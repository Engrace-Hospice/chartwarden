// apps/backend/src/modules/24-billing-medicaid/routes/m24-typebox.ts — M24 (§4.2) request/response schemas.
//
// TypeBox request bodies, list queries, and response DTOs for the §4.1 Billing — Medicaid routes (claims,
// validation, rule config, eligibility, R&B arrangements/days, trading-partner credentials, platform admin).
// The OpenAPI enrichment registry (scripts/openapi/enrichments.ts) layers these onto the auto-discovered
// routes so the generated client (packages/ui/src/core/api/schema.ts) types the M24 surface the P4 web
// screens call — the M26 `m26-typebox` / M27 `cost-report-typebox` precedent. Named `m24-typebox` (NOT
// `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import for a Drizzle one.
//
// The shapes MIRROR the module's own service interfaces — read-service.ts (`*View`) and write-service.ts
// (`*Input`) — and the string-literal unions mirror the FROZEN `@wardenx/db` pgEnum value lists
// (packages/db/src/schema/medicaid-billing/enums.ts) plus the @wardenx/medicaid-adapters contract unions;
// the schema wins on conflict. Money is ALWAYS integer cents (D8). Org/actor/membership binding is server-
// side (request.context) — no body or query carries an org id or an acting membership id. A Recipient ID is
// never returned (only the masked last-4 fact; D12 / §3.6) and credential secrets are write-only (the read
// DTO carries presence flags only).
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

function check<T extends TSchema>(schema: T, value: unknown): Static<T> {
  if (!Value.Check(schema, value)) {
    const first = [...Value.Errors(schema, value)][0];
    const field = first ? first.path.replace(/^\//, "").replace(/\//g, ".") || "(root)" : "(root)";
    throw new ValidationError("request validation failed", [
      { field, code: "INVALID", message: first?.message ?? "invalid request" },
    ]);
  }
  return value as Static<T>;
}

/**
 * Validate a request BODY against its §4.2 schema at the route boundary. A failure raises M1's
 * VALIDATION_FAILED envelope with the offending field path (the M27 `cost-report-typebox` precedent), so a
 * malformed request is rejected BEFORE it reaches a service rather than surfacing as a downstream type error.
 *
 * Deliberately does NOT run `Value.Convert`: a JSON body already carries real types, and coercing it would
 * silently repair genuinely wrong input — `nfPerDiemRoutineCents: 210.5` would truncate to 210, turning a
 * client bug into a money bug. A body that sends the wrong type is rejected, not rounded. Queries are the
 * only place coercion is legitimate (everything arrives as a string) — use `parseQuery` there.
 */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, raw ?? {});
}

/**
 * Validate a request QUERY against its §4.2 schema, converting the declared scalars first — `?limit=25`
 * arrives as the string "25" and must land as a number. Same VALIDATION_FAILED envelope on failure.
 */
export function parseQuery<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, Value.Convert(schema, raw ?? {}));
}

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));
const uuid = () => Type.String({ format: "uuid" });
const isoInstant = () => Type.String({ format: "date-time" });
const isoDate = () => Type.String({ format: "date" });
const nullableStr = () => Type.Union([Type.String(), Type.Null()]);
const nullableInt = () => Type.Union([Type.Integer(), Type.Null()]);
const cents = () => Type.Integer({ description: "Integer cents (D8)" });

