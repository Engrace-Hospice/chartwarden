// apps/backend/src/modules/39-consent/routes/consent-typebox.ts — M39-T07 TypeBox route schemas
// (M39 spec §4.2). Named `consent-typebox` (not `*schema*`) so the table-ownership import heuristic
// never mistakes a TypeBox-schema import for a Drizzle one. Validation runs through TypeBox `Value`
// so a bad request fails with M1's VALIDATION_FAILED envelope and query scalars coerce first.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { CONSENT_TYPE_KEYS } from "@wardenx/consent";
import { ValidationError } from "@wardenx/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}

export const ConsentTypeKeySchema = Type.Union(CONSENT_TYPE_KEYS.map((k) => Type.Literal(k)));

export const PatientIdParamsSchema = Type.Object({ patientId: Type.String({ minLength: 1 }) });
export const ConsentIdParamsSchema = Type.Object({ consentId: Type.String({ minLength: 1 }) });

export const CreateDraftBodySchema = Type.Object({
  typeKey: ConsentTypeKeySchema,
  grantorKind: Type.Union(
    [
      "patient_self",
      "dpoa_healthcare_agent",
      "dpoa_financial_agent",
      "court_guardian",
      "parent_for_minor",
      "healthcare_surrogate",
      "bereaved_person_self",
    ].map((g) => Type.Literal(g)),
  ),
  captureMethod: Type.Union(
    [
      "electronic_portal_signature",
      "typed_signature_in_app",
      "uploaded_signed_pdf",
      "witnessed_verbal_documented",
      "notarized",
    ].map((m) => Type.Literal(m)),
  ),
  scopeDescriptor: Type.Unknown(),
});

export const RevokeBodySchema = Type.Object({
  revokedByKind: Type.Union(
    [
      "patient_self_via_portal",
      "staff",
      "dpoa_agent",
      "court_order",
      "platform_admin_break_glass",
    ].map((k) => Type.Literal(k)),
  ),
  reasonText: Type.String({ default: "" }),
  evidenceDocumentId: Type.Optional(Type.String({ format: "uuid" })),
});

// §4.12 cursor pagination — opaque cursor + bounded page size (never offset).
export const EvalAuditQuerySchema = Type.Object({
  patientId: Type.Optional(Type.String({ minLength: 1 })),
  cursor: Type.Optional(Type.String({ minLength: 1 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
});

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
