import { describe, it, expect } from "vitest";
import { checkDedup } from "../src/core/tool-dedup.js";
import type { StepResult } from "../src/core/types.js";

function makeStep(
  toolName: string,
  params: Record<string, unknown>,
  status: "ok" | "failed" = "ok",
): StepResult {
  return {
    iteration: 0,
    action: "use_tool",
    toolName,
    toolParams: params,
    toolResult: {
      tool: toolName,
      status,
      result: { data: `${toolName}-result` },
    },
    confidence: 0.9,
    reasoning: "",
    costUsd: 0,
    latencyMs: 100,
    timestamp: new Date().toISOString(),
  };
}

describe("tool-dedup", () => {
  it("detects duplicate call with same tool + same params", () => {
    const steps = [makeStep("search", { query: "pizza" })];
    const result = checkDedup("search", { query: "pizza" }, steps);
    expect(result.isDuplicate).toBe(true);
    expect(result.cachedResult?.tool).toBe("search");
  });

  it("does NOT flag as duplicate when params differ", () => {
    const steps = [makeStep("search", { query: "pizza" })];
    const result = checkDedup("search", { query: "sushi" }, steps);
    expect(result.isDuplicate).toBe(false);
  });

  it("does NOT flag as duplicate when tool name differs", () => {
    const steps = [makeStep("search", { query: "pizza" })];
    const result = checkDedup("lookup", { query: "pizza" }, steps);
    expect(result.isDuplicate).toBe(false);
  });

  it("does NOT flag as duplicate when previous call failed", () => {
    const steps = [makeStep("search", { query: "pizza" }, "failed")];
    const result = checkDedup("search", { query: "pizza" }, steps);
    expect(result.isDuplicate).toBe(false);
  });

  it("handles param key order differences (stable hash)", () => {
    const steps = [makeStep("api", { a: 1, b: 2 })];
    const result = checkDedup("api", { b: 2, a: 1 }, steps);
    expect(result.isDuplicate).toBe(true);
  });

  it("handles nested object params", () => {
    const steps = [makeStep("api", { filter: { type: "food", limit: 10 } })];
    const result = checkDedup(
      "api",
      { filter: { limit: 10, type: "food" } },
      steps,
    );
    expect(result.isDuplicate).toBe(true);
  });

  it("returns false for empty steps", () => {
    const result = checkDedup("search", { query: "test" }, []);
    expect(result.isDuplicate).toBe(false);
  });

  it("matches the most recent successful call", () => {
    const steps = [
      makeStep("search", { query: "old" }),
      makeStep("search", { query: "pizza" }),
    ];
    const result = checkDedup("search", { query: "pizza" }, steps);
    expect(result.isDuplicate).toBe(true);
    expect(result.cachedResult?.result).toEqual({ data: "search-result" });
  });
});
