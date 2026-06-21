/**
 * WardenX — OpenAPI enrichment registry (F0-T01, ADR-0032)
 * --------------------------------------------------------
 * Layers request/response schema detail onto the auto-discovered routes
 * (scan-routes.ts). Keyed by `METHOD /path` (exactly as written in source).
 *
 * Routes are discovered automatically, so COVERAGE never depends on this file —
 * an unlisted route still appears in the contract (params auto-derived from the
 * path). This registry only ADDS the request body / typed response, reusing the
 * SAME exported TypeBox schemas the route handlers validate against, so the
 * contract cannot drift from the validator.
 *
 * As of F0-T01 only the M5 Patient routes are enriched (proves the schema-embed
 * path end-to-end). Wiring the remaining modules' bodies/responses is the
 * deferred backend follow-up in docs/plans/FRONTEND_INTEGRATION_PLAN.md.
 */
import { type TSchema, Type } from "@sinclair/typebox";
import {
  AuditEventsQuerySchema,
  AuditEventsResponseSchema,
} from "../../apps/backend/src/modules/04-audit/routes/audit-typebox";
import {
  AddressBodySchema,
  AdmitBodySchema,
  AmendmentBodySchema,
  DenyBodySchema,
  PatientListQuerySchema,
  PatientListResponseSchema,
  PatientSummarySchema,
} from "../../apps/backend/src/modules/05-patient/routes/patient-typebox";
import { SearchQuerySchema as MdmSearchQuerySchema } from "../../apps/backend/src/modules/40-mdm/routes/mdm-typebox";
import { SearchQuerySchema as TerminologySearchQuerySchema } from "../../apps/backend/src/modules/38-terminology/routes/terminology-typebox";
import {
  ListMessagesQuerySchema,
  SendMessageBodySchema,
} from "../../apps/backend/src/modules/36-messaging/routes/messaging-typebox";

// M36 service view shapes (packages/messaging/src/interfaces/route-service.ts + provider.ts). The
// routes return TS service results (not TypeBox), so the response shapes are declared here for the client.
const ChannelSummarySchema = Type.Object({
  channelId: Type.String(),
  kind: Type.String(),
  title: Type.Union([Type.String(), Type.Null()]),
  subjectId: Type.Union([Type.String(), Type.Null()]),
  archivedAt: Type.Union([Type.String(), Type.Null()]),
  unreadCount: Type.Integer(),
});
const ResolvedMessageSchema = Type.Object({
  messageId: Type.String(),
  channelId: Type.String(),
  authorUserId: Type.Union([Type.String(), Type.Null()]),
  body: Type.String(),
  bodyKind: Type.String(),
  createdAt: Type.String(),
  parentMessageId: Type.Union([Type.String(), Type.Null()]),
});
const AlertInboxItemSchema = Type.Object({
  alertId: Type.String(),
  eventType: Type.String(),
  category: Type.String(),
  severity: Type.String(),
  summary: Type.String(),
  createdAt: Type.String(),
  deliveryStatus: Type.Union([
    Type.Literal("delivered"),
    Type.Literal("partial"),
    Type.Literal("failed"),
    Type.Literal("pending"),
  ]),
});

// M38 search returns { results: ResolvedConcept[], mode, asOf }. The concept summary (the fields the
// admin table needs) is declared here; `properties` (a per-system union) is omitted from the client type.
const ConceptSummarySchema = Type.Object({
  systemId: Type.String(),
  code: Type.String(),
  display: Type.String(),
  status: Type.Union([Type.Literal("active"), Type.Literal("deprecated"), Type.Literal("retired")]),
  effectiveDate: Type.String(),
  endDate: Type.Union([Type.String(), Type.Null()]),
});
const TerminologySearchResponseSchema = Type.Object({
  results: Type.Array(ConceptSummarySchema),
  mode: Type.String(),
  asOf: Type.Union([Type.String(), Type.Null()]),
});

// M40 search returns MdmResolved<K>[] (canonical base + status). The route returns `{ results }`
// untyped, so the common resolved-summary shape is declared here for the client (UI reads the base
// fields; the server may send richer per-kind canonical fields).
const MdmResolvedSummarySchema = Type.Object({
  id: Type.String(),
  status: Type.Union([Type.Literal("active"), Type.Literal("deactivated"), Type.Literal("provisional")]),
  canonical: Type.Object({
    id: Type.String(),
    identifierType: Type.String(),
    identifierValue: Type.Union([Type.String(), Type.Null()]),
    displayName: Type.String(),
  }),
});
const MdmSearchResponseSchema = Type.Object({ results: Type.Array(MdmResolvedSummarySchema) });

