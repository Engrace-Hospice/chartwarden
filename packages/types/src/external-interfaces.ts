// @wardenx/types — Module 29 (External Interfaces) leaf contracts (M29-T01).
//
// Per ADR-0005 D1/D2 the cross-module CONTRACTS live in this leaf package, so every downstream consumer
// (M1's boot validators, M5's ADT patient-mutator, M6's admission applier, M11's ORM producer, M22's lab
// PDF back-ref, M28's `LabObservationReader`, M40's NPPES-sync handler, the M33 metrics reader) imports
// them with NO `dependsOn` edge. M29 never imports another module's feature package — every upstream chart
// it touches (M5/M11/M22/M27/M38/M39/M40) is reached through a reader seam or an outbox event, and the
// dependency-cruiser boundary check (architecture §25.15) blocks any `import` from a non-listed code path.
//
// WHAT T01 SHIPS. The type-level surface every later M29 task builds on: the §3.2/§3.3 pgEnum value
// mirrors (the 24 `CREATE TYPE` vocabularies), the §2.3 domain validation constants (the SLA window, the
// reject-rationale floor, the outbound retry ceiling, the listener-down threshold), the §2.2 lifecycle
// vocabulary for the four FSMs (feed onboarding, inbound-message parse, ADT proposal review, outbound ORM
// dispatch) + the operator-facing posture each state implies, the M29-owned id aliases, and the §3.5–§3.7
// owned-table descriptors (tenancy scope, audit denylist, ADR-0004 retention class, cipher columns, the
// partitioned-table set, the eraser data-class name) — the arguments M29-T02 passes to the M4 generators.
//
// WHAT T01 DELIBERATELY DOES NOT SHIP. The §4.4 published seam interfaces (`LabObservationReader` /
// `Hl7InboundProposalReader` / `ExternalFeedReader` / `NppesProviderReader` / `ExternalInterfaceMetricsProvider`,
// M29-T08), the §4.5 patient-match-cascade contracts (T04/T05), the §4.10 outbox catalog + §4.9 alert
// payloads (T05–T08), the wire-shape TypeBox schemas (§4.3, the route tasks), and the Drizzle table
// shapes + migration (T02). Those land as their tasks land; T01 is the vocabulary they are typed against.
//
// AUTHORITY NOTE (ADR-0005). The module spec's §3.1/§13.1 propose owning the packages `packages/hl7-worker`
// + `packages/nppes-client` and a frontend codePath. The authoritative `architecture/module-manifest.ts`
// gives M29 exactly ONE codePath — `apps/backend/src/modules/29-external-interfaces` — plus the eleven
// owned tables, and the Wave-H plan's acceptance item 1 requires the manifest stay unchanged this wave.
// Architecture wins: M29 is backend-only, so the HL7/NPPES worker code lives under the backend module and
// the Drizzle tables under the shared `packages/db` leaf — no new packages, no manifest edit. This leaf is
// the only shared surface T01 adds.
//
// NAMING. M29's domain words are already unambiguous namespaces (`ExternalFeed*`, `Hl7*`, `Lab*`, `Nppes*`);
// the cross-cutting constants/descriptors carry an `XI_` / `M29_` prefix. `@wardenx/types` is re-exported
// wholesale from `./index.ts`, so a bare `Status`/`Kind` would collide the day another module wants the
// same word — every export here is prefixed to survive the `export *` barrel (`DocumentId` already belongs
// to `documents.ts`, so the M22 back-ref alias below is `AttachedDocumentId`, never `DocumentId`).
//
// PHASE-1 POSTURE (Wave H plan, "M29 — HL7 v2 + NPPES are the Phase-1 core"). The MLLP ADT/ORU/ORM
// listeners + the NPPES nightly sync ship now. The Xero GL / Gusto payroll integrations are gated on the
// M27-owned `packages/xero-client`/`packages/gusto-client` and deferred to Phase 2 with M27 — see
// `XI_ACCOUNTING_GL_FLAG` (default OFF).

