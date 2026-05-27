/**
 * Jobs Adapter — Phase 7: Long-Running Workflows
 *
 * A Job is a named, stateful workflow that spans multiple agent interactions
 * over minutes to days. Unlike a Task (one loop run), a Job:
 *
 *   - Has a typed workflow name (e.g. "onboard_customer")
 *   - Carries a shared `state` bag that persists across all interactions
 *   - Tracks cumulative step count and enforces step/time budgets
 *   - Has a full lifecycle: running → waiting → completed | failed | cancelled
 *
 * ID prefix: jbm_ (matches Kader's Job ID convention)
 *
 * The adapter is optional — wire it via ServerOptions.jobs in createAgentServer().
 * Enable via ENABLE_JOBS=true in the CLI.
 */

import { randomBytes } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────

/** Lifecycle status of a long-running job. */
export type JobStatus =
  | "running" // actively executing — agent is handling an event
  | "waiting" // paused between interactions, ready to resume
  | "completed" // finished successfully (terminal)
  | "failed" // terminated due to an error or exceeded budget (terminal)
  | "cancelled"; // manually cancelled by an operator (terminal)

/**
 * Resource budget for a job across all of its interactions.
 * Set to 0 to indicate unlimited.
 */
export interface JobBudget {
  /** Maximum number of agent interactions (loop runs) for this job. 0 = unlimited. */
  maxSteps: number;
  /** Maximum wall-clock duration in ms from job creation. 0 = unlimited. */
  maxDurationMs: number;
}

/**
 * A Job is a named, stateful, long-running workflow that can span multiple
 * agent interactions over minutes to days.
 *
 * Unlike a Task (a single loop execution), a Job groups many interactions
 * under one envelope, carries shared state between steps, and enforces
 * cumulative budgets.
 */
export interface Job {
  /** Unique job identifier. Format: jbm_<hex16> */
  jobId: string;
  /** Session the job is attached to — all interactions use this session. */
  sessionId: string;
  /** Named workflow type, e.g. "onboard_customer", "process_return". */
  type: string;
  /** Current lifecycle status. */
  status: JobStatus;
  /** Number of completed agent interactions (loop runs) so far. */
  currentStep: number;
  /** Shared mutable state bag — persists across all steps. */
  state: Record<string, unknown>;
  /** Resource constraints for this job. */
  budget: JobBudget;
  /** ISO-8601 — when the job was created. */
  startedAt: string;
  /** ISO-8601 — last state change. */
  updatedAt: string;
  /** ISO-8601 — when the job reached a terminal state. Null while active. */
  completedAt: string | null;
  /** Error description if status is "failed". */
  error: string | null;
}

// ─── Adapter Interface ─────────────────────────────────────────

export interface JobAdapter {
  /** Persist a newly created job. */
  createJob(job: Job): Promise<void>;
  /** Retrieve a job by its ID. Returns null if not found. */
  getJob(jobId: string): Promise<Job | null>;
  /**
   * Find the active (running | waiting) job associated with a session.
   * Returns null if the session has no active job.
   */
  findActiveJobForSession(sessionId: string): Promise<Job | null>;
  /** List jobs with optional status and type filters. */
  listJobs(filter?: { status?: JobStatus; type?: string }): Promise<Job[]>;
  /** Apply a partial patch to an existing job. Silently no-ops for unknown IDs. */
  updateJob(
    jobId: string,
    patch: Partial<
      Pick<
        Job,
        | "status"
        | "currentStep"
        | "state"
        | "updatedAt"
        | "completedAt"
        | "error"
      >
    >,
  ): Promise<void>;
  /** Graceful teardown (close DB connections, flush caches, etc.). */
  close(): Promise<void>;
}

// ─── ID Generator ─────────────────────────────────────────────

/** Generate a unique job ID with the jbm_ prefix (matches Kader convention). */
export function generateJobId(): string {
  return `jbm_${randomBytes(8).toString("hex")}`;
}

// ─── In-Memory Implementation ──────────────────────────────────

/**
 * InMemoryJobAdapter — zero-dependency, in-process store.
 *
 * Suitable for development, testing, and single-instance demos.
 * State is not persisted across restarts.
 * Use SQLiteJobAdapter (MEMORY_PATH) for persistence.
 */
export class InMemoryJobAdapter implements JobAdapter {
  private readonly store = new Map<string, Job>();

  async createJob(job: Job): Promise<void> {
    this.store.set(job.jobId, { ...job });
  }

  async getJob(jobId: string): Promise<Job | null> {
    const job = this.store.get(jobId);
    return job ? { ...job } : null;
  }

  async findActiveJobForSession(sessionId: string): Promise<Job | null> {
    for (const job of this.store.values()) {
      if (
        job.sessionId === sessionId &&
        (job.status === "running" || job.status === "waiting")
      ) {
        return { ...job };
      }
    }
    return null;
  }

  async listJobs(filter?: {
    status?: JobStatus;
    type?: string;
  }): Promise<Job[]> {
    let jobs = Array.from(this.store.values());
    if (filter?.status) jobs = jobs.filter((j) => j.status === filter.status);
    if (filter?.type) jobs = jobs.filter((j) => j.type === filter.type);
    return jobs
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((j) => ({ ...j }));
  }

  async updateJob(
    jobId: string,
    patch: Partial<
      Pick<
        Job,
        | "status"
        | "currentStep"
        | "state"
        | "updatedAt"
        | "completedAt"
        | "error"
      >
    >,
  ): Promise<void> {
    const job = this.store.get(jobId);
    if (job) this.store.set(jobId, { ...job, ...patch });
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}
