/**
 * OpenAI Brain
 *
 * Wraps the OpenAI Chat Completions API as an agent Brain.
 * Uses native fetch — no openai SDK dependency.
 *
 * Supports:
 *  - Text response (respond action)
 *  - Tool selection via OpenAI function calling (use_tool action)
 *
 * Required env: OPENAI_API_KEY
 * Optional env: OPENAI_BASE_URL (for proxies or Azure OpenAI)
 */

import type { Brain, BrainPayload } from "../core/types.js";
import type { ToolDefinition } from "../adapters/tools.js";
import { STANDARD_ACTIONS } from "../core/types.js";

export interface OpenAIBrainOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  baseUrl?: string;
  /** Available tools — if provided, enables function calling */
  tools?: ToolDefinition[];
  /** Temperature (default: 0.3 — factual, low creativity) */
  temperature?: number;
  /**
   * Optional per-turn system prompt builder.
   * When provided, called on every run() with the current input to produce
   * the system prompt dynamically (enables 5-layer prompt with live memory).
   * Overrides the static systemPrompt.
   */
  promptBuilder?: (input: Parameters<Brain["run"]>[0]) => string;
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIChoice {
  message: {
    role: string;
    content: string | null;
    tool_calls?: OpenAIToolCall[];
  };
  finish_reason: string;
}

interface OpenAIResponse {
  choices: OpenAIChoice[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  error?: { message: string; type: string };
}

export function createOpenAIBrain(opts: OpenAIBrainOptions): Brain {
  const baseUrl = opts.baseUrl ?? "https://api.openai.com";

  return {
    async run(input): Promise<BrainPayload> {
      const systemContent = opts.promptBuilder
        ? opts.promptBuilder(input)
        : opts.systemPrompt;
      const messages: OpenAIMessage[] = [
        { role: "system", content: systemContent },
      ];

      // Conversation history
      for (const h of input.history ?? []) {
        messages.push({ role: h.role, content: h.content });
      }

      // Inject tool results from last iteration
      if (input.tool_results && input.tool_results.length > 0) {
        for (const tr of input.tool_results) {
          messages.push({
            role: "tool",
            content: JSON.stringify(tr.result),
            tool_call_id: tr.tool,
          });
        }
      }

      messages.push({ role: "user", content: input.raw });

      // Build request body
      const body: Record<string, unknown> = {
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0.3,
      };

      // Attach tool definitions if provided
      if (opts.tools && opts.tools.length > 0) {
        body.tools = opts.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: {
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
          },
        }));
        body.tool_choice = "auto";
      }

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`OpenAI API error ${res.status}: ${text}`);
      }

      const data = (await res.json()) as OpenAIResponse;

      if (data.error) {
        throw new Error(`OpenAI error: ${data.error.message}`);
      }

      const choice = data.choices[0];
      if (!choice) throw new Error("OpenAI returned no choices");

      // ── Tool call response ────────────────────────────────
      if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
        const tc = choice.message.tool_calls[0];
        let params: Record<string, unknown> = {};
        try {
          params = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          // leave empty if unparseable
        }

        return {
          orchestration: {
            action: STANDARD_ACTIONS.USE_TOOL,
            confidence: 0.9,
            tool_name: tc.function.name,
            tool_params: params,
          },
        };
      }

      // ── Text response ─────────────────────────────────────
      const text = choice.message.content ?? "";

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
