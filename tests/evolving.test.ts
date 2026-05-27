import { describe, it, expect, vi } from "vitest";
import {
  NoneEvolvingAdapter,
  MemoryEvolvingAdapter,
} from "../src/adapters/evolving.js";
import type { EvolvingContext } from "../src/adapters/evolving.js";
import type { LoopOutcome } from "../src/core/types.js";
import type { MemoryAdapter } from "../src/adapters/memory.js";

// ─── Helpers ──────────────────────────────────────────────────

const ctx: EvolvingContext = {
  sessionId: "sess-1",
  taskId: "task-1",
  situation: "User wants to book a haircut",
};

const responseOutcome: LoopOutcome = {
  type: "response",
  text: "I found 3 available slots for you.",
  sessionId: "sess-1",
  usage: { input: 10, output: 20, total: 30 },
  cost: 0,
};

const errorOutcome: LoopOutcome = {
  type: "fatal_error",
  error: "Brain refused",
  sessionId: "sess-1",
};

function makeMemoryAdapter(
  overrides: Partial<MemoryAdapter> = {},
): MemoryAdapter {
  return {
    getConversation: vi.fn().mockResolvedValue([]),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    store: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

// ─── NoneEvolvingAdapter ──────────────────────────────────────

describe("NoneEvolvingAdapter", () => {
  it("mode is 'off'", () => {
    const adapter = new NoneEvolvingAdapter();
    expect(adapter.mode).toBe("off");
  });

  it("preReason() returns empty array", async () => {
    const adapter = new NoneEvolvingAdapter();
    const hints = await adapter.preReason(ctx);
    expect(hints).toEqual([]);
  });

  it("postOutcome() is a no-op (does not throw)", async () => {
    const adapter = new NoneEvolvingAdapter();
    await expect(
      adapter.postOutcome(ctx, responseOutcome),
    ).resolves.toBeUndefined();
  });

  it("close() resolves cleanly", async () => {
    const adapter = new NoneEvolvingAdapter();
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});

// ─── MemoryEvolvingAdapter — shadow mode ──────────────────────

describe("MemoryEvolvingAdapter (shadow)", () => {
  it("mode is 'shadow'", () => {
    const memory = makeMemoryAdapter();
    const adapter = new MemoryEvolvingAdapter(memory, "shadow");
    expect(adapter.mode).toBe("shadow");
  });

  it("preReason() returns [] in shadow mode (never injects)", async () => {
    const memory = makeMemoryAdapter();
    const adapter = new MemoryEvolvingAdapter(memory, "shadow");
    const hints = await adapter.preReason(ctx);
    expect(hints).toEqual([]);
    expect(memory.search).not.toHaveBeenCalled();
  });

  it("postOutcome() calls memory.store() with evolution event", async () => {
    const memory = makeMemoryAdapter();
    const adapter = new MemoryEvolvingAdapter(memory, "shadow");
    await adapter.postOutcome(ctx, responseOutcome);

    expect(memory.store).toHaveBeenCalledOnce();
    const stored = (memory.store as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(stored.id).toMatch(/^evo-/);
    expect(stored.source).toBe("system");
    const payload = JSON.parse(stored.content as string);
    expect(payload.situation).toBe(ctx.situation);
    expect(payload.sessionId).toBe(ctx.sessionId);
    expect(payload.outcomeType).toBe("response");
  });

  it("postOutcome() stores truncated outcomeText for response outcomes", async () => {
    const memory = makeMemoryAdapter();
    const adapter = new MemoryEvolvingAdapter(memory, "shadow");
    await adapter.postOutcome(ctx, responseOutcome);

    const stored = (memory.store as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const payload = JSON.parse(stored.content as string);
    expect(payload.outcomeText).toContain("found 3 available");
  });

  it("postOutcome() works for non-response outcomes (no outcomeText)", async () => {
    const memory = makeMemoryAdapter();
    const adapter = new MemoryEvolvingAdapter(memory, "shadow");
    await adapter.postOutcome(ctx, errorOutcome);

    const stored = (memory.store as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const payload = JSON.parse(stored.content as string);
    expect(payload.outcomeType).toBe("fatal_error");
    expect(payload.outcomeText).toBeUndefined();
  });

  it("postOutcome() does not throw if memory.store() rejects", async () => {
    const memory = makeMemoryAdapter({
      store: vi.fn().mockRejectedValue(new Error("DB down")),
    });
    const adapter = new MemoryEvolvingAdapter(memory, "shadow");
    // Should resolve, not reject
    await expect(
      adapter.postOutcome(ctx, responseOutcome),
    ).resolves.toBeUndefined();
  });

  it("throws if constructed with 'off' mode", () => {
    const memory = makeMemoryAdapter();
    expect(() => new MemoryEvolvingAdapter(memory, "off")).toThrow();
  });
});

// ─── MemoryEvolvingAdapter — assist mode ─────────────────────

describe("MemoryEvolvingAdapter (assist)", () => {
  it("mode is 'assist'", () => {
    const memory = makeMemoryAdapter();
    const adapter = new MemoryEvolvingAdapter(memory, "assist");
    expect(adapter.mode).toBe("assist");
  });

  it("preReason() calls memory.search() with situation", async () => {
    const memory = makeMemoryAdapter({
      search: vi.fn().mockResolvedValue([]),
    });
    const adapter = new MemoryEvolvingAdapter(memory, "assist");
    await adapter.preReason(ctx);
    expect(memory.search).toHaveBeenCalledWith(ctx.situation, 5);
  });

  it("preReason() returns [] when no evolution entries found", async () => {
    const memory = makeMemoryAdapter({
      search: vi.fn().mockResolvedValue([]),
    });
    const adapter = new MemoryEvolvingAdapter(memory, "assist");
    const hints = await adapter.preReason(ctx);
    expect(hints).toEqual([]);
  });

  it("preReason() returns formatted hints from past evolution entries", async () => {
    const evolutionEntry = {
      id: "evo-123",
      content: JSON.stringify({
        sessionId: "sess-old",
        taskId: "task-old",
        situation: "User wants to book a haircut",
        outcomeType: "response",
        outcomeText: "Booked at 3pm on Tuesday",
        recordedAt: new Date().toISOString(),
      }),
      source: "system",
      confidence: 0.8,
      createdAt: new Date().toISOString(),
    };

    const memory = makeMemoryAdapter({
      search: vi.fn().mockResolvedValue([evolutionEntry]),
    });
    const adapter = new MemoryEvolvingAdapter(memory, "assist", {
      minSampleSize: 1,
    });
    const hints = await adapter.preReason(ctx);

    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("[past approach]");
    expect(hints[0]).toContain("haircut");
  });

  it("preReason() skips non-evolution memory entries (no situation key)", async () => {
    const normalEntry = {
      id: "mem-1",
      content: "The user prefers morning appointments",
      source: "system",
      confidence: 0.9,
      createdAt: new Date().toISOString(),
    };

    const memory = makeMemoryAdapter({
      search: vi.fn().mockResolvedValue([normalEntry]),
    });
    const adapter = new MemoryEvolvingAdapter(memory, "assist");
    const hints = await adapter.preReason(ctx);
    expect(hints).toEqual([]);
  });

  it("preReason() returns [] if memory.search() rejects", async () => {
    const memory = makeMemoryAdapter({
      search: vi.fn().mockRejectedValue(new Error("Search failed")),
    });
    const adapter = new MemoryEvolvingAdapter(memory, "assist");
    const hints = await adapter.preReason(ctx);
    expect(hints).toEqual([]);
  });

  it("postOutcome() writes in assist mode too", async () => {
    const memory = makeMemoryAdapter();
    const adapter = new MemoryEvolvingAdapter(memory, "assist");
    await adapter.postOutcome(ctx, responseOutcome);
    expect(memory.store).toHaveBeenCalledOnce();
  });
});
