// apps/backend/src/modules/23-billing-medicare/routes/billing-typebox.ts — M23 (§4.2) request schemas.
//
// TypeBox path-param / query / body schemas for the §4.1 M23 routes + the `parse(...)` helper. Named
// `billing-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import
// for a Drizzle one (the M27 `cost-report-typebox` precedent). Validation runs through TypeBox `Value` →
// M1's VALIDATION_FAILED envelope. Org/actor/membership binding is ALWAYS server-side (request.context) — no
// body/query carries an org id or an authoring/acting/overriding membership id.
//
// VOCAB NOTE: the body/query string-literal unions mirror the FROZEN `@wardenx/db` pgEnum value lists +
// the @wardenx/billing route-service CONTRACT arg shapes (the lowercase domain alphabet the read/write
// services speak — enum case is mapped at the repository boundary). The optimistic-concurrency version is
// carried on the `If-Match` header (§2.5; see concurrency.ts), NOT in the body.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set("date", (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
}

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));
const uuid = () => Type.String({ format: "uuid" });
const isoDate = () => Type.String({ format: "date" });
const decimal = () => Type.String({ pattern: "^-?\\d+(\\.\\d+)?$" });

// ── §3 vocab mirrors (canonical pgEnums live in @wardenx/db / @wardenx/billing contracts) ────────────────
const VALIDATION_SEVERITY = ["error", "warn", "info"] as const;
const OVERRIDE_ROLE = [
  "billing_manager",
  "compliance_officer",
  "medical_director",
  "org_admin",
] as const;
const NOTICE_STATE = [
  "draft",
  "ready",
  "submitted",
  "ack_pending",
  "ack_accepted",
  "ack_rejected",
  "cancelled",
] as const;
const CLAIM_STATE = [
  "draft",
  "validating",
  "ready",
  "submitted",
  "ack_pending",
  "ack_accepted",
  "ack_rejected",
  "ack_partial",
  "paid",
  "denied",
  "replaced",
  "voided",
] as const;
const NOTR_TRIGGER_KIND = ["revocation", "transfer_out", "discharge"] as const;
const MAC_JURISDICTION = [
  "ngs_j6",
  "ngs_jk",
  "cgs_j15",
  "palmetto_jj",
  "palmetto_jm",
  "noridian_jf",
  "noridian_je",
] as const;

// ── cursor / keyset page query (§4.1.2 — opaque cursor + clamp-to-200 limit) ─────────────────────────────
const PageQuery = {
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
};

// ── path params ──────────────────────────────────────────────────────────────────────────────────────
export const ClaimIdParamsSchema = Type.Object({ id: uuid() });
export const ValidationRunParamsSchema = Type.Object({ id: uuid(), runId: uuid() });
export const OverrideParamsSchema = Type.Object({ id: uuid(), runId: uuid(), resultId: uuid() });
export const RuleConfigIdParamsSchema = Type.Object({ id: uuid() });
export const NoeIdParamsSchema = Type.Object({ id: uuid() });
export const NotrIdParamsSchema = Type.Object({ id: uuid() });
export const ProviderEntityParamsSchema = Type.Object({ providerEntityId: uuid() });

// ── list / read queries ──────────────────────────────────────────────────────────────────────────────
export const NoeListQuerySchema = Type.Object({
  ...PageQuery,
  providerEntityId: Type.Optional(uuid()),
  patientId: Type.Optional(uuid()),
  admissionId: Type.Optional(uuid()),
  state: Type.Optional(lit(NOTICE_STATE)),
});
export const NotrListQuerySchema = Type.Object({
  ...PageQuery,
  providerEntityId: Type.Optional(uuid()),
  patientId: Type.Optional(uuid()),
  admissionId: Type.Optional(uuid()),
  triggerKind: Type.Optional(lit(NOTR_TRIGGER_KIND)),
  state: Type.Optional(lit(NOTICE_STATE)),
});
export const RuleConfigListQuerySchema = Type.Object({
  ...PageQuery,
  enabled: Type.Optional(Type.Boolean()),
  isCustom: Type.Optional(Type.Boolean()),
});
export const ValidationRunListQuerySchema = Type.Object({
  state: Type.Optional(lit(CLAIM_STATE)),
});
export const PatientQuerySchema = Type.Object({ patientId: uuid() });
export const ProviderEntityQuerySchema = Type.Object({ providerEntityId: Type.Optional(uuid()) });
export const RequiredProviderEntityQuerySchema = Type.Object({ providerEntityId: uuid() });
export const MacCredentialListQuerySchema = Type.Object({ ...PageQuery });
export const MetricsQuerySchema = Type.Object({ providerEntityId: Type.Optional(uuid()) });

