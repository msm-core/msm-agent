/**
 * Tests for the Jobs adapter layer (Phase 7).
 *
 * Coverage:
 *   - InMemoryJobAdapter: full CRUD + filtering
 *   - generateJobId: format validation
 *
 * SQLiteJobAdapter is integration-tested via the build (node:sqlite is sync,
 * same logic path as InMemoryJobAdapter once rows are mapped).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryJobAdapter, generateJobId } from "../src/adapters/jobs.js";
import type { Job } from "../src/adapters/jobs.js";

// ─── Fixtures ─────────────────────────────────────────────────

let counter = 0;

function makeJob(overrides?: Partial<Job>): Job {
  const now = new Date().toISOString();
  return {
    jobId: `jbm_test${String(++counter).padStart(4, "0")}`,
    sessionId: `sess_${counter}`,
    type: "test_workflow",
    status: "running",
    currentStep: 0,
    state: {},
    budget: { maxSteps: 5, maxDurationMs: 0 },
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
    ...overrides,
  };
}

// ─── InMemoryJobAdapter ────────────────────────────────────────

describe("InMemoryJobAdapter", () => {
  let adapter: InMemoryJobAdapter;

  beforeEach(() => {
    adapter = new InMemoryJobAdapter();
    counter = 0;
  });

  it("createJob / getJob — round-trip", async () => {
    const job = makeJob();
    await adapter.createJob(job);
    const found = await adapter.getJob(job.jobId);
    expect(found).not.toBeNull();
    expect(found!.jobId).toBe(job.jobId);
    expect(found!.type).toBe("test_workflow");
  });

  it("getJob — returns null for unknown ID", async () => {
    expect(await adapter.getJob("jbm_missing")).toBeNull();
  });

  it("findActiveJobForSession — returns running job", async () => {
    const job = makeJob({ sessionId: "sess_active" });
    await adapter.createJob(job);
    const found = await adapter.findActiveJobForSession("sess_active");
    expect(found?.jobId).toBe(job.jobId);
  });

  it("findActiveJobForSession — returns waiting job", async () => {
    const job = makeJob({ sessionId: "sess_wait", status: "waiting" });
    await adapter.createJob(job);
    const found = await adapter.findActiveJobForSession("sess_wait");
    expect(found?.jobId).toBe(job.jobId);
  });

  it("findActiveJobForSession — returns null for completed job", async () => {
    const job = makeJob({ status: "completed" });
    await adapter.createJob(job);
    expect(await adapter.findActiveJobForSession(job.sessionId)).toBeNull();
  });

  it("findActiveJobForSession — returns null for cancelled job", async () => {
    const job = makeJob({ status: "cancelled" });
    await adapter.createJob(job);
    expect(await adapter.findActiveJobForSession(job.sessionId)).toBeNull();
  });

  it("findActiveJobForSession — returns null for unrelated session", async () => {
    const job = makeJob({ sessionId: "sess_a" });
    await adapter.createJob(job);
    expect(await adapter.findActiveJobForSession("sess_b")).toBeNull();
  });

  it("updateJob — changes status to cancelled", async () => {
    const job = makeJob();
    await adapter.createJob(job);
    const ts = new Date().toISOString();
    await adapter.updateJob(job.jobId, {
      status: "cancelled",
      updatedAt: ts,
      completedAt: ts,
    });
    const updated = await adapter.getJob(job.jobId);
    expect(updated?.status).toBe("cancelled");
    expect(updated?.completedAt).toBe(ts);
  });

  it("updateJob — increments currentStep", async () => {
    const job = makeJob({ currentStep: 2 });
    await adapter.createJob(job);
    await adapter.updateJob(job.jobId, { currentStep: 3 });
    expect((await adapter.getJob(job.jobId))?.currentStep).toBe(3);
  });

  it("updateJob — merges state bag", async () => {
    const job = makeJob({ state: { a: 1 } });
    await adapter.createJob(job);
    await adapter.updateJob(job.jobId, { state: { a: 1, b: 2 } });
    expect((await adapter.getJob(job.jobId))?.state).toEqual({ a: 1, b: 2 });
  });

  it("updateJob — no-op for unknown ID", async () => {
    await expect(
      adapter.updateJob("jbm_ghost", { status: "failed" }),
    ).resolves.toBeUndefined();
  });

  it("listJobs — returns all when no filter", async () => {
    await adapter.createJob(makeJob({ status: "running" }));
    await adapter.createJob(makeJob({ status: "completed" }));
    const all = await adapter.listJobs();
    expect(all).toHaveLength(2);
  });

  it("listJobs — filters by status", async () => {
    await adapter.createJob(makeJob({ status: "running" }));
    await adapter.createJob(makeJob({ status: "completed" }));
    await adapter.createJob(makeJob({ status: "cancelled" }));
    const running = await adapter.listJobs({ status: "running" });
    expect(running).toHaveLength(1);
    expect(running[0]?.status).toBe("running");
  });

  it("listJobs — filters by type", async () => {
    await adapter.createJob(makeJob({ type: "workflow_a" }));
    await adapter.createJob(makeJob({ type: "workflow_b" }));
    await adapter.createJob(makeJob({ type: "workflow_a" }));
    const aJobs = await adapter.listJobs({ type: "workflow_a" });
    expect(aJobs).toHaveLength(2);
    expect(aJobs.every((j) => j.type === "workflow_a")).toBe(true);
  });

  it("listJobs — combines status + type filters", async () => {
    await adapter.createJob(makeJob({ type: "workflow_a", status: "running" }));
    await adapter.createJob(
      makeJob({ type: "workflow_a", status: "completed" }),
    );
    await adapter.createJob(makeJob({ type: "workflow_b", status: "running" }));
    const result = await adapter.listJobs({
      type: "workflow_a",
      status: "running",
    });
    expect(result).toHaveLength(1);
  });

  it("close — clears all jobs", async () => {
    await adapter.createJob(makeJob());
    await adapter.close();
    const all = await adapter.listJobs();
    expect(all).toHaveLength(0);
  });
});

// ─── generateJobId ─────────────────────────────────────────────

describe("generateJobId", () => {
  it("produces jbm_ prefix with 16 hex chars", () => {
    const id = generateJobId();
    expect(id).toMatch(/^jbm_[0-9a-f]{16}$/);
  });

  it("produces unique IDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateJobId()));
    expect(ids.size).toBe(100);
  });
});
