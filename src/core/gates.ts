/**
 * Pre-processing gates — zero-LLM message filters
 *
 * Run before the brain loop to handle trivial cases without calling the LLM.
 * Two gates are supported:
 *
 *   Gate 1 — Acknowledgement: suppress "ok / thanks / 👍 / تمام" messages.
 *     The agent returns a "suppressed" outcome and no delivery is made.
 *     Saves an entire LLM call for ~30% of real-world conversations.
 *
 *   Gate 2 — Business hours: send a canned closed message when outside
 *     working hours. Uses IANA timezone for accurate local time comparison.
 *     No LLM call is made.
 *
 * Ported from Kader's channel-router.ts §3.5 "Pre-Processing Gate", adapted
 * for single-tenant portable use (no customer opt-out needed).
 */

import type { LoopOutcome, BrainPayload } from "./types.js";

// ─── Acknowledgement Gate ─────────────────────────────────────

/**
 * Patterns that indicate a pure acknowledgement with no informational content.
 * Each pattern is tested against the trimmed message text.
 * Max text length checked: 60 chars (longer messages are never acks).
 */
const ACK_PATTERNS: RegExp[] = [
  // English
  /^\s*(ok|okay|o+k+|alright|got it|got that|understood|noted|i see|ic)\s*[.!]?\s*$/i,
  /^\s*(thanks|thank you|thx|ty|thank u|many thanks|cheers)\s*[.!]?\s*$/i,
  /^\s*(sure|yep|yup|yes|yeah|no worries|no problem|np|np!)\s*[.!]?\s*$/i,
  /^\s*(great|perfect|awesome|nice|cool|sounds good|sounds great)\s*[.!]?\s*$/i,
  // Arabic
  /^\s*(تمام|تمام جداً|اوكي|اوك|أوكي|أوك|حسنا|حسناً|مفهوم|موافق|شكرا|شكراً|شكرا جزيلا|شكراً جزيلاً|ممتاز|رائع)\s*[.!]?\s*$/,
  // Emoji-only — common positive reactions
  /^\s*(👍|👌|🙏|✅|☑️|🆗|😊|🤙|💪|👏|❤️|🥰|💯|🫡|🫶)\s*$/,
];

const ACK_MAX_LENGTH = 60;

/**
 * Returns true if the message is a pure acknowledgement with no actionable content.
 * False positives are avoided by capping length and using anchored patterns.
 */
export function isAcknowledgement(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > ACK_MAX_LENGTH) return false;
  return ACK_PATTERNS.some((re) => re.test(trimmed));
}

// ─── Business Hours Gate ──────────────────────────────────────

/** 3-letter day-of-week codes matching JavaScript's short weekday output */
export type DayOfWeek = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

const ALL_DAYS: DayOfWeek[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const DAY_INDEX: Record<DayOfWeek, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export interface BusinessHoursSchedule {
  /** Days this window applies to (e.g. ["mon","tue","wed","thu","fri"]) */
  days: DayOfWeek[];
  /** Opening time in "HH:MM" 24-hour format (e.g. "09:00") */
  from: string;
  /** Closing time in "HH:MM" 24-hour format (e.g. "17:00") */
  to: string;
}

export interface BusinessHoursGateConfig {
  /** IANA timezone string (e.g. "Asia/Dubai", "America/New_York", "UTC") */
  timezone: string;
  /** One or more time windows that define when the agent is open */
  schedule: BusinessHoursSchedule[];
  /** Response sent when outside hours. Falls back to generic closed message. */
  closedMessage?: string;
  /** Arabic version of the closed message (optional) */
  closedMessageAr?: string;
}

const DEFAULT_CLOSED_MESSAGE =
  "We're currently outside business hours. We'll get back to you as soon as we're open!";

/**
 * Returns true if the current time (in the gate's configured timezone)
 * falls within any of the declared schedule windows.
 * Fails open (returns true) if the timezone is invalid or parsing fails.
 */
export function isWithinBusinessHours(
  config: BusinessHoursGateConfig,
  now?: Date,
): boolean {
  if (config.schedule.length === 0) return true; // no schedule = always open

  const date = now ?? new Date();

  let day: DayOfWeek;
  let curMinutes: number;

  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "short",
    });

    const parts = dtf.formatToParts(date);
    const rawHour = parts.find((p) => p.type === "hour")?.value ?? "00";
    const rawMinute = parts.find((p) => p.type === "minute")?.value ?? "00";
    const rawDay = parts.find((p) => p.type === "weekday")?.value ?? "Mon";

    // Guard against Intl returning "24" for midnight in some environments
    const hour = rawHour === "24" ? 0 : parseInt(rawHour, 10);
    const minute = parseInt(rawMinute, 10);
    day = rawDay.toLowerCase().slice(0, 3) as DayOfWeek;
    curMinutes = hour * 60 + minute;
  } catch {
    return true; // fail open — don't block if timezone lookup fails
  }

  for (const window of config.schedule) {
    if (!window.days.includes(day)) continue;

    const [fromH = 0, fromM = 0] = window.from
      .split(":")
      .map((n) => parseInt(n, 10));
    const [toH = 0, toM = 0] = window.to.split(":").map((n) => parseInt(n, 10));

    const fromMinutes = fromH * 60 + fromM;
    const toMinutes = toH * 60 + toM;

    if (curMinutes >= fromMinutes && curMinutes < toMinutes) return true;
  }

  return false;
}

