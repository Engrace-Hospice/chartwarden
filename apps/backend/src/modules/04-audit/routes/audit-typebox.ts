// apps/backend/src/modules/04-audit/routes/audit-typebox.ts — M4-T06 complete TypeBox route
// schemas for the audit query surface (M4 spec §4.3). Named `audit-typebox` (not `*schema*`) so
// the table-ownership import heuristic never mistakes a TypeBox-schema import for a Drizzle one.
//
// The §4.3 schemas are the route contract every audit-query response conforms to and every
// request is validated against. Validation runs through TypeBox's `Value` (not the Fastify ajv
// pipeline) so a bad request fails with M1's `VALIDATION_FAILED` envelope — the same house style
// the M1/M2/M3 routes use — and so query-string scalars are coerced (`limit=50` → 50) before the
// shape check. `uuid` / `date-time` formats are registered so they actually validate.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";

// --- format registration (TypeBox Value does not validate `format` until registered) ----------
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set(
    "date",
    (v) => typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)),
  );
}

// --- shared shapes (§4.3) ---------------------------------------------------------------------

/** One `audit_event` row as the API returns it (§4.3 `AuditEvent`). */
export const AuditEventSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  createdAt: Type.String({ format: "date-time" }),
  organizationId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  actorUserId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  actorKind: Type.String(),
  actorRole: Type.Union([Type.String(), Type.Null()]),
  eventType: Type.String(),
  resourceKind: Type.String(),
  resourceId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  outcome: Type.Union([Type.Literal("success"), Type.Literal("failure"), Type.Literal("denied")]),
  severity: Type.Union([Type.Literal("info"), Type.Literal("warn"), Type.Literal("critical")]),
  before: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  after: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
  context: Type.Record(Type.String(), Type.Unknown()),
  retentionClass: Type.Union([
    Type.Literal("operational"),
    Type.Literal("compliance"),
    Type.Literal("legal_hold"),
    Type.Literal("compliance_42cfr_part2"),
  ]),
});

/** Cursor-paginated envelope `{ items, nextCursor }` over `item` (§4.3 `Cursor`). */
export const Cursor = <T extends TSchema>(item: T) =>
  Type.Object({ items: Type.Array(item), nextCursor: Type.Union([Type.String(), Type.Null()]) });

// --- GET /api/v1/audit/events (§4.3) ----------------------------------------------------------

export const AuditEventsQuerySchema = Type.Object({
  actorUserId: Type.Optional(Type.String({ format: "uuid" })),
  patientId: Type.Optional(Type.String({ format: "uuid" })),
  resourceKind: Type.Optional(Type.String()),
  eventType: Type.Optional(Type.String()),
  outcome: Type.Optional(Type.String()),
  severity: Type.Optional(Type.String()),
  from: Type.Optional(Type.String({ format: "date-time" })),
  to: Type.Optional(Type.String({ format: "date-time" })),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const AuditEventsResponseSchema = Cursor(AuditEventSchema);

// --- GET /api/v1/audit/events/:id (§4.3) ------------------------------------------------------

export const AuditEventParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });

// --- GET /api/v1/audit/patients/:patientId/access (§4.3, §10.2) -------------------------------

export const PatientAccessParamsSchema = Type.Object({
  patientId: Type.String({ format: "uuid" }),
});

