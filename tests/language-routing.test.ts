/**
 * Phase 15 — Arabic-Native Routing Tests
 *
 * Tests for:
 * - detectLanguage() — character-set heuristic
 * - RoutingBrain — per-request language routing
 * - buildBrain() — returns RoutingBrain when language is declared
 */

import { describe, it, expect, vi } from "vitest";
import {
  detectLanguage,
  ARABIC_FRACTION_THRESHOLD,
} from "../src/brains/language-detect.js";
import { RoutingBrain } from "../src/brains/routing-brain.js";
import type { Brain, BrainPayload } from "../src/core/types.js";

// ─── Helpers ─────────────────────────────────────────────────

function makeBrain(label: string): Brain {
  return {
    run: vi.fn().mockResolvedValue({
      decision: "respond",
      content: `[${label}]`,
      confidence: 0.95,
      layers: [],
    } satisfies BrainPayload),
  };
}

// ─── detectLanguage() ─────────────────────────────────────────

describe("detectLanguage()", () => {
  it("classifies pure Arabic text as 'ar'", () => {
    expect(detectLanguage("مرحباً كيف حالك؟")).toBe("ar");
  });

  it("classifies pure English text as 'en'", () => {
    expect(detectLanguage("Hello, how are you?")).toBe("en");
  });

  it("classifies empty string as 'en' (safe fallback)", () => {
    expect(detectLanguage("")).toBe("en");
  });

  it("classifies whitespace-only string as 'en'", () => {
    expect(detectLanguage("   \t\n")).toBe("en");
  });

  it("classifies punctuation-only string as 'en'", () => {
    expect(detectLanguage("!!! ??? ...")).toBe("en");
  });

  it("classifies digits-only string as 'en'", () => {
    expect(detectLanguage("12345 67890")).toBe("en");
  });

  it(`classifies mixed text as 'ar' when Arabic fraction > ${ARABIC_FRACTION_THRESHOLD}`, () => {
    // Mostly Arabic with some Latin
    const text = "مرحباً كيف حالك test";
    expect(detectLanguage(text)).toBe("ar");
  });

  it(`classifies mixed text as 'en' when Arabic fraction <= ${ARABIC_FRACTION_THRESHOLD}`, () => {
    // Mostly English with a single Arabic word
    const text = "Hello, how are you? مرحباً";
    expect(detectLanguage(text)).toBe("en");
  });

  it("handles a single Arabic character as 'ar'", () => {
    // Single Arabic char → 100% Arabic fraction
    expect(detectLanguage("م")).toBe("ar");
  });

  it("handles a single Latin character as 'en'", () => {
    expect(detectLanguage("a")).toBe("en");
  });

  it("classifies Arabic numerals (U+0660–U+0669 within Arabic block) correctly", () => {
    // U+0660 = Arabic-Indic digit zero — inside ARABIC_BLOCK
    const arabicDigits = "\u0660\u0661\u0662\u0663"; // ٠١٢٣
    expect(detectLanguage(arabicDigits)).toBe("ar");
  });
});

// ─── RoutingBrain ─────────────────────────────────────────────

describe("RoutingBrain", () => {
  it("routes Arabic input to the arabic brain", async () => {
    const primary = makeBrain("primary");
    const arabic = makeBrain("arabic");
    const router = new RoutingBrain(primary, arabic);

    const result = await router.run({
      raw: "مرحباً كيف يمكنني مساعدتك؟",
      modality: "text",
    });

    expect(result.content).toBe("[arabic]");
    expect(primary.run).not.toHaveBeenCalled();
    expect(arabic.run).toHaveBeenCalledOnce();
  });

  it("routes English input to the primary brain", async () => {
    const primary = makeBrain("primary");
    const arabic = makeBrain("arabic");
    const router = new RoutingBrain(primary, arabic);

    const result = await router.run({
      raw: "Hello, what can you help me with?",
      modality: "text",
    });

    expect(result.content).toBe("[primary]");
    expect(arabic.run).not.toHaveBeenCalled();
    expect(primary.run).toHaveBeenCalledOnce();
  });

  it("falls back to primary when arabic brain is undefined", async () => {
    const primary = makeBrain("primary");
    const router = new RoutingBrain(primary, undefined);

    const result = await router.run({
      raw: "مرحباً",
      modality: "text",
    });

    expect(result.content).toBe("[primary]");
    expect(primary.run).toHaveBeenCalledOnce();
  });

  it("passes the full input object through to the selected brain", async () => {
    const primary = makeBrain("primary");
    const arabic = makeBrain("arabic");
    const router = new RoutingBrain(primary, arabic);

    const input = {
      raw: "مرحباً",
      modality: "text" as const,
      history: [{ role: "user" as const, content: "prev" }],
    };
    await router.run(input);

    expect(arabic.run).toHaveBeenCalledWith(input);
  });
});

// ─── BrainSchema language field ───────────────────────────────

describe("BrainSchema language field", () => {
  it("accepts 'arabic' as a valid language value", async () => {
    const { BrainSchema } = await import("../src/definition/schema.js");
    const result = BrainSchema.safeParse({
      provider: "ollama",
      model: "phi4-mini",
      language: "arabic",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.language).toBe("arabic");
    }
  });

  it("accepts 'ar' as a valid language value", async () => {
    const { BrainSchema } = await import("../src/definition/schema.js");
    const result = BrainSchema.safeParse({
      provider: "ollama",
      model: "phi4-mini",
      language: "ar",
    });
    expect(result.success).toBe(true);
  });

  it("accepts 'auto' as a valid language value", async () => {
    const { BrainSchema } = await import("../src/definition/schema.js");
    const result = BrainSchema.safeParse({
      provider: "openai",
      language: "auto",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown language values", async () => {
    const { BrainSchema } = await import("../src/definition/schema.js");
    const result = BrainSchema.safeParse({
      provider: "ollama",
      language: "french",
    });
    expect(result.success).toBe(false);
  });

  it("language field is optional (omitted is fine)", async () => {
    const { BrainSchema } = await import("../src/definition/schema.js");
    const result = BrainSchema.safeParse({ provider: "ollama" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.language).toBeUndefined();
    }
  });
});