// ── validation / override bodies ───────────────────────────────────────────────────────────────────────
export const OverrideValidationResultBodySchema = Type.Object({
  /** ≥40-char typed billing rationale (CHECK-enforced; server re-validated). */
  reason: Type.String({ minLength: 40, maxLength: 2000 }),
  overrideRole: lit(OVERRIDE_ROLE),
});

// ── rule-config bodies ─────────────────────────────────────────────────────────────────────────────────
export const CreateRuleConfigBodySchema = Type.Object({
  ruleKey: Type.String({ minLength: 1, maxLength: 128 }),
  severity: lit(VALIDATION_SEVERITY),
  enabled: Type.Optional(Type.Boolean()),
  overrideRoleRequired: Type.Optional(lit(OVERRIDE_ROLE)),
  parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  predicateDsl: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  setReason: Type.Optional(Type.String({ minLength: 20, maxLength: 2000 })),
  ruleVersion: Type.Optional(Type.Integer({ minimum: 1 })),
});
export const UpdateRuleConfigBodySchema = Type.Object({
  enabled: Type.Optional(Type.Boolean()),
  severity: Type.Optional(lit(VALIDATION_SEVERITY)),
  overrideRoleRequired: Type.Optional(lit(OVERRIDE_ROLE)),
  parameters: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  predicateDsl: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  setReason: Type.Optional(Type.String({ minLength: 20, maxLength: 2000 })),
});

// ── NOE / NOTR cancel bodies (the §2.2 guard facts; version is the If-Match header) ──────────────────────
export const CancelNoeBodySchema = Type.Object({ electionReversed: Type.Boolean() });
export const CancelNotrBodySchema = Type.Object({ terminatingEventReversed: Type.Boolean() });

// ── eligibility body ───────────────────────────────────────────────────────────────────────────────────
export const CheckEligibilityBodySchema = Type.Object({
  patientId: uuid(),
  providerEntityId: uuid(),
  asOfServiceDate: isoDate(),
});

// ── MAC-credential upsert body (clientSecret is write-only; encrypted at the boundary) ──────────────────
export const UpsertMacCredentialBodySchema = Type.Object({
  providerEntityId: uuid(),
  macJurisdiction: lit(MAC_JURISDICTION),
  submitterId: Type.String({ minLength: 1, maxLength: 64 }),
  tradingPartnerId: Type.String({ minLength: 1, maxLength: 64 }),
  clientId: Type.String({ minLength: 1, maxLength: 256 }),
  clientSecret: Type.String({ minLength: 1, maxLength: 4096 }),
  baaRecordRef: Type.Optional(Type.String({ maxLength: 256 })),
  credentialExpiresAt: Type.Optional(Type.String({ format: "date-time" })),
});

// ── claims-core (route group A): list query / assemble / DRAFT-edit bodies ───────────────────────────────
// (assemble / replace / void / submit / manual-validate request shapes are the @wardenx/billing route-
// contract schemas; the claims.routes.ts plugin imports those from the package and `parse`s them here.)

const LEVEL_OF_CARE = [
  "routine_home_care",
  "continuous_home_care",
  "inpatient_respite_care",
  "general_inpatient_care",
] as const;

/** route #2: GET /claims (cursor-paginated). The `state` filter speaks the lowercase domain alphabet the
 * read-service `ClaimListFilter` consumes (enum case is mapped at the repository boundary, NOT here). */