// ── §3.3 vocab mirrors (canonical pgEnums live in @wardenx/db/schema/medicaid-billing/enums.ts) ─────────
const CLAIM_STATE = [
  "DRAFT",
  "VALIDATING",
  "FAILED_VALIDATION",
  "READY",
  "AWAITING_MEDICARE_PRIMARY",
  "FAILED_MEDICARE_PRIMARY",
  "SUBMITTED",
  "POLLING",
  "ACK_PENDING",
  "ACK_TIMEOUT",
  "ACK_ACCEPTED",
  "ACK_REJECTED",
  "ACK_PARTIAL",
  "PAID",
  "DENIED",
  "REPLACED",
  "VOIDED",
  "ABANDONED",
] as const;
const CLAIM_KIND = ["combined_hospice_rb", "hospice_only", "rb_only"] as const;
const CLAIM_LINE_LOC = ["RHC", "CHC", "IRC", "GIP", "NF_RB"] as const;
const TOB = ["811", "812", "813", "814", "817", "818"] as const;
const SUBMISSION_RESULT = [
  "pending",
  "accepted_sync",
  "pending_async",
  "rejected_sync",
  "transport_failure",
  "timeout",
  "cancelled",
] as const;
const ACK_KIND = ["sync_999", "sync_277ca", "async_state_specific"] as const;
const ACK_OUTCOME = ["accepted", "rejected", "partial"] as const;
const VALIDATION_OUTCOME = ["pass", "fail", "warn", "info", "skip_not_applicable"] as const;
const ELIGIBILITY_OUTCOME = ["active", "inactive", "unknown", "mco_assignment", "error"] as const;
const RB_ARRANGEMENT_STATE = ["DRAFT", "ACTIVE", "EXPIRED", "TERMINATED", "SUPERSEDED"] as const;
const RB_DAY_STATUS = ["pending", "billable", "excluded", "voided", "billed"] as const;
const CHANNEL = [
  "direct_mmis",
  "cco_clearinghouse",
  "sftp",
  "portal",
  "state_proprietary",
] as const;
/** §4.7 override-eligible roles (the claimed role is re-checked server-side against the actor's grants). */
const OVERRIDE_ROLE = [
  "billing_manager",
  "compliance_officer",
  "medical_director",
  "org_admin",
] as const;
/** The rb_day statuses a §5.1 manual override may set (`billed` is system-only). */
const RB_DAY_OVERRIDE_STATUS = ["pending", "billable", "excluded", "voided"] as const;
/** A two-letter USPS state code — the M24 service state (Phase 1 ships the Oregon adapter). */
const StateCode = Type.String({ minLength: 2, maxLength: 2, pattern: "^[A-Z]{2}$" });

// ── request bodies (§4.2) ───────────────────────────────────────────────────────────────────────────────

/** POST /api/v1/medicaid-claims — assemble a draft over a patient + service range (§2.1). */
export const AssembleClaimBody = Type.Object(
  {
    patientId: uuid(),
    admissionId: uuid(),
    providerEntityId: uuid(),
    serviceFrom: isoDate(),
    serviceTo: isoDate(),
    kind: lit(CLAIM_KIND),
    rbArrangementId: Type.Optional(uuid()),
    medicareClaimId: Type.Optional(uuid()),
  },
  { additionalProperties: false },
);

/** PATCH /api/v1/medicaid-claims/:id — the only editable draft field is the MCO routing target. */
export const UpdateDraftClaimBody = Type.Object(
  { mcoId: Type.Optional(Type.Union([uuid(), Type.Null()])) },
  { additionalProperties: false },
);

/** POST …/:id/submit — the channel hint is advisory; the adapter resolves the real channel (§4.4). */
export const SubmitClaimBody = Type.Object(
  { channelHint: Type.Optional(lit(CHANNEL)) },
  { additionalProperties: false },
);

/** POST …/:id/replace — builds the TOB-817 replacement draft. Reason ≥40 chars (server CHECK-enforced). */
export const ReplaceClaimBody = Type.Object(
  { reason: Type.String({ minLength: 40 }) },
  { additionalProperties: false },
);

/** POST …/:id/void — builds the TOB-818 void draft. Reason ≥40 chars (server CHECK-enforced). */
export const VoidClaimBody = Type.Object(
  { reason: Type.String({ minLength: 40 }) },
  { additionalProperties: false },
);

/** POST /api/v1/medicaid-validation-results/:id/override — §D14 step-up + role-eligibility server-side. */
export const ApplyOverrideBody = Type.Object(
  {
    reason: Type.String({ minLength: 40 }),
    overrideRoleClaimed: lit(OVERRIDE_ROLE),
  },
  { additionalProperties: false },
);

/** PATCH /api/v1/medicaid-rule-config/:ruleKey — the per-tenant overlay (regulatory-required rules lock). */
export const EditRuleConfigBody = Type.Object(
  {
    enabled: Type.Optional(Type.Boolean()),
    parametersOverlay: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: false },
);

/** POST /api/v1/medicaid-rule-config/custom — a tenant custom rule over the §11 predicate DSL. */
export const CreateCustomRuleBody = Type.Object(
  {
    ruleKey: Type.String({ minLength: 3, maxLength: 128 }),
    customPredicateDsl: Type.Unknown(),
    customSeverity: lit(["error", "warn", "info"] as const),
    customOverrideRole: Type.Optional(lit(OVERRIDE_ROLE)),
  },
  { additionalProperties: false },
);

