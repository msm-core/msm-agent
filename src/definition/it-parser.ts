/**
 * IntentText (.it) → AgentDefinition parser
 *
 * Reads an agent definition written in IntentText format and compiles it
 * to a validated AgentDefinition object.
 *
 * Uses @intenttext/core for parsing. In Node.js without WASM initialisation,
 * the package automatically falls back to the pure TypeScript parser.
 *
 * IMPORTANT: IntentText blocks are flat siblings, not nested under sections.
 * We track the "current section" by observing each section: block and routing
 * subsequent blocks to the appropriate accumulator.
 *
 * Expected .it file structure (sections are case-insensitive):
 *
 *   title: Support Agent
 *   summary: E-commerce customer support
 *
 *   section: Persona
 *   context: domain = "e-commerce" | language = "ar, en"
 *   prompt: Nour | style: warm, direct
 *
 *   section: Capabilities
 *   tool: answer product questions
 *   tool: check order status | to: human    ← escalation target via pipe prop
 *
 *   section: Memory
 *   memory: customer preferences
 *
 *   section: Rules
 *   policy: never fabricate order details
 *   policy: escalate | when: confidence < 0.7
 *   info: max tool calls | max: 6           ← numeric limit via max: prop
 *
 *   section: Brain
 *   model: gpt-4o-mini | provider: openai
 */

import { parseIntentTextSafe } from "@intenttext/core";
import type { IntentBlock } from "@intenttext/core";
import { AgentDefinitionSchema } from "./schema.js";
import type { AgentDefinition } from "./schema.js";

// ─── Types ───────────────────────────────────────────────────

type RawDef = {
  name?: string;
  domain?: string;
  persona: { name?: string; language: string[]; style?: string };
  capabilities: string[];
  memory: { retain: string[] };
  rules: string[];
  limits: {
    toolCalls?: number;
    iterations?: number;
    confidenceThreshold?: number;
  };
  brain?: { provider: string; model?: string; endpoint?: string };
};

// ─── Helpers ─────────────────────────────────────────────────

function str(v: string | number | undefined): string | undefined {
  return v !== undefined ? String(v) : undefined;
}

// ─── Section aliases ─────────────────────────────────────────

const SECTION_ALIASES: Record<string, string> = {
  identity: "persona",
  "can do": "capabilities",
  constraints: "rules",
  behaviour: "rules",
  behavior: "rules",
  llm: "brain",
};

function normaliseSection(raw: string): string {
  const k = raw.trim().toLowerCase();
  return SECTION_ALIASES[k] ?? k;
}

// ─── Block router (flat traversal) ───────────────────────────

function processBlock(block: IntentBlock, section: string, raw: RawDef): void {
  const props = block.properties ?? {};

  if (section === "persona") {
    if (block.type === "context") {
      // context: key = "value"
      // Note: use a single key per context: line (IntentText pipes split content).
      // For language, prefer: prompt: Name | language: ar, en
      const kvPairs = block.content.split(/\s*\|\s*/);
      for (const pair of kvPairs) {
        const m = pair.match(/^(\w+)\s*=\s*["']?([^"'|]+?)["']?\s*$/);
        if (!m) continue;
        const key = m[1].trim().toLowerCase();
        const val = m[2].trim();
        if (key === "domain") raw.domain = val;
        if (key === "language") {
          raw.persona.language = val
            .split(",")
            .map((l) => l.trim())
            .filter(Boolean);
        }
      }
    }
    if (block.type === "prompt") {
      if (block.content) raw.persona.name = block.content;
      if (props.style) raw.persona.style = String(props.style);
      if (props.language && !raw.persona.language.length) {
        raw.persona.language = String(props.language)
          .split(",")
          .map((l) => l.trim())
          .filter(Boolean);
      }
    }
    return;
  }

  if (section === "capabilities") {
    if (block.type === "tool" && block.content) {
      const cap = props.to ? `${block.content} → ${props.to}` : block.content;
      raw.capabilities.push(cap);
    }
    return;
  }

  if (section === "memory") {
    if (block.type === "memory" && block.content) {
      raw.memory.retain.push(block.content);
    }
    return;
  }

  if (section === "rules") {
    if (block.type === "policy" && block.content) {
      const rule = props.when
        ? `${block.content} when ${props.when}`
        : block.content;
      raw.rules.push(rule);
    }
    if (
      (block.type === "info" || block.type === "text") &&
      props.max !== undefined
    ) {
      const maxVal = Number(props.max);
      if (!isNaN(maxVal)) {
        const label = block.content.toLowerCase();
        if (label.includes("tool")) raw.limits.toolCalls = maxVal;
        else if (label.includes("iter")) raw.limits.iterations = maxVal;
      }
    }
    if (
      (block.type === "info" || block.type === "text") &&
      props.confidence !== undefined
    ) {
      const val = Number(props.confidence);
      if (!isNaN(val)) raw.limits.confidenceThreshold = val;
    }
    return;
  }

  if (section === "brain") {
    if (block.type === "model" && block.content) {
      raw.brain = {
        provider: str(props.provider) ?? "custom",
        model: block.content || undefined,
        endpoint: str(props.endpoint),
      };
    }
    return;
  }
}

// ─── Main parser ─────────────────────────────────────────────

export function parseItSource(source: string): AgentDefinition {
  const result = parseIntentTextSafe(source, {
    unknownKeyword: "note",
    maxBlocks: 500,
    maxLineLength: 2000,
    strict: false,
  });

  const doc = result.document;

  const raw: RawDef = {
    persona: { language: [] },
    capabilities: [],
    memory: { retain: [] },
    rules: [],
    limits: {},
  };

  // Agent name: title block > document metadata > agent metadata
  const titleBlock = doc.blocks.find((b) => b.type === "title");
  raw.name =
    titleBlock?.content ?? doc.metadata?.["title"] ?? doc.metadata?.["agent"];

  // Domain: summary block > document metadata
  const summaryBlock = doc.blocks.find((b) => b.type === "summary");
  raw.domain = summaryBlock?.content ?? doc.metadata?.["summary"];

  // Walk all blocks flat — track current section by each section: block
  let currentSection = "";
  for (const block of doc.blocks) {
    if (block.type === "section") {
      currentSection = normaliseSection(block.content);
      continue;
    }
    if (currentSection) {
      processBlock(block, currentSection, raw);
    }
  }

  return AgentDefinitionSchema.parse(raw);
}