// ── Leaf-safe shared id aliases (single definition site elsewhere; imported for internal use only so the
//    package surface stays unambiguous under `export *` — re-exporting would be a TS2308 collision) ───────
import type { OrgId, PatientId } from "./admission";
import type { IsoInstant, MembershipId } from "./care-plan";
import type { OrderRecordId } from "./orders";

// ── M29-owned id aliases (mirror the §3.3 uuid PKs; packages/types cannot import @wardenx/db) ────────────

export type ExternalFeedId = string;
export type ExternalFeedCredentialId = string;
export type Hl7MessageInboundId = string;
export type Hl7MessageOutboundId = string;
export type Hl7InboundProposalId = string;
export type LabObservationId = string;
export type LabObservationValueId = string;
export type LabObservationInboundLinkId = string;
export type NppesSyncRunId = string;
/** `nppes_provider` is keyed by the 10-char NPI, not a synthetic uuid (§2.1). */
export type Npi = string;
/** The MSH-10 message control id (the HL7 wire dedup key, §2.6). */
export type MessageControlId = string;

// ── Cross-module ref aliases (app-side references — NEVER a DB FK across modules, architecture §25.15) ───
/** M40 Facility id — resolves an HL7 `MSH-4` sending facility / an ORM destination facility. */
export type FacilityId = string;
/** M22 document id — set on `lab_observation.attached_document_id` when an OBX-5 ED segment carries a PDF. */
export type AttachedDocumentId = string;
/** M11 `order_record.id` — the OBR-2 placer-order-number join key (D8) and the ORM source aggregate. */
export type M11OrderRecordId = OrderRecordId;

// ── §3.2 pgEnum value mirrors — kept in lock-step with `packages/db/src/schema/external-interfaces/enums.ts`
//    (M29-T02 lands the pgEnums; a T02 parity test asserts these sets match). Each is a `type` + a runtime
//    `as const` array so a worker/route can both narrow AND iterate. ────────────────────────────────────

export type ExternalFeedKind = "adt_inbound" | "lab_inbound" | "orm_outbound";
export const EXTERNAL_FEED_KINDS = [
  "adt_inbound",
  "lab_inbound",
  "orm_outbound",
] as const satisfies readonly ExternalFeedKind[];

export type ExternalFeedProtocol = "mllp_tls" | "mllp_plain";
export const EXTERNAL_FEED_PROTOCOLS = [
  "mllp_tls",
  "mllp_plain",
] as const satisfies readonly ExternalFeedProtocol[];

export type ExternalFeedStatus =
  | "proposed"
  | "pending_approval"
  | "active"
  | "suspended"
  | "revoked"
  | "rejected";
export const EXTERNAL_FEED_STATUSES = [
  "proposed",
  "pending_approval",
  "active",
  "suspended",
  "revoked",
  "rejected",
] as const satisfies readonly ExternalFeedStatus[];

export type ExternalFeedCredentialKind = "mllp_client_cert" | "mllp_channel_password";
export const EXTERNAL_FEED_CREDENTIAL_KINDS = [
  "mllp_client_cert",
  "mllp_channel_password",
] as const satisfies readonly ExternalFeedCredentialKind[];

export type ExternalFeedCredentialStatus = "active" | "retired";
export const EXTERNAL_FEED_CREDENTIAL_STATUSES = [
  "active",
  "retired",
] as const satisfies readonly ExternalFeedCredentialStatus[];

export type Hl7InboundParseStatus = "in_progress" | "parsed" | "parse_error" | "rejected";
export const HL7_INBOUND_PARSE_STATUSES = [
  "in_progress",
  "parsed",
  "parse_error",
  "rejected",
] as const satisfies readonly Hl7InboundParseStatus[];

export type Hl7InboundProposalKind =
  | "patient_demographic_update"
  | "admission_event"
  | "discharge_event"
  | "cancel_admission"
  | "new_patient";
export const HL7_INBOUND_PROPOSAL_KINDS = [
  "patient_demographic_update",
  "admission_event",
  "discharge_event",
  "cancel_admission",
  "new_patient",
] as const satisfies readonly Hl7InboundProposalKind[];

export type Hl7InboundProposalStatus = "pending" | "accepted" | "rejected" | "expired";
export const HL7_INBOUND_PROPOSAL_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "expired",
] as const satisfies readonly Hl7InboundProposalStatus[];

