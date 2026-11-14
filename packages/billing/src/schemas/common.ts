// @chartwarden/billing — shared TypeBox fragments for the M23 route request/response contracts (§4.1 / §4.2).
//
// PURE DOMAIN (shape contracts only): TypeBox schemas + their `Static` types. NO Fastify, NO Drizzle, NO
// handlers — the routes (P3) import these as `{ schema: { body, querystring, params, response } }`. The
// validation/lifecycle/penny-math invariants behind each shape are enforced at the service layer, never
// here (a TypeBox schema is a SHAPE gate only — the M33 `@chartwarden/reporting` schema precedent).
//
// ENUM VOCABULARY — the API/wire surface speaks the **DB pgEnum** vocabulary (UPPERCASE claim/notice
// states, the full `m23_eligibility_outcome` union), MATCHING the spec §4.2 worked examples
// (`Type.Literal('DRAFT')`, `'mbi_invalid'`, …) and the row projections the repositories return. This is
// the deliberate boundary the kernel report flagged: `contracts.ts` carries the package-canonical
// LOWERCASE `ClaimState`/`EligibilityOutcome` the reducers speak; the Phase-3 repository/service maps
// case at the DB↔domain boundary. These route schemas live on the DB side of that boundary.
import { type Static, type TSchema, Type } from "@sinclair/typebox";

// ── primitive fragments ─────────────────────────────────────────────────────────────────────────────────
/** A v4/v7 UUID id. */
export const Uuid = Type.String({ format: "uuid" });
/** ISO-8601 calendar date (`YYYY-MM-DD`). */
export const IsoDateSchema = Type.String({ format: "date" });
/** ISO-8601 instant (`YYYY-MM-DDTHH:mm:ss.sssZ`). */
export const IsoDateTimeSchema = Type.String({ format: "date-time" });
/** Whole integer cents — the canonical money boundary type (never a float; mirrors `domain/money.ts`). */
export const CentsSchema = Type.Integer();
/** A non-negative whole count. */
export const Count = Type.Integer({ minimum: 0 });
/** A decimal carried as a STRING (percentages / wage-index factors — never a float on the wire). */
export const DecimalString = Type.String({ pattern: "^-?\\d+(\\.\\d+)?$" });

// ── enum schemas (mirror the frozen `packages/db/src/schema/billing` pgEnums — DB vocabulary) ────────────
/** `m23_claim_state` — UPPERCASE (the wire/DB vocabulary; the reducer speaks lowercase `ClaimState`). */
export const ClaimStateApi = Type.Union([
  Type.Literal("DRAFT"),
  Type.Literal("VALIDATING"),
  Type.Literal("READY"),
  Type.Literal("SUBMITTED"),
  Type.Literal("ACK_PENDING"),
  Type.Literal("ACK_ACCEPTED"),
  Type.Literal("ACK_REJECTED"),
  Type.Literal("ACK_PARTIAL"),
  Type.Literal("PAID"),
  Type.Literal("DENIED"),
  Type.Literal("REPLACED"),
  Type.Literal("VOIDED"),
]);

/** `m23_claim_tob` — full UB-04 Type-of-Bill set (817/818 produced only by :replace / :void). */
export const ClaimTobApi = Type.Union([
  Type.Literal("811"),
  Type.Literal("812"),
  Type.Literal("813"),
  Type.Literal("814"),
  Type.Literal("817"),
  Type.Literal("818"),
]);

/** The TOBs a tenant may assemble directly (817/818 go through dedicated routes — spec §4.2). */
export const ClaimTobAssemblable = Type.Union([
  Type.Literal("811"),
  Type.Literal("812"),
  Type.Literal("813"),
  Type.Literal("814"),
]);

/** `m23_claim_line_level_of_care`. */
export const LevelOfCareApi = Type.Union([
  Type.Literal("RHC"),
  Type.Literal("CHC"),
  Type.Literal("IRC"),
  Type.Literal("GIP"),
]);

/** `m23_noe_state` / `m23_notr_state` (identical 7-state shape). */
export const NoticeStateApi = Type.Union([
  Type.Literal("DRAFT"),
  Type.Literal("READY"),
  Type.Literal("SUBMITTED"),
  Type.Literal("ACK_PENDING"),
  Type.Literal("ACK_ACCEPTED"),
  Type.Literal("ACK_REJECTED"),
  Type.Literal("CANCELLED"),
]);

