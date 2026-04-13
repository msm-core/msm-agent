/**
 * MemoryAdapter — How the agent remembers.
 *
 * In dalil: Redis working memory + MongoDB episodic/semantic/procedural/reflection + customer memory.
 * In msm-agent: you bring your own. The dummy adapter uses in-memory Maps.
 */

import type {
  Message,
  TaskState,
  TaskPlan,
  StepResult,
} from "../core/types.js";

export interface MemoryAdapter {
  // ─── Conversation ──────────────────────────────────────────
  getConversation(sessionId: string): Promise<Message[]>;
  addMessage(sessionId: string, message: Message): Promise<void>;

  // ─── Task State ────────────────────────────────────────────
  getTask(taskId: string): Promise<TaskState | null>;
  saveTask(task: TaskState): Promise<void>;
  updatePlan(taskId: string, plan: TaskPlan): Promise<void>;
  addStep(taskId: string, step: StepResult): Promise<void>;
  updateTaskStatus(taskId: string, status: TaskState["status"]): Promise<void>;

  // ─── Optional: Semantic/Episodic Memory ────────────────────
  /** Search memory by natural language query (for context enrichment) */
  search?(query: string, limit: number): Promise<MemoryEntry[]>;
  /** Store a memory entry (for learning from interactions) */
  store?(entry: MemoryEntry): Promise<void>;
}

export interface MemoryEntry {
  id: string;
  content: string;
  source: "task" | "conversation" | "user_explicit" | "system";
  confidence: number;
  createdAt: string;
  metadata?: Record<string, unknown>;
}