export type Hl7InboundMatchOutcome =
  | "matched_single"
  | "matched_ambiguous"
  | "no_match"
  | "merged_target";
export const HL7_INBOUND_MATCH_OUTCOMES = [
  "matched_single",
  "matched_ambiguous",
  "no_match",
  "merged_target",
] as const satisfies readonly Hl7InboundMatchOutcome[];

/** §4.5 D6 — the five-level deterministic patient-match precedence cascade (highest confidence first). */
export type Hl7InboundMatchLevel =
  | "L1_MRN_EXACT"
  | "L2_EXTERNAL_MRN_EXACT"
  | "L3_SSN_DOB"
  | "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE"
  | "L5_LOOSE_NAME_DOB_CANDIDATE"
  | "NO_MATCH";
export const HL7_INBOUND_MATCH_LEVELS = [
  "L1_MRN_EXACT",
  "L2_EXTERNAL_MRN_EXACT",
  "L3_SSN_DOB",
  "L4_DEMOGRAPHIC_BRIDGE_CANDIDATE",
  "L5_LOOSE_NAME_DOB_CANDIDATE",
  "NO_MATCH",
] as const satisfies readonly Hl7InboundMatchLevel[];

/** HL7 v2.5.1 application-acknowledgment codes (§2.2): AA accept, AE error, AR reject, plus our timeout. */
export type Hl7OutboundAckStatus = "aa" | "ae" | "ar" | "timeout";
export const HL7_OUTBOUND_ACK_STATUSES = [
  "aa",
  "ae",
  "ar",
  "timeout",
] as const satisfies readonly Hl7OutboundAckStatus[];

export type Hl7OutboundStatus = "queued" | "in_flight" | "acked" | "naked" | "failed" | "dlq";
export const HL7_OUTBOUND_STATUSES = [
  "queued",
  "in_flight",
  "acked",
  "naked",
  "failed",
  "dlq",
] as const satisfies readonly Hl7OutboundStatus[];

export type LabResultStatus = "preliminary" | "final" | "corrected" | "cancelled";
export const LAB_RESULT_STATUSES = [
  "preliminary",
  "final",
  "corrected",
  "cancelled",
] as const satisfies readonly LabResultStatus[];

export type LabAbnormalSummary = "any_critical" | "any_abnormal" | "all_normal" | "no_flags";
export const LAB_ABNORMAL_SUMMARIES = [
  "any_critical",
  "any_abnormal",
  "all_normal",
  "no_flags",
] as const satisfies readonly LabAbnormalSummary[];

/** OBX-8 abnormal flags (HL7 Table 0078 subset): H/L high/low, HH/LL critical, A abnormal, N normal. */
export type LabAbnormalFlag = "H" | "L" | "HH" | "LL" | "A" | "N";
export const LAB_ABNORMAL_FLAGS = [
  "H",
  "L",
  "HH",
  "LL",
  "A",
  "N",
] as const satisfies readonly LabAbnormalFlag[];

/** OBX-2 value type (HL7 Table 0125 subset): NM numeric, ST string, CE coded, SN structured-numeric, TX text, DT date. */
export type LabValueType = "NM" | "ST" | "CE" | "SN" | "TX" | "DT";
export const LAB_VALUE_TYPES = [
  "NM",
  "ST",
  "CE",
  "SN",
  "TX",
  "DT",
] as const satisfies readonly LabValueType[];

export type LabTerminologyValidation = "valid" | "unknown_code" | "deprecated";
export const LAB_TERMINOLOGY_VALIDATIONS = [
  "valid",
  "unknown_code",
  "deprecated",
] as const satisfies readonly LabTerminologyValidation[];

export type LabMatchMethod = "obr_placer_id" | "patient_loinc_date" | "manual" | "unmatched";
export const LAB_MATCH_METHODS = [
  "obr_placer_id",
  "patient_loinc_date",
  "manual",
  "unmatched",
] as const satisfies readonly LabMatchMethod[];

