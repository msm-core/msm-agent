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

import type {
  Brain,
  BrainPayload,
  BrainRunInput,
  PlanStep,
  StreamChunk,
} from "../core/types.js";
import type { ToolDefinition } from "../adapters/tools.js";
import { STANDARD_ACTIONS } from "../core/types.js";
import { AGENT_META_TOOL, resolveAgentMeta } from "./agent-meta.js";

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
  /**
   * When true, the brain makes an upfront planning call on the first iteration
   * to generate a multi-step plan before executing. The plan is returned in
   * `orchestration.plan` and tracked by the loop throughout the task.
   * @default false
   */
  usePlanning?: boolean;
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

/** Generate an upfront execution plan via a dedicated JSON call (internal). */
async function generateOpenAIPlan(
  baseUrl: string,
  apiKey: string,
  model: string,
  userRequest: string,
): Promise<PlanStep[]> {
  const planBody = {
    model,
    messages: [
      {
        role: "system",
        content:
          'You produce execution plans. Given a user request, respond ONLY with a valid JSON object:\n{"plan":[{"id":1,"description":"…","tool_hint":"tool_name_or_null"}]}\nUse tool_hint as the relevant function name if a tool call is expected, otherwise null. Limit to 6 steps.',
      },
      { role: "user", content: userRequest },
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  };

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(planBody),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];

    const data = (await res.json()) as OpenAIResponse;
    const content = data.choices?.[0]?.message?.content ?? "{}";
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

export function createOpenAIBrain(opts: OpenAIBrainOptions): Brain {
  const baseUrl = opts.baseUrl ?? "https://api.openai.com";

  return {
    async run(input): Promise<BrainPayload> {
      // Planning pre-call — first iteration only, when usePlanning is enabled
      let upfrontPlan: PlanStep[] | undefined;
      if (
        opts.usePlanning &&
        (!input.tool_results || input.tool_results.length === 0)
      ) {
        upfrontPlan = await generateOpenAIPlan(
          baseUrl,
          opts.apiKey,
          opts.model,
          input.raw,
        );
        if (upfrontPlan.length === 0) upfrontPlan = undefined;
      }

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

      // Inject tool results from last iteration.
      // Gemini's OpenAI-compat API requires the preceding assistant tool_calls
      // message to resolve function_response.name — inject a synthetic one.
      if (input.tool_results && input.tool_results.length > 0) {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: input.tool_results.map((tr) => ({
            id: tr.tool,
            type: "function",
            function: { name: tr.tool, arguments: "{}" },
          })),
        } as unknown as OpenAIMessage);
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

      // Attach tool definitions — always include agent_meta for explicit signalling
      const allTools = [...(opts.tools ?? []), AGENT_META_TOOL];
      body.tools = allTools.map((t) => ({
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

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
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

        // agent_meta signals (clarify / escalate / delegate)
        if (tc.function.name === "agent_meta") {
          const resolved = resolveAgentMeta(
            String(params["action"] ?? ""),
            String(params["message"] ?? ""),
          );
          if (resolved) return resolved;
        }

        return {
          orchestration: {
            action: STANDARD_ACTIONS.USE_TOOL,
            confidence: 0.9,
            tool_name: tc.function.name,
            tool_params: params,
            ...(upfrontPlan ? { plan: upfrontPlan } : {}),
          },
        };
      }

      // ── Text response ─────────────────────────────────────
      const text = choice.message.content ?? "";

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

    async *stream(input: BrainRunInput): AsyncIterable<StreamChunk> {
      const systemContent = opts.promptBuilder
        ? opts.promptBuilder(input)
        : opts.systemPrompt;
      const messages: OpenAIMessage[] = [
        { role: "system", content: systemContent },
      ];
      for (const h of input.history ?? []) {
        messages.push({ role: h.role, content: h.content });
      }
      if (input.tool_results && input.tool_results.length > 0) {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: input.tool_results.map((tr) => ({
            id: tr.tool,
            type: "function",
            function: { name: tr.tool, arguments: "{}" },
          })),
        } as unknown as OpenAIMessage);
        for (const tr of input.tool_results) {
          messages.push({
            role: "tool",
            content: JSON.stringify(tr.result),
            tool_call_id: tr.tool,
          });
        }
      }
      messages.push({ role: "user", content: input.raw });

      const allTools = [...(opts.tools ?? []), AGENT_META_TOOL];
      const body: Record<string, unknown> = {
        model: opts.model,
        messages,
        temperature: opts.temperature ?? 0.3,
        stream: true,
        tools: allTools.map((t) => ({
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
        })),
        tool_choice: "auto",
      };

      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`OpenAI stream error ${res.status}: ${errText}`);
      }

      let accumulated = "";
      let toolName = "";
      let toolArgs = "";
      let toolId = "";

      for await (const line of readSSELines(res.body)) {
        if (line === "data: [DONE]") break;
        if (!line.startsWith("data: ")) continue;
        let data: {
          choices?: Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
          }>;
        };
        try {
          data = JSON.parse(line.slice(6)) as typeof data;
        } catch {
          continue;
        }
        const delta = data.choices?.[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          accumulated += delta.content;
          yield { type: "delta", text: delta.content };
        }
        const tc = delta.tool_calls?.[0];
        if (tc) {
          if (tc.id) toolId = tc.id;
          if (tc.function?.name) toolName += tc.function.name;
          if (tc.function?.arguments) toolArgs += tc.function.arguments;
        }
      }

      if (toolName) {
        let params: Record<string, unknown> = {};
        try {
          params = JSON.parse(toolArgs) as Record<string, unknown>;
        } catch {
          /* leave empty */
        }

        // agent_meta signals
        if (toolName === "agent_meta") {
          const resolved = resolveAgentMeta(
            String(params["action"] ?? ""),
            String(params["message"] ?? ""),
          );
          if (resolved) {
            yield { type: "tool_call", name: toolName, params };
            yield { type: "done", payload: resolved };
            return;
          }
        }

        yield { type: "tool_call", name: toolName, params };
        yield {
          type: "done",
          payload: {
            orchestration: {
              action: STANDARD_ACTIONS.USE_TOOL,
              confidence: 0.9,
              tool_name: toolName,
              tool_params: params,
            },
          },
        };
      } else {
        yield {
          type: "done",
          payload: {
            orchestration: {
              action: STANDARD_ACTIONS.RESPOND,
              confidence: 0.95,
            },
            generation: { response_text: accumulated },
            final_output: { text: accumulated, language: "en" },
          },
        };
      }
      void toolId; // used in request, acknowledged here
    },
  };
}

/** Read Server-Sent Event lines from a fetch Response body. */
async function* readSSELines(
  body: ReadableStream<Uint8Array> | null,
): AsyncIterable<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) yield line;
      }
    }
    if (buffer.trim()) yield buffer;
  } finally {
    reader.releaseLock();
  }
}
