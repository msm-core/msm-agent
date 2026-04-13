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
}

export const DEFAULT_CONFIG: AgentConfig = {
  maxIterations: 6,
  maxReplans: 2,
  confidenceThreshold: 0.6,
  costCapPerTask: 0,
  timeoutMs: 0,
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
  | "completed"
  | "failed"
  | "escalated";

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
  | { type: "budget_iterations"; iteration: number; max: number };

// ─── Loop Result ─────────────────────────────────────────────

export type LoopOutcome =
  | {
      type: "response";
      text: string;
      textAr?: string;
      language: string;
      payload: MSMPayload;
    }
  | { type: "escalated"; reason: string; payload: MSMPayload }
  | {
      type: "clarification";
      question: string;
      questionAr?: string;
      payload: MSMPayload;
    }
  | { type: "delegated"; targetRole: string; payload: MSMPayload }
  | { type: "error"; error: string; payload?: MSMPayload }
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
