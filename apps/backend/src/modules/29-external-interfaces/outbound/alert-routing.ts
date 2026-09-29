// apps/backend/src/modules/29-external-interfaces/outbound/alert-routing.ts — how an `OutboundAlert` intent becomes
// an M36 `AlertEmitter.emit()` input (F-186, #248). PURE.
//
// WHY THIS EXISTS. Until F-186 the worker passed the intent straight through, and three independent defects meant
// no outbound alert ever notified anyone (each proven live on the real emitter, `m29-alert-routing.live.test.ts`):
//   1. SEVERITY. M29's ladder is the §5.3 payload ladder (`HIGH` / `NORMAL`); the emitter takes the legacy
//      `alert_severity` enum (`info` / `warn` / `critical`). `alert.severity` is an enum column, so every emit threw
//      at the INSERT ("invalid input value for enum") — and the worker deliberately swallows alert failures, so the
//      only trace was a log line. The mapping below is the one place the two ladders meet.
//   2. NO RULE. No platform-default `alert_rule` existed for any of the three kinds (`packages/messaging/src/seed`),
//      so even a valid emit persisted an `alert` with zero recipients. The rules now exist; `OUTBOUND_ALERT_KINDS`
//      lets a test assert that none can be added without one.
//   3. PERMANENT DEDUPE. `alert` is unique on `(organization_id, correlation_id)` and `persist()` returns the existing
//      row without writing deliveries. The old id `m29-outbound:<kind>:<feedId>` never changed, so only the FIRST alert
//      of a kind per feed could ever notify anyone; every later incident was silently absorbed. The id now carries a
//      time WINDOW: one page per (kind, feed) per window — a retry storm on one feed pages once — and a condition that
//      is still true in the next window pages again.
import type { OutboundAlert } from "./outbound-events";

/** The `alert_severity` values the M36 emitter accepts (`packages/messaging` `AlertSeverity`). */
export type EmitterSeverity = "info" | "warn" | "critical";

/** M29 §5.3 ladder → the emitter's enum. HIGH pages (`critical`); NORMAL is an FYI that still routes (`warn`). */
export function toEmitterSeverity(severity: OutboundAlert["severity"]): EmitterSeverity {
  return severity === "HIGH" ? "critical" : "warn";
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long one (kind, feed) alert suppresses repeats. A failed/held transmission is per-message noise on a busy feed:
 * one page an hour. A BAA lapse blocks EVERY send for the feed and does not change within a day: one page a day (each
 * refused order still becomes `failed` with its own actionable reason, so no order is silent).
 */
export const OUTBOUND_ALERT_WINDOW_MS: Readonly<Record<OutboundAlert["kind"], number>> = {
  "hl7_outbound.transmission_failed": HOUR_MS,
  "external_feed.baa_expired": DAY_MS,
  "external_feed.baa_missing": DAY_MS,
};

/** `m29-outbound:<kind>:<feedId>:<window>` — stable inside a window, new in the next. */
export function outboundAlertCorrelationId(alert: OutboundAlert, now: Date): string {
  const window = Math.floor(now.getTime() / OUTBOUND_ALERT_WINDOW_MS[alert.kind]);
  return `m29-outbound:${alert.kind}:${alert.feedId}:${window}`;
}

/** The exact `AlertEmitter.emit()` input for an outbound alert intent. PHI-free by construction (ids + a summary). */
export function buildOutboundAlertEmit(
  alert: OutboundAlert,
  now: Date,
): {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
  readonly severity: EmitterSeverity;
  readonly correlationId: string;
} {
  return {
    eventType: alert.kind,
    payload: { feedId: alert.feedId, detail: alert.detail },
    severity: toEmitterSeverity(alert.severity),
    correlationId: outboundAlertCorrelationId(alert, now),
  };
}
