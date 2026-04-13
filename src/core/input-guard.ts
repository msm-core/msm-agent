/**
 * Input Guard — Prompt injection defense for user input.
 *
 * Two-tier defense:
 *   Tier 1: Pattern matching (fast path) — 13+ hardcoded patterns
 *   Tier 2: Sanitization — length limit, control char removal, tag stripping
 *
 * For Tier 3 (embedding-similarity), use the preHook to plug in
 * an embedding model + adversarial blocklist.
 */

/** Maximum allowed input length (truncated beyond this) */
const MAX_INPUT_LENGTH = 8000;

/** Patterns indicating prompt injection attempts */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+(instructions?|prompts?|rules?)/i,
  /ignore\s+above/i,
  /disregard\s+(all\s+)?previous/i,
  /forget\s+(all\s+)?previous/i,
  /system\s+prompt/i,
  /you\s+are\s+now\s+(?:a|an|acting\s+as)/i,
  /jailbreak/i,
  /DAN\s+mode/i,
  /do\s+anything\s+now/i,
  /pretend\s+(?:you\s+are|to\s+be)\s+(?!interested|happy|sad)/i,
  /reveal\s+(?:your|the)\s+(?:system|initial|original)\s+(?:prompt|instructions?|message)/i,
  /what\s+(?:is|are)\s+your\s+(?:system|initial|original)\s+(?:prompt|instructions?)/i,
  /override\s+(?:your|the|all)\s+(?:rules?|instructions?|constraints?)/i,
  // Unicode and zero-width char injection detection
  /[\u200B-\u200F\u2028-\u202F\uFEFF]/,
];

export interface InputGuardResult {
  /** Cleaned and safe input text */
  text: string;
  /** Whether injection was detected */
  injectionDetected: boolean;
  /** Which patterns matched (for logging/observability) */
  matchedPatterns: string[];
  /** Whether the input was truncated */
  truncated: boolean;
}

/**
 * Guard user input against prompt injection and sanitize for safety.
 *
 * Steps:
 * 1. Truncate to MAX_INPUT_LENGTH
 * 2. Strip control characters
 * 3. Strip HTML/script tags
 * 4. Detect injection patterns (strip matched segments)
 */
export function guardInput(raw: string): InputGuardResult {
  const matchedPatterns: string[] = [];
  let truncated = false;

  // Step 1: Length limit
  let text = raw;
  if (text.length > MAX_INPUT_LENGTH) {
    text = text.slice(0, MAX_INPUT_LENGTH);
    truncated = true;
  }

  // Step 2: Strip control characters (keep newlines, tabs, standard whitespace)
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");

  // Step 3: Strip script tags and HTML event handlers
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  text = text.replace(/\bon\w+\s*=\s*["'][^"']*["']/gi, "");

  // Step 4: Detect and strip injection patterns
  let injectionDetected = false;
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      injectionDetected = true;
      matchedPatterns.push(pattern.source.slice(0, 60));
      // Strip the matched injection attempt
      text = text.replace(pattern, "");
    }
  }

  // Step 5: Strip zero-width characters that could hide injection
  text = text.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, "");

  // Trim whitespace artifacts from stripping
  text = text.replace(/\s{3,}/g, " ").trim();

  return {
    text,
    injectionDetected,
    matchedPatterns,
    truncated,
  };
}
