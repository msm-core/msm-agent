/**
 * Unit tests for MemoryAdapter implementations.
 *
 * Covers:
 *  - getConversation() limit parameter (2.12)
 *  - saveTask() / getTask() round-trip (used by loop 2.7)
 */

import { describe, it, expect } from "vitest";
import { InMemoryAdapter } from "../src/adapters-dummy/memory.js";
import { SQLiteMemoryAdapter } from "../src/adapters/sqlite-memory.js";
import type { Message } from "../src/core/types.js";

function msg(role: "user" | "assistant", content: string): Message {
  return { role, content, timestamp: new Date().toISOString() };
}

// ─── InMemoryAdapter ──────────────────────────────────────────────────────────

describe("InMemoryAdapter.getConversation", () => {
  it("returns all messages when no limit given", async () => {
    const mem = new InMemoryAdapter();
    for (let i = 0; i < 8; i++) {
      await mem.addMessage(
        "s1",
        msg(i % 2 === 0 ? "user" : "assistant", `m${i}`),
      );
    }
    const all = await mem.getConversation("s1");
    expect(all).toHaveLength(8);
  });

  it("returns last N messages when limit is set", async () => {
    const mem = new InMemoryAdapter();
    for (let i = 0; i < 10; i++) {
      await mem.addMessage(
        "s1",
        msg(i % 2 === 0 ? "user" : "assistant", `m${i}`),
      );
    }
    const limited = await mem.getConversation("s1", 3);
    expect(limited).toHaveLength(3);
    expect(limited[0].content).toBe("m7");
    expect(limited[1].content).toBe("m8");
    expect(limited[2].content).toBe("m9");
  });

  it("returns all messages when limit exceeds count", async () => {
    const mem = new InMemoryAdapter();
    await mem.addMessage("s1", msg("user", "hello"));
    const limited = await mem.getConversation("s1", 100);
    expect(limited).toHaveLength(1);
  });

  it("returns empty array for unknown session", async () => {
    const mem = new InMemoryAdapter();
    expect(await mem.getConversation("no-such-session", 10)).toEqual([]);
  });

  it("does not cross sessions", async () => {
    const mem = new InMemoryAdapter();
    await mem.addMessage("s1", msg("user", "from s1"));
    await mem.addMessage("s2", msg("user", "from s2"));
    const s1 = await mem.getConversation("s1");
    const s2 = await mem.getConversation("s2");
    expect(s1).toHaveLength(1);
    expect(s2).toHaveLength(1);
    expect(s1[0].content).toBe("from s1");
  });
});

// ─── SQLiteMemoryAdapter ──────────────────────────────────────────────────────

describe("SQLiteMemoryAdapter.getConversation", () => {
  it("returns last N messages in ascending order when limit is set", async () => {
    const adapter = new SQLiteMemoryAdapter(":memory:");
    for (let i = 0; i < 10; i++) {
      await adapter.addMessage(
        "s1",
        msg(i % 2 === 0 ? "user" : "assistant", `m${i}`),
      );
    }

    const limited = await adapter.getConversation("s1", 4);
    expect(limited).toHaveLength(4);
    // Should be last 4 in chronological order: m6, m7, m8, m9
    expect(limited[0].content).toBe("m6");
    expect(limited[3].content).toBe("m9");
  });

  it("returns all messages when no limit", async () => {
    const adapter = new SQLiteMemoryAdapter(":memory:");
    for (let i = 0; i < 6; i++) {
      await adapter.addMessage(
        "s1",
        msg(i % 2 === 0 ? "user" : "assistant", `m${i}`),
      );
    }
    const all = await adapter.getConversation("s1");
    expect(all).toHaveLength(6);
  });
});

// ─── saveTask / getTask round-trip (used by loop 2.7) ─────────────────────────

describe("InMemoryAdapter saveTask/getTask", () => {
  it("persists and retrieves task state", async () => {
    const mem = new InMemoryAdapter();
    const task = {
      taskId: "t1",
      sessionId: "s1",
      status: "running" as const,
      plan: null,
      steps: [],
      totalCostUsd: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    await mem.saveTask(task);
    const retrieved = await mem.getTask("t1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.taskId).toBe("t1");
    expect(retrieved!.status).toBe("running");
  });

  it("overwrites task on second saveTask call", async () => {
    const mem = new InMemoryAdapter();
    const task = {
      taskId: "t2",
      sessionId: "s1",
      status: "running" as const,
      plan: null,
      steps: [],
      totalCostUsd: 0,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    };
    await mem.saveTask(task);
    await mem.saveTask({ ...task, status: "completed" });
    const retrieved = await mem.getTask("t2");
    expect(retrieved!.status).toBe("completed");
  });
});
