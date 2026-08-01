// apps/backend/src/modules/03-authorization/routes/authz-typebox.ts — M3 (§4.3–4.4) request schemas.
//
// TypeBox path-param + request-body schemas for the §4.1 authorization routes (the role catalog +
// assignment surface, the §7.4 break-glass console, the §7.5 auditor-engagement console). Every M3
// write is validated against these AT THE ROUTE BOUNDARY before it reaches a store — the M24
// `m24-typebox` / M30 `quality-typebox` precedent. Named `authz-typebox` (NOT `*schema*`) so the
// table-ownership import heuristic never mistakes a TypeBox import for a Drizzle one.
//
// The shapes MIRROR the ports in `../authz-ports.ts` and the FROZEN `@wardenx/db` pgEnum value lists
// (packages/db/src/enums.ts — `role_category`, `scope_level`, `engagement_type`); the schema wins on
// conflict. Two column facts drive the strictness here, because M3 previously took these as bare
// strings and only found out at the INSERT:
//   • `role.category` / `role.scope_level` / `auditor_engagement.engagement_type` are pgEnums — an
//     off-vocabulary string is a 500 at the store, not a 422 at the client, unless it is refused here.
//   • `membership_role.membership_id`, `membership_role.expires_at` and
//     `break_glass_event.target_patient_id` are uuid / timestamptz columns reached WITHOUT a prior
//     existence lookup — a malformed value goes straight to Postgres.
//
// Org/actor binding stays server-side (`request.context`) — no body carries an organization id or an
// acting user id (§3.2). Path params that address a ROLE stay permissive strings: a role id is a
// platform-template reference as often as a uuid (`tmpl_administrator` in the slice store), and the
// route's own `deps.roles.get()` → 404 is the real guard. Every other id param is uuid-shaped.
import { FormatRegistry, type Static, type TSchema, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { PermissionMirrorRow } from "@wardenx/auth";
import { ValidationError } from "@wardenx/types";
import type {
  BreakGlassStatus,
  BreakGlassView,
  EngagementStatus,
  EngagementSummary,
  EngagementView,
  MembershipRoleView,
  RoleView,
} from "../authz-ports";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) {
  FormatRegistry.Set("uuid", (v) => typeof v === "string" && UUID_RE.test(v));
}
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => typeof v === "string" && !Number.isNaN(Date.parse(v)));
}
// Deliberately permissive (a local-part @ a dotted domain) — M3 only needs enough shape to refuse
// junk before M2 mints an auditor magic-link to it; deliverability is the mail transport's verdict.
if (!FormatRegistry.Has("email")) {
  FormatRegistry.Set(
    "email",
    (v) => typeof v === "string" && /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(v),
  );
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

/**
 * Validate a request BODY or PATH PARAMS against its §4.2 schema at the route boundary. A failure
 * raises M1's VALIDATION_FAILED envelope (422) naming the offending field path, so a malformed
 * request is refused BEFORE it reaches a store rather than surfacing as a downstream type error or
 * a Postgres enum/uuid cast failure.
 *
 * Deliberately does NOT run `Value.Convert` (the M24 `m24-typebox` reasoning): a JSON body already
 * carries real types, and coercing it would silently repair genuinely wrong input — `enabled: "no"`
 * would land as a boolean rather than being rejected. Path params arrive as strings and every param
 * schema below is string-typed, so they need no conversion either. M3 has no query strings; if one
 * is ever added it needs a `parseQuery` with `Value.Convert`, not this helper.
 */
export function parse<T extends TSchema>(schema: T, raw: unknown): Static<T> {
  return check(schema, raw ?? {});
}

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));
const uuid = () => Type.String({ format: "uuid" });
const isoInstant = () => Type.String({ format: "date-time" });
/** A non-empty opaque id (role ids may be a `tmpl_*` template reference, not a uuid). */
const opaqueId = () => Type.String({ minLength: 1, maxLength: 128 });

// ── §3.3 vocab mirrors (canonical pgEnums live in packages/db/src/enums.ts) ─────────────────────
const ROLE_CATEGORY = [
  "clinical_staff",
  "clinical_leadership",
  "operations",
  "admin_executive",
  "billing_finance",
  "compliance_quality",
  "volunteer",
  "patient_family",
  "external_auditor",
  "external_collaborator",
  "platform_staff",
  "temporary_special",
] as const;

const SCOPE_LEVEL = ["organization", "provider_entity", "location", "patient"] as const;

