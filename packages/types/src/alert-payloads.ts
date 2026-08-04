// @wardenx/types — Typed alert-payload catalog contracts (M36 Secure Messaging §3.11/§3.12; M36-T05).
//
// The typed alert-payload registry brings M36's alert catalog inline with M1's
// outbox-event-catalog (./outbox.ts) and M4's audit-action-catalog discipline: a per-module
// CONTRIBUTION shape + a boot UPSERT into `alert_payload_catalog` + runtime validation. Per the
// §3.12 Foundation Registry pattern, every LATER module contributes the typed payloads it emits
// (`m11.lab_results.critical`, `m22.document.rendered_critical_results`, …) at ITS OWN boot — so
// the shape lives here in a leaf (NOT the banned packages/foundation, ADR-0005 D4), and M36's
// aggregator (packages/messaging) needs no dependsOn edge on any producer. check-fitness-gaps.ts
// enforces the same `mN.<resource>.<verb>` ownership the outbox catalog uses.
import { Type } from "@sinclair/typebox";
import type { TSchema } from "@sinclair/typebox";
import type { ModuleToken } from "./outbox";

/**
 * The DISTINCT payload-catalog severity ladder (§3.11, M36-F06b) — mirrors the
 * `alert_payload_severity` pgEnum. Tenants may TIGHTEN via the D11 routing override but never
 * loosen. DISTINCT from the legacy `alert`/`alert_rule` `info|warn|critical` ladder.
 */
export type AlertPayloadSeverity = "INFO" | "WARN" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Definition order of {@link AlertPayloadSeverity} — the floor ↑ tighten ordering the D11 routing
 *  override compares against (INFO < WARN < MEDIUM < HIGH < CRITICAL), matching the Postgres enum
 *  definition order the §3.11.1 `enforce_alert_routing_tighten_only` trigger relies on. */
