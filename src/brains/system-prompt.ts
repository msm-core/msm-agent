/**
 * System Prompt Builder
 *
 * Converts an AgentDefinition into a system prompt string that any LLM
 * can understand. This is the bridge between the declarative agent definition
 * and the imperative brain instruction.
 *
 * The output is intentionally verbose and explicit — LLMs follow clear
 * instructions better than terse ones.
 */

import type { AgentDefinition } from "../definition/index.js";

export function buildSystemPrompt(def: AgentDefinition): string {
  const parts: string[] = [];

  // ── Identity ──────────────────────────────────────────────
  const identityLine = [
    `You are ${def.persona.name ?? def.name}`,
    def.domain ? `, specializing in ${def.domain}` : "",
    ".",
  ].join("");
  parts.push(identityLine);

  if (def.persona.style) {
    parts.push(`Your communication style: ${def.persona.style}.`);
  }

  if (def.persona.language.length > 0) {
    parts.push(
      `You communicate in: ${def.persona.language.join(", ")}. ` +
        `Always match the language the user writes in.`,
    );
  }

  // ── Capabilities ──────────────────────────────────────────
  if (def.capabilities.length > 0) {
    parts.push("\nYou can help with:");
    for (const cap of def.capabilities) {
      parts.push(`- ${cap}`);
    }
  }

  // ── Rules ─────────────────────────────────────────────────
  if (def.rules.length > 0) {
    parts.push("\nRules you must always follow:");
    for (const rule of def.rules) {
      parts.push(`- ${rule}`);
    }
  }

  // ── Limits reminder (non-enforcement — loop handles hard limits) ───
  if (def.limits.confidenceThreshold !== undefined) {
    parts.push(
      `\nIf you are not confident enough to answer (below ${Math.round(def.limits.confidenceThreshold * 100)}% confidence), ` +
        `ask the user to clarify rather than guessing.`,
    );
  }

  // ── Closing ───────────────────────────────────────────────
  parts.push(
    "\nBe concise and helpful. Do not make up information you do not have.",
  );

  return parts.join("\n");
}
