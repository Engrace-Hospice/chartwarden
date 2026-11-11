// apps/backend/src/modules/34-saas-tenant-platform/routes/help-request-typebox.ts — slice 7: the help-request wire contract.
//
// Request bodies, queries and response views of the six help-request routes on BOTH surfaces (tenant `/api/v1/tenant/help-requests`,
// platform `/api/v1/platform/help-requests`). Named `*-typebox` (never `*schema*`) so the table-ownership heuristic never mistakes
// it for a Drizzle import. Bodies bound the RAW text; the trimmed-length rules and the patient-identifier screen are the service's
// (piece 7B), which is the authority: a PHI-shaped message passes THIS schema and is refused 422 EVIDENCE_LOOKS_LIKE_PHI there.
// The response schemas are pinned to `help/help-request-contract.ts` by the `Conforms` aliases below (drift is a type error).
import { pageQuery } from "@chartwarden/shared/route-kit";
import { type Static, type TSchema, Type } from "@sinclair/typebox";
import type {
  HelpRequestView as ContractHelpRequestView,
  PlatformHelpRequestView as ContractPlatformHelpRequestView,
  TenantHelpRequestListView as ContractTenantHelpRequestListView,
} from "../help/help-request-contract";

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((x) => Type.Literal(x)));
const Nullable = <T extends TSchema>(t: T) => Type.Union([t, Type.Null()]);
const Instant = Type.String({ format: "date-time" });

// ── vocabularies (the screens switch on these; mirrored in help-request-contract.ts) ─────────────────────────────────────
export const HELP_REQUEST_STATUSES = ["open", "approved", "resolved", "cancelled"] as const;
export const HELP_REQUEST_PHASES = [
  "waiting_for_consent",
  "ready_to_start",
  "in_session",
  "ended",
] as const;
const HELP_GRANT_STATUSES = ["active", "expired", "revoked"] as const;
const SUPPORT_SESSION_STATES = ["open", "expired", "closed"] as const;
const SUPPORT_SESSION_CLOSE_REASONS = [
  "manual",
  "expired",
  "grant_revoked",
  "forced_terminated",
] as const;
/** Relative to the viewer, never an id: the operator is only ever "ChartWarden operations". */
const HELP_REQUEST_CLOSED_BY = [
  "you",
  "your organization",
  "ChartWarden operations",
  "system",
] as const;
const HELP_REQUEST_CLOSER_KINDS = ["tenant", "platform_ops", "system"] as const;

/** Bounds shared with the table's CHECKs (migration 1482, piece 7B): message btrim 8..1000, close note btrim 8..500, step key <= 64. */
export const HELP_MESSAGE_MIN = 8;
export const HELP_MESSAGE_MAX = 1000;
export const HELP_NOTE_MIN = 8;
export const HELP_NOTE_MAX = 500;
export const HELP_STEP_KEY_MAX = 64;
/** The consent window an approval may grant, in whole hours, and the default the service applies when it is omitted. */
export const HELP_APPROVE_HOURS_MIN = 1;
export const HELP_APPROVE_HOURS_MAX = 24;
export const HELP_APPROVE_HOURS_DEFAULT = 8;

/** `?status=open,approved`: one or more statuses, comma separated (the nav badge asks `open,approved` with `limit=1`). */
export const HELP_STATUS_FILTER_PATTERN =
  "^(open|approved|resolved|cancelled)(,(open|approved|resolved|cancelled))*$";

// ── path params, bodies, queries ─────────────────────────────────────────────────────────────────────────────────────────
export const HelpRequestParamsSchema = Type.Object({ id: Type.String({ format: "uuid" }) });

/** `POST /api/v1/tenant/help-requests`. */
export const FileHelpRequestRequest = Type.Object({
  stepKey: Type.Optional(Type.String({ minLength: 1, maxLength: HELP_STEP_KEY_MAX })),
  message: Type.String({ minLength: HELP_MESSAGE_MIN, maxLength: HELP_MESSAGE_MAX }),
});

/** `POST /api/v1/tenant/help-requests/:id/approve`. The default (8) is applied by the service, not the schema. */
export const ApproveHelpRequestRequest = Type.Object({
  hours: Type.Optional(
    Type.Integer({
      minimum: HELP_APPROVE_HOURS_MIN,
      maximum: HELP_APPROVE_HOURS_MAX,
      description: `Whole hours the consent lasts (${HELP_APPROVE_HOURS_MIN} to ${HELP_APPROVE_HOURS_MAX}); 8 when omitted.`,
    }),
  ),
});

