/**
 * HTTP Server — Portable Agent Microservice
 *
 * Minimal HTTP server built on Node's built-in `http` module.
 * No framework. No extra runtime dependencies.
 *
 * Routes:
 *   GET  /health              → agent identity + readiness
 *   POST /v1/event            → process any AgentEvent, return LoopOutcome
 *   POST /chat                → stateless single-turn (generates fresh sessionId)
 *   GET  /session/:id         → session state: conversation + active task
 *   POST /task/approve        → approval callback for gated tool calls
 *
 * Admin routes (require DASHBOARD_PASSWORD via HTTP Basic Auth):
 *   GET  /dashboard           → self-contained ops dashboard HTML
 *   GET  /admin/state         → agent health + tracked control state
 *   POST /admin/control       → execute a ControlCommand
 *   GET  /admin/memory?q=     → search semantic memory
 *
 * Error handling:
 *   400 → malformed JSON or missing required fields
 *   401 → auth required for admin routes
 *   404 → unknown session or route
 *   405 → wrong HTTP method
 *   500 → internal agent error
 *
 * All responses are JSON except GET /dashboard (text/html).
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type {
  AgentHandle,
  AgentEvent,
  LoopOutcome,
  ControlCommand,
} from "../core/types.js";
import type { AgentHubHandle } from "../core/hub.js";
import { isAgentHub } from "../core/hub.js";
import type { AgentDefinition } from "../definition/index.js";
import type { MemoryAdapter } from "../adapters/memory.js";
import type { ControlBusAdapter } from "../adapters/control-bus.js";
import {
  WhatsAppEventAdapter,
  WebhookAuthError,
  WebhookParseError,
} from "../adapters/whatsapp-event.js";
import type { JobAdapter, Job, JobStatus } from "../adapters/jobs.js";
import { generateJobId } from "../adapters/jobs.js";
import { buildDashboardHtml } from "./dashboard.js";
import { z } from "zod";

// ─── AgentEvent Zod schema ────────────────────────────────────────────────────
// Mirrors the AgentEvent discriminated union in core/types.ts.
// Used to validate incoming HTTP payloads before they reach the loop.
const agentEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_message"),
    sessionId: z.string().min(1),
    text: z.string(),
    modality: z.enum(["text", "voice", "image"]),
  }),
  z.object({
    type: z.literal("tool_callback"),
    sessionId: z.string().min(1),
    taskId: z.string().min(1),
    result: z.object({ tool: z.string(), result: z.unknown() }),
  }),
  z.object({
    type: z.literal("approval_callback"),
    sessionId: z.string().min(1),
    taskId: z.string().min(1),
    approved: z.boolean(),
    decidedBy: z.string().optional(),
  }),
  z.object({
    type: z.literal("webhook"),
    sessionId: z.string().min(1),
    source: z.string(),
    payload: z.unknown(),
  }),
  z.object({
    type: z.literal("cron"),
    taskType: z.string().min(1),
    payload: z.unknown().optional(),
  }),
]);

export interface ServerOptions {
  port?: number;
  host?: string;
  /** Memory adapter — enables GET /session/:id and GET /admin/memory */
  memory?: MemoryAdapter;
  /** Control bus adapter — enables POST /admin/control */
  controlBus?: ControlBusAdapter;
  /**
   * If set, enables the ops dashboard at GET /dashboard and all /admin/* routes.
   * Protected by HTTP Basic Auth (password only — username is ignored).
   * If absent, dashboard and admin routes return 404.
   */
  dashboardPassword?: string;
  /**
   * WhatsApp event adapter — enables POST /webhook/whatsapp.
   * The Kader whatsapp-gateway should be configured to POST inbound messages here.
   * Absent = /webhook/whatsapp returns 404.
   */
  whatsAppEvents?: WhatsAppEventAdapter;
  /**
   * Job adapter — enables the /jobs/* routes and per-session budget enforcement.
   * Absent = /jobs routes return 404 and no budget tracking is applied.
   * Enable via ENABLE_JOBS=true in the CLI.
   */
  jobs?: JobAdapter;
  /**
   * Optional Bearer API key.
   * When set, all routes except GET /health require
   *   Authorization: Bearer <apiKey>
   * Callers without the key receive 401.
   * Use this when the agent is exposed beyond a trusted network boundary.
   */
  apiKey?: string;
  /**
   * Sovereign mode flag — Phase 16.
   * When true, the /health response includes `"sovereign": true` to confirm
   * that no cloud credentials are in use and all processing is local.
   * Set automatically by cli.ts when SOVEREIGN=true is in the environment.
   */
  sovereign?: boolean;
}

