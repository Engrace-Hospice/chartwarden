// apps/backend/src/modules/38-terminology/routes/terminology-typebox.ts — M38-T06 complete
// TypeBox route schemas for the terminology API surface (M38 spec §4.1–4.2). Named
// `terminology-typebox` (not `*schema*`) so the table-ownership import heuristic never mistakes
// a TypeBox-schema import for a Drizzle one.
//
// Validation runs through TypeBox's `Value` (not the Fastify ajv pipeline) so a bad request
// fails with M1's `VALIDATION_FAILED` envelope — the same house style the M1/M2/M3/M4 routes
// use — and so query-string scalars are coerced (`limit=10` → 10, `billableOnly=true` → true)
// before the shape check. The `:system` param is a closed union of `CODE_SYSTEM_IDS` (the
// value-level mirror of the §4.5 `CodeSystemId` union), so an unknown / not-yet-licensed system
// (e.g. `cpt`, §7.8) is rejected as a malformed request, never routed.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import { CODE_SYSTEM_IDS } from "@wardenx/terminology";

// --- format registration (TypeBox Value does not validate `format` until registered) ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set(
    "date",
    (v) => typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)),
  );
}

// --- shared shapes (§4.2) ---------------------------------------------------------------------

/** The closed `:system` enum — every Phase-1 code system, `cpt` deliberately absent (§7.8). */
export const CodeSystemIdSchema = Type.Union(CODE_SYSTEM_IDS.map((id) => Type.Literal(id)));

/** As-of selector shared by every version-aware read (§2.1); default is "today" in the handler. */
const AsOfQuery = Type.Optional(Type.String({ format: "date" }));

// --- GET /:system/validate (§4.2) -------------------------------------------------------------

export const ValidateParamsSchema = Type.Object({ system: CodeSystemIdSchema });
export const ValidateQuerySchema = Type.Object({
  code: Type.String({ minLength: 1, maxLength: 32 }),
  asOf: AsOfQuery,
});

// --- GET /:system/:code (lookup, §4.2) --------------------------------------------------------

export const LookupParamsSchema = Type.Object({
  system: CodeSystemIdSchema,
  code: Type.String({ minLength: 1, maxLength: 32 }),
});
export const LookupQuerySchema = Type.Object({ asOf: AsOfQuery });

// --- GET /:system/search (§4.2) ---------------------------------------------------------------

export const SearchParamsSchema = Type.Object({ system: CodeSystemIdSchema });
export const SearchQuerySchema = Type.Object({
  q: Type.String({ minLength: 1, maxLength: 200 }),
  mode: Type.Optional(
    Type.Union([Type.Literal("exact"), Type.Literal("fuzzy"), Type.Literal("semantic")]),
  ),
  asOf: AsOfQuery,
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
  billableOnly: Type.Optional(Type.Boolean()),
  inValueSet: Type.Optional(Type.String()),
});

// --- GET /value-sets/:id/expand (§4.2) --------------------------------------------------------

export const ExpandParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
export const ExpandQuerySchema = Type.Object({
  asOf: AsOfQuery,
  system: Type.Optional(CodeSystemIdSchema),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  includeTenantExtensions: Type.Optional(Type.Boolean()),
});

// --- GET /value-sets/:id/is-member (§4.2) -----------------------------------------------------

export const IsMemberParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
export const IsMemberQuerySchema = Type.Object({
  system: CodeSystemIdSchema,
  code: Type.String({ minLength: 1, maxLength: 32 }),
  asOf: AsOfQuery,
});

// --- POST /value-sets/:id/extensions (§4.2) ---------------------------------------------------

export const ExtensionParamsSchema = Type.Object({ id: Type.String({ minLength: 1 }) });
export const ExtensionBodySchema = Type.Object({
  system: CodeSystemIdSchema,
  code: Type.String({ minLength: 1, maxLength: 32 }),
  reason: Type.String({ minLength: 10, maxLength: 500 }),
});

// --- DELETE /value-sets/:id/extensions/:extId (§4.2) ------------------------------------------

export const ExtensionDeleteParamsSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  extId: Type.String({ minLength: 1 }),
});

// --- GET /:system/:code/deprecation (§4.2) ----------------------------------------------------

export const DeprecationParamsSchema = Type.Object({
  system: CodeSystemIdSchema,
  code: Type.String({ minLength: 1, maxLength: 32 }),
});

export type ValidateQuery = Static<typeof ValidateQuerySchema>;
export type SearchQuery = Static<typeof SearchQuerySchema>;
export type ExpandQuery = Static<typeof ExpandQuerySchema>;

/**
 * Validate `raw` against `schema`, coercing query-string scalars first (`limit=10` → 10,
 * `billableOnly=true` → true), and return the typed value. Throws M1's `VALIDATION_FAILED`
 * envelope (flat field list) on a miss, so a malformed request renders the standard 422 envelope
 * rather than a Fastify ajv 400.
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
