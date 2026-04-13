/**
 * ControlBusAdapter — Runtime operability for the agent.
 *
 * Commands: PAUSE_TENANT, RESUME_TENANT, KILL_TASK, DISABLE_TOOL, ENABLE_TOOL
 * Checked every iteration of the execution loop.
 *
 * Production implementations typically use Redis with atomic operations.
 * The dummy adapter uses in-memory state for testing.
 */

import type { ControlCommand } from "../core/types.js";

export interface ControlBusAdapter {
  /** Check if a task has been killed. Returns abort reason or null. */
  isTaskKilled(taskId: string): Promise<string | null>;

  /** Check if a tenant is paused. Returns pause reason or null. */
  isTenantPaused(tenantId: string): Promise<string | null>;

  /** Check if a tool is disabled. Returns disable reason or null. */
  isToolDisabled(toolName: string): Promise<string | null>;

  /** Execute a control command */
  execute(command: ControlCommand): Promise<void>;
}
