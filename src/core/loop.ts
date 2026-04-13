/**
 * Execution Loop — The core agent loop extracted from dalil's executeTask().
 *
 * dalil's 22-step loop simplified to the universal pattern:
 *
 *   event → context → brain → guard → dispatch:
 *     terminal (respond/escalate/clarify/delegate) → deliver → done
 *     use_tool → validate → execute → record → plan advance → loop
 *
 * dalil-specific things NOT here (pluggable via adapters instead):
 *   - WhatsApp typing indicators (DeliveryAdapter.sendTyping)
 *   - DCA approval gates (ToolAdapter + DeliveryAdapter.requestApproval)
 *   - NL auto-approve classifier (project-specific)
 *   - Multi-agent delegation chain (project-specific)
 *   - Channel-specific formatting (DeliveryAdapter)
 *   - C2 control bus (project-specific)
 *   - 5-layer memory loading (MemoryAdapter)
 */

import type { MSMPayload, ToolResult } from "msm-ai";
import { STANDARD_ACTIONS } from "msm-ai";
import type {
  AgentConfig,
  Brain,
  LoopOutcome,
  RunState,
  StepResult,
  TaskState,
  AgentEvent,
} from "./types.js";
import type { MemoryAdapter } from "../adapters/memory.js";
import type { ToolAdapter } from "../adapters/tools.js";
import type { DeliveryAdapter } from "../adapters/delivery.js";
import { checkGuards, hasHardBlock } from "./guards.js";
import { buildContext } from "./context.js";
import { createPlan, advancePlanStep, failPlanStep, canReplan, clearPlan } from "./planner.js";

export interface LoopDeps {
  brain: Brain;
  memory: MemoryAdapter;
  tools: ToolAdapter;
  delivery: DeliveryAdapter;
  config: AgentConfig;
  /** Optional: called on every iteration for observability */
  onIteration?: (state: RunState, step: StepResult) => void;
  /** Optional: called when a guard fires */
  onGuard?: (signal: import("./types.js").GuardSignal) => void;
}

/**
 * Execute a single agent event through the brain loop.
 *
 * This is the heart of the agent — the equivalent of dalil's executeTask().
 */
