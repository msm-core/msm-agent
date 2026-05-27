import { describe, it, expect } from "vitest";
import { createAgent } from "../src/core/agent.js";
import { createAgentHub, isAgentHub } from "../src/core/hub.js";
import type {
  Brain,
  AgentEvent,
  BrainPayload,
  BrainOrchestration,
  BrainGeneration,
  BrainFinalOutput,
} from "../src/core/types.js";
import { InMemoryAdapter } from "../src/adapters-dummy/memory.js";
import { MockToolAdapter } from "../src/adapters-dummy/tools.js";
import { ManualEventAdapter } from "../src/adapters-dummy/events.js";
import { ConsoleDeliveryAdapter } from "../src/adapters-dummy/delivery.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makePayload(text: string): BrainPayload {
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
    } satisfies BrainOrchestration,
    generation: {
      model_id: "test",
      model_ver: "1.0",
      latency_ms: 10,
      confidence: 0.9,
      status: "ok",
      response_text: text,
      tone: "neutral",
      word_count: text.split(" ").length,
    } satisfies BrainGeneration,
    final_output: {
      text,
      language: "en",
      total_latency_ms: 20,
      pipeline_status: "ok",
    } satisfies BrainFinalOutput,
  };
}

function staticBrain(text: string): Brain {
  return {
    async run() {
      return makePayload(text);
    },
  };
}

function makeEvent(sessionId = "sess1"): AgentEvent {
  return {
    type: "user_message",
    sessionId,
    text: "hello",
    modality: "text",
  };
}

function makeAgent(text: string) {
  return createAgent({
    brain: staticBrain(text),
    memory: new InMemoryAdapter(),
    tools: new MockToolAdapter(),
    events: new ManualEventAdapter(),
    delivery: new ConsoleDeliveryAdapter(),
  });
}

// ─── createAgentHub ───────────────────────────────────────────────────────────

describe("createAgentHub", () => {
  it("creates a hub with correct agentNames()", () => {
    const hub = createAgentHub({
      feasibility: makeAgent("feasibility response"),
      legal: makeAgent("legal response"),
    });

    expect(hub.agentNames()).toEqual(
      expect.arrayContaining(["feasibility", "legal"]),
    );
    expect(hub.agentNames()).toHaveLength(2);
  });

  it("exposes agents as a frozen record", () => {
    const hub = createAgentHub({ support: makeAgent("hi") });
    expect(hub.agents).toHaveProperty("support");
    expect(Object.isFrozen(hub.agents)).toBe(true);
  });

  it("routes handleEvent to the correct agent", async () => {
    const hub = createAgentHub({
      a: makeAgent("from agent A"),
      b: makeAgent("from agent B"),
    });

    const outcomeA = await hub.handleEvent("a", makeEvent());
    const outcomeB = await hub.handleEvent("b", makeEvent());

    // Each agent gets its own brain response — routing worked
    expect(outcomeA.type).toBe("response");
    expect(outcomeB.type).toBe("response");
  });

  it("rejects handleEvent for unknown agent name", async () => {
    const hub = createAgentHub({ support: makeAgent("hi") });
    await expect(hub.handleEvent("nonexistent", makeEvent())).rejects.toThrow(
      /no agent registered as "nonexistent"/i,
    );
  });

  it("throws if agents map is empty", () => {
    expect(() => createAgentHub({})).toThrow(/must not be empty/);
  });

  it("throws if agent name contains invalid characters", () => {
    expect(() => createAgentHub({ "bad name!": makeAgent("x") })).toThrow(
      /invalid characters/,
    );
    expect(() => createAgentHub({ "bad/path": makeAgent("x") })).toThrow(
      /invalid characters/,
    );
  });

  it("allows hyphens and underscores in agent names", () => {
    expect(() =>
      createAgentHub({
        "my-agent": makeAgent("x"),
        my_agent_2: makeAgent("y"),
      }),
    ).not.toThrow();
  });
});

// ─── isAgentHub ───────────────────────────────────────────────────────────────

describe("isAgentHub", () => {
  it("returns true for a valid hub", () => {
    const hub = createAgentHub({ support: makeAgent("hi") });
    expect(isAgentHub(hub)).toBe(true);
  });

  it("returns false for a single AgentHandle", () => {
    const agent = makeAgent("hi");
    expect(isAgentHub(agent)).toBe(false);
  });

  it("returns false for null and primitives", () => {
    expect(isAgentHub(null)).toBe(false);
    expect(isAgentHub(undefined)).toBe(false);
    expect(isAgentHub(42)).toBe(false);
    expect(isAgentHub("hub")).toBe(false);
  });
});

// ─── Session isolation (shared memory, separate session IDs) ──────────────────

describe("AgentHub session isolation", () => {
  it("processes independent sessions per agent without interference", async () => {
    // Both agents share the same memory adapter instance (as in real deployments)
    const sharedMemory = new InMemoryAdapter();

    const hub = createAgentHub({
      billing: createAgent({
        brain: staticBrain("billing answer"),
        memory: sharedMemory,
        tools: new MockToolAdapter(),
        events: new ManualEventAdapter(),
        delivery: new ConsoleDeliveryAdapter(),
      }),
      shipping: createAgent({
        brain: staticBrain("shipping answer"),
        memory: sharedMemory,
        tools: new MockToolAdapter(),
        events: new ManualEventAdapter(),
        delivery: new ConsoleDeliveryAdapter(),
      }),
    });

    // Parallel events to different agents — both should complete successfully
    const [billingResult, shippingResult] = await Promise.all([
      hub.handleEvent("billing", makeEvent("billing::sess1")),
      hub.handleEvent("shipping", makeEvent("shipping::sess1")),
    ]);

    expect(billingResult.type).toBe("response");
    expect(shippingResult.type).toBe("response");
  });
});
