import { MDM_ENTITY_KINDS } from "@chartwarden/mdm";
import type {
  BaaRegisterEntry as ServiceBaaRegisterEntry,
  MdmEntityKind as ServiceMdmEntityKind,
  MdmResolved as ServiceMdmResolved,
  MergeRequestRow as ServiceMergeRequestRow,
  NppesSyncRun as ServiceNppesSyncRun,
} from "@chartwarden/mdm";
import { ValidationError } from "@chartwarden/types";
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
export const RejectBodySchema = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 500 }),
});

// --- POST /admin/mdm/nppes/lookup (§4.2) -------------------------------------------------------
export const NppesLookupBodySchema = Type.Object({
  npi: Type.String({ pattern: "^[0-9]{10}$" }),
});

export type SearchQuery = Static<typeof SearchQuerySchema>;
export type OverlayBody = Static<typeof OverlayBodySchema>;
export type BaaBody = Static<typeof BaaBodySchema>;

// --- §4.2 RESPONSE DTOs (F0 enrichment) --------------------------------------------------------
// The MDM read/write routes returned typed view shapes (`MdmResolved` / `BaaRegisterEntry` /
// `MergeRequestRow` / `NppesSyncRun` and small write acks) but published NO response contract, so
// the generated client typed every body as `never`. These DTOs mirror the seam/service views and
// are pinned to them by the compile-time `Conforms` aliases below, so a view field added or renamed
// breaks `bun run build` rather than silently drifting from the client. `MdmResolved`'s `canonical`
// is a per-kind rich generic; the DTO publishes the shared `CanonicalBaseFields` denominator (a
// valid member of the canonical union) so the pin holds across every kind.
const CanonicalIdentifierSchema = Type.Union([
  Type.Literal("npi"),
  Type.Literal("ccn"),
  Type.Literal("x12_payer_id"),
  Type.Literal("ncpdp"),
]);

const CanonicalBaseFieldsSchema = Type.Object({
  id: Type.String(),
  identifierType: CanonicalIdentifierSchema,
  identifierValue: Type.Union([Type.String(), Type.Null()]),
  displayName: Type.String(),
});

const OverlayPhysicianFieldsSchema = Type.Object({
  preferredContactPhone: Type.Union([Type.String(), Type.Null()]),
  preferredContactEmail: Type.Union([Type.String(), Type.Null()]),
  relationshipNotes: Type.Union([Type.String(), Type.Null()]),
  doNotRefer: Type.Boolean(),
  isPreferred: Type.Boolean(),
  preferredRank: Type.Union([Type.Integer(), Type.Null()]),
});

/** The resolved entity (§4.5): survivor id, optional redirect breadcrumb, canonical base payload,
 *  this-tenant overlay (physician-only, else `null`), and the post-redirect status. */
export const MdmResolvedResponseSchema = Type.Object({
  id: Type.String(),
  resolvedFrom: Type.Optional(Type.String()),
  canonical: CanonicalBaseFieldsSchema,
  overlay: Type.Union([OverlayPhysicianFieldsSchema, Type.Null()]),
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("deactivated"),
    Type.Literal("provisional"),
  ]),
});

/** GET /:kind/search — `{ results }`. */
export const MdmSearchResponseSchema = Type.Object({
  results: Type.Array(MdmResolvedResponseSchema),
});

/** POST /:kind/get-or-create — the §7.1 match / provisional / fuzzy union. */
export const MdmGetOrCreateResponseSchema = Type.Union([
  Type.Object({ kind: Type.Literal("matched_canonical"), entity: MdmResolvedResponseSchema }),
  Type.Object({ kind: Type.Literal("created_provisional"), provisionalId: Type.String() }),
  Type.Object({
    kind: Type.Literal("fuzzy_candidates"),
    candidates: Type.Array(MdmResolvedResponseSchema),
    provisionalId: Type.String(),
  }),
]);

