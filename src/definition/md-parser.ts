/**
 * Markdown (.md) → AgentDefinition parser
 *
 * Parses an agent definition written as a simple Markdown document.
 * No external parser dependency — pure line scanning against a known schema.
 *
 * Expected format:
 *
 *   # Agent Name
 *
 *   Domain: E-commerce customer support
 *   Language: Arabic, English
 *
 *   ## Persona
 *   Name: Nour
 *   Style: warm, direct, solution-focused
 *
 *   ## Capabilities
 *   - answer product questions
 *   - check order status
 *   - escalate billing disputes → human
 *
 *   ## Memory
 *   - customer preferences
 *   - unresolved issues
 *
 *   ## Rules
 *   - never fabricate order details
 *   - escalate when confidence < 70%
 *   - max 6 tool calls
 *
 *   ## Brain
 *   Provider: openai
 *   Model: gpt-4o-mini
 *   Endpoint: http://localhost:11434  (optional — for Ollama etc.)
 *
 * Section headings are case-insensitive. Unknown sections are ignored.
 * Bullet items use "- " or "* " prefix. Key: value pairs are case-insensitive.
 */

import { AgentDefinitionSchema } from "./schema.js";
import type { AgentDefinition, EquipmentConnector } from "./schema.js";
import { parseDays, type DayOfWeek } from "../core/gates.js";

// ─── Helpers ─────────────────────────────────────────────────

function parseKV(line: string): { key: string; value: string } | null {
  const m = line.match(/^([a-z_][a-z0-9 _-]*):\s*(.+)$/i);
  if (!m) return null;
  return { key: m[1].trim().toLowerCase(), value: m[2].trim() };
}

function isBullet(line: string): string | null {
  const m = line.match(/^[-*]\s+(.+)$/);
  return m ? m[1].trim() : null;
}

function sectionKey(heading: string): string {
  return heading.trim().toLowerCase();
}

// Section heading aliases → canonical name
const SECTION_ALIASES: Record<string, string> = {
  "can do": "capabilities",
  can: "capabilities",
  identity: "persona",
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
  const k = sectionKey(raw);
  return SECTION_ALIASES[k] ?? k;
}

// ─── Parser ──────────────────────────────────────────────────

type Section =
  | "root"
  | "persona"
  | "capabilities"
  | "memory"
  | "rules"
  | "brain"
  | "equipment"
  | "skills"
  | "hours"
  | "unknown";

