/**
 * Tests for the 7 Codex review findings:
 *  1. Task resumption (tool_callback + waiting_clarification)
 *  2. Abortable tool execution (AbortSignal passed to tools)
 *  3. Distributed dedup contract (checkIdempotency/recordIdempotency)
 *  4. Cost tracking (costExtractor hook)
 *  5. Evidence + Receipt generation on terminal outcomes
 *  6. maxToolCallsPerTask budget guard
 *  7. Brain call error handling (try/catch → failTask)
 */

import { describe, it, expect, vi } from "vitest";
import { executeEvent, type LoopDeps } from "../src/core/loop.js";
import { DEFAULT_CONFIG } from "../src/core/types.js";
import type {
  AgentEvent,
  Brain,
  AgentConfig,
  BrainPayload,
  BrainOrchestration,
  ToolResult,
} from "../src/core/types.js";
import { InMemoryAdapter } from "../src/adapters-dummy/memory.js";
import { MockToolAdapter } from "../src/adapters-dummy/tools.js";
import { ConsoleDeliveryAdapter } from "../src/adapters-dummy/delivery.js";
import { checkGuards, hasHardBlock } from "../src/core/guards.js";
import type { RunState } from "../src/core/types.js";

// ─── Helpers ─────────────────────────────────────────────────

