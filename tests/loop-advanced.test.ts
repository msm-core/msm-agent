import { describe, it, expect, vi } from "vitest";
import { executeEvent, type LoopDeps } from "../src/core/loop.js";
import { DEFAULT_CONFIG } from "../src/core/types.js";
import type { AgentEvent, Brain, AgentConfig } from "../src/core/types.js";
import type {
  MSMPayload,
  OrchestrationOutput,
  GenerationOutput,
  FinalOutput,
} from "msm-ai";
import { InMemoryAdapter } from "../src/adapters-dummy/memory.js";
import { MockToolAdapter } from "../src/adapters-dummy/tools.js";
import { ConsoleDeliveryAdapter } from "../src/adapters-dummy/delivery.js";
import { InMemoryControlBus } from "../src/adapters-dummy/control-bus.js";

// ─── Helpers ─────────────────────────────────────────────────

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
    reasoning: "test reasoning",
    ...overrides,
  };
}

function makePayload(overrides: Partial<MSMPayload> = {}): MSMPayload {
  return {
    msm_version: "3.0.0",
    session_id: "test-session",
    trace_id: "trace-1",
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

function sequenceBrain(...payloads: MSMPayload[]): Brain {
  let callIndex = 0;
  return {
    async run() {
      const idx = Math.min(callIndex, payloads.length - 1);
      callIndex++;
      return payloads[idx];
    },
  };
}

function staticBrain(payload: MSMPayload): Brain {
  return {
    async run() {
      return payload;
    },
  };
}

function userEvent(text = "test", sessionId = "s1"): AgentEvent {
  return { type: "user_message", sessionId, text, modality: "text" };
}

function makeDeps(brain: Brain, overrides: Partial<LoopDeps> = {}): LoopDeps {
  return {
    brain,
    memory: new InMemoryAdapter(),
    tools: new MockToolAdapter(),
    delivery: new ConsoleDeliveryAdapter(),
    config: { ...DEFAULT_CONFIG },
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe("loop — control bus integration", () => {
  it("aborts when task is killed via control bus", async () => {
    const controlBus = new InMemoryControlBus();
    // We need to kill the task, but we don't know the taskId in advance.
    // The loop creates the taskId internally. We'll use a brain that's slow enough
    // for us to kill... Actually, the kill check happens at the start of each iteration.
    // For the first iteration, the task was just created. Let's make the brain request a tool
    // so the loop enters a second iteration, but kill ALL tasks via a broad approach.
    // Better: use a brain that calls a tool, and in the tool execution, kill the task.

    // Simpler approach: kill the task ID pattern. Since we can't predict the exact ID,
    // let's override the control bus to kill everything.
    const alwaysKilledBus: InMemoryControlBus = {
      ...controlBus,
      isTaskKilled: async () => "Killed by admin",
      isTenantPaused: async () => null,
      isToolDisabled: async () => null,
      execute: async () => {},
      clear: () => {},
    };

    const brain = staticBrain(
      makePayload({
        orchestration: makeOrch({
          action: "use_tool",
          tool_name: "search",
          tool_params: {},
        }),
      }),
    );

    const outcome = await executeEvent(
      userEvent("test"),
      makeDeps(brain, { controlBus: alwaysKilledBus }),
    );

    expect(outcome.type).toBe("aborted");
    if (outcome.type === "aborted") {
      expect(outcome.reason).toBe("Killed by admin");
    }
  });

  it("aborts when tenant is paused via control bus", async () => {
    const controlBus = new InMemoryControlBus();
    await controlBus.execute({
      type: "pause_tenant",
      tenantId: "t1",
      reason: "Maintenance window",
    });

    const brain = staticBrain(makePayload());

    const outcome = await executeEvent(
      userEvent("test"),
      makeDeps(brain, { controlBus, tenantId: "t1" }),
    );

    expect(outcome.type).toBe("aborted");
    if (outcome.type === "aborted") {
      expect(outcome.reason).toContain("Maintenance window");
    }
  });

  it("skips disabled tools via control bus", async () => {
    const controlBus = new InMemoryControlBus();
    await controlBus.execute({
      type: "disable_tool",
      toolName: "search",
      reason: "Under maintenance",
    });

    const brain = sequenceBrain(
      makePayload({
        orchestration: makeOrch({
          action: "use_tool",
          tool_name: "search",
          tool_params: {},
        }),
      }),
      makePayload({
        orchestration: makeOrch({ action: "respond" }),
        generation: {
          model_id: "t",
          model_ver: "1",
          latency_ms: 1,
          confidence: 0.9,
          status: "ok",
          response_text: "Tool was disabled.",
          tone: "neutral",
          word_count: 3,
        },
        final_output: {
          text: "Tool was disabled.",
          language: "en",
          total_latency_ms: 1,
          pipeline_status: "ok",
        },
      }),
    );

    const tools = new MockToolAdapter([
      { name: "search", description: "Search", parameters: {} },
    ]);

    const outcome = await executeEvent(
      userEvent("test"),
      makeDeps(brain, { tools, controlBus }),
    );

    expect(outcome.type).toBe("response");
  });
});

describe("loop — rate limiting", () => {
  it("skips rate-limited tools and continues loop", async () => {
    const onGuard = vi.fn();

    const brain = sequenceBrain(
      makePayload({
        orchestration: makeOrch({
          action: "use_tool",
          tool_name: "api",
          tool_params: {},
        }),
      }),
      makePayload({
        orchestration: makeOrch({ action: "respond" }),
        generation: {
          model_id: "t",
          model_ver: "1",
          latency_ms: 1,
          confidence: 0.9,
          status: "ok",
          response_text: "Rate limited, responding.",
          tone: "neutral",
          word_count: 3,
        },
        final_output: {
          text: "Rate limited, responding.",
          language: "en",
          total_latency_ms: 1,
          pipeline_status: "ok",
        },
      }),
    );

    const tools = new MockToolAdapter([
      { name: "api", description: "API", parameters: {} },
    ]);
    tools.checkRateLimit = (name: string) => (name === "api" ? 5000 : 0);

    const outcome = await executeEvent(
      userEvent("test"),
      makeDeps(brain, { tools, onGuard }),
    );

    expect(outcome.type).toBe("response");
    expect(onGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "rate_limited",
        toolName: "api",
        retryAfterMs: 5000,
      }),
    );
  });
});

describe("loop — tool dedup", () => {
  it("deduplicates identical tool calls and returns cached result", async () => {
    let brainCallCount = 0;
    const brain: Brain = {
      async run() {
        brainCallCount++;
        if (brainCallCount === 1) {
          return makePayload({
            orchestration: makeOrch({
              action: "use_tool",
              tool_name: "search",
              tool_params: { q: "pizza" },
            }),
          });
        }
        if (brainCallCount === 2) {
          // Brain asks for exact same tool call again
          return makePayload({
            orchestration: makeOrch({
              action: "use_tool",
              tool_name: "search",
              tool_params: { q: "pizza" },
            }),
          });
        }
        return makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: {
            model_id: "t",
            model_ver: "1",
            latency_ms: 1,
            confidence: 0.9,
            status: "ok",
            response_text: "Found pizza.",
            tone: "neutral",
            word_count: 2,
          },
          final_output: {
            text: "Found pizza.",
            language: "en",
            total_latency_ms: 1,
            pipeline_status: "ok",
          },
        });
      },
    };

    const tools = new MockToolAdapter(
      [{ name: "search", description: "", parameters: {} }],
      new Map([["search", { status: "ok", result: { count: 3 } }]]),
    );
    const executeSpy = vi.spyOn(tools, "execute");

    const outcome = await executeEvent(
      userEvent("find pizza"),
      makeDeps(brain, {
        tools,
        config: { ...DEFAULT_CONFIG, toolDedup: true },
      }),
    );

    expect(outcome.type).toBe("response");
    // Tool should only be executed ONCE — second call is deduped
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not dedup when toolDedup is disabled", async () => {
    let brainCallCount = 0;
    const brain: Brain = {
      async run() {
        brainCallCount++;
        if (brainCallCount <= 2) {
          return makePayload({
            orchestration: makeOrch({
              action: "use_tool",
              tool_name: "search",
              tool_params: { q: "pizza" },
            }),
          });
        }
        return makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: {
            model_id: "t",
            model_ver: "1",
            latency_ms: 1,
            confidence: 0.9,
            status: "ok",
            response_text: "Done.",
            tone: "neutral",
            word_count: 1,
          },
          final_output: {
            text: "Done.",
            language: "en",
            total_latency_ms: 1,
            pipeline_status: "ok",
          },
        });
      },
    };

    const tools = new MockToolAdapter(
      [{ name: "search", description: "", parameters: {} }],
      new Map([["search", { status: "ok", result: { count: 3 } }]]),
    );
    const executeSpy = vi.spyOn(tools, "execute");

    const outcome = await executeEvent(
      userEvent("find pizza"),
      makeDeps(brain, {
        tools,
        config: { ...DEFAULT_CONFIG, toolDedup: false },
      }),
    );

    expect(outcome.type).toBe("response");
    // Tool should be executed TWICE — dedup is off
    expect(executeSpy).toHaveBeenCalledTimes(2);
  });
});
