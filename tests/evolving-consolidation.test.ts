/**
 * Phase 17 — Deeper Evolving Layer Tests
 *
 * Tests for:
 * - computeDecayScore() — decay formula
 * - computeTaskWeight() — task complexity weighting
 * - areContradictory() — contradiction detection
 * - consolidateStrategies() — prune stale notes, resolve contradictions
 * - MemoryEvolvingAdapter.consolidate() — delegates to consolidateStrategies
 * - QualityScore.weight field (optional, Phase 17 extension)
 */

import { describe, it, expect, vi } from "vitest";
import {
  computeDecayScore,
  computeTaskWeight,
  areContradictory,
  consolidateStrategies,
  DECAY_PRUNE_THRESHOLD,
  CONTRADICTION_PAIRS,
} from "../src/adapters/evolving-consolidation.js";
import { MemoryEvolvingAdapter } from "../src/adapters/evolving.js";
import type { MemoryAdapter, MemoryEntry } from "../src/adapters/memory.js";
import type { QualityScore } from "../src/core/quality.js";

// ─── computeDecayScore() ──────────────────────────────────────

describe("computeDecayScore()", () => {
  it("returns high score for recent entries with many events", () => {
    // 10 events, recorded today (0 days old)
    const score = computeDecayScore(10, 0);
    // 10 / (0 + 1) * 1.0 = 10
    expect(score).toBeCloseTo(10, 2);
  });

  it("applies 1.0 recency weight for events < 7 days old", () => {
    const score = computeDecayScore(5, 3);
    // 5 / (3 + 1) * 1.0 = 1.25
    expect(score).toBeCloseTo(1.25, 2);
  });

  it("applies 0.5 recency weight for events 7–29 days old", () => {
    const score = computeDecayScore(5, 14);
    // 5 / (14 + 1) * 0.5 = 5/15 * 0.5 ≈ 0.1667
    expect(score).toBeCloseTo((5 / 15) * 0.5, 4);
  });

  it("applies 0.1 recency weight for events 30+ days old", () => {
    const score = computeDecayScore(5, 60);
    // 5 / (60 + 1) * 0.1 ≈ 0.0082
    expect(score).toBeCloseTo((5 / 61) * 0.1, 4);
  });

  it("returns a low score for a single event that is very old", () => {
    const score = computeDecayScore(1, 90);
    // 1 / 91 * 0.1 ≈ 0.0011
    expect(score).toBeLessThan(DECAY_PRUNE_THRESHOLD);
  });

  it("single event recorded today is above prune threshold", () => {
    const score = computeDecayScore(1, 0);
    // 1 / 1 * 1.0 = 1.0
    expect(score).toBeGreaterThan(DECAY_PRUNE_THRESHOLD);
  });
});

// ─── computeTaskWeight() ──────────────────────────────────────

describe("computeTaskWeight()", () => {
  it("returns 1 + 0 + 1 = 2 for zero tools and matched iterations", () => {
    // 0 tools, maxIter=5, actualIter=5 → log(1) + 5/5 = 0 + 1 = 1 base+1 = 2
    const w = computeTaskWeight(0, 5, 5);
    expect(w).toBeCloseTo(2, 3);
  });

  it("increases weight with more tool calls", () => {
    const w1 = computeTaskWeight(2, 5, 5);
    const w2 = computeTaskWeight(10, 5, 5);
    expect(w2).toBeGreaterThan(w1);
  });

  it("increases weight when actualIterations is much less than max", () => {
    // Very fast resolution: 1 iteration out of 10 max
    const fast = computeTaskWeight(0, 10, 10); // used all iters
    const superFast = computeTaskWeight(0, 10, 1); // used 1 iter
    expect(superFast).toBeGreaterThan(fast);
  });

  it("handles zero actualIterations without throwing (defaults to 1 factor)", () => {
    const w = computeTaskWeight(2, 5, 0);
    expect(Number.isFinite(w)).toBe(true);
    expect(w).toBeGreaterThan(1);
  });

  it("weight is always >= 1", () => {
    const w = computeTaskWeight(0, 1, 1);
    expect(w).toBeGreaterThanOrEqual(1);
  });
});

