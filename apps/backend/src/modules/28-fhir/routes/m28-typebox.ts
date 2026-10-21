// apps/backend/src/modules/28-fhir/routes/m28-typebox.ts — M28-T08 (§4.1 / §4.2) request schemas.
//
// TypeBox request bodies, path params and list queries for the §4.1 FHIR-gateway routes. Named
// `m28-typebox` (NOT `*schema*`) so the table-ownership import heuristic never mistakes a TypeBox import
// for a Drizzle one (the M21-T01 gotcha).
//
// THE STRING-LITERAL UNIONS MIRROR the frozen `@chartwarden/types` unions (`packages/types/src/fhir.ts`,
// M28-T01), which mirror the `@chartwarden/db` pgEnums and the §3 CHECK vocabularies. The DB wins on conflict.
//
// FOUR THINGS NOTHING HERE ACCEPTS: (1) no organization id and no acting membership — both are server-side
// (./actor.ts); (2) no client SECRET on the wire — a rotated credential's plaintext is minted server-side
// and returned once; (3) no `status` a caller may set directly — every status change walks the §2.2 FSM
// through a named transition route; (4) no signed cursor key — R39 rotates it server-side.
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  FHIR_BULK_EXPORT_STATUSES,
  FHIR_CLIENT_STATUSES,
  FHIR_CLIENT_TIERS,
  FHIR_CLIENT_TYPES,
  FHIR_INBOUND_OWNER_MODULES,
  FHIR_INBOUND_STATUSES,
  ValidationError,
} from "@chartwarden/types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
if (!FormatRegistry.Has("uri")) {
  FormatRegistry.Set("uri", (v) => typeof v === "string" && v.length > 0);
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

/** Validate a request BODY at the route boundary (no `Value.Convert` — a JSON body carries real types). */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, raw ?? {});
}

/** Validate a request QUERY, converting declared scalars first (`?limit=25` arrives as "25"). */
export function parseQuery<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, Value.Convert(schema, raw ?? {}));
}

const Uuid = Type.String({ format: "uuid" });
const InstantOpt = Type.Optional(Type.String({ format: "date-time" }));
const Lit = <T extends string>(members: readonly T[]) =>
  Type.Union(members.map((m) => Type.Literal(m)));

// ── vocabulary mirrors (`@chartwarden/types` is the source of truth) ──────────────────────────────────────

export const FhirClientTypeSchema = Lit(FHIR_CLIENT_TYPES);
export const FhirClientTierSchema = Lit(FHIR_CLIENT_TIERS);
export const FhirClientStatusSchema = Lit(FHIR_CLIENT_STATUSES);
export const FhirInboundOwnerModuleSchema = Lit(FHIR_INBOUND_OWNER_MODULES);
export const FhirInboundStatusSchema = Lit(FHIR_INBOUND_STATUSES);
export const FhirBulkExportStatusSchema = Lit(FHIR_BULK_EXPORT_STATUSES);

// ── path params ─────────────────────────────────────────────────────────────────────────────────────

export const ClientIdParams = Type.Object({ id: Uuid });
export const ClientSessionParams = Type.Object({ id: Uuid, jti: Uuid });
export const JobIdParams = Type.Object({ id: Uuid });
export const ProposalIdParams = Type.Object({ id: Uuid });
export const PollJobParams = Type.Object({ jobId: Uuid });
export const ResourceReadParams = Type.Object({
  resourceType: Type.String({ minLength: 1, maxLength: 60 }),
  id: Type.String({ minLength: 1, maxLength: 200 }),
});
export const ResourceTypeParams = Type.Object({
  resourceType: Type.String({ minLength: 1, maxLength: 60 }),
});
export const PatientEverythingParams = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 200 }),
});
export const CodeSystemParams = Type.Object({
  system: Type.String({ minLength: 1, maxLength: 200 }),
});
export const ValueSetParams = Type.Object({ vs: Type.String({ minLength: 1, maxLength: 200 }) });
export const GroupExportParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 200 }) });
export const Phase2ResourceParams = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 200 }),
});

// ── §4.2 admin bodies — client registry (R24-R30) ────────────────────────────────────────────────────

export const CreateClientBody = Type.Object({
  name: Type.String({ minLength: 3, maxLength: 200 }),
  type: FhirClientTypeSchema,
  jwksUri: Type.Optional(Type.String({ format: "uri", pattern: "^https://" })),
  allowedScopes: Type.Array(Type.String({ pattern: "^system/[A-Z][A-Za-z]+\\.(read|write)$" }), {
    minItems: 1,
    maxItems: 50,
  }),
  tier: FhirClientTierSchema,
  /** Tighten-only: the service refuses a value that LOOSENS the platform floor for the tier. */
  rateLimitRpsOverride: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  ipAllowlist: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 64 }))),
  baaContractReference: Type.String({ minLength: 1, maxLength: 100 }),
});

export const ApproveClientBody = Type.Object({
  rationale: Type.String({ minLength: 20, maxLength: 1000 }),
});

export const RevokeClientBody = Type.Object({
  rationale: Type.String({ minLength: 40, maxLength: 1000 }),
});

export const SuspendClientBody = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});

// ── admin bodies — bulk export (R32) ─────────────────────────────────────────────────────────────────

export const InitiateBulkExportBody = Type.Object({
  clientId: Uuid,
  requestKind: Lit(["system", "group", "patient"] as const),
  groupId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  patientIds: Type.Optional(Type.Array(Uuid, { maxItems: 5000 })),
  resourceTypes: Type.Array(Type.String({ minLength: 1, maxLength: 60 }), {
    minItems: 1,
    maxItems: 50,
  }),
  since: InstantOpt,
});