// M2 Identity routes validate via a manual parse() (no route-level TypeBox file), so their request/
// response schemas are declared here to type the client. Mirrors the wire shapes in
// apps/backend/src/modules/02-identity/routes/identity-routes.ts (toView / readString).
const MembershipViewSchema = Type.Object({
  membershipId: Type.String(),
  organizationId: Type.String(),
  organizationName: Type.String(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("active"),
    Type.Literal("suspended"),
    Type.Literal("revoked"),
  ]),
  isAdmin: Type.Boolean(),
  defaultLocationIds: Type.Array(Type.String()),
});

// Step-up qualifying factors (W-M2-11 / D9): only webauthn + totp; SMS is excluded by design.
const StepUpFactorSchema = Type.Union([Type.Literal("webauthn"), Type.Literal("totp")]);

export interface RouteEnrichment {
  /** JSON request body schema (a TypeBox schema reused from the route's validator). */
  body?: TSchema;
  /** Query-string schema (a TypeBox object; each property → one `in: query` parameter). */
  query?: TSchema;
  /** Typed 2xx response body schema, when known. */
  response?: TSchema;
  /** Human summary for the operation. */
  summary?: string;
}

/** `METHOD /path` → enrichment. Keys MUST match a scanned route (openapi:check enforces). */
export const ROUTE_ENRICHMENTS: Record<string, RouteEnrichment> = {
  // M36 Messaging (Track A — Staff Messaging + Notifications)
  "GET /api/v1/messaging/channels": {
    summary: "List the caller's channels (§4.6)",
    response: Type.Object({ channels: Type.Array(ChannelSummarySchema) }),
  },
  "GET /api/v1/messaging/channels/:id/messages": {
    summary: "List a channel's messages (cursor-paginated, §4.6)",
    query: ListMessagesQuerySchema,
    response: Type.Object({
      messages: Type.Array(ResolvedMessageSchema),
      nextCursor: Type.Optional(Type.String()),
    }),
  },
  "POST /api/v1/messaging/channels/:id/messages": {
    summary: "Post a message to a channel (§4.6)",
    body: SendMessageBodySchema,
  },
  "GET /api/v1/alerts/inbox": {
    summary: "The caller's alert inbox (§4.7)",
    response: Type.Object({ alerts: Type.Array(AlertInboxItemSchema) }),
  },
  // M3 Authorization (Track A — Roles & Permissions). No route-level TypeBox; shapes from
  // apps/backend/src/modules/03-authorization/authz-ports.ts (RoleView) + the M3 permission mirror.
  "GET /api/v1/roles": {
    summary: "List role catalog for the org (templates + customized, §6)",
    response: Type.Object({
      roles: Type.Array(
        Type.Object({
          roleId: Type.String(),
          organizationId: Type.Union([Type.String(), Type.Null()]),
          key: Type.String(),
          name: Type.String(),
          category: Type.String(),
          scopeLevel: Type.String(),
          systemDefault: Type.Boolean(),
          systemLocked: Type.Boolean(),
          enabled: Type.Boolean(),
          customized: Type.Boolean(),
          permissionKeys: Type.Array(Type.String()),
        }),
      ),
    }),
  },
  "GET /api/v1/permissions": {
    summary: "The permission catalog (mirror rows, §6)",
    response: Type.Object({
      permissions: Type.Array(
        Type.Object({
          key: Type.String(),
          resource: Type.String(),
          action: Type.String(),
          category: Type.String(),
        }),
      ),
    }),
  },
  // M38 Terminology (Track A — Terminology Admin)
  "GET /api/v1/terminology/:system/search": {
    summary: "Search concepts within a code system (§4.2)",
    query: TerminologySearchQuerySchema,
    response: TerminologySearchResponseSchema,
  },
  // M40 MDM (Track A — Master Data Management console)
  "GET /api/v1/mdm/:kind/search": {
    summary: "Search a kind's canonical master-data set (§4.2)",
    query: MdmSearchQuerySchema,
    response: MdmSearchResponseSchema,
  },
  // M4 Audit (Track A — Audit Log Viewer)
  "GET /api/v1/audit/events": {
    summary: "Search audit events (cursor-paginated, §4.3)",
    query: AuditEventsQuerySchema,
    response: AuditEventsResponseSchema,
  },
  // M2 Identity (Track A — Auth screens)
  "GET /api/v1/auth/memberships": {
    summary: "List the caller's memberships (pre-org-bind, §7.2)",
    response: Type.Object({ memberships: Type.Array(MembershipViewSchema) }),
  },
  "POST /api/v1/auth/select-organization": {
    summary: "Bind the session to one organization (one-time, §7.2)",
    body: Type.Object({ organizationId: Type.String({ minLength: 1 }) }),
  },
  "POST /api/v1/invitations/accept": {
    summary: "Accept an invitation token → membership (§7.1)",
    body: Type.Object({ token: Type.String({ minLength: 1 }) }),
  },
  // M2 Identity — Staff Management (Track A): org member roster + invitations + lifecycle.
  "GET /api/v1/orgs/:id/members": {
    summary: "List an org's members (member.manage, §6)",
    response: Type.Object({ members: Type.Array(MembershipViewSchema) }),
  },
  "POST /api/v1/orgs/:id/invitations": {
    summary: "Invite a member by email — token emailed, never returned (§7.1)",
    body: Type.Object({
      email: Type.String({ format: "email" }),
      proposedRoleKeys: Type.Optional(Type.Array(Type.String())),
      proposedDefaultLocationIds: Type.Optional(Type.Array(Type.String())),
    }),
  },
  "PATCH /api/v1/orgs/:id/members/:mId": {
    summary: "Change a member's status (active|suspended) or default locations; last-admin guarded (§6)",
    body: Type.Object({
      status: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("suspended")])),
      defaultLocationIds: Type.Optional(Type.Array(Type.String())),
    }),
    response: MembershipViewSchema,
  },
  "DELETE /api/v1/orgs/:id/members/:mId": {
    summary: "Revoke a membership (terminates its sessions; last-admin guarded, §6/§7.5)",
    response: Type.Object({ revoked: Type.Boolean() }),
  },
  // M2 Identity — session step-up (§4.4). Manual parse() in routes/session-step-up.ts; the wire shapes
  // are mirrored here for the client. SMS is intentionally absent (D9 — only webauthn + totp qualify).
  "POST /api/v1/sessions/step-up/initiate": {
    summary: "Begin a step-up challenge (webauthn | totp, §4.4)",
    body: Type.Object({ factor: StepUpFactorSchema }),
    response: Type.Object({
      challengeId: Type.String(),
      factor: StepUpFactorSchema,
      // present only for webauthn (the browser uses it to drive the assertion ceremony)
      webauthnChallenge: Type.Optional(
        Type.Object({ challenge: Type.String(), rpId: Type.String() }),
      ),
    }),
  },
  "POST /api/v1/sessions/step-up": {
    summary: "Verify a step-up challenge → paired-write the session freshness (§4.4, D8)",
    body: Type.Object({
      factor: StepUpFactorSchema,
      challengeId: Type.String({ minLength: 1 }),
      // factor-specific (one is supplied): a 6-digit TOTP code or a WebAuthn assertion.
      totpCode: Type.Optional(Type.String({ pattern: "^[0-9]{6}$" })),
      assertion: Type.Optional(Type.Unknown()),
    }),
    response: Type.Object({
      lastStepUpAt: Type.String(),
      lastStepUpFactor: StepUpFactorSchema,
    }),
  },
  // M5 Patient
  "GET /api/v1/patients": {
    summary: "Patient census / list (cursor-paginated, §4.2)",
    query: PatientListQuerySchema,
    response: PatientListResponseSchema,
  },
  "GET /api/v1/patients/:id": {
    summary: "Fetch a patient by id (merge-redirect aware, §4.8)",
    response: PatientSummarySchema,
  },
  "POST /api/v1/patients": { body: AdmitBodySchema, summary: "Admit a patient (§7.1 duplicate-check)" },
  "POST /api/v1/patients/:id/addresses": {
    body: AddressBodySchema,
    summary: "Append a patient address (§7.4 cascade)",
  },
  "POST /api/v1/patients/:id/amendments": {
    body: AmendmentBodySchema,
    summary: "Open a record-amendment request (§7.7, 60-day SLA)",
  },
  "POST /api/v1/amendments/:id/deny": {
    body: DenyBodySchema,
    summary: "Deny an amendment request (denial reason required)",
  },
};
