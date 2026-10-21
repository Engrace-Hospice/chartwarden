// @chartwarden/reporting — the NINE typed M36 alert payloads M33 emits (spec §4.9), with their severity +
// default channel. Mirrors the @chartwarden/saas-tenant-platform alert posture: M33 is the PRODUCER — it
// emits the typed `m33.*` outbox events (apps/backend/src/modules/33-reporting/events-by-m33.ts) and
// ships these alert definitions; M36 is the live alerts consumer that matches an emitted outbox
// `eventType` to the firing `alert_rule`(s) and fans out via its registered resolvers (§4.8). This file
// imports NOTHING from M36 at runtime (only `@chartwarden/messaging` channel/severity TYPES where useful) —
// never the inverse — so M33 `dependsOn` stays `[1,2,3,4,36]`.
//
// SEVERITY (§4.9 ↔ M36 `alert_severity`): the §4.9 table uses the three-level `info | warn | critical`
// ladder, which maps 1:1 onto M36's `alert_severity` pgEnum / `alert_rule.severity_floor` — no
// projection needed (unlike M34's four-level `error` rows). CHANNEL: the §4.9 table names the default
// delivery channel per alert; the admin-audience variants (`in_app_admin` / `in_app_compliance`) are
// M33-local channel labels the alert-rule seed resolves to the platform-ops / compliance audiences
// (the `report.admin.*` / drilldown-audit readers) — recipients may still override per §3.6.

import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";

/** The three-level ladder M36's `alert_severity` pgEnum / `alert_rule.severity_floor` carries (§3.2). */
export type ReportingAlertSeverity = "info" | "warn" | "critical";

/**
 * The default delivery channel per §4.9 alert. `in_app` is M36's tenant-facing in-app channel; the two
 * admin-audience labels narrow the in-app fan-out to the platform-ops (`in_app_admin`) / compliance
 * (`in_app_compliance`) recipient sets the alert-rule seed resolves (§4.8) — they are NOT new M36
 * transport channels.
 */
export type ReportingAlertChannel = "in_app" | "in_app_admin" | "in_app_compliance";

/** One M33 typed alert definition: the M36 rule key, its severity floor, default channel, and payload. */
export interface ReportingAlertDef<TPayload extends TSchema = TSchema> {
  /** The M36 alert-rule key M33 ships (the platform-default label the alert engine routes on). */
  readonly alertKey: string;
  /** The `m33.<resource>.<verb>` outbox `eventType` whose publish fires this alert (events-by-m33.ts). */
  readonly eventType: string;
  /** The §4.9 severity (maps 1:1 onto M36's `alert_severity` floor). */
  readonly severity: ReportingAlertSeverity;
  /** The §4.9 default delivery channel / audience. */
  readonly channel: ReportingAlertChannel;
  /** The TypeBox schema the alert payload satisfies (a projection of the firing event's payload). */
  readonly payloadSchema: TPayload;
}

const id = Type.String({ minLength: 1 });
const isoInstant = Type.String({ minLength: 1 });

/**
 * The nine §4.9 typed alerts, keyed by their M36 alert key. Each `payloadSchema` is the alert-projected
 * shape the §4.9 table specifies (a subset of the firing `m33.*` event payload). UPSERT of the matching
 * M36 platform-default `alert_rule` rows is a Phase-2D wiring TODO (the M34 alert-rules precedent).
 */
