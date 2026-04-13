/**
 * Guards — Safety mechanisms extracted from dalil's execution engine.
 *
 * dalil patterns:
 *   - Confidence gate: <0.6 on tool calls → ask_clarification
 *   - Repetition guard: same tool 3+ times → signal LLM
 *   - Dead-end detection: 4+ failures across 2+ tools → signal LLM
 *   - Budget guards: cost cap, tool call limit, time limit
 *   - Iteration limit: max 6 steps → force respond
 */

import type {
  AgentConfig,
  GuardSignal,
  RunState,
  StepResult,
} from "./types.js";

/**
 * Check all guards and return any triggered signals.
 * Hard guards (budget, confidence) block execution.
 * Soft guards (repetition, dead-end) are advisory signals.
 */
export function checkGuards(
  state: RunState,
  config: AgentConfig,
  currentAction: string,
  currentConfidence: number,
  currentToolName: string | null,
): GuardSignal[] {
  const signals: GuardSignal[] = [];

  // ─── Hard: Iteration limit ─────────────────────────────────
  if (state.iteration >= config.maxIterations) {
    signals.push({
      type: "budget_iterations",
      iteration: state.iteration,
      max: config.maxIterations,
    });
  }

  // ─── Hard: Confidence gate (dalil: 0.6 threshold) ─────────
  if (
    currentAction === "use_tool" &&
    currentConfidence < config.confidenceThreshold
  ) {
    signals.push({
      type: "confidence_low",
      confidence: currentConfidence,
      threshold: config.confidenceThreshold,
      action: "clarify",
    });
  }

  // ─── Hard: Cost cap ────────────────────────────────────────
  if (
    config.costCapPerTask > 0 &&
    state.totalCostUsd >= config.costCapPerTask
  ) {
    signals.push({
      type: "budget_cost",
      totalCost: state.totalCostUsd,
      cap: config.costCapPerTask,
    });
  }

  // ─── Hard: Time limit ──────────────────────────────────────
  if (config.timeoutMs > 0) {
    const elapsed = Date.now() - state.startTime;
    if (elapsed >= config.timeoutMs) {
      signals.push({
        type: "budget_time",
        elapsedMs: elapsed,
        cap: config.timeoutMs,
      });
    }
  }

  // ─── Soft: Repetition guard (dalil: 3+ same tool) ─────────
  if (currentToolName && state.recentSteps.length >= 2) {
    const consecutive = countConsecutiveSameTool(
      state.recentSteps,
      currentToolName,
    );
    if (consecutive >= 2) {
      // Current call would be the 3rd+
      signals.push({
        type: "repetition",
        toolName: currentToolName,
        count: consecutive + 1,
      });
    }
  }

  // ─── Soft: Dead-end detection (dalil: 4+ failures, 2+ tools)
  const deadEnd = detectDeadEnd(state.recentSteps);
  if (deadEnd) {
    signals.push(deadEnd);
  }

  return signals;
}

/** Are any of the signals hard-blocking? */
export function hasHardBlock(signals: GuardSignal[]): boolean {
  return signals.some(
    (s) =>
      s.type === "confidence_low" ||
      s.type === "budget_cost" ||
      s.type === "budget_time" ||
      s.type === "budget_iterations",
  );
}

/** Count consecutive calls to the same tool at the tail of recent steps */
function countConsecutiveSameTool(
  steps: StepResult[],
  toolName: string,
): number {
  let count = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    if (steps[i].toolName === toolName) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/** Detect dead-end: 4+ recent failures across 2+ different tools */
function detectDeadEnd(steps: StepResult[]): GuardSignal | null {
  const recent = steps.slice(-6);
  const failures = recent.filter(
    (s) => s.toolResult && s.toolResult.status === "failed",
  );
  if (failures.length < 4) return null;

  const uniqueTools = new Set(failures.map((s) => s.toolName).filter(Boolean));
  if (uniqueTools.size < 2) return null;

  return {
    type: "dead_end",
    failureCount: failures.length,
    toolCount: uniqueTools.size,
  };
}
