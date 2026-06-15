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
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
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
  outcome: Type.Union([
    Type.Literal("success"),
    Type.Literal("failure"),
    Type.Literal("denied"),
  ]),
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
