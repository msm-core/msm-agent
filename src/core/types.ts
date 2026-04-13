/**
 * msm-agent — Core Types
 *
 * Contracts for the agent framework. The agent is the "hands" —
 * it receives events, asks the MSM brain what to do, executes tools,
 * feeds results back, and delivers responses.
 *
 * Extracted from dalil's proven execution engine patterns,
 * made generic and pluggable for any project.
 */

import type {
  MSMPayload,
  OrchestrationAction,
  PlanStep,
  ToolResult,
} from "msm-ai";

// ─── Agent Configuration ─────────────────────────────────────

export interface AgentConfig {
  /** Maximum iterations per event before forcing a response (dalil default: 6) */
  maxIterations: number;
  /** Maximum replans before switching to freestyle (dalil default: 2) */
  maxReplans: number;
  /** Confidence threshold — tool calls below this become clarifications (dalil default: 0.6) */
  confidenceThreshold: number;
  /** Maximum cost per task in USD (0 = unlimited) */
  costCapPerTask: number;
  /** Maximum wall-clock time per task in ms (0 = unlimited) */
  timeoutMs: number;
  /** Enable tool dedup — eliminate redundant tool calls (default: true) */
  toolDedup: boolean;
  /** Maximum tool calls per task (0 = unlimited, dalil: maxToolCallsPerTask) */
  maxToolCallsPerTask: number;
}

export const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 6,
  maxReplans: 2,
  confidenceThreshold: 0.6,
  costCapPerTask: 0,
  timeoutMs: 0,
  toolDedup: true,
  maxToolCallsPerTask: 0,
};

// ─── Events ──────────────────────────────────────────────────

export type AgentEvent =
  | {
      type: "user_message";
      sessionId: string;
      text: string;
      modality: "text" | "voice" | "image";
    }
  | {
      type: "tool_callback";
      sessionId: string;
      taskId: string;
      result: ToolResult;
    }
  | {
      type: "approval_callback";
      sessionId: string;
      taskId: string;
      approved: boolean;
      decidedBy?: string;
    }
  | { type: "webhook"; sessionId: string; source: string; payload: unknown }
  | { type: "cron"; taskType: string; payload?: unknown };

// ─── Messages ────────────────────────────────────────────────

export interface Message {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

// ─── Task & Plan ─────────────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "running"
  | "waiting_tool"
  | "waiting_clarification"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "escalated"
  | "aborted";

export interface TaskPlan {
  steps: PlanStep[];
  reasoning: string;
  replanCount: number;
  createdAt: string;
}

export interface StepResult {
  iteration: number;
  action: OrchestrationAction;
  toolName: string | null;
  toolParams: Record<string, unknown> | null;
  toolResult: ToolResult | null;
  confidence: number;
  reasoning: string;
  costUsd: number;
  latencyMs: number;
  timestamp: string;
}

export interface TaskState {
  taskId: string;
  sessionId: string;
  status: TaskStatus;
  plan: TaskPlan | null;
  steps: StepResult[];
  totalCostUsd: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

// ─── Run State (ephemeral, per-iteration) ────────────────────

export interface RunState {
  iteration: number;
  totalCostUsd: number;
  startTime: number;
  replanCount: number;
  /** Total tool calls made in this task (for maxToolCallsPerTask guard) */
  toolCallCount: number;
  /** Last N steps for guard checks */
  recentSteps: StepResult[];
}

// ─── Brain Interface ─────────────────────────────────────────

/**
 * The brain decides, the agent executes.
 *
 * Any MSM Pipeline satisfies this interface, but you can also
 * wrap an HTTP endpoint, a mock brain, or any other implementation.
 */
export interface Brain {
  run(input: {
    raw: string;
    modality: "text" | "voice" | "image";
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    tool_results?: ToolResult[];
  }): Promise<MSMPayload>;
}

// ─── Guard Signals ───────────────────────────────────────────

export type GuardSignal =
  | {
      type: "confidence_low";
      confidence: number;
      threshold: number;
      action: "clarify";
    }
  | { type: "repetition"; toolName: string; count: number }
  | { type: "dead_end"; failureCount: number; toolCount: number }
  | { type: "budget_cost"; totalCost: number; cap: number }
  | { type: "budget_time"; elapsedMs: number; cap: number }
  | { type: "budget_iterations"; iteration: number; max: number }
  | { type: "budget_tool_calls"; toolCallCount: number; max: number }
  | { type: "rate_limited"; toolName: string; retryAfterMs: number }
  | { type: "aborted"; taskId: string; reason: string };

// ─── Response Format ──────────────────────────────────────────

/** Structured response format for rich channel delivery (buttons, lists, carousels) */
export interface ResponseFormat {
  type: "text" | "list" | "buttons" | "carousel" | "confirmation";
  items?: Array<{
    id: string;
    title: string;
    titleAr?: string;
    subtitle?: string;
    image?: string;
  }>;
  fields?: Array<{ label: string; value: string }>;
  actions?: string[];
}

// ─── Loop Result ─────────────────────────────────────────────

export type LoopOutcome =
  | {
      type: "response";
      text: string;
      textAr?: string;
      language: string;
      payload: MSMPayload;
      /** Evidence chain from tool executions (if any occurred) */
      evidence?: ResponseEvidence[];
      /** Customer-visible receipts for destructive operations */
      receipts?: ActionReceipt[];
      /** Structured response format for rich channel rendering */
      responseFormat?: ResponseFormat;
    }
  | { type: "escalated"; reason: string; payload: MSMPayload }
  | {
      type: "clarification";
      question: string;
      questionAr?: string;
      payload: MSMPayload;
      /** Task ID to resume when clarification is answered */
      taskId?: string;
    }
  | {
      type: "waiting_approval";
      taskId: string;
      toolName: string;
      toolParams: Record<string, unknown>;
      reasoning: string;
      payload: MSMPayload;
    }
  | { type: "delegated"; targetRole: string; payload: MSMPayload }
  | { type: "error"; error: string; payload?: MSMPayload }
  | { type: "aborted"; taskId: string; reason: string }
  | { type: "custom"; action: string; payload: MSMPayload };

// ─── Agent Handle ────────────────────────────────────────────

export interface AgentHandle {
  /** Process a single event and return the outcome */
  handleEvent(event: AgentEvent): Promise<LoopOutcome>;
  /** Start listening for events (EventAdapter.start()) */
  start(): Promise<void>;
  /** Stop listening for events */
  stop(): Promise<void>;
}

// ─── Audit Trail ─────────────────────────────────────────────

/** Customer-visible confirmation of a tool execution */
export interface ActionReceipt {
  action: string;
  reference: string;
  summary: string;
  timestamp: string;
}

/** Internal evidence linking tool call → result for observability */
export interface ResponseEvidence {
  toolName: string;
  toolParams: Record<string, unknown>;
  toolResult: Record<string, unknown>;
  costUsd: number;
  latencyMs: number;
  timestamp: string;
}

// ─── Control Commands ────────────────────────────────────────

export type ControlCommand =
  | { type: "pause_tenant"; tenantId: string; reason: string }
  | { type: "resume_tenant"; tenantId: string }
  | { type: "kill_task"; taskId: string; reason: string }
  | { type: "disable_tool"; toolName: string; reason: string }
  | { type: "enable_tool"; toolName: string };