/** Server-authoritative notice deadline and lifecycle assessment; no client-computable acceptance state. */
export const MedicareNoticeDeadlineApi = Type.Object({
  applies: Type.Boolean(),
  basis: Type.String(),
  policyVersion: Type.Literal("CMS-100-04-Ch11-20.1.1-20.1.2-2024-06-03"),
  triggerDate: Type.Union([IsoDateSchema, Type.Null()]),
  dueDate: Type.Union([IsoDateSchema, Type.Null()]),
  risk: Type.Union([
    Type.Literal("not_applicable"), Type.Literal("not_determinable"), Type.Literal("on_track"),
    Type.Literal("approaching"), Type.Literal("due_today"), Type.Literal("overdue"),
    Type.Literal("submitted_awaiting_verification"), Type.Literal("accepted_within_deadline"),
    Type.Literal("accepted_after_deadline"), Type.Literal("filing_timeliness_unknown"), Type.Literal("transport_rejected"), Type.Literal("rejected"),
  ]),
  lifecycle: Type.Union([
    Type.Literal("draft"), Type.Literal("ready"), Type.Literal("submission_requested"),
    Type.Literal("dispatch_started"), Type.Literal("transport_receipt_confirmed"), Type.Literal("transport_rejected"),
    Type.Literal("known_not_sent"), Type.Literal("outcome_unknown"), Type.Literal("awaiting_mac_acknowledgment"),
    Type.Literal("mac_accepted_verified"), Type.Literal("mac_rejected_verified"), Type.Literal("external_filing_recorded"),
    Type.Literal("cancelled"), Type.Literal("unknown"),
  ]),
  acceptance: Type.Union([Type.Literal("verified"), Type.Literal("not_verified"), Type.Literal("unknown")]),
  acceptedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  timeliness: Type.Union([Type.Literal("timely"), Type.Literal("late"), Type.Literal("unknown"), Type.Literal("not_applicable")]),
  followUp: Type.String(),
});

export const NoticeEvidenceEventApi = Type.Object({
  kind: Type.Union([
    Type.Literal("notice_created"), Type.Literal("submission_requested"), Type.Literal("dispatch_started"),
    Type.Literal("transport_receipt_recorded"), Type.Literal("external_filing_recorded"),
    Type.Literal("mac_accepted"), Type.Literal("mac_rejected"),
  ]),
  source: Type.Union([
    Type.Literal("m23_notice_record"), Type.Literal("m23_submission_attempt"), Type.Literal("tenant_recorded_external_filing"),
    Type.Literal("verified_mac_acknowledgment"),
  ]),
  at: IsoDateTimeSchema,
  referenceId: Uuid,
  submissionId: Type.Union([Uuid, Type.Null()]),
  verification: Type.Union([Type.Literal("recorded"), Type.Literal("verified")]),
  safeSummary: Type.String(),
});

export const NoticeAttemptSummaryApi = Type.Union([
  Type.Object({
    submissionId: Uuid,
    attemptIndex: Type.Integer({ minimum: 0 }),
    outcome: Type.String(),
    dispatchState: Type.Union([Type.Literal("pending"), Type.Literal("sending"), Type.Literal("in_doubt"), Type.Literal("finished")]),
    dispatchStartedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    submittedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
    createdAt: IsoDateTimeSchema,
  }),
  Type.Null(),
]);

/** `m23_notr_trigger_kind`. */
export const NotrTriggerKindApi = Type.Union([
  Type.Literal("revocation"),
  Type.Literal("transfer_out"),
  Type.Literal("discharge"),
]);

/** `m23_validation_severity`. */
export const ValidationSeverityApi = Type.Union([
  Type.Literal("error"),
  Type.Literal("warn"),
  Type.Literal("info"),
]);

/** `m23_validation_result_outcome`. */
export const ValidationResultOutcomeApi = Type.Union([
  Type.Literal("pass"),
  Type.Literal("fail"),
  Type.Literal("warn"),
  Type.Literal("info"),
]);