export type NppesEnumerationType = "NPI-1" | "NPI-2";
export const NPPES_ENUMERATION_TYPES = [
  "NPI-1",
  "NPI-2",
] as const satisfies readonly NppesEnumerationType[];

export type NppesProviderStatus = "active" | "deactivated";
export const NPPES_PROVIDER_STATUSES = [
  "active",
  "deactivated",
] as const satisfies readonly NppesProviderStatus[];

export type NppesSyncKind =
  | "daily_incremental"
  | "weekly_dissemination"
  | "monthly_deactivation"
  | "manual";
export const NPPES_SYNC_KINDS = [
  "daily_incremental",
  "weekly_dissemination",
  "monthly_deactivation",
  "manual",
] as const satisfies readonly NppesSyncKind[];

export type NppesSyncTrigger = "platform_cron" | "platform_admin";
export const NPPES_SYNC_TRIGGERS = [
  "platform_cron",
  "platform_admin",
] as const satisfies readonly NppesSyncTrigger[];

export type NppesSyncStatus = "in_progress" | "completed" | "failed";
export const NPPES_SYNC_STATUSES = [
  "in_progress",
  "completed",
  "failed",
] as const satisfies readonly NppesSyncStatus[];

// ── §2.3 domain validation constants (leaf DATA every M29 route + worker validates against) ─────────────

/** §2.2 — ADT proposal SLA: `expires_at = proposed_at + 72h`, tenant-overridable, tighten-only. */
export const XI_DEFAULT_INBOUND_REVIEW_SLA_HOURS = 72;
/** §2.2 — the platform ceiling on the tenant override (propose-then-review is operational, not life-safety). */
export const XI_INBOUND_REVIEW_SLA_PLATFORM_MAX_HOURS = 168;
/** §2.2 / W-XI-04 — a proposal rejection requires a rationale of at least this many chars. */
export const XI_PROPOSAL_REJECT_RATIONALE_MIN_CHARS = 40;
/** §2.3 / D9 — outbound ORM exponential-backoff attempt ceiling before DLQ + M36 alert. */
export const XI_OUTBOUND_MAX_ATTEMPTS = 5;
/** §4.11.5 / D17 — consecutive minutes of `listener_down_seconds` accrual that trip the M36 alert. */
export const XI_LISTENER_DOWN_ALERT_MINUTES = 5;
/** §4.1.3 — the compliance-review decrypt route is rate-limited to one disclosure per this many seconds per actor. */
export const XI_MESSAGE_DECRYPT_RATE_LIMIT_SECONDS = 5;
/** §2.2 — the `external_feed_health` rollup worker cadence (5-minute aggregation window). */
export const XI_FEED_HEALTH_ROLLUP_MINUTES = 5;
/** §2.2 — `nppes_provider.fetched_at` freshness the M5 D9 cert-eligibility rule reads ("current within 90 days"). */
export const XI_NPPES_FRESHNESS_DAYS = 90;

/** §7.3 / D15 — the M39 ingress-redaction data class consulted for SUD-flagged inbound labs (42 CFR Part 2). */
export const XI_SUD_INGRESS_DATA_CLASS = "lab_sud" as const;
export type XiSudIngressDataClass = typeof XI_SUD_INGRESS_DATA_CLASS;

/** Phase-1 flag (Wave H plan): the Xero GL / Gusto payroll integrations are gated to Phase 2 with M27. OFF. */
export const XI_ACCOUNTING_GL_FLAG = "external_interfaces.accounting_gl" as const;

/** §2.4 — the `source_aggregate_kind` values an outbound HL7 message can originate from (Phase 1: M11 orders). */
export type Hl7OutboundSourceKind = "m11.order_record";
export const HL7_OUTBOUND_SOURCE_KINDS = [
  "m11.order_record",
] as const satisfies readonly Hl7OutboundSourceKind[];

/**
 * §2.2 / §4.1.2 — the owner module an ADT proposal applies through on acceptance. Demographic updates
 * flow to M5's `PatientMutator`; admission/discharge/cancel events flow to M6's admission applier (Wave H
 * plan, "M5 PatientMutator apply + M6 AdmissionEventApplier"). The ABAC predicate
 * `hl7_inbound_proposal_owner_module_match` (§4.8) gates accept/reject on the actor's authority for this module.
 */
