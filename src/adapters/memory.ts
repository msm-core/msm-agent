/**
 * MemoryAdapter — How the agent remembers.
 *
 * Production implementations typically use Redis for working memory,
 * a database (MongoDB/Postgres) for episodic/semantic/procedural layers.
 * The dummy adapter uses in-memory Maps for testing.
 */

import type {
  Message,
  TaskState,
  TaskPlan,
  StepResult,
  RunState,
} from "../core/types.js";

export interface MemoryAdapter {
  // ─── Conversation ──────────────────────────────────────────
  getConversation(sessionId: string, limit?: number): Promise<Message[]>;
  addMessage(sessionId: string, message: Message): Promise<void>;

  // ─── Task State ────────────────────────────────────────────
  getTask(taskId: string): Promise<TaskState | null>;
  saveTask(task: TaskState): Promise<void>;
  updatePlan(taskId: string, plan: TaskPlan): Promise<void>;
  addStep(taskId: string, step: StepResult): Promise<void>;
  updateTaskStatus(taskId: string, status: TaskState["status"]): Promise<void>;

  // ─── Optional: Task Resumption ───────────────────────────────
  /**
   * Find the most recent active (resumable) task for a session.
   * Returns a task in waiting_tool, waiting_clarification, waiting_approval, or running state.
   * Required for first-class approval/callback resumption workflows.
   */
  getActiveTask?(sessionId: string): Promise<TaskState | null>;

  // ─── Optional: Durable Run State ───────────────────────────
  /**
   * Save ephemeral run state for durability across restarts (e.g. Redis with TTL).
   * If not implemented, run state is in-memory only (lost on restart).
   */
  saveRunState?(taskId: string, state: RunState): Promise<void>;
  /** Load run state for a resumed task */
  loadRunState?(taskId: string): Promise<RunState | null>;
  /** Extend TTL on run state during long operations (e.g. extendTTL) */
  extendRunStateTTL?(taskId: string): Promise<void>;

  // ─── Optional: Semantic/Episodic Memory ────────────────────
  /** Search memory by natural language query (for context enrichment) */
  search?(query: string, limit: number): Promise<MemoryEntry[]>;
  /** Store a memory entry (for learning from interactions) */
  store?(entry: MemoryEntry): Promise<void>;
  /**
   * Delete a memory entry by ID.
   * Phase 17 — used by consolidateStrategies() to prune stale/contradictory notes.
   * Optional: adapters that don't support deletion gracefully no-op.
   */
  delete?(id: string): Promise<void>;
}

export interface MemoryEntry {
  id: string;
  content: string;
  source:
    | "task"
    | "conversation"
    | "user_explicit"
    | "system"
    | "evolution.strategy";
  confidence: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}