export const PatientAccessQuerySchema = Type.Object({
  from: Type.Optional(Type.String({ format: "date-time" })),
  to: Type.Optional(Type.String({ format: "date-time" })),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const PatientAccessEntrySchema = Type.Object({
  eventId: Type.String({ format: "uuid" }),
  at: Type.String({ format: "date-time" }),
  actorUserId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  actorRole: Type.Union([Type.String(), Type.Null()]),
  eventType: Type.String(),
  fields: Type.Array(Type.String()),
  viaBreakGlass: Type.Boolean(),
});

export const PatientAccessResponseSchema = Cursor(PatientAccessEntrySchema);

// --- GET /api/v1/audit/patients/:patientId/accounting (§4.3, §7.1, §164.528 / §2.13) ----------

export const AccountingParamsSchema = Type.Object({
  patientId: Type.String({ format: "uuid" }),
});

/** The accounting scope selector (§7.1) — drives lookback + disclosure set; `all` is gated. */
export const AccountingScopeSchema = Type.Union([
  Type.Literal("hipaa_528"),
  Type.Literal("part_2_13"),
  Type.Literal("all"),
]);

export const AccountingQuerySchema = Type.Object({
  scope: Type.Optional(AccountingScopeSchema),
  from: Type.Optional(Type.String({ format: "date" })),
  to: Type.Optional(Type.String({ format: "date" })),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const DisclosureEntrySchema = Type.Object({
  date: Type.String({ format: "date-time" }),
  recipient: Type.String(),
  purpose: Type.String(),
  description: Type.String(),
  eventId: Type.String({ format: "uuid" }),
  rationale: Type.Optional(Type.String()),
});

export const AccountingResponseSchema = Type.Object({
  patientId: Type.String({ format: "uuid" }),
  period: Type.Object({ from: Type.String(), to: Type.String() }),
  disclosures: Type.Array(DisclosureEntrySchema),
  note: Type.String(),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

export type AuditEventsQuery = Static<typeof AuditEventsQuerySchema>;
export type PatientAccessQuery = Static<typeof PatientAccessQuerySchema>;
export type AccountingQuery = Static<typeof AccountingQuerySchema>;

// --- Legal holds (§4.3, §7) ---------------------------------------------------------------------

export const LegalHoldCriteriaSchema = Type.Object({
  patientIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }))),
  dateRange: Type.Optional(
    Type.Object({
      from: Type.String({ format: "date-time" }),
      to: Type.String({ format: "date-time" }),
    }),
  ),
  resourceKinds: Type.Optional(Type.Array(Type.String())),
});
export type LegalHoldCriteria = Static<typeof LegalHoldCriteriaSchema>;

export const LegalHoldSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  organizationId: Type.String({ format: "uuid" }),
  name: Type.String(),
  criteria: LegalHoldCriteriaSchema,
  status: Type.Union([Type.Literal("active"), Type.Literal("released")]),
  reason: Type.String(),
  appliedBy: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  appliedAt: Type.String({ format: "date-time" }),
  releasedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});

export const LegalHoldListQuerySchema = Type.Object({
  status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("released")])),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const LegalHoldListResponseSchema = Cursor(LegalHoldSchema);

export const CreateLegalHoldBodySchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  criteria: LegalHoldCriteriaSchema,
  reason: Type.String({ minLength: 10 }),
});

export const CreateLegalHoldResponseSchema = Type.Object({
  legalHoldId: Type.String({ format: "uuid" }),
  matchedRecordCount: Type.Integer({ minimum: 0 }),
});

export const LegalHoldIdParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });

export const ReleaseLegalHoldBodySchema = Type.Object({
  reason: Type.String({ minLength: 10 }),
});

export const ReleaseLegalHoldResponseSchema = Type.Object({
  released: Type.Literal(true),
  restoredRecordCount: Type.Integer({ minimum: 0 }),
});

export type CreateLegalHoldBody = Static<typeof CreateLegalHoldBodySchema>;
export type LegalHoldListQuery = Static<typeof LegalHoldListQuerySchema>;

// --- Destruction certificates (§4.3, §6) --------------------------------------------------------

export const DestructionCertificateSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  organizationId: Type.String({ format: "uuid" }),
  dataClass: Type.String(),
  recordCount: Type.Integer(),
  dateRangeStart: Type.String({ format: "date-time" }),
  dateRangeEnd: Type.String({ format: "date-time" }),
  method: Type.String(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("approved"),
    Type.Literal("held"),
    Type.Literal("executed"),
    Type.Literal("partial_refused"),
  ]),
  approvedBy: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  executedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  refusalReason: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
});

export const DestructionCertificateListQuerySchema = Type.Object({
  status: Type.Optional(
    Type.Union([
      Type.Literal("pending"),
      Type.Literal("approved"),
      Type.Literal("held"),
      Type.Literal("executed"),
      Type.Literal("partial_refused"),
    ]),
  ),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

export const DestructionCertificateListResponseSchema = Cursor(DestructionCertificateSchema);

export const DestructionCertificateIdParamsSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
});

// M04-F0X — `reauthToken` is deliberately OMITTED from this body: step-up is a SERVER fact
// (`requireStepUp('destruction.approve')` over M3's `step_up_recent` session predicate), never a
// caller-supplied token — the same audit-C2 judgment call M26 made for `stepUpAssertionId`
// (m26-request-validation.test.ts). Accepting a client-supplied re-auth assertion would let the
// caller assert its own security fact, exactly the defect that precedent exists to avoid.
export const ApproveDestructionCertificateResponseSchema = Type.Object({
  status: Type.Literal("approved"),
});

export const HoldDestructionCertificateBodySchema = Type.Object({
  reason: Type.String({ minLength: 10 }),
});

export const HoldDestructionCertificateResponseSchema = Type.Object({
  status: Type.Literal("held"),
});

export type DestructionCertificateListQuery = Static<typeof DestructionCertificateListQuerySchema>;

// --- Audit exports (§4.3, §4.4, M04-F04 / SEC-052) ----------------------------------------------

export const AuditExportScopeSchema = Type.Object({
  patientIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }))),
  actorIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }))),
  resourceKinds: Type.Optional(Type.Array(Type.String())),
  eventTypes: Type.Optional(Type.Array(Type.String())),
  from: Type.String({ format: "date-time" }),
  to: Type.String({ format: "date-time" }),
});

