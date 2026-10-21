// @chartwarden/quality — the TWELVE §4.9 M36 alert DEFINITIONS M30 ships (severity / channel / recipients /
// cadence / trigger), the exact mirror of @chartwarden/reporting's `alert-defs.ts`.
//
// M30 is the alert PRODUCER: its typed alert PAYLOADS already live in `@chartwarden/types`
// (`packages/types/src/alert-payloads.ts` — `M30_ALERT_PAYLOADS`, the `m30.alerts.*` TypeBox schemas +
// the payload-catalog severity/channels). THIS file adds the §4.9 escalation METADATA M36's alert-rule
// seed resolves on top of those payloads: the firing TRIGGER (the cron sweep or the `m30.*` outbox event
// whose publish raises the alert), the platform-default RECIPIENT roles, and the platform-floor CADENCE
// (tenants may TIGHTEN via M3 ABAC overrides per D15, never loosen). It imports NOTHING from M36 at
// runtime — M36 is the live consumer that matches an emitted outbox `eventType` (or a cron-raised payload)
// to the firing `alert_rule`(s) and fans out via its registered resolvers. M30 `dependsOn` is unaffected.
//
// SEVERITY (§4.9): the four-level `info | warn | high | critical` ladder maps 1:1 onto the
// `M30_ALERT_PAYLOADS` payload-catalog ladder (info→INFO, warn→WARN, high→HIGH, critical→CRITICAL; M30
// publishes no MEDIUM-floor alert). CHANNELS mirror each payload's `defaultChannels` (`inbox` /
// `socket_push` / `email`) so the def + the payload catalog never drift.
import type { M30AlertPayloadType } from "@chartwarden/types";

/** The §4.9 four-level severity ladder (maps 1:1 onto the `AlertPayloadSeverity` payload-catalog floor). */
export type QualityAlertSeverity = "info" | "warn" | "high" | "critical";

/** A platform-floor delivery class (mirrors each payload's `defaultChannels`; tenants ADD-only per D11). */
export type QualityAlertChannel = "inbox" | "socket_push" | "email";

/**
 * What FIRES a §4.9 alert: either a cron/sweep raising the payload directly, or a published `m30.*` outbox
 * event M36 consumes. The §4.9 "Trigger" column collapses onto these two shapes.
 */
export type QualityAlertTrigger =
  /** A `m30.*` outbox event (events-by-m30.ts) whose publish M36 matches to the firing `alert_rule`. */
  | { readonly kind: "outbox_event"; readonly eventType: string }
  /** A cron / scheduled sweep (§4.8) that raises the alert payload directly (no domain outbox event). */
  | { readonly kind: "scheduled"; readonly source: string };

/** One §4.9 M30 alert definition: the M36 rule key + payload type, its severity, channels, recipients,
 *  cadence, and the firing trigger. The `payloadType` cross-links to the `M30_ALERT_PAYLOADS` schema. */
export interface QualityAlertDef {
  /** The M36 alert-rule key M30 ships (the platform-default label the alert engine routes on). */
  readonly alertKey: string;
  /** The `m30.alerts.*` payload type (the `M30_ALERT_PAYLOADS` entry whose schema the payload satisfies). */
  readonly payloadType: M30AlertPayloadType;
  /** The §4.9 severity (maps 1:1 onto M36's `alert_severity` floor). */
  readonly severity: QualityAlertSeverity;
  /** The §4.9 default delivery classes (mirror the payload's `defaultChannels`). */
  readonly defaultChannels: readonly QualityAlertChannel[];
  /** The §4.9 platform-default recipient roles (M36 resolves these to memberships per permission scope). */
  readonly recipients: readonly string[];
  /** The §4.9 platform-floor cadence (tenants tighten-only per D15). */
  readonly cadence: string;
  /** What raises the alert — a cron sweep or a published `m30.*` outbox event. */
  readonly trigger: QualityAlertTrigger;
}

/** The cron that evaluates the SRA reminder calendar (§4.8). */
const SRA_REMINDERS_CRON = "m30.sra_reminders";

/**
 * The twelve §4.9 alert definitions, keyed by their M36 alert key. The boot UPSERT of the matching M36
 * platform-default `alert_rule` rows (from these defs + the `M30_ALERT_PAYLOADS` schemas) is a later
 * wiring phase (the M33/M34 alert-rules precedent) — M36 is the live consumer.
 */