export const M33_ALERTS = {
  /** A scheduled report rendered + fanned out to its recipients (§4.9). */
  scheduledReportDelivered: {
    alertKey: "scheduledReportDelivered",
    eventType: "m33.scheduled_report.delivered",
    severity: "info",
    channel: "in_app",
    payloadSchema: Type.Object({
      scheduleId: id,
      viewName: Type.String(),
      documentId: id,
      deliveredAt: isoInstant,
    }),
  },
  /** A scheduled-report run failed (render or fan-out) (§4.9). */
  scheduledReportFailed: {
    alertKey: "scheduledReportFailed",
    eventType: "m33.scheduled_report.failed",
    severity: "warn",
    channel: "in_app",
    payloadSchema: Type.Object({
      scheduleId: id,
      scheduledFor: isoInstant,
      reason: Type.String(),
    }),
  },
  /** A schedule recipient was revoked (M34 cascade); the schedule may have auto-paused (§4.9). */
  scheduledReportRecipientRevoked: {
    alertKey: "scheduledReportRecipientRevoked",
    eventType: "m33.report_schedule.recipient_revoked",
    severity: "warn",
    channel: "in_app",
    payloadSchema: Type.Object({
      scheduleId: id,
      revokedMembershipId: id,
      recipientsRemaining: Type.Integer({ minimum: 0 }),
      autoPaused: Type.Boolean(),
    }),
  },
  /** An MV refresh failed but retries remain (§4.9). */
  mvRefreshFailed: {
    alertKey: "mvRefreshFailed",
    eventType: "m33.mv.refresh_failed",
    severity: "warn",
    channel: "in_app_admin",
    payloadSchema: Type.Object({
      mvKey: id,
      attempts: Type.Integer({ minimum: 1 }),
      reason: Type.String(),
    }),
  },
  /** An MV refresh exhausted its retries (the MV is now stale / suspended) (§4.9). */
  mvRefreshExhausted: {
    alertKey: "mvRefreshExhausted",
    eventType: "m33.mv.refresh_failed",
    severity: "critical",
    channel: "in_app_admin",
    payloadSchema: Type.Object({
      mvKey: id,
      attempts: Type.Integer({ minimum: 1 }),
      reason: Type.String(),
      lastSucceededAt: Type.Union([isoInstant, Type.Null()]),
    }),
  },
  /** The read-replica lag crossed the freshness threshold (§4.9). */
  replicaLagExceeded: {
    alertKey: "replicaLagExceeded",
    eventType: "m33.lag.exceeded",
    severity: "warn",
    channel: "in_app_admin",
    payloadSchema: Type.Object({
      lagSeconds: Type.Number({ minimum: 0 }),
      threshold: Type.Number({ minimum: 0 }),
      sampledAt: isoInstant,
    }),
  },
  /** The read-replica lag recovered below threshold (§4.9). */
  replicaLagRecovered: {
    alertKey: "replicaLagRecovered",
    eventType: "m33.lag.recovered",
    severity: "info",
    channel: "in_app_admin",
    payloadSchema: Type.Object({
      lagSeconds: Type.Number({ minimum: 0 }),
      durationDownSeconds: Type.Number({ minimum: 0 }),
    }),
  },
  /** A saved view was shared org-wide (§4.9). */
  viewSharedOrg: {
    alertKey: "viewSharedOrg",
    eventType: "m33.report_view.shared_org",
    severity: "info",
    channel: "in_app",
    payloadSchema: Type.Object({
      viewId: id,
      viewName: Type.String(),
      sharedByMembershipId: id,
    }),
  },
  /** A drilldown's patient identifiers were narrowed under M39 consent (narrowed, not refused) (§4.9). */
  drilldownConsentNarrowed: {
    alertKey: "drilldownConsentNarrowed",
    eventType: "m33.drilldown.emitted",
    severity: "warn",
    channel: "in_app_compliance",
    payloadSchema: Type.Object({
      drilldownTraceId: id,
      actorMembershipId: id,
      reason: Type.String(),
    }),
  },
} as const satisfies Record<string, ReportingAlertDef>;

/** Every M33 alert key (the §4.9 set). */
export type M33AlertKey = keyof typeof M33_ALERTS;

/** The nine M33 alert definitions as a list (for seeding / iteration). */
export const M33_ALERT_LIST: readonly ReportingAlertDef[] = Object.values(M33_ALERTS);
