// apps/backend/src/modules/29-external-interfaces/outbound/alert-routing.ts — how an `OutboundAlert` intent becomes
// an M36 `AlertEmitter.emit()` input (F-188, #248). PURE.
//
// WHY THIS EXISTS. Until F-188 the worker passed the intent straight through, and three independent defects meant
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
  // F-196 — same window as the failures it escalates, so the escalation is once per (feed, window) too.
  "hl7_outbound.transmission_storm": HOUR_MS,
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

// ── F-196 — STORMS: count the repeats the window absorbs, and escalate once when a feed is clearly down ─────────
//
// F-188's window means a retry storm pages ONCE — the right thing for a pager, but it made the storm invisible: the
// 2nd..200th failing order changed nothing on the alert, so an operator could not tell "one flaky message" from "the
// lab endpoint is down". Two additions, both opt-in through the emitter and neither pages more than once per window:
//   1. COUNT. Every emit asks M36 to count an absorbed repeat (`countRepeats`): the alert's `payload.occurrences`
//      is 1 at birth and +1 per repeat, atomically, with NO new delivery. The in-app alert inbox shows the number.
//      The row-less refusals (a lapsed BAA or a misconfigured feed refuses every order and writes no outbound row)
//      cannot be counted from `hl7_message_outbound`, which is why the count lives in the alert persistence.
//   2. ESCALATE. When the count reaches the threshold EXACTLY, raise ONE `hl7_outbound.transmission_storm` alert
//      (`critical`, its own correlation id, so M36's dedupe bounds it to once per window even if two workers race).
//      Exact equality on an atomic counter means exactly one caller sees the threshold.
// BAA kinds are counted but never escalated: they are one standing condition (already `critical`, already a 24h
// window), not a rate of independent failures.

/** How many failures in one window (per feed) raise the escalation. Documented default; override with the env below. */
export const DEFAULT_STORM_THRESHOLD = 10;
const MIN_STORM_THRESHOLD = 2;
const MAX_STORM_THRESHOLD = 100_000;

/** `M29_ALERT_STORM_THRESHOLD` (integer, 2..100000), else {@link DEFAULT_STORM_THRESHOLD}. A bad value FALLS BACK — it
 *  must never disable escalation by accident (NaN would never equal a count). */
export function resolveStormThreshold(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.M29_ALERT_STORM_THRESHOLD;
  if (raw === undefined || raw.trim() === "") return DEFAULT_STORM_THRESHOLD;
  const n = Number(raw);
  return Number.isInteger(n) && n >= MIN_STORM_THRESHOLD && n <= MAX_STORM_THRESHOLD ? n : DEFAULT_STORM_THRESHOLD;
}

/** Which kinds escalate, and to what. Only the per-message failure kind is a RATE worth escalating. */
const STORM_ESCALATION: Partial<Record<OutboundAlert["kind"], OutboundAlert["kind"]>> = {
  "hl7_outbound.transmission_failed": "hl7_outbound.transmission_storm",
};

/** The escalation's exact `emit()` input. PHI-free: a feed id, two integers and a fixed sentence. */
export function buildStormEscalationEmit(
  source: OutboundAlert,
  occurrences: number,
  now: Date,
): ReturnType<typeof buildOutboundAlertEmit> {
  const stormKind = STORM_ESCALATION[source.kind];
  if (stormKind === undefined) throw new Error(`no storm escalation is defined for ${source.kind}`);
  const windowMinutes = OUTBOUND_ALERT_WINDOW_MS[stormKind] / 60_000;
  const escalation: OutboundAlert = {
    kind: stormKind,
    severity: "HIGH",
    channel: "operator-on-call",
    feedId: source.feedId,
    detail: `${occurrences} outbound transmissions failed on this feed within ${windowMinutes} minutes — the lab endpoint or the feed configuration is likely down; investigate the feed, not the individual orders`,
  };
  const base = buildOutboundAlertEmit(escalation, now);
  return { ...base, payload: { ...base.payload, occurrences, windowMinutes } };
}

/** The slice of the M36 `AlertEmitter` seam this needs — structural, so no concrete M36 import (M29 dependsOn excludes it). */
export interface StormAlertEmitPort {
  emit(
    organizationId: string,
    input: ReturnType<typeof buildOutboundAlertEmit> & { readonly countRepeats?: boolean },
  ): Promise<unknown>;
}

/** The count M36 returned, or undefined when the emitter (an older / in-memory one) does not count. */
function occurrencesOf(result: unknown): number | undefined {
  const n = (result as { occurrences?: unknown } | null)?.occurrences;
  return typeof n === "number" && Number.isInteger(n) ? n : undefined;
}

/**
 * Emit an outbound alert intent: the windowed alert (counted), plus — exactly once per window, when the count reaches
 * `threshold` — the storm escalation. The FIRST alert is emitted with no added latency; the escalation is a second
 * emit only on the one call that crosses the threshold. Throws whatever the emitter throws (the worker's
 * `emitAlert` owns the never-block-the-pipeline try/catch).
 */
export async function emitOutboundAlert(
  emitter: StormAlertEmitPort,
  organizationId: string,
  alert: OutboundAlert,
  now: Date,
  threshold: number = resolveStormThreshold(process.env),
): Promise<void> {
  const result = await emitter.emit(organizationId, {
    ...buildOutboundAlertEmit(alert, now),
    countRepeats: true,
  });
  if (STORM_ESCALATION[alert.kind] !== undefined && occurrencesOf(result) === threshold) {
    await emitter.emit(organizationId, buildStormEscalationEmit(alert, threshold, now));
  }
}
