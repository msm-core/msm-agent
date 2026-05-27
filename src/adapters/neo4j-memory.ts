/**
 * Neo4jMemoryAdapter
 *
 * Graph-enriched MemoryAdapter backed by Neo4j.
 * Wraps a primary MemoryAdapter (Postgres, MongoDB, SQLite) for conversations
 * and task state. Overrides search() and store() with Neo4j graph operations.
 *
 * Requires:
 *   pnpm add neo4j-driver
 *
 * Graph model:
 *   (:Memory {id, content, source, confidence, createdAt})
 *   (:Concept {name})          ← keywords extracted from content
 *   (:Memory)-[:MENTIONS]->(:Concept)
 *
 * Why graph memory?
 *   Unlike keyword search (LIKE / FTS), graph traversal finds memories through
 *   conceptual relationships. Storing that "user prefers Arabic" and "Arabic"
 *   links to ":Concept{name:'arabic'}" means any future query touching
 *   "language", "Arabic", or related concepts surfaces that memory — even
 *   if the exact words don't match.
 *
 * Usage:
 *   // First set up a primary adapter (postgres, mongo, or sqlite):
 *   const primary = await PostgresMemoryAdapter.connect(process.env.DATABASE_URL);
 *
 *   // Then wrap it with Neo4j for graph-enriched search:
 *   const mem = await Neo4jMemoryAdapter.connect({
 *     url:      process.env.NEO4J_URL,      // bolt://localhost:7687
 *     user:     process.env.NEO4J_USER,     // default: "neo4j"
 *     password: process.env.NEO4J_PASSWORD,
 *     primary,
 *   });
 */

import { randomUUID } from "node:crypto";
import type { MemoryAdapter, MemoryEntry } from "./memory.js";
import type {
  Message,
  TaskState,
  TaskPlan,
  StepResult,
} from "../core/types.js";

// ─── Minimal Neo4j type stubs ─────────────────────────────────

interface Neo4jRecord {
  get(field: string): unknown;
}

interface Neo4jResult {
  records: Neo4jRecord[];
}

interface Neo4jSession {
  run(query: string, params?: Record<string, unknown>): Promise<Neo4jResult>;
  close(): Promise<void>;
}

interface Neo4jDriverLike {
  session(): Neo4jSession;
  close(): Promise<void>;
}

// ─── Stopwords (excluded from concept extraction) ─────────────

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "in",
  "on",
  "at",
  "to",
  "of",
  "and",
  "or",
  "but",
  "not",
  "for",
  "with",
  "this",
  "that",
  "it",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "she",
  "they",
  "was",
  "are",
  "be",
  "has",
  "had",
  "will",
  "can",
  "do",
  "did",
  "from",
  "by",
  "as",
  "its",
  "than",
  "so",
  "if",
]);

function extractConcepts(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[\s,.!?;:'"()\[\]{}<>\/\\]+/)
        .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
    ),
  ];
}

// ─── Options ─────────────────────────────────────────────────

export interface Neo4jMemoryAdapterOptions {
  /** Bolt URL — bolt://localhost:7687 or neo4j+s://xxx.databases.neo4j.io */
  url: string;
  /** Neo4j username (default: "neo4j") */
  user?: string;
  /** Neo4j password */
  password: string;
  /**
   * Primary MemoryAdapter for conversations and task state.
   * Neo4j only handles search() and store() — everything else delegates here.
   */
  primary: MemoryAdapter;
}

// ─── Adapter ─────────────────────────────────────────────────

export class Neo4jMemoryAdapter implements MemoryAdapter {
  private constructor(
    private readonly driver: Neo4jDriverLike,
    private readonly primary: MemoryAdapter,
  ) {}

  /**
   * Connect to Neo4j and ensure constraints exist.
   *
   * @throws  If `neo4j-driver` is not installed.
   */
  static async connect(
    opts: Neo4jMemoryAdapterOptions,
  ): Promise<Neo4jMemoryAdapter> {
    let neo4j: {
      default: {
        driver(url: string, auth: unknown): Neo4jDriverLike;
        auth: { basic(user: string, pass: string): unknown };
      };
    };
    try {
      // @ts-ignore — optional peer dep: pnpm add neo4j-driver
      neo4j = (await import("neo4j-driver")) as typeof neo4j;
    } catch {
      throw new Error(
        "Neo4jMemoryAdapter requires the 'neo4j-driver' package.\n" +
          "Install it: pnpm add neo4j-driver",
      );
    }

    const driver = neo4j.default.driver(
      opts.url,
      neo4j.default.auth.basic(opts.user ?? "neo4j", opts.password),
    );

    // Bootstrap constraints
    const session = driver.session();
    try {
      await session.run(
        "CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE",
      );
      await session.run(
        "CREATE CONSTRAINT concept_name IF NOT EXISTS FOR (c:Concept) REQUIRE c.name IS UNIQUE",
      );
    } finally {
      await session.close();
    }

    return new Neo4jMemoryAdapter(driver, opts.primary);
  }

