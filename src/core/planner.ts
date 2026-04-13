/**
 * Planner — Plan tracking extracted from dalil's planner.
 *
 * dalil patterns:
 *   - Max 3 steps (configurable)
 *   - Skip planning for fast intents (greeting/faq)
 *   - Suppress acknowledge for single-step plans
 *   - Re-plan on failure (max 2 replans)
 *   - After 2 failures → freestyle fallback (clears plan)
 *
 * msm-agent delegates plan GENERATION to the brain (MSM orchestration layer
 * returns plan[] with steps). The planner here just TRACKS state.
 */

import type { PlanStep } from "msm-ai";
import type { TaskPlan } from "./types.js";

/**
 * Create a plan from the brain's orchestration output.
 * The brain decides the steps — we just track them.
 */
export function createPlan(steps: PlanStep[], reasoning: string): TaskPlan {
  return {
    steps: steps.map((s, i) => ({
      ...s,
      id: s.id ?? i + 1,
      status: i === 0 ? "current" : "pending",
    })),
    reasoning,
    replanCount: 0,
    createdAt: new Date().toISOString(),
  };
}

/** Mark the current step as done and advance to the next */
export function advancePlanStep(plan: TaskPlan): TaskPlan {
  const steps = plan.steps.map((s) => {
    if (s.status === "current") return { ...s, status: "done" as const };
    return s;
  });

  // Find next pending step and mark it current
  const nextIdx = steps.findIndex((s) => s.status === "pending");
  if (nextIdx >= 0) {
    steps[nextIdx] = { ...steps[nextIdx], status: "current" };
  }

  return { ...plan, steps };
}

/** Mark the current step as failed */
export function failPlanStep(plan: TaskPlan): TaskPlan {
  const steps = plan.steps.map((s) => {
    if (s.status === "current") return { ...s, status: "failed" as const };
    return s;
  });
  return { ...plan, steps };
}

/** Can we replan? (dalil: max 2 replans) */
export function canReplan(plan: TaskPlan, maxReplans: number): boolean {
  return plan.replanCount < maxReplans;
}

/** Replace the plan with a new one (increment replan counter) */
export function replan(
  plan: TaskPlan,
  newSteps: PlanStep[],
  reasoning: string,
): TaskPlan {
  return {
    steps: newSteps.map((s, i) => ({
      ...s,
      id: s.id ?? i + 1,
      status: i === 0 ? "current" : "pending",
    })),
    reasoning,
    replanCount: plan.replanCount + 1,
    createdAt: new Date().toISOString(),
  };
}

/** Clear the plan — freestyle fallback after exhausting replans */
export function clearPlan(): null {
  return null;
}

/** Is the plan complete? All steps done or failed */
export function isPlanComplete(plan: TaskPlan): boolean {
  return plan.steps.every((s) => s.status === "done" || s.status === "failed");
}

/** Get current step (if any) */
export function getCurrentStep(plan: TaskPlan): PlanStep | null {
  return plan.steps.find((s) => s.status === "current") ?? null;
}