const ENGAGEMENT_TYPE = [
  "cms_survey",
  "state_survey",
  "tpe_probe",
  "upic_investigation",
  "cost_report_field_audit",
  "financial_audit",
  "accreditation",
  "other",
] as const;

/**
 * A permission key as the §6 catalog writes them — 2–4 dot-separated lowercase segments
 * (`patient.read`, `hope.sfv.read`). Every one of the contributed keys matches. This is a SHAPE gate
 * only; membership in the catalog is settled by the anti-escalation check, which cannot be passed
 * with a key that does not exist (an actor holds no such key, so it cannot be granted).
 */
const PERMISSION_KEY_RE = "^[a-z0-9_]+(\\.[a-z0-9_]+){1,3}$";
const permissionKey = () => Type.String({ pattern: PERMISSION_KEY_RE, maxLength: 128 });
const permissionKeys = () => Type.Array(permissionKey(), { maxItems: 512 });

/** A jsonb scope narrowing (`membership_role.scope` / `auditor_engagement.scope`) — an object. */
const scopeObject = () => Type.Object({}, { additionalProperties: true });

// ── path params ────────────────────────────────────────────────────────────────────────────────

/** `/roles/:id` — permissive: a role id may be a `tmpl_*` platform-template reference. */
export const RoleIdParams = Type.Object({ id: opaqueId() });

/** `/memberships/:id/roles` — the membership id lands in a uuid FK with no prior lookup. */
export const MembershipIdParams = Type.Object({ id: uuid() });

/** `/memberships/:id/roles/:rid` — `rid` is only ever looked up/compared, so it stays opaque. */
export const MembershipRoleParams = Type.Object({ id: uuid(), rid: opaqueId() });

/** `/breakglass/:id/*` */
export const BreakGlassIdParams = Type.Object({ id: uuid() });

/** `/engagements/:id/*` */
export const EngagementIdParams = Type.Object({ id: uuid() });

// ── request bodies ─────────────────────────────────────────────────────────────────────────────

/** POST /api/v1/roles — §7.6 clone/extend a template into an org-owned custom role. */
export const CreateRoleBody = Type.Object(
  {
    key: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9_]+$" }),
    name: Type.String({ minLength: 1, maxLength: 200 }),
    category: lit(ROLE_CATEGORY),
    /** Absent → the `role.scope_level` column default (`location`), never a widened grant. */
    scopeLevel: Type.Optional(lit(SCOPE_LEVEL)),
    permissionKeys: Type.Optional(permissionKeys()),
    clonedFromKey: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
  },
  { additionalProperties: false },
);

/**
 * PATCH /api/v1/roles/:id — a partial edit; an absent field is untouched. `permissionKeys: []` is a
 * MEANINGFUL value (strip to nothing — refused for a system_locked role by the §3.4.1 floor check),
 * which is why the handler drives its patch off PRESENCE, not truthiness.
 */
export const UpdateRoleBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    enabled: Type.Optional(Type.Boolean()),
    permissionKeys: Type.Optional(permissionKeys()),
  },
  { additionalProperties: false },
);

/** POST /api/v1/memberships/:id/roles — §6 grant a role onto a membership. */
export const AssignRoleBody = Type.Object(
  {
    roleId: opaqueId(),
    scope: Type.Optional(scopeObject()),
    /** `membership_role.expires_at` is timestamptz — a non-instant string is refused here. */
    expiresAt: Type.Optional(Type.Union([isoInstant(), Type.Null()])),
  },
  { additionalProperties: false },
);

/** POST /api/v1/breakglass — §7.4 open emergency access (the reason IS the accountability record). */
export const InvokeBreakGlassBody = Type.Object(
  {
    /** §7.4 D1 — a substantive reason, not a keystroke. */
    reason: Type.String({ minLength: 10, maxLength: 2000 }),
    /**
     * REQUIRED, and non-null. Break-glass is emergency access to ONE patient's chart.
     *
     * This used to be `Optional(Union([uuid(), Null()]))`, and an absent target minted a
     * "scope-level" grant that `findActiveGrant` treated as a wildcard over EVERY target. One
     * permission — `breakglass.invoke`, by design a bedside-clinician permission — could therefore
     * self-issue a 4-hour grant that satisfied every `requireAbac` in the platform, including
     * `part2Redisclosure` (42 CFR Part 2 has no break-glass exception), `capVerifyAuthority`
     * (collapsing ADR-0022 two-person control), `abuseAllegationAccess`, and M34's platform-ops
     * predicates. The audit C2 fix took `cosignRequired` out of the body but left the scope here,
     * which is the same class of defect: the CALLER choosing the blast radius of its own bypass.
     * The scope is now server-derived from a target the caller must name.
     */
    targetPatientId: uuid(),
    // audit C2 — `cosignRequired` REMOVED. Whether a grant needs a co-signer is tenant policy
    // (`breakglass_cosign_required`), resolved server-side; a caller that supplies it now gets a
    // 422 from `additionalProperties: false` rather than silently choosing its own oversight.
  },
  { additionalProperties: false },
);

