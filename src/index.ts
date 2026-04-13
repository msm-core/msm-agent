/**
 * msm-agent — Portable Agent Framework for MSM Brain
 *
 * The agent is the "hands" — it receives events, asks the MSM brain
 * what to do, executes tools, feeds results back, and delivers responses.
 * The brain (MSM) never executes anything — it only decides.
 */

// ─── Core ────────────────────────────────────────────────────
export { createAgent } from "./core/agent.js";
export type { CreateAgentOptions } from "./core/agent.js";

export type {
  AgentConfig,
  AgentEvent,
  AgentHandle,
  Brain,
  GuardSignal,
  LoopOutcome,
  Message,
  RunState,
  StepResult,
  TaskPlan,
  TaskState,
  TaskStatus,
} from "./core/types.js";
export { DEFAULT_CONFIG } from "./core/types.js";

// ─── Loop (for advanced usage) ───────────────────────────────
export { executeEvent } from "./core/loop.js";
export type { LoopDeps } from "./core/loop.js";

// ─── Guards ──────────────────────────────────────────────────
export { checkGuards, hasHardBlock } from "./core/guards.js";

// ─── Planner ─────────────────────────────────────────────────
export {
  createPlan,
  advancePlanStep,
  failPlanStep,
  canReplan,
  replan,
  clearPlan,
  isPlanComplete,
  getCurrentStep,
} from "./core/planner.js";

// ─── Context Builder ─────────────────────────────────────────
export { buildContext } from "./core/context.js";
export type { BrainInput, ContextOptions } from "./core/context.js";

// ─── Adapter Interfaces ─────────────────────────────────────
export type { MemoryAdapter, MemoryEntry } from "./adapters/memory.js";
export type { ToolAdapter, ToolDefinition, ToolParameter, ToolValidationResult } from "./adapters/tools.js";
export type { EventAdapter } from "./adapters/events.js";
export type { DeliveryAdapter } from "./adapters/delivery.js";

// ─── Dummy Adapters (testing & demos) ────────────────────────
export { InMemoryAdapter } from "./adapters-dummy/memory.js";
export { MockToolAdapter } from "./adapters-dummy/tools.js";
export type { MockToolResponse } from "./adapters-dummy/tools.js";
export { ManualEventAdapter } from "./adapters-dummy/events.js";
export { ConsoleDeliveryAdapter } from "./adapters-dummy/delivery.js";
