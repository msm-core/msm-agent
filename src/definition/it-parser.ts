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
import type { AgentDefinition, EquipmentConnector } from "./schema.js";
import { parseDays } from "../core/gates.js";

// ─── Types ───────────────────────────────────────────────────

type RawHours = {
  timezone: string;
  schedule: Array<{ days: ReturnType<typeof parseDays>; from: string; to: string }>;
  closedMessage?: string;
  closedMessageAr?: string;
};

type RawConnector = Partial<EquipmentConnector> & {
  credentialType?: string;
  credentialValue?: string;
  credentialHeader?: string;
};

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
    costCap?: number;
  };
  brain?: { provider: string; model?: string; endpoint?: string; language?: string };
  skills: string[];
  hours?: RawHours;
  equipment?: {
    connectors: EquipmentConnector[];
    channels: string[];
    dedicatedTools: string[];
  };
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
  model: "brain",
  "business hours": "hours",
  "working hours": "hours",
  "opening hours": "hours",
};

function normaliseSection(raw: string): string {
  const k = raw.trim().toLowerCase();
  return SECTION_ALIASES[k] ?? k;
}

// ─── Block router (flat traversal) ───────────────────────────

function processBlock(block: IntentBlock, section: string, raw: RawDef): void {
  const props = block.properties ?? {};

  // ── v3.5.0: custom-key blocks (non-reserved keywords) ──────
  // Route custom blocks by their preserved keyword before falling through
  // to section-based handling. This covers hours:, skill:, connector:, etc.
  if (block.type === "custom") {
    const kw = String(props.keyword ?? "").toLowerCase();

    // hours: Asia/Kuwait | Mon-Fri: 09:00-18:00 | Sat: 10:00-14:00
    if (kw === "hours" && section === "hours") {
      applyHoursBlock(block, raw);
      return;
    }
    // skill: booking
    if (kw === "skill" && section === "skills") {
      if (block.content) raw.skills.push(block.content.trim());
      return;
    }
    // connector: shopify | operations: orders.list | access: read | endpoint: ...
    if (kw === "connector" && section === "equipment") {
      applyConnectorBlock(block, raw);
      return;
    }
    // credential: api_key | value: ${KEY}
    if (kw === "credential" && section === "equipment") {
      applyCredentialBlock(block, raw);
      return;
    }
    // Unrecognised custom block — ignore silently
    return;
  }

  if (section === "persona") {
    if (block.type === "context") {
      // context: key = "value"
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
    if (block.type === "info" || block.type === "text") {
      applyInfoLimit(block, raw);
    }
    return;
  }

  if (section === "limits") {
    if (block.type === "info" || block.type === "text") {
      applyInfoLimit(block, raw);
    }
    return;
  }

  if (section === "brain") {
    if (block.type === "model" && block.content) {
      raw.brain = {
        provider: str(props.provider) ?? "custom",
        model: block.content || undefined,
        endpoint: str(props.endpoint),
        language: str(props.language),
      };
    }
    return;
  }

  if (section === "hours") {
    // text: block following hours: → closed message
    if (block.type === "text" && block.content) {
      if (!raw.hours) raw.hours = { timezone: "UTC", schedule: [] };
      const langProp = str(props.lang ?? props.language ?? "");
      if (langProp === "ar") {
        raw.hours.closedMessageAr = block.content;
      } else {
        raw.hours.closedMessage = block.content;
      }
    }
    return;
  }

  if (section === "skills") {
    // Fallback for when skill keyword not preserved (older @intenttext/core)
    if (block.type === "text" && block.content) {
      // content may be space-joined: "booking payments" — split it
      const names = block.content.split(/\s+/).filter(Boolean);
      raw.skills.push(...names);
    }
    return;
  }

  if (section === "equipment") {
    // text: block in equipment with connector-like properties (older @intenttext/core)
    if (block.type === "text" && block.content) {
      applyConnectorBlock(block, raw);
    }
    return;
  }
}

// ─── Hours helpers ────────────────────────────────────────────

/**
 * Parse an hours: block.
 * With v3.5.0:  { type: "custom", properties.keyword: "hours",
 *                 content: "Asia/Kuwait", "Mon-Fri": "09:00-18:00", ... }
 * Older fallback: { type: "text", content: "",
 *                   properties: { timezone: "Asia/Kuwait", "Mon-Fri": "09:00-18:00" } }
 */
function applyHoursBlock(block: IntentBlock, raw: RawDef): void {
  const props = block.properties ?? {};
  if (!raw.hours) raw.hours = { timezone: "UTC", schedule: [] };

  // Timezone: content of the block (v3.5.0) or timezone property (fallback)
  const tz =
    block.content?.trim() ||
    str(props["timezone"] ?? props["tz"]) ||
    "UTC";
  raw.hours.timezone = tz;

  // Schedule: all remaining properties that look like day ranges
  for (const [key, val] of Object.entries(props)) {
    if (key === "keyword" || key === "timezone" || key === "tz") continue;
    const timeRange = String(val).match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (!timeRange) continue;
    const days = parseDays(key);
    if (days.length > 0) {
      raw.hours.schedule.push({ days, from: timeRange[1]!, to: timeRange[2]! });
    }
  }
}

// ─── Equipment helpers ────────────────────────────────────────

function ensureEquipment(raw: RawDef) {
  if (!raw.equipment) {
    raw.equipment = { connectors: [], channels: [], dedicatedTools: [] };
  }
  return raw.equipment;
}

/**
 * Parse a connector: block.
 * content = connector type (e.g. "shopify")
 * properties: operations, access, endpoint, key/credentials/token, dedicatedTools
 */
function applyConnectorBlock(block: IntentBlock, raw: RawDef): void {
  const props = block.properties ?? {};
  const eq = ensureEquipment(raw);

  const connType = block.content?.trim();
  if (!connType) return;

  const conn: EquipmentConnector = {
    type: connType,
    operations: str(props["operations"])
      ? String(props["operations"]).split(",").map((o) => o.trim()).filter(Boolean)
      : [],
    access: (str(props["access"]) as EquipmentConnector["access"]) ?? "readwrite",
    endpoint: str(props["endpoint"] ?? props["url"]),
  };

  // Credential detection
  const credType = str(props["credentials"] ?? props["credentialtype"]);
  const credValue =
    str(props["key"] ?? props["apikey"] ?? props["token"] ?? props["value"] ?? props["password"]);
  const credHeader = str(props["header"] ?? props["headername"]);

  if (credValue) {
    const resolvedType = resolveCredType(credType);
    conn.credentials = {
      type: resolvedType,
      value: credValue,
      headerName: credHeader,
    };
  }

  // Dedicated tools for this connector
  const dedicated = str(props["dedicatedtools"] ?? props["tools"]);
  if (dedicated) {
    eq.dedicatedTools.push(
      ...dedicated.split(",").map((t) => t.trim()).filter(Boolean),
    );
  }

  eq.connectors.push(conn);
}

/**
 * Parse a credential: block attached to the last connector.
 * credential: api_key | value: ${KEY} | header: X-API-Key
 */
function applyCredentialBlock(block: IntentBlock, raw: RawDef): void {
  const props = block.properties ?? {};
  const eq = ensureEquipment(raw);
  const last = eq.connectors[eq.connectors.length - 1];
  if (!last) return; // no connector to attach to

  const credType = resolveCredType(block.content?.trim() || str(props["type"]));
  const credValue = str(props["value"] ?? props["key"] ?? props["token"]);
  if (!credValue) return;

  last.credentials = {
    type: credType,
    value: credValue,
    headerName: str(props["header"] ?? props["headername"]),
  };
}

function resolveCredType(
  raw: string | undefined,
): "api_key" | "bearer" | "basic" {
  switch ((raw ?? "").toLowerCase()) {
    case "bearer":
    case "token":
      return "bearer";
    case "basic":
    case "password":
      return "basic";
    default:
      return "api_key";
  }
}

// ─── Limits helper ────────────────────────────────────────────

function applyInfoLimit(block: IntentBlock, raw: RawDef): void {
  const props = block.properties ?? {};
  const label = block.content.toLowerCase();

  if (props.max !== undefined) {
    const maxVal = Number(props.max);
    if (!isNaN(maxVal)) {
      if (label.includes("tool")) raw.limits.toolCalls = maxVal;
      else raw.limits.iterations = maxVal; // iterations, max iterations, etc.
    }
  }
  if (props.confidence !== undefined) {
    const val = Number(props.confidence);
    if (!isNaN(val)) raw.limits.confidenceThreshold = val;
  }
  if (props.cost !== undefined) {
    const val = Number(props.cost);
    if (!isNaN(val)) raw.limits.costCap = val;
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
    skills: [],
  };

  // Agent name: title block > document metadata > agent metadata
  const titleBlock = doc.blocks.find((b) => b.type === "title");
  raw.name =
    titleBlock?.content ?? doc.metadata?.["title"] ?? doc.metadata?.["agent"];

  // Domain: summary block > document metadata
  const summaryBlock = doc.blocks.find((b) => b.type === "summary");
  raw.domain = summaryBlock?.content ?? doc.metadata?.["summary"];

  // Walk all blocks — v3.5.0 nests section children inside block.children,
  // older versions emitted flat siblings. Support both layouts.
  let currentSection = "";
  for (const block of doc.blocks) {
    if (block.type === "section") {
      currentSection = normaliseSection(block.content);
      // v3.5.0: section children are nested inside block.children
      for (const child of (block as { children?: IntentBlock[] }).children ?? []) {
        processBlock(child, currentSection, raw);
      }
      continue;
    }
    // Flat siblings (older @intenttext/core) or top-level blocks outside sections
    if (currentSection) {
      processBlock(block, currentSection, raw);
    }
  }

  return AgentDefinitionSchema.parse({
    name: raw.name,
    domain: raw.domain,
    persona: raw.persona,
    capabilities: raw.capabilities,
    memory: raw.memory,
    rules: raw.rules,
    limits: raw.limits,
    brain: raw.brain,
    skills: raw.skills,
    hours: raw.hours,
    equipment: raw.equipment,
  });
}
