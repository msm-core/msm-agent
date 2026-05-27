/**
 * SQLite Memory Adapter
 *
 * Persistent MemoryAdapter backed by SQLite (node:sqlite, built-in since Node 22.12).
 * Zero extra dependencies — uses Node's native SQL engine.
 *
 * Tables:
 *   messages  — conversation history, keyed by sessionId
 *   tasks     — full TaskState serialised as JSON
 *   memories  — episodic/semantic memory entries (keyword-searchable)
 *
 * Usage:
 *   const mem = new SQLiteMemoryAdapter("/data/agent.db");
 *   mem.searchSync("user prefers Arabic", 5); // called synchronously by promptBuilder
 *
 * Environment:
 *   Set MEMORY_PATH to a file path (e.g. /data/agent.db) to enable persistence.
 *   Leave unset to use the in-memory InMemoryAdapter (state lost on restart).
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { MemoryAdapter, MemoryEntry } from "./memory.js";
import type {
  Message,
  TaskState,
  TaskPlan,
  StepResult,
} from "../core/types.js";

// ─── Schema ──────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id         TEXT    PRIMARY KEY,
  session_id TEXT    NOT NULL,
  role       TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  timestamp  TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session
  ON messages (session_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT    PRIMARY KEY,
  data       TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id         TEXT    PRIMARY KEY,
  content    TEXT    NOT NULL,
  source     TEXT    NOT NULL,
  confidence REAL    NOT NULL,
  created_at TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

// ─── Row shapes ──────────────────────────────────────────────

interface MessageRow {
  role: string;
  content: string;
  timestamp: string;
}

interface TaskRow {
  data: string;
}

interface MemoryRow {
  id: string;
  content: string;
  source: string;
  confidence: number;
  created_at: string;
}

// ─── Adapter ─────────────────────────────────────────────────

export class SQLiteMemoryAdapter implements MemoryAdapter {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  // ─── Conversation ──────────────────────────────────────────

  async getConversation(sessionId: string): Promise<Message[]> {
    const rows = this.db
      .prepare(
        "SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY created_at ASC",
      )
      .all(sessionId) as unknown as MessageRow[];

    return rows.map((r) => ({
      role: r.role as Message["role"],
      content: r.content,
      timestamp: r.timestamp,
    }));
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO messages (id, session_id, role, content, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        randomUUID(),
        sessionId,
        message.role,
        message.content,
        message.timestamp,
        Date.now(),
      );
  }

  // ─── Task State ────────────────────────────────────────────

  async getTask(taskId: string): Promise<TaskState | null> {
    const row = this.db
      .prepare("SELECT data FROM tasks WHERE id = ?")
      .get(taskId) as unknown as TaskRow | undefined;
    return row ? (JSON.parse(row.data) as TaskState) : null;
  }

  async saveTask(task: TaskState): Promise<void> {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO tasks (id, data, updated_at) VALUES (?, ?, ?)",
      )
      .run(task.taskId, JSON.stringify(task), Date.now());
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
    const rows = this.db
      .prepare("SELECT data FROM tasks ORDER BY updated_at DESC")
      .all() as unknown as TaskRow[];

    const activeStatuses = new Set<TaskState["status"]>([
      "running",
      "waiting_tool",
      "waiting_clarification",
      "waiting_approval",
    ]);

    for (const row of rows) {
      const t = JSON.parse(row.data) as TaskState;
      if (t.sessionId === sessionId && activeStatuses.has(t.status)) {
        return t;
      }
    }
    return null;
  }

  // ─── Semantic Memory ───────────────────────────────────────

  async store(entry: MemoryEntry): Promise<void> {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO memories
           (id, content, source, confidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        entry.id,
        entry.content,
        entry.source,
        entry.confidence,
        entry.createdAt,
        Date.now(),
      );
  }

  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    return this.searchSync(query, limit);
  }

  /**
   * Synchronous keyword search used by the promptBuilder closure in factory.ts.
   * Splits the query into words and OR-matches each against memory content.
   * Falls back to returning the most confident memories when no keywords match.
   */
  searchSync(query: string, limit: number): MemoryEntry[] {
    const words = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2);

    if (words.length === 0) {
      return (
        this.db
          .prepare(
            "SELECT id, content, source, confidence, created_at FROM memories ORDER BY confidence DESC, updated_at DESC LIMIT ?",
          )
          .all(limit) as unknown as MemoryRow[]
      ).map(toEntry);
    }

    const conditions = words.map(() => "LOWER(content) LIKE ?").join(" OR ");
    const wordParams: string[] = words.map((w) => `%${w}%`);
    return (
      this.db
        .prepare(
          `SELECT id, content, source, confidence, created_at FROM memories
           WHERE ${conditions}
           ORDER BY confidence DESC, updated_at DESC LIMIT ?`,
        )
        .all(...wordParams, limit) as unknown as MemoryRow[]
    ).map(toEntry);
  }

  /** Close the database. Call during graceful shutdown. */
  close(): void {
    this.db.close();
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
  };
}
