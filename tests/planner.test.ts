import { describe, it, expect } from "vitest";
import {
  createPlan,
  advancePlanStep,
  failPlanStep,
  canReplan,
  replan,
  clearPlan,
  isPlanComplete,
  getCurrentStep,
} from "../src/core/planner.js";
import type { PlanStep } from "msm-ai";

const sampleSteps: PlanStep[] = [
  { id: 1, description: "Search inventory", tool_hint: "search_api", status: "pending" },
  { id: 2, description: "Check pricing", tool_hint: "price_api", status: "pending" },
  { id: 3, description: "Respond to user", tool_hint: null, status: "pending" },
];

describe("planner", () => {
  describe("createPlan", () => {
    it("creates a plan with first step marked current", () => {
      const plan = createPlan(sampleSteps, "Need to search then price check");
      expect(plan.steps[0].status).toBe("current");
      expect(plan.steps[1].status).toBe("pending");
      expect(plan.steps[2].status).toBe("pending");
      expect(plan.replanCount).toBe(0);
      expect(plan.reasoning).toBe("Need to search then price check");
    });

    it("assigns sequential IDs if missing", () => {
      const steps: PlanStep[] = [
        { id: 0, description: "A", tool_hint: null, status: "pending" },
        { id: 0, description: "B", tool_hint: null, status: "pending" },
      ];
      const plan = createPlan(steps, "test");
      // id 0 is falsy so should get reassigned
      expect(plan.steps[0].id).toBeDefined();
      expect(plan.steps[1].id).toBeDefined();
    });
  });

  describe("advancePlanStep", () => {
    it("marks current as done and advances to next pending", () => {
      const plan = createPlan(sampleSteps, "test");
      const advanced = advancePlanStep(plan);
      expect(advanced.steps[0].status).toBe("done");
      expect(advanced.steps[1].status).toBe("current");
      expect(advanced.steps[2].status).toBe("pending");
    });

    it("handles advancing the last step", () => {
      let plan = createPlan(sampleSteps, "test");
      plan = advancePlanStep(plan); // step 1 done, step 2 current
      plan = advancePlanStep(plan); // step 2 done, step 3 current
      plan = advancePlanStep(plan); // step 3 done, no more
      expect(plan.steps.every((s) => s.status === "done")).toBe(true);
    });
  });

  describe("failPlanStep", () => {
    it("marks the current step as failed", () => {
      const plan = createPlan(sampleSteps, "test");
      const failed = failPlanStep(plan);
      expect(failed.steps[0].status).toBe("failed");
      expect(failed.steps[1].status).toBe("pending");
    });
  });

  describe("canReplan", () => {
    it("allows replan when under limit", () => {
      const plan = createPlan(sampleSteps, "test");
      expect(canReplan(plan, 2)).toBe(true);
    });

    it("denies replan at the limit", () => {
      const plan = { ...createPlan(sampleSteps, "test"), replanCount: 2 };
      expect(canReplan(plan, 2)).toBe(false);
    });
  });

  describe("replan", () => {
    it("creates a new plan with incremented replanCount", () => {
      const plan = createPlan(sampleSteps, "original");
      const newSteps: PlanStep[] = [
        { id: 1, description: "New approach", tool_hint: "alt_api", status: "pending" },
      ];
      const replanned = replan(plan, newSteps, "trying different approach");
      expect(replanned.replanCount).toBe(1);
      expect(replanned.steps).toHaveLength(1);
      expect(replanned.steps[0].status).toBe("current");
      expect(replanned.reasoning).toBe("trying different approach");
    });
  });

  describe("clearPlan", () => {
    it("returns null (freestyle fallback)", () => {
      expect(clearPlan()).toBeNull();
    });
  });

  describe("isPlanComplete", () => {
    it("returns true when all steps are done", () => {
      let plan = createPlan(sampleSteps, "test");
      plan = advancePlanStep(plan);
      plan = advancePlanStep(plan);
      plan = advancePlanStep(plan);
      expect(isPlanComplete(plan)).toBe(true);
    });

    it("returns true when all steps are done or failed", () => {
      let plan = createPlan(sampleSteps, "test");
      plan = failPlanStep(plan); // step 1 failed
      // Steps 2 and 3 still pending — not complete
      expect(isPlanComplete(plan)).toBe(false);
    });

    it("returns false when pending steps remain", () => {
      const plan = createPlan(sampleSteps, "test");
      expect(isPlanComplete(plan)).toBe(false);
    });
  });

  describe("getCurrentStep", () => {
    it("returns the current step", () => {
      const plan = createPlan(sampleSteps, "test");
      const current = getCurrentStep(plan);
      expect(current?.description).toBe("Search inventory");
    });

    it("returns null when no step is current", () => {
      let plan = createPlan(sampleSteps, "test");
      plan = advancePlanStep(plan);
      plan = advancePlanStep(plan);
      plan = advancePlanStep(plan);
      expect(getCurrentStep(plan)).toBeNull();
    });
  });
});
