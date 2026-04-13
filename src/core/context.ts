/**
 * Context Builder — Assembles brain input from agent state.
 *
 * dalil does 5-layer prompt assembly with compaction. msm-agent keeps it simpler:
 * the brain (MSM) handles prompting internally. The context builder just assembles
 * the structured input the brain needs: conversation history + tool results.
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
}

/**
 * Build the input for the MSM brain.
 *
 * Conversation history is fetched from memory, compressed if needed.
 * Tool results from previous iterations are passed back so the brain
 * can decide the next step.
 */
export async function buildContext(
  options: ContextOptions,
): Promise<BrainInput> {
  const { sessionId, text, modality, memory, state, lastToolResult } = options;

  // Fetch conversation history
  const messages = await memory.getConversation(sessionId);

  // Compress history: if > 10 messages, keep last 6
  const history = compressHistory(messages);

  // Build brain input
  const input: BrainInput = {
    raw: text,
    modality,
    history,
  };

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

/** Compress conversation history: last 6 messages if over 10 */
function compressHistory(
  messages: Message[],
): Array<{ role: "user" | "assistant"; content: string }> {
  const relevant = messages.filter(
    (m) => m.role === "user" || m.role === "assistant",
  );
  const window = relevant.length > 10 ? relevant.slice(-6) : relevant;
  return window.map((m) => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));
}