/** PATCH /:kind/:id/overlay — the write ack. */
export const MdmOverlayAppliedResponseSchema = Type.Object({ applied: Type.Boolean() });

/** GET /:kind/:id/relationships — canonical parent + children (no overlay join). */
export const MdmRelationshipsResponseSchema = Type.Object({
  parent: Type.Union([MdmResolvedResponseSchema, Type.Null()]),
  children: Type.Array(MdmResolvedResponseSchema),
});

/** A BAA register entry (§4.1 GET /mdm/baa) — the per-tenant view of `mdm_baa_record`. */
export const BaaRegisterEntryResponseSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union([
    Type.Literal("facility"),
    Type.Literal("payer"),
    Type.Literal("referral_source"),
    Type.Literal("dme_vendor"),
    Type.Literal("funeral_home"),
  ]),
  canonicalId: Type.String(),
  baaStatus: Type.Union([Type.Literal("executed"), Type.Literal("pending"), Type.Literal("n_a")]),
  executedOn: Type.Union([Type.String(), Type.Null()]),
  expiresOn: Type.Union([Type.String(), Type.Null()]),
});
export const MdmBaaListResponseSchema = Type.Object({
  entries: Type.Array(BaaRegisterEntryResponseSchema),
});

/** POST /mdm/baa — the created register id. */
export const MdmBaaCreatedResponseSchema = Type.Object({ id: Type.String() });

/** POST /mdm/license/manual — the manual-entry ack. */
export const MdmLicenseRecordedResponseSchema = Type.Object({ recorded: Type.Literal(true) });

/** A merge-request row (§2.4.2) — the platform-ops surface. */
export const MergeRequestRowResponseSchema = Type.Object({
  id: Type.String(),
  kind: KindSchema,
  canonicalId: Type.String(),
  duplicateId: Type.String(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("approved"),
    Type.Literal("rejected"),
    Type.Literal("executed"),
  ]),
  evidence: Type.Record(Type.String(), Type.Unknown()),
});
export const MdmMergeRequestsResponseSchema = Type.Object({
  mergeRequests: Type.Array(MergeRequestRowResponseSchema),
});

/** POST …/merge-requests/:id/approve — the §7.6 flip result. */
export const MdmMergeApprovedResponseSchema = Type.Object({
  duplicateId: Type.String(),
  canonicalId: Type.String(),
});

/** POST …/provisional/:id/promote — the promoted canonical id. */
export const MdmProvisionalPromotedResponseSchema = Type.Object({ canonicalId: Type.String() });

/** POST …/nppes/lookup — the single-NPI sync outcome. */
export const MdmNppesLookupResponseSchema = Type.Object({
  matched: Type.Boolean(),
  canonicalId: Type.Union([Type.String(), Type.Null()]),
});

/** An NPPES sync-log row (§4.1 GET …/nppes/sync-log). */
export const NppesSyncRunResponseSchema = Type.Object({
  id: Type.String(),
  mode: Type.Union([
    Type.Literal("nightly_delta"),
    Type.Literal("weekly_full"),
    Type.Literal("on_demand"),
  ]),
  outcome: Type.Union([Type.Literal("success"), Type.Literal("partial"), Type.Literal("failure")]),
});
export const MdmNppesSyncLogResponseSchema = Type.Object({
  runs: Type.Array(NppesSyncRunResponseSchema),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the seam/service returns).
type Conforms<T extends V, V> = T;
type _MdmResolved = Conforms<
  Static<typeof MdmResolvedResponseSchema>,
  ServiceMdmResolved<ServiceMdmEntityKind>
>;
type _BaaEntry = Conforms<Static<typeof BaaRegisterEntryResponseSchema>, ServiceBaaRegisterEntry>;
type _MergeRow = Conforms<Static<typeof MergeRequestRowResponseSchema>, ServiceMergeRequestRow>;
type _NppesRun = Conforms<Static<typeof NppesSyncRunResponseSchema>, ServiceNppesSyncRun>;

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