/** POST /api/v1/engagements — §7.5 open an auditor engagement over a defined slice + window. */
export const CreateEngagementBody = Type.Object(
  {
    engagementType: lit(ENGAGEMENT_TYPE),
    auditorAgency: Type.String({ minLength: 1, maxLength: 200 }),
    scope: Type.Optional(scopeObject()),
    startAt: isoInstant(),
    endAt: isoInstant(),
  },
  { additionalProperties: false },
);

/** PATCH /api/v1/engagements/:id — shorten the window or cancel the engagement. */
export const UpdateEngagementBody = Type.Object(
  {
    cancel: Type.Optional(Type.Boolean()),
    endAt: Type.Optional(isoInstant()),
  },
  { additionalProperties: false },
);

/** POST /api/v1/engagements/:id/auditors — enroll an auditor (M2 mints the magic link, D4). */
export const EnrollAuditorBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    email: Type.String({ format: "email", maxLength: 320 }),
  },
  { additionalProperties: false },
);

export type CreateRoleInput = Static<typeof CreateRoleBody>;
export type UpdateRoleInput = Static<typeof UpdateRoleBody>;
export type AssignRoleInput = Static<typeof AssignRoleBody>;
export type InvokeBreakGlassInput = Static<typeof InvokeBreakGlassBody>;
export type CreateEngagementInput = Static<typeof CreateEngagementBody>;
export type UpdateEngagementInput = Static<typeof UpdateEngagementBody>;
export type EnrollAuditorInput = Static<typeof EnrollAuditorBody>;

// ── §4.2 RESPONSE DTOs (F0 enrichment) ───────────────────────────────────────────────────────────
// The M3 read + mutation routes return typed views from `../authz-ports` (RoleView, MembershipRoleView,
// BreakGlassView, EngagementView, EngagementSummary) plus the @wardenx/auth permission mirror, but the
// published API carried NO response contract for any of them, so `client:gen` typed those bodies as
// `never`. These DTOs mirror the views 1:1 and are pinned to them by the compile-time `Conforms` aliases
// below — a view field renamed/added breaks `bun run build` rather than silently drifting from the client.
// Enums are LITERAL UNIONS, never bare `Type.String()` (the M30 "a wire enum as a string is a silent lie"
// lesson): `role.category` / `scope_level` / `engagement_type` / the break-glass + engagement status
// vocabularies publish their real value sets.
const BREAK_GLASS_STATUS = ["active", "cosign_pending", "revoked", "expired"] as const;
const ENGAGEMENT_STATUS = ["scheduled", "active", "closed", "cancelled"] as const;

/** One role row (a platform template or an org's own/customized role) — mirrors `RoleView`. */
export const RoleResponseSchema = Type.Object({
  roleId: Type.String(),
  organizationId: Type.Union([Type.String(), Type.Null()]),
  key: Type.String(),
  name: Type.String(),
  category: lit(ROLE_CATEGORY),
  scopeLevel: lit(SCOPE_LEVEL),
  systemDefault: Type.Boolean(),
  systemLocked: Type.Boolean(),
  enabled: Type.Boolean(),
  customized: Type.Boolean(),
  permissionKeys: Type.Array(Type.String()),
});
/** GET /api/v1/roles — the role catalog envelope. */
export const RoleListResponseSchema = Type.Object({ roles: Type.Array(RoleResponseSchema) });
/** DELETE /api/v1/roles/:id — the tombstone ack. */
export const RoleDeletedResponseSchema = Type.Object({ deleted: Type.Literal(true) });