export const ClaimListQuerySchema = Type.Object({
  ...PageQuery,
  providerEntityId: Type.Optional(uuid()),
  patientId: Type.Optional(uuid()),
  state: Type.Optional(lit(CLAIM_STATE)),
  attention: Type.Optional(
    Type.Union([Type.Literal("missing_discharge_details"), Type.Literal("tob_changed")], {
      description:
        "Only claims needing this action: `missing_discharge_details` (the stay ended by a death with no place " +
        "of death or a transfer-out with no receiving care setting — the patient status cannot be derived) or " +
        "`tob_changed` (the Type of Bill derived from how the stay ended differs from the stored one). Scans " +
        "up to 1,000 claims per request; follow `nextCursor` to continue.",
    }),
  ),
});

/**
 * One assembled `claim_line` the DRAFT-edit (re-assembly) body carries — mirrors the write-service
 * `AssembledClaimLineInput` exactly (`line_charge = unit_count × unit_rate`, CHECK-enforced downstream).
 * `claim_line` is INTERNAL-WRITE-ONLY (§3.3): this shape only reaches the write service's draft re-assembly
 * path; there is no external line-mutation route.
 */
export const AssembledClaimLineBodySchema = Type.Object({
  lineNumber: Type.Integer({ minimum: 1 }),
  revenueCode: Type.String({ minLength: 4, maxLength: 4 }),
  qCode: Type.String({ minLength: 5, maxLength: 5 }),
  levelOfCare: lit(LEVEL_OF_CARE),
  hcpcsCode: Type.Optional(Type.String({ maxLength: 16 })),
  serviceDateFrom: isoDate(),
  serviceDateTo: isoDate(),
  unitCount: Type.Integer({ minimum: 0 }),
  unitRateCents: Type.Integer({ minimum: 0 }),
  lineChargeCents: Type.Integer({ minimum: 0 }),
  levelOfCarePeriodId: uuid(),
  modifiers: Type.Optional(Type.Array(Type.String({ maxLength: 8 }))),
  icdPointerPositions: Type.Optional(Type.Array(Type.Integer({ minimum: 1 }))),
  backingEncounterIds: Type.Optional(Type.Array(uuid())),
});

/**
 * route #4: PATCH /claims/:id DRAFT-edit body. The implemented P3 write service (`updateDraftClaim`) edits a
 * DRAFT by REPLACING its line set + totals (re-assembly); the §2.5 optimistic-concurrency version is carried
 * on the `If-Match` header (NOT the body — see concurrency.ts). The Coder's `coder_icd_only_scope`
 * field-allowlist (§6 / §4.7) is enforced IN the handler over this body: a Coder-restricted actor may not
 * carry the economic `totalChargeCents` / `totalExpectedPaymentCents` fields (FIELD_OUT_OF_SCOPE → 403).
 */