/** POST /api/v1/medicaid-eligibility-checks — refresh a patient's state/MCO eligibility as of a date. */
export const RefreshEligibilityBody = Type.Object(
  {
    patientId: uuid(),
    patientPayerId: uuid(),
    asOfServiceDate: isoDate(),
    providerEntityId: Type.Optional(uuid()),
  },
  { additionalProperties: false },
);

/** POST /api/v1/rb-arrangements — the NF Room & Board pass-through contract (§2.4). */
export const CreateRbArrangementBody = Type.Object(
  {
    patientId: uuid(),
    providerEntityId: uuid(),
    nfFacilityMdmId: uuid(),
    effectiveFrom: isoDate(),
    effectiveTo: Type.Optional(isoDate()),
    nfPerDiemRoutineCents: cents(),
    nfPerDiemRespCents: cents(),
    nfPerDiemGipCents: cents(),
    passThroughPct: Type.Number({ minimum: 0, maximum: 100 }),
    retentionPct: Type.Number({ minimum: 0, maximum: 100 }),
    contractDocumentId: Type.Optional(uuid()),
  },
  { additionalProperties: false },
);

/** PATCH /api/v1/rb-arrangements/:id — DRAFT-only edits (rates + end date). */
export const EditRbArrangementBody = Type.Object(
  {
    effectiveTo: Type.Optional(isoDate()),
    nfPerDiemRoutineCents: Type.Optional(cents()),
    nfPerDiemRespCents: Type.Optional(cents()),
    nfPerDiemGipCents: Type.Optional(cents()),
  },
  { additionalProperties: false },
);

/** POST /api/v1/rb-arrangements/:id/terminate — reason ≥40 chars (server CHECK-enforced). */
export const TerminateRbArrangementBody = Type.Object(
  { reason: Type.String({ minLength: 40 }) },
  { additionalProperties: false },
);

/** PATCH /api/v1/rb-days/:id — flip a single day's status; `excluded` requires an exclusion reason. */
export const OverrideRbDayBody = Type.Object(
  {
    status: lit(RB_DAY_OVERRIDE_STATUS),
    exclusionReason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
  },
  { additionalProperties: false },
);

/** POST /api/v1/state-medicaid-trading-partner-credentials — secrets are WRITE-ONLY (never read back). */
export const UpsertCredentialBody = Type.Object(
  {
    providerEntityId: uuid(),
    serviceState: StateCode,
    channel: lit(CHANNEL),
    mcoId: Type.Optional(uuid()),
    tradingPartnerId: Type.String({ minLength: 1, maxLength: 128 }),
    clientId: Type.Optional(Type.String({ maxLength: 256 })),
    clientSecret: Type.Optional(Type.String({ maxLength: 4096 })),
    sftpHost: Type.Optional(Type.String({ maxLength: 256 })),
    sftpUser: Type.Optional(Type.String({ maxLength: 256 })),
    sftpKey: Type.Optional(Type.String({ maxLength: 16384 })),
    portalUrl: Type.Optional(Type.String({ maxLength: 1024 })),
    activeFrom: isoDate(),
    activeTo: Type.Optional(isoDate()),
  },
  { additionalProperties: false },
);

/** POST /api/v1/admin/platform-medicaid-rules — platform-floor rule registration (platform admin only). */
export const RegisterPlatformRuleBody = Type.Object(
  {
    ruleKey: Type.String({ minLength: 3, maxLength: 128 }),
    title: Type.String({ minLength: 1, maxLength: 256 }),
    category: Type.String({ minLength: 1, maxLength: 64 }),
    severity: lit(["error", "warn", "info"] as const),
  },
  { additionalProperties: false },
);

/** POST /api/v1/admin/state-rate-schedule-load — queues a state rate-schedule load (platform admin only). */
export const LoadRateScheduleBody = Type.Object(
  { serviceState: StateCode, effectiveYear: Type.Integer({ minimum: 2000, maximum: 2999 }) },
  { additionalProperties: false },
);

// ── list queries (§4.1) ─────────────────────────────────────────────────────────────────────────────────