export type Hl7ProposalOwnerModule = "m5" | "m6";
export const HL7_PROPOSAL_OWNER_MODULES = [
  "m5",
  "m6",
] as const satisfies readonly Hl7ProposalOwnerModule[];

// ── §2.2 lifecycle — the four FSM vocabularies + the operator-facing posture ────────────────────────────

/**
 * A legal edge of an M29 FSM. The service layer holds the edge SETS; this is only their shape, so a
 * consumer (an admin route, a worker) can type a transition request without importing the module.
 * `fromStatus: null` is the initial insert (the entry arrow of each §2.2 diagram).
 */
export interface Hl7StatusTransition<TStatus extends string> {
  readonly fromStatus: TStatus | null;
  readonly toStatus: TStatus;
  /** The `audit_event.action` the transition emits. */
  readonly auditAction: string;
  /** Human-readable gate name, straight from the §2.2 diagram's edge labels. */
  readonly label: string;
}

/**
 * §2.2 `external_feed` — whether the onboarding state permits the MLLP listener to bind and dispatch.
 *
 * This is the LIFECYCLE leg only. `active` means the registry permits binding; the per-feed sender
 * allowlist (§4.11.2), the M40 BAA gate (D16), the channel cert pin (§8.7) and the rate limit are further
 * gates the listener applies on top. Reading `active` as "every message on this feed will land" is the
 * mistake this posture is documented to prevent.
 */
export type ExternalFeedServePosture =
  /** `active` — the listener may bind and the transmitter may dispatch behind the further per-feed gates. */
  | { readonly kind: "serving" }
  /** `proposed` / `pending_approval` — awaiting the D18 compliance co-approval; no listener bound. */
  | { readonly kind: "awaiting_approval"; readonly status: "proposed" | "pending_approval" }
  /** `suspended` — BAA-expired / cert-pin-storm / allowlist-breach paused; listener unbound, resumable. */
  | { readonly kind: "suspended" }
  /** `revoked` / `rejected` — terminal; the feed is gone (row retained so every message's FK resolves). */
  | { readonly kind: "terminated"; readonly terminalStatus: "revoked" | "rejected" };

/**
 * §2.2 `hl7_inbound_proposal` — whether the proposal is still actionable by an M5/M6 reviewer.
 * `pending` is the only reviewable state; `matched_ambiguous` is a `pending` proposal whose match outcome
 * routes the reviewer to a candidate picker (§2.2). Terminal states are decided-is-decided (§2.6).
 */
export type Hl7ProposalReviewPosture =
  | { readonly kind: "reviewable"; readonly ambiguous: boolean }
  | { readonly kind: "decided"; readonly terminalStatus: "accepted" | "rejected" }
  | { readonly kind: "expired" };

// ── §3.5–§3.7 owned-table descriptors (the arguments M29-T02 passes to the M4 generators) ───────────────

/** The eleven tables `architecture/module-manifest.ts` gives M29. */
export type M29TableName =
  | "external_feed"
  | "external_feed_credential"
  | "external_feed_health"
  | "hl7_inbound_proposal"
  | "hl7_message_inbound"
  | "hl7_message_outbound"
  | "lab_observation"
  | "lab_observation_inbound_link"
  | "lab_observation_value"
  | "nppes_provider"
  | "nppes_sync_run";

/** The same eleven as a runtime list (the M4 trigger loop and the §8.1 RLS proof both iterate it). */
export const M29_TABLE_NAMES = [
  "external_feed",
  "external_feed_credential",
  "external_feed_health",
  "hl7_inbound_proposal",
  "hl7_message_inbound",
  "hl7_message_outbound",
  "lab_observation",
  "lab_observation_inbound_link",
  "lab_observation_value",
  "nppes_provider",
  "nppes_sync_run",
] as const satisfies readonly M29TableName[];

/**
 * §3.5 — which RLS shape each table takes.
 *
 *   `platform_shared` — no `organization_id`. `nppes_provider` + `nppes_sync_run`: `USING (true)` SELECT
 *                       platform-wide (any tenant reads the public NPPES directory), write only under the
 *                       `wardenx_admin` role via the nightly `withPlatformContext` sync (D11).
 *   `tenant_scoped`   — `organization_id` present, policy keyed ONLY on `app.org_id`. The other nine.
 */
