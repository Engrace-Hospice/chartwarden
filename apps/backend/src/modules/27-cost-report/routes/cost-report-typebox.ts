// apps/backend/src/modules/27-cost-report/routes/cost-report-typebox.ts — M27 (§4.2) request schemas.
//
// TypeBox path-param / query / body schemas for the §4.1 cost-report routes (cost reports, worksheets,
// cost-center mappings, imports, bad-debt, statistics, validations, ECR submissions, snapshots, compliance
// window, validation rules) + the `parse(...)` helper. Named `cost-report-typebox` (NOT `*schema*`) so the
// table-ownership import heuristic never mistakes a TypeBox import for a Drizzle one (the M30
// `quality-typebox` / M33 `reporting-typebox` precedent). Validation runs through TypeBox `Value` → M1's
// VALIDATION_FAILED envelope. Org/actor/membership binding is ALWAYS server-side (request.context) — no
// body/query carries an org id or an authoring/approving membership id (the attestation membership ids are
// the only identities a submit body attests to; the route still stamps the acting principal from the actor).
//
// VOCAB NOTE: the string-literal unions mirror the FROZEN `@wardenx/db` pgEnum value lists
// (packages/db/src/schema/cost-report/*) and the @wardenx/cost-report value unions; schema wins on conflict.
// M27 carries NO PHI (D18); every money field is INTEGER CENTS (D8).
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
const isoInstant = () => Type.String({ format: "date-time" });
const isoDate = () => Type.String({ format: "date" });

// ── §3 vocab mirrors (canonical pgEnums live in @wardenx/db / @wardenx/cost-report contracts) ───────────
const COST_REPORT_STATE = [
  "draft",
  "populating",
  "validating",
  "ready_for_review",
  "approved_for_submit",
  "submitted",
  "accepted",
  "rejected",
  "reopened",
  "closed",
] as const;
const WORKSHEET_CODE = [
  "S", "S-1", "S-2", "S-3", "S-4",
  "A", "A-1", "A-6", "A-7", "A-8",
  "B", "B-1", "C", "D", "E-1",
  "F", "G", "G-1", "G-2", "G-3", "H",
] as const;
const WAGE_SOURCE = ["gusto", "manual"] as const;
const BAD_DEBT_KIND = ["deductible", "coinsurance"] as const;
const MAPPING_SOURCE = ["tenant_override", "tenant_extended"] as const;
const RULE_SEVERITY = ["block", "warn", "info"] as const;
const REOPEN_REASON_CATEGORY = [
  "mac_revision_request",
  "internal_audit_finding",
  "cap_recalculation_received",
  "clerical_correction",
  "other_with_explanation",
] as const;

// ── cursor / keyset page query (§4.1.2 — opaque cursor + clamp-to-100 limit) ────────────────────────────
const PageQuery = {
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
};

// ── path params ──────────────────────────────────────────────────────────────────────────────────────
export const CostReportIdParamsSchema = Type.Object({ id: uuid() });
export const WorksheetParamsSchema = Type.Object({ id: uuid(), code: lit(WORKSHEET_CODE) });
export const BadDebtRecordParamsSchema = Type.Object({ id: uuid(), recordId: uuid() });
export const ValidationParamsSchema = Type.Object({ id: uuid(), vid: uuid() });
export const SubmissionParamsSchema = Type.Object({ id: uuid(), sid: uuid() });
export const SnapshotParamsSchema = Type.Object({ id: uuid(), sid: uuid() });
export const RuleIdParamsSchema = Type.Object({ id: uuid() });

// ── list queries ─────────────────────────────────────────────────────────────────────────────────────
export const CostReportListQuerySchema = Type.Object({
  ...PageQuery,
  providerEntityId: Type.Optional(uuid()),
  fiscalYear: Type.Optional(Type.Integer({ minimum: 2000, maximum: 2100 })),
  state: Type.Optional(lit(COST_REPORT_STATE)),
});

// ── cost-report lifecycle bodies ─────────────────────────────────────────────────────────────────────
export const CreateCostReportBodySchema = Type.Object({
  providerEntityId: uuid(),
  fiscalYearStartDate: isoDate(),
  fiscalYearEndDate: isoDate(),
  wageSource: Type.Optional(lit(WAGE_SOURCE)),
});

export const PatchCostReportBodySchema = Type.Object({
  expectedVersion: Type.Integer({ minimum: 1 }),
  badDebtClaimed: Type.Optional(Type.Boolean()),
  wageSource: Type.Optional(lit(WAGE_SOURCE)),
});

export const ApproveForSubmitBodySchema = Type.Object({
  validationId: Type.Optional(uuid()),
});

export const SubmitBodySchema = Type.Object({
  attestedByMembershipId: uuid(),
  attestedAt: isoInstant(),
  approvedByMembershipId: Type.Optional(uuid()),
});

