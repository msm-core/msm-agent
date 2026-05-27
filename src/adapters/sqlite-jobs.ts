/**
 * SQLiteJobAdapter — persistent job store backed by node:sqlite (Node 22.12+).
 *
 * Uses the same SQLite file as SQLiteMemoryAdapter — pass the same MEMORY_PATH
 * and both adapters will coexist in one database file.
 *
 * Creates the `agent_jobs` table and its indexes on first use (idempotent).
 *
 * Activation: set ENABLE_JOBS=true alongside MEMORY_PATH in the CLI.
 */

import { DatabaseSync } from "node:sqlite";

import type { Job, JobAdapter, JobBudget, JobStatus } from "./jobs.js";

// ─── Schema ───────────────────────────────────────────────────

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS agent_jobs (
  job_id       TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 0,
  state        TEXT NOT NULL DEFAULT '{}',
  budget       TEXT NOT NULL DEFAULT '{}',
  started_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  completed_at TEXT,
  error        TEXT
)`;

const CREATE_INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_agent_jobs_session ON agent_jobs (session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agent_jobs_status  ON agent_jobs (status)`,
];

// ─── Row mapper ───────────────────────────────────────────────

function rowToJob(row: Record<string, unknown>): Job {
  return {
    jobId: row["job_id"] as string,
    sessionId: row["session_id"] as string,
    type: row["type"] as string,
    status: row["status"] as JobStatus,
    currentStep: row["current_step"] as number,
    state: JSON.parse(row["state"] as string) as Record<string, unknown>,
    budget: JSON.parse(row["budget"] as string) as JobBudget,
    startedAt: row["started_at"] as string,
    updatedAt: row["updated_at"] as string,
    completedAt: (row["completed_at"] as string | null) ?? null,
    error: (row["error"] as string | null) ?? null,
  };
}

// ─── Adapter ──────────────────────────────────────────────────

export class SQLiteJobAdapter implements JobAdapter {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(CREATE_TABLE);
    for (const sql of CREATE_INDEXES) {
      this.db.exec(sql);
    }
  }

  /**
   * Open (or create) a SQLite database at the given path and initialise the
   * agent_jobs schema. Safe to call on the same file as SQLiteMemoryAdapter.
   */
  static connect(dbPath: string): SQLiteJobAdapter {
    return new SQLiteJobAdapter(new DatabaseSync(dbPath));
  }

  async createJob(job: Job): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO agent_jobs
         (job_id, session_id, type, status, current_step, state, budget,
          started_at, updated_at, completed_at, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        job.jobId,
        job.sessionId,
        job.type,
        job.status,
        job.currentStep,
        JSON.stringify(job.state),
        JSON.stringify(job.budget),
        job.startedAt,
        job.updatedAt,
        job.completedAt,
        job.error,
      );
  }

  async getJob(jobId: string): Promise<Job | null> {
    const row = this.db
      .prepare("SELECT * FROM agent_jobs WHERE job_id = ?")
      .get(jobId) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }

  async findActiveJobForSession(sessionId: string): Promise<Job | null> {
    const row = this.db
      .prepare(
        `SELECT * FROM agent_jobs
         WHERE session_id = ? AND status IN ('running', 'waiting')
         LIMIT 1`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? rowToJob(row) : null;
  }

  async listJobs(filter?: {
    status?: JobStatus;
    type?: string;
  }): Promise<Job[]> {
    const wheres: string[] = [];
    const params: (string | number | null)[] = [];

    if (filter?.status) {
      wheres.push("status = ?");
      params.push(filter.status);
    }
    if (filter?.type) {
      wheres.push("type = ?");
      params.push(filter.type);
    }

    const where = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM agent_jobs ${where} ORDER BY started_at DESC`)
      .all(...params) as Record<string, unknown>[];

    return rows.map(rowToJob);
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
    const sets: string[] = [];
    const params: (string | number | null)[] = [];

    if (patch.status !== undefined) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.currentStep !== undefined) {
      sets.push("current_step = ?");
      params.push(patch.currentStep);
    }
    if (patch.state !== undefined) {
      sets.push("state = ?");
      params.push(JSON.stringify(patch.state));
    }
    if (patch.updatedAt !== undefined) {
      sets.push("updated_at = ?");
      params.push(patch.updatedAt);
    }
    if (patch.completedAt !== undefined) {
      sets.push("completed_at = ?");
      params.push(patch.completedAt);
    }
    if (patch.error !== undefined) {
      sets.push("error = ?");
      params.push(patch.error);
    }

    if (sets.length === 0) return;

    params.push(jobId);
    this.db
      .prepare(`UPDATE agent_jobs SET ${sets.join(", ")} WHERE job_id = ?`)
      .run(...params);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