export type M29TableTenancy = "platform_shared" | "tenant_scoped";

export const M29_TABLE_TENANCY: { readonly [K in M29TableName]: M29TableTenancy } = {
  external_feed: "tenant_scoped",
  external_feed_credential: "tenant_scoped",
  external_feed_health: "tenant_scoped",
  hl7_inbound_proposal: "tenant_scoped",
  hl7_message_inbound: "tenant_scoped",
  hl7_message_outbound: "tenant_scoped",
  lab_observation: "tenant_scoped",
  lab_observation_inbound_link: "tenant_scoped",
  lab_observation_value: "tenant_scoped",
  nppes_provider: "platform_shared",
  nppes_sync_run: "platform_shared",
};

/**
 * §3.6 — the columns the M4 write-audit trigger records as `<changed>` rather than by value.
 *
 * Every entry is a secret or a PHI-bearing payload. The HL7 raw-wire ciphers are denylisted to their
 * `payload_sha256` digest (a first-class column), so the audit reconstructs "what was transmitted" without
 * re-storing PHI (§3.6); `hl7_inbound_proposal.proposed_patient_candidate` carries a demographic candidate
 * and is captured by its hash digest. What stays OFF the list is verbatim on purpose: `status`, the
 * approvals, the decision rationale and the match outcome are exactly what a §164.528 accounting reads.
 */
export const M29_AUDIT_DENYLIST: { readonly [K in M29TableName]: readonly string[] } = {
  external_feed: [],
  external_feed_credential: ["secret_cipher"],
  external_feed_health: [],
  hl7_inbound_proposal: ["proposed_patient_candidate"],
  hl7_message_inbound: ["payload_cipher", "parsed_segments_cipher"],
  hl7_message_outbound: ["payload_cipher", "ack_payload_cipher"],
  lab_observation: [],
  lab_observation_inbound_link: [],
  lab_observation_value: [],
  nppes_provider: [],
  nppes_sync_run: [],
};

/**
 * ADR-0004 retention class each table's M4 trigger STAMPS.
 *
 * Nearly every M29 row IS part of the §164.528 disclosure-accounting record — an inbound HL7 message is a
 * receipt-of-disclosure event and a lab surfaced to an operator (or to M28 for FHIR egress) is itself a
 * disclosure — so the HL7 messages, proposals, lab rows, feed config, credentials, health rollup and sync
 * runs all file `compliance` (a future §164.528 request must reproduce the wire-shape transmitted years
 * later; the sending-hospital/reference-lab data-sharing agreements likewise mandate audit retention).
 * `nppes_provider` alone is `operational`: the public-directory record is rebuildable from a re-sync.
 * (`external_feed_health` ages at 90 days per §3.7 but its audit trail files `compliance` — the two are
 * distinct: retention of the ROW vs. retention of its audit event.)
 */
export const M29_AUDIT_RETENTION_CLASS: {
  readonly [K in M29TableName]: "operational" | "compliance" | "legal_hold";
} = {
  external_feed: "compliance",
  external_feed_credential: "compliance",
  external_feed_health: "compliance",
  hl7_inbound_proposal: "compliance",
  hl7_message_inbound: "compliance",
  hl7_message_outbound: "compliance",
  lab_observation: "compliance",
  lab_observation_inbound_link: "compliance",
  lab_observation_value: "compliance",
  nppes_provider: "operational",
  nppes_sync_run: "compliance",
};

/**
 * §3.6 — the columns holding a per-tenant DEK envelope-encrypted value (the `*_cipher` columns).
 * Encryption happens in the M29 service BEFORE insert and decryption at the service, never at the DB, so a
 * replica or a cold-storage backup never holds plaintext raw HL7 bytes or a channel secret. The redact-
 * then-persist ordering (§2.2 M29-F03): SUD segments are stripped at the wire boundary BEFORE these
 * ciphers are written — no raw pre-gate SUD wire bytes ever land encrypted-at-rest.
 */
