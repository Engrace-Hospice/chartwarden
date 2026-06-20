// apps/backend/src/modules/40-mdm/routes/mdm-typebox.ts — M40-T07 TypeBox route schemas for the
// MDM API surface (M40 spec §4.1–4.2). Named `mdm-typebox` (not `*schema*`) so the table-ownership
// import heuristic never mistakes a TypeBox-schema import for a Drizzle one.
//
// Validation runs through TypeBox's `Value` (not the Fastify ajv pipeline) so a bad request fails
// with M1's `VALIDATION_FAILED` envelope and query scalars coerce (`limit=25` → 25) before the
// shape check. The `:kind` param is the closed `MDM_ENTITY_KINDS` union, so an unknown kind is a
// malformed request, never routed.
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { ValidationError } from "@wardenx/types";
import { MDM_ENTITY_KINDS } from "@wardenx/mdm";

// --- format registration (TypeBox Value does not validate `format` until registered) ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
if (!FormatRegistry.Has("date")) {
  FormatRegistry.Set(
    "date",
    (v) => typeof v === "string" && DATE_RE.test(v) && !Number.isNaN(Date.parse(v)),
  );
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}

/** The closed `:kind` enum — every MDM entity kind (§2.3). */
export const KindSchema = Type.Union(MDM_ENTITY_KINDS.map((k) => Type.Literal(k)));

export const KindParamsSchema = Type.Object({ kind: KindSchema });
export const KindIdParamsSchema = Type.Object({
  kind: KindSchema,
  id: Type.String({ format: "uuid" }),
});
export const IdParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });

// --- GET /:kind/search (§4.2) -----------------------------------------------------------------
export const SearchQuerySchema = Type.Object({
  q: Type.Optional(Type.String({ maxLength: 120 })),
  identifier: Type.Optional(Type.String({ maxLength: 64 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 25 })),
});

// --- POST /:kind/get-or-create (§4.2) — Phase-1 minimal identifying shape -----------------------
export const GetOrCreateBodySchema = Type.Object({
  identifierType: Type.Union([
    Type.Literal("npi"),
    Type.Literal("ccn"),
    Type.Literal("x12_payer_id"),
    Type.Literal("ncpdp"),
  ]),
  identifierValue: Type.String({ minLength: 1, maxLength: 64 }),
  displayName: Type.Optional(Type.String({ maxLength: 200 })),
});

// --- PATCH /:kind/:id/overlay (§4.2) — Phase-1 physician overlay fields -------------------------
export const OverlayBodySchema = Type.Object({
  preferredContactPhone: Type.Optional(Type.Union([Type.String({ maxLength: 32 }), Type.Null()])),
  preferredContactEmail: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])),
  relationshipNotes: Type.Optional(Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])),
  doNotRefer: Type.Optional(Type.Boolean()),
  isPreferred: Type.Optional(Type.Boolean()),
  preferredRank: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
});

// --- POST /mdm/baa (§4.2) ----------------------------------------------------------------------
export const BaaBodySchema = Type.Object({
  kind: Type.Union([
    Type.Literal("facility"),
    Type.Literal("payer"),
    Type.Literal("referral_source"),
    Type.Literal("dme_vendor"),
    Type.Literal("funeral_home"),
  ]),
  canonicalId: Type.String({ format: "uuid" }),
  baaStatus: Type.Union([Type.Literal("executed"), Type.Literal("pending"), Type.Literal("n_a")]),
  executedOn: Type.Union([Type.String({ format: "date" }), Type.Null()]),
  expiresOn: Type.Union([Type.String({ format: "date" }), Type.Null()]),
});

// --- POST /mdm/license/manual (§4.2) -----------------------------------------------------------
export const LicenseBodySchema = Type.Object({
  kind: KindSchema,
  canonicalId: Type.String({ format: "uuid" }),
  licenseState: Type.String({ minLength: 2, maxLength: 2 }),
  expiresOn: Type.String({ format: "date" }),
});

// --- POST /admin/mdm/merge-requests/:id/reject (§4.2) ------------------------------------------
export const RejectBodySchema = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 500 }) });

// --- POST /admin/mdm/nppes/lookup (§4.2) -------------------------------------------------------
export const NppesLookupBodySchema = Type.Object({
  npi: Type.String({ pattern: "^[0-9]{10}$" }),
});

export type SearchQuery = Static<typeof SearchQuerySchema>;
export type OverlayBody = Static<typeof OverlayBodySchema>;
export type BaaBody = Static<typeof BaaBodySchema>;

/** Validate `raw` against `schema`, coercing query scalars first; throws M1's VALIDATION_FAILED. */
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
