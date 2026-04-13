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
  ActionReceipt,
  ResponseEvidence,
  ResponseFormat,
  ControlCommand,
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

// ─── Tool Dedup ──────────────────────────────────────────────
export { checkDedup } from "./core/tool-dedup.js";
export type { DedupResult } from "./core/tool-dedup.js";

// ─── Flush Gate ──────────────────────────────────────────────
export { FlushGate } from "./core/flush-gate.js";
export type { FlushGateOptions } from "./core/flush-gate.js";

// ─── Context Builder ─────────────────────────────────────────
export { buildContext } from "./core/context.js";
export type { BrainInput, ContextOptions } from "./core/context.js";
// ─── Output Sanitization ─────────────────────────────────
export { sanitizeOutput, containsSensitiveData } from "./core/sanitize.js";
export type { SanitizeResult } from "./core/sanitize.js";

// ─── Input Guard (Prompt Injection Defense) ──────────────
export { guardInput } from "./core/input-guard.js";
export type { InputGuardResult } from "./core/input-guard.js";
// ─── Adapter Interfaces ─────────────────────────────────────
export type { MemoryAdapter, MemoryEntry } from "./adapters/memory.js";
export type {
  ToolAdapter,
  ToolDefinition,
  ToolParameter,
  ToolRateLimit,
  ToolValidationResult,
} from "./adapters/tools.js";
export type { EventAdapter } from "./adapters/events.js";
export type { DeliveryAdapter } from "./adapters/delivery.js";
export type { ControlBusAdapter } from "./adapters/control-bus.js";

// ─── Dummy Adapters (testing & demos) ────────────────────────
export { InMemoryAdapter } from "./adapters-dummy/memory.js";
export { MockToolAdapter } from "./adapters-dummy/tools.js";
export type { MockToolResponse } from "./adapters-dummy/tools.js";
export { ManualEventAdapter } from "./adapters-dummy/events.js";
export { ConsoleDeliveryAdapter } from "./adapters-dummy/delivery.js";
export { InMemoryControlBus } from "./adapters-dummy/control-bus.js";
