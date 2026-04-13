/**
 * InMemoryAdapter — Zero-infrastructure memory for testing and demos.
 */

import type { Message, TaskState, TaskPlan, StepResult } from "../core/types.js";
import type { MemoryAdapter, MemoryEntry } from "../adapters/memory.js";

export class InMemoryAdapter implements MemoryAdapter {
  private conversations = new Map<string, Message[]>();
  private tasks = new Map<string, TaskState>();
  private memories: MemoryEntry[] = [];

  async getConversation(sessionId: string): Promise<Message[]> {
    return this.conversations.get(sessionId) ?? [];
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

  async updateTaskStatus(taskId: string, status: TaskState["status"]): Promise<void> {
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

  /** Test helper: get all tasks */
  getAllTasks(): TaskState[] {
    return [...this.tasks.values()];
  }

  /** Test helper: clear everything */
  clear(): void {
    this.conversations.clear();
    this.tasks.clear();
    this.memories = [];
  }
}
