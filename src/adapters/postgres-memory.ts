/**
 * PostgresMemoryAdapter
 *
 * Production MemoryAdapter backed by PostgreSQL.
 * Uses the `postgres` (postgresjs) package — install it first:
 *
 *   pnpm add postgres
 *
 * Features:
 *  - Conversation history per session (agent_messages)
 *  - Full task state as JSONB (agent_tasks)
 *  - Semantic memory with PostgreSQL full-text search (agent_memories)
 *  - Optional pgvector support: add a `search_vector vector(1536)` column
 *    and call `store()` with pre-computed embeddings via metadata.embedding
 *
 * Usage:
 *   const mem = await PostgresMemoryAdapter.connect(process.env.DATABASE_URL);
 *
 * Schema is auto-created on first connect.
 */

import { randomUUID } from "node:crypto";
import type { MemoryAdapter, MemoryEntry } from "./memory.js";
import type {
  Message,
  TaskState,
  TaskPlan,
  StepResult,
} from "../core/types.js";

// ─── Minimal type stubs (avoid runtime devDep requirement) ────

type SqlTag = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Record<string, unknown>[]>;

type Sql = SqlTag & {
  end(): Promise<void>;
  unsafe(query: string): Promise<Record<string, unknown>[]>;
};

// ─── Schema ──────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_messages (
  id         TEXT   PRIMARY KEY,
  session_id TEXT   NOT NULL,
  role       TEXT   NOT NULL,
  content    TEXT   NOT NULL,
  ts         TEXT   NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session
  ON agent_messages (session_id, created_at);

