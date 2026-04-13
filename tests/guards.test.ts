import { describe, it, expect } from "vitest";
import { checkGuards, hasHardBlock } from "../src/core/guards.js";
import type { RunState, AgentConfig, StepResult } from "../src/core/types.js";
import { DEFAULT_CONFIG } from "../src/core/types.js";

function makeStep(overrides: Partial<StepResult> = {}): StepResult {
  return {
    iteration: 0,
    action: "use_tool",
    toolName: "some_tool",
    toolParams: {},
    toolResult: { tool: "some_tool", status: "ok", result: {} },
    confidence: 0.9,
    reasoning: "",
    costUsd: 0,
    latencyMs: 100,
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    iteration: 0,
    totalCostUsd: 0,
    startTime: Date.now(),
    replanCount: 0,
    toolCallCount: 0,
    recentSteps: [],
    ...overrides,
  };
}

describe("guards", () => {
  describe("confidence gate", () => {
    it("fires on low-confidence tool call", () => {
      const signals = checkGuards(
        makeState(),
        DEFAULT_CONFIG,
        "use_tool",
        0.3,
        "search",
      );
      expect(signals).toContainEqual(
        expect.objectContaining({ type: "confidence_low", action: "clarify" }),
      );
    });

    it("does NOT fire on non-tool actions even with low confidence", () => {
      const signals = checkGuards(
        makeState(),
        DEFAULT_CONFIG,
        "respond",
        0.1,
        null,
      );
      expect(signals.find((s) => s.type === "confidence_low")).toBeUndefined();
    });

    it("does NOT fire when confidence meets threshold", () => {
      const signals = checkGuards(
        makeState(),
        DEFAULT_CONFIG,
        "use_tool",
        0.6,
        "search",
      );
      expect(signals.find((s) => s.type === "confidence_low")).toBeUndefined();
    });
  });

  describe("iteration budget", () => {
    it("fires when iteration >= maxIterations", () => {
      const state = makeState({ iteration: 6 });
      const signals = checkGuards(
        state,
        DEFAULT_CONFIG,
        "use_tool",
        0.9,
        "search",
      );
      expect(signals).toContainEqual(
        expect.objectContaining({
          type: "budget_iterations",
          iteration: 6,
          max: 6,
        }),
      );
    });

    it("does NOT fire under limit", () => {
      const state = makeState({ iteration: 5 });
      const signals = checkGuards(
        state,
        DEFAULT_CONFIG,
        "use_tool",
        0.9,
        "search",
      );
      expect(
        signals.find((s) => s.type === "budget_iterations"),
      ).toBeUndefined();
    });
  });

  describe("cost budget", () => {
    it("fires when cost reaches cap", () => {
      const config: AgentConfig = { ...DEFAULT_CONFIG, costCapPerTask: 0.5 };
      const state = makeState({ totalCostUsd: 0.5 });
      const signals = checkGuards(state, config, "use_tool", 0.9, "search");
      expect(signals).toContainEqual(
        expect.objectContaining({ type: "budget_cost" }),
      );
    });

    it("does NOT fire when costCap is 0 (unlimited)", () => {
      const state = makeState({ totalCostUsd: 100 });
      const signals = checkGuards(
        state,
        DEFAULT_CONFIG,
        "use_tool",
        0.9,
        "search",
      );
      expect(signals.find((s) => s.type === "budget_cost")).toBeUndefined();
    });
  });

  describe("time budget", () => {
    it("fires when elapsed time exceeds timeout", () => {
      const config: AgentConfig = { ...DEFAULT_CONFIG, timeoutMs: 1000 };
      const state = makeState({ startTime: Date.now() - 1500 });
      const signals = checkGuards(state, config, "use_tool", 0.9, "search");
      expect(signals).toContainEqual(
        expect.objectContaining({ type: "budget_time" }),
      );
    });

    it("does NOT fire when timeoutMs is 0 (unlimited)", () => {
      const state = makeState({ startTime: Date.now() - 999999 });
      const signals = checkGuards(
        state,
        DEFAULT_CONFIG,
        "use_tool",
        0.9,
        "search",
      );
      expect(signals.find((s) => s.type === "budget_time")).toBeUndefined();
    });
  });

  describe("repetition guard", () => {
    it("fires when same tool called 3+ times consecutively", () => {
      const steps = [
        makeStep({ toolName: "search" }),
        makeStep({ toolName: "search" }),
      ];
      const state = makeState({ recentSteps: steps });
      const signals = checkGuards(
        state,
        DEFAULT_CONFIG,
        "use_tool",
        0.9,
        "search",
      );
      expect(signals).toContainEqual(
        expect.objectContaining({
          type: "repetition",
          toolName: "search",
          count: 3,
        }),
      );
    });

    it("does NOT fire when different tools are interleaved", () => {
      const steps = [
        makeStep({ toolName: "search" }),
        makeStep({ toolName: "other_tool" }),
      ];
      const state = makeState({ recentSteps: steps });
      const signals = checkGuards(
        state,
        DEFAULT_CONFIG,
        "use_tool",
        0.9,
        "search",
      );
      expect(signals.find((s) => s.type === "repetition")).toBeUndefined();
    });

    it("does NOT fire with fewer than 2 prior same-tool calls", () => {
      const steps = [makeStep({ toolName: "search" })];
      const state = makeState({ recentSteps: steps });
      const signals = checkGuards(
        state,
        DEFAULT_CONFIG,
        "use_tool",
        0.9,
        "search",
      );
      expect(signals.find((s) => s.type === "repetition")).toBeUndefined();
    });
  });

  describe("dead-end detection", () => {
    it("fires on 4+ failures across 2+ tools", () => {
      const steps = [
        makeStep({
          toolName: "a",
          toolResult: { tool: "a", status: "failed", result: {} },
        }),
        makeStep({
          toolName: "b",
          toolResult: { tool: "b", status: "failed", result: {} },
        }),
        makeStep({
          toolName: "a",
          toolResult: { tool: "a", status: "failed", result: {} },
        }),
        makeStep({
          toolName: "b",
          toolResult: { tool: "b", status: "failed", result: {} },
        }),
      ];
      const state = makeState({ recentSteps: steps });
      const signals = checkGuards(state, DEFAULT_CONFIG, "use_tool", 0.9, "c");
      expect(signals).toContainEqual(
        expect.objectContaining({ type: "dead_end" }),
      );
    });

    it("does NOT fire if failures are all from the same tool", () => {
      const steps = [
        makeStep({
          toolName: "a",
          toolResult: { tool: "a", status: "failed", result: {} },
        }),
        makeStep({
          toolName: "a",
          toolResult: { tool: "a", status: "failed", result: {} },
        }),
        makeStep({
          toolName: "a",
          toolResult: { tool: "a", status: "failed", result: {} },
        }),
        makeStep({
          toolName: "a",
          toolResult: { tool: "a", status: "failed", result: {} },
        }),
      ];
      const state = makeState({ recentSteps: steps });
      const signals = checkGuards(state, DEFAULT_CONFIG, "use_tool", 0.9, "a");
      expect(signals.find((s) => s.type === "dead_end")).toBeUndefined();
    });

    it("does NOT fire with fewer than 4 failures", () => {
      const steps = [
        makeStep({
          toolName: "a",
          toolResult: { tool: "a", status: "failed", result: {} },
        }),
        makeStep({
          toolName: "b",
          toolResult: { tool: "b", status: "failed", result: {} },
        }),
        makeStep({
          toolName: "a",
          toolResult: { tool: "a", status: "failed", result: {} },
        }),
      ];
      const state = makeState({ recentSteps: steps });
      const signals = checkGuards(state, DEFAULT_CONFIG, "use_tool", 0.9, "c");
      expect(signals.find((s) => s.type === "dead_end")).toBeUndefined();
    });
  });

  describe("hasHardBlock", () => {
    it("returns true for confidence_low", () => {
      expect(
        hasHardBlock([
          {
            type: "confidence_low",
            confidence: 0.3,
            threshold: 0.6,
            action: "clarify",
          },
        ]),
      ).toBe(true);
    });

    it("returns true for budget signals", () => {
      expect(
        hasHardBlock([{ type: "budget_cost", totalCost: 1, cap: 0.5 }]),
      ).toBe(true);
      expect(
        hasHardBlock([{ type: "budget_time", elapsedMs: 2000, cap: 1000 }]),
      ).toBe(true);
      expect(
        hasHardBlock([{ type: "budget_iterations", iteration: 6, max: 6 }]),
      ).toBe(true);
    });

    it("returns false for soft signals only", () => {
      expect(
        hasHardBlock([{ type: "repetition", toolName: "x", count: 3 }]),
      ).toBe(false);
      expect(
        hasHardBlock([{ type: "dead_end", failureCount: 4, toolCount: 2 }]),
      ).toBe(false);
    });

    it("returns false for empty array", () => {
      expect(hasHardBlock([])).toBe(false);
    });
  });
});