// ─── areContradictory() ───────────────────────────────────────

describe("areContradictory()", () => {
  it("detects ask clarifying questions vs respond directly", () => {
    const a = "Ask clarifying questions when intent is ambiguous.";
    const b = "Respond directly without asking.";
    expect(areContradictory(a, b)).toBe(true);
  });

  it("detects contradiction in reverse order", () => {
    const a = "Respond directly to the user.";
    const b = "Ask clarifying questions first.";
    expect(areContradictory(a, b)).toBe(true);
  });

  it("detects multi-step planning vs direct tool calls", () => {
    const a = "Use multi-step planning for complex tasks.";
    const b = "Prioritize direct tool calls.";
    expect(areContradictory(a, b)).toBe(true);
  });

  it("returns false for non-contradictory notes", () => {
    const a = "Verify tool parameters carefully before execution.";
    const b = "Always check the order ID before proceeding.";
    expect(areContradictory(a, b)).toBe(false);
  });

  it("returns false for identical content", () => {
    const a = "Ask clarifying questions when intent is ambiguous.";
    expect(areContradictory(a, a)).toBe(false);
  });

  it("is case-insensitive", () => {
    const a = "ASK CLARIFYING QUESTIONS about the user's goal.";
    const b = "RESPOND DIRECTLY without extra steps.";
    expect(areContradictory(a, b)).toBe(true);
  });

  it("CONTRADICTION_PAIRS has the expected pairs", () => {
    expect(CONTRADICTION_PAIRS.length).toBeGreaterThanOrEqual(2);
    const flat = CONTRADICTION_PAIRS.flatMap((p) => p);
    expect(flat).toContain("ask clarifying questions");
    expect(flat).toContain("respond directly");
  });
});

// ─── consolidateStrategies() ──────────────────────────────────

function makeEntry(
  overrides: Partial<MemoryEntry> & { id: string; content: string },
): MemoryEntry {
  return {
    source: "evolution.strategy",
    confidence: 0.8,
    createdAt: new Date().toISOString(),
    metadata: {},
    ...overrides,
  } as MemoryEntry;
}

function makeMockMemory(
  entries: MemoryEntry[],
): MemoryAdapter & { delete: ReturnType<typeof vi.fn> } {
  const deleteStub = vi.fn().mockResolvedValue(undefined);
  return {
    getConversation: vi.fn().mockResolvedValue([]),
    addMessage: vi.fn().mockResolvedValue(undefined),
    getTask: vi.fn().mockResolvedValue(null),
    saveTask: vi.fn().mockResolvedValue(undefined),
    updatePlan: vi.fn().mockResolvedValue(undefined),
    addStep: vi.fn().mockResolvedValue(undefined),
    updateTaskStatus: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue(entries),
    store: vi.fn().mockResolvedValue(undefined),
    delete: deleteStub,
  } as unknown as MemoryAdapter & { delete: ReturnType<typeof vi.fn> };
}