export function parseMdSource(source: string): AgentDefinition {
  const lines = source.split(/\r?\n/);

  // Mutable accumulator
  let name: string | undefined;
  let domain: string | undefined;
  let language: string[] = [];
  let persona = {
    name: undefined as string | undefined,
    style: undefined as string | undefined,
  };
  const capabilities: string[] = [];
  const memoryRetain: string[] = [];
  const rules: string[] = [];
  const brain: { provider?: string; model?: string; endpoint?: string } = {};
  const limits: {
    toolCalls?: number;
    iterations?: number;
    confidenceThreshold?: number;
  } = {};
  const skills: string[] = [];
  const equipmentChannels: string[] = [];
  const equipmentDedicatedTools: string[] = [];
  const equipmentConnectors: EquipmentConnector[] = [];
  const hours: {
    timezone?: string;
    schedule: Array<{ days: DayOfWeek[]; from: string; to: string }>;
    closedMessage?: string;
    closedMessageAr?: string;
  } = { schedule: [] };
  let currentConnector:
    | (Partial<EquipmentConnector> & {
        credentialType?: string;
        credentialValue?: string;
        credentialHeader?: string;
      })
    | null = null;

  let currentSection: Section = "root";

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip empty lines and comment lines
    if (!line || line.startsWith("<!--")) continue;

    // ── H1 = agent name ──────────────────────────────────────
    if (line.startsWith("# ") && !line.startsWith("## ")) {
      name = line.slice(2).trim();
      currentSection = "root";
      continue;
    }

    // ── H2/H3 = section ──────────────────────────────────────
    if (line.startsWith("## ") || line.startsWith("### ")) {
      const raw = line.replace(/^#{2,3}\s+/, "");
      const key = normaliseSection(raw);

      // "### Connector: <type>" within equipment — push previous connector
      if (currentSection === "equipment" && line.startsWith("### ")) {
        const connMatch = raw.match(/^connector(?:s)?:\s*(.+)$/i);
        if (connMatch) {
          if (currentConnector?.type) {
            equipmentConnectors.push(flushConnector(currentConnector));
          }
          currentConnector = {
            type: connMatch[1].trim(),
            operations: [],
            access: "readwrite",
          };
          continue;
        }
      }

      // Flush connector when leaving equipment section
      if (currentSection === "equipment" && line.startsWith("## ")) {
        if (currentConnector?.type) {
          equipmentConnectors.push(flushConnector(currentConnector));
          currentConnector = null;
        }
      }

      if (
        key === "persona" ||
        key === "capabilities" ||
        key === "memory" ||
        key === "rules" ||
        key === "brain" ||
        key === "equipment" ||
        key === "skills" ||
        key === "hours"
      ) {
        currentSection = key as Section;
      } else {
        currentSection = "unknown";
      }
      continue;
    }

    // ── Key: Value (anywhere) ─────────────────────────────────
    const kv = parseKV(line);

    // Root-level key:value pairs (before any ## heading, or generic)
    if (currentSection === "root" && kv) {
      switch (kv.key) {
        case "domain":
        case "purpose":
          domain = kv.value;
          break;
        case "language":
        case "languages":
          language = kv.value
            .split(/[,;]/)
            .map((l) => l.trim())
            .filter(Boolean);
          break;
      }
      continue;
    }

    // ── Persona section ───────────────────────────────────────
    if (currentSection === "persona") {
      if (kv) {
        switch (kv.key) {
          case "name":
            persona.name = kv.value;
            break;
          case "style":
          case "tone":
            persona.style = kv.value;
            break;
          case "language":
          case "languages":
            language = kv.value
              .split(/[,;]/)
              .map((l) => l.trim())
              .filter(Boolean);
            break;
          case "domain":
            domain = kv.value;
            break;
        }
      }
      continue;
    }

    // ── Capabilities section ──────────────────────────────────
    if (currentSection === "capabilities") {
      const item = isBullet(line);
      if (item) capabilities.push(item);
      continue;
    }

    // ── Memory section ────────────────────────────────────────
    if (currentSection === "memory") {
      const item = isBullet(line);
      if (item) memoryRetain.push(item);
      continue;
    }

    // ── Rules section ─────────────────────────────────────────
    if (currentSection === "rules") {
      const item = isBullet(line);
      if (item) {
        // Detect limit hints: "max 6 tool calls"
        const toolLimit = item.match(/^max\s+(\d+)\s+tool/i);
        if (toolLimit) {
          limits.toolCalls = parseInt(toolLimit[1], 10);
        } else {
          // Detect confidence threshold: "escalate when confidence < 0.7" or "< 70%"
          const confMatch = item.match(/confidence\s*[<>]\s*([\d.]+)(%?)/i);
          if (confMatch) {
            let val = parseFloat(confMatch[1]);
            if (confMatch[2] === "%") val = val / 100;
            limits.confidenceThreshold = val;
          }
          rules.push(item);
        }
      }
      continue;
    }

    // ── Brain section ─────────────────────────────────────────
    if (currentSection === "brain") {
      if (kv) {
        switch (kv.key) {
          case "provider":
          case "type":
            brain.provider = kv.value.toLowerCase();
            break;
          case "model":
            brain.model = kv.value;
            break;
          case "endpoint":
          case "url":
            brain.endpoint = kv.value;
            break;
        }
      }
      continue;
    }

    // ── Skills section ─────────────────────────────────────────
    if (currentSection === "skills") {
      const item = isBullet(line);
      if (item) {
        // Strip inline comments: "- booking  # check_availability, ..."
        const name = item.split(/\s*#/)[0]!.trim();
        if (name) skills.push(name);
      }
      continue;
    }
    // ── Hours section ────────────────────────────────────────────
    if (currentSection === "hours") {
      if (kv) {
        const timeRange = kv.value.match(
          /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/,
        );
        if (timeRange) {
          // Schedule line: e.g. "Mon-Fri: 09:00-17:00"
          const days = parseDays(kv.key);
          if (days.length > 0) {
            hours.schedule.push({
              days,
              from: timeRange[1]!,
              to: timeRange[2]!,
            });
          }
        } else {
          switch (kv.key) {
            case "timezone":
            case "tz":
              hours.timezone = kv.value;
              break;
            case "message":
            case "closed message":
            case "closedmessage":
              hours.closedMessage = kv.value;
              break;
            case "message ar":
            case "closed message ar":
            case "closedmessagear":
              hours.closedMessageAr = kv.value;
              break;
          }
        }
      }
      continue;
    }
    // ── Equipment section ─────────────────────────────────────
    if (currentSection === "equipment") {
      if (kv) {
        // Equipment-level keys
        if (!currentConnector) {
          switch (kv.key) {
            case "channels":
            case "channel":
              equipmentChannels.push(
                ...kv.value
                  .split(/[,;]/)
                  .map((c) => c.trim())
                  .filter(Boolean),
              );
              break;
            case "tools":
            case "dedicated tools":
            case "dedicatedtools":
              equipmentDedicatedTools.push(
                ...kv.value
                  .split(/[,;]/)
                  .map((t) => t.trim())
                  .filter(Boolean),
              );
              break;
          }
        } else {
          // Connector-level keys
          switch (kv.key) {
            case "operations":
            case "operation":
              currentConnector.operations = kv.value
                .split(/[,;]/)
                .map((o) => o.trim())
                .filter(Boolean);
              break;
            case "access":
              currentConnector.access =
                kv.value.toLowerCase() as EquipmentConnector["access"];
              break;
            case "endpoint":
            case "url":
              currentConnector.endpoint = kv.value;
              break;
            case "key":
            case "api key":
            case "apikey":
              currentConnector.credentialType = "api_key";
              currentConnector.credentialValue = kv.value;
              break;
            case "token":
            case "bearer":
            case "bearer token":
              currentConnector.credentialType = "bearer";
              currentConnector.credentialValue = kv.value;
              break;
            case "password":
            case "basic":
              currentConnector.credentialType = "basic";
              currentConnector.credentialValue = kv.value;
              break;
            case "header":
            case "header name":
            case "headername":
              currentConnector.credentialHeader = kv.value;
              break;
          }
        }
      }
      continue;
    }
  }

  // Flush any open connector at end-of-file
  if (currentConnector?.type) {
    equipmentConnectors.push(flushConnector(currentConnector));
  }

  return AgentDefinitionSchema.parse({
    name,
    domain,
    persona: {
      ...persona,
      language,
    },
    capabilities,
    memory: { retain: memoryRetain },
    rules,
    limits,
    brain: {
      provider:
        (brain.provider as AgentDefinition["brain"]["provider"]) ?? "custom",
      model: brain.model,
      endpoint: brain.endpoint,
    },
    skills,
    hours:
      hours.schedule.length > 0 || hours.timezone
        ? {
            timezone: hours.timezone ?? "UTC",
            schedule: hours.schedule,
            closedMessage: hours.closedMessage,
            closedMessageAr: hours.closedMessageAr,
          }
        : undefined,
    equipment:
      equipmentConnectors.length > 0 ||
      equipmentChannels.length > 0 ||
      equipmentDedicatedTools.length > 0
        ? {
            connectors: equipmentConnectors,
            channels: equipmentChannels,
            dedicatedTools: equipmentDedicatedTools,
          }
        : undefined,
  });
}

// ─── Internal helpers ─────────────────────────────────────────

function flushConnector(
  raw: Partial<EquipmentConnector> & {
    credentialType?: string;
    credentialValue?: string;
    credentialHeader?: string;
  },
): EquipmentConnector {
  const conn: EquipmentConnector = {
    type: raw.type ?? "unknown",
    operations: raw.operations ?? [],
    access: raw.access ?? "readwrite",
    endpoint: raw.endpoint,
  };
  if (raw.credentialType && raw.credentialValue) {
    conn.credentials = {
      type: raw.credentialType as "api_key" | "bearer" | "basic",
      value: raw.credentialValue,
      headerName: raw.credentialHeader,
    };
  }
  return conn;
}