/** GET /api/v1/medicaid-claims — cursor-paginated claim workbench filters. */
export const ClaimListQuery = Type.Object(
  {
    state: Type.Optional(lit(CLAIM_STATE)),
    kind: Type.Optional(lit(CLAIM_KIND)),
    mcoId: Type.Optional(uuid()),
    serviceState: Type.Optional(StateCode),
    patientId: Type.Optional(uuid()),
    providerEntityId: Type.Optional(uuid()),
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  },
  { additionalProperties: false },
);

/** GET /api/v1/rb-arrangements. */
export const RbArrangementListQuery = Type.Object(
  {
    patientId: Type.Optional(uuid()),
    nfFacilityMdmId: Type.Optional(uuid()),
    serviceState: Type.Optional(StateCode),
    state: Type.Optional(lit(RB_ARRANGEMENT_STATE)),
  },
  { additionalProperties: false },
);

/** GET /api/v1/rb-days. */
export const RbDayListQuery = Type.Object(
  {
    patientId: Type.Optional(uuid()),
    rbArrangementId: Type.Optional(uuid()),
    status: Type.Optional(lit(RB_DAY_STATUS)),
    from: Type.Optional(isoDate()),
    to: Type.Optional(isoDate()),
  },
  { additionalProperties: false },
);

/** GET /api/v1/medicaid-eligibility-checks. */
export const EligibilityListQuery = Type.Object(
  { patientId: Type.Optional(uuid()) },
  { additionalProperties: false },
);

/** GET /api/v1/medicaid-validation-worklist — caps the failing-result scan (the response says if it hit). */
export const ValidationWorklistQuery = Type.Object(
  { limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) },
  { additionalProperties: false },
);

/** GET /api/v1/state-medicaid-trading-partner-credentials + the AR reads — optional PE narrowing. */
export const ProviderEntityQuery = Type.Object(
  { providerEntityId: Type.Optional(uuid()) },
  { additionalProperties: false },
);

// ── response DTOs (mirror read-service.ts `*View`) ───────────────────────────────────────────────────────

export const ClaimDto = Type.Object({
  id: uuid(),
  providerEntityId: uuid(),
  patientId: uuid(),
  admissionId: uuid(),
  serviceState: StateCode,
  kind: lit(CLAIM_KIND),
  tob: lit(TOB),
  serviceFrom: isoDate(),
  serviceTo: isoDate(),
  mcoId: Type.Union([uuid(), Type.Null()]),
  medicareClaimId: Type.Union([uuid(), Type.Null()]),
  rbArrangementId: Type.Union([uuid(), Type.Null()]),
  medicaidClaimControlNumber: Type.String(),
  state: lit(CLAIM_STATE),
  version: Type.Integer(),
  validationRunIdLatest: Type.Union([uuid(), Type.Null()]),
  eligibilityOutcomeSnapshot: Type.Union([lit(ELIGIBILITY_OUTCOME), Type.Null()]),
  createdAt: isoInstant(),
  updatedAt: isoInstant(),
});

/** The §F09 cursor page envelope every M24 cursor-paginated read returns. */
export const ClaimListResponse = Type.Object({
  items: Type.Array(ClaimDto),
  nextCursor: nullableStr(),
});

export const ClaimLineDto = Type.Object({
  id: uuid(),
  medicaidClaimId: uuid(),
  lineNumber: Type.Integer(),
  serviceDate: isoDate(),
  revenueCode: Type.String(),
  qCode: Type.String(),
  levelOfCare: lit(CLAIM_LINE_LOC),
  units: Type.Integer(),
  rateAtAssemblyCents: cents(),
  chargesCents: cents(),
  cobPaidCents: Type.Union([cents(), Type.Null()]),
  isRb: Type.Boolean(),
  rbDayId: Type.Union([uuid(), Type.Null()]),
});
export const ClaimLineListResponse = Type.Array(ClaimLineDto);

export const SubmissionDto = Type.Object({
  id: uuid(),
  medicaidClaimId: uuid(),
  serviceState: StateCode,
  channel: lit(CHANNEL),
  medicaidClaimControlNumber: Type.String(),
  attemptIndex: Type.Integer(),
  adapterVendor: Type.String(),
  adapterVersion: Type.String(),
  result: lit(SUBMISSION_RESULT),
  errorCode: nullableStr(),
  nextPollAt: Type.Union([isoInstant(), Type.Null()]),
  submittedAt: Type.Union([isoInstant(), Type.Null()]),
  createdAt: isoInstant(),
});
export const SubmissionListResponse = Type.Array(SubmissionDto);