describe("consolidateStrategies()", () => {
  it("returns empty report when no strategy entries exist", async () => {
    const memory = makeMockMemory([]);
    const report = await consolidateStrategies(memory);

    expect(report.pruned).toBe(0);
    expect(report.contradictionsResolved).toBe(0);
    expect(report.consolidatedAt).toBeTruthy();
  });

  it("prunes stale strategy notes (decayScore < threshold)", async () => {
    // Entry created 90 days ago → very low decay score
    const oldDate = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const staleEntry = makeEntry({
      id: "stale-1",
      content: "Ask clarifying questions when intent is ambiguous.",
      source: "evolution.strategy",
      createdAt: oldDate,
    });

    const memory = makeMockMemory([staleEntry]);
    const report = await consolidateStrategies(memory);

    expect(report.pruned).toBe(1);
    expect(memory.delete).toHaveBeenCalledWith("stale-1");
  });

  it("keeps fresh strategy notes (decayScore >= threshold)", async () => {
    // Entry created today → high decay score
    const freshEntry = makeEntry({
      id: "fresh-1",
      content: "Verify tool parameters before execution.",
      source: "evolution.strategy",
      createdAt: new Date().toISOString(),
    });

    const memory = makeMockMemory([freshEntry]);
    const report = await consolidateStrategies(memory);

    expect(report.pruned).toBe(0);
    expect(memory.delete).not.toHaveBeenCalledWith("fresh-1");
  });

  it("resolves contradictions between two fresh notes — removes lower-scored", async () => {
    // Both notes are fresh (today), but we force one to be "older" by adjusting createdAt
    const slightlyOlder = new Date(
      Date.now() - 1 * 24 * 3600 * 1000,
    ).toISOString(); // 1 day old
    const newest = new Date().toISOString();

    const noteA = makeEntry({
      id: "note-a",
      content: "Ask clarifying questions when the user's intent is ambiguous.",
      source: "evolution.strategy",
      createdAt: newest, // higher decay score (newer)
    });
    const noteB = makeEntry({
      id: "note-b",
      content: "Respond directly without asking extra questions.",
      source: "evolution.strategy",
      createdAt: slightlyOlder, // slightly lower decay score (1 day older)
    });

    const memory = makeMockMemory([noteA, noteB]);
    const report = await consolidateStrategies(memory);

    expect(report.contradictionsResolved).toBe(1);
    // note-b has older createdAt → lower decay score → should be removed
    expect(memory.delete).toHaveBeenCalledWith("note-b");
    expect(memory.delete).not.toHaveBeenCalledWith("note-a");
  });

  it("does not flag non-contradictory notes as contradictions", async () => {
    const noteA = makeEntry({
      id: "note-x",
      content: "Verify tool parameters carefully before execution.",
      source: "evolution.strategy",
      createdAt: new Date().toISOString(),
    });
    const noteB = makeEntry({
      id: "note-y",
      content: "Always summarise the outcome at the end of each task.",
      source: "evolution.strategy",
      createdAt: new Date().toISOString(),
    });

    const memory = makeMockMemory([noteA, noteB]);
    const report = await consolidateStrategies(memory);

    expect(report.contradictionsResolved).toBe(0);
    expect(memory.delete).not.toHaveBeenCalled();
  });

  it("report includes a valid ISO timestamp", async () => {
    const memory = makeMockMemory([]);
    const report = await consolidateStrategies(memory);
    expect(() => new Date(report.consolidatedAt)).not.toThrow();
    expect(new Date(report.consolidatedAt).getFullYear()).toBeGreaterThan(2020);
  });
});

// ─── MemoryEvolvingAdapter.consolidate() ─────────────────────

describe("MemoryEvolvingAdapter.consolidate()", () => {
  it("is defined on MemoryEvolvingAdapter instances", () => {
    const mockMemory = makeMockMemory([]);
    const adapter = new MemoryEvolvingAdapter(mockMemory, "shadow");
    expect(typeof adapter.consolidate).toBe("function");
  });

  it("delegates to consolidateStrategies and returns a report", async () => {
    const mockMemory = makeMockMemory([]);
    const adapter = new MemoryEvolvingAdapter(mockMemory, "shadow");
    const report = await adapter.consolidate(mockMemory);

    expect(report).toMatchObject({
      pruned: expect.any(Number),
      contradictionsResolved: expect.any(Number),
      consolidatedAt: expect.any(String),
    });
  });
});

// ─── QualityScore.weight (Phase 17 extension) ─────────────────

describe("QualityScore.weight field", () => {
  it("weight is optional on QualityScore", () => {
    const score: QualityScore = {
      resolution: 1,
      efficiency: 0.9,
      errorRate: 1,
      flags: [],
      // weight is intentionally omitted
    };
    expect(score.weight).toBeUndefined();
  });

  it("weight can be set explicitly", () => {
    const score: QualityScore = {
      resolution: 1,
      efficiency: 0.9,
      errorRate: 1,
      flags: [],
      weight: 3.5,
    };
    expect(score.weight).toBe(3.5);
  });
});
