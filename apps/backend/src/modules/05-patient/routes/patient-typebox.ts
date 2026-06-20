// apps/backend/src/modules/05-patient/routes/patient-typebox.ts — M5-T09 TypeBox route schemas
// (§4.2, §4.4). Named `patient-typebox` (NOT `*schema*`) so the table-ownership import heuristic
// never mistakes a TypeBox import for a Drizzle one. Validation runs through TypeBox `Value` → M1's
// VALIDATION_FAILED envelope.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set("date", (v) => typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)));
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}

const AddressSchema = Type.Object({
  line1: Type.String({ minLength: 1, maxLength: 200 }),
  line2: Type.Optional(Type.String({ maxLength: 200 })),
  city: Type.String({ minLength: 1, maxLength: 120 }),
  state: Type.Optional(Type.String({ minLength: 2, maxLength: 2 })),
  postalCode: Type.String({ minLength: 3, maxLength: 12 }),
});

export const IdParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });
// The slice service uses non-uuid synthetic ids (pat_1); routes accept a loose id param.
export const LooseIdParamsSchema = Type.Object({ id: Type.String({ minLength: 1, maxLength: 64 }) });

// POST /api/v1/patients (§4.2 capture contract)
export const AdmitBodySchema = Type.Object({
  lastName: Type.String({ minLength: 1, maxLength: 120 }),
  firstName: Type.String({ minLength: 1, maxLength: 120 }),
  dob: Type.String({ format: "date" }),
  administrativeSex: Type.String({ minLength: 1, maxLength: 16 }),
  mbi: Type.Optional(Type.Union([Type.String({ maxLength: 16 }), Type.Null()])),
  ssn: Type.Optional(Type.Union([Type.String({ maxLength: 16 }), Type.Null()])),
  primaryAddress: Type.Optional(
    Type.Union([
      Type.Object({
        line1: Type.String(),
        city: Type.String(),
        postalCode: Type.String(),
      }),
      Type.Null(),
    ]),
  ),
  phone: Type.Optional(Type.Union([Type.String({ maxLength: 32 }), Type.Null()])),
  email: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  bypassMatchReview: Type.Optional(Type.Boolean()),
});

// POST /api/v1/patients/:id/addresses (§4.2; §7.4 cascade)
export const AddressBodySchema = AddressSchema;

// POST /api/v1/patients/:id/amendments (§4.2; §7.7)
export const AmendmentBodySchema = Type.Object({
  scope: Type.Union([Type.Literal("demographic"), Type.Literal("clinical"), Type.Literal("narrative")]),
  rationale: Type.String({ minLength: 1, maxLength: 2000 }),
});

// POST /api/v1/amendments/:id/deny
export const DenyBodySchema = Type.Object({ denialReason: Type.String({ minLength: 1, maxLength: 500 }) });

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
