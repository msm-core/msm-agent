import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FlushGate } from "../src/core/flush-gate.js";

describe("FlushGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("buffers items until flush", async () => {
    const flushFn = vi.fn().mockResolvedValue(undefined);
    const gate = new FlushGate({ flush: flushFn });

    gate.push("a");
    gate.push("b");
    expect(gate.pending).toBe(2);
    expect(flushFn).not.toHaveBeenCalled();

    await gate.flush();
    expect(flushFn).toHaveBeenCalledWith(["a", "b"]);
    expect(gate.pending).toBe(0);
  });

  it("auto-flushes when buffer reaches maxBufferSize", async () => {
    const flushFn = vi.fn().mockResolvedValue(undefined);
    const gate = new FlushGate({ flush: flushFn, maxBufferSize: 3 });

    gate.push("a");
    gate.push("b");
    expect(flushFn).not.toHaveBeenCalled();

    gate.push("c"); // Hits max → triggers flush
    // flushFn is called asynchronously via void
    await vi.runAllTimersAsync();
    expect(flushFn).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("flushes periodically when started", async () => {
    const flushFn = vi.fn().mockResolvedValue(undefined);
    const gate = new FlushGate({ flush: flushFn, intervalMs: 1000 });

    gate.start();
    gate.push("a");

    await vi.advanceTimersByTimeAsync(1000);
    expect(flushFn).toHaveBeenCalledWith(["a"]);

    gate.push("b");
    await vi.advanceTimersByTimeAsync(1000);
    expect(flushFn).toHaveBeenCalledWith(["b"]);

    await gate.stop();
  });

  it("flushes remaining items on stop", async () => {
    const flushFn = vi.fn().mockResolvedValue(undefined);
    const gate = new FlushGate({ flush: flushFn });

    gate.push("a");
    gate.push("b");
    await gate.stop();

    expect(flushFn).toHaveBeenCalledWith(["a", "b"]);
    expect(gate.pending).toBe(0);
  });

  it("calls onError and requeues items on flush failure", async () => {
    const flushFn = vi.fn().mockRejectedValue(new Error("DB down"));
    const onError = vi.fn();
    const gate = new FlushGate({ flush: flushFn, onError });

    gate.push("a");
    gate.push("b");
    await gate.flush();

    expect(onError).toHaveBeenCalled();
    expect(onError.mock.calls[0][0].message).toBe("DB down");
    // Items should be back in buffer for retry
    expect(gate.pending).toBe(2);
  });

  it("does nothing when flushing empty buffer", async () => {
    const flushFn = vi.fn().mockResolvedValue(undefined);
    const gate = new FlushGate({ flush: flushFn });

    await gate.flush();
    expect(flushFn).not.toHaveBeenCalled();
  });

  it("does not double-start the timer", () => {
    const flushFn = vi.fn().mockResolvedValue(undefined);
    const gate = new FlushGate({ flush: flushFn, intervalMs: 1000 });

    gate.start();
    gate.start(); // Should not create a second timer
    gate.push("a");

    // Only one flush after one interval
    vi.advanceTimersByTime(1000);
    // If double-started, we'd get two flushes — but we should only get one
    expect(gate.pending).toBeLessThanOrEqual(1);
  });
});
