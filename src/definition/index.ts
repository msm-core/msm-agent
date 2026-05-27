/**
 * Definition Layer — Entry Point
 *
 * Detects the file format (.md or .it) and routes to the correct parser.
 * Both parsers produce the same AgentDefinition — the rest of the runtime
 * never sees the source format.
 *
 * Usage:
 *
 *   import { loadAgent } from "msm-agent/definition";
 *
 *   const def = await loadAgent("./my-agent.md");
 *   // or
 *   const def = await loadAgent("./my-agent.it");
 *
 *   const agent = createAgent({
 *     brain: buildBrainFromDefinition(def),
 *     config: toAgentConfig(def),
 *     ...adapters,
 *   });
 */

import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parseItSource } from "./it-parser.js";
import { parseMdSource } from "./md-parser.js";
import type { AgentDefinition } from "./schema.js";

export type {
  AgentDefinition,
  Persona,
  BrainConfig,
  LimitsConfig,
  AgentEquipment,
  EquipmentConnector,
  ConnectorCredentials,
} from "./schema.js";
export type {
  SkillToolDef,
  SkillFactory,
  SkillOptions,
} from "../adapters/skills.js";
export {
  AgentDefinitionSchema,
  PersonaSchema,
  BrainSchema,
  LimitsSchema,
  toAgentConfig,
  toGatesConfig,
  renderEquipmentBlock,
} from "./schema.js";
export { parseItSource } from "./it-parser.js";
export { parseMdSource } from "./md-parser.js";

// ─── loadAgent ───────────────────────────────────────────────

/**
 * Load and parse an agent definition file.
 *
 * Supported formats:
 *  - `.it`  — IntentText (structured, machine-queryable)
 *  - `.md`  — Markdown (human-friendly, lowest barrier)
 *
 * The returned AgentDefinition is fully validated.
 * Throws on parse errors or schema violations.
 */
export async function loadAgent(filePath: string): Promise<AgentDefinition> {
  const source = await readFile(filePath, "utf-8");
  return parseAgentSource(source, filePath);
}

/**
 * Parse an agent definition from a raw string.
 * The `hint` parameter is used only to infer the format — any string works.
 */
export function parseAgentSource(
  source: string,
  hint: string = "",
): AgentDefinition {
  const ext = extname(hint).toLowerCase();

  if (ext === ".it") {
    return parseItSource(source);
  }

  // Default to Markdown for .md and any unknown extension
  return parseMdSource(source);
}