// ─── Dashboard state ─────────────────────────────────────────
// Tracks commands issued via POST /admin/control in this server process.
// This gives the dashboard a live view of what's been commanded without
// requiring a "list all" method on the control bus adapter.

interface DashboardControlState {
  killedTasks: string[];
  pausedTenants: string[];
  disabledTools: string[];
}

function emptyControlState(): DashboardControlState {
  return { killedTasks: [], pausedTenants: [], disabledTools: [] };
}

// ─── Helpers ─────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MB hard limit

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("413"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/**
 * Check HTTP Basic Auth against the configured dashboard password.
 * Uses constant-time comparison to prevent timing attacks.
 * Username is ignored — only the password is checked.
 */
function checkBasicAuth(req: IncomingMessage, password: string): boolean {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Basic ")) return false;
  const encoded = header.slice(6);
  let decoded: string;
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf-8");
  } catch {
    return false;
  }
  // Format is "username:password" — extract password after first colon
  const colonIdx = decoded.indexOf(":");
  const supplied = colonIdx >= 0 ? decoded.slice(colonIdx + 1) : decoded;
  try {
    const a = Buffer.from(supplied);
    const b = Buffer.from(password);
    // Reject on length mismatch before constant-time compare to avoid length oracle.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Check Bearer API key for non-admin routes.
 * Uses constant-time comparison to prevent timing attacks.
 */
function checkApiKey(req: IncomingMessage, apiKey: string): boolean {
  const header = req.headers["authorization"];
  if (!header || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice(7).trim();
  try {
    const a = Buffer.from(supplied);
    const b = Buffer.from(apiKey);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  password: string | undefined,
): boolean {
  if (!password) {
    json(res, 404, { error: "Not found" });
    return false;
  }
  if (!checkBasicAuth(req, password)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="msm-agent ops"',
      "Content-Type": "application/json",
    });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return false;
  }
  return true;
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    // Prevent the browser from caching the dashboard (stale password risk)
    "Cache-Control": "no-store",
  });
  res.end(body);
}

// ─── Route handlers ──────────────────────────────────────────

async function handleHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  def: AgentDefinition,
  sovereign?: boolean,
): Promise<void> {
  json(res, 200, {
    status: "ok",
    ready: true,
    name: def.name,
    domain: def.domain,
    provider: def.brain.provider,
    brain: def.brain.model ?? def.brain.provider,
    capabilities: def.capabilities,
    ...(sovereign ? { sovereign: true } : {}),
  });
}

async function handleEvent(
  req: IncomingMessage,
  res: ServerResponse,
  agent: AgentHandle,
  jobs?: JobAdapter,
): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed. Use POST." });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: "Failed to read request body" });
    return;
  }

  let event: AgentEvent;
  try {
    const raw: unknown = JSON.parse(body);
    const parsed = agentEventSchema.safeParse(raw);
    if (!parsed.success) {
      json(res, 400, {
        error: "Invalid event payload",
        detail: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
      });
      return;
    }
    event = parsed.data as AgentEvent;
  } catch {
    json(res, 400, { error: "Invalid JSON in request body" });
    return;
  }

  // Job budget enforcement — apply when a jobs adapter is configured and the
  // event carries a sessionId (all event types except "cron" do).
  if (jobs && "sessionId" in event && typeof event.sessionId === "string") {
    let result: BudgetRunResult;
    try {
      result = await runWithJobBudget(event.sessionId, jobs, () =>
        agent.handleEvent(event),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      json(res, 500, { error: "Agent processing error", detail: message });
      return;
    }
    if (result.budgetExceeded) {
      json(res, 402, { error: "Job budget exceeded", jobId: result.jobId });
      return;
    }
    json(res, 200, result.outcome);
    return;
  }

  let outcome: LoopOutcome;
  try {
    outcome = await agent.handleEvent(event);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: "Agent processing error", detail: message });
    return;
  }

  json(res, 200, outcome);
}