CREATE TABLE IF NOT EXISTS agent_tasks (
  id         TEXT   PRIMARY KEY,
  data       JSONB  NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_memories (
  id         TEXT   PRIMARY KEY,
  content    TEXT   NOT NULL,
  source     TEXT   NOT NULL,
  confidence FLOAT  NOT NULL,
  created_at TEXT   NOT NULL,
  updated_at BIGINT NOT NULL,
  metadata   JSONB
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_fts
  ON agent_memories USING gin(to_tsvector('english', content));
`;

// ─── Row shapes ──────────────────────────────────────────────

interface MessageRow {
  role: string;
  content: string;
  ts: string;
}

interface TaskRow {
  data: unknown; // JSONB is already parsed by postgresjs
}

interface MemoryRow {
  id: string;
  content: string;
  source: string;
  confidence: number;
  created_at: string;
  metadata: unknown;
}

// ─── Adapter ─────────────────────────────────────────────────

export class PostgresMemoryAdapter implements MemoryAdapter {
  private readonly sql: Sql;

  private constructor(sql: Sql) {
    this.sql = sql;
  }

  /**
   * Connect to PostgreSQL and initialise the schema.
   *
   * @param url  Full connection URL — postgresql://user:pass@host:5432/dbname
   * @throws     If the `postgres` package is not installed.
   */
  static async connect(url: string): Promise<PostgresMemoryAdapter> {
    let postgres: (url: string) => Sql;
    try {
      // @ts-ignore — optional peer dep: pnpm add postgres
      const mod = await import("postgres");
      postgres = (mod.default ?? mod) as typeof postgres;
    } catch {
      throw new Error(
        "PostgresMemoryAdapter requires the 'postgres' package.\n" +
          "Install it: pnpm add postgres",
      );
    }

    const sql = postgres(url) as Sql;
    // Bootstrap schema
    await sql.unsafe(SCHEMA);
    return new PostgresMemoryAdapter(sql);
  }

  // ─── Conversation ──────────────────────────────────────────

  async getConversation(sessionId: string): Promise<Message[]> {
    const rows = (await (this.sql as SqlTag)`
      SELECT role, content, ts
      FROM   agent_messages
      WHERE  session_id = ${sessionId}
      ORDER  BY created_at ASC
    `) as unknown as MessageRow[];

    return rows.map((r) => ({
      role: r.role as Message["role"],
      content: r.content,
      timestamp: r.ts,
    }));
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    await (this.sql as SqlTag)`
      INSERT INTO agent_messages (id, session_id, role, content, ts, created_at)
      VALUES (${randomUUID()}, ${sessionId}, ${message.role},
              ${message.content}, ${message.timestamp}, ${Date.now()})
    `;
  }

  // ─── Task State ────────────────────────────────────────────

  async getTask(taskId: string): Promise<TaskState | null> {
    const rows = (await (this.sql as SqlTag)`
      SELECT data FROM agent_tasks WHERE id = ${taskId}
    `) as unknown as TaskRow[];
    return rows.length > 0 ? (rows[0]!.data as TaskState) : null;
  }

  async saveTask(task: TaskState): Promise<void> {
    await (this.sql as SqlTag)`
      INSERT INTO agent_tasks (id, data, updated_at)
      VALUES (${task.taskId}, ${JSON.stringify(task) as unknown}, ${Date.now()})
      ON CONFLICT (id) DO UPDATE
        SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
    `;
  }

  async updatePlan(taskId: string, plan: TaskPlan): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;
    await this.saveTask({ ...task, plan });
  }

  async addStep(taskId: string, step: StepResult): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;
    await this.saveTask({ ...task, steps: [...task.steps, step] });
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskState["status"],
  ): Promise<void> {
    const task = await this.getTask(taskId);
    if (!task) return;
    await this.saveTask({ ...task, status });
  }

  async getActiveTask(sessionId: string): Promise<TaskState | null> {
    const rows = (await (this.sql as SqlTag)`
      SELECT data FROM agent_tasks
      WHERE  data->>'sessionId' = ${sessionId}
        AND  data->>'status' IN (
               'running', 'waiting_tool',
               'waiting_clarification', 'waiting_approval'
             )
      ORDER  BY updated_at DESC
      LIMIT  1
    `) as unknown as TaskRow[];
    return rows.length > 0 ? (rows[0]!.data as TaskState) : null;
  }

  // ─── Semantic Memory ───────────────────────────────────────

  async store(entry: MemoryEntry): Promise<void> {
    const meta = entry.metadata ? JSON.stringify(entry.metadata) : null;
    await (this.sql as SqlTag)`
      INSERT INTO agent_memories
             (id, content, source, confidence, created_at, updated_at, metadata)
      VALUES (${entry.id}, ${entry.content}, ${entry.source},
              ${entry.confidence}, ${entry.createdAt}, ${Date.now()},
              ${meta as unknown})
      ON CONFLICT (id) DO UPDATE
        SET content    = EXCLUDED.content,
            confidence = EXCLUDED.confidence,
            updated_at = EXCLUDED.updated_at,
            metadata   = EXCLUDED.metadata
    `;
  }

  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    const rows = (await (this.sql as SqlTag)`
      SELECT id, content, source, confidence, created_at, metadata
      FROM   agent_memories
      WHERE  to_tsvector('english', content) @@ plainto_tsquery('english', ${query})
      ORDER  BY confidence DESC, updated_at DESC
      LIMIT  ${limit}
    `) as unknown as MemoryRow[];

    // Fallback to simple ILIKE if FTS returns nothing
    if (rows.length === 0) {
      const fallback = (await (this.sql as SqlTag)`
        SELECT id, content, source, confidence, created_at, metadata
        FROM   agent_memories
        WHERE  content ILIKE ${"%%" + query + "%%"}
        ORDER  BY confidence DESC, updated_at DESC
        LIMIT  ${limit}
      `) as unknown as MemoryRow[];
      return fallback.map(toEntry);
    }

    return rows.map(toEntry);
  }

  /** Close the connection pool. Call on graceful shutdown. */
  async close(): Promise<void> {
    await this.sql.end();
  }
}

// ─── Helpers ─────────────────────────────────────────────────

function toEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    content: row.content,
    source: row.source as MemoryEntry["source"],
    confidence: row.confidence,
    createdAt: row.created_at,
    metadata: row.metadata as Record<string, unknown> | undefined,
  };
}
