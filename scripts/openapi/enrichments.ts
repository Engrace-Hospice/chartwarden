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
  PatientAddressesResponseSchema,
  PatientCareTeamResponseSchema,
  PatientDemographicsSchema,
  PatientIdentifiersResponseSchema,
  PatientListQuerySchema,
  PatientListResponseSchema,
  PatientPayersResponseSchema,
  PatientPrivacyFlagsResponseSchema,
  PatientSummarySchema,
} from "../../apps/backend/src/modules/05-patient/routes/patient-typebox";
import {
  ListMessagesQuerySchema,
  SendMessageBodySchema,
} from "../../apps/backend/src/modules/36-messaging/routes/messaging-typebox";
import { SearchQuerySchema as TerminologySearchQuerySchema } from "../../apps/backend/src/modules/38-terminology/routes/terminology-typebox";
import { SearchQuerySchema as MdmSearchQuerySchema } from "../../apps/backend/src/modules/40-mdm/routes/mdm-typebox";

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
  status: Type.Union([
    Type.Literal("active"),
    Type.Literal("deactivated"),
    Type.Literal("provisional"),
  ]),
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
  userId: Type.String(),
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
  // Wrapped-user identity joined in by the live repo (FB-T12). Account status drives the "locked" KPI.
  displayName: Type.Union([Type.String(), Type.Null()]),
  email: Type.Union([Type.String(), Type.Null()]),
  lastLoginAt: Type.Union([Type.String(), Type.Null()]),
  accountStatus: Type.Union([
    Type.Literal("created"),
    Type.Literal("active"),
    Type.Literal("suspended"),
    Type.Literal("deactivated"),
    Type.Null(),
  ]),
});

// The authenticated actor's role/membership context (FB-T15, M2↔M3 enrichment). Mirrors the
// `GET /api/v1/auth/context` wire shape in identity-routes.ts — the shell reflects these
// server-resolved roles/permissions for Role-Home + nav gating (the server stays the enforcer).
const ActorContextSchema = Type.Object({
  userId: Type.String(),
  organizationId: Type.Union([Type.String(), Type.Null()]),
  organizationName: Type.Union([Type.String(), Type.Null()]),
  membershipId: Type.Union([Type.String(), Type.Null()]),
  displayName: Type.Union([Type.String(), Type.Null()]),
  roles: Type.Array(Type.String()),
  isAdmin: Type.Boolean(),
  permissions: Type.Array(Type.String()),
});

// Step-up qualifying factors (W-M2-11 / D9): only webauthn + totp; SMS is excluded by design.
const StepUpFactorSchema = Type.Union([Type.Literal("webauthn"), Type.Literal("totp")]);