/** One membership↔role grant — mirrors `MembershipRoleView`. */
export const MembershipRoleResponseSchema = Type.Object({
  grantId: Type.String(),
  membershipId: Type.String(),
  roleId: Type.String(),
  roleKey: Type.String(),
  scope: Type.Unknown(),
  expiresAt: Type.Union([Type.String(), Type.Null()]),
});
/** GET /api/v1/memberships/:id/roles — the grants envelope. */
export const MembershipRoleListResponseSchema = Type.Object({
  roles: Type.Array(MembershipRoleResponseSchema),
});
/** DELETE /api/v1/memberships/:id/roles/:rid — the revoke ack. */
export const RoleGrantRevokedResponseSchema = Type.Object({ revoked: Type.Literal(true) });

/** GET /api/v1/me/permissions — the caller's effective permission keys (no service view; a key set). */
export const MePermissionsResponseSchema = Type.Object({ permissions: Type.Array(Type.String()) });

/** One permission catalog row — mirrors `@wardenx/auth` `PermissionMirrorRow`. */
export const PermissionMirrorResponseSchema = Type.Object({
  key: Type.String(),
  resource: Type.String(),
  action: Type.String(),
  category: Type.String(),
  defaultAbac: Type.String(),
  description: Type.String(),
});
/** GET /api/v1/permissions — the permission-catalog envelope. */
export const PermissionsResponseSchema = Type.Object({
  permissions: Type.Array(PermissionMirrorResponseSchema),
});

/** One break-glass event (carries a target *reference*, not PHI) — mirrors `BreakGlassView`. */
export const BreakGlassResponseSchema = Type.Object({
  eventId: Type.String(),
  organizationId: Type.String(),
  actorUserId: Type.String(),
  targetPatientId: Type.Union([Type.String(), Type.Null()]),
  reason: Type.String(),
  status: lit(BREAK_GLASS_STATUS),
  cosignRequired: Type.Boolean(),
  startedAt: Type.String(),
  expiresAt: Type.String(),
});
/** GET /api/v1/breakglass — the events envelope. */
export const BreakGlassListResponseSchema = Type.Object({
  events: Type.Array(BreakGlassResponseSchema),
});
/** POST /api/v1/breakglass — the invoke ack (id + status + time-box). */
export const BreakGlassInvokedResponseSchema = Type.Object({
  breakGlassId: Type.String(),
  status: lit(BREAK_GLASS_STATUS),
  expiresAt: Type.String(),
});
/** POST /api/v1/breakglass/:id/{cosign,revoke} — the status-transition ack. */
export const BreakGlassStatusResponseSchema = Type.Object({
  breakGlassId: Type.String(),
  status: lit(BREAK_GLASS_STATUS),
});

/** One auditor engagement — mirrors `EngagementView`. */
export const EngagementResponseSchema = Type.Object({
  engagementId: Type.String(),
  organizationId: Type.String(),
  engagementType: lit(ENGAGEMENT_TYPE),
  auditorAgency: Type.String(),
  scope: Type.Unknown(),
  status: lit(ENGAGEMENT_STATUS),
  startAt: Type.String(),
  endAt: Type.String(),
});
/** GET /api/v1/engagements/:id/summary — the post-engagement report — mirrors `EngagementSummary`. */
export const EngagementSummaryResponseSchema = Type.Object({
  engagementId: Type.String(),
  auditorsEnrolled: Type.Integer(),
  resourcesTouched: Type.Integer(),
});
/** POST /api/v1/engagements/:id/auditors — the enrollment ack (token delivered out-of-band). */
export const AuditorEnrolledResponseSchema = Type.Object({
  engagementId: Type.String(),
  status: Type.Literal("pending"),
});

// Compile-time pins: `T` (what the schema publishes) must be assignable to `V` (what the service returns).
type Conforms<T extends V, V> = T;
type _Role = Conforms<Static<typeof RoleResponseSchema>, RoleView>;
type _MembershipRole = Conforms<Static<typeof MembershipRoleResponseSchema>, MembershipRoleView>;
type _PermissionMirror = Conforms<Static<typeof PermissionMirrorResponseSchema>, PermissionMirrorRow>;
type _BreakGlass = Conforms<Static<typeof BreakGlassResponseSchema>, BreakGlassView>;
type _BreakGlassStatus = Conforms<Static<typeof BreakGlassResponseSchema>["status"], BreakGlassStatus>;
type _Engagement = Conforms<Static<typeof EngagementResponseSchema>, EngagementView>;
type _EngagementStatus = Conforms<Static<typeof EngagementResponseSchema>["status"], EngagementStatus>;
type _EngagementSummary = Conforms<Static<typeof EngagementSummaryResponseSchema>, EngagementSummary>;
