/**
 * Quality Scoring — Phase 13
 *
 * Signal-based quality scoring after each task outcome.
 * Zero LLM cost — computed entirely from the LoopOutcome structure.
 *
 * Three dimensions:
 *   resolution  — did the agent actually answer the user? (1=response, 0=error)
 *   efficiency  — how many tools were needed? (1=direct, 0=verbose)
 *   errorRate   — how often did tools fail? (1=no failures, 0=all failed)
 *
 * Flags are derived from threshold crossings and feed into Phase 14's
 * self-improvement loop via EvolvingAdapter.postOutcome().
 *
 * Phase 14 — Strategy Notes
 *
 * FLAG_STRATEGIES maps each quality flag to an actionable hint string.
 * MemoryEvolvingAdapter.refreshStrategies() analyses accumulated flags and
 * writes strategy notes back to memory, which preReason() retrieves on startup.
 */

import type { LoopOutcome } from "./types.js";

// ─── Types ────────────────────────────────────────────────────

export type QualityFlag =
  | "failed_resolution" // agent could not resolve the user's request
  | "slow_response" // agent used too many tool calls (>3)
  | "high_error_rate"; // >30% of tool calls failed

export interface QualityScore {
  /** 0–1: likelihood the user's request was resolved */
  resolution: number;
  /** 0–1: 1=direct answer (≤1 tool), 0=verbose (>5 tools) */
  efficiency: number;
  /** 0–1: 1=no tool failures, 0=all tools failed */
  errorRate: number;
  /** Threshold-crossed quality problems */
  flags: QualityFlag[];
  /**
   * Task complexity weight — Phase 17.
   * Scales the influence of this signal in refreshStrategies() flag counting.
   * 1 = minimal complexity (no tools, direct answer). Higher = more complex task.
   * Computed by computeTaskWeight() when toolCount and iteration data are available.
   * Defaults to 1 when not set (pre-Phase-17 behaviour preserved).
   */
  weight?: number;
}

// ─── Flag → Strategy mapping (Phase 14) ──────────────────────

/**
 * Maps each quality flag to an actionable strategy note.
 * These are injected into the system prompt by the evolving layer
 * to nudge the agent toward better behaviour over time.
 */
export const FLAG_STRATEGIES: Record<QualityFlag, string> = {
  failed_resolution:
    "Ask clarifying questions when the user's intent is ambiguous rather than attempting and failing",
  slow_response:
    "Prioritize direct tool calls over multi-step planning when the intent is clear",
  high_error_rate:
    "Verify tool parameters carefully before execution to reduce failed calls",
};

// ─── scoreOutcome ─────────────────────────────────────────────

/**
 * Compute a QualityScore for a completed LoopOutcome.
 *
 * All signals are derived from the LoopOutcome itself — no RunState needed:
 *   outcome.evidence   — all tool interactions (including failed ones)
 *   outcome.receipts   — only successful tool calls
 *   outcome.type       — terminal action classification
 *
 * Returns a zeroed score for non-scored types (suppressed, aborted).
 */
export function scoreOutcome(outcome: LoopOutcome): QualityScore {
  // ── Resolution ────────────────────────────────────────────
  let resolution: number;
  switch (outcome.type) {
    case "response":
      resolution = 1.0;
      break;
    case "clarification":
    case "delegated":
      resolution = 0.7; // partial — intent identified but not fully resolved
      break;
    case "escalated":
      resolution = 0.5; // handed off — counted as partial, not failure
      break;
    case "waiting_approval":
      resolution = 0.8; // pending user — agent did its job
      break;
    case "error":
    case "aborted":
      resolution = 0.0;
      break;
    default:
      resolution = 0.5; // custom, suppressed — neutral
  }

  // ── Efficiency (from evidence / receipts counts) ──────────
  const totalTools =
    "evidence" in outcome ? (outcome.evidence?.length ?? 0) : 0;
  let efficiency: number;
  if (totalTools === 0) {
    efficiency = 1.0; // direct answer, no tools
  } else if (totalTools <= 1) {
    efficiency = 0.9;
  } else if (totalTools <= 3) {
    efficiency = 0.7;
  } else if (totalTools <= 5) {
    efficiency = 0.4;
  } else {
    efficiency = 0.1;
  }

  // ── Error Rate (failed = evidence - receipts) ─────────────
  const successTools =
    "receipts" in outcome ? (outcome.receipts?.length ?? 0) : 0;
  const failedTools = Math.max(0, totalTools - successTools);
  const errorRate = totalTools > 0 ? 1 - failedTools / totalTools : 1.0; // no tools = no errors

  // ── Flags ─────────────────────────────────────────────────
  const flags: QualityFlag[] = [];
  if (resolution < 0.5) flags.push("failed_resolution");
  if (efficiency < 0.5) flags.push("slow_response"); // >3 tools
  if (errorRate < 0.7) flags.push("high_error_rate"); // >30% failure

  return { resolution, efficiency, errorRate, flags };
}