// M6 Admission routes validate via a manual parse() (the route-level TypeBox covers request bodies,
// not the wire response shapes), so the read responses are declared here to type the Track B screens
// (M6-T12). Mirrors AdmissionRouteService's SummaryRow / AdmissionDetail / Page<T>
// (apps/backend/src/modules/06-admission/routes/service.ts).
const AdmissionSummaryRowSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
});
const AdmissionListQuerySchema = Type.Object({
  state: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
const ComplianceListQuerySchema = Type.Object({
  state: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
const ReferralListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
const AdmissionPageResponseSchema = Type.Object({
  items: Type.Array(AdmissionSummaryRowSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
const AdmissionListResponseSchema = Type.Object({ items: Type.Array(AdmissionSummaryRowSchema) });
const AdmissionDetailResponseSchema = Type.Object({
  id: Type.String(),
  state: Type.String(),
  version: Type.Integer(),
  // R-AC-01 activation gate (§5.2.5 checklist source of truth — the same gate route 14 enforces).
  activationGate: Type.Object({
    ready: Type.Boolean(),
    missing: Type.Array(Type.String()),
  }),
});

// M7 Care Plan (IPOC) routes validate via a manual parse() (the route-level TypeBox covers request
// bodies, not the wire response shapes), so the read responses are declared here to type the Track B
// screens (M7-T09). Mirrors CarePlanRouteService's getCarePlanForPatient / listVersions / getSummary
// projections (apps/backend/src/modules/07-care-plan/routes/service.ts). The UI reads only the fields
// it renders; the server may send richer rows.
const CarePlanVersionDtoSchema = Type.Object({
  id: Type.String(),
  planId: Type.String(),
  sequence: Type.Integer(),
  kind: Type.String(),
  status: Type.String(),
  idgMeetingId: Type.Union([Type.String(), Type.Null()]),
  requiredSignerSet: Type.Array(Type.String()),
  signatures: Type.Array(Type.Object({ signerRole: Type.String(), signedAt: Type.String() })),
  signedAt: Type.Union([Type.String(), Type.Null()]),
  version: Type.Integer(),
});
const CarePlanProblemDtoSchema = Type.Object({
  id: Type.String(),
  description: Type.String(),
  kind: Type.String(),
  source: Type.String(),
  sudRelated: Type.Boolean(),
  status: Type.String(),
  icd10Code: Type.Union([Type.String(), Type.Null()]),
  snomedCode: Type.Union([Type.String(), Type.Null()]),
  resolutionNote: Type.Union([Type.String(), Type.Null()]),
  version: Type.Integer(),
});
const CarePlanGoalDtoSchema = Type.Object({
  id: Type.String(),
  problemId: Type.String(),
  originalText: Type.String(),
  revisedText: Type.Union([Type.String(), Type.Null()]),
  source: Type.String(),
  actingConsentId: Type.Union([Type.String(), Type.Null()]),
  measurableOutcome: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  version: Type.Integer(),
});
const CarePlanInterventionDtoSchema = Type.Object({
  id: Type.String(),
  problemId: Type.String(),
  goalRefs: Type.Array(Type.String()),
  scopeText: Type.String(),
  frequencyText: Type.String(),
  frequencyValue: Type.String(),
  discipline: Type.String(),
  responsibleRole: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  version: Type.Integer(),
});
// The patient-scoped read returns the assembled plan; the no-plan case sends `{ carePlan: null }`.
// All assembled fields are optional so the client narrows on `id` presence (the empty case omits them).
const CarePlanReadResponseSchema = Type.Object({
  id: Type.Optional(Type.String()),
  patientId: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  activeVersionId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  version: Type.Optional(Type.Integer()),
  versions: Type.Optional(Type.Array(CarePlanVersionDtoSchema)),
  problems: Type.Optional(Type.Array(CarePlanProblemDtoSchema)),
  goals: Type.Optional(Type.Array(CarePlanGoalDtoSchema)),
  interventions: Type.Optional(Type.Array(CarePlanInterventionDtoSchema)),
  redacted: Type.Optional(Type.Boolean()),
  // present (and null) only on the no-plan response
  carePlan: Type.Optional(Type.Null()),
});
const CarePlanVersionsResponseSchema = Type.Object({
  items: Type.Array(CarePlanVersionDtoSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
const CarePlanSummaryResponseSchema = Type.Object({
  planId: Type.String(),
  versionId: Type.Union([Type.String(), Type.Null()]),
  activeProblems: Type.Array(Type.Object({ description: Type.String(), kind: Type.String() })),
  patientStatedGoals: Type.Array(
    Type.Object({
      text: Type.String(),
      measurableOutcome: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
  activeInterventions: Type.Array(
    Type.Object({
      layText: Type.String(),
      discipline: Type.String(),
      frequencyText: Type.String(),
    }),
  ),
  redacted: Type.Boolean(),
});

// M8 Encounters & Visit Notes (Track B — Encounter Read / Cosignature Queue / My Drafts, M8-T12). M8's
// routes are not auto-mounted into the contract yet (the write routes keep route-level TypeBox bodies),
// so the read responses are declared here to type the Track B screens. Mirrors EncounterView /
// listEncounters / cosignatureQueue / myDrafts / getCosignature projections
// (apps/backend/src/modules/08-encounters/routes/service.ts). The UI reads only the fields it renders.
const EncounterViewDtoSchema = Type.Object({
  id: Type.String(),
  organizationId: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  visitId: Type.Union([Type.String(), Type.Null()]),
  encounterType: Type.String(),
  discipline: Type.String(),
  serviceDate: Type.String(),
  status: Type.String(),
  lateEntryTier: Type.String(),
  version: Type.Integer(),
  authoredByUserId: Type.String(),
  isF2f: Type.Boolean(),
  signedAt: Type.Union([Type.String(), Type.Null()]),
  cosignedAt: Type.Union([Type.String(), Type.Null()]),
});
const EncounterListResponseSchema = Type.Object({ encounters: Type.Array(EncounterViewDtoSchema) });
const CosignatureReadResponseSchema = Type.Object({
  status: Type.Union([Type.String(), Type.Null()]),
});

// M9 Clinical Assessments Suite (Track B — Assessment Timeline / Per-scale Trend / Significant-change
// Inbox / Assessment Summary / Scale-license Registry / Scale-policy Editor, M9-T07). Read responses
// only; the write routes keep their route-level TypeBox request bodies (already in the contract). The
// UI reads only the fields it renders; the server may send richer rows. SUD-flagged rows are redacted
// SERVER-side (§7.6) — `redacted: true` is the only signal the client sees. Mirrors AssessmentRouteService's
// AssessmentView / SignificantChangeView / ScaleLicenseView / ScalePolicyView + ScaleSeries projections
// (apps/backend/src/modules/09-assessments/routes/service.ts).
const AssessmentViewDtoSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  scaleType: Type.String(),
  score: Type.Union([Type.Number(), Type.Null()]),
  scoreInterpretation: Type.Union([Type.String(), Type.Null()]),
  capturedAt: Type.String(),
  capturedByDiscipline: Type.String(),
  cosignRequired: Type.Boolean(),
  cosignedAt: Type.Union([Type.String(), Type.Null()]),
  sudContext: Type.Boolean(),
  status: Type.String(),
  redacted: Type.Boolean(),
  version: Type.Integer(),
});
const AssessmentListResponseSchema = Type.Object({ assessments: Type.Array(AssessmentViewDtoSchema) });
const AssessmentSummaryResponseSchema = Type.Object({
  patientId: Type.String(),
  latest: Type.Array(AssessmentViewDtoSchema),
});
const ScaleSeriesResponseSchema = Type.Object({
  scaleType: Type.String(),
  patientId: Type.String(),
  from: Type.String(),
  to: Type.String(),
  points: Type.Array(
    Type.Object({
      assessmentId: Type.String(),
      capturedAt: Type.String(),
      score: Type.Union([Type.Number(), Type.Null()]),
      scoreInterpretation: Type.Union([Type.String(), Type.Null()]),
      significantChange: Type.Boolean(),
    }),
  ),
});
const SignificantChangeListResponseSchema = Type.Object({
  events: Type.Array(
    Type.Object({
      id: Type.String(),
      assessmentId: Type.String(),
      priorAssessmentId: Type.Union([Type.String(), Type.Null()]),
      ruleId: Type.String(),
      status: Type.String(),
      severity: Type.String(),
    }),
  ),
});
const ScaleLicenseListResponseSchema = Type.Object({
  licenses: Type.Array(
    Type.Object({
      id: Type.String(),
      scaleType: Type.String(),
      vendor: Type.String(),
      effectiveDate: Type.String(),
      expiresAt: Type.String(),
      seats: Type.Union([Type.Integer(), Type.Null()]),
      status: Type.String(),
    }),
  ),
});
const ScalePolicyListResponseSchema = Type.Object({
  policies: Type.Array(Type.Object({ scaleType: Type.String(), enabled: Type.Boolean() })),
});
// The per-scale series window (§4.1 `/scales/:scaleType/series` — from/to ISO instants, the trend window).
const ScaleSeriesQuerySchema = Type.Object({ from: Type.String(), to: Type.String() });

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
  // M6 Admission, Election & Certification (Track B — Referral Inbox / Admission Detail /
  // Compliance Dashboard / Admission Census, M6-T12). Read responses only; the write routes keep
  // their route-level TypeBox request bodies (already in the contract).
  "GET /api/v1/referrals": {
    summary: "Referral inbox queue (cursor-paginated, §4.1)",
    query: ReferralListQuerySchema,
    response: AdmissionPageResponseSchema,
  },
  "GET /api/v1/admissions": {
    summary: "Admission census (cursor-paginated; optional state filter, §4.1)",
    query: AdmissionListQuerySchema,
    response: AdmissionPageResponseSchema,
  },
  "GET /api/v1/admissions/:id": {
    summary: "Admission aggregate + the R-AC-01 activation gate (route 10, §5.2.4/§5.2.5)",
    response: AdmissionDetailResponseSchema,
  },
  "GET /api/v1/admissions/:id/election-periods": {
    summary: "An admission's election periods (§5.2.4 Elections tab)",
    response: AdmissionListResponseSchema,
  },
  "GET /api/v1/admissions/:id/compliance-windows": {
    summary: "An admission's compliance windows (§5.2.4 Compliance tab)",
    response: AdmissionListResponseSchema,
  },
  "GET /api/v1/compliance-windows": {
    summary:
      "Org-wide compliance window dashboard (cursor-paginated; optional state filter, §5.2.11)",
    query: ComplianceListQuerySchema,
    response: AdmissionPageResponseSchema,
  },
  // M7 Care Plan / IPOC (Track B — Care Plan View / Version History / Summary, M7-T09). Read responses
  // only; the write routes keep their route-level TypeBox request bodies (already in the contract).
  "GET /api/v1/patients/:patientId/care-plan": {
    summary:
      "A patient's care plan — problems/goals/interventions + versions; §7.6 SUD-redacted per caller (§5.2)",
    response: CarePlanReadResponseSchema,
  },
  "GET /api/v1/care-plans/:planId/versions": {
    summary: "Care-plan version history — every version with status, signers, and signed-at (§5.1)",
    response: CarePlanVersionsResponseSchema,
  },
  "GET /api/v1/care-plans/:planId/summary": {
    summary:
      "Patient/family-friendly care-plan summary; SUD content excluded unless consent matches (§5.2)",
    response: CarePlanSummaryResponseSchema,
  },
  // M8 Encounters & Visit Notes (Track B — Encounter Read / Cosignature Queue / My Drafts, M8-T12). Read
  // responses only; the write routes keep their route-level TypeBox request bodies (not yet in the contract).
  "GET /api/v1/encounters/:encounterId": {
    summary:
      "Read one encounter (selections + signatures + addenda; §7.6 SUD-redacted per caller, §5.2)",
    response: EncounterViewDtoSchema,
  },
  "GET /api/v1/encounters/cosignature-queue": {
    summary: "RN/Supervisor cosignature work queue with SLA chips (§5.5)",
    response: EncounterListResponseSchema,
  },
  "GET /api/v1/encounters/my-drafts": {
    summary: "The author's open encounter drafts (§5.1 My Drafts)",
    response: EncounterListResponseSchema,
  },
  "GET /api/v1/encounters/:encounterId/cosignature": {
    summary: "Read an encounter's cosignature-request state (§5.5)",
    response: CosignatureReadResponseSchema,
  },
  // M9 Clinical Assessments Suite (Track B — Timeline / Trend / Change Inbox / Summary / License
  // Registry / Policy Editor, M9-T07). Read responses only; the write routes keep their route-level
  // TypeBox request bodies (already in the contract). SUD redaction is server-side (§7.6).
  "GET /api/v1/patients/:patientId/assessments": {
    summary: "Patient assessment timeline — every captured scale, newest first; §7.6 SUD-redacted per caller (§5.2)",
    response: AssessmentListResponseSchema,
  },
  "GET /api/v1/patients/:patientId/assessments/summary": {
    summary: "Assessment summary — latest value per scale family across all scales; SUD-redacted per caller (§5.2)",
    response: AssessmentSummaryResponseSchema,
  },
  "GET /api/v1/patients/:patientId/scales/:scaleType/series": {
    summary: "Per-scale scored series over a [from,to] window with significant-change markers (§5.2)",
    query: ScaleSeriesQuerySchema,
    response: ScaleSeriesResponseSchema,
  },
  "GET /api/v1/patients/:patientId/significant-changes": {
    summary: "Per-patient significant-change worklist — open/escalated changes with ack state (§5.2)",
    response: SignificantChangeListResponseSchema,
  },
  "GET /api/v1/admin/scales/licenses": {
    summary: "Scale-license registry — one row per (org × scale) with status/expiry (§5.2)",
    response: ScaleLicenseListResponseSchema,
  },
  "GET /api/v1/admin/scales/policies": {
    summary: "Scale-policy editor — enable/disable state per scale (§5.2)",
    response: ScalePolicyListResponseSchema,
  },
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
  "GET /api/v1/auth/context": {
    summary: "The authenticated actor's roles/membership context (M2↔M3 enrichment, FB-T15)",
    response: ActorContextSchema,
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
    summary:
      "List an org's members; optional ?q narrows by user identity (member.manage, §6; FB-T11)",
    query: Type.Object({
      q: Type.Optional(
        Type.String({ description: "Narrow the roster by the wrapped user's identity" }),
      ),
    }),
    response: Type.Object({
      members: Type.Array(MembershipViewSchema),
      // Org-wide count of still-pending invitations — the "pending invites" KPI (FB-T12).
      pendingInvitations: Type.Integer(),
    }),
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
    summary:
      "Change a member's status (active|suspended) or default locations; last-admin guarded (§6)",
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
  "GET /api/v1/patients/:id/demographics": {
    summary: "Patient demographics tab — name parts + SOGI/race/ethnicity codes + language (§3.3)",
    response: PatientDemographicsSchema,
  },
  "GET /api/v1/patients/:id/identifiers": {
    summary: "Patient identifiers — ssn/state_id masked to last4 (§3.3/§2.2)",
    response: PatientIdentifiersResponseSchema,
  },
  "POST /api/v1/patients": {
    body: AdmitBodySchema,
    summary: "Admit a patient (§7.1 duplicate-check)",
  },
  "GET /api/v1/patients/:id/addresses": {
    summary: "Patient address history — D5 append-only; current + closed rows (§3.3)",
    response: PatientAddressesResponseSchema,
  },
  "POST /api/v1/patients/:id/addresses": {
    body: AddressBodySchema,
    summary: "Append a patient address (§7.4 cascade; isPrimary rotates the current primary)",
  },
  "GET /api/v1/patients/:id/payers": {
    summary: "Patient coverage / payers — ranked coverages; payer name resolved via M40 (§3.4)",
    response: PatientPayersResponseSchema,
  },
  "GET /api/v1/patients/:id/care-team": {
    summary: "Patient care team — assignment roster + caregivers + emergency contacts (§3.4/§3.5)",
    response: PatientCareTeamResponseSchema,
  },
  "GET /api/v1/patients/:id/privacy-flags": {
    summary:
      "Patient privacy flags — active restrictions snapshot; SUD §7.6 fail-closed (§3.5/D10)",
    response: PatientPrivacyFlagsResponseSchema,
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