/**
 * POST /chat — stateless single-turn.
 *
 * Accepts:
 *   { message: string, language?: string, modality?: "text"|"voice"|"image" }
 *
 * Each call gets a fresh sessionId (no conversation history carried across calls).
 * Returns: { sessionId, outcome }
 *
 * Use POST /v1/event with a stable sessionId if you need conversation continuity.
 */
async function handleChat(
  req: IncomingMessage,
  res: ServerResponse,
  agent: AgentHandle,
): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed. Use POST." });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: "Failed to read request body" });
    return;
  }

  let parsed: { message?: string; language?: string; modality?: string };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    json(res, 400, { error: "Invalid JSON in request body" });
    return;
  }

  if (!parsed.message || typeof parsed.message !== "string") {
    json(res, 400, { error: 'Missing required field: "message"' });
    return;
  }

  const sessionId = randomUUID();
  const event: AgentEvent = {
    type: "user_message",
    sessionId,
    text: parsed.message,
    modality:
      parsed.modality === "voice" || parsed.modality === "image"
        ? parsed.modality
        : "text",
  };

  let outcome: LoopOutcome;
  try {
    outcome = await agent.handleEvent(event);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: "Agent processing error", detail: message });
    return;
  }

  json(res, 200, { sessionId, outcome });
}

/**
 * GET /session/:id — session state inspection.
 *
 * Returns: { sessionId, messages, activeTask }
 *
 * Requires memory to be passed into createAgentServer options.
 * Returns 404 if the session has no messages on record.
 */
async function handleSession(
  _req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  memory: MemoryAdapter | undefined,
): Promise<void> {
  if (!memory) {
    json(res, 503, {
      error: "Session inspection not available — no memory adapter configured",
    });
    return;
  }

  const [messages, activeTask] = await Promise.all([
    memory.getConversation(sessionId),
    memory.getActiveTask?.(sessionId) ?? Promise.resolve(null),
  ]);

  if (messages.length === 0 && !activeTask) {
    json(res, 404, { error: `No session found for id: ${sessionId}` });
    return;
  }

  json(res, 200, { sessionId, messages, activeTask });
}

/**
 * POST /task/approve — human approval callback for gated tool calls.
 *
 * Accepts:
 *   { sessionId: string, taskId: string, approved: boolean, decidedBy?: string }
 *
 * Translates into an `approval_callback` AgentEvent and sends it through the
 * loop. The loop handles the waiting_approval → resume flow.
 *
 * Returns the LoopOutcome that results from resuming the task.
 */
async function handleApprove(
  req: IncomingMessage,
  res: ServerResponse,
  agent: AgentHandle,
): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed. Use POST." });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: "Failed to read request body" });
    return;
  }

  let parsed: {
    sessionId?: string;
    taskId?: string;
    approved?: boolean;
    decidedBy?: string;
  };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    json(res, 400, { error: "Invalid JSON in request body" });
    return;
  }

  if (!parsed.sessionId || !parsed.taskId || parsed.approved === undefined) {
    json(res, 400, {
      error: 'Missing required fields: "sessionId", "taskId", "approved"',
    });
    return;
  }

  if (typeof parsed.approved !== "boolean") {
    json(res, 400, { error: '"approved" must be a boolean' });
    return;
  }

  const event: AgentEvent = {
    type: "approval_callback",
    sessionId: parsed.sessionId,
    taskId: parsed.taskId,
    approved: parsed.approved,
    decidedBy: parsed.decidedBy,
  };

  let outcome: LoopOutcome;
  try {
    outcome = await agent.handleEvent(event);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: "Approval processing error", detail: message });
    return;
  }

  json(res, 200, outcome);
}

// ─── Admin route handlers ─────────────────────────────────────

/**
 * GET /dashboard — serves the self-contained ops dashboard HTML.
 * Requires dashboardPassword to be set in ServerOptions.
 * The HTML page handles its own auth (password stored in sessionStorage).
 */
function handleDashboard(
  _req: IncomingMessage,
  res: ServerResponse,
  def: AgentDefinition,
): void {
  html(res, 200, buildDashboardHtml(def.name));
}

/**
 * GET /admin/state — returns agent health + tracked control state.
 * Used by the dashboard to populate all panels on load and on every poll.
 */