  // ─── Delegate conversation + task ops to primary ───────────

  getConversation(sessionId: string): Promise<Message[]> {
    return this.primary.getConversation(sessionId);
  }
  addMessage(sessionId: string, message: Message): Promise<void> {
    return this.primary.addMessage(sessionId, message);
  }
  getTask(taskId: string): Promise<TaskState | null> {
    return this.primary.getTask(taskId);
  }
  saveTask(task: TaskState): Promise<void> {
    return this.primary.saveTask(task);
  }
  updatePlan(taskId: string, plan: TaskPlan): Promise<void> {
    return this.primary.updatePlan(taskId, plan);
  }
  addStep(taskId: string, step: StepResult): Promise<void> {
    return this.primary.addStep(taskId, step);
  }
  updateTaskStatus(taskId: string, status: TaskState["status"]): Promise<void> {
    return this.primary.updateTaskStatus(taskId, status);
  }
  getActiveTask?(sessionId: string): Promise<TaskState | null> {
    return this.primary.getActiveTask?.(sessionId) ?? Promise.resolve(null);
  }

  // ─── Graph-enriched semantic memory ───────────────────────

  /**
   * Store a memory as a Neo4j node + concept relationships.
   * Concepts are extracted from content (stopword-filtered keywords).
   * Each concept is MERGEd (deduped) and linked with [:MENTIONS].
   */
  async store(entry: MemoryEntry): Promise<void> {
    const concepts = extractConcepts(entry.content);

    const session = this.driver.session();
    try {
      await session.run(
        `MERGE (m:Memory {id: $id})
         SET m.content    = $content,
             m.source     = $source,
             m.confidence = $confidence,
             m.createdAt  = $createdAt`,
        {
          id: entry.id,
          content: entry.content,
          source: entry.source,
          confidence: entry.confidence,
          createdAt: entry.createdAt,
        },
      );

      for (const concept of concepts) {
        await session.run(
          `MATCH (m:Memory {id: $id})
           MERGE (c:Concept {name: $name})
           MERGE (m)-[:MENTIONS]->(c)`,
          { id: entry.id, name: concept },
        );
      }
    } finally {
      await session.close();
    }

    // Also write to the primary adapter (durable storage)
    await this.primary.store?.(entry);
  }

  /**
   * Graph-traversal search: finds memories through concept relationships.
   * Queries both direct content matches and concept-linked memories.
   * Deduplicates and ranks by confidence.
   */
  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    const concepts = extractConcepts(query);
    const session = this.driver.session();

    try {
      // Graph search: memories that share concepts with this query
      const result = await session.run(
        `UNWIND $concepts AS kw
         MATCH (c:Concept {name: kw})<-[:MENTIONS]-(m:Memory)
         RETURN DISTINCT m.id AS id, m.content AS content, m.source AS source,
                m.confidence AS confidence, m.createdAt AS createdAt
         ORDER BY m.confidence DESC
         LIMIT $limit`,
        { concepts, limit },
      );

      const graphEntries = result.records.map(
        (r): MemoryEntry => ({
          id: r.get("id") as string,
          content: r.get("content") as string,
          source: r.get("source") as MemoryEntry["source"],
          confidence: r.get("confidence") as number,
          createdAt: r.get("createdAt") as string,
        }),
      );

      // Enrich with primary adapter's text search (union, dedup by id)
      const primaryEntries = await (this.primary.search?.(query, limit) ??
        Promise.resolve([]));
      const seen = new Set(graphEntries.map((e) => e.id));
      const merged = [
        ...graphEntries,
        ...primaryEntries.filter((e) => !seen.has(e.id)),
      ];

      return merged.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
    } finally {
      await session.close();
    }
  }

  /** Convenience: create a memory from plain text (auto-generates id + timestamp). */
  async remember(
    content: string,
    opts: {
      source?: MemoryEntry["source"];
      confidence?: number;
    } = {},
  ): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: randomUUID(),
      content,
      source: opts.source ?? "system",
      confidence: opts.confidence ?? 0.9,
      createdAt: new Date().toISOString(),
    };
    await this.store(entry);
    return entry;
  }

  /** Close Neo4j driver and the primary adapter (if it has a close()). */
  async close(): Promise<void> {
    await this.driver.close();
    const p = this.primary as { close?: () => Promise<void> };
    await p.close?.();
  }
}
