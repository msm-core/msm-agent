/**
 * Context Builder — Assembles brain input from agent state.
 *
 * dalil does 5-layer prompt assembly (Working, Episodic, Semantic, Procedural,
 * Reflection) with strict compaction rules. msm-agent gives you the hooks to
 * replicate that level of sophistication:
 *
 *  - Task state is serialized into system_context
 *  - Semantic memory is queried via MemoryAdapter.search() if available
 *  - History compaction can be overridden with a custom compactHistory hook
 *  - Tool results from previous iterations are passed back
 */

import type { ToolResult } from "msm-ai";
import type { Message, RunState, TaskState } from "./types.js";
import type { MemoryAdapter, MemoryEntry } from "../adapters/memory.js";
import type { ToolAdapter } from "../adapters/tools.js";

export interface BrainInput {
  raw: string;
  modality: "text" | "voice" | "image";
  history: Array<{ role: "user" | "assistant"; content: string }>;
  tool_results?: ToolResult[];
  /** Assembled system context: task state, semantic memories, tool catalog */
  system_context?: string;
}

export interface ContextOptions {
  sessionId: string;
  text: string;
  modality: "text" | "voice" | "image";
  memory: MemoryAdapter;
  tools: ToolAdapter;
  state: RunState;
  task: TaskState | null;
  /** Tool results from the last iteration (if resuming after tool execution) */
  lastToolResult?: ToolResult;
  /**
   * Optional: custom history compaction.
   * Receives full conversation, returns compacted history array.
   * Use this to inject an LLM-based summarizer instead of naive truncation.
   * If not provided, falls back to prefix-summary + tail window heuristic.
   */
  compactHistory?: (
    messages: Message[],
  ) => Promise<Array<{ role: "user" | "assistant"; content: string }>>;
}

/**
 * Build the input for the MSM brain.
 *
 * 1. Fetches conversation history from memory
 * 2. Compacts history (custom hook or built-in heuristic)
 * 3. Queries semantic/episodic memory if MemoryAdapter.search() is available
 * 4. Serializes task state (status, plan, recent failures)
 * 5. Assembles tool results from previous iterations
 */
export async function buildContext(
  options: ContextOptions,
): Promise<BrainInput> {
  const { sessionId, text, modality, memory, state, lastToolResult, task } =
    options;

  // Fetch conversation history
  const messages = await memory.getConversation(sessionId);

  // Compact history — custom hook or built-in heuristic
  const history = options.compactHistory
    ? await options.compactHistory(messages)
    : compressHistory(messages);

  // Build system context: task state + semantic memory + tool catalog
  const contextParts: string[] = [];

  // ── Task State ──────────────────────────────────────────
  if (task) {
    const taskLines: string[] = [`[Task ${task.taskId}] status=${task.status}`];
    if (task.plan) {
      const currentIdx = task.plan.steps.findIndex(
        (s) => s.status === "pending",
      );
      taskLines.push(
        `Plan: ${task.plan.steps.length} steps, current=${currentIdx >= 0 ? currentIdx + 1 : "done"}, replans=${task.plan.replanCount}`,
      );
    }
    const recentFailures = state.recentSteps.filter(
      (s) => s.toolResult?.status === "failed",
    );
    if (recentFailures.length > 0) {
      taskLines.push(
        `Recent failures: ${recentFailures.map((f) => `${f.toolName}(${JSON.stringify(f.toolResult?.result)})`).join(", ")}`,
      );
    }
    contextParts.push(taskLines.join("\n"));
  }

  // ── Semantic/Episodic Memory ────────────────────────────
  if (memory.search) {
    try {
      const memories = await memory.search(text, 5);
      if (memories.length > 0) {
        const memoryLines = memories.map((m) => `- [${m.source}] ${m.content}`);
        contextParts.push("Relevant memories:\n" + memoryLines.join("\n"));
      }
    } catch {
      // search is optional — silently skip on failure
    }
  }

  // ── Available Tools ─────────────────────────────────────
  const toolDefs = options.tools.list();
  if (toolDefs.length > 0) {
    const toolLines = toolDefs.map(
      (t) =>
        `- ${t.name}: ${t.description}${t.destructive ? " [destructive]" : ""}`,
    );
    contextParts.push("Available tools:\n" + toolLines.join("\n"));
  }

  // Build brain input
  const input: BrainInput = {
    raw: text,
    modality,
    history,
  };

  if (contextParts.length > 0) {
    input.system_context = contextParts.join("\n\n");
  }

  // If we have tool results from a previous iteration, include them
  if (lastToolResult) {
    input.tool_results = [lastToolResult];
  } else if (state.recentSteps.length > 0) {
    // Collect tool results from recent steps
    const toolResults = state.recentSteps
      .filter((s) => s.toolResult !== null)
      .map((s) => s.toolResult!);
    if (toolResults.length > 0) {
      input.tool_results = toolResults;
    }
  }

  return input;
}

/**
 * Built-in history compaction heuristic.
 *
 * If history ≤ 10 messages: pass through unchanged.
 * If history > 10: summarize dropped prefix as a single "[Earlier: ...]"
 * entry, then keep the last 6 messages for recency.
 */
function compressHistory(
  messages: Message[],
): Array<{ role: "user" | "assistant"; content: string }> {
  const relevant = messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  if (relevant.length <= 10) {
    return relevant.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
  }

  // Summarize the dropped prefix so the brain knows what was discussed
  const dropped = relevant.slice(0, -6);
  const topics = dropped
    .filter((m) => m.role === "user")
    .map((m) => {
      // Take first 80 chars of each user message as a topic hint
      const text =
        m.content.length > 80 ? m.content.slice(0, 80) + "…" : m.content;
      return text;
    });
  const summary: { role: "user" | "assistant"; content: string } = {
    role: "assistant",
    content: `[Earlier conversation summary: User discussed: ${topics.join("; ")}]`,
  };

  const tail = relevant.slice(-6).map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  return [summary, ...tail];
}
