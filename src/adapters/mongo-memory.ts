/**
 * MongoMemoryAdapter
 *
 * Production MemoryAdapter backed by MongoDB.
 * Uses the `mongodb` package — install it first:
 *
 *   pnpm add mongodb
 *
 * Features:
 *  - Conversation history per session (agent_messages collection)
 *  - Full task state as documents (agent_tasks collection)
 *  - Semantic memory with MongoDB text search (agent_memories collection)
 *  - Compatible with Atlas Vector Search: add a vector index to
 *    agent_memories.embedding and pass embeddings via entry.metadata.embedding
 *
 * Usage:
 *   const mem = await MongoMemoryAdapter.connect(process.env.DATABASE_URL);
 *   // DATABASE_URL: mongodb://user:pass@host:27017/dbname
 *   // Or Atlas:     mongodb+srv://user:pass@cluster.mongodb.net/dbname
 *
 * Indexes and collections are created automatically on first connect.
 */

import { randomUUID } from "node:crypto";
import type { MemoryAdapter, MemoryEntry } from "./memory.js";
import type {
  Message,
  TaskState,
  TaskPlan,
  StepResult,
} from "../core/types.js";

// ─── Minimal type stubs ───────────────────────────────────────

interface MongoDoc {
  [key: string]: unknown;
}

interface MongoCursor {
  toArray(): Promise<MongoDoc[]>;
}

interface MongoCollection {
  insertOne(doc: MongoDoc): Promise<unknown>;
  findOne(filter: MongoDoc): Promise<MongoDoc | null>;
  find(filter: MongoDoc): MongoCursor;
  replaceOne(
    filter: MongoDoc,
    replacement: MongoDoc,
    options: MongoDoc,
  ): Promise<unknown>;
  updateOne(filter: MongoDoc, update: MongoDoc): Promise<unknown>;
  createIndex(spec: MongoDoc, options?: MongoDoc): Promise<unknown>;
}

interface MongoDB {
  collection(name: string): MongoCollection;
}

interface MongoClientLike {
  connect(): Promise<void>;
  db(name?: string): MongoDB;
  close(): Promise<void>;
}

// ─── DB name extracted from URL ───────────────────────────────

function extractDbName(url: string): string {
  try {
    const u = new URL(url);
    const name = u.pathname.replace(/^\//, "").split("?")[0];
    return name || "msm_agent";
  } catch {
    return "msm_agent";
  }
}

// ─── Adapter ─────────────────────────────────────────────────

export class MongoMemoryAdapter implements MemoryAdapter {
  private readonly messages: MongoCollection;
  private readonly tasks: MongoCollection;
  private readonly memories: MongoCollection;
  private readonly client: MongoClientLike;

  private constructor(client: MongoClientLike, db: MongoDB) {
    this.client = client;
    this.messages = db.collection("agent_messages");
    this.tasks = db.collection("agent_tasks");
    this.memories = db.collection("agent_memories");
  }

  /**
   * Connect to MongoDB and initialise indexes.
   *
   * @param url  MongoDB connection URL
   * @throws     If the `mongodb` package is not installed.
   */
  static async connect(url: string): Promise<MongoMemoryAdapter> {
    let MongoClient: new (url: string) => MongoClientLike;
    try {
      // @ts-ignore — optional peer dep: pnpm add mongodb
      const mod = await import("mongodb");
      MongoClient = (mod.MongoClient ??
        mod.default?.MongoClient) as typeof MongoClient;
    } catch {
      throw new Error(
        "MongoMemoryAdapter requires the 'mongodb' package.\n" +
          "Install it: pnpm add mongodb",
      );
    }

    const client = new MongoClient(url);
    await client.connect();
    const db = client.db(extractDbName(url));

    // Bootstrap indexes
    const messages = db.collection("agent_messages");
    const memories = db.collection("agent_memories");
    await messages.createIndex({ sessionId: 1, createdAt: 1 });
    await memories.createIndex({ content: "text" });
    await memories.createIndex({ confidence: -1, updatedAt: -1 });

    return new MongoMemoryAdapter(client, db);
  }

  // ─── Conversation ──────────────────────────────────────────

  async getConversation(sessionId: string): Promise<Message[]> {
    const docs = await this.messages.find({ sessionId }).toArray();

    docs.sort(
      (a, b) => (a["createdAt"] as number) - (b["createdAt"] as number),
    );

    return docs.map((d) => ({
      role: d["role"] as Message["role"],
      content: d["content"] as string,
      timestamp: d["timestamp"] as string,
    }));
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    await this.messages.insertOne({
      _id: randomUUID(),
      sessionId,
      role: message.role,
      content: message.content,
      timestamp: message.timestamp,
      createdAt: Date.now(),
    });
  }

  // ─── Task State ────────────────────────────────────────────

  async getTask(taskId: string): Promise<TaskState | null> {
    const doc = await this.tasks.findOne({ _id: taskId });
    if (!doc) return null;
    const { _id: _, ...task } = doc;
    return task as unknown as TaskState;
  }

  async saveTask(task: TaskState): Promise<void> {
    await this.tasks.replaceOne(
      { _id: task.taskId },
      { _id: task.taskId, ...task, updatedAt: Date.now() },
      { upsert: true } as MongoDoc,
    );
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
    await this.tasks.updateOne({ _id: taskId }, {
      $set: { status, updatedAt: Date.now() },
    } as MongoDoc);
  }

  async getActiveTask(sessionId: string): Promise<TaskState | null> {
    const activeStatuses = [
      "running",
      "waiting_tool",
      "waiting_clarification",
      "waiting_approval",
    ];
    const docs = await this.tasks
      .find({ sessionId, status: { $in: activeStatuses } })
      .toArray();

    if (docs.length === 0) return null;
    docs.sort(
      (a, b) => (b["updatedAt"] as number) - (a["updatedAt"] as number),
    );
    const { _id: _, ...task } = docs[0]!;
    return task as unknown as TaskState;
  }

  // ─── Semantic Memory ───────────────────────────────────────

  async store(entry: MemoryEntry): Promise<void> {
    await this.memories.replaceOne(
      { _id: entry.id },
      {
        _id: entry.id,
        content: entry.content,
        source: entry.source,
        confidence: entry.confidence,
        createdAt: entry.createdAt,
        updatedAt: Date.now(),
        metadata: entry.metadata ?? null,
      },
      { upsert: true } as MongoDoc,
    );
  }

  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    // MongoDB full-text search (requires text index on content)
    let docs = await this.memories
      .find({ $text: { $search: query } } as MongoDoc)
      .toArray();

    // Fallback: regex search if text index returns nothing
    if (docs.length === 0) {
      docs = await this.memories
        .find({ content: { $regex: query, $options: "i" } } as MongoDoc)
        .toArray();
    }

    docs.sort(
      (a, b) => (b["confidence"] as number) - (a["confidence"] as number),
    );

    return docs.slice(0, limit).map((d) => ({
      id: d["_id"] as string,
      content: d["content"] as string,
      source: d["source"] as MemoryEntry["source"],
      confidence: d["confidence"] as number,
      createdAt: d["createdAt"] as string,
      metadata: d["metadata"] as Record<string, unknown> | undefined,
    }));
  }

  /** Close the MongoDB connection. Call on graceful shutdown. */
  async close(): Promise<void> {
    await this.client.close();
  }
}