export const M29_CIPHER_COLUMNS: { readonly [K in M29TableName]: readonly string[] } = {
  external_feed: [],
  external_feed_credential: ["secret_cipher"],
  external_feed_health: [],
  hl7_inbound_proposal: [],
  hl7_message_inbound: ["payload_cipher", "parsed_segments_cipher"],
  hl7_message_outbound: ["payload_cipher", "ack_payload_cipher"],
  lab_observation: [],
  lab_observation_inbound_link: [],
  lab_observation_value: [],
  nppes_provider: [],
  nppes_sync_run: [],
};

/**
 * §3.2 Phase B — the monthly RANGE-partitioned tables and their partition-key column (ADR-0022 D1.1, which
 * `arch:ddl` enforces: the PK must include the partition key). The lab-value child co-partitions with its
 * parent `lab_observation` on a denormalized received timestamp — M29-T02 owns the exact column name; the
 * descriptor names the intended key so the T02 migration and the RLS proof iterate one source of truth.
 */
export const M29_PARTITIONED_TABLES: {
  readonly [K in
    | "hl7_message_inbound"
    | "hl7_message_outbound"
    | "hl7_inbound_proposal"
    | "lab_observation"
    | "lab_observation_value"]: { readonly partitionKey: string };
} = {
  hl7_message_inbound: { partitionKey: "received_at" },
  // M29-T02 partitions the outbound table on `queued_at`, NOT the spec's `transmitted_at`: transmitted_at
  // is NULL while a message sits `queued`, and a partition key that is part of the composite PRIMARY KEY
  // must be NOT NULL. `queued_at` (NOT NULL, always present at insert) is the honest partition key;
  // transmitted_at stays a nullable data column (PostgreSQL wins over §3.2/§3.3).
  hl7_message_outbound: { partitionKey: "queued_at" },
  hl7_inbound_proposal: { partitionKey: "proposed_at" },
  lab_observation: { partitionKey: "received_at" },
  lab_observation_value: { partitionKey: "received_at" },
};

/**
 * §3.7 — the M4 `DataEraser` data class M29 registers at boot (M29-T02/T08 do the registering and widen
 * `DataClass`; T01 only NAMES it, so adding the union member without a registered eraser cannot fail
 * `validateErasers()` mid-wave).
 *
 * NOT a delete. The eraser is a targeted shred: it destroys the per-tenant DEK so every `*_cipher` column
 * (the raw HL7 payloads, the channel secret) becomes unrecoverable, re-encrypts
 * `hl7_inbound_proposal.proposed_patient_candidate` to null, tombstones the feed (`status='revoked'`) and
 * cascades `lab_observation → lab_observation_value/_inbound_link` — while every ROW survives with its
 * status, decision, `payload_sha256` and timestamps intact, because those rows ARE the §164.528
 * accounting-of-disclosures evidence (§3.7). `nppes_provider` has no tenant destruction path (platform,
 * rebuildable from re-sync).
 */
export const M29_ERASER_DATA_CLASS = "external_interfaces" as const;
export type M29EraserDataClass = typeof M29_ERASER_DATA_CLASS;

/**
 * §2.4 / §3.3 (M4 `auditRead()` = disclosure receipt) — the envelope every M29 read route stamps when it
 * surfaces HL7 message content, lab observation values, NPPES records, or inbound-proposal payloads.
 * Every such read is a HIPAA §164.528 accountable event; this is the shape the route hands `auditRead()`.
 * The interface is leaf-only DATA — the M4 audit writer (M29-T02+ wires it) owns the persistence.
 */
export interface Hl7ReadDisclosureEnvelope {
  readonly organizationId: OrgId;
  /** The membership that performed the read (the disclosing actor). */
  readonly actorMembershipId: MembershipId;
  /** Which M29 surface was read — anchors the accounting to a table + row. */
  readonly resource: M29TableName;
  readonly resourceId: string;
  /** The patient whose PHI was disclosed, when the read resolves to one (null for feed/NPPES admin reads). */
  readonly patientId: PatientId | null;
  readonly disclosedAt: IsoInstant;
}