export async function executeEvent(
  event: AgentEvent,
  deps: LoopDeps,
): Promise<LoopOutcome> {
  const sessionId = "sessionId" in event ? event.sessionId : `cron-${Date.now()}`;
  const text = event.type === "user_message"
    ? event.text
    : event.type === "tool_callback"
      ? `Tool result received for task ${event.taskId}`
      : event.type === "webhook"
        ? `Webhook from ${event.source}`
        : `Scheduled task: ${event.taskType}`;
  const modality = event.type === "user_message" ? event.modality : "text" as const;

  // Create task
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const task: TaskState = {
    taskId,
    sessionId,
    status: "running",
    plan: null,
    steps: [],
    totalCostUsd: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    error: null,
  };
  await deps.memory.saveTask(task);

  // Record user message
  await deps.memory.addMessage(sessionId, {
    role: "user",
    content: text,
    timestamp: new Date().toISOString(),
  });

  // Initialize run state
  const state: RunState = {
    iteration: 0,
    totalCostUsd: 0,
    startTime: Date.now(),
    replanCount: 0,
    recentSteps: [],
  };

  let lastToolResult: ToolResult | undefined;
  let lastPayload: MSMPayload | undefined;

  // ─── The Loop ────────────────────────────────────────────
  while (state.iteration < deps.config.maxIterations) {
    // Send typing indicator if available
    await deps.delivery.sendTyping?.(sessionId);

    // Build context for brain
    const brainInput = await buildContext({
      sessionId,
      text,
      modality,
      memory: deps.memory,
      tools: deps.tools,
      state,
      task,
      lastToolResult,
    });

    // Call brain
    const startMs = Date.now();
    const payload = await deps.brain.run(brainInput);
    const latencyMs = Date.now() - startMs;
    lastPayload = payload;

    // Extract brain's decision from orchestration layer
    const orch = payload.orchestration;
    if (!orch) {
      return { type: "error", error: "Brain returned no orchestration output", payload };
    }

    const action = orch.action;
    const confidence = orch.confidence;
    const toolName = orch.tool_name ?? null;
    const toolParams = orch.tool_params ?? null;
    const reasoning = orch.reasoning ?? "";

    // If brain returned a plan on first call, track it
    if (orch.plan && orch.plan.length > 0 && !task.plan) {
      task.plan = createPlan(orch.plan, reasoning);
      await deps.memory.updatePlan(taskId, task.plan);
    }

    // ─── Guard Check ─────────────────────────────────────
    const signals = checkGuards(state, deps.config, action, confidence, toolName);
    for (const signal of signals) {
      deps.onGuard?.(signal);
    }

    if (hasHardBlock(signals)) {
      // Check if it's a confidence gate → convert to clarification
      const confidenceBlock = signals.find((s) => s.type === "confidence_low");
      if (confidenceBlock) {
        const clarifyText = payload.generation?.response_text
          ?? payload.final_output?.text
          ?? "Could you provide more details?";
        await finishTask(task, "waiting_clarification", deps);
        return { type: "clarification", question: clarifyText, payload };
      }

      // Budget/iteration limit → force respond with whatever we have
      const responseText = payload.final_output?.text
        ?? payload.generation?.response_text
        ?? "I was unable to complete this task within the allowed limits.";
      await finishTask(task, "completed", deps);
      return {
        type: "response",
        text: responseText,
        textAr: payload.generation?.response_text_ar,
        language: payload.final_output?.language ?? "en",
        payload,
      };
    }

    // ─── Terminal Actions ─────────────────────────────────
    if (action === STANDARD_ACTIONS.RESPOND || action === "complete") {
      const responseText = payload.final_output?.text
        ?? payload.generation?.response_text
        ?? "Done.";

      // Record step
      const step = recordStep(state, action, null, null, null, confidence, reasoning, latencyMs);
      deps.onIteration?.(state, step);

      // Record assistant message
      await deps.memory.addMessage(sessionId, {
        role: "assistant",
        content: responseText,
        timestamp: new Date().toISOString(),
      });

      await finishTask(task, "completed", deps);
      return {
        type: "response",
        text: responseText,
        textAr: payload.generation?.response_text_ar,
        language: payload.final_output?.language ?? "en",
        payload,
      };
    }

    if (action === STANDARD_ACTIONS.ESCALATE) {
      const step = recordStep(state, action, null, null, null, confidence, reasoning, latencyMs);
      deps.onIteration?.(state, step);
      await finishTask(task, "escalated", deps);
      return { type: "escalated", reason: reasoning, payload };
    }

    if (action === STANDARD_ACTIONS.CLARIFY || action === "ask_clarification") {
      const question = payload.generation?.response_text
        ?? payload.final_output?.text
        ?? "Could you clarify?";
      const step = recordStep(state, action, null, null, null, confidence, reasoning, latencyMs);
      deps.onIteration?.(state, step);
      await finishTask(task, "waiting_clarification", deps);
      return {
        type: "clarification",
        question,
        questionAr: payload.generation?.response_text_ar,
        payload,
      };
    }

    if (action === STANDARD_ACTIONS.DELEGATE) {
      const step = recordStep(state, action, null, null, null, confidence, reasoning, latencyMs);
      deps.onIteration?.(state, step);
      await finishTask(task, "completed", deps);
      return {
        type: "delegated",
        targetRole: (orch as unknown as Record<string, unknown>).delegate_to_role as string ?? "unknown",
        payload,
      };
    }

    // ─── Tool Execution ──────────────────────────────────
    if (action === STANDARD_ACTIONS.USE_TOOL || action === "use_tool") {
      if (!toolName) {
        const step = recordStep(state, action, null, null, null, confidence, "No tool name provided", latencyMs);
        deps.onIteration?.(state, step);
        // Brain said use_tool but didn't specify which — treat as error, continue
        state.iteration++;
        continue;
      }

      // Validate tool if adapter supports it
      if (deps.tools.validate) {
        const validation = deps.tools.validate(toolName, toolParams ?? {});
        if (!validation.valid) {
          const step = recordStep(
            state, action, toolName, toolParams,
            { tool: toolName, status: "failed", result: { errors: validation.errors } },
            confidence, `Validation failed: ${validation.errors.join(", ")}`, latencyMs,
          );
          deps.onIteration?.(state, step);
          state.iteration++;
          lastToolResult = step.toolResult!;
          continue;
        }
      }

      // Check approval if needed
      const toolDef = deps.tools.list().find((t) => t.name === toolName);
      if (toolDef?.requiresApproval && deps.delivery.requestApproval) {
        const approved = await deps.delivery.requestApproval(sessionId, toolName, toolParams ?? {});
        if (!approved) {
          const step = recordStep(
            state, action, toolName, toolParams,
            { tool: toolName, status: "failed", result: { reason: "Approval denied" } },
            confidence, "User denied approval", latencyMs,
          );
          deps.onIteration?.(state, step);
          state.iteration++;
          lastToolResult = step.toolResult!;
          continue;
        }
      }

      // Execute the tool
      const toolStart = Date.now();
      let toolResult: ToolResult;
      try {
        toolResult = await deps.tools.execute(toolName, toolParams ?? {});
      } catch (err) {
        toolResult = {
          tool: toolName,
          status: "failed",
          result: { error: err instanceof Error ? err.message : String(err) },
        };
      }
      const toolLatency = Date.now() - toolStart;

      // Record step
      const step = recordStep(
        state, action, toolName, toolParams, toolResult,
        confidence, reasoning, latencyMs + toolLatency,
      );
      task.steps.push(step);
      await deps.memory.addStep(taskId, step);
      deps.onIteration?.(state, step);

      // Plan management
      if (toolResult.status === "ok" && task.plan) {
        task.plan = advancePlanStep(task.plan);
        await deps.memory.updatePlan(taskId, task.plan);
      } else if (toolResult.status === "failed" && task.plan) {
        task.plan = failPlanStep(task.plan);
        if (canReplan(task.plan, deps.config.maxReplans)) {
          // Brain will replan on next iteration with failure context
          task.plan = { ...task.plan, replanCount: task.plan.replanCount + 1 };
        } else {
          // Freestyle — clear plan, let brain figure it out
          task.plan = clearPlan();
        }
        await deps.memory.updatePlan(taskId, task.plan!);
      }

      lastToolResult = toolResult;
      state.iteration++;
      continue;
    }

    // ─── Custom Action ───────────────────────────────────
    // Actions beyond the standard 5 — let the caller handle them
    const step = recordStep(state, action, null, null, null, confidence, reasoning, latencyMs);
    deps.onIteration?.(state, step);
    await finishTask(task, "completed", deps);
    return { type: "custom", action, payload };
  }

  // Loop exhausted without terminal action
  const fallbackText = lastPayload?.final_output?.text
    ?? lastPayload?.generation?.response_text
    ?? "I was unable to complete this task.";
  await finishTask(task, "completed", deps);
  return {
    type: "response",
    text: fallbackText,
    language: lastPayload?.final_output?.language ?? "en",
    payload: lastPayload!,
  };
}

// ─── Helpers ─────────────────────────────────────────────────

function recordStep(
  state: RunState,
  action: string,
  toolName: string | null,
  toolParams: Record<string, unknown> | null,
  toolResult: ToolResult | null,
  confidence: number,
  reasoning: string,
  latencyMs: number,
): StepResult {
  const step: StepResult = {
    iteration: state.iteration,
    action,
    toolName,
    toolParams,
    toolResult,
    confidence,
    reasoning,
    costUsd: 0, // TODO: track from LLM usage when available
    latencyMs,
    timestamp: new Date().toISOString(),
  };
  state.recentSteps.push(step);
  // Keep only last 10 steps in memory
  if (state.recentSteps.length > 10) {
    state.recentSteps = state.recentSteps.slice(-10);
  }
  return step;
}

async function finishTask(
  task: TaskState,
  status: TaskState["status"],
  deps: LoopDeps,
): Promise<void> {
  task.status = status;
  task.completedAt = new Date().toISOString();
  await deps.memory.updateTaskStatus(task.taskId, status);
}