async function handleAdminState(
  _req: IncomingMessage,
  res: ServerResponse,
  def: AgentDefinition,
  memory: MemoryAdapter | undefined,
  controlState: DashboardControlState,
): Promise<void> {
  json(res, 200, {
    health: {
      status: "ok",
      ready: true,
      name: def.name,
      domain: def.domain,
      provider: def.brain.provider,
      brain: def.brain.model ?? def.brain.provider,
      capabilities: def.capabilities,
    },
    controlState,
    memoryEnabled: !!memory,
    // Pending approvals require a listTasks() method not currently in MemoryAdapter.
    // Populated in a future release; dashboard handles empty array gracefully.
    pendingApprovals: [],
  });
}

/**
 * POST /admin/control — execute a ControlCommand and track local state.
 *
 * Accepts: a ControlCommand object (see ControlBusAdapter.execute).
 * Returns: { ok: true, controlState }
 */
async function handleAdminControl(
  req: IncomingMessage,
  res: ServerResponse,
  controlBus: ControlBusAdapter | undefined,
  controlState: DashboardControlState,
): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed. Use POST." });
    return;
  }

  if (!controlBus) {
    json(res, 503, {
      error: "Control bus not available — no controlBus adapter configured",
    });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: "Failed to read request body" });
    return;
  }

  let cmd: ControlCommand;
  try {
    cmd = JSON.parse(body) as ControlCommand;
  } catch {
    json(res, 400, { error: "Invalid JSON in request body" });
    return;
  }

  if (!cmd.type) {
    json(res, 400, { error: 'Missing required field: "type"' });
    return;
  }

  try {
    await controlBus.execute(cmd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: "Control bus error", detail: message });
    return;
  }

  // Update local tracking state so the dashboard reflects the change immediately.
  applyCommandToState(controlState, cmd);

  json(res, 200, { ok: true, controlState });
}

function applyCommandToState(
  state: DashboardControlState,
  cmd: ControlCommand,
): void {
  switch (cmd.type) {
    case "kill_task":
      if (!state.killedTasks.includes(cmd.taskId)) {
        state.killedTasks.push(cmd.taskId);
      }
      break;
    case "pause_tenant":
      if (!state.pausedTenants.includes(cmd.tenantId)) {
        state.pausedTenants.push(cmd.tenantId);
      }
      break;
    case "resume_tenant":
      state.pausedTenants = state.pausedTenants.filter(
        (id) => id !== cmd.tenantId,
      );
      break;
    case "disable_tool":
      if (!state.disabledTools.includes(cmd.toolName)) {
        state.disabledTools.push(cmd.toolName);
      }
      break;
    case "enable_tool":
      state.disabledTools = state.disabledTools.filter(
        (n) => n !== cmd.toolName,
      );
      break;
  }
}

/**
 * GET /admin/memory?q=<query>&limit=<n> — search semantic memory.
 * Requires a memory adapter with a search() method.
 */
async function handleAdminMemory(
  req: IncomingMessage,
  res: ServerResponse,
  memory: MemoryAdapter | undefined,
): Promise<void> {
  if (!memory) {
    json(res, 503, {
      error: "Memory search not available — no memory adapter configured",
    });
    return;
  }

  if (!memory.search) {
    json(res, 503, {
      error:
        "Memory search not available — current adapter does not support search()",
    });
    return;
  }

  const rawUrl = req.url ?? "";
  const qIdx = rawUrl.indexOf("?");
  const params = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "");
  const q = params.get("q") ?? "";
  const limit = Math.min(parseInt(params.get("limit") ?? "10", 10), 50);

  if (!q.trim()) {
    json(res, 400, { error: 'Missing required query parameter: "q"' });
    return;
  }

  try {
    const entries = await memory.search(q, limit);
    json(res, 200, { entries, total: entries.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: "Memory search error", detail: message });
  }
}

/**
 * POST /webhook/whatsapp — inbound message webhook from the Kader WhatsApp Gateway.
 *
 * The gateway POSTs each inbound WhatsApp message here after authentication.
 * The payload is verified using HMAC-SHA256 (x-dalil-signature header).
 * On success, responds 200 immediately (fast ACK) then dispatches async.
 */
