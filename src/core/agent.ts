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
import { executeEvent, type LoopDeps } from "./loop.js";

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
}

/**
 * Simple per-session mutex. Ensures only one executeEvent runs per session
 * at a time. Subsequent events for the same session queue behind the first.
 *
 * Prevents double-tap race conditions (e.g., WhatsApp "Yes, Yes" on approval).
 */
class SessionMutex {
  private locks = new Map<string, Promise<void>>();

  async acquire<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    // Chain behind any existing lock for this session
    const prev = this.locks.get(sessionId) ?? Promise.resolve();
    let releaseFn!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });
    this.locks.set(sessionId, next);

    // Wait for previous operation to finish
    await prev;
    try {
      return await fn();
    } finally {
      releaseFn();
      // Clean up if no one else is queued
      if (this.locks.get(sessionId) === next) {
        this.locks.delete(sessionId);
      }
    }
  }
}

export function createAgent(options: CreateAgentOptions): AgentHandle {
  const config: AgentConfig = { ...DEFAULT_CONFIG, ...options.config };
  const mutex = new SessionMutex();

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
  };

  /** Execute an event with pre-hook and session mutex */
  async function processEvent(
    event: AgentEvent,
    sessionId = resolveSessionId(event),
  ): Promise<LoopOutcome> {
    return mutex.acquire(sessionId, async () => {
      // Fast-intent pre-hook: skip brain loop for trivials
      if (options.preHook) {
        const shortCircuit = await options.preHook(event);
        if (shortCircuit) {
          return shortCircuit;
        }
      }

      return executeEvent(event, deps, sessionId);
    });
  }

  // Wire event adapter → processEvent → delivery
  options.events.onEvent(async (event: AgentEvent) => {
    const sessionId = resolveSessionId(event);
    const outcome = await processEvent(event, sessionId);
    await options.delivery.send(sessionId, outcome);
  });

  return {
    async handleEvent(event: AgentEvent): Promise<LoopOutcome> {
      return processEvent(event);
    },

    async start(): Promise<void> {
      await options.events.start();
    },

    async stop(): Promise<void> {
      await options.events.stop();
    },
  };
}
