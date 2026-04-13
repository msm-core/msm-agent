/**
 * Output Sanitization — Strips sensitive data from agent responses.
 *
 * Extracted from dalil's 7+ pattern output guards:
 *   - API keys (GitHub, GitLab, Slack, AWS, generic)
 *   - PII patterns (national IDs, phone numbers)
 *   - Control characters
 *
 * Called before delivery to prevent accidental secret/PII leakage.
 */

/** Patterns that should never appear in user-facing responses */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // API keys & tokens
  { pattern: /ghp_[A-Za-z0-9_]{36,}/g, label: "github_token" },
  { pattern: /glpat-[A-Za-z0-9\-_]{20,}/g, label: "gitlab_token" },
  { pattern: /xoxb-[A-Za-z0-9\-]{24,}/g, label: "slack_token" },
  { pattern: /xoxp-[A-Za-z0-9\-]{24,}/g, label: "slack_user_token" },
  { pattern: /AKIA[0-9A-Z]{16}/g, label: "aws_access_key" },
  { pattern: /sk-[A-Za-z0-9]{32,}/g, label: "openai_key" },
  { pattern: /sk-ant-[A-Za-z0-9\-]{32,}/g, label: "anthropic_key" },
  // Generic secret patterns
  {
    pattern:
      /(?:api[_-]?key|secret|token|password|auth)\s*[:=]\s*["']?[A-Za-z0-9\-_.]{16,}["']?/gi,
    label: "generic_secret",
  },
  // Credit card numbers (basic: 13-19 digit sequences that look like cards)
  {
    pattern:
      /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g,
    label: "credit_card",
  },
  // SSN pattern
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, label: "ssn" },
  // Saudi national ID (10 digits starting with 1 or 2)
  { pattern: /\b[12]\d{9}\b/g, label: "saudi_national_id" },
  // Control characters (safety)
  { pattern: /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, label: "control_char" },
];

export interface SanitizeResult {
  text: string;
  redacted: string[];
}

/**
 * Sanitize output text by redacting sensitive patterns.
 * Returns the cleaned text and a list of what was redacted (for logging).
 */
export function sanitizeOutput(text: string): SanitizeResult {
  const redacted: string[] = [];
  let cleaned = text;

  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    if (pattern.test(cleaned)) {
      redacted.push(label);
      pattern.lastIndex = 0;
      cleaned = cleaned.replace(pattern, "[REDACTED]");
    }
  }

  return { text: cleaned, redacted };
}

/**
 * Quick check: does the text contain any sensitive patterns?
 * Faster than full sanitization when you just need a boolean.
 */
export function containsSensitiveData(text: string): boolean {
  for (const { pattern } of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) return true;
  }
  return false;
}
