/**
 * Ollama Brain
 *
 * Wraps the Ollama local API as an agent Brain.
 * Uses native fetch — no extra dependency.
 *
 * Ollama exposes an OpenAI-compatible API at /api/chat.
 * This implementation uses that endpoint for consistency.
 *
 * Default endpoint: http://localhost:11434
 * Override via: OLLAMA_ENDPOINT env var or options.endpoint
 */

import type { Brain, BrainPayload } from "../core/types.js";
import { STANDARD_ACTIONS } from "../core/types.js";

export interface OllamaBrainOptions {
  model: string;
  systemPrompt: string;
  /** Ollama base URL (default: http://localhost:11434) */
  endpoint?: string;
  /** Temperature (default: 0.3) */
  temperature?: number;
  /** Optional per-turn system prompt builder. Overrides the static systemPrompt. */
  promptBuilder?: (input: Parameters<Brain["run"]>[0]) => string;
}

interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OllamaResponse {
  message?: { role: string; content: string };
  error?: string;
}

export function createOllamaBrain(opts: OllamaBrainOptions): Brain {
  const base = opts.endpoint ?? "http://localhost:11434";

  return {
    async run(input): Promise<BrainPayload> {
      const systemContent = opts.promptBuilder
        ? opts.promptBuilder(input)
        : opts.systemPrompt;
      const messages: OllamaMessage[] = [
        { role: "system", content: systemContent },
      ];

      for (const h of input.history ?? []) {
        messages.push({ role: h.role, content: h.content });
      }

      // Inline tool results as assistant context
      if (input.tool_results && input.tool_results.length > 0) {
        const summary = input.tool_results
          .map(
            (tr) => `Tool "${tr.tool}" returned: ${JSON.stringify(tr.result)}`,
          )
          .join("\n");
        messages.push({ role: "assistant", content: summary });
      }

      messages.push({ role: "user", content: input.raw });

      const res = await fetch(`${base}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: opts.model,
          messages,
          stream: false,
          options: { temperature: opts.temperature ?? 0.3 },
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama API error ${res.status}: ${text}`);
      }

      const data = (await res.json()) as OllamaResponse;

      if (data.error) {
        throw new Error(`Ollama error: ${data.error}`);
      }

      const text = data.message?.content ?? "";

      return {
        orchestration: {
          action: STANDARD_ACTIONS.RESPOND,
          confidence: 0.9,
        },
        generation: { response_text: text },
        final_output: { text, language: "en" },
      };
    },
  };
}
