/**
 * Anthropic Brain
 *
 * Wraps the Anthropic Messages API as an agent Brain.
 * Uses native fetch — no @anthropic-ai/sdk dependency.
 *
 * Supports:
 *  - Text response (respond action)
 *  - Tool selection via Anthropic tool use (use_tool action)
 *
 * Required env: ANTHROPIC_API_KEY
 */

import type { Brain, BrainPayload, PlanStep } from "../core/types.js";
import type { ToolDefinition } from "../adapters/tools.js";
import { STANDARD_ACTIONS } from "../core/types.js";
import { AGENT_META_TOOL, resolveAgentMeta } from "./agent-meta.js";

export interface AnthropicBrainOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  /** Available tools — enables Anthropic tool use */
  tools?: ToolDefinition[];
  /** Max tokens for response (default: 1024) */
  maxTokens?: number;
  /** Optional per-turn system prompt builder. Overrides the static systemPrompt. */
  promptBuilder?: (input: Parameters<Brain["run"]>[0]) => string;
  /**
   * When true, the brain makes an upfront planning call on the first iteration
   * to generate a multi-step plan before executing.
   * @default false
   */
  usePlanning?: boolean;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
}

interface AnthropicContent {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicResponse {
  content: AnthropicContent[];
  stop_reason: string;
  error?: { type: string; message: string };
}

/** Generate an upfront execution plan via a dedicated JSON call (internal). */
async function generateAnthropicPlan(
  apiKey: string,
  model: string,
  userRequest: string,
): Promise<PlanStep[]> {
  const planBody = {
    model,
    max_tokens: 512,
    system:
      'You produce execution plans. Given a user request, respond ONLY with a valid JSON object:\n{"plan":[{"id":1,"description":"…","tool_hint":"tool_name_or_null"}]}\nUse tool_hint as the relevant function name if a tool call is expected, otherwise null. Limit to 6 steps.',
    messages: [{ role: "user", content: userRequest }],
  };

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(planBody),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as AnthropicResponse;
    const textBlock = data.content?.find((b) => b.type === "text");
    const content = textBlock?.text ?? "{}";
    const parsed = JSON.parse(content) as {
      plan?: Array<{
        id?: unknown;
        description?: unknown;
        tool_hint?: unknown;
      }>;
    };
    if (!Array.isArray(parsed.plan)) return [];
    return parsed.plan
      .filter((s) => typeof s.description === "string")
      .map((s, i) => ({
        id: typeof s.id === "number" ? s.id : i + 1,
        description: String(s.description),
        tool_hint: s.tool_hint ? String(s.tool_hint) : null,
        status: "pending" as const,
      }));
  } catch {
    return [];
  }
}

export function createAnthropicBrain(opts: AnthropicBrainOptions): Brain {
  return {
    async run(input): Promise<BrainPayload> {
      // Planning pre-call — first iteration only, when usePlanning is enabled
      let upfrontPlan: PlanStep[] | undefined;
      if (
        opts.usePlanning &&
        (!input.tool_results || input.tool_results.length === 0)
      ) {
        upfrontPlan = await generateAnthropicPlan(
          opts.apiKey,
          opts.model,
          input.raw,
        );
        if (upfrontPlan.length === 0) upfrontPlan = undefined;
      }

      const systemContent = opts.promptBuilder
        ? opts.promptBuilder(input)
        : opts.systemPrompt;
      const messages: AnthropicMessage[] = [];

      // Conversation history
      for (const h of input.history ?? []) {
        messages.push({ role: h.role, content: h.content });
      }

      // Inject tool results
      if (input.tool_results && input.tool_results.length > 0) {
        const toolResults: AnthropicContent[] = input.tool_results.map(
          (tr) => ({
            type: "tool_result",
            tool_use_id: tr.tool,
            content: JSON.stringify(tr.result),
          }),
        );
        messages.push({ role: "user", content: toolResults });
      }

      messages.push({ role: "user", content: input.raw });

      const body: Record<string, unknown> = {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 1024,
        system: systemContent,
        messages,
      };

      // Always include agent_meta for explicit clarify/escalate/delegate signalling
      const allTools = [...(opts.tools ?? []), AGENT_META_TOOL];
      body.tools = allTools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(t.parameters).map(([name, p]) => [
              name,
              { type: p.type, description: p.description },
            ]),
          ),
          required: Object.entries(t.parameters)
            .filter(([, p]) => p.required)
            .map(([name]) => name),
        },
      }));

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Anthropic API error ${res.status}: ${text}`);
      }

      const data = (await res.json()) as AnthropicResponse;

      if (data.error) {
        throw new Error(`Anthropic error: ${data.error.message}`);
      }

      // ── Tool use response ─────────────────────────────────
      const toolBlock = data.content.find((b) => b.type === "tool_use");
      if (toolBlock && toolBlock.name) {
        // agent_meta signals (clarify / escalate / delegate)
        if (toolBlock.name === "agent_meta") {
          const input = toolBlock.input ?? {};
          const resolved = resolveAgentMeta(
            String(input["action"] ?? ""),
            String(input["message"] ?? ""),
          );
          if (resolved) return resolved;
        }

        return {
          orchestration: {
            action: STANDARD_ACTIONS.USE_TOOL,
            confidence: 0.9,
            tool_name: toolBlock.name,
            tool_params: toolBlock.input ?? {},
            ...(upfrontPlan ? { plan: upfrontPlan } : {}),
          },
        };
      }

      // ── Text response ─────────────────────────────────────
      const textBlock = data.content.find((b) => b.type === "text");
      const text = textBlock?.text ?? "";

      return {
        orchestration: {
          action: STANDARD_ACTIONS.RESPOND,
          confidence: 0.95,
          ...(upfrontPlan ? { plan: upfrontPlan } : {}),
        },
        generation: { response_text: text },
        final_output: { text, language: "en" },
      };
    },
  };
}
