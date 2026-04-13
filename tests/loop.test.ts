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

function makeGeneration(text: string): GenerationOutput {
  return {
    model_id: "test",
    model_ver: "1.0",
    latency_ms: 10,
    confidence: 0.9,
    status: "ok",
    response_text: text,
    tone: "neutral",
    word_count: text.split(" ").length,
  };
}

function makeFinalOutput(text: string): FinalOutput {
  return {
    text,
    language: "en",
    total_latency_ms: 20,
    pipeline_status: "ok",
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
    generation: makeGeneration("Hello!"),
    final_output: makeFinalOutput("Hello!"),
    ...overrides,
  };
}

/** Create a brain that returns a sequence of payloads (one per call) */
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

/** Create a brain that always returns the same payload */
function staticBrain(payload: MSMPayload): Brain {
  return {
    async run() {
      return payload;
    },
  };
}

function userEvent(text: string, sessionId = "s1"): AgentEvent {
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

describe("execution loop", () => {
  describe("terminal actions", () => {
    it("returns response on action=respond", async () => {
      const brain = staticBrain(
        makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: makeGeneration("The answer is 42."),
          final_output: makeFinalOutput("The answer is 42."),
        }),
      );

      const outcome = await executeEvent(
        userEvent("What is the answer?"),
        makeDeps(brain),
      );
      expect(outcome.type).toBe("response");
      if (outcome.type === "response") {
        expect(outcome.text).toBe("The answer is 42.");
        expect(outcome.language).toBe("en");
      }
    });

    it("returns escalated on action=escalate", async () => {
      const brain = staticBrain(
        makePayload({
          orchestration: makeOrch({
            action: "escalate",
            reasoning: "Need human help",
          }),
        }),
      );

      const outcome = await executeEvent(
        userEvent("I need a manager"),
        makeDeps(brain),
      );
      expect(outcome.type).toBe("escalated");
      if (outcome.type === "escalated") {
        expect(outcome.reason).toBe("Need human help");
      }
    });

    it("returns clarification on action=clarify", async () => {
      const brain = staticBrain(
        makePayload({
          orchestration: makeOrch({ action: "clarify" }),
          generation: makeGeneration("What size do you want?"),
          final_output: makeFinalOutput("What size do you want?"),
        }),
      );

      const outcome = await executeEvent(
        userEvent("I want a shirt"),
        makeDeps(brain),
      );
      expect(outcome.type).toBe("clarification");
      if (outcome.type === "clarification") {
        expect(outcome.question).toBe("What size do you want?");
      }
    });

    it("returns delegated on action=delegate", async () => {
      const brain = staticBrain(
        makePayload({
          orchestration: {
            ...makeOrch({
              action: "delegate",
              reasoning: "Sending to billing",
            }),
            delegate_to_role: "billing_agent",
          } as OrchestrationOutput,
        }),
      );

      const outcome = await executeEvent(
        userEvent("Check my bill"),
        makeDeps(brain),
      );
      expect(outcome.type).toBe("delegated");
      if (outcome.type === "delegated") {
        expect(outcome.targetRole).toBe("billing_agent");
      }
    });

    it("returns custom for unknown actions", async () => {
      const brain = staticBrain(
        makePayload({
          orchestration: makeOrch({ action: "schedule_callback" }),
        }),
      );

      const outcome = await executeEvent(
        userEvent("Call me later"),
        makeDeps(brain),
      );
      expect(outcome.type).toBe("custom");
      if (outcome.type === "custom") {
        expect(outcome.action).toBe("schedule_callback");
      }
    });
  });

  describe("tool execution", () => {
    it("executes a tool and loops back to brain", async () => {
      // First call: brain requests tool
      // Second call: brain responds with tool result incorporated
      const brain = sequenceBrain(
        makePayload({
          orchestration: makeOrch({
            action: "use_tool",
            tool_name: "search",
            tool_params: { query: "pizza" },
          }),
        }),
        makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: makeGeneration("Found 3 pizza places."),
          final_output: makeFinalOutput("Found 3 pizza places."),
        }),
      );

      const tools = new MockToolAdapter(
        [{ name: "search", description: "Search", parameters: {} }],
        new Map([["search", { status: "ok", result: { count: 3 } }]]),
      );

      const outcome = await executeEvent(
        userEvent("Find pizza"),
        makeDeps(brain, { tools }),
      );

      expect(outcome.type).toBe("response");
      if (outcome.type === "response") {
        expect(outcome.text).toBe("Found 3 pizza places.");
      }
    });

    it("handles tool execution failure gracefully", async () => {
      const brain = sequenceBrain(
        makePayload({
          orchestration: makeOrch({
            action: "use_tool",
            tool_name: "failing_tool",
            tool_params: {},
          }),
        }),
        makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: makeGeneration("Sorry, that failed."),
          final_output: makeFinalOutput("Sorry, that failed."),
        }),
      );

      const tools = new MockToolAdapter(
        [{ name: "failing_tool", description: "Always fails", parameters: {} }],
        new Map([
          [
            "failing_tool",
            { status: "failed", result: { error: "Connection refused" } },
          ],
        ]),
      );

      const outcome = await executeEvent(
        userEvent("Try this"),
        makeDeps(brain, { tools }),
      );

      expect(outcome.type).toBe("response");
      if (outcome.type === "response") {
        expect(outcome.text).toBe("Sorry, that failed.");
      }
    });

    it("handles tool execute() throwing an exception", async () => {
      const brain = sequenceBrain(
        makePayload({
          orchestration: makeOrch({
            action: "use_tool",
            tool_name: "crasher",
            tool_params: {},
          }),
        }),
        makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: makeGeneration("Recovered from crash."),
          final_output: makeFinalOutput("Recovered from crash."),
        }),
      );

      const tools = new MockToolAdapter([
        { name: "crasher", description: "", parameters: {} },
      ]);
      // Override execute to throw
      tools.execute = async () => {
        throw new Error("Boom!");
      };

      const outcome = await executeEvent(
        userEvent("Crash test"),
        makeDeps(brain, { tools }),
      );

      expect(outcome.type).toBe("response");
    });

    it("aborts on use_tool with no tool_name", async () => {
      // Brain says use_tool but forgets tool_name — must abort immediately
      // to prevent infinite loop (dalil: INVALID_REASONING → failTask)
      const brain = sequenceBrain(
        makePayload({
          orchestration: makeOrch({ action: "use_tool" }), // no tool_name
        }),
      );

      const outcome = await executeEvent(userEvent("Test"), makeDeps(brain));
      expect(outcome.type).toBe("error");
      if (outcome.type === "error") {
        expect(outcome.error).toContain("tool_name");
      }
    });

    it("checks tool validation when available", async () => {
      const brain = sequenceBrain(
        makePayload({
          orchestration: makeOrch({
            action: "use_tool",
            tool_name: "strict_tool",
            tool_params: { bad: "param" },
          }),
        }),
        makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: makeGeneration("Validation failed, responding."),
          final_output: makeFinalOutput("Validation failed, responding."),
        }),
      );

      const tools = new MockToolAdapter([
        { name: "strict_tool", description: "", parameters: {} },
      ]);
      tools.validate = () => ({
        valid: false,
        errors: ["Missing required field 'id'"],
      });

      const outcome = await executeEvent(
        userEvent("Test validation"),
        makeDeps(brain, { tools }),
      );

      expect(outcome.type).toBe("response");
    });

    it("requests approval for tools that require it", async () => {
      const brain = sequenceBrain(
        makePayload({
          orchestration: makeOrch({
            action: "use_tool",
            tool_name: "delete_account",
            tool_params: { id: "123" },
          }),
        }),
        makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: makeGeneration("Approval denied."),
          final_output: makeFinalOutput("Approval denied."),
        }),
      );

      const tools = new MockToolAdapter([
        {
          name: "delete_account",
          description: "Destructive",
          parameters: {},
          requiresApproval: true,
        },
      ]);

      const delivery = new ConsoleDeliveryAdapter();
      delivery.requestApproval = vi.fn().mockResolvedValue(false);

      const outcome = await executeEvent(
        userEvent("Delete my account"),
        makeDeps(brain, { tools, delivery }),
      );

      expect(delivery.requestApproval).toHaveBeenCalledWith(
        "s1",
        expect.stringMatching(/^task-/),
        "delete_account",
        { id: "123" },
        expect.any(String),
      );
      expect(outcome.type).toBe("response");
    });
  });

  describe("guards integration", () => {
    it("returns clarification on low confidence tool call", async () => {
      const brain = staticBrain(
        makePayload({
          orchestration: makeOrch({
            action: "use_tool",
            tool_name: "risky_call",
            confidence: 0.3, // Below 0.6 threshold
          }),
          generation: makeGeneration("Can you clarify what you mean?"),
          final_output: makeFinalOutput("Can you clarify what you mean?"),
        }),
      );

      const outcome = await executeEvent(
        userEvent("Do something"),
        makeDeps(brain),
      );
      expect(outcome.type).toBe("clarification");
    });

    it("force-responds when iteration limit is reached", async () => {
      // Brain keeps requesting tool calls — should hit iteration limit
      const brain = staticBrain(
        makePayload({
          orchestration: makeOrch({
            action: "use_tool",
            tool_name: "infinite_tool",
            tool_params: {},
          }),
        }),
      );

      const tools = new MockToolAdapter([
        { name: "infinite_tool", description: "", parameters: {} },
      ]);

      const config: AgentConfig = { ...DEFAULT_CONFIG, maxIterations: 3 };
      const outcome = await executeEvent(
        userEvent("Loop forever"),
        makeDeps(brain, { tools, config }),
      );

      // Should eventually exhaust iterations and return something
      expect(["response", "clarification", "error"]).toContain(outcome.type);
    });
  });

  describe("plan tracking", () => {
    it("tracks plan from brain orchestration output", async () => {
      const memory = new InMemoryAdapter();

      const brain = sequenceBrain(
        makePayload({
          orchestration: makeOrch({
            action: "use_tool",
            tool_name: "step1",
            tool_params: {},
            plan: [
              {
                id: 1,
                description: "Do step 1",
                tool_hint: "step1",
                status: "pending",
              },
              {
                id: 2,
                description: "Do step 2",
                tool_hint: "step2",
                status: "pending",
              },
            ],
          }),
        }),
        makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: makeGeneration("All done."),
          final_output: makeFinalOutput("All done."),
        }),
      );

      const tools = new MockToolAdapter([
        { name: "step1", description: "", parameters: {} },
      ]);

      await executeEvent(
        userEvent("Do multi-step"),
        makeDeps(brain, { memory, tools }),
      );

      // Verify task was saved with a plan
      const tasks = memory.getAllTasks();
      expect(tasks.length).toBe(1);
      expect(tasks[0].plan).not.toBeNull();
      expect(tasks[0].plan!.steps).toHaveLength(2);
    });
  });

  describe("error handling", () => {
    it("returns error when brain returns no orchestration", async () => {
      const brain = staticBrain({
        msm_version: "3.0.0",
        session_id: "test",
        trace_id: "t1",
        timestamp: new Date().toISOString(),
        input: { raw: "test", modality: "text" },
        // No orchestration layer
      });

      const outcome = await executeEvent(userEvent("Test"), makeDeps(brain));
      expect(outcome.type).toBe("error");
      if (outcome.type === "error") {
        expect(outcome.error).toContain("no orchestration");
      }
    });
  });

  describe("observability hooks", () => {
    it("calls onIteration on each loop step", async () => {
      const onIteration = vi.fn();

      const brain = sequenceBrain(
        makePayload({
          orchestration: makeOrch({
            action: "use_tool",
            tool_name: "t1",
            tool_params: {},
          }),
        }),
        makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: makeGeneration("Done."),
          final_output: makeFinalOutput("Done."),
        }),
      );

      const tools = new MockToolAdapter([
        { name: "t1", description: "", parameters: {} },
      ]);

      await executeEvent(
        userEvent("Test hooks"),
        makeDeps(brain, { tools, onIteration }),
      );

      // Should be called twice: once for tool step, once for respond
      expect(onIteration).toHaveBeenCalledTimes(2);
    });

    it("calls onGuard when guards fire", async () => {
      const onGuard = vi.fn();

      const brain = staticBrain(
        makePayload({
          orchestration: makeOrch({
            action: "use_tool",
            tool_name: "x",
            confidence: 0.2,
          }),
          generation: makeGeneration("Clarify please"),
        }),
      );

      await executeEvent(userEvent("Unclear"), makeDeps(brain, { onGuard }));

      expect(onGuard).toHaveBeenCalled();
      const signal = onGuard.mock.calls[0][0];
      expect(signal.type).toBe("confidence_low");
    });
  });

  describe("event types", () => {
    it("handles tool_callback events", async () => {
      const brain = staticBrain(
        makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: makeGeneration("Got the callback."),
          final_output: makeFinalOutput("Got the callback."),
        }),
      );

      const event: AgentEvent = {
        type: "tool_callback",
        sessionId: "s1",
        taskId: "t1",
        result: {
          tool: "webhook_tool",
          status: "ok",
          result: { data: "callback data" },
        },
      };

      const outcome = await executeEvent(event, makeDeps(brain));
      expect(outcome.type).toBe("response");
    });

    it("handles webhook events", async () => {
      const brain = staticBrain(
        makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: makeGeneration("Webhook processed."),
          final_output: makeFinalOutput("Webhook processed."),
        }),
      );

      const event: AgentEvent = {
        type: "webhook",
        sessionId: "s1",
        source: "stripe",
        payload: { event: "payment_succeeded" },
      };

      const outcome = await executeEvent(event, makeDeps(brain));
      expect(outcome.type).toBe("response");
    });

    it("handles cron events", async () => {
      const brain = staticBrain(
        makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: makeGeneration("Cron job done."),
          final_output: makeFinalOutput("Cron job done."),
        }),
      );

      const event: AgentEvent = {
        type: "cron",
        taskType: "daily_cleanup",
      };

      const outcome = await executeEvent(event, makeDeps(brain));
      expect(outcome.type).toBe("response");
    });
  });

  describe("memory integration", () => {
    it("saves user and assistant messages to memory", async () => {
      const memory = new InMemoryAdapter();

      const brain = staticBrain(
        makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: makeGeneration("Hi there!"),
          final_output: makeFinalOutput("Hi there!"),
        }),
      );

      await executeEvent(userEvent("Hello", "s1"), makeDeps(brain, { memory }));

      const messages = await memory.getConversation("s1");
      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe("user");
      expect(messages[0].content).toBe("Hello");
      expect(messages[1].role).toBe("assistant");
      expect(messages[1].content).toBe("Hi there!");
    });

    it("persists task state", async () => {
      const memory = new InMemoryAdapter();

      const brain = staticBrain(
        makePayload({
          orchestration: makeOrch({ action: "respond" }),
          generation: makeGeneration("Done."),
          final_output: makeFinalOutput("Done."),
        }),
      );

      await executeEvent(
        userEvent("Do something"),
        makeDeps(brain, { memory }),
      );

      const tasks = memory.getAllTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe("completed");
      expect(tasks[0].completedAt).toBeTruthy();
    });
  });
});
