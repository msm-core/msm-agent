/**
 * Tests for production-gap fixes (Gemini review feedback):
 *
 * 1. Context builder: task state + semantic memory injection
 * 2. Session mutex: concurrent event safety
 * 3. History compaction hook
 * 4. Fast-intent pre-hook
 * 5. Abort on missing toolName
 */

import { describe, it, expect, vi } from "vitest";
import { buildContext } from "../src/core/context.js";
import { createAgent } from "../src/core/agent.js";
import { executeEvent, type LoopDeps } from "../src/core/loop.js";
import { DEFAULT_CONFIG } from "../src/core/types.js";
import type {
  AgentEvent,
  Brain,
  LoopOutcome,
  Message,
  RunState,
  TaskState,
  TaskPlan,
} from "../src/core/types.js";
import type {
  MSMPayload,
  OrchestrationOutput,
  GenerationOutput,
  FinalOutput,
} from "msm-ai";
import { InMemoryAdapter } from "../src/adapters-dummy/memory.js";
import { MockToolAdapter } from "../src/adapters-dummy/tools.js";
import { ManualEventAdapter } from "../src/adapters-dummy/events.js";
import { ConsoleDeliveryAdapter } from "../src/adapters-dummy/delivery.js";
import type { MemoryEntry } from "../src/adapters/memory.js";

// ─── Helpers ─────────────────────────────────────────────────

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

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    taskId: "task-1",
    sessionId: "s1",
    status: "running",
    plan: null,
    steps: [],
    totalCostUsd: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
    ...overrides,
  };
}

function makeOrch(
  overrides: Partial<OrchestrationOutput> = {},
): OrchestrationOutput {
  return {
    model_id: "test",
    model_ver: "1.0",
    latency_ms: 10,
    confidence: 0.9,
    status: "ok",
    action: "respond",
    workflow_steps: [],
    tool_selections: [],
    estimated_steps: 1,
    mode: "rules",
    reasoning: "test",
    ...overrides,
  };
}

function makePayload(overrides: Partial<MSMPayload> = {}): MSMPayload {
  return {
    msm_version: "3.0.0",
    session_id: "test",
    trace_id: "t1",
    timestamp: new Date().toISOString(),
    input: { raw: "test", modality: "text" },
    orchestration: makeOrch(),
    generation: {
      model_id: "test",
      model_ver: "1.0",
      latency_ms: 10,
      confidence: 0.9,
      status: "ok",
      response_text: "Hello!",
      tone: "neutral",
      word_count: 1,
    },
    final_output: {
      text: "Hello!",
      language: "en",
      total_latency_ms: 20,
      pipeline_status: "ok",
    },
    ...overrides,
  };
}

function staticBrain(text: string): Brain {
  return {
    async run() {
      return makePayload({
        generation: {
          model_id: "test",
          model_ver: "1.0",
          latency_ms: 10,
          confidence: 0.9,
          status: "ok",
          response_text: text,
          tone: "neutral",
          word_count: text.split(" ").length,
        },
        final_output: {
          text,
          language: "en",
          total_latency_ms: 20,
          pipeline_status: "ok",
        },
      });
    },
  };
}

function userEvent(text: string, sessionId = "s1"): AgentEvent {
  return { type: "user_message", sessionId, text, modality: "text" };
}

// ─── 1. Context Builder: Task State & Semantic Memory ────────

