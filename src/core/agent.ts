/**
 * createAgent — Wires adapters together and returns an AgentHandle.
 *
 * This is the entry point for using msm-agent. Provide a brain (MSM pipeline),
 * adapters for memory/tools/events/delivery, and optional config overrides.
 *
 * Production features:
 *  - Session mutex: prevents concurrent executeEvent on the same session
 *  - Pre-hook: fast-intent routing to short-circuit the loop for trivials
 *  - History compaction hook: override naive truncation with LLM summarizer
 */

import type {
  AgentConfig,
  AgentEvent,
  AgentHandle,
  Brain,
  BrainPayload,
  LoopOutcome,
  GuardSignal,
  Message,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { MemoryAdapter } from "../adapters/memory.js";
import type { ToolAdapter } from "../adapters/tools.js";
import type { EventAdapter } from "../adapters/events.js";
import type { DeliveryAdapter } from "../adapters/delivery.js";
import type { ControlBusAdapter } from "../adapters/control-bus.js";
import type { EvolvingAdapter } from "../adapters/evolving.js";
import {
  InProcessLockAdapter,
  type DistributedLockAdapter,
} from "../adapters/distributed-lock.js";
import { executeEvent, type LoopDeps } from "./loop.js";
import { checkGates, type GatesConfig } from "./gates.js";
import { scoreOutcome } from "./quality.js";

function resolveSessionId(event: AgentEvent): string {
  return "sessionId" in event ? event.sessionId : `cron-${Date.now()}`;
}

export interface CreateAgentOptions {
  brain: Brain;
  memory: MemoryAdapter;
  tools: ToolAdapter;
  events: EventAdapter;
  delivery: DeliveryAdapter;
  /** Optional: control bus for runtime operability (pause/kill/disable) */
  controlBus?: ControlBusAdapter;
  /** Optional: tenant ID for multi-tenant control bus checks */
  tenantId?: string;
  config?: Partial<AgentConfig>;
  /** Optional: called on every iteration for observability */
  onIteration?: LoopDeps["onIteration"];
  /** Optional: called when a guard fires */
  onGuard?: (signal: GuardSignal) => void;
  /**
   * Optional: fast-intent pre-hook. Called before entering the brain loop.
   * If it returns a LoopOutcome, the loop is skipped entirely (greetings,
   * FAQs, static replies). Return null/undefined to proceed normally.
   */
  preHook?: (event: AgentEvent) => Promise<LoopOutcome | null | undefined>;
  /**
   * Optional: custom history compaction hook. Receives full conversation
   * history, returns compacted version. Use for LLM-based summarization.
   */
  compactHistory?: (
    messages: Message[],
  ) => Promise<Array<{ role: "user" | "assistant"; content: string }>>;
  /**
   * Optional: extract cost in USD from a brain payload.
   * Called after every brain.run() to track cumulative cost per task.
   */
  costExtractor?: (payload: BrainPayload) => number;
  /**
   * Optional: called when a multi-step plan is created (>1 step).
   * Use to send acknowledge messages ("Let me check for you...").
   */
  onPlanCreated?: LoopDeps["onPlanCreated"];
  /**
   * Optional: called on fatal error to produce a user-friendly recovery message.
   * The repair message is delivered to the user before returning the error.
   */
  onFatalError?: LoopDeps["onFatalError"];
  /**
   * Optional: called when input injection is detected.
   * Return a LoopOutcome to short-circuit, or null to continue with stripped input.
   */
  onInjectionDetected?: LoopDeps["onInjectionDetected"];
  /**
   * Optional: evolving layer — learns from outcomes over time.
   * Provide a MemoryEvolvingAdapter (shadow or assist mode) to enable.
   * In assist mode, past approaches are injected into the prompt.
   */
  evolving?: EvolvingAdapter;
  /**
   * Optional: pre-processing gates — zero-LLM filters applied before the brain loop.
   * Acknowledgement gate suppresses "ok/thanks/تمام" messages.
   * Business hours gate sends a canned closed message outside working hours.
   */
  gates?: GatesConfig;
  /**
   * Optional: pre-rendered equipment block for system prompt injection.
   * Generated via renderEquipmentBlock(def.equipment) from the agent definition.
   * Tells the LLM which external systems it can reach and at what access level.
   */
  equipmentBlock?: string;
  /**
   * Optional: vector knowledge base adapter.
   * When set, the agent searches the KB on every iteration and injects the
   * top-5 most relevant chunks into the brain prompt as [knowledge] context.
   *
   * Usage:
   *   const kb = QdrantKnowledgeAdapter.create({
   *     url: "http://localhost:6333",
   *     collection: "support_kb",
   *     embedProvider: "openai",
   *     embedApiKey: process.env.OPENAI_API_KEY,
   *   });
   *   createAgent({ brain, memory, tools, ..., knowledge: kb });
   */
  knowledge?: import("../adapters/knowledge.js").KnowledgeAdapter;

  /**
   * Optional: distributed lock adapter for session concurrency control.
   *
   * When not provided, the default in-process lock is used (correct for single-instance
   * deployments). For horizontally scaled deployments, provide a `RedisDistributedLock`
   * to prevent two instances from processing the same session simultaneously:
   *
   *   const lock = await RedisDistributedLock.connect(process.env.REDIS_URL);
   *   createAgent({ brain, memory, tools, ..., distributedLock: lock });
   */
  distributedLock?: DistributedLockAdapter;
}

export function createAgent(options: CreateAgentOptions): AgentHandle {
  const config: AgentConfig = { ...DEFAULT_CONFIG, ...options.config };
  const lock: DistributedLockAdapter =
    options.distributedLock ?? new InProcessLockAdapter();

  const deps: LoopDeps = {
    brain: options.brain,
    memory: options.memory,
    tools: options.tools,
    delivery: options.delivery,
    config,
    controlBus: options.controlBus,
    tenantId: options.tenantId,
    onIteration: options.onIteration,
    onGuard: options.onGuard,
    compactHistory: options.compactHistory,
    costExtractor: options.costExtractor,
    onPlanCreated: options.onPlanCreated,
    onFatalError: options.onFatalError,
    onInjectionDetected: options.onInjectionDetected,
    equipmentBlock: options.equipmentBlock,
    knowledge: options.knowledge,
  };

  /** Execute an event with pre-hook, evolving layer, and session lock */
  async function processEvent(
    event: AgentEvent,
    sessionId = resolveSessionId(event),
    onDelta?: (delta: string) => void,
  ): Promise<LoopOutcome> {
    const SESSION_LOCK_TTL_MS = 5 * 60 * 1000; // 5 min max per event
    const handle = await lock.acquire(sessionId, SESSION_LOCK_TTL_MS);
    if (!handle) {
      // Another instance is processing this session — return busy signal
      return {
        type: "error",
        error:
          "A request is already being processed for this session. Please try again shortly.",
      };
    }
    try {
      // Pre-processing gates: zero-LLM filters (ack suppression, business hours)
      if (event.type === "user_message" && options.gates) {
        const gateOutcome = checkGates(event.text, options.gates);
        if (gateOutcome) return gateOutcome;
      }

      // Fast-intent pre-hook: skip brain loop for trivials
      if (options.preHook) {
        const shortCircuit = await options.preHook(event);
        if (shortCircuit) {
          return shortCircuit;
        }
      }

      // Evolving pre-reason: inject hints from past outcomes (assist mode only)
      let evolvingHints: string[] = [];
      if (options.evolving && event.type === "user_message") {
        evolvingHints = await options.evolving
          .preReason({
            sessionId,
            taskId: "",
            situation: event.text,
          })
          .catch(() => []);
      }

      const baseDeps =
        evolvingHints.length > 0 ? { ...deps, evolvingHints } : deps;
      const loopDeps = onDelta
        ? { ...baseDeps, onTextDelta: onDelta }
        : baseDeps;
      const outcome = await executeEvent(event, loopDeps, sessionId);

      // Evolving post-outcome: record what happened (shadow + assist modes)
      if (options.evolving && event.type === "user_message") {
        const quality = scoreOutcome(outcome);
        void options.evolving
          .postOutcome(
            {
              sessionId,
              taskId: "",
              situation: event.text,
              quality,
            },
            outcome,
          )
          .catch(() => {});
      }

      return outcome;
    } finally {
      await handle.release();
    }
  }

  // Wire event adapter → processEvent → delivery
  options.events.onEvent(async (event: AgentEvent) => {
    const sessionId = resolveSessionId(event);
    const outcome = await processEvent(event, sessionId);
    // Suppressed outcomes (acknowledgement gate) produce no delivery — stay silent
    if (outcome.type !== "suppressed") {
      await options.delivery.send(sessionId, outcome);
    }
  });

  return {
    async handleEvent(event: AgentEvent): Promise<LoopOutcome> {
      return processEvent(event);
    },

    async streamEvent(
      event: AgentEvent,
      onDelta: (delta: string) => void,
    ): Promise<LoopOutcome> {
      return processEvent(event, resolveSessionId(event), onDelta);
    },

    async start(): Promise<void> {
      await options.events.start();
    },

    async stop(): Promise<void> {
      await options.events.stop();
    },

    async close(): Promise<void> {
      await options.events.stop().catch(() => {});
      // Best-effort release of optional adapter resources.
      const closeable = options as unknown as Record<string, unknown>;
      for (const key of ["memory", "tools", "knowledge", "delivery", "jobs"]) {
        const adapter = closeable[key] as
          | { close?: () => Promise<void> }
          | undefined;
        await adapter?.close?.().catch(() => {});
      }
    },
  };
}
