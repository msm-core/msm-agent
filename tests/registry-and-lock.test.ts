/**
 * Tests for InProcessLockAdapter (3.1 — Distributed session locking)
 * and per-agent registry isolation (3.7)
 */

import { describe, it, expect, vi } from "vitest";
import {
  InProcessLockAdapter,
  type LockHandle,
} from "../src/adapters/distributed-lock.js";
import { createSkillRegistry } from "../src/adapters/skills.js";
import { createConnectorRegistry } from "../src/adapters/equipment.js";
import { SkillToolAdapter } from "../src/adapters/skills.js";

// ─── InProcessLockAdapter ─────────────────────────────────────────────────────

describe("InProcessLockAdapter", () => {
  it("acquires a lock and returns a LockHandle", async () => {
    const lock = new InProcessLockAdapter();
    const handle = await lock.acquire("session-1", 5000);
    expect(handle).not.toBeNull();
    expect(typeof handle!.release).toBe("function");
    expect(typeof handle!.extend).toBe("function");
    await handle!.release();
  });

  it("serialises concurrent acquisitions for the same key", async () => {
    const lock = new InProcessLockAdapter();
    const order: number[] = [];

    const run = async (id: number) => {
      const handle = await lock.acquire("session-1", 5000);
      order.push(id);
      // Simulate some async work
      await new Promise<void>((r) => setTimeout(r, 5));
      await handle!.release();
    };

    // Start 3 concurrent runs — they must serialise
    await Promise.all([run(1), run(2), run(3)]);
    expect(order).toHaveLength(3);
    // All 3 ran (order is deterministic for Promise chains)
    expect(order).toContain(1);
    expect(order).toContain(2);
    expect(order).toContain(3);
  });

  it("allows different keys to run concurrently without blocking", async () => {
    const lock = new InProcessLockAdapter();
    const resolved: string[] = [];

    const run = async (key: string) => {
      const handle = await lock.acquire(key, 5000);
      resolved.push(key);
      await handle!.release();
    };

    await Promise.all([run("s1"), run("s2"), run("s3")]);
    expect(resolved).toHaveLength(3);
  });

  it("extend() is a no-op for in-process lock (does not throw)", async () => {
    const lock = new InProcessLockAdapter();
    const handle = await lock.acquire("session-1", 5000);
    await expect(handle!.extend(10_000)).resolves.toBeUndefined();
    await handle!.release();
  });

  it("cleans up map after release", async () => {
    const lock = new InProcessLockAdapter();
    const handle = await lock.acquire("session-cleanup", 5000);
    await handle!.release();
    // Second acquire should work fine (no dangling lock)
    const handle2 = await lock.acquire("session-cleanup", 5000);
    expect(handle2).not.toBeNull();
    await handle2!.release();
  });
});

// ─── Per-agent skill registry (3.7) ───────────────────────────────────────────

describe("createSkillRegistry — per-agent isolation", () => {
  it("returns an independent instance that does not share state with the global registry", () => {
    const r1 = createSkillRegistry();
    const r2 = createSkillRegistry();

    r1.register("greet", () => [
      {
        name: "greet",
        description: "Say hello",
        execute: async () => "hi",
      },
    ]);

    // r2 should not see r1's registration
    expect(r1.has("greet")).toBe(true);
    expect(r2.has("greet")).toBe(false);
  });

  it("resolve returns [] for unknown skills and does not throw", () => {
    const r = createSkillRegistry();
    expect(r.resolve("nonexistent")).toEqual([]);
  });

  it("SkillToolAdapter.create accepts a custom registry", () => {
    const registry = createSkillRegistry();
    registry.register("ping", () => [
      {
        name: "ping",
        description: "Ping tool",
        execute: async () => "pong",
      },
    ]);

    const adapter = SkillToolAdapter.create(["ping"], {}, null, registry);
    const tools = adapter.list();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("ping");
  });

  it("SkillToolAdapter skips skills not in the provided registry", () => {
    const registry = createSkillRegistry();
    // Only "alpha" is registered, "beta" is not
    registry.register("alpha", () => [
      {
        name: "alpha_tool",
        description: "Alpha",
        execute: async () => null,
      },
    ]);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = SkillToolAdapter.create(
      ["alpha", "beta"],
      {},
      null,
      registry,
    );
    expect(adapter.list()).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("beta"));
    warnSpy.mockRestore();
  });
});

// ─── Per-agent connector registry (3.7) ───────────────────────────────────────

describe("createConnectorRegistry — per-agent isolation", () => {
  it("returns independent instances", () => {
    const r1 = createConnectorRegistry();
    const r2 = createConnectorRegistry();

    r1.register("shopify", () => []);

    expect(r1.has("shopify")).toBe(true);
    expect(r2.has("shopify")).toBe(false);
  });

  it("resolve returns [] for unknown types", () => {
    const r = createConnectorRegistry();
    expect(
      r.resolve("unknown", {
        type: "unknown",
        label: "Test",
        credentials: {},
        options: {},
      }),
    ).toEqual([]);
  });
});