// ─── Gates Config ─────────────────────────────────────────────

export interface GatesConfig {
  /**
   * Acknowledgement gate — suppress "ok / thanks / تمام" without LLM call.
   * Default: enabled (true).
   * Set to false to disable (e.g., for data collection agents that want all input).
   */
  acknowledgement?: boolean;

  /**
   * Business hours gate — send a closed message outside working hours.
   * When present, any incoming user_message outside the schedule returns
   * a response outcome with the closed message (no LLM call made).
   */
  businessHours?: BusinessHoursGateConfig;
}

// ─── Gate Execution ───────────────────────────────────────────

/**
 * Run all configured gates against an incoming user message text.
 *
 * Returns a LoopOutcome to short-circuit processEvent(), or null to proceed normally.
 * Gates are checked in order; the first match wins.
 *
 * @param text    Raw text from the user_message event
 * @param config  Gates configuration (from CreateAgentOptions.gates)
 * @param now     Optional date override — useful for testing business hours
 */
export function checkGates(
  text: string,
  config: GatesConfig | undefined,
  now?: Date,
): LoopOutcome | null {
  if (!config) return null;

  // Gate 1 — Acknowledgement (no delivery)
  if (config.acknowledgement !== false && isAcknowledgement(text)) {
    return { type: "suppressed", reason: "acknowledgement" };
  }

  // Gate 2 — Business hours (send closed message)
  if (
    config.businessHours &&
    !isWithinBusinessHours(config.businessHours, now)
  ) {
    const closedText =
      config.businessHours.closedMessage ?? DEFAULT_CLOSED_MESSAGE;
    const stubPayload: BrainPayload = {
      orchestration: { action: "respond", confidence: 1 },
      generation: { response_text: closedText },
    };
    return {
      type: "response",
      text: closedText,
      textAr: config.businessHours.closedMessageAr,
      language: "en",
      payload: stubPayload,
    };
  }

  return null;
}

// ─── Day parsing helpers (exported for md-parser) ─────────────

const DAY_NAMES: Record<string, DayOfWeek> = {
  sun: "sun",
  sunday: "sun",
  mon: "mon",
  monday: "mon",
  tue: "tue",
  tuesday: "tue",
  wed: "wed",
  wednesday: "wed",
  thu: "thu",
  thursday: "thu",
  fri: "fri",
  friday: "fri",
  sat: "sat",
  saturday: "sat",
};

/**
 * Parse a day expression into a list of DayOfWeek codes.
 *
 * Supports:
 *   "Mon"       → ["mon"]
 *   "Mon-Fri"   → ["mon","tue","wed","thu","fri"]
 *   "Mon,Wed"   → ["mon","wed"]
 *
 * Unknown names are silently ignored.
 */
export function parseDays(expr: string): DayOfWeek[] {
  const trimmed = expr.trim();

  // Range: Mon-Fri
  const rangeMatch = trimmed.match(/^(\w+)-(\w+)$/);
  if (rangeMatch) {
    const [, fromRaw, toRaw] = rangeMatch;
    const fromDay = DAY_NAMES[fromRaw!.toLowerCase()];
    const toDay = DAY_NAMES[toRaw!.toLowerCase()];
    if (fromDay && toDay) {
      const fromIdx = DAY_INDEX[fromDay];
      const toIdx = DAY_INDEX[toDay];
      if (fromIdx <= toIdx) {
        return ALL_DAYS.slice(fromIdx, toIdx + 1);
      }
      // Wraps (e.g. Fri-Mon): not common, expand linearly
      return [...ALL_DAYS.slice(fromIdx), ...ALL_DAYS.slice(0, toIdx + 1)];
    }
  }

  // Comma-separated: Mon,Wed,Fri
  return trimmed
    .split(",")
    .map((d) => DAY_NAMES[d.trim().toLowerCase()])
    .filter((d): d is DayOfWeek => d !== undefined);
}