async function handleWhatsAppWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  adapter: WhatsAppEventAdapter,
): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed. Use POST." });
    return;
  }

  let rawBody: string;
  try {
    rawBody = await readBody(req);
  } catch {
    json(res, 400, { error: "Failed to read request body" });
    return;
  }

  const signature = req.headers["x-dalil-signature"];
  const sigStr = typeof signature === "string" ? signature : null;

  try {
    await adapter.handleWebhook(rawBody, sigStr);
    json(res, 200, { ok: true });
  } catch (err) {
    if (err instanceof WebhookAuthError) {
      json(res, 401, { error: err.message });
      return;
    }
    if (err instanceof WebhookParseError) {
      json(res, 400, { error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    json(res, 500, { error: "Webhook processing error", detail: message });
  }
}

// ─── Job budget enforcement ───────────────────────────────────

/**
 * Run an agent event handler while enforcing the active job's budget.
 *
 * If the session has an active job:
 *   - Budget exceeded before the run → job is failed; returns { budgetExceeded: true }.
 *   - Error during the run → job is marked failed; error is re-thrown.
 *   - Success → job step count is incremented; terminal outcomes complete the job.
 *
 * If the session has no active job, the run proceeds with no tracking.
 */
type BudgetRunResult =
  | { budgetExceeded: true; jobId: string }
  | { budgetExceeded: false; outcome: LoopOutcome };

async function runWithJobBudget(
  sessionId: string,
  jobs: JobAdapter,
  run: () => Promise<LoopOutcome>,
): Promise<BudgetRunResult> {
  const job = await jobs.findActiveJobForSession(sessionId);

  if (job) {
    const elapsed = Date.now() - new Date(job.startedAt).getTime();
    const exceeded =
      (job.budget.maxSteps > 0 && job.currentStep >= job.budget.maxSteps) ||
      (job.budget.maxDurationMs > 0 && elapsed >= job.budget.maxDurationMs);

    if (exceeded) {
      const ts = new Date().toISOString();
      await jobs.updateJob(job.jobId, {
        status: "failed",
        updatedAt: ts,
        completedAt: ts,
        error: "budget_exceeded",
      });
      return { budgetExceeded: true, jobId: job.jobId };
    }
  }

  let outcome: LoopOutcome;
  try {
    outcome = await run();
  } catch (err) {
    if (job) {
      const ts = new Date().toISOString();
      // Best-effort update — don't mask the original error.
      await jobs
        .updateJob(job.jobId, {
          currentStep: job.currentStep + 1,
          updatedAt: ts,
          status: "failed",
          completedAt: ts,
          error: err instanceof Error ? err.message : String(err),
        })
        .catch(() => {});
    }
    throw err;
  }

  if (job) {
    // Terminal outcomes mark the job as completed.
    const terminal =
      outcome.type === "response" ||
      outcome.type === "escalated" ||
      outcome.type === "error" ||
      outcome.type === "aborted";

    const ts = new Date().toISOString();
    await jobs.updateJob(job.jobId, {
      currentStep: job.currentStep + 1,
      updatedAt: ts,
      status: terminal ? "completed" : "waiting",
      completedAt: terminal ? ts : null,
    });
  }

  return { budgetExceeded: false, outcome };
}

// ─── Job route handlers ───────────────────────────────────────

/**
 * POST /jobs — create a new long-running job.
 *
 * Body: { type: string, sessionId?: string, budget?: JobBudget, state?: object }
 * Returns: { jobId, sessionId, status, type }
 *
 * The job starts in "running" status. Send a POST /v1/event or POST /chat
 * with the returned sessionId to start the first step.
 */
async function handleCreateJob(
  req: IncomingMessage,
  res: ServerResponse,
  jobs: JobAdapter,
): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed. Use POST." });
    return;
  }

  let body: string;
  try {
    body = await readBody(req);
  } catch {
    json(res, 400, { error: "Failed to read request body" });
    return;
  }

  let parsed: {
    type?: string;
    sessionId?: string;
    budget?: { maxSteps?: number; maxDurationMs?: number };
    state?: Record<string, unknown>;
  };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    json(res, 400, { error: "Invalid JSON in request body" });
    return;
  }

  if (!parsed.type || typeof parsed.type !== "string") {
    json(res, 400, { error: 'Missing required field: "type"' });
    return;
  }

  const now = new Date().toISOString();
  const job: Job = {
    jobId: generateJobId(),
    sessionId: parsed.sessionId ?? randomUUID(),
    type: parsed.type,
    status: "running",
    currentStep: 0,
    state: parsed.state ?? {},
    budget: {
      maxSteps: parsed.budget?.maxSteps ?? 0,
      maxDurationMs: parsed.budget?.maxDurationMs ?? 0,
    },
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    error: null,
  };

  await jobs.createJob(job);
  json(res, 201, {
    jobId: job.jobId,
    sessionId: job.sessionId,
    status: job.status,
    type: job.type,
  });
}

