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

import type { Brain, BrainPayload } from "../core/types.js";
import type { ToolDefinition } from "../adapters/tools.js";
import { STANDARD_ACTIONS } from "../core/types.js";

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

export function createAnthropicBrain(opts: AnthropicBrainOptions): Brain {
  return {
    async run(input): Promise<BrainPayload> {
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

      if (opts.tools && opts.tools.length > 0) {
        body.tools = opts.tools.map((t) => ({
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
      }

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
        return {
          orchestration: {
            action: STANDARD_ACTIONS.USE_TOOL,
            confidence: 0.9,
            tool_name: toolBlock.name,
            tool_params: toolBlock.input ?? {},
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
        },
        generation: { response_text: text },
        final_output: { text, language: "en" },
      };
    },
  };
}
