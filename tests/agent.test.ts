import { describe, it, expect, vi } from "vitest";
import { createAgent } from "../src/core/agent.js";
import type { Brain, AgentEvent } from "../src/core/types.js";
import type { MSMPayload, OrchestrationOutput, GenerationOutput, FinalOutput } from "msm-ai";
import { InMemoryAdapter } from "../src/adapters-dummy/memory.js";
import { MockToolAdapter } from "../src/adapters-dummy/tools.js";
import { ManualEventAdapter } from "../src/adapters-dummy/events.js";
import { ConsoleDeliveryAdapter } from "../src/adapters-dummy/delivery.js";

function makePayload(text: string): MSMPayload {
  return {
    msm_version: "3.0.0",
    session_id: "test",
    trace_id: "t1",
    timestamp: new Date().toISOString(),
    input: { raw: "test", modality: "text" },
    orchestration: {
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
      reasoning: "",
    } satisfies OrchestrationOutput,
    generation: {
      model_id: "test",
      model_ver: "1.0",
      latency_ms: 10,
      confidence: 0.9,
      status: "ok",
      response_text: text,
      tone: "neutral",
      word_count: text.split(" ").length,
    } satisfies GenerationOutput,
    final_output: {
      text,
      language: "en",
      total_latency_ms: 20,
      pipeline_status: "ok",
    } satisfies FinalOutput,
  };
}

function staticBrain(text: string): Brain {
  return {
    async run() {
      return makePayload(text);
    },
  };
}

describe("createAgent", () => {
  it("returns an AgentHandle with handleEvent, start, stop", () => {
    const agent = createAgent({
      brain: staticBrain("Hello"),
      memory: new InMemoryAdapter(),
      tools: new MockToolAdapter(),
      events: new ManualEventAdapter(),
      delivery: new ConsoleDeliveryAdapter(),
    });

    expect(agent.handleEvent).toBeTypeOf("function");
    expect(agent.start).toBeTypeOf("function");
    expect(agent.stop).toBeTypeOf("function");
  });

  it("handleEvent processes an event and returns outcome", async () => {
    const agent = createAgent({
      brain: staticBrain("I can help with that."),
      memory: new InMemoryAdapter(),
      tools: new MockToolAdapter(),
      events: new ManualEventAdapter(),
      delivery: new ConsoleDeliveryAdapter(),
    });

    const outcome = await agent.handleEvent({
      type: "user_message",
      sessionId: "s1",
      text: "Help me",
      modality: "text",
    });

    expect(outcome.type).toBe("response");
    if (outcome.type === "response") {
      expect(outcome.text).toBe("I can help with that.");
    }
  });

  it("wires event adapter to delivery via executeEvent", async () => {
    const events = new ManualEventAdapter();
    const delivery = new ConsoleDeliveryAdapter();

    const agent = createAgent({
      brain: staticBrain("Auto-delivered."),
      memory: new InMemoryAdapter(),
      tools: new MockToolAdapter(),
      events,
      delivery,
    });

    await agent.start();

    // Emit an event through the event adapter
    await events.emit({
      type: "user_message",
      sessionId: "s1",
      text: "Trigger",
      modality: "text",
    });

    // The delivery adapter should have received the outcome
    const log = delivery.getLog();
    expect(log).toHaveLength(1);
    expect(log[0].outcome.type).toBe("response");
    if (log[0].outcome.type === "response") {
      expect(log[0].outcome.text).toBe("Auto-delivered.");
    }

    await agent.stop();
  });

  it("applies config overrides", async () => {
    const onGuard = vi.fn();

    // Brain always tries to use a tool with low confidence
    const brain: Brain = {
      async run() {
        return {
          msm_version: "3.0.0",
          session_id: "test",
          trace_id: "t1",
          timestamp: new Date().toISOString(),
          input: { raw: "test", modality: "text" },
          orchestration: {
            model_id: "test",
            model_ver: "1.0",
            latency_ms: 10,
            confidence: 0.4,
            status: "ok",
            action: "use_tool",
            tool_name: "risky",
            workflow_steps: [],
            tool_selections: [],
            estimated_steps: 1,
            mode: "rules",
          } satisfies OrchestrationOutput,
          generation: {
            model_id: "test",
            model_ver: "1.0",
            latency_ms: 10,
            confidence: 0.9,
            status: "ok",
            response_text: "Need more info",
            tone: "neutral",
            word_count: 3,
          } satisfies GenerationOutput,
          final_output: {
            text: "Need more info",
            language: "en",
            total_latency_ms: 20,
            pipeline_status: "ok",
          },
        };
      },
    };

    const agent = createAgent({
      brain,
      memory: new InMemoryAdapter(),
      tools: new MockToolAdapter(),
      events: new ManualEventAdapter(),
      delivery: new ConsoleDeliveryAdapter(),
      config: { confidenceThreshold: 0.5 },
      onGuard,
    });

    const outcome = await agent.handleEvent({
      type: "user_message",
      sessionId: "s1",
      text: "Test config",
      modality: "text",
    });

    // Should trigger confidence guard (0.4 < 0.5 override)
    expect(outcome.type).toBe("clarification");
    expect(onGuard).toHaveBeenCalled();
  });
});
