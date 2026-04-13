/**
 * createAgent — Wires adapters together and returns an AgentHandle.
 *
 * This is the entry point for using msm-agent. Provide a brain (MSM pipeline),
 * adapters for memory/tools/events/delivery, and optional config overrides.
 */

import type { AgentConfig, AgentEvent, AgentHandle, Brain, LoopOutcome, GuardSignal } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { MemoryAdapter } from "../adapters/memory.js";
import type { ToolAdapter } from "../adapters/tools.js";
import type { EventAdapter } from "../adapters/events.js";
import type { DeliveryAdapter } from "../adapters/delivery.js";
import { executeEvent, type LoopDeps } from "./loop.js";

export interface CreateAgentOptions {
  brain: Brain;
  memory: MemoryAdapter;
  tools: ToolAdapter;
  events: EventAdapter;
  delivery: DeliveryAdapter;
  config?: Partial<AgentConfig>;
  /** Optional: called on every iteration for observability */
  onIteration?: LoopDeps["onIteration"];
  /** Optional: called when a guard fires */
  onGuard?: (signal: GuardSignal) => void;
}

export function createAgent(options: CreateAgentOptions): AgentHandle {
  const config: AgentConfig = { ...DEFAULT_CONFIG, ...options.config };

  const deps: LoopDeps = {
    brain: options.brain,
    memory: options.memory,
    tools: options.tools,
    delivery: options.delivery,
    config,
    onIteration: options.onIteration,
    onGuard: options.onGuard,
  };

  // Wire event adapter → loop → delivery
  options.events.onEvent(async (event: AgentEvent) => {
    const outcome = await executeEvent(event, deps);
    const sessionId = "sessionId" in event ? event.sessionId : `cron-${Date.now()}`;
    await options.delivery.send(sessionId, outcome);
  });

  return {
    async handleEvent(event: AgentEvent): Promise<LoopOutcome> {
      return executeEvent(event, deps);
    },

    async start(): Promise<void> {
      await options.events.start();
    },

    async stop(): Promise<void> {
      await options.events.stop();
    },
  };
}