/** `m23_validation_run_trigger`. */
export const ValidationRunTriggerApi = Type.Union([
  Type.Literal("initial_assembly"),
  Type.Literal("pre_submission"),
  Type.Literal("re_validation_after_correction"),
  Type.Literal("re_validation_after_override"),
  Type.Literal("manual_re_run"),
]);

/** `m23_validation_run_outcome`. */
export const ValidationRunOutcomeApi = Type.Union([
  Type.Literal("all_pass"),
  Type.Literal("failures_present"),
  Type.Literal("overrides_required"),
  Type.Literal("ready_for_submission"),
]);

/** `m23_override_role_required`. */
export const OverrideRoleApi = Type.Union([
  Type.Literal("billing_manager"),
  Type.Literal("compliance_officer"),
  Type.Literal("medical_director"),
  Type.Literal("org_admin"),
]);

/** `m23_mac_jurisdiction`. */
export const MacJurisdictionApi = Type.Union([
  Type.Literal("ngs_j6"),
  Type.Literal("ngs_jk"),
  Type.Literal("cgs_j15"),
  Type.Literal("palmetto_jj"),
  Type.Literal("palmetto_jm"),
  Type.Literal("noridian_jf"),
  Type.Literal("noridian_je"),
]);

/** `m23_eligibility_outcome` — the DB union (carries `mbi_invalid` / `hets_error`; spec §4.2). */
export const EligibilityOutcomeApi = Type.Union([
  Type.Literal("active_part_a"),
  Type.Literal("inactive_part_a"),
  Type.Literal("mbi_invalid"),
  Type.Literal("unknown_response"),
  Type.Literal("hets_error"),
]);

/** `m23_claim_submission_outcome`. */
export const SubmissionOutcomeApi = Type.Union([
  Type.Literal("queued"),
  Type.Literal("generated"),
  Type.Literal("submitted"),
  Type.Literal("failed_worker"),
  Type.Literal("failed_portal"),
  Type.Literal("held_stale_source"),
]);

/** `m23_claim_submission_kind`. */
export const SubmissionKindApi = Type.Union([
  Type.Literal("claim_837i"),
  Type.Literal("noe"),
  Type.Literal("notr"),
  Type.Literal("transfer_notice"),
]);

/** `m23_claim_acknowledgment_kind`. */
export const AcknowledgmentKindApi = Type.Union([
  Type.Literal("ack_999"),
  Type.Literal("ack_277ca"),
  Type.Literal("ack_835"),
]);

// ── cursor pagination + concurrency fragments ───────────────────────────────────────────────────────────
/**
 * The shared opaque-cursor page query (§4.1 "cursor-paginated"). `cursor` is an opaque continuation token
 * the service mints from the last row's keyset; clients echo it verbatim. `limit` is bounded.
 */
export const CursorPageQuery = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});
export type CursorPageQuery = Static<typeof CursorPageQuery>;

/**
 * Wraps an item schema in the canonical `{ items, nextCursor }` page envelope. `nextCursor === null` ⇒
 * the last page. (TypeBox generic helper — every list response composes this.)
 */
export function PageOf<T extends TSchema>(item: T) {
  return Type.Object({
    items: Type.Array(item),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  });
}

/**
 * The optimistic-concurrency guard for any mutation whose target carries a `version` column (§2.5). The
 * routes ALSO accept the `If-Match` header; this body field is the spec §4.2 in-payload form (`ifVersion`)
 * — the service treats whichever is present as the precondition and answers 409 STALE_VERSION on mismatch.
 */
export const IfVersion = Type.Integer({ minimum: 0 });

// ── error envelope (documentary; the global error plugin emits this shape) ───────────────────────────────
/**
 * The structured error body every 4xx/5xx returns. `code` is the SCREAMING_SNAKE machine code documented
 * per route in §4.2 (e.g. `CLAIM_NOT_READY`, `STALE_VERSION`); `details` carries PHI-free context (e.g.
 * the failing rule keys on a 422 `VALIDATION_FAILURES_PRESENT`).
 */
export const ApiError = Type.Object({
  code: Type.String(),
  message: Type.String(),
  details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});
export type ApiError = Static<typeof ApiError>;
