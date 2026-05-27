/**
 * Tests for Phase 12–14:
 *   Phase 12 — Equipment Prompt Injection (renderEquipmentBlock, context wiring)
 *   Phase 13 — Quality Scoring (scoreOutcome)
 *   Phase 14 — Self-Improving Loop (refreshStrategies, preReason strategy injection)
 */

import { describe, it, expect, vi } from "vitest";
import { renderEquipmentBlock } from "../src/definition/schema.js";
import type { AgentEquipment } from "../src/definition/schema.js";
import { scoreOutcome, FLAG_STRATEGIES } from "../src/core/quality.js";
import type { QualityScore } from "../src/core/quality.js";
import type { LoopOutcome } from "../src/core/types.js";
import type { MemoryAdapter, MemoryEntry } from "../src/adapters/memory.js";
import {
  NoneEvolvingAdapter,
  MemoryEvolvingAdapter,
} from "../src/adapters/evolving.js";
import { InMemoryAdapter } from "../src/adapters-dummy/memory.js";

// ─── Mock memory adapter factory ────────────────────────────

function makeMockMemory(overrides: Partial<MemoryAdapter> = {}): MemoryAdapter {
  return {
    getConversation: vi.fn().mockResolvedValue([]),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ─── Phase 12 — Equipment Prompt Injection ─────────────────────

describe("renderEquipmentBlock", () => {
  it("returns null when equipment is undefined", () => {
    expect(renderEquipmentBlock(undefined)).toBeNull();
  });

  it("returns null when connectors and dedicatedTools are empty", () => {
    const empty: AgentEquipment = {
      connectors: [],
      channels: [],
      dedicatedTools: [],
    };
    expect(renderEquipmentBlock(empty)).toBeNull();
  });

  it("renders connectors with operations and access level", () => {
    const equipment: AgentEquipment = {
      connectors: [
        {
          type: "shopify",
          operations: ["orders.list", "orders.get"],
          access: "read",
        },
        {
          type: "fresha",
          operations: ["bookings.create", "bookings.list"],
          access: "readwrite",
        },
      ],
      channels: [],
      dedicatedTools: [],
    };
    const block = renderEquipmentBlock(equipment);
    expect(block).not.toBeNull();
    expect(block).toContain("EQUIPMENT (connected systems):");
    expect(block).toContain("- shopify: orders.list, orders.get [read]");
    expect(block).toContain(
      "- fresha: bookings.create, bookings.list [readwrite]",
    );
  });

  it("renders dedicated tools on their own line", () => {
    const equipment: AgentEquipment = {
      connectors: [],
      channels: [],
      dedicatedTools: ["generate_quote", "send_sms"],
    };
    const block = renderEquipmentBlock(equipment);
    expect(block).toContain("DEDICATED TOOLS: generate_quote, send_sms");
  });

  it("renders both connectors and dedicated tools together", () => {
    const equipment: AgentEquipment = {
      connectors: [
        { type: "shopify", operations: ["orders.list"], access: "read" },
      ],
      channels: [],
      dedicatedTools: ["book_appointment"],
    };
    const block = renderEquipmentBlock(equipment);
    expect(block).toContain("EQUIPMENT");
    expect(block).toContain("shopify");
    expect(block).toContain("DEDICATED TOOLS: book_appointment");
  });

  it("uses 'all operations' when connector has no operations listed", () => {
    const equipment: AgentEquipment = {
      connectors: [{ type: "hubspot", operations: [], access: "readwrite" }],
      channels: [],
      dedicatedTools: [],
    };
    const block = renderEquipmentBlock(equipment);
    expect(block).toContain("all operations");
  });
});

// ─── Phase 13 — Quality Scoring ───────────────────────────────

function makeResponseOutcome(toolCount = 0, failedCount = 0): LoopOutcome {
  const receipts = Array.from({ length: toolCount - failedCount }, (_, i) => ({
    action: `tool${i}`,
    reference: `ref${i}`,
    summary: `Executed tool${i}`,
    timestamp: new Date().toISOString(),
  }));
  const evidence = Array.from({ length: toolCount }, (_, i) => ({
    toolName: `tool${i}`,
    toolParams: {},
    toolResult: {},
    costUsd: 0,
    latencyMs: 10,
    timestamp: new Date().toISOString(),
  }));
  return {
    type: "response",
    text: "Here is your answer.",
    language: "en",
    payload: {},
    evidence: evidence.length > 0 ? evidence : undefined,
    receipts: receipts.length > 0 ? receipts : undefined,
  } as unknown as LoopOutcome;
}

describe("scoreOutcome", () => {
  it("gives resolution=1 for a response outcome", () => {
    const score = scoreOutcome(makeResponseOutcome());
    expect(score.resolution).toBe(1.0);
  });

  it("gives resolution=0 for an error outcome", () => {
    const score = scoreOutcome({ type: "error", error: "boom" } as LoopOutcome);
    expect(score.resolution).toBe(0.0);
  });

  it("gives resolution=0.5 for escalated", () => {
    const score = scoreOutcome({
      type: "escalated",
      reason: "agent limit",
      payload: {},
    } as unknown as LoopOutcome);
    expect(score.resolution).toBe(0.5);
  });

  it("gives resolution=0.7 for clarification", () => {
    const score = scoreOutcome({
      type: "clarification",
      question: "What date?",
      payload: {},
    } as unknown as LoopOutcome);
    expect(score.resolution).toBe(0.7);
  });

  it("gives efficiency=1 when no tools used", () => {
    const score = scoreOutcome(makeResponseOutcome(0));
    expect(score.efficiency).toBe(1.0);
  });

  it("gives efficiency=0.9 for a single tool call", () => {
    const score = scoreOutcome(makeResponseOutcome(1));
    expect(score.efficiency).toBe(0.9);
  });

  it("gives efficiency=0.7 for 2 tool calls", () => {
    const score = scoreOutcome(makeResponseOutcome(2));
    expect(score.efficiency).toBe(0.7);
  });

  it("gives efficiency=0.1 for >5 tool calls", () => {
    const score = scoreOutcome(makeResponseOutcome(6));
    expect(score.efficiency).toBe(0.1);
  });

  it("gives errorRate=1 when no tools failed", () => {
    const score = scoreOutcome(makeResponseOutcome(2, 0));
    expect(score.errorRate).toBe(1.0);
  });

  it("gives errorRate=0.5 when half of tools failed", () => {
    const score = scoreOutcome(makeResponseOutcome(4, 2)); // 2 failed, 2 ok
    expect(score.errorRate).toBe(0.5);
  });

  it("flags failed_resolution when resolution < 0.5", () => {
    const score = scoreOutcome({ type: "error", error: "boom" } as LoopOutcome);
    expect(score.flags).toContain("failed_resolution");
  });

  it("flags slow_response when efficiency < 0.5 (>5 tools)", () => {
    const score = scoreOutcome(makeResponseOutcome(6));
    expect(score.flags).toContain("slow_response");
  });

  it("flags high_error_rate when >30% tools failed", () => {
    const score = scoreOutcome(makeResponseOutcome(4, 2)); // 50% failed
    expect(score.flags).toContain("high_error_rate");
  });

  it("returns no flags for a clean single-tool response", () => {
    const score = scoreOutcome(makeResponseOutcome(1, 0));
    expect(score.flags).toHaveLength(0);
  });

  it("returns a complete QualityScore shape", () => {
    const score: QualityScore = scoreOutcome(makeResponseOutcome(2, 1));
    expect(score).toHaveProperty("resolution");
    expect(score).toHaveProperty("efficiency");
    expect(score).toHaveProperty("errorRate");
    expect(score).toHaveProperty("flags");
    expect(Array.isArray(score.flags)).toBe(true);
  });
});

describe("FLAG_STRATEGIES", () => {
  it("has a strategy note for every QualityFlag", () => {
    expect(FLAG_STRATEGIES.failed_resolution).toBeTruthy();
    expect(FLAG_STRATEGIES.slow_response).toBeTruthy();
    expect(FLAG_STRATEGIES.high_error_rate).toBeTruthy();
  });

  it("strategy notes are non-empty strings", () => {
    for (const note of Object.values(FLAG_STRATEGIES)) {
      expect(typeof note).toBe("string");
      expect(note.length).toBeGreaterThan(10);
    }
  });
});

// ─── Phase 14 — Self-Improving Loop ───────────────────────────

describe("MemoryEvolvingAdapter — refreshStrategies", () => {
  it("is defined on MemoryEvolvingAdapter", () => {
    const memory = new InMemoryAdapter();
    const adapter = new MemoryEvolvingAdapter(memory, "assist");
    expect(typeof adapter.refreshStrategies).toBe("function");
  });

  it("NoneEvolvingAdapter does not have refreshStrategies", () => {
    const adapter = new NoneEvolvingAdapter();
    expect(adapter.refreshStrategies).toBeUndefined();
  });

  it("does not throw when memory has fewer than 3 evolution events", async () => {
    const memory = new InMemoryAdapter();
    const adapter = new MemoryEvolvingAdapter(memory, "assist");
    // No data in memory — refreshStrategies should silently bail
    await expect(adapter.refreshStrategies(memory)).resolves.not.toThrow();
  });

  it("writes strategy notes to memory when enough flagged events exist", async () => {
    // Build 5 evolution entries with failed_resolution flags
    const evEntries: MemoryEntry[] = Array.from({ length: 5 }, (_, i) => ({
      id: `evo-test-${i}`,
      content: JSON.stringify({
        sessionId: "s1",
        taskId: `t${i}`,
        situation: "user asks about order status",
        outcomeType: "error",
        qualityFlags: ["failed_resolution"],
        recordedAt: new Date().toISOString(),
      }),
      source: "system" as const,
      confidence: 0.8,
      createdAt: new Date().toISOString(),
    }));

    const mockStore = vi.fn().mockResolvedValue(undefined);
    const memory = makeMockMemory({
      search: vi.fn().mockResolvedValue(evEntries),
      store: mockStore,
    });
    const adapter = new MemoryEvolvingAdapter(memory, "assist");

    await adapter.refreshStrategies(memory);

    expect(mockStore).toHaveBeenCalled();
    const stored: MemoryEntry = mockStore.mock.calls[0][0];
    expect(stored.source).toBe("evolution.strategy");
    expect(stored.content).toContain("clarif");
  });

  it("preReason (assist) includes strategy notes at the top of hints", async () => {
    const strategyEntry: MemoryEntry = {
      id: "strategy-failed_resolution-123",
      content: FLAG_STRATEGIES.failed_resolution,
      source: "evolution.strategy",
      confidence: 0.9,
      createdAt: new Date().toISOString(),
    };
    const memory = makeMockMemory({
      search: vi.fn().mockResolvedValue([strategyEntry]),
    });
    const adapter = new MemoryEvolvingAdapter(memory, "assist");

    const hints = await adapter.preReason({
      sessionId: "s1",
      taskId: "t1",
      situation: "user asks for a refund",
    });

    const strategyHint = hints.find((h) => h.startsWith("[strategy]"));
    expect(strategyHint).toBeDefined();
    expect(strategyHint).toContain(FLAG_STRATEGIES.failed_resolution);
  });

  it("preReason (shadow) returns empty even with strategy notes in memory", async () => {
    const memory = new InMemoryAdapter();
    const adapter = new MemoryEvolvingAdapter(memory, "shadow");

    await memory.store({
      id: "strategy-1",
      content: "Some strategy",
      source: "evolution.strategy",
      confidence: 0.9,
      createdAt: new Date().toISOString(),
    });

    const hints = await adapter.preReason({
      sessionId: "s1",
      taskId: "t1",
      situation: "anything",
    });
    expect(hints).toHaveLength(0);
  });
});