export const ALERT_PAYLOAD_SEVERITY_ORDER = [
  "INFO",
  "WARN",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const satisfies readonly AlertPayloadSeverity[];

/**
 * One typed alert payload a module registers with M36 (§3.12.1). The `payloadType` is a
 * `mN.<resource>.<verb>` name owned by `moduleOwner`; `payloadSchema` is the TypeBox schema the
 * catalog-validated dispatch path (§4.6.1) checks every emit against. `defaultChannels` is the
 * platform-floor delivery class set (`socket_push`/`inbox`/`sms`/`email`); a tenant may ADD but
 * never remove (D11). `defaultRecipientResolver` names a resolver in M36's registry (§4.6).
 */
export interface AlertPayloadEntry {
  /** Fully-qualified payload type, e.g. `m11.lab_results.critical` (§3.12). */
  readonly payloadType: string;
  /** The owning module's `mN` token — must match the payload type's `mN.` prefix. */
  readonly moduleOwner: ModuleToken;
  /** Platform-floor severity for this payload (tenants may tighten, never loosen, §3.11). */
  readonly severity: AlertPayloadSeverity;
  /** Default delivery class set, e.g. `['socket_push', 'inbox']` (§3.11; tenants add-only). */
  readonly defaultChannels: readonly string[];
  /** Name of the recipient resolver M36 dispatches to (§4.6), e.g. `ordering_provider`. */
  readonly defaultRecipientResolver: string;
  /** TypeBox schema every emitted payload of this type must satisfy (§4.6.1 refuse-on-failure). */
  readonly payloadSchema: TSchema;
  /** When true, the response SLA is tracked downstream in M30 (§3.11). */
  readonly requiresResponseTracking: boolean;
  /** Human-readable description (the catalog's reporting surface, §3.11). */
  readonly description: string;
}

/** One module's alert-payload contribution: the payload types it OWNS under its `mN.` prefix
 *  (§3.12). A producer module ships one of these and registers it at its own boot. */
export type ModuleAlertContribution = readonly AlertPayloadEntry[];

/**
 * Persisted projection of a catalog entry into the `alert_payload_catalog` row shape (§3.11.2).
 * Structural (no `@wardenx/db` import) so the leaf stays a leaf — M36's boot slice feeds these
 * rows to an injected Drizzle UPSERTer, exactly as M1 does for `outbox_event_catalog`.
 */
export interface AlertPayloadCatalogRow {
  readonly payloadType: string;
  readonly moduleOwner: string;
  readonly severity: AlertPayloadSeverity;
  readonly defaultChannels: string[];
  readonly defaultRecipientResolver: string;
  readonly payloadSchema: unknown;
  readonly requiresResponseTracking: boolean;
  readonly description: string;
}

// -----------------------------------------------------------------------------
// Module 30 (HQRP & Quality) alert-payload contribution (M30 spec §4.9; W-M30-29).
//
// The TWELVE typed alert payloads M30 OWNS under the `m30.` prefix. M30 is a PRODUCER: it emits these
// deterministic, PHI-free payloads (IDs + structural facts) and M36 (foundation-tier) resolves recipient
// PHI per permission scope and fans out via its registered resolvers — M36 never imports M30. Other
// producer modules ship this `ModuleAlertContribution` from `apps/backend/src/modules/NN/alerts-by-mNN.ts`
// and register it onto M36's Foundation registry at their own boot; M30's runtime route/worker wiring is
// a LATER phase, so the contribution is hoisted to this leaf now so the §4.9 catalog exists and the
// W-M30-29 boot gate (boot fails if an M30 alert payload is missing from the catalog) has a single source
// of truth to register. The §4.9 three-level `info | warn | high | critical` ladder maps onto the
// {@link AlertPayloadSeverity} payload-catalog ladder (info→INFO, warn→WARN, high→HIGH, critical→CRITICAL;
// M30 publishes no MEDIUM-floor alert). check-fitness-gaps.ts enforces the same `mN.<resource>.<verb>`
// ownership the outbox catalog uses.
// -----------------------------------------------------------------------------

/** The twelve `m30.alerts.*` payload type names M30 owns (§4.9), as a string-literal union. */
export type M30AlertPayloadType =
  | "m30.alerts.sra_due_90"
  | "m30.alerts.sra_due_60"
  | "m30.alerts.sra_due_30"
  | "m30.alerts.sra_overdue"
  | "m30.alerts.incident_abuse_allegation"
  | "m30.alerts.incident_sentinel"
  | "m30.alerts.outbreak_detected"
  | "m30.alerts.measure_threshold_breached"
  | "m30.alerts.cap_overdue"
  | "m30.alerts.mortality_review_due"
  | "m30.alerts.cop_review_overdue"
  | "m30.alerts.cahps_sample_ready";

const m30OrgId = Type.String({ minLength: 1 });
const m30Id = Type.String({ minLength: 1 });
const m30IsoInstant = Type.String({ minLength: 1 });

/**
 * The §4.9 M36 alert-payload contribution for Module 30. Registered onto M36's Foundation alert-payload
 * registry at M30 boot (a later phase). Every payload is PHI-free (IDs + structural facts only).
 */
export const M30_ALERT_PAYLOADS: ModuleAlertContribution = [
  {
    payloadType: "m30.alerts.sra_due_90",
    moduleOwner: "m30",
    severity: "INFO", // 90d before the SRA anniversary; cadence every 14d until acked
    defaultChannels: ["inbox"],
    defaultRecipientResolver: "sra_reminder_recipients",
    payloadSchema: Type.Object({
      organizationId: m30OrgId,
      cycleId: m30Id,
      anniversaryAt: m30IsoInstant,
      daysRemaining: Type.Integer({ minimum: 0 }),
    }),
    requiresResponseTracking: true,
    description: "SRA due in 90 days — the early reminder to the Security + Compliance Officers.",
  },
  {
    payloadType: "m30.alerts.sra_due_60",
    moduleOwner: "m30",
    severity: "WARN", // 60d before anniversary; cadence every 7d until acked
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "sra_reminder_recipients",
    payloadSchema: Type.Object({
      organizationId: m30OrgId,
      cycleId: m30Id,
      anniversaryAt: m30IsoInstant,
      daysRemaining: Type.Integer({ minimum: 0 }),
    }),
    requiresResponseTracking: true,
    description:
      "SRA due in 60 days — reminder to the Security + Compliance Officers + Administrator.",
  },
  {
    payloadType: "m30.alerts.sra_due_30",
    moduleOwner: "m30",
    severity: "HIGH", // 30d before anniversary; cadence every 3d until acked
    defaultChannels: ["inbox", "socket_push", "email"],
    defaultRecipientResolver: "sra_reminder_recipients",
    payloadSchema: Type.Object({
      organizationId: m30OrgId,
      cycleId: m30Id,
      anniversaryAt: m30IsoInstant,
      daysRemaining: Type.Integer({ minimum: 0 }),
    }),
    requiresResponseTracking: true,
    description:
      "SRA due in 30 days — the escalated reminder to the Security/Compliance Officers + Administrator.",
  },
  {
    payloadType: "m30.alerts.sra_overdue",
    moduleOwner: "m30",
    severity: "CRITICAL", // past anniversary, cycle not closed; cadence daily
    defaultChannels: ["inbox", "socket_push", "email"],
    defaultRecipientResolver: "sra_escalation_recipients",
    payloadSchema: Type.Object({
      organizationId: m30OrgId,
      cycleId: m30Id,
      anniversaryAt: m30IsoInstant,
      daysOverdue: Type.Integer({ minimum: 0 }),
    }),
    requiresResponseTracking: true,
    description:
      "SRA is overdue (past anniversary, cycle open) — the daily escalation to Administrator/Owner/Compliance.",
  },
  {
    payloadType: "m30.alerts.incident_abuse_allegation",
    moduleOwner: "m30",
    severity: "CRITICAL", // kind=allegation_of_abuse submitted; immediate, then 6h until triaged
    defaultChannels: ["inbox", "socket_push", "email"],
    defaultRecipientResolver: "incident_abuse_recipients",
    payloadSchema: Type.Object({
      organizationId: m30OrgId,
      incidentId: m30Id,
      occurredAt: m30IsoInstant,
      hasPatientLink: Type.Boolean(),
    }),
    requiresResponseTracking: true,
    description:
      "An abuse-allegation incident was submitted — the immediate escalation to Admin/Compliance/Medical Director.",
  },
  {
    payloadType: "m30.alerts.incident_sentinel",
    moduleOwner: "m30",
    severity: "CRITICAL", // sentinel-severity incident submitted; immediate, then 4h until triaged
    defaultChannels: ["inbox", "socket_push", "email"],
    defaultRecipientResolver: "incident_sentinel_recipients",
    payloadSchema: Type.Object({
      organizationId: m30OrgId,
      incidentId: m30Id,
      kind: Type.String(),
      occurredAt: m30IsoInstant,
      hasPatientLink: Type.Boolean(),
    }),
    requiresResponseTracking: true,
    description:
      "A sentinel-severity incident was submitted — the immediate escalation to Admin/Compliance/MD/QAPI.",
  },
  {
    payloadType: "m30.alerts.outbreak_detected",
    moduleOwner: "m30",
    severity: "HIGH", // infection cluster >=3 events / 14d; immediate, then 12h until reviewed
    defaultChannels: ["inbox", "socket_push", "email"],
    defaultRecipientResolver: "infection_control_recipients",
    payloadSchema: Type.Object({
      organizationId: m30OrgId,
      clusterKey: m30Id,
      eventCount: Type.Integer({ minimum: 3 }),
      windowDays: Type.Integer({ minimum: 1 }),
      firstEventAt: m30IsoInstant,
    }),
    requiresResponseTracking: true,
    description:
      "An infection cluster (>=3 events / 14d) was detected — the escalation to Infection Control/MD/Admin.",
  },
  {
    payloadType: "m30.alerts.measure_threshold_breached",
    moduleOwner: "m30",
    severity: "WARN", // QAPI indicator crosses red threshold; every 7d until project chartered
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "qapi_coordinators",
    payloadSchema: Type.Object({
      organizationId: m30OrgId,
      indicatorId: m30Id,
      measureId: m30Id,
      periodEnd: m30IsoInstant,
      rate: Type.Number(),
      threshold: Type.Number(),
    }),
    requiresResponseTracking: true,
    description:
      "A QAPI indicator crossed its red threshold — the cadence alert to the QAPI Coordinator + Medical Director.",
  },
  {
    payloadType: "m30.alerts.cap_overdue",
    moduleOwner: "m30",
    severity: "HIGH", // CAP action item past dueAt, not completed; every 2d until completed
    defaultChannels: ["inbox", "socket_push", "email"],
    defaultRecipientResolver: "cap_owner_and_verifier",
    payloadSchema: Type.Object({
      organizationId: m30OrgId,
      capId: m30Id,
      actionItemId: m30Id,
      dueAt: m30IsoInstant,
    }),
    requiresResponseTracking: true,
    description:
      "A corrective-action-plan item is overdue — the cadence alert to the owner, verifier, and QAPI Coordinator.",
  },
  {
    payloadType: "m30.alerts.mortality_review_due",
    moduleOwner: "m30",
    severity: "INFO", // 25 days post-death, review not completed; every 2d until completed
    defaultChannels: ["inbox"],
    defaultRecipientResolver: "mortality_review_recipients",
    payloadSchema: Type.Object({
      organizationId: m30OrgId,
      mortalityReviewId: m30Id,
      patientId: Type.Union([m30Id, Type.Null()]),
      deathAt: m30IsoInstant,
      daysSinceDeath: Type.Integer({ minimum: 0 }),
    }),
    requiresResponseTracking: true,
    description:
      "A mortality review is due (25d post-death, not completed) — the cadence reminder to the MD + QAPI Coordinator.",
  },
  {
    payloadType: "m30.alerts.cop_review_overdue",
    moduleOwner: "m30",
    severity: "WARN", // 6 months since last attestation on a citation; every 14d until attested
    defaultChannels: ["inbox", "socket_push"],
    defaultRecipientResolver: "compliance_officers",
    payloadSchema: Type.Object({
      organizationId: m30OrgId,
      citationId: m30Id,
      lastAttestedAt: Type.Union([m30IsoInstant, Type.Null()]),
    }),
    requiresResponseTracking: true,
    description:
      "A CoP citation is overdue for re-attestation (>6 months) — the cadence alert to Compliance + Administrator.",
  },
  {
    payloadType: "m30.alerts.cahps_sample_ready",
    moduleOwner: "m30",
    severity: "INFO", // monthly sample built and ready for export; fired once
    defaultChannels: ["inbox"],
    defaultRecipientResolver: "qapi_coordinators",
    payloadSchema: Type.Object({
      organizationId: m30OrgId,
      sampleId: m30Id,
      periodMonth: Type.String({ minLength: 1 }),
      sampleSize: Type.Integer({ minimum: 0 }),
    }),
    requiresResponseTracking: false,
    description:
      "The monthly CAHPS decedent sample is built and ready for export — the one-shot notice to the QAPI Coordinator.",
  },
];
