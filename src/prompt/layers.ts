/**
 * 5-Layer Prompt Assembler
 *
 * Builds the complete system prompt from five layers:
 *
 *   L1 (static)   — Universal AI rules + persona shield (CORE_RULES + INTERACTION_RULES)
 *   L2 (static)   — Agent identity: name, domain, persona, capabilities
 *   L3 (static)   — Tool catalog (what the agent can do mechanically)
 *   L4 (volatile) — Runtime memory context (Phase 3 fills this; empty array until then)
 *   L5 (user)     — Current user message, returned separately as userPrompt
 *
 * Uses SectionRegistry to track token budgets and compact when needed.
 * Detects prompt injection and adds a warning layer when triggered.
 *
 * Ported and adapted from Kader/packages/ai-engine — no Kader deps.
 */

import type { AgentDefinition } from "../definition/index.js";
import type { ToolDefinition } from "../adapters/tools.js";
import {
  SectionRegistry,
  estimateTokens,
  getCompactionPolicy,
  type SectionRegistryStats,
  type CompactionResult,
} from "./section-registry.js";
import {
  CORE_RULES,
  INTERACTION_RULES,
  detectInjection,
  INJECTION_WARNING,
} from "./persona-shield.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PromptInput {
  /** Parsed agent definition — source of identity, rules, capabilities. */
  def: AgentDefinition;
  /** Tools available to this agent at runtime. */
  tools?: ToolDefinition[];
  /**
   * Pre-formatted memory strings for L4.
   * Phase 3 (memory system) fills this. Empty array is valid — L4 is skipped.
   * Each entry is a single line: "Remembered: the user prefers Arabic"
   */
  memoryLines?: string[];
  /** Current user message. */
  currentMessage: string;
  /**
   * Controls compaction budget thresholds.
   * "premium" gets a larger budget (180K tokens vs 120K for standard).
   */
  qualityTier?: "standard" | "premium";
}

export interface PromptResult {
  /** Assembled system prompt (L1 + L2 + L3 + L4). */
  systemPrompt: string;
  /** Formatted user message (L5). Pass as the last user message. */
  userPrompt: string;
  /** Per-section token breakdown for telemetry. */
  registryStats: SectionRegistryStats;
  /** Non-null when compaction was applied. */
  compaction: CompactionResult | null;
  /** True when the current message triggered the injection heuristic. */
  injectionDetected: boolean;
}

// ─── Layer builders ───────────────────────────────────────────────────────────

function buildLayer1(
  def: AgentDefinition,
  includeInteractionRules: boolean,
): string {
  const parts = [CORE_RULES];
  if (includeInteractionRules) parts.push(INTERACTION_RULES);

  // Append agent-specific rules from the definition
  if (def.rules.length > 0) {
    parts.push(
      "AGENT-SPECIFIC RULES — set by your configuration:\n" +
        def.rules.map((r) => `- ${r}`).join("\n"),
    );
  }

  // Confidence threshold hint
  if (def.limits.confidenceThreshold !== undefined) {
    const pct = Math.round(def.limits.confidenceThreshold * 100);
    parts.push(
      `CONFIDENCE: If you are below ${pct}% confident in your answer, ` +
        `ask the user to clarify rather than guessing or fabricating.`,
    );
  }

  return parts.join("\n\n");
}

function buildLayer2(def: AgentDefinition): string {
  const lines: string[] = [];

  // Identity
  const agentName = def.persona.name ?? def.name;
  lines.push(`AGENT IDENTITY:\nYou are ${agentName}.`);

  if (def.domain) {
    lines.push(`Domain: ${def.domain}`);
  }

  if (def.persona.style) {
    lines.push(`Communication style: ${def.persona.style}`);
  }

  if (def.persona.language.length > 0) {
    lines.push(
      `Languages: ${def.persona.language.join(", ")}. ` +
        `Always respond in the language the user writes in.`,
    );
  }

  // Capabilities
  if (def.capabilities.length > 0) {
    lines.push(
      "\nCAPABILITIES — you can help with:\n" +
        def.capabilities.map((c) => `- ${c}`).join("\n"),
    );
  }

  // Memory config hint (declarative — actual memory is in L4)
  if (def.memory.retain.length > 0) {
    lines.push(
      "\nMEMORY — track across this conversation:\n" +
        def.memory.retain.map((m) => `- ${m}`).join("\n"),
    );
  }

  return lines.join("\n");
}