// ── admin bodies — inbound proposal review (R35-R36) ────────────────────────────────────────────────

export const AcceptProposalBody = Type.Object({
  /** The native aggregate the owner module created/updated on acceptance (§2.2 `accepted_aggregate_id`). */
  acceptedAggregateId: Uuid,
  rationale: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
});

export const RejectProposalBody = Type.Object({
  /** ≥40 chars (§2.3 survey-defense detail). */
  rationale: Type.String({ minLength: 40, maxLength: 1000 }),
});

// ── admin bodies — tenant config (R38) ───────────────────────────────────────────────────────────────

export const PutConfigBody = Type.Object({
  tenantFhirHost: Type.String({ minLength: 1, maxLength: 300 }),
  identifierUriBase: Type.String({ minLength: 1, maxLength: 300 }),
  inboundReviewSlaHours: Type.Optional(Type.Integer({ minimum: 1, maximum: 720 })),
  exportDedupWindowMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440 })),
});

// ── admin list queries ───────────────────────────────────────────────────────────────────────────────

export const ClientListQuery = Type.Object({
  status: Type.Optional(FhirClientStatusSchema),
});

export const BulkExportListQuery = Type.Object({
  status: Type.Optional(FhirBulkExportStatusSchema),
  clientId: Type.Optional(Uuid),
});

export const InboundListQuery = Type.Object({
  ownerModule: Type.Optional(FhirInboundOwnerModuleSchema),
  status: Type.Optional(FhirInboundStatusSchema),
});

// ── FHIR-spec bodies + queries (R3, R5, R7, R13, R16) ────────────────────────────────────────────────

/**
 * R3 — the token endpoint (`application/x-www-form-urlencoded`). §D2 defines TWO auth paths, and this
 * shape now admits both: the SMART Backend Services asymmetric flow (`client_assertion_type` +
 * `client_assertion`) and the api-key flow (`client_id` + `client_secret`) for trusted infrastructure
 * integrations that cannot run an asymmetric signer.
 *
 * Everything but `grant_type` and `scope` is OPTIONAL here on purpose: which fields are required depends
 * on WHICH path the request is taking, and a schema that demanded the SMART fields — as this one did —
 * answered a well-formed api-key request with a 400 body-validation error naming a field that flow does
 * not have. The handler picks the path first, then enforces that path's requirements, so the error a
 * partner gets names the credential they actually presented.
 */
export const TokenFormBody = Type.Object({
  grant_type: Type.Literal("client_credentials"),
  scope: Type.String({ minLength: 1, maxLength: 2000 }),
  /** Present on both paths; SMART allows it to be omitted, in which case the assertion's `iss` names it. */
  client_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  client_assertion_type: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  client_assertion: Type.Optional(Type.String({ minLength: 1, maxLength: 8192 })),
  client_secret: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
});

/**
 * R5 — type-level search parameters. `patient` scopes every clinical search (W-FHIR-14: an unscoped
 * org-wide FHIR search is a bulk export wearing a search's clothes, and R7/R9 is the audited surface for
 * that); `_id` and `identifier` are the two Patient searches, since a partner that holds an MRN must be
 * able to resolve it to a `Patient/{id}` before it can scope anything else.
 */
export const ResourceSearchQuery = Type.Object({
  patient: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  _id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  identifier: Type.Optional(Type.String({ minLength: 1, maxLength: 400 })),
  _count: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  _since: InstantOpt,
});

/** R7 — system-level `$export` (query-parameter encoding; the FHIR-spec `Parameters` body is also legal). */
export const ExportQuery = Type.Object({
  _outputFormat: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  _type: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  _since: InstantOpt,
});

/** R13 — `CodeSystem/$validate-code` operation input (FHIR-spec `Parameters`). */
export const ValidateCodeBody = Type.Object({
  resourceType: Type.Literal("Parameters"),
  parameter: Type.Array(
    Type.Object({
      name: Type.String({ minLength: 1, maxLength: 60 }),
      valueString: Type.Optional(Type.String({ maxLength: 2000 })),
      valueUri: Type.Optional(Type.String({ maxLength: 2000 })),
      valueCode: Type.Optional(Type.String({ maxLength: 200 })),
    }),
    { maxItems: 20 },
  ),
});

/** R16 — inbound staging: an opaque raw FHIR resource (validated structurally at the boundary). */
export const InboundResourceBody = Type.Object(
  {
    resourceType: Type.String({ minLength: 1, maxLength: 60 }),
    id: Type.Optional(Type.String({ maxLength: 200 })),
  },
  { additionalProperties: true },
);

export type CreateClientInput = Static<typeof CreateClientBody>;
export type ApproveClientInput = Static<typeof ApproveClientBody>;
export type RevokeClientInput = Static<typeof RevokeClientBody>;
export type SuspendClientInput = Static<typeof SuspendClientBody>;
export type InitiateBulkExportInput = Static<typeof InitiateBulkExportBody>;
export type AcceptProposalInput = Static<typeof AcceptProposalBody>;
export type RejectProposalInput = Static<typeof RejectProposalBody>;
export type PutConfigInput = Static<typeof PutConfigBody>;
export type TokenFormInput = Static<typeof TokenFormBody>;
export type InboundResourceInput = Static<typeof InboundResourceBody>;
