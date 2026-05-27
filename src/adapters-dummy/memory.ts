/**
 * InMemoryAdapter — Zero-infrastructure memory for testing and demos.
 */

import type {
  Message,
  TaskState,
  TaskPlan,
  StepResult,
  RunState,
} from "../core/types.js";
import type { MemoryAdapter, MemoryEntry } from "../adapters/memory.js";

export class InMemoryAdapter implements MemoryAdapter {
  private conversations = new Map<string, Message[]>();
  private tasks = new Map<string, TaskState>();
  private memories: MemoryEntry[] = [];
  private runStates = new Map<string, RunState>();

  async getConversation(sessionId: string, limit?: number): Promise<Message[]> {
    const msgs = this.conversations.get(sessionId) ?? [];
    return limit !== undefined ? msgs.slice(-limit) : msgs;
  }

  async addMessage(sessionId: string, message: Message): Promise<void> {
    const conv = this.conversations.get(sessionId) ?? [];
    conv.push(message);
    this.conversations.set(sessionId, conv);
  }

  async getTask(taskId: string): Promise<TaskState | null> {
    return this.tasks.get(taskId) ?? null;
  }

  async saveTask(task: TaskState): Promise<void> {
    this.tasks.set(task.taskId, task);
  }

  async updatePlan(taskId: string, plan: TaskPlan): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
      task.plan = plan;
    }
  }

  async addStep(taskId: string, step: StepResult): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
      task.steps.push(step);
    }
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskState["status"],
  ): Promise<void> {
    const task = this.tasks.get(taskId);
    if (task) {
      task.status = status;
    }
  }

  async search(query: string, limit: number): Promise<MemoryEntry[]> {
    // Simple substring search for testing
    return this.memories
      .filter((m) => m.content.toLowerCase().includes(query.toLowerCase()))
      .slice(0, limit);
  }

  async store(entry: MemoryEntry): Promise<void> {
    this.memories.push(entry);
  }

  /**
   * Find an active (resumable) task for a session.
   * Returns the most recent task in waiting_tool, waiting_clarification,
   * waiting_approval, or running state.
   */
  async getActiveTask(sessionId: string): Promise<TaskState | null> {
    const resumableStatuses = new Set([
      "waiting_tool",
      "waiting_clarification",
      "waiting_approval",
      "running",
    ]);
    let best: TaskState | null = null;
    for (const task of this.tasks.values()) {
      if (task.sessionId === sessionId && resumableStatuses.has(task.status)) {
        if (!best || task.startedAt > best.startedAt) {
          best = task;
        }
      }
    }
    return best;
  }

  // ─── Durable Run State ─────────────────────────────────
  async saveRunState(taskId: string, state: RunState): Promise<void> {
    this.runStates.set(taskId, { ...state });
  }

  async loadRunState(taskId: string): Promise<RunState | null> {
    return this.runStates.get(taskId) ?? null;
  }

  async extendRunStateTTL(_taskId: string): Promise<void> {
    // No-op for in-memory (no TTL concept)
  }

  /** Test helper: get all tasks */
  getAllTasks(): TaskState[] {
    return [...this.tasks.values()];
  }

  /** Test helper: clear everything */
  clear(): void {
    this.conversations.clear();
    this.tasks.clear();
    this.memories = [];
    this.runStates.clear();
  }
}
