export {
  SectionRegistry,
  estimateTokens,
  getCompactionPolicy,
} from "./section-registry.js";
export type {
  SectionKind,
  PromptSection,
  SectionRegistryStats,
  CompactionPolicy,
  CompactionResult,
} from "./section-registry.js";

export {
  CORE_RULES,
  INTERACTION_RULES,
  detectInjection,
  INJECTION_WARNING,
} from "./persona-shield.js";

export { buildPrompt } from "./layers.js";
export type { PromptInput, PromptResult } from "./layers.js";