describe("context builder — enriched", () => {
  it("injects task state into system_context", async () => {
    const memory = new InMemoryAdapter();
    const task = makeTask({ status: "running" });

    const input = await buildContext({
      sessionId: "s1",
      text: "Next step please",
      modality: "text",
      memory,
      tools: new MockToolAdapter(),
      state: makeState(),
      task,
    });

    expect(input.system_context).toBeDefined();
    expect(input.system_context).toContain("task-1");
    expect(input.system_context).toContain("status=running");
  });

  it("injects task plan info into system_context", async () => {
    const memory = new InMemoryAdapter();
    const plan: TaskPlan = {
      steps: [
        { description: "Search", status: "completed" },
        { description: "Analyze", status: "pending" },
        { description: "Report", status: "pending" },
      ],
      reasoning: "three-step plan",
      replanCount: 1,
      createdAt: new Date().toISOString(),
    };
    const task = makeTask({ plan });

    const input = await buildContext({
      sessionId: "s1",
      text: "Continue",
      modality: "text",
      memory,
      tools: new MockToolAdapter(),
      state: makeState(),
      task,
    });

    expect(input.system_context).toContain("3 steps");
    expect(input.system_context).toContain("current=2");
    expect(input.system_context).toContain("replans=1");
  });

  it("injects recent failures into system_context", async () => {
    const memory = new InMemoryAdapter();
    const task = makeTask();
    const state = makeState({
      recentSteps: [
        {
          iteration: 0,
          action: "use_tool",
          toolName: "api_call",
          toolParams: {},
          toolResult: {
            tool: "api_call",
            status: "failed",
            result: { error: "timeout" },
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
      text: "Try again",
      modality: "text",
      memory,
      tools: new MockToolAdapter(),
      state,
      task,
    });

    expect(input.system_context).toContain("Recent failures");
    expect(input.system_context).toContain("api_call");
  });

  it("queries semantic memory when search() is available", async () => {
    const memory = new InMemoryAdapter();
    // Add search capability
    memory.search = async (
      query: string,
      limit: number,
    ): Promise<MemoryEntry[]> => {
      return [
        {
          id: "m1",
          content: "User prefers Arabic responses",
          source: "conversation",
          confidence: 0.8,
          createdAt: new Date().toISOString(),
        },
      ];
    };

    const input = await buildContext({
      sessionId: "s1",
      text: "Hello",
      modality: "text",
      memory,
      tools: new MockToolAdapter(),
      state: makeState(),
      task: null,
    });

    expect(input.system_context).toContain("Relevant memories");
    expect(input.system_context).toContain("User prefers Arabic responses");
  });

  it("includes tool catalog in system_context", async () => {
    const tools = new MockToolAdapter([
      {
        name: "search_kb",
        description: "Search knowledge base",
        parameters: {},
      },
      {
        name: "delete_order",
        description: "Delete an order",
        parameters: {},
        destructive: true,
      },
    ]);

    const input = await buildContext({
      sessionId: "s1",
      text: "Help me",
      modality: "text",
      memory: new InMemoryAdapter(),
      tools,
      state: makeState(),
      task: null,
    });

    expect(input.system_context).toContain("Available tools");
    expect(input.system_context).toContain("search_kb");
    expect(input.system_context).toContain("delete_order");
    expect(input.system_context).toContain("[destructive]");
  });

  it("has no system_context when task is null and no tools/memories", async () => {
    const input = await buildContext({
      sessionId: "s1",
      text: "Simple question",
      modality: "text",
      memory: new InMemoryAdapter(),
      tools: new MockToolAdapter(), // no tools registered
      state: makeState(),
      task: null,
    });

    expect(input.system_context).toBeUndefined();
  });

  it("gracefully handles search() failure", async () => {
    const memory = new InMemoryAdapter();
    memory.search = async () => {
      throw new Error("Vector DB down");
    };

    // Should not throw
    const input = await buildContext({
      sessionId: "s1",
      text: "Hello",
      modality: "text",
      memory,
      tools: new MockToolAdapter(),
      state: makeState(),
      task: null,
    });

    // No crash, system_context may or may not exist depending on tools
    expect(input.raw).toBe("Hello");
  });
});

// ─── 2. Session Mutex ────────────────────────────────────────

describe("session mutex", () => {
  it("serializes concurrent events on the same session", async () => {
    const executionOrder: string[] = [];

    // Brain that takes a bit to process (enough to detect overlap)
    const brain: Brain = {
      async run() {
        executionOrder.push("brain-start");
        await new Promise((r) => setTimeout(r, 50));
        executionOrder.push("brain-end");
        return makePayload();
      },
    };

    const agent = createAgent({
      brain,
      memory: new InMemoryAdapter(),
      tools: new MockToolAdapter(),
      events: new ManualEventAdapter(),
      delivery: new ConsoleDeliveryAdapter(),
    });

    // Fire two events on the same session concurrently
    const p1 = agent.handleEvent(userEvent("First", "s1"));
    const p2 = agent.handleEvent(userEvent("Second", "s1"));

    await Promise.all([p1, p2]);

    // Should be serialized: start-end-start-end, not interleaved
    expect(executionOrder).toEqual([
      "brain-start",
      "brain-end",
      "brain-start",
      "brain-end",
    ]);
  });

  it("allows parallel events on different sessions", async () => {
    const activeSessions = new Set<string>();
    let maxConcurrent = 0;

    const brain: Brain = {
      async run(input) {
        const sid = input.raw;
        activeSessions.add(sid);
        maxConcurrent = Math.max(maxConcurrent, activeSessions.size);
        await new Promise((r) => setTimeout(r, 50));
        activeSessions.delete(sid);
        return makePayload();
      },
    };

    const agent = createAgent({
      brain,
      memory: new InMemoryAdapter(),
      tools: new MockToolAdapter(),
      events: new ManualEventAdapter(),
      delivery: new ConsoleDeliveryAdapter(),
    });

    // Fire events on different sessions concurrently
    const p1 = agent.handleEvent(userEvent("s1", "s1"));
    const p2 = agent.handleEvent(userEvent("s2", "s2"));

    await Promise.all([p1, p2]);

    // Both should have been in-flight at the same time
    expect(maxConcurrent).toBe(2);
  });
});

// ─── 3. History Compaction Hook ──────────────────────────────

describe("history compaction hook", () => {
  it("uses custom compactHistory when provided", async () => {
    const memory = new InMemoryAdapter();
    for (let i = 0; i < 20; i++) {
      await memory.addMessage("s1", {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    const customCompact = vi.fn(async (messages: Message[]) => {
      return [
        {
          role: "assistant" as const,
          content: `[Summary of ${messages.length} messages]`,
        },
        {
          role: "user" as const,
          content: messages[messages.length - 1].content,
        },
      ];
    });

    const input = await buildContext({
      sessionId: "s1",
      text: "Latest question",
      modality: "text",
      memory,
      tools: new MockToolAdapter(),
      state: makeState(),
      task: null,
      compactHistory: customCompact,
    });

    expect(customCompact).toHaveBeenCalledOnce();
    expect(input.history).toHaveLength(2);
    expect(input.history[0].content).toContain("Summary of 20 messages");
  });

  it("built-in compression preserves summary of dropped messages", async () => {
    const memory = new InMemoryAdapter();
    for (let i = 0; i < 14; i++) {
      await memory.addMessage("s1", {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}`,
        timestamp: new Date().toISOString(),
      });
    }

    const input = await buildContext({
      sessionId: "s1",
      text: "Continue",
      modality: "text",
      memory,
      tools: new MockToolAdapter(),
      state: makeState(),
      task: null,
    });

    // 1 summary + 6 tail = 7
    expect(input.history).toHaveLength(7);
    expect(input.history[0].content).toContain("Earlier conversation summary");
    // Summary should reference topics from dropped messages
    expect(input.history[0].content).toContain("Message 0");
  });
});

// ─── 4. Fast-Intent Pre-Hook ─────────────────────────────────

describe("fast-intent pre-hook", () => {
  it("short-circuits the loop when preHook returns an outcome", async () => {
    const brainCalled = vi.fn();

    const agent = createAgent({
      brain: {
        async run(input) {
          brainCalled();
          return makePayload();
        },
      },
      memory: new InMemoryAdapter(),
      tools: new MockToolAdapter(),
      events: new ManualEventAdapter(),
      delivery: new ConsoleDeliveryAdapter(),
      preHook: async (event) => {
        if (event.type === "user_message" && event.text === "Hi") {
          return {
            type: "response",
            text: "Hello! How can I help?",
            language: "en",
            payload: makePayload(),
          };
        }
        return null; // proceed normally
      },
    });

    const outcome = await agent.handleEvent(userEvent("Hi"));

    expect(outcome.type).toBe("response");
    if (outcome.type === "response") {
      expect(outcome.text).toBe("Hello! How can I help?");
    }
    // Brain should NOT have been called
    expect(brainCalled).not.toHaveBeenCalled();
  });

  it("proceeds to brain loop when preHook returns null", async () => {
    const brainCalled = vi.fn();

    const agent = createAgent({
      brain: {
        async run() {
          brainCalled();
          return makePayload({
            generation: {
              model_id: "test",
              model_ver: "1.0",
              latency_ms: 10,
              confidence: 0.9,
              status: "ok",
              response_text: "Brain response",
              tone: "neutral",
              word_count: 2,
            },
            final_output: {
              text: "Brain response",
              language: "en",
              total_latency_ms: 20,
              pipeline_status: "ok",
            },
          });
        },
      },
      memory: new InMemoryAdapter(),
      tools: new MockToolAdapter(),
      events: new ManualEventAdapter(),
      delivery: new ConsoleDeliveryAdapter(),
      preHook: async () => null,
    });

    const outcome = await agent.handleEvent(userEvent("Complex question"));

    expect(brainCalled).toHaveBeenCalled();
    expect(outcome.type).toBe("response");
    if (outcome.type === "response") {
      expect(outcome.text).toBe("Brain response");
    }
  });
});

// ─── 5. Abort on Missing toolName ────────────────────────────

describe("abort on missing toolName", () => {
  it("returns error immediately when use_tool has no tool_name", async () => {
    const brain: Brain = {
      async run() {
        return makePayload({
          orchestration: makeOrch({ action: "use_tool" }),
        });
      },
    };

    const deps: LoopDeps = {
      brain,
      memory: new InMemoryAdapter(),
      tools: new MockToolAdapter(),
      delivery: new ConsoleDeliveryAdapter(),
      config: { ...DEFAULT_CONFIG },
    };

    const outcome = await executeEvent(userEvent("Do something"), deps);

    expect(outcome.type).toBe("error");
    if (outcome.type === "error") {
      expect(outcome.error).toContain("tool_name");
    }
  });

  it("marks task as failed (not completed) on invalid reasoning", async () => {
    const memory = new InMemoryAdapter();
    const brain: Brain = {
      async run() {
        return makePayload({
          orchestration: makeOrch({ action: "use_tool" }),
        });
      },
    };

    const deps: LoopDeps = {
      brain,
      memory,
      tools: new MockToolAdapter(),
      delivery: new ConsoleDeliveryAdapter(),
      config: { ...DEFAULT_CONFIG },
    };

    await executeEvent(userEvent("Do something"), deps);

    // The task should be marked as failed, not completed
    const allTasks = memory.getAllTasks(); // helper from InMemoryAdapter
    expect(allTasks.length).toBe(1);
    expect(allTasks[0].status).toBe("failed");
  });

  it("fires onIteration before aborting", async () => {
    const onIteration = vi.fn();
    const brain: Brain = {
      async run() {
        return makePayload({
          orchestration: makeOrch({ action: "use_tool" }),
        });
      },
    };

    const deps: LoopDeps = {
      brain,
      memory: new InMemoryAdapter(),
      tools: new MockToolAdapter(),
      delivery: new ConsoleDeliveryAdapter(),
      config: { ...DEFAULT_CONFIG },
      onIteration,
    };

    await executeEvent(userEvent("Do"), deps);

    expect(onIteration).toHaveBeenCalledOnce();
    const step = onIteration.mock.calls[0][1];
    expect(step.reasoning).toContain("INVALID_REASONING");
  });
});