export const AcknowledgmentDto = Type.Object({
  id: uuid(),
  medicaidClaimId: uuid(),
  medicaidSubmissionId: uuid(),
  kind: lit(ACK_KIND),
  outcome: lit(ACK_OUTCOME),
  payerClaimControlNumber: nullableStr(),
  acceptedLineNumbers: Type.Array(Type.Integer()),
  rejectedLineNumbers: Type.Array(Type.Integer()),
  errorCodes: Type.Array(Type.String()),
  receivedAt: isoInstant(),
});
export const AcknowledgmentListResponse = Type.Array(AcknowledgmentDto);

export const ValidationResultDto = Type.Object({
  id: uuid(),
  medicaidValidationRunId: uuid(),
  ruleKey: Type.String(),
  ruleVersion: Type.Integer(),
  outcome: lit(VALIDATION_OUTCOME),
  remediationSummary: nullableStr(),
  remediationFixAction: nullableStr(),
  at: isoInstant(),
});

export const ValidationRunDto = Type.Object({
  id: uuid(),
  medicaidClaimId: uuid(),
  ruleRegistryVersion: Type.String(),
  triggeredBy: Type.String(),
  claimStateAtTrigger: lit(CLAIM_STATE),
  at: isoInstant(),
  completedAt: Type.Union([isoInstant(), Type.Null()]),
  totalResults: Type.Integer(),
  failedResults: Type.Integer(),
  warnedResults: Type.Integer(),
  results: Type.Optional(Type.Array(ValidationResultDto)),
});
export const ValidationRunListResponse = Type.Array(ValidationRunDto);

/** §5.1 #5 — the org-wide worklist: blocked claims grouped by the failing rule that is holding them. */
export const ValidationWorklistDto = Type.Object({
  groups: Type.Array(
    Type.Object({
      ruleKey: Type.String(),
      remediationSummary: nullableStr(),
      remediationFixAction: nullableStr(),
      claims: Type.Array(
        Type.Object({
          claimId: uuid(),
          medicaidClaimControlNumber: Type.String(),
          patientId: uuid(),
          serviceState: StateCode,
          state: lit(CLAIM_STATE),
          updatedAt: isoInstant(),
        }),
      ),
    }),
  ),
  /** Every claim in a blocked state — the honest denominator, including ones under no group. */
  blockedClaimCount: Type.Integer(),
  /** Blocked claims attributable to no rule (no run yet, or every failure already overridden). */
  unattributedClaimCount: Type.Integer(),
  /** True when the scan hit `limit` — the groups are a partial view, and the caller must say so. */
  truncated: Type.Boolean(),
});

export const ValidationOverrideDto = Type.Object({
  id: uuid(),
  medicaidValidationResultId: uuid(),
  medicaidClaimId: uuid(),
  ruleKey: Type.String(),
  overrideRoleApplied: lit(OVERRIDE_ROLE),
  reason: Type.String(),
  actorMembershipId: uuid(),
  at: isoInstant(),
});
export const ValidationOverrideListResponse = Type.Array(ValidationOverrideDto);

export const RuleConfigDto = Type.Object({
  ruleKey: Type.String(),
  enabled: Type.Boolean(),
  isCustom: Type.Boolean(),
  customSeverity: nullableStr(),
  customOverrideRole: nullableStr(),
  regulatoryRequired: Type.Boolean(),
  parametersOverlay: Type.Unknown(),
  version: nullableInt(),
  platformDefault: Type.Optional(
    Type.Object({
      title: Type.String(),
      category: Type.String(),
      severity: Type.String(),
      regulatoryRequired: Type.Boolean(),
      applicableStates: Type.Array(StateCode),
    }),
  ),
});
export const RuleConfigListResponse = Type.Array(RuleConfigDto);