export const CreateAuditExportBodySchema = Type.Object({
  scope: AuditExportScopeSchema,
  justification: Type.String({ minLength: 10 }),
  format: Type.Union([Type.Literal("csv"), Type.Literal("ndjson"), Type.Literal("pdf")]),
  watermarked: Type.Optional(Type.Boolean()),
});

export const CreateAuditExportResponseSchema = Type.Object({
  exportId: Type.String({ format: "uuid" }),
  status: Type.Literal("pending"),
});

export const AuditExportIdParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });

export const AuditExportResponseSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  status: Type.String(),
  format: Type.Union([Type.Literal("csv"), Type.Literal("ndjson"), Type.Literal("pdf")]),
  recordCount: Type.Union([Type.Integer(), Type.Null()]),
  downloadUrl: Type.Optional(Type.String()),
  expiresAt: Type.String({ format: "date-time" }),
});

export type CreateAuditExportBody = Static<typeof CreateAuditExportBodySchema>;

// --- Integrity report (§4.3, §10.4) --------------------------------------------------------------
//
// `backupSampling` is `Optional` here — a deliberate DEVIATION from the spec's literal (required)
// shape. The `audit.integrity_sample` job (§4.4) that would populate it has no persisted run-history
// table and its worker adapters are unwired (packages/audit/src/jobs — "a tracked follow-up", like
// the rest of M4's async infra); fabricating `{sampled: 0, mismatches: 0}` when the check has never
// actually run would read as "verified clean" rather than "never checked" — the exact kind of false
// compliance signal this module exists to prevent. Omitted (not zeroed) until that job is wired.

export const IntegrityReportResponseSchema = Type.Object({
  appendOnly: Type.Object({
    grantsVerified: Type.Boolean(),
    lastChecked: Type.String({ format: "date-time" }),
  }),
  backupSampling: Type.Optional(
    Type.Object({
      lastRun: Type.String({ format: "date-time" }),
      sampled: Type.Integer(),
      mismatches: Type.Integer(),
    }),
  ),
  sealChain: Type.Optional(
    Type.Object({
      contiguous: Type.Boolean(),
      lastSealedPartition: Type.String(),
      brokenAt: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
  // The sampled hash-chain verification (`audit.integrity_sample`, migration 0510). Present once a run
  // exists. `result` is `skipped` when the org has not enabled `audit_hash_chain_enabled` (never a clean
  // pass); `backupCrossReference` says the pgBackRest comparison is not available in this deployment.
  integritySample: Type.Optional(
    Type.Object({
      lastRun: Type.String({ format: "date-time" }),
      result: Type.Union([
        Type.Literal("match"),
        Type.Literal("mismatch"),
        Type.Literal("skipped"),
        Type.Literal("error"),
      ]),
      sealsTotal: Type.Integer(),
      sealsSampled: Type.Integer(),
      eventsHashed: Type.Integer(),
      mismatches: Type.Integer(),
      backupCrossReference: Type.String(),
    }),
  ),
});

// ── §4.3 RESPONSE DTO pins (M4E enrichment) ────────────────────────────────────────────────────
// The four audit read routes already publish view-shaped response schemas above, but nothing tied
// them to the `@wardenx/audit` `AuditQuery` port they actually return (this module has no local
// `service.ts` — the read views live in the port package). These compile-time `Conforms` aliases
// pin each published schema to the service view it mirrors, so a port field added/renamed breaks
// `bun run build` rather than silently drifting the generated client.
import type {
  AccountingReport as ServiceAccountingReport,
  AuditEventRecord as ServiceAuditEventRecord,
  Page as ServicePage,
  PatientAccessEntry as ServicePatientAccessEntry,
} from "@wardenx/audit";

/** `T` (what the schema publishes) must be assignable to `V` (what the port returns). */
type Conforms<T extends V, V> = T;
type _AuditEvent = Conforms<Static<typeof AuditEventSchema>, ServiceAuditEventRecord>;
type _AuditEventsPage = Conforms<
  Static<typeof AuditEventsResponseSchema>,
  ServicePage<ServiceAuditEventRecord>
>;
type _PatientAccessPage = Conforms<
  Static<typeof PatientAccessResponseSchema>,
  ServicePage<ServicePatientAccessEntry>
>;
type _Accounting = Conforms<Static<typeof AccountingResponseSchema>, ServiceAccountingReport>;

/**
 * Validate `raw` against `schema`, coercing query-string scalars first (`limit=50` → 50), and
 * return the typed value. Throws M1's `VALIDATION_FAILED` envelope (flat field list) on a miss,
 * so a malformed request renders the standard 422 envelope rather than a Fastify ajv 400.
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
