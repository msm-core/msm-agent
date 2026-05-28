/**
 * Brain Factory
 *
 * Creates the right Brain implementation from an AgentDefinition.
 * Reads credentials from environment variables — never from the definition file.
 *
 * Supported providers (from AgentDefinition.brain.provider):
 *   "openai"     → OpenAI Chat Completions (needs OPENAI_API_KEY)
 *   "anthropic"  → Anthropic Messages API  (needs ANTHROPIC_API_KEY)
 *   "ollama"     → Ollama local API        (needs OLLAMA_ENDPOINT or default localhost)
 *   "msm"        → Delegates to wrapMSM()  (caller must provide MSMPipeline)
 *   "custom"     → Throws — caller must supply a Brain directly to createAgent()
 */

import type { Brain } from "../core/types.js";
import type { AgentDefinition } from "../definition/index.js";
import type { ToolDefinition } from "../adapters/tools.js";
import { buildPrompt } from "../prompt/index.js";
import { createOpenAIBrain } from "./openai.js";
import { createAnthropicBrain } from "./anthropic.js";
import { createOllamaBrain } from "./ollama.js";
import { RoutingBrain } from "./routing-brain.js";

export interface BrainFactoryOptions {
  /** Available tools — passed to the brain for function calling */
  tools?: ToolDefinition[];
  /**
   * Sync memory context provider for L4 of the 5-layer prompt.
   * Called on every turn with the current user message; returns pre-formatted
   * memory lines (e.g. "[memory] User prefers Arabic").
   * Phase 3: wired by cli.ts when MEMORY_PATH is set. Empty until then.
   */
  memoryContext?: (query: string) => string[];
}

/**
 * Build a primary (non-routing) Brain from an AgentDefinition.
 * Exported so RoutingBrain setup can call it without re-entering buildBrain.
 */
export function buildDirectBrain(
  def: AgentDefinition,
  options: BrainFactoryOptions = {},
): Brain {
  const tools = options.tools ?? [];
  const promptBuilder = (input: Parameters<Brain["run"]>[0]): string =>
    buildPrompt({
      def,
      tools,
      memoryLines: options.memoryContext
        ? options.memoryContext(input.raw)
        : [],
      agentContext: input.system_context,
      currentMessage: input.raw,
      qualityTier: "standard",
    }).systemPrompt;

  const { provider, model, endpoint } = def.brain;

  switch (provider) {
    case "openai": {
      const apiKey = process.env["OPENAI_API_KEY"];
      if (!apiKey)
        throw new Error("OPENAI_API_KEY environment variable is not set");
      return createOpenAIBrain({
        apiKey,
        model: model ?? "gpt-4o-mini",
        systemPrompt: "",
        promptBuilder,
        baseUrl: process.env["OPENAI_BASE_URL"] ?? endpoint,
        tools,
      });
    }

    case "anthropic": {
      const apiKey = process.env["ANTHROPIC_API_KEY"];
      if (!apiKey)
        throw new Error("ANTHROPIC_API_KEY environment variable is not set");
      return createAnthropicBrain({
        apiKey,
        model: model ?? "claude-3-5-haiku-20241022",
        systemPrompt: "",
        promptBuilder,
        tools,
      });
    }

    case "ollama": {
      return createOllamaBrain({
        model: model ?? "llama3",
        systemPrompt: "",
        promptBuilder,
        endpoint:
          process.env["OLLAMA_ENDPOINT"] ??
          endpoint ??
          "http://localhost:11434",
      });
    }

    case "msm":
      throw new Error(
        'provider "msm" requires a pre-built MSMPipeline. ' +
          "Use wrapMSM(pipeline) and pass the result as brain to createAgent() directly.",
      );

    case "custom":
      throw new Error(
        'provider "custom" means you supply the Brain yourself. ' +
          "Pass it as brain to createAgent() directly.",
      );

    default:
      throw new Error(`Unknown brain provider: "${provider}"`);
  }
}

