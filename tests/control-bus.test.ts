import { describe, it, expect } from "vitest";
import { InMemoryControlBus } from "../src/adapters-dummy/control-bus.js";

describe("InMemoryControlBus", () => {
  it("kill_task marks task as killed", async () => {
    const bus = new InMemoryControlBus();
    expect(await bus.isTaskKilled("t1")).toBeNull();

    await bus.execute({ type: "kill_task", taskId: "t1", reason: "Testing" });
    expect(await bus.isTaskKilled("t1")).toBe("Testing");
  });

  it("pause_tenant marks tenant as paused", async () => {
    const bus = new InMemoryControlBus();
    expect(await bus.isTenantPaused("tenant-1")).toBeNull();

    await bus.execute({
      type: "pause_tenant",
      tenantId: "tenant-1",
      reason: "Maintenance",
    });
    expect(await bus.isTenantPaused("tenant-1")).toBe("Maintenance");
  });

  it("resume_tenant unpauses tenant", async () => {
    const bus = new InMemoryControlBus();
    await bus.execute({
      type: "pause_tenant",
      tenantId: "tenant-1",
      reason: "Maintenance",
    });
    await bus.execute({ type: "resume_tenant", tenantId: "tenant-1" });
    expect(await bus.isTenantPaused("tenant-1")).toBeNull();
  });

  it("disable_tool marks tool as disabled", async () => {
    const bus = new InMemoryControlBus();
    expect(await bus.isToolDisabled("search")).toBeNull();

    await bus.execute({
      type: "disable_tool",
      toolName: "search",
      reason: "Rate limit exceeded",
    });
    expect(await bus.isToolDisabled("search")).toBe("Rate limit exceeded");
  });

  it("enable_tool re-enables a disabled tool", async () => {
    const bus = new InMemoryControlBus();
    await bus.execute({
      type: "disable_tool",
      toolName: "search",
      reason: "Rate limit exceeded",
    });
    await bus.execute({ type: "enable_tool", toolName: "search" });
    expect(await bus.isToolDisabled("search")).toBeNull();
  });

  it("clear() resets all state", async () => {
    const bus = new InMemoryControlBus();
    await bus.execute({ type: "kill_task", taskId: "t1", reason: "Testing" });
    await bus.execute({
      type: "pause_tenant",
      tenantId: "tenant-1",
      reason: "Testing",
    });
    await bus.execute({
      type: "disable_tool",
      toolName: "search",
      reason: "Testing",
    });

    bus.clear();
    expect(await bus.isTaskKilled("t1")).toBeNull();
    expect(await bus.isTenantPaused("tenant-1")).toBeNull();
    expect(await bus.isToolDisabled("search")).toBeNull();
  });
});
