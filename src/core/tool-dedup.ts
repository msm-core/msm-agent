/**
 * Tool Dedup — Eliminates redundant tool calls before execution.
 *
 * In dalil: SHA-256 based idempotency guard for destructive tools,
 *           plus planning-phase dedup that detects duplicate/conflicting calls.
 *
 * msm-agent implementation: hash-based dedup with configurable window.
 * Same tool + same params within the window = skip (return cached result).
 */

import type { ToolResult } from "msm-ai";
import type { StepResult } from "./types.js";

export interface DedupResult {
  isDuplicate: boolean;
  cachedResult?: ToolResult;
}

/**
 * Check if a tool call is a duplicate of a recent call.
 * Uses the recent steps to detect same tool + same params.
 */
export function checkDedup(
  toolName: string,
  toolParams: Record<string, unknown>,
  recentSteps: StepResult[],
): DedupResult {
  // Hash the call signature
  const callHash = hashToolCall(toolName, toolParams);

  // Look for matching recent step with a successful result
  for (let i = recentSteps.length - 1; i >= 0; i--) {
    const step = recentSteps[i];
    if (
      step.toolName === toolName &&
      step.toolResult &&
      step.toolResult.status === "ok"
    ) {
      const stepHash = hashToolCall(step.toolName, step.toolParams ?? {});
      if (stepHash === callHash) {
        return { isDuplicate: true, cachedResult: step.toolResult };
      }
    }
  }

  return { isDuplicate: false };
}

/**
 * Create a stable hash of a tool call for dedup comparison.
 * Sorts object keys to ensure { a: 1, b: 2 } === { b: 2, a: 1 }.
 */
function hashToolCall(
  toolName: string,
  params: Record<string, unknown>,
): string {
  const sortedParams = stableStringify(params);
  return `${toolName}::${sortedParams}`;
}

/** JSON.stringify with sorted keys for stable comparison */
function stableStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map(stableStringify).join(",") + "]";
  }
  const sorted = Object.keys(obj as Record<string, unknown>)
    .sort()
    .map(
      (k) =>
        JSON.stringify(k) +
        ":" +
        stableStringify((obj as Record<string, unknown>)[k]),
    );
  return "{" + sorted.join(",") + "}";
}