/** GET /jobs — list all jobs with optional ?status= and ?type= filters. */
async function handleListJobs(
  req: IncomingMessage,
  res: ServerResponse,
  jobs: JobAdapter,
): Promise<void> {
  if (req.method !== "GET") {
    json(res, 405, { error: "Method not allowed. Use GET." });
    return;
  }

  const rawUrl = req.url ?? "";
  const qIdx = rawUrl.indexOf("?");
  const params = new URLSearchParams(qIdx >= 0 ? rawUrl.slice(qIdx + 1) : "");
  const statusParam = params.get("status") as JobStatus | null;
  const typeParam = params.get("type") ?? undefined;

  const list = await jobs.listJobs({
    status: statusParam ?? undefined,
    type: typeParam,
  });
  json(res, 200, { jobs: list, total: list.length });
}

/** GET /jobs/:id — retrieve a single job by its ID. */
async function handleGetJob(
  _req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  jobs: JobAdapter,
): Promise<void> {
  const job = await jobs.getJob(jobId);
  if (!job) {
    json(res, 404, { error: `Job not found: ${jobId}` });
    return;
  }
  json(res, 200, job);
}

/**
 * POST /jobs/:id/cancel — cancel an active job.
 *
 * Returns 409 if the job is already in a terminal state.
 */
async function handleCancelJob(
  req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
  jobs: JobAdapter,
): Promise<void> {
  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed. Use POST." });
    return;
  }

  const job = await jobs.getJob(jobId);
  if (!job) {
    json(res, 404, { error: `Job not found: ${jobId}` });
    return;
  }

  if (
    job.status === "completed" ||
    job.status === "failed" ||
    job.status === "cancelled"
  ) {
    json(res, 409, { error: `Job is already ${job.status}` });
    return;
  }

  const ts = new Date().toISOString();
  await jobs.updateJob(jobId, {
    status: "cancelled",
    updatedAt: ts,
    completedAt: ts,
  });
  json(res, 200, { jobId, status: "cancelled" });
}

// ─── Hub route handlers ──────────────────────────────────────

/**
 * GET /health (hub mode) — returns status of all registered agents.
 */
function handleHubHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  hub: AgentHubHandle,
  defs: Record<string, AgentDefinition>,
  sovereign?: boolean,
): void {
  const agents: Record<string, unknown> = {};
  for (const name of hub.agentNames()) {
    const def = defs[name];
    agents[name] = def
      ? {
          status: "ok",
          ready: true,
          name: def.name,
          domain: def.domain,
          provider: def.brain.provider,
          brain: def.brain.model ?? def.brain.provider,
          capabilities: def.capabilities,
        }
      : { status: "ok", ready: true };
  }
  json(res, 200, {
    status: "ok",
    ready: true,
    agentCount: hub.agentNames().length,
    agents,
    ...(sovereign ? { sovereign: true } : {}),
  });
}

// ─── Server factory ──────────────────────────────────────────

