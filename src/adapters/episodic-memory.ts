/**
 * EpisodicMemoryAdapter
 *
 * Wraps any `MemoryAdapter` with optional vector search for episodic memories.
 *
 * Problem: The default `memory.search()` uses LIKE keyword matching (SQLite) or
 * regex scans (in-memory). For agents with large memory stores, semantic search
 * retrieves far more relevant context — especially for paraphrased queries.
 *
 * Solution: When a `KnowledgeAdapter` (e.g. Qdrant) is provided, this wrapper
 * indexes every `store()` call into a dedicated Qdrant collection and overrides
 * `search()` to use vector similarity instead.
 *
 * Usage:
 *   const base = new SQLiteMemoryAdapter("./agent.db");
 *   const episodicKb = QdrantKnowledgeAdapter.create({
 *     url: process.env.QDRANT_URL,
 *     collection: "myagent_episodic",
 *     embedProvider: "openai",
 *     embedApiKey: process.env.OPENAI_API_KEY,
 *   });
 *   const memory = new EpisodicMemoryAdapter(base, episodicKb);
 *   const agent = createAgent({ brain, memory, tools, ... });
 *
 * This is fully backward-compatible: the base adapter still handles all
 * conversation, task, and run-state operations. Only `store()` and `search()`
 * are upgraded.
 */

import type { MemoryAdapter, MemoryEntry } from "./memory.js";
import type { KnowledgeAdapter } from "./knowledge.js";
import type {
  Message,
  TaskState,
  TaskPlan,
  StepResult,
  RunState,
} from "../core/types.js";

export class EpisodicMemoryAdapter implements MemoryAdapter {
  constructor(
    private readonly base: MemoryAdapter,
    private readonly episodicKb: KnowledgeAdapter,
  ) {}

  // ─── Episodic store: index into vector KB ─────────────────

  async store(entry: MemoryEntry): Promise<void> {
    // Write to base adapter first (durability)
    await this.base.store?.(entry);

    // Index into vector KB — use entry.id as docId, source as title
    try {
      await this.episodicKb.indexDocument(
        entry.id,
        `[${entry.source}] ${entry.content.slice(0, 80)}`,
        entry.content,
        { chunkSize: 2000, chunkOverlap: 0 },
      );
    } catch (err) {
      // Non-fatal — base adapter still has the entry
      console.warn(
        "[msm-agent] EpisodicMemoryAdapter: vector index failed:",
        err,
      );
    }
  }

  // ─── Episodic search: vector similarity via KB ────────────

  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    try {
      const hits = await this.episodicKb.search(query, {
        topK: limit,
        minScore: 0.35,
      });

      return hits.map((h) => ({
        id: h.docId,
        content: h.text,
        source: "conversation" as MemoryEntry["source"],
        confidence: h.score,
        createdAt: new Date().toISOString(),
      }));
    } catch {
      // Fall back to base adapter search on vector store failure
      return this.base.search?.(query, limit) ?? [];
    }
  }

  // ─── Delete: remove from both stores ─────────────────────

  async delete(id: string): Promise<void> {
    await this.base.delete?.(id);
    try {
      await this.episodicKb.deleteDocument(id);
    } catch (err) {
      console.warn(
        "[msm-agent] EpisodicMemoryAdapter: vector delete failed:",
        err,
      );
    }
  }

  // ─── Pass-through: all other MemoryAdapter methods ────────

  getConversation(sessionId: string, limit?: number): Promise<Message[]> {
    return this.base.getConversation(sessionId, limit);
  }

  addMessage(sessionId: string, message: Message): Promise<void> {
    return this.base.addMessage(sessionId, message);
  }

  getTask(taskId: string): Promise<TaskState | null> {
    return this.base.getTask(taskId);
  }

  saveTask(task: TaskState): Promise<void> {
    return this.base.saveTask(task);
  }

  updatePlan(taskId: string, plan: TaskPlan): Promise<void> {
    return this.base.updatePlan(taskId, plan);
  }

  addStep(taskId: string, step: StepResult): Promise<void> {
    return this.base.addStep(taskId, step);
  }

  updateTaskStatus(taskId: string, status: TaskState["status"]): Promise<void> {
    return this.base.updateTaskStatus(taskId, status);
  }

  getActiveTask?(sessionId: string): Promise<TaskState | null> {
    return this.base.getActiveTask?.(sessionId) ?? Promise.resolve(null);
  }

  saveRunState?(taskId: string, state: RunState): Promise<void> {
    return this.base.saveRunState?.(taskId, state) ?? Promise.resolve();
  }

  loadRunState?(taskId: string): Promise<RunState | null> {
    return this.base.loadRunState?.(taskId) ?? Promise.resolve(null);
  }

  extendRunStateTTL?(taskId: string): Promise<void> {
    return this.base.extendRunStateTTL?.(taskId) ?? Promise.resolve();
  }
}