export const ClaimPatchDraftBodySchema = Type.Object({
  lines: Type.Array(AssembledClaimLineBodySchema, { maxItems: 512 }),
  totalChargeCents: Type.Optional(Type.Integer({ minimum: 0 })),
  totalExpectedPaymentCents: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ClaimPatchDraftBody = Static<typeof ClaimPatchDraftBodySchema>;

/**
 * Validate `raw` against `schema` (Convert-then-Check), throwing M1's VALIDATION_FAILED envelope on the
 * first error (the M27 `parse(...)` precedent). The route handlers call this on params/query/body so a
 * malformed request is refused with the platform error shape before the service is reached.
 */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  const converted = Value.Convert(schema, raw ?? {});
  if (!Value.Check(schema, converted)) {
    const first = [...Value.Errors(schema, converted)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return converted as Static<T>;
}

// ── GET /billing/eligibility/hospice-periods response (the readmission screen's HETS history) ───────────
const nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const ELIGIBILITY_OUTCOME = [
  "active_part_a",
  "inactive_part_a",
  "mbi_invalid",
  "indeterminate",
  "error",
] as const;
const NEXT_PERIOD_BASIS = [
  "computed",
  "election_open",
  "election_status_uncertain",
  "unbilled_election",
  "history_truncated",
] as const;

export const HospicePeriodSchema = Type.Object({
  kind: lit(["election", "benefit_period"] as const),
  periodNumber: nullable(Type.Integer({ minimum: 1 })),
  startDate: isoDate(),
  endDate: nullable(isoDate()),
  hospiceNpi: nullable(Type.String({ pattern: "^\\d{10}$" })),
  revocationOrDischargeDate: nullable(isoDate()),
  revocationCode: nullable(lit(["0", "1", "2", "3"] as const)),
  daysUsed: nullable(Type.Integer({ minimum: 0 })),
});

/** `?patientId=&electionDate=` — `electionDate` asks for the RHC carry-over of a new election on that date. */
export const HospicePeriodsQuerySchema = Type.Object({
  patientId: uuid(),
  electionDate: Type.Optional(isoDate()),
});

/**
 * The two-tier RHC day-count carry-over (`computeRhcCarryOver`, Claims Processing Manual ch. 11 §30.2): the prior
 * hospice days (ours + other hospices' per HETS) a new election continues, the chain counted, the basis and any
 * warnings. Shared by the hospice-periods read and the claim detail's `pricing.hipps.rhcCarryOver`.
 */
export const RhcCarryOverSchema = Type.Object({
  electionDate: isoDate(),
  priorDays: Type.Integer({ minimum: 0, maximum: 60 }),
  chainDays: Type.Integer({ minimum: 0 }),
  basis: lit(["internal_only", "hets_merged", "hets_stale"] as const),
  startsAtDay: Type.Integer({ minimum: 1 }),
  highRateDaysRemaining: Type.Integer({ minimum: 0 }),
  daysSinceLastCare: nullable(Type.Integer()),
  chain: Type.Array(
    Type.Object({
      source: lit(["internal", "hets"] as const),
      kind: lit(["stay", "election", "benefit_period"] as const),
      start: isoDate(),
      end: isoDate(),
      endAssumed: Type.Boolean(),
      countedDays: Type.Integer({ minimum: 0 }),
      hospiceNpi: nullable(Type.String()),
      ref: nullable(Type.String()),
    }),
  ),
  warnings: Type.Array(Type.Object({ code: Type.String(), message: Type.String() })),
  hetsCheck: nullable(
    Type.Object({
      checkId: uuid(),
      checkedAt: Type.String({ format: "date-time" }),
      ageDays: Type.Integer({ minimum: 0 }),
      stale: Type.Boolean(),
    }),
  ),
});

export const HospicePeriodsResponseSchema = Type.Object({
  status: lit(["available", "no_check_on_file", "hets_not_configured"] as const),
  hetsConfigured: Type.Boolean(),
  patientId: uuid(),
  checkId: nullable(uuid()),
  asOfServiceDate: nullable(isoDate()),
  outcome: nullable(lit(ELIGIBILITY_OUTCOME)),
  checkedAt: nullable(Type.String({ format: "date-time" })),
  staleAt: nullable(Type.String({ format: "date-time" })),
  stale: nullable(Type.Boolean()),
  synthetic: Type.Boolean(),
  hospiceHistoryReturned: Type.Boolean(),
  hospiceElectionOpen: nullable(Type.Boolean()),
  hospiceHistoryTruncated: nullable(Type.Boolean()),
  hospicePeriods: Type.Array(HospicePeriodSchema),
  nextPeriodNumber: nullable(Type.Integer({ minimum: 1 })),
  nextPeriodBasis: nullable(lit(NEXT_PERIOD_BASIS)),
  lastAttempt: nullable(
    Type.Object({
      checkId: uuid(),
      outcome: lit(ELIGIBILITY_OUTCOME),
      checkedAt: Type.String({ format: "date-time" }),
      reason: nullable(Type.String()),
    }),
  ),
  rhcCarryOver: nullable(RhcCarryOverSchema),
});
export type HospicePeriodsResponse = Static<typeof HospicePeriodsResponseSchema>;
