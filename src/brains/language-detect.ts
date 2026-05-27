/**
 * Language Detection — Phase 15 (Arabic-Native Routing)
 *
 * Fast, zero-dependency character-set heuristic. No LLM call. No external API.
 *
 * Arabic Unicode block: U+0600–U+06FF
 * If >30% of non-whitespace characters fall in this range → "ar".
 * Otherwise → "en" (used as the default/fallback for all non-Arabic input).
 */

/** Unicode range covering Arabic script characters */
export const ARABIC_BLOCK_START = 0x0600;
export const ARABIC_BLOCK_END = 0x06ff;

/** Threshold fraction — if Arabic chars exceed this, classify as Arabic */
export const ARABIC_FRACTION_THRESHOLD = 0.3;

export type DetectedLanguage = "ar" | "en" | "other";

/**
 * Detect whether the input text is predominantly Arabic or English.
 *
 * @param text - The user input string to analyse
 * @returns "ar" if Arabic characters make up >30% of non-whitespace chars,
 *          "en" (default fallback) otherwise
 */
export function detectLanguage(text: string): DetectedLanguage {
  if (!text || text.trim().length === 0) return "en";

  const chars = [...text].filter((c) => !/\s/.test(c));
  if (chars.length === 0) return "en";

  let arabicCount = 0;
  for (const ch of chars) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= ARABIC_BLOCK_START && cp <= ARABIC_BLOCK_END) {
      arabicCount++;
    }
  }

  const fraction = arabicCount / chars.length;
  return fraction >= ARABIC_FRACTION_THRESHOLD ? "ar" : "en";
}