/** Recipient IDs are NEVER returned — only the masked last-4 fact (D12 / §3.6). */
export const EligibilityCheckDto = Type.Object({
  id: uuid(),
  patientId: uuid(),
  patientPayerId: uuid(),
  serviceState: StateCode,
  asOfServiceDate: isoDate(),
  outcome: lit(ELIGIBILITY_OUTCOME),
  mcoId: Type.Union([uuid(), Type.Null()]),
  recipientIdMaskedAtCheck: nullableStr(),
  checkedAt: isoInstant(),
  staleAt: isoInstant(),
  errorMessage: nullableStr(),
});
export const EligibilityCheckListResponse = Type.Array(EligibilityCheckDto);

export const RbDayDto = Type.Object({
  id: uuid(),
  rbArrangementId: uuid(),
  patientId: uuid(),
  serviceDate: isoDate(),
  locOfDay: lit(CLAIM_LINE_LOC),
  perDiemCentsSnapshot: cents(),
  status: lit(RB_DAY_STATUS),
  exclusionReason: nullableStr(),
  medicaidClaimLineId: Type.Union([uuid(), Type.Null()]),
  version: Type.Integer(),
});
export const RbDayListResponse = Type.Array(RbDayDto);

export const RbArrangementDto = Type.Object({
  id: uuid(),
  patientId: uuid(),
  providerEntityId: uuid(),
  nfFacilityMdmId: uuid(),
  nfFacilityNameSnapshot: Type.String(),
  effectiveFrom: isoDate(),
  effectiveTo: Type.Union([isoDate(), Type.Null()]),
  nfPerDiemRoutineCents: cents(),
  nfPerDiemRespCents: cents(),
  nfPerDiemGipCents: cents(),
  passThroughPct: Type.Number(),
  retentionPct: Type.Number(),
  state: lit(RB_ARRANGEMENT_STATE),
  version: Type.Integer(),
  createdAt: isoInstant(),
  days: Type.Optional(Type.Array(RbDayDto)),
});
export const RbArrangementListResponse = Type.Array(RbArrangementDto);

/** Secrets are never read back — only the presence flags (§3.6). */
export const TradingPartnerCredentialDto = Type.Object({
  id: uuid(),
  providerEntityId: uuid(),
  serviceState: StateCode,
  channel: lit(CHANNEL),
  mcoId: Type.Union([uuid(), Type.Null()]),
  tradingPartnerId: Type.String(),
  clientId: nullableStr(),
  sftpHost: nullableStr(),
  portalUrl: nullableStr(),
  activeFrom: isoDate(),
  activeTo: Type.Union([isoDate(), Type.Null()]),
  lastSandboxTestAt: Type.Union([isoInstant(), Type.Null()]),
  lastSandboxTestResult: nullableStr(),
  version: Type.Integer(),
  hasClientSecret: Type.Boolean(),
  hasSftpKey: Type.Boolean(),
});
export const TradingPartnerCredentialListResponse = Type.Array(TradingPartnerCredentialDto);

const ArAgingBucketDto = Type.Object({
  bucket: Type.String(),
  count: Type.Integer(),
  chargesCents: cents(),
});

export const ArDashboardDto = Type.Object({
  totalOpen: Type.Integer(),
  buckets: Type.Array(ArAgingBucketDto),
  byState: Type.Array(
    Type.Object({ state: StateCode, count: Type.Integer(), chargesCents: cents() }),
  ),
});

export const ArMetricsDto = Type.Object({
  denialRate: Type.Number({ description: "0..1 fraction of terminal claims denied" }),
  openCount: Type.Integer(),
  byMco: Type.Array(
    Type.Object({ mcoId: Type.Union([uuid(), Type.Null()]), count: Type.Integer() }),
  ),
  aging: Type.Array(ArAgingBucketDto),
});

// ── small command acknowledgements ──────────────────────────────────────────────────────────────────────

export const ValidateClaimResponse = Type.Object({ validationRunId: uuid() });
export const ApplyOverrideResponse = Type.Object({ overrideId: uuid() });
export const CreateCustomRuleResponse = Type.Object({ ruleKey: Type.String() });
export const RefreshEligibilityResponse = Type.Object({
  checkId: uuid(),
  outcome: lit(ELIGIBILITY_OUTCOME),
});
export const UpsertCredentialResponse = Type.Object({ id: uuid() });
export const TestCredentialResponse = Type.Object({
  ok: Type.Boolean(),
  errorMessage: Type.Optional(Type.String()),
});
export const LoadRateScheduleResponse = Type.Object({ queued: Type.Boolean() });
