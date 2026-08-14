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
import { CODE_SYSTEM_IDS } from "@wardenx/terminology";
import type {
  CodeSystemId,
  DeprecationMappingResponse as ServiceDeprecationMapping,
  ExpansionMember as ServiceExpansionMember,
  MembershipResult as ServiceMembershipResult,
  ResolvedConcept as ServiceResolvedConcept,
  ValidateResult as ServiceValidateResult,
} from "@wardenx/terminology";
import { ValidationError } from "@wardenx/types";
import type {
  TerminologyLoadHistoryEntry as StoreLoadHistoryEntry,
  TenantExtensionGovernanceRow as StoreTenantExtensionGovernanceRow,
  ValueSetCatalogEntry as StoreValueSetCatalogEntry,
} from "../ops-store";

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

// --- §4.2 RESPONSE DTOs (F0 enrichment) -------------------------------------------------------
// The read + extension routes returned typed provider views (`ValidateResult` / `ResolvedConcept` /
// `ExpansionMember` / `MembershipResult` / `DeprecationMappingResponse`) but published NO response
// contract, so the generated client typed every body as `never`. These DTOs mirror the §4.5 seam
// return shapes 1:1 and are pinned to them by the compile-time `Conforms` aliases below, so a seam
// field added or renamed breaks `bun run build` rather than silently drifting from the client.
// (`properties`, a per-system concept union, is published as an open object — the client reads the
// stable base fields; the base is still pinned.)

const ConceptStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("deprecated"),
  Type.Literal("retired"),
]);

const DeprecationMappingKindSchema = Type.Union([
  Type.Literal("equivalent"),
  Type.Literal("broader"),
  Type.Literal("narrower"),
  Type.Literal("none"),
  Type.Literal("see_other"),
]);

/** §4.5 `DeprecationMappingResponse` — a deprecated code's successor mapping. */
export const DeprecationMappingResponseSchema = Type.Object({
  deprecatedCode: Type.String(),
  deprecationEffective: Type.String(),
  successorCodes: Type.Array(Type.String()),
  mappingKind: DeprecationMappingKindSchema,
  guidance: Type.Union([Type.String(), Type.Null()]),
});

/** GET /:system/validate — `ValidateResult` + the echoed `asOf` (null → "today"). */
export const ValidateResponseSchema = Type.Object({
  valid: Type.Boolean(),
  status: Type.Optional(ConceptStatusSchema),
  successor: Type.Optional(DeprecationMappingResponseSchema),
  asOf: Type.Union([Type.String(), Type.Null()]),
});

/** GET /:system/:code/deprecation — the successor mapping, or null when the code is current. */
export const DeprecationLookupResponseSchema = Type.Object({
  mapping: Type.Union([DeprecationMappingResponseSchema, Type.Null()]),
});

/** GET /:system/:code — the union concept (§4.5 `ResolvedConcept`); `properties` is a per-system union. */
export const ConceptResponseSchema = Type.Object({
  systemId: CodeSystemIdSchema,
  code: Type.String(),
  display: Type.String(),
  status: ConceptStatusSchema,
  effectiveDate: Type.String(),
  endDate: Type.Union([Type.String(), Type.Null()]),
  properties: Type.Record(Type.String(), Type.Unknown()),
});

/** A single (system, code) expansion member (§4.5 `ExpansionMember`). */
export const ExpansionMemberResponseSchema = Type.Object({
  systemId: CodeSystemIdSchema,
  code: Type.String(),
  display: Type.String(),
  annotations: Type.Record(Type.String(), Type.Unknown()),
});