/** `POST /api/v1/tenant/help-requests/:id/close` carries no mutable fields. */
export const CloseHelpRequestRequest = Type.Object({}, { additionalProperties: false });

/** `POST /api/v1/platform/help-requests/:id/resolve`. */
export const ResolveHelpRequestRequest = Type.Object({
  note: Type.String({ minLength: HELP_NOTE_MIN, maxLength: HELP_NOTE_MAX }),
});

const PageQuery = { ...pageQuery() };

/** `GET /api/v1/tenant/help-requests`: pages the ended requests; the live one always comes back as `current`. */
export const TenantHelpRequestListQuerySchema = Type.Object(PageQuery);

/** `GET /api/v1/platform/help-requests`. */
export const PlatformHelpRequestListQuerySchema = Type.Object({
  status: Type.Optional(
    Type.String({
      pattern: HELP_STATUS_FILTER_PATTERN,
      description:
        "Comma-separated statuses to include (open, approved, resolved, cancelled); every status when omitted.",
    }),
  ),
  tenantAccountId: Type.Optional(Type.String({ format: "uuid" })),
  ...PageQuery,
});

// ── response views (mirror help/help-request-contract.ts) ────────────────────────────────────────────────────────────────
const HelpGrantViewSchema = Type.Object({
  expiresAt: Instant,
  status: lit(HELP_GRANT_STATUSES),
});

const HelpSessionSummaryProperties = {
  state: lit(SUPPORT_SESSION_STATES),
  startedAt: Instant,
  expiresAt: Instant,
  closedAt: Nullable(Instant),
  closeReason: Nullable(lit(SUPPORT_SESSION_CLOSE_REASONS)),
  actionCount: Type.Integer({ minimum: 0 }),
  lastActionAt: Nullable(Instant),
};

/** The request as the TENANT sees it. `closedBy` is a label relative to the viewer; there is no operator id anywhere in it. */
export const HelpRequestViewSchema = Type.Object({
  id: Type.String(),
  stepKey: Nullable(Type.String()),
  message: Type.String(),
  status: lit(HELP_REQUEST_STATUSES),
  phase: lit(HELP_REQUEST_PHASES),
  requestedAt: Instant,
  approvedAt: Nullable(Instant),
  grant: Nullable(HelpGrantViewSchema),
  session: Nullable(Type.Object(HelpSessionSummaryProperties)),
  closedAt: Nullable(Instant),
  closedBy: Nullable(lit(HELP_REQUEST_CLOSED_BY)),
  closeNote: Nullable(Type.String()),
});

export const TenantHelpRequestListResponseSchema = Type.Object({
  current: Nullable(HelpRequestViewSchema),
  items: Type.Array(HelpRequestViewSchema),
  nextCursor: Nullable(Type.String()),
  hasMore: Type.Boolean(),
});

/** The request as an OPERATOR sees it: the inbox row, with the tenant, the grant to start against and the session id. */
export const PlatformHelpRequestViewSchema = Type.Object({
  id: Type.String(),
  tenantAccountId: Type.String(),
  orgSlug: Type.String(),
  legalBusinessName: Type.String(),
  stepKey: Nullable(Type.String()),
  message: Type.String(),
  status: lit(HELP_REQUEST_STATUSES),
  phase: lit(HELP_REQUEST_PHASES),
  requestedAt: Instant,
  requestedByMembershipId: Type.String(),
  approvedAt: Nullable(Instant),
  supportConsentGrantId: Nullable(Type.String()),
  grant: Nullable(HelpGrantViewSchema),
  session: Nullable(Type.Object({ sessionId: Type.String(), ...HelpSessionSummaryProperties })),
  closedAt: Nullable(Instant),
  closedByActorKind: Nullable(lit(HELP_REQUEST_CLOSER_KINDS)),
  closeNote: Nullable(Type.String()),
});

export const PlatformHelpRequestListResponseSchema = Type.Object({
  items: Type.Array(PlatformHelpRequestViewSchema),
  nextCursor: Nullable(Type.String()),
  hasMore: Type.Boolean(),
});

// Compile-time pins: each response schema structurally conforms to its contract view (drift = a type error).
type Conforms<T extends V, V> = T;
type _HelpRequest = Conforms<Static<typeof HelpRequestViewSchema>, ContractHelpRequestView>;
type _TenantList = Conforms<
  Static<typeof TenantHelpRequestListResponseSchema>,
  ContractTenantHelpRequestListView
>;
type _PlatformRequest = Conforms<
  Static<typeof PlatformHelpRequestViewSchema>,
  ContractPlatformHelpRequestView
>;
