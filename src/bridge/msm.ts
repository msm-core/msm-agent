/**
 * MSM Bridge — Adapter that connects msm-ai (brain) to msm-agent.
 *
 * This bridge wraps an MSM pipeline so it satisfies the agent's Brain interface.
 * It maps MSMPayload → BrainPayload, keeping the two packages fully decoupled.
 *
 * Usage:
 *   import { createPipeline } from "msm-ai";
 *   import { wrapMSM } from "msm-agent/bridge/msm";
 *   import { createAgent } from "msm-agent";
 *
 *   const pipeline = await createPipeline("./manifest.yaml");
 *   const brain = wrapMSM(pipeline);
 *   const agent = createAgent({ brain, ... });
 *
 * If you're NOT using msm-ai, you don't need this file at all.
 * Just implement the Brain interface directly.
 */

import type { Brain, BrainPayload, ToolResult } from "../core/types.js";

/**
 * Minimal MSM pipeline interface — what we need from msm-ai.
 * We don't import from msm-ai; instead we accept anything with this shape.
 */
export interface MSMPipeline {
  run(input: {
    raw: string;
    modality: "text" | "voice" | "image";
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    tool_results?: Array<{
      tool: string;
      status: string;
      result: Record<string, unknown>;
    }>;
  }): Promise<Record<string, unknown>>;
}

/**
 * Wrap an MSM pipeline as an agent Brain.
 *
 * The MSMPayload returned by msm-ai already matches BrainPayload's shape
 * (orchestration, generation, final_output are all present), so the mapping
 * is a zero-cost pass-through — no field renaming needed.
 */
export function wrapMSM(pipeline: MSMPipeline): Brain {
  return {
    async run(input: {
      raw: string;
      modality: "text" | "voice" | "image";
      history?: Array<{ role: "user" | "assistant"; content: string }>;
      tool_results?: ToolResult[];
    }): Promise<BrainPayload> {
      const result = await pipeline.run(input);
      // MSMPayload fields map directly to BrainPayload
      return result as BrainPayload;
    },
  };
}
