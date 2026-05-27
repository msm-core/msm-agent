/**
 * TelemetryAdapter — observability interface for msm-agent.
 *
 * Implement this interface to connect any APM system (OpenTelemetry,
 * Datadog, New Relic, etc.). A no-op stub is used when no adapter
 * is supplied, so instrumentation is always zero-cost to configure.
 *
 * Example (no-op):
 *
 *   const telemetry: TelemetryAdapter = {
 *     startSpan: () => ({ end: () => {}, fail: () => {} }),
 *     recordMetric: () => {},
 *     recordError: () => {},
 *   };
 *
 * Example (console tracer for dev):
 *
 *   const telemetry: TelemetryAdapter = {
 *     startSpan(name, attrs) {
 *       const start = Date.now();
 *       return {
 *         end(a) { console.log(`[span] ${name}`, { ...attrs, ...a, ms: Date.now() - start }); },
 *         fail(e) { console.error(`[span:fail] ${name}`, e.message); },
 *       };
 *     },
 *     recordMetric(name, value, labels) { console.log(`[metric] ${name}=${value}`, labels); },
 *     recordError(error, ctx) { console.error(`[error]`, error, ctx); },
 *   };
 */

export interface TelemetrySpan {
  /**
   * End the span successfully.
   * @param attributes  Optional key/value pairs to attach to the completed span.
   */
  end(attributes?: Record<string, string | number>): void;

  /**
   * Mark the span as failed with an error.
   */
  fail(error: Error): void;
}

export interface TelemetryAdapter {
  /**
   * Start a new trace span.
   * The returned span must be ended (via .end() or .fail()) when the
   * operation completes.
   *
   * @param name        Human-readable operation name (e.g. "agent.loop.iteration").
   * @param attributes  Optional initial attributes for the span.
   */
  startSpan(
    name: string,
    attributes?: Record<string, string | number>,
  ): TelemetrySpan;

  /**
   * Record a numeric metric (counter, gauge, histogram).
   *
   * @param name   Metric name (e.g. "agent.tokens.used").
   * @param value  Numeric value.
   * @param labels Optional dimension labels.
   */
  recordMetric(
    name: string,
    value: number,
    labels?: Record<string, string>,
  ): void;

  /**
   * Report an error outside the context of a span (e.g. uncaught adapter errors).
   *
   * @param error    The error to report.
   * @param context  Optional key/value context for attribution.
   */
  recordError(error: Error, context?: Record<string, string>): void;
}

/** A no-op telemetry adapter. Use when APM is not configured. */
export const noopTelemetry: TelemetryAdapter = {
  startSpan: () => ({ end: () => {}, fail: () => {} }),
  recordMetric: () => {},
  recordError: () => {},
};