/** GET /value-sets/:id/expand — the member page (`nextCursor` is null in the slice). */
export const ExpandResponseSchema = Type.Object({
  items: Type.Array(ExpansionMemberResponseSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

/** GET /value-sets/:id/is-member — membership + provenance (§4.5 `MembershipResult`). */
export const MembershipResponseSchema = Type.Object({
  isMember: Type.Boolean(),
  source: Type.Union([Type.Literal("platform"), Type.Literal("tenant_extension"), Type.Null()]),
});

/** POST /value-sets/:id/extensions — the created tenant-extension echo (201). */
export const ExtensionCreatedResponseSchema = Type.Object({
  extensionId: Type.String(),
  valueSetId: Type.String(),
  system: CodeSystemIdSchema,
  code: Type.String(),
});

// --- GAP-063: the six §4.1 routes that were never built ---------------------------------------
// Six of the fourteen §4.1 rows had no `app.get/post` anywhere: the value-set catalog, the tenant
// remediation report, and the whole `/api/v1/admin/terminology/*` platform-ops surface. Their
// schemas live here beside the eight that shipped.

/** GET /api/v1/terminology/value-sets — the catalog (§4.1). */
export const ValueSetCatalogQuerySchema = Type.Object({
  scope: Type.Optional(
    Type.Union([Type.Literal("platform"), Type.Literal("hospice"), Type.Literal("hqrp")]),
  ),
});
export const ValueSetCatalogEntrySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.Union([Type.String(), Type.Null()]),
  scope: Type.Union([Type.Literal("platform"), Type.Literal("hospice"), Type.Literal("hqrp")]),
  updatedAt: Type.String(),
});
export const ValueSetCatalogResponseSchema = Type.Object({
  items: Type.Array(ValueSetCatalogEntrySchema),
});

/** GET /api/v1/terminology/remediation — the per-tenant §7.3 rollup. */
export const RemediationQuerySchema = Type.Object({
  since: Type.Optional(Type.String({ format: "date" })),
  system: Type.Optional(CodeSystemIdSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
export const RemediationLineSchema = Type.Object({
  systemId: CodeSystemIdSchema,
  deprecatedCode: Type.String(),
  deprecationEffective: Type.String(),
  successorCodes: Type.Array(Type.String()),
  mappingKind: DeprecationMappingKindSchema,
  guidance: Type.Union([Type.String(), Type.Null()]),
  affectedRecordCount: Type.Integer(),
  sampleRecordIds: Type.Array(Type.String()),
  affectedByType: Type.Record(Type.String(), Type.Integer()),
  /** §7.3: an `equivalent` mapping to exactly one successor is mechanical; everything else is judgement. */
  recommendedAction: Type.Union([
    Type.Literal("update_to_successor"),
    Type.Literal("manual_review"),
  ]),
});
export const RemediationResponseSchema = Type.Object({
  since: Type.String(),
  /** Distinct (record, deprecated code) usages — a row on two deprecated codes is two remediations. */
  totalAffected: Type.Integer(),
  affectedCodeCount: Type.Integer(),
  /** Record classes actually consulted — see the route's honesty note on unbuilt producers. */
  coveredRecordTypes: Type.Array(Type.String()),
  items: Type.Array(RemediationLineSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

/** GET /api/v1/admin/terminology/versions — platform load history. */
export const AdminVersionsQuerySchema = Type.Object({
  system: Type.Optional(CodeSystemIdSchema),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});
export const AdminVersionEntrySchema = Type.Object({
  logId: Type.String(),
  systemId: CodeSystemIdSchema,
  versionId: Type.Union([Type.String(), Type.Null()]),
  version: Type.Union([Type.String(), Type.Null()]),
  versionStatus: Type.Union([Type.String(), Type.Null()]),
  action: Type.String(),
  conceptCount: Type.Integer(),
  newCodes: Type.Integer(),
  retiredCodes: Type.Integer(),
  affectedValueSets: Type.Integer(),
  summary: Type.Record(Type.String(), Type.Unknown()),
  at: Type.String(),
});
export const AdminVersionsResponseSchema = Type.Object({
  items: Type.Array(AdminVersionEntrySchema),
});

/** POST /api/v1/admin/terminology/:system/load — register a source version (step-up). */
export const AdminSystemParamsSchema = Type.Object({ system: CodeSystemIdSchema });
export const AdminLoadBodySchema = Type.Object({
  version: Type.String({ minLength: 1, maxLength: 64 }),
  sourceFileRef: Type.String({ minLength: 1, maxLength: 512 }),
  /**
   * REQUIRED, unlike the §4.2 body sketch. `code_system_version.checksum` is NOT NULL and exists so a
   * re-load can be proven byte-identical; defaulting it would write a lie into the provenance column.
   */
  checksum: Type.String({ minLength: 8, maxLength: 128 }),
  releasedOn: Type.Optional(Type.String({ format: "date" })),
  effectiveFrom: Type.Optional(Type.String({ format: "date" })),
});
export const AdminLoadResponseSchema = Type.Object({
  versionId: Type.String(),
  status: Type.String(),
  /** False when this (system, version) was already registered — the caller's request changed nothing. */
  created: Type.Boolean(),
  /** What actually happened, so "registered" is never mistaken for "ingested". */
  ingestion: Type.Literal("pending_loader_worker"),
});

/** POST /api/v1/admin/terminology/:system/refresh-embeddings. */
export const AdminRefreshEmbeddingsResponseSchema = Type.Object({
  versionId: Type.String(),
  status: Type.Literal("embedding"),
  recompute: Type.Literal("pending_embeddings_worker"),
});

/** GET /api/v1/admin/terminology/value-set-extensions — cross-tenant governance view. */
export const AdminExtensionsQuerySchema = Type.Object({
  valueSetId: Type.Optional(Type.String({ minLength: 1 })),
  organizationId: Type.Optional(Type.String({ minLength: 1 })),
  includeRemoved: Type.Optional(Type.Boolean()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  cursor: Type.Optional(Type.String()),
});
export const AdminExtensionEntrySchema = Type.Object({
  extensionId: Type.String(),
  valueSetId: Type.String(),
  organizationId: Type.String(),
  systemId: CodeSystemIdSchema,
  code: Type.String(),
  reason: Type.String(),
  addedBy: Type.Union([Type.String(), Type.Null()]),
  removedAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
export const AdminExtensionsResponseSchema = Type.Object({
  items: Type.Array(AdminExtensionEntrySchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the seam returns).
type Conforms<T extends V, V> = T;
type _Validate = Conforms<
  Static<typeof ValidateResponseSchema>,
  ServiceValidateResult & { readonly asOf: string | null }
>;
type _Deprecation = Conforms<
  Static<typeof DeprecationLookupResponseSchema>,
  { readonly mapping: ServiceDeprecationMapping | null }
>;
// `properties` is a per-system union (published open); the stable base fields are pinned.
type _Concept = Conforms<
  Omit<Static<typeof ConceptResponseSchema>, "properties">,
  Omit<ServiceResolvedConcept<CodeSystemId>, "properties">
>;
type _Expand = Conforms<
  Static<typeof ExpandResponseSchema>,
  { readonly items: readonly ServiceExpansionMember[]; readonly nextCursor: string | null }
>;
type _Membership = Conforms<Static<typeof MembershipResponseSchema>, ServiceMembershipResult>;
type _ExtCreated = Conforms<
  Static<typeof ExtensionCreatedResponseSchema>,
  {
    readonly extensionId: string;
    readonly valueSetId: string;
    readonly system: CodeSystemId;
    readonly code: string;
  }
>;
// GAP-063 — the same pin for the six new routes' DTOs: the published contract must stay assignable to
// what `TerminologyOpsStore` returns, so a store field renamed breaks the build rather than the client.
type _ValueSetCatalog = Conforms<
  Static<typeof ValueSetCatalogEntrySchema>,
  StoreValueSetCatalogEntry
>;
type _AdminVersion = Conforms<Static<typeof AdminVersionEntrySchema>, StoreLoadHistoryEntry>;
type _AdminExtension = Conforms<
  Static<typeof AdminExtensionEntrySchema>,
  StoreTenantExtensionGovernanceRow
>;

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