export function createAgentServer(
  agent: AgentHandle | AgentHubHandle,
  def: AgentDefinition | Record<string, AgentDefinition>,
  opts: ServerOptions = {},
): { start: () => Promise<void>; stop: () => Promise<void> } {
  const port = opts.port ?? 3000;
  const host = opts.host ?? "0.0.0.0";
  const {
    memory,
    controlBus,
    dashboardPassword,
    whatsAppEvents,
    jobs,
    sovereign,
    apiKey,
  } = opts;
  const controlState = emptyControlState();

  // Detect hub vs single-agent mode.
  const hub = isAgentHub(agent) ? agent : null;
  const singleAgent = hub ? null : (agent as AgentHandle);
  const singleDef = hub ? null : (def as AgentDefinition);
  const hubDefs = hub ? (def as Record<string, AgentDefinition>) : {};

  const server = createServer((req, res) => {
    // Strip query string for routing; preserve full URL for admin/memory
    const url = req.url?.split("?")[0] ?? "/";

    // GET /health — always unauthenticated (liveness/readiness probes)
    if (url === "/health" && req.method === "GET") {
      if (hub) {
        handleHubHealth(req, res, hub, hubDefs, sovereign);
      } else {
        handleHealth(req, res, singleDef!, sovereign).catch((err) => {
          json(res, 500, { error: String(err) });
        });
      }
      return;
    }

    // API key guard — applies to all routes below when apiKey is configured.
    if (apiKey && !checkApiKey(req, apiKey)) {
      json(res, 401, { error: "Unauthorized — missing or invalid API key" });
      return;
    }

    // ── Hub routes: /agents/:name/* ───────────────────────────
    const agentRouteMatch = url.match(/^\/agents\/([^/]+)(\/.*)?$/);
    if (agentRouteMatch && hub) {
      const agentName = decodeURIComponent(agentRouteMatch[1]!);
      const subPath = agentRouteMatch[2] ?? "/";
      const agentHandle = hub.agents[agentName];

      if (!agentHandle) {
        json(res, 404, {
          error: `No agent registered as "${agentName}". Available: ${hub.agentNames().join(", ")}`,
        });
        return;
      }

      // GET /agents/:name/health
      if (subPath === "/health" && req.method === "GET") {
        const agentDef = hubDefs[agentName];
        if (agentDef) {
          handleHealth(req, res, agentDef, sovereign).catch((err) => {
            json(res, 500, { error: String(err) });
          });
        } else {
          json(res, 200, { status: "ok", ready: true, name: agentName });
        }
        return;
      }

      // POST /agents/:name/event
      if (subPath === "/event") {
        handleEvent(req, res, agentHandle, jobs).catch((err) => {
          json(res, 500, { error: String(err) });
        });
        return;
      }

      // POST /agents/:name/chat
      if (subPath === "/chat") {
        handleChat(req, res, agentHandle).catch((err) => {
          json(res, 500, { error: String(err) });
        });
        return;
      }

      // GET /agents/:name/session/:id
      const agentSessionMatch = subPath.match(/^\/session\/([^/]+)$/);
      if (agentSessionMatch && req.method === "GET") {
        const sessionId = decodeURIComponent(agentSessionMatch[1]!);
        handleSession(req, res, sessionId, memory).catch((err) => {
          json(res, 500, { error: String(err) });
        });
        return;
      }

      // POST /agents/:name/task/approve
      if (subPath === "/task/approve") {
        handleApprove(req, res, agentHandle).catch((err) => {
          json(res, 500, { error: String(err) });
        });
        return;
      }

      json(res, 404, {
        error: `No route for ${req.method} /agents/${agentName}${subPath}`,
      });
      return;
    }

    // ── Single-agent routes (unchanged) ──────────────────────

    // POST /v1/event — generic event ingress
    if (url === "/v1/event") {
      if (!singleAgent) {
        json(res, 404, { error: "Use /agents/:name/event in hub mode" });
        return;
      }
      handleEvent(req, res, singleAgent, jobs).catch((err) => {
        json(res, 500, { error: String(err) });
      });
      return;
    }

    // POST /chat — stateless single-turn
    if (url === "/chat") {
      if (!singleAgent) {
        json(res, 404, { error: "Use /agents/:name/chat in hub mode" });
        return;
      }
      handleChat(req, res, singleAgent).catch((err) => {
        json(res, 500, { error: String(err) });
      });
      return;
    }

    // GET /session/:id — session state inspection
    const sessionMatch = url.match(/^\/session\/([^/]+)$/);
    if (sessionMatch && req.method === "GET") {
      const sessionId = decodeURIComponent(sessionMatch[1]!);
      handleSession(req, res, sessionId, memory).catch((err) => {
        json(res, 500, { error: String(err) });
      });
      return;
    }

    // POST /task/approve — approval callback
    if (url === "/task/approve") {
      if (!singleAgent) {
        json(res, 404, { error: "Use /agents/:name/task/approve in hub mode" });
        return;
      }
      handleApprove(req, res, singleAgent).catch((err) => {
        json(res, 500, { error: String(err) });
      });
      return;
    }

    // ── Admin / Dashboard routes ─────────────────────────────

    // GET /dashboard — ops dashboard HTML (no auth on HTML itself; JS prompts for password)
    if (url === "/dashboard" && req.method === "GET") {
      if (!dashboardPassword) {
        json(res, 404, { error: "Not found" });
        return;
      }
      const dashboardName =
        singleDef?.name ?? `Hub (${hub?.agentNames().join(", ")})`;
      handleDashboard(req, res, { name: dashboardName } as AgentDefinition);
      return;
    }

    // GET /admin/state — health + control state (auth required)
    if (url === "/admin/state" && req.method === "GET") {
      if (!requireAuth(req, res, dashboardPassword)) return;
      const stateDef =
        singleDef ??
        ({
          name: `Hub (${hub?.agentNames().join(", ")})`,
          domain: "multi-agent",
          brain: { provider: "mixed" },
          capabilities: hub?.agentNames() ?? [],
        } as unknown as AgentDefinition);
      handleAdminState(req, res, stateDef, memory, controlState).catch(
        (err) => {
          json(res, 500, { error: String(err) });
        },
      );
      return;
    }

    // POST /admin/control — execute ControlCommand (auth required)
    if (url === "/admin/control") {
      if (!requireAuth(req, res, dashboardPassword)) return;
      handleAdminControl(req, res, controlBus, controlState).catch((err) => {
        json(res, 500, { error: String(err) });
      });
      return;
    }

    // GET /admin/memory?q= — memory search (auth required)
    if (url === "/admin/memory" && req.method === "GET") {
      if (!requireAuth(req, res, dashboardPassword)) return;
      handleAdminMemory(req, res, memory).catch((err) => {
        json(res, 500, { error: String(err) });
      });
      return;
    }

    // POST /webhook/whatsapp — inbound message from Kader WhatsApp Gateway
    if (url === "/webhook/whatsapp") {
      if (!whatsAppEvents) {
        json(res, 404, { error: "Not found" });
        return;
      }
      handleWhatsAppWebhook(req, res, whatsAppEvents).catch((err) => {
        json(res, 500, { error: String(err) });
      });
      return;
    }

    // ── Jobs routes ───────────────────────────────────────────

    // POST /jobs — create a job   GET /jobs — list jobs
    if (url === "/jobs") {
      if (!jobs) {
        json(res, 404, { error: "Not found" });
        return;
      }
      if (req.method === "POST") {
        handleCreateJob(req, res, jobs).catch((err) => {
          json(res, 500, { error: String(err) });
        });
      } else if (req.method === "GET") {
        handleListJobs(req, res, jobs).catch((err) => {
          json(res, 500, { error: String(err) });
        });
      } else {
        json(res, 405, { error: "Method not allowed" });
      }
      return;
    }

    // GET /jobs/:id   POST /jobs/:id/cancel
    const jobMatch = url.match(/^\/jobs\/([^/]+)(\/cancel)?$/);
    if (jobMatch) {
      if (!jobs) {
        json(res, 404, { error: "Not found" });
        return;
      }
      const jobId = decodeURIComponent(jobMatch[1]!);
      const isCancel = !!jobMatch[2];
      if (isCancel) {
        handleCancelJob(req, res, jobId, jobs).catch((err) => {
          json(res, 500, { error: String(err) });
        });
      } else {
        handleGetJob(req, res, jobId, jobs).catch((err) => {
          json(res, 500, { error: String(err) });
        });
      }
      return;
    }

    json(res, 404, { error: `No route for ${req.method} ${url}` });
  });

  return {
    start(): Promise<void> {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          if (hub) {
            console.log(
              `[msm-agent] Hub running on http://${host}:${port} — agents: ${hub.agentNames().join(", ")}`,
            );
            for (const name of hub.agentNames()) {
              console.log(
                `[msm-agent]   POST http://${host}:${port}/agents/${name}/event`,
              );
            }
          } else {
            console.log(
              `[msm-agent] ${singleDef!.name} running on http://${host}:${port}`,
            );
          }
          console.log(`[msm-agent] Health: http://${host}:${port}/health`);
          if (dashboardPassword) {
            console.log(
              `[msm-agent] Dashboard: http://${host}:${port}/dashboard`,
            );
          }
          if (whatsAppEvents) {
            console.log(
              `[msm-agent] WhatsApp webhook: http://${host}:${port}/webhook/whatsapp`,
            );
          }
          if (jobs) {
            console.log(`[msm-agent] Jobs API: http://${host}:${port}/jobs`);
          }
          resolve();
        });
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