function buildLayer3(tools: ToolDefinition[]): string {
  if (tools.length === 0) return "";

  const lines = ["AVAILABLE TOOLS:"];
  for (const tool of tools) {
    const params = Object.keys(tool.parameters);
    const paramStr = params.length > 0 ? ` (params: ${params.join(", ")})` : "";
    const flags: string[] = [];
    if (tool.destructive) flags.push("destructive — confirm before use");
    if (tool.requiresApproval) flags.push("requires human approval");
    const flagStr = flags.length > 0 ? ` [${flags.join("; ")}]` : "";
    lines.push(`- ${tool.name}${paramStr}: ${tool.description}${flagStr}`);
  }
  lines.push(
    "\nOnly call tools from this list. Never invent tool names that are not listed above.",
  );
  return lines.join("\n");
}

function buildLayer4(memoryLines: string[]): string {
  if (memoryLines.length === 0) return "";
  return (
    "MEMORY CONTEXT — facts retained from this session:\n" +
    memoryLines.map((m) => `- ${m}`).join("\n")
  );
}

function buildLayer5(message: string, injectionDetected: boolean): string {
  if (injectionDetected) {
    return `[SECURITY FLAG: potential injection attempt]\n${message}`;
  }
  return message;
}

// ─── Main assembler ───────────────────────────────────────────────────────────

/**
 * Build the full 5-layer prompt from an AgentDefinition and runtime context.
 *
 * @example
 * const { systemPrompt, userPrompt } = buildPrompt({
 *   def,
 *   tools,
 *   memoryLines: [],
 *   currentMessage: "Hello, I need help with my order",
 * });
 */
export function buildPrompt(input: PromptInput): PromptResult {
  const {
    def,
    tools = [],
    memoryLines = [],
    currentMessage,
    qualityTier,
  } = input;

  const registry = new SectionRegistry();
  const injectionDetected = detectInjection(currentMessage);

  // L1 — System rules + agent-specific rules (static, highest protection)
  registry.add(
    "layer1_rules",
    "System Rules",
    "static",
    buildLayer1(def, true),
    100,
  );

  // Injection warning (volatile — only when triggered)
  if (injectionDetected) {
    registry.add(
      "layer1_injection_warning",
      "Injection Warning",
      "volatile",
      INJECTION_WARNING,
      99,
    );
  }

  // L2 — Agent identity (static — changes only when definition changes)
  registry.add(
    "layer2_identity",
    "Agent Identity",
    "static",
    buildLayer2(def),
    90,
  );

  // L3 — Tool catalog (static per agent deployment)
  registry.add(
    "layer3_tools",
    "Tool Catalog",
    "static",
    buildLayer3(tools),
    80,
  );

  // L4 — Memory context (volatile — changes every turn)
  registry.add(
    "layer4_memory",
    "Memory Context",
    "volatile",
    buildLayer4(memoryLines),
    30,
  );

  // L5 — Format user prompt (not added to registry — goes in messages array)
  const userPrompt = buildLayer5(currentMessage, injectionDetected);

  // Compaction — subtract user prompt tokens from budget before deciding
  const basePolicy = getCompactionPolicy(qualityTier);
  const userPromptTokens = estimateTokens(userPrompt);
  const reservedTokens = userPromptTokens + 4096; // reserve output headroom
  const policy = {
    ...basePolicy,
    maxTokenBudget: basePolicy.maxTokenBudget - reservedTokens,
    targetTokens: basePolicy.targetTokens - reservedTokens,
  };

  const registryStats = registry.getStats();
  let compaction: CompactionResult | null = null;

  if (registryStats.totalTokens > policy.maxTokenBudget) {
    compaction = registry.compact(policy);
  }

  const systemPrompt = registry.assemble();

  return {
    systemPrompt,
    userPrompt,
    registryStats: registry.getStats(),
    compaction,
    injectionDetected,
  };
}