function makeOrch(
  overrides: Partial<BrainOrchestration> = {},
): BrainOrchestration {
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

function makePayload(overrides: Partial<BrainPayload> = {}): BrainPayload {
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

function sequenceBrain(...payloads: BrainPayload[]): Brain {
  let callIndex = 0;
  return {
    async run() {
      const idx = Math.min(callIndex, payloads.length - 1);
      callIndex++;
      return payloads[idx];
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

// ─── Finding 1: Task Resumption ─────────────────────────────

describe("task resumption", () => {
  it("resumes a waiting_clarification task on follow-up user_message", async () => {
    const memory = new InMemoryAdapter();

    // Step 1: First event produces a clarification (waiting_clarification status)
    const brain1 = sequenceBrain(
      makePayload({
        orchestration: makeOrch({ action: "ask_clarification" }),
        generation: {
          model_id: "t",
          model_ver: "1",
          latency_ms: 1,
          confidence: 0.9,
          status: "ok",
          response_text: "Which city?",
          tone: "neutral",
          word_count: 2,
        },
      }),
    );

    const outcome1 = await executeEvent(
      userEvent("book a hotel", "s-resume"),
      makeDeps(brain1, { memory }),
    );
    expect(outcome1.type).toBe("clarification");
    const taskId = (outcome1 as { taskId?: string }).taskId;
    expect(taskId).toBeTruthy();

    // The task should be in waiting_clarification
    const task1 = await memory.getTask(taskId!);
    expect(task1?.status).toBe("waiting_clarification");

    // Step 2: Follow-up message should resume the same task, not create new one
    const brain2 = sequenceBrain(
      makePayload({
        orchestration: makeOrch({ action: "respond" }),
        final_output: {
          text: "Booked in Riyadh!",
          language: "en",
          total_latency_ms: 10,
          pipeline_status: "ok",
        },
      }),
    );

    // Replace brain for this call
    const deps2 = makeDeps(brain2, { memory });
    const outcome2 = await executeEvent(userEvent("Riyadh", "s-resume"), deps2);
    expect(outcome2.type).toBe("response");

    // The original task should now be completed — NOT a new task
    const task2 = await memory.getTask(taskId!);
    expect(task2?.status).toBe("completed");
  });

  it("resumes a waiting_tool task on tool_callback event", async () => {
    const memory = new InMemoryAdapter();

    // Manually create a task in waiting_tool state
    const taskId = "task-resume-tool";
    await memory.saveTask({
      taskId,
      sessionId: "s-tool",
      status: "waiting_tool",
      plan: null,
      steps: [],
      totalCostUsd: 0.05,
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
    });

    const brain = sequenceBrain(
      makePayload({
        orchestration: makeOrch({ action: "respond" }),
        final_output: {
          text: "Tool result processed!",
          language: "en",
          total_latency_ms: 10,
          pipeline_status: "ok",
        },
      }),
    );

    const toolCallbackEvent: AgentEvent = {
      type: "tool_callback",
      sessionId: "s-tool",
      taskId,
      toolName: "search",
      result: { tool: "search", status: "ok", result: { items: 5 } },
    };

    const outcome = await executeEvent(
      toolCallbackEvent,
      makeDeps(brain, { memory }),
    );
    expect(outcome.type).toBe("response");

    // Should have resumed the same task
    const updated = await memory.getTask(taskId);
    expect(updated?.status).toBe("completed");
    // Cost should carry forward
    expect(updated?.totalCostUsd).toBe(0.05);
  });
});

// ─── Finding 2: Abortable Tool Execution ────────────────────

describe("abortable tool execution", () => {
  it("passes AbortSignal to tool execute()", async () => {
    const tools = new MockToolAdapter(
      [{ name: "slow_search", description: "", parameters: {} }],
      new Map([["slow_search", { status: "ok", result: { found: true } }]]),
    );
    const executeSpy = vi.spyOn(tools, "execute");

    const brain = sequenceBrain(
      makePayload({
        orchestration: makeOrch({
          action: "use_tool",
          tool_name: "slow_search",
          tool_params: { q: "test" },
        }),
      }),
      makePayload({
        orchestration: makeOrch({ action: "respond" }),
        final_output: {
          text: "Found it.",
          language: "en",
          total_latency_ms: 10,
          pipeline_status: "ok",
        },
      }),
    );

    await executeEvent(userEvent("search"), makeDeps(brain, { tools }));

    // The execute call should have received 3 args, with the third being an AbortSignal
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const callArgs = executeSpy.mock.calls[0];
    expect(callArgs).toHaveLength(3);
    expect(callArgs[2]).toBeInstanceOf(AbortSignal);
  });
});

// ─── Finding 3: Distributed Dedup Contract ──────────────────

describe("distributed dedup", () => {
  it("uses checkIdempotency cache hit instead of executing", async () => {
    const cachedResult: ToolResult = {
      tool: "pay",
      status: "ok",
      result: { txId: "abc123" },
    };
    const tools = new MockToolAdapter(
      [{ name: "pay", description: "", parameters: {}, destructive: true }],
      new Map([["pay", { status: "ok", result: { txId: "new" } }]]),
    );
    // Attach distributed dedup stubs
    tools.checkIdempotency = vi.fn().mockResolvedValue(cachedResult);
    tools.recordIdempotency = vi.fn().mockResolvedValue(undefined);
    const executeSpy = vi.spyOn(tools, "execute");

    const brain = sequenceBrain(
      makePayload({
        orchestration: makeOrch({
          action: "use_tool",
          tool_name: "pay",
          tool_params: { amount: 100 },
        }),
      }),
      makePayload({
        orchestration: makeOrch({ action: "respond" }),
        final_output: {
          text: "Payment processed.",
          language: "en",
          total_latency_ms: 10,
          pipeline_status: "ok",
        },
      }),
    );

    const outcome = await executeEvent(
      userEvent("pay please"),
      makeDeps(brain, { tools }),
    );
    expect(outcome.type).toBe("response");

    // Should have checked idempotency
    expect(tools.checkIdempotency).toHaveBeenCalledWith("pay", { amount: 100 });
    // Should NOT have called execute (cache hit)
    expect(executeSpy).not.toHaveBeenCalled();
    // Should NOT record again (it was a cache hit)
    expect(tools.recordIdempotency).not.toHaveBeenCalled();
  });

  it("records idempotency after successful destructive execution", async () => {
    const tools = new MockToolAdapter(
      [{ name: "pay", description: "", parameters: {}, destructive: true }],
      new Map([["pay", { status: "ok", result: { txId: "new" } }]]),
    );
    // No cache hit
    tools.checkIdempotency = vi.fn().mockResolvedValue(null);
    tools.recordIdempotency = vi.fn().mockResolvedValue(undefined);

    const brain = sequenceBrain(
      makePayload({
        orchestration: makeOrch({
          action: "use_tool",
          tool_name: "pay",
          tool_params: { amount: 50 },
        }),
      }),
      makePayload({
        orchestration: makeOrch({ action: "respond" }),
        final_output: {
          text: "Done.",
          language: "en",
          total_latency_ms: 10,
          pipeline_status: "ok",
        },
      }),
    );

    await executeEvent(userEvent("pay 50"), makeDeps(brain, { tools }));

    // Should have recorded the result for future dedup
    expect(tools.recordIdempotency).toHaveBeenCalledWith(
      "pay",
      { amount: 50 },
      expect.objectContaining({ tool: "pay", status: "ok" }),
    );
  });
});

// ─── Finding 4: Cost Tracking ───────────────────────────────

describe("cost tracking", () => {
  it("accumulates cost via costExtractor hook", async () => {
    const costExtractor = vi.fn().mockReturnValue(0.003);

    // 2 iterations: use_tool then respond
    const brain = sequenceBrain(
      makePayload({
        orchestration: makeOrch({
          action: "use_tool",
          tool_name: "search",
          tool_params: { q: "test" },
        }),
      }),
      makePayload({
        orchestration: makeOrch({ action: "respond" }),
        final_output: {
          text: "Done.",
          language: "en",
          total_latency_ms: 10,
          pipeline_status: "ok",
        },
      }),
    );

    const tools = new MockToolAdapter(
      [{ name: "search", description: "", parameters: {} }],
      new Map([["search", { status: "ok", result: {} }]]),
    );

    const memory = new InMemoryAdapter();
    await executeEvent(
      userEvent("test"),
      makeDeps(brain, { tools, memory, costExtractor }),
    );

    // costExtractor should have been called once per brain.run() (2 iterations)
    expect(costExtractor).toHaveBeenCalledTimes(2);
    // Total cost = 0.003 * 2 = 0.006
    const tasks = memory.getAllTasks();
    expect(tasks[0].totalCostUsd).toBeCloseTo(0.006);
  });
});

// ─── Finding 5: Evidence + Receipt Generation ────────────────

describe("evidence and receipts", () => {
  it("includes evidence and receipts in response outcome after tool use", async () => {
    const brain = sequenceBrain(
      makePayload({
        orchestration: makeOrch({
          action: "use_tool",
          tool_name: "create_order",
          tool_params: { item: "pizza" },
        }),
      }),
      makePayload({
        orchestration: makeOrch({ action: "respond" }),
        final_output: {
          text: "Order placed!",
          language: "en",
          total_latency_ms: 10,
          pipeline_status: "ok",
        },
      }),
    );

    const tools = new MockToolAdapter(
      [{ name: "create_order", description: "", parameters: {} }],
      new Map([
        ["create_order", { status: "ok", result: { orderId: "ORD-1" } }],
      ]),
    );

    const outcome = await executeEvent(
      userEvent("order pizza"),
      makeDeps(brain, { tools }),
    );

    expect(outcome.type).toBe("response");
    if (outcome.type === "response") {
      expect(outcome.evidence).toBeDefined();
      expect(outcome.evidence!.length).toBe(1);
      expect(outcome.evidence![0].toolName).toBe("create_order");
      expect(outcome.evidence![0].toolResult).toEqual({ orderId: "ORD-1" });

      expect(outcome.receipts).toBeDefined();
      expect(outcome.receipts!.length).toBe(1);
      expect(outcome.receipts![0].action).toBe("create_order");
    }
  });

  it("omits evidence/receipts when no tools were used", async () => {
    const brain = sequenceBrain(
      makePayload({
        orchestration: makeOrch({ action: "respond" }),
        final_output: {
          text: "Just a chat.",
          language: "en",
          total_latency_ms: 10,
          pipeline_status: "ok",
        },
      }),
    );

    const outcome = await executeEvent(userEvent("hello"), makeDeps(brain));

    expect(outcome.type).toBe("response");
    if (outcome.type === "response") {
      expect(outcome.evidence).toBeUndefined();
      expect(outcome.receipts).toBeUndefined();
    }
  });
});

// ─── Finding 6: maxToolCallsPerTask Budget Guard ─────────────

describe("maxToolCallsPerTask", () => {
  it("guard fires budget_tool_calls when count reaches max", () => {
    const state: RunState = {
      iteration: 2,
      totalCostUsd: 0,
      startTime: Date.now(),
      replanCount: 0,
      toolCallCount: 5,
      recentSteps: [],
    };
    const config: AgentConfig = { ...DEFAULT_CONFIG, maxToolCallsPerTask: 5 };
    const signals = checkGuards(state, config, "use_tool", 0.9, "search");
    const budgetSignal = signals.find((s) => s.type === "budget_tool_calls");
    expect(budgetSignal).toBeTruthy();
    expect(hasHardBlock(signals)).toBe(true);
  });

  it("does not fire when maxToolCallsPerTask is 0 (unlimited)", () => {
    const state: RunState = {
      iteration: 2,
      totalCostUsd: 0,
      startTime: Date.now(),
      replanCount: 0,
      toolCallCount: 100,
      recentSteps: [],
    };
    const config: AgentConfig = { ...DEFAULT_CONFIG, maxToolCallsPerTask: 0 };
    const signals = checkGuards(state, config, "use_tool", 0.9, "search");
    const budgetSignal = signals.find((s) => s.type === "budget_tool_calls");
    expect(budgetSignal).toBeUndefined();
  });

  it("loop stops when tool call budget exhausted", async () => {
    const tools = new MockToolAdapter(
      [{ name: "search", description: "", parameters: {} }],
      new Map([["search", { status: "ok", result: {} }]]),
    );

    // Brain always says use_tool — budget should force-stop it
    const brain: Brain = {
      async run() {
        return makePayload({
          orchestration: makeOrch({
            action: "use_tool",
            tool_name: "search",
            tool_params: {},
          }),
          final_output: {
            text: "Budget exceeded.",
            language: "en",
            total_latency_ms: 5,
            pipeline_status: "ok",
          },
        });
      },
    };

    const outcome = await executeEvent(
      userEvent("search a lot"),
      makeDeps(brain, {
        tools,
        config: { ...DEFAULT_CONFIG, maxToolCallsPerTask: 2 },
      }),
    );

    // Should return a response (guard hard-blocks after 2 tool calls)
    expect(outcome.type).toBe("response");
  });
});

// ─── Finding 7: Brain Call Error Handling ────────────────────

describe("brain error handling", () => {
  it("returns error outcome and fails task when brain.run() throws", async () => {
    const memory = new InMemoryAdapter();
    const brain: Brain = {
      async run() {
        throw new Error("LLM API timeout");
      },
    };

    const outcome = await executeEvent(
      userEvent("test", "s-err"),
      makeDeps(brain, { memory }),
    );

    expect(outcome.type).toBe("error");
    if (outcome.type === "error") {
      expect(outcome.error).toContain("LLM API timeout");
    }

    // The task should be in failed state
    const tasks = memory.getAllTasks();
    expect(tasks.length).toBe(1);
    expect(tasks[0].status).toBe("failed");
    expect(tasks[0].error).toContain("LLM API timeout");
  });

  it("returns error outcome when brain returns no orchestration", async () => {
    const memory = new InMemoryAdapter();
    const brain: Brain = {
      async run() {
        return {
          msm_version: "3.0.0",
          session_id: "test",
          trace_id: "t",
          timestamp: new Date().toISOString(),
          input: { raw: "test", modality: "text" },
          // No orchestration layer
        } as BrainPayload;
      },
    };

    const outcome = await executeEvent(
      userEvent("test", "s-no-orch"),
      makeDeps(brain, { memory }),
    );

    expect(outcome.type).toBe("error");
    if (outcome.type === "error") {
      expect(outcome.error).toContain("no orchestration");
    }

    const tasks = memory.getAllTasks();
    expect(tasks[0].status).toBe("failed");
  });
});