export const M30_ALERTS = {
  /** SRA due in 90 days — early reminder (§4.9). */
  sraDue90: {
    alertKey: "sraDue90",
    payloadType: "m30.alerts.sra_due_90",
    severity: "info",
    defaultChannels: ["inbox"],
    recipients: ["Security Officer", "Compliance Officer"],
    cadence: "every 14d until acked",
    trigger: { kind: "scheduled", source: SRA_REMINDERS_CRON },
  },
  /** SRA due in 60 days (§4.9). */
  sraDue60: {
    alertKey: "sraDue60",
    payloadType: "m30.alerts.sra_due_60",
    severity: "warn",
    defaultChannels: ["inbox", "socket_push"],
    recipients: ["Security Officer", "Compliance Officer", "Administrator"],
    cadence: "every 7d until acked",
    trigger: { kind: "scheduled", source: SRA_REMINDERS_CRON },
  },
  /** SRA due in 30 days (§4.9). */
  sraDue30: {
    alertKey: "sraDue30",
    payloadType: "m30.alerts.sra_due_30",
    severity: "high",
    defaultChannels: ["inbox", "socket_push", "email"],
    recipients: ["Security Officer", "Compliance Officer", "Administrator"],
    cadence: "every 3d until acked",
    trigger: { kind: "scheduled", source: SRA_REMINDERS_CRON },
  },
  /** SRA overdue — past anniversary, cycle not closed (§4.9). */
  sraOverdue: {
    alertKey: "sraOverdue",
    payloadType: "m30.alerts.sra_overdue",
    severity: "critical",
    defaultChannels: ["inbox", "socket_push", "email"],
    recipients: ["Administrator", "Owner", "Compliance Officer"],
    cadence: "daily",
    trigger: { kind: "scheduled", source: SRA_REMINDERS_CRON },
  },
  /** An abuse-allegation incident was submitted (§4.9). */
  incidentAbuseAllegation: {
    alertKey: "incidentAbuseAllegation",
    payloadType: "m30.alerts.incident_abuse_allegation",
    severity: "critical",
    defaultChannels: ["inbox", "socket_push", "email"],
    recipients: ["Administrator", "Compliance Officer", "Medical Director"],
    cadence: "immediate, then 6h until triaged",
    trigger: { kind: "outbox_event", eventType: "m30.incident.submitted" },
  },
  /** A sentinel-severity incident was submitted (§4.9). */
  incidentSentinel: {
    alertKey: "incidentSentinel",
    payloadType: "m30.alerts.incident_sentinel",
    severity: "critical",
    defaultChannels: ["inbox", "socket_push", "email"],
    recipients: ["Administrator", "Compliance Officer", "Medical Director", "QAPI Coordinator"],
    cadence: "immediate, then 4h until triaged",
    trigger: { kind: "outbox_event", eventType: "m30.incident.submitted" },
  },
  /** An infection cluster (≥3 events / 14d) was detected (§4.9). */
  outbreakDetected: {
    alertKey: "outbreakDetected",
    payloadType: "m30.alerts.outbreak_detected",
    severity: "high",
    defaultChannels: ["inbox", "socket_push", "email"],
    recipients: ["Infection Control Lead", "Medical Director", "Administrator"],
    cadence: "immediate, then 12h until reviewed",
    trigger: { kind: "outbox_event", eventType: "m30.infection.outbreak_opened" },
  },
  /** A QAPI indicator crossed its red threshold (§4.9). */
  measureThresholdBreached: {
    alertKey: "measureThresholdBreached",
    payloadType: "m30.alerts.measure_threshold_breached",
    severity: "warn",
    defaultChannels: ["inbox", "socket_push"],
    recipients: ["QAPI Coordinator", "Medical Director"],
    cadence: "every 7d until project chartered",
    trigger: { kind: "outbox_event", eventType: "m30.measure.threshold_breached" },
  },
  /** A corrective-action-plan item is overdue (§4.9). */
  capOverdue: {
    alertKey: "capOverdue",
    payloadType: "m30.alerts.cap_overdue",
    severity: "high",
    defaultChannels: ["inbox", "socket_push", "email"],
    recipients: ["CAP action item owner", "CAP verifier", "QAPI Coordinator"],
    cadence: "every 2d until completed",
    trigger: { kind: "outbox_event", eventType: "m30.incident.cap_overdue" },
  },
  /** A mortality review is due (25d post-death, not completed) (§4.9). */
  mortalityReviewDue: {
    alertKey: "mortalityReviewDue",
    payloadType: "m30.alerts.mortality_review_due",
    severity: "info",
    defaultChannels: ["inbox"],
    recipients: ["Medical Director", "QAPI Coordinator"],
    cadence: "every 2d until completed",
    trigger: { kind: "scheduled", source: "m30 mortality-review overdue sweep" },
  },
  /** A CoP citation is overdue for re-attestation (>6 months) (§4.9). */
  copReviewOverdue: {
    alertKey: "copReviewOverdue",
    payloadType: "m30.alerts.cop_review_overdue",
    severity: "warn",
    defaultChannels: ["inbox", "socket_push"],
    recipients: ["Compliance Officer", "Administrator"],
    cadence: "every 14d until attested",
    trigger: { kind: "scheduled", source: "m30 CoP-attestation cadence sweep" },
  },
  /** The monthly CAHPS decedent sample is built and ready for export (§4.9). */
  cahpsSampleReady: {
    alertKey: "cahpsSampleReady",
    payloadType: "m30.alerts.cahps_sample_ready",
    severity: "info",
    defaultChannels: ["inbox"],
    recipients: ["QAPI Coordinator"],
    cadence: "once",
    trigger: { kind: "outbox_event", eventType: "m30.cahps.sample_ready" },
  },
} as const satisfies Record<string, QualityAlertDef>;

/** Every M30 alert key (the §4.9 set of twelve). */
export type M30AlertKey = keyof typeof M30_ALERTS;

/** The twelve M30 alert definitions as a list (for seeding / iteration). */
export const M30_ALERT_LIST: readonly QualityAlertDef[] = Object.values(M30_ALERTS);