export const SubmitPastDeadlineBodySchema = Type.Object({
  attestedByMembershipId: uuid(),
  attestedAt: isoInstant(),
  approvedByMembershipId: Type.Optional(uuid()),
  reason: Type.String({ minLength: 20, maxLength: 1000 }),
});

export const ReopenBodySchema = Type.Object({
  reason: Type.String({ minLength: 20, maxLength: 1000 }),
  reasonCategory: lit(REOPEN_REASON_CATEGORY),
});

// ── worksheet bodies ─────────────────────────────────────────────────────────────────────────────────
export const PutWorksheetBodySchema = Type.Object({
  expectedVersion: Type.Integer({ minimum: 1 }),
  // The per-worksheet TypeBox schema (WORKSHEET_SCHEMAS/resolveWorksheetSchema) is resolved + checked
  // inside the write service against the `:code`; the route only enforces the envelope. Unknown by design.
  data: Type.Unknown(),
});

// ── cost-center-mapping bodies ───────────────────────────────────────────────────────────────────────
const MappingChangeSchema = Type.Object({
  xeroAccountCode: Type.String({ minLength: 1, maxLength: 50 }),
  xeroAccountName: Type.String({ minLength: 1, maxLength: 200 }),
  cmsCostCenterCode: Type.String({ minLength: 1, maxLength: 50 }),
});
export const PreviewMappingBodySchema = Type.Object({
  changes: Type.Array(MappingChangeSchema, { minItems: 1, maxItems: 500 }),
});
export const ApplyMappingBodySchema = Type.Object({
  changes: Type.Array(MappingChangeSchema, { minItems: 1, maxItems: 500 }),
  mappingSource: Type.Optional(lit(MAPPING_SOURCE)),
});
export const ResetMappingBodySchema = Type.Object({
  keepTenantOverrides: Type.Boolean(),
});

// ── bad-debt bodies ──────────────────────────────────────────────────────────────────────────────────
export const AddBadDebtBodySchema = Type.Object({
  periodLabel: Type.String({ minLength: 1, maxLength: 50 }),
  debtKind: lit(BAD_DEBT_KIND),
  amountCents: Type.Integer({ minimum: 0 }),
  collectionEffortsDocumented: Type.Optional(Type.Boolean()),
  supportingDocumentIds: Type.Optional(Type.Array(uuid(), { maxItems: 100 })),
});
export const UpdateBadDebtBodySchema = Type.Object({
  periodLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
  debtKind: Type.Optional(lit(BAD_DEBT_KIND)),
  amountCents: Type.Optional(Type.Integer({ minimum: 0 })),
  collectionEffortsDocumented: Type.Optional(Type.Boolean()),
  supportingDocumentIds: Type.Optional(Type.Array(uuid(), { maxItems: 100 })),
});

// ── import bodies (manual upload — pre-normalized rows parsed at the edge) ──────────────────────────────
export const ManualTrialBalanceBodySchema = Type.Object({
  normalizedAccounts: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 100000 }),
});
export const ManualWageDataBodySchema = Type.Object({
  normalizedWageRows: Type.Array(Type.Unknown(), { minItems: 1, maxItems: 100000 }),
});

// ── validation bodies ────────────────────────────────────────────────────────────────────────────────
export const OverrideValidationResultBodySchema = Type.Object({
  validationResultId: uuid(),
  reason: Type.String({ minLength: 30, maxLength: 1000 }),
});

// ── acknowledgment body (acceptance number XOR rejection code; the DB CHECK is the source of truth) ─────
export const RecordAcknowledgmentBodySchema = Type.Object({
  mcrefAcknowledgmentNumber: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  mcrefRejectionCode: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  mcrefRejectionDetail: Type.Optional(Type.String({ maxLength: 2000 })),
});

// ── compliance-window body ───────────────────────────────────────────────────────────────────────────
export const DeadlineExtensionBodySchema = Type.Object({
  newEffectiveDeadlineDate: isoDate(),
});

// ── validation-rule library bodies ───────────────────────────────────────────────────────────────────
export const CreateValidationRuleBodySchema = Type.Object({
  ruleCode: Type.String({ minLength: 1, maxLength: 120 }),
  category: Type.String({ minLength: 1, maxLength: 120 }),
  description: Type.String({ minLength: 1, maxLength: 2000 }),
  severity: lit(RULE_SEVERITY),
  macJurisdictionScope: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  predicateSpec: Type.Unknown(),
});
export const UpdateValidationRuleBodySchema = Type.Object({
  description: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  severity: Type.Optional(lit(RULE_SEVERITY)),
  macJurisdictionScope: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  predicateSpec: Type.Optional(Type.Unknown()),
});

/**
 * Validate `raw` against `schema` (Convert-then-Check), throwing M1's VALIDATION_FAILED envelope on the
 * first error (the M30/M33 `parse(...)` precedent). The route handlers call this on params/query/body so a
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
