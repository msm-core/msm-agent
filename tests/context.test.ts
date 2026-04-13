import { describe, it, expect } from "vitest";
import { buildContext } from "../src/core/context.js";
import { InMemoryAdapter } from "../src/adapters-dummy/memory.js";
import { MockToolAdapter } from "../src/adapters-dummy/tools.js";
import type { RunState } from "../src/core/types.js";

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

describe("context builder", () => {
  it("builds basic brain input from conversation", async () => {
    const memory = new InMemoryAdapter();
    await memory.addMessage("s1", {
      role: "user",
      content: "Hello",
      timestamp: new Date().toISOString(),
    });

    const input = await buildContext({
      sessionId: "s1",
      text: "What time is it?",
      modality: "text",
      memory,
      tools: new MockToolAdapter(),
      state: makeState(),
      task: null,
    });

    expect(input.raw).toBe("What time is it?");
    expect(input.modality).toBe("text");
    expect(input.history).toHaveLength(1);
    expect(input.history[0]).toEqual({ role: "user", content: "Hello" });
  });

  it("compresses history when > 10 messages", async () => {
    const memory = new InMemoryAdapter();
    for (let i = 0; i < 12; i++) {
      await memory.addMessage("s1", {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    const input = await buildContext({
      sessionId: "s1",
      text: "Next question",
      modality: "text",
      memory,
      tools: new MockToolAdapter(),
      state: makeState(),
      task: null,
    });

    // Should be: 1 summary prefix + 6 tail = 7 entries
    expect(input.history).toHaveLength(7);
    // First entry is the summary of dropped messages
    expect(input.history[0].role).toBe("assistant");
    expect(input.history[0].content).toContain("Earlier conversation summary");
    // Tail is the last 6
    expect(input.history[1].content).toBe("Message 6");
    expect(input.history[6].content).toBe("Message 11");
  });

  it("includes tool result when provided as lastToolResult", async () => {
    const memory = new InMemoryAdapter();
    const toolResult = {
      tool: "search",
      status: "ok" as const,
      result: { data: "found" },
    };

    const input = await buildContext({
      sessionId: "s1",
      text: "Search done",
      modality: "text",
      memory,
      tools: new MockToolAdapter(),
      state: makeState(),
      task: null,
      lastToolResult: toolResult,
    });

    expect(input.tool_results).toHaveLength(1);
    expect(input.tool_results![0].tool).toBe("search");
  });

  it("includes tool results from recent steps when no lastToolResult", async () => {
    const memory = new InMemoryAdapter();
    const state = makeState({
      recentSteps: [
        {
          iteration: 0,
          action: "use_tool",
          toolName: "api_call",
          toolParams: {},
          toolResult: {
            tool: "api_call",
            status: "ok",
            result: { data: "result" },
          },
          confidence: 0.9,
          reasoning: "",
          costUsd: 0,
          latencyMs: 100,
          timestamp: new Date().toISOString(),
        },
      ],
    });

    const input = await buildContext({
      sessionId: "s1",
      text: "Check result",
      modality: "text",
      memory,
      tools: new MockToolAdapter(),
      state,
      task: null,
    });

    expect(input.tool_results).toHaveLength(1);
    expect(input.tool_results![0].tool).toBe("api_call");
  });

  it("excludes system messages from history", async () => {
    const memory = new InMemoryAdapter();
    await memory.addMessage("s1", {
      role: "system",
      content: "You are helpful",
      timestamp: new Date().toISOString(),
    });
    await memory.addMessage("s1", {
      role: "user",
      content: "Hi",
      timestamp: new Date().toISOString(),
    });
    await memory.addMessage("s1", {
      role: "assistant",
      content: "Hello!",
      timestamp: new Date().toISOString(),
    });

    const input = await buildContext({
      sessionId: "s1",
      text: "Next",
      modality: "text",
      memory,
      tools: new MockToolAdapter(),
      state: makeState(),
      task: null,
    });

    // System messages should be filtered out
    expect(input.history).toHaveLength(2);
    expect(input.history[0].role).toBe("user");
    expect(input.history[1].role).toBe("assistant");
  });
});