/**
 * Build an Arabic-capable brain variant.
 * Reads ARABIC_OLLAMA_MODEL / ARABIC_OPENAI_MODEL / ARABIC_ANTHROPIC_MODEL from env.
 * Returns undefined if no Arabic model override is configured (caller falls back to primary).
 */
export function buildArabicBrain(
  def: AgentDefinition,
  options: BrainFactoryOptions = {},
): Brain | undefined {
  const tools = options.tools ?? [];
  const promptBuilder = (input: Parameters<Brain["run"]>[0]): string =>
    buildPrompt({
      def,
      tools,
      memoryLines: options.memoryContext
        ? options.memoryContext(input.raw)
        : [],
      agentContext: input.system_context,
      currentMessage: input.raw,
      qualityTier: "standard",
    }).systemPrompt;

  const { provider, endpoint } = def.brain;

  switch (provider) {
    case "openai": {
      const arabicModel = process.env["ARABIC_OPENAI_MODEL"];
      if (!arabicModel) return undefined;
      const apiKey = process.env["OPENAI_API_KEY"];
      if (!apiKey) return undefined;
      return createOpenAIBrain({
        apiKey,
        model: arabicModel,
        systemPrompt: "",
        promptBuilder,
        baseUrl: process.env["OPENAI_BASE_URL"] ?? endpoint,
        tools,
      });
    }

    case "anthropic": {
      const arabicModel = process.env["ARABIC_ANTHROPIC_MODEL"];
      if (!arabicModel) return undefined;
      const apiKey = process.env["ANTHROPIC_API_KEY"];
      if (!apiKey) return undefined;
      return createAnthropicBrain({
        apiKey,
        model: arabicModel,
        systemPrompt: "",
        promptBuilder,
        tools,
      });
    }

    case "ollama": {
      const arabicModel = process.env["ARABIC_OLLAMA_MODEL"] ?? "jais";
      return createOllamaBrain({
        model: arabicModel,
        systemPrompt: "",
        promptBuilder,
        endpoint:
          process.env["OLLAMA_ENDPOINT"] ??
          endpoint ??
          "http://localhost:11434",
      });
    }

    default:
      return undefined;
  }
}

/**
 * Build a Brain from an AgentDefinition.
 * Credentials are read from environment variables.
 *
 * When def.brain.language is "arabic", "ar", or "auto", returns a RoutingBrain
 * that selects the arabic-capable brain for Arabic input automatically.
 *
 * @throws if the provider requires credentials that are not set
 * @throws if provider is "custom" (caller must supply a Brain themselves)
 */
export function buildBrain(
  def: AgentDefinition,
  options: BrainFactoryOptions = {},
): Brain {
  const lang = def.brain?.language;

  if (lang === "arabic" || lang === "ar" || lang === "auto") {
    const primary = buildDirectBrain(def, options);
    const arabic = buildArabicBrain(def, options);
    return new RoutingBrain(primary, arabic);
  }

  return buildDirectBrain(def, options);
}

// ─── Legacy inline switch kept below for reference (replaced by buildDirectBrain) ─

function _legacyBuildBrain_unused(
  def: AgentDefinition,
  options: BrainFactoryOptions,
): Brain {
  const tools = options.tools ?? [];
  const promptBuilder = (input: Parameters<Brain["run"]>[0]): string =>
    buildPrompt({
      def,
      tools,
      memoryLines: options.memoryContext
        ? options.memoryContext(input.raw)
        : [],
      currentMessage: input.raw,
      qualityTier: "standard",
    }).systemPrompt;

  const { provider, model, endpoint } = def.brain;

  switch (provider) {
    case "openai":
      return createOpenAIBrain({
        apiKey: "",
        model: model ?? "",
        systemPrompt: "",
        promptBuilder,
        tools,
      });
    default:
      throw new Error(`Legacy stub — should not be called`);
  }
}
