/**
 * InMemoryControlBus — Zero-infrastructure control bus for testing and demos.
 */

import type { ControlCommand } from "../core/types.js";
import type { ControlBusAdapter } from "../adapters/control-bus.js";

export class InMemoryControlBus implements ControlBusAdapter {
  private killedTasks = new Map<string, string>();
  private pausedTenants = new Map<string, string>();
  private disabledTools = new Map<string, string>();

  async isTaskKilled(taskId: string): Promise<string | null> {
    return this.killedTasks.get(taskId) ?? null;
  }

  async isTenantPaused(tenantId: string): Promise<string | null> {
    return this.pausedTenants.get(tenantId) ?? null;
  }

  async isToolDisabled(toolName: string): Promise<string | null> {
    return this.disabledTools.get(toolName) ?? null;
  }

  async execute(command: ControlCommand): Promise<void> {
    switch (command.type) {
      case "kill_task":
        this.killedTasks.set(command.taskId, command.reason);
        break;
      case "pause_tenant":
        this.pausedTenants.set(command.tenantId, command.reason);
        break;
      case "resume_tenant":
        this.pausedTenants.delete(command.tenantId);
        break;
      case "disable_tool":
        this.disabledTools.set(command.toolName, command.reason);
        break;
      case "enable_tool":
        this.disabledTools.delete(command.toolName);
        break;
    }
  }

  /** Test helper: clear all state */
  clear(): void {
    this.killedTasks.clear();
    this.pausedTenants.clear();
    this.disabledTools.clear();
  }
}
