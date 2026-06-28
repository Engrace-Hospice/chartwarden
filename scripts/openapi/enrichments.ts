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
// M23 Billing — the package-contract request/response schemas the route handlers `parse(...)` / return
// (claim assemble/replace/void bodies, the empty manual-validate body, and the internal service-to-service
// seam queries + responses). Re-exported from @wardenx/billing via route-contracts → schemas.
import {
  AcceptedSubmissionsQuery,
  AcceptedSubmissionsResponse,
  ClaimAssembleRequest,
  ClaimAssembleResponse,
  ClaimDayProjectionQuery,
  ClaimDayProjectionResponse,
  ClaimReplaceRequest,
  ClaimVoidRequest,
  ManualValidateRequest,
} from "@wardenx/billing";
import {
  AuditEventsQuerySchema,
  AuditEventsResponseSchema,
} from "../../apps/backend/src/modules/04-audit/routes/audit-typebox";
import {
  AddressBodySchema,
  AdmitBodySchema,
  AmendmentBodySchema,
  CensusMetricsResponseSchema,
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
import { OrderListQuerySchema } from "../../apps/backend/src/modules/11-orders/routes/orders-typebox";
import {
  AdministrationListResponseSchema,
  AdministrationPolicyViewSchema,
  AdministrationViewSchema,
  DeploymentListResponseSchema,
  DeploymentViewSchema,
  AdministrationListQuerySchema as EmarAdministrationListQuerySchema,
  DeploymentQuerySchema as EmarDeploymentQuerySchema,
  MissedDoseQuerySchema as EmarMissedDoseQuerySchema,
  ScheduledDoseQuerySchema as EmarScheduledDoseQuerySchema,
  WorksheetQuerySchema as EmarWorksheetQuerySchema,
  IvSessionViewSchema,
  MissedDoseListResponseSchema,
  ScheduledDoseListResponseSchema,
  WorksheetListResponseSchema,
  WorksheetViewSchema,
} from "../../apps/backend/src/modules/13-emar/routes/emar-typebox";
import {
  ActionItemListQuerySchema as IdgActionItemListQuerySchema,
  ActionItemListResponseSchema as IdgActionItemListResponseSchema,
  MeetingViewSchema as IdgMeetingViewSchema,
  MinutesViewSchema as IdgMinutesViewSchema,
  PacketDigestViewSchema as IdgPacketDigestViewSchema,
  PacketListResponseSchema as IdgPacketListResponseSchema,
  ScheduleListResponseSchema as IdgScheduleListResponseSchema,
  ScheduleQuerySchema as IdgScheduleQuerySchema,
} from "../../apps/backend/src/modules/14-idg/routes/idg-typebox";
import {
  AvailabilityQuerySchema as SchedAvailabilityQuerySchema,
  AvailabilityViewSchema as SchedAvailabilityViewSchema,
  DayViewQuerySchema as SchedDayViewQuerySchema,
  DayViewResponseSchema as SchedDayViewResponseSchema,
  MapViewQuerySchema as SchedMapViewQuerySchema,
  MapViewResponseSchema as SchedMapViewResponseSchema,
  MetricsQuerySchema as SchedMetricsQuerySchema,
  ProposalListQuerySchema as SchedProposalListQuerySchema,
  ProposalListResponseSchema as SchedProposalListResponseSchema,
  RecurringListQuerySchema as SchedRecurringListQuerySchema,
  RecurringListResponseSchema as SchedRecurringListResponseSchema,
  RouteEfficiencyQuerySchema as SchedRouteEfficiencyQuerySchema,
  RouteEfficiencyResponseSchema as SchedRouteEfficiencyResponseSchema,
  TimeOffListQuerySchema as SchedTimeOffListQuerySchema,
  TimeOffListResponseSchema as SchedTimeOffListResponseSchema,
  VisitListQuerySchema as SchedVisitListQuerySchema,
  VisitListResponseSchema as SchedVisitListResponseSchema,
  VisitMetricsResponseSchema as SchedVisitMetricsResponseSchema,
  VisitViewSchema as SchedVisitViewSchema,
  WeekViewQuerySchema as SchedWeekViewQuerySchema,
  WeekViewResponseSchema as SchedWeekViewResponseSchema,
} from "../../apps/backend/src/modules/17-scheduling/routes/scheduling-typebox";
import {
  AggregatorListQuery as EvvAggregatorListQuery,
  EvvAggregatorSubmissionListResponse,
  EvvDeviceListResponse,
  EventGetQuery as EvvEventGetQuery,
  EventListQuery as EvvEventListQuery,
  EvvEventListResponse,
  EvvEventView,
  EvvGeofencePolicyView,
  MembershipIdQuery as EvvMembershipIdQuery,
  MetricsQuery as EvvMetricsQuery,
  EvvMetricsView,
  MissingResolutionListQuery as EvvMissingResolutionListQuery,
  EvvMissingResolutionListResponse,
} from "../../apps/backend/src/modules/18-evv/routes/evv-typebox";
import {
  DocumentListQuerySchema as M22DocumentListQuerySchema,
  DocumentListResponseSchema as M22DocumentListResponseSchema,
  DocumentViewSchema as M22DocumentViewSchema,
  FormTemplateListResponseSchema as M22FormTemplateListResponseSchema,
  IntakeBatchViewSchema as M22IntakeBatchViewSchema,
  IntakeJobListResponseSchema as M22IntakeJobListResponseSchema,
  TemplateListQuerySchema as M22TemplateListQuerySchema,
  VersionListQuerySchema as M22VersionListQuerySchema,
  VersionListResponseSchema as M22VersionListResponseSchema,
} from "../../apps/backend/src/modules/22-documents/routes/documents-typebox";
// M23 Billing — Medicare. The route-level TypeBox query/body schemas the handlers `parse(...)` against
// (the same validators, so the contract cannot drift). REQUIRED import path for the status-matrix
// enrichment detection (`modules/23-billing-medicare/routes`).
import {
  CancelNoeBodySchema,
  CancelNotrBodySchema,
  CheckEligibilityBodySchema,
  ClaimListQuerySchema,
  ClaimPatchDraftBodySchema,
  CreateRuleConfigBodySchema,
  ForwardDateSequestrationBodySchema,
  MacCredentialListQuerySchema,
  MetricsQuerySchema as BillingMetricsQuerySchema,
  PatientQuerySchema as BillingPatientQuerySchema,
  NoeListQuerySchema,
  NotrListQuerySchema,
  OverrideValidationResultBodySchema,
  RequiredProviderEntityQuerySchema,
  RuleConfigListQuerySchema,
  UpdateRuleConfigBodySchema,
  UpsertMacCredentialBodySchema,
} from "../../apps/backend/src/modules/23-billing-medicare/routes/billing-typebox";
// M33 Reporting & Dashboards — the read query + drilldown body the Track B screens call (FB read paths).
import {
  DashboardListQuerySchema,
  MvListQuerySchema,
} from "../../apps/backend/src/modules/33-reporting/routes/reporting-typebox";
import {
  DrilldownEmitRequest,
  ScheduleListQuery,
} from "../../apps/backend/src/modules/33-reporting/routes/write-typebox";
import {
  BaaRegisterListQuerySchema,
  FeatureFlagListQuerySchema,
  OnboardingTemplateListQuerySchema,
  UpsertOnboardingTemplateRequest,
} from "../../apps/backend/src/modules/34-saas-tenant-platform/routes/platform/platform-typebox";
import {
  DsarListQuerySchema,
  TenantExportListQuerySchema,
} from "../../apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/tenant-typebox";
// M34 SaaS Tenant Platform — platform-ops + tenant read queries + the write bodies the admin screens call.
import {
  KillSwitchRequest,
  SupportConsentGrantRequest,
  TenantListQuerySchema,
} from "../../apps/backend/src/modules/34-saas-tenant-platform/routes/typebox";
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
const AssessmentListResponseSchema = Type.Object({
  assessments: Type.Array(AssessmentViewDtoSchema),
});
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

// ── M10 HOPE Engine read DTOs (Track B, M10-T08) ───────────────────────────────────────────────────
// Mirror HopeRouteService's view projections (apps/backend/src/modules/10-hope/routes/service.ts). The UI
// reads only the fields it renders; the server is authoritative for J2051/late/snapshot. The §4.10 iQIES
// submission lifecycle surfaces as read-only status here; the recording modal (writes) keeps its route-level
// TypeBox request bodies (already in the contract).
const HopeScheduleViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  rfaKind: Type.String(),
  status: Type.String(),
  windowOpensAt: Type.String(),
  windowClosesAt: Type.String(),
  lateDeadlineAt: Type.String(),
  generatedBy: Type.String(),
  completedByAssessmentId: Type.Union([Type.String(), Type.Null()]),
});
const HopeAssessmentViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  rfaKind: Type.String(),
  status: Type.String(),
  targetDate: Type.String(),
  authorDiscipline: Type.String(),
  j2051MaxSeverity: Type.Union([Type.String(), Type.Null()]),
  j2051TriggerFired: Type.Boolean(),
  wasLate: Type.Boolean(),
  signedAt: Type.Union([Type.String(), Type.Null()]),
  signedBy: Type.Union([Type.String(), Type.Null()]),
  correctsAssessmentId: Type.Union([Type.String(), Type.Null()]),
  supersededByAssessmentId: Type.Union([Type.String(), Type.Null()]),
  snapshot: Type.Union([
    Type.Record(Type.String(), Type.Union([Type.Number(), Type.Null()])),
    Type.Null(),
  ]),
  version: Type.Integer(),
});
const HopeSfvViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  triggeringAssessmentId: Type.String(),
  status: Type.String(),
  triggeredAt: Type.String(),
  dueAt: Type.String(),
  completingAssessmentId: Type.Union([Type.String(), Type.Null()]),
});
const HopeSubmissionViewSchema = Type.Object({
  id: Type.String(),
  providerEntityId: Type.String(),
  submissionPeriod: Type.String(),
  status: Type.String(),
  itemCount: Type.Integer(),
  acceptedCount: Type.Integer(),
  rejectedCount: Type.Integer(),
  transmittedAt: Type.Union([Type.String(), Type.Null()]),
  acceptedAt: Type.Union([Type.String(), Type.Null()]),
});
const HopeComplianceViewSchema = Type.Object({
  providerEntityId: Type.Union([Type.String(), Type.Null()]),
  hopeOnTimeRate: Type.Number(),
  sfvOnTimeRate: Type.Number(),
  submissionAcceptanceRate: Type.Number(),
});
const HopeValidationResponseSchema = Type.Object({
  assessmentId: Type.String(),
  findings: Type.Array(
    Type.Object({ ruleId: Type.String(), severity: Type.String(), message: Type.String() }),
  ),
});
const HopeScheduleListResponseSchema = Type.Object({
  schedules: Type.Array(HopeScheduleViewSchema),
});
const HopeAssessmentListResponseSchema = Type.Object({
  assessments: Type.Array(HopeAssessmentViewSchema),
});
const HopeSfvListResponseSchema = Type.Object({ sfvs: Type.Array(HopeSfvViewSchema) });
const HopeSubmissionListResponseSchema = Type.Object({
  submissions: Type.Array(HopeSubmissionViewSchema),
});
const HopeScheduleListQuerySchema = Type.Object({
  patientId: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
  rfaKind: Type.Optional(Type.String()),
});
const HopeSfvWorklistQuerySchema = Type.Object({ state: Type.Optional(Type.String()) });
const HopeSubmissionListQuerySchema = Type.Object({
  providerEntityId: Type.Optional(Type.String()),
});
const HopeDashboardQuerySchema = Type.Object({ providerEntityId: Type.Optional(Type.String()) });

// ── M11 Orders read DTOs (Track B, M11-T08) ────────────────────────────────────────────────────────
// Mirror OrderRouteService's view projections (apps/backend/src/modules/11-orders/routes/service.ts —
// OrderView / StandingOrderView / VerbalPolicyView). The UI reads only the fields it renders; the server is
// authoritative for the §2.2 D2 lifecycle status, the §2.3 verbal deadline, and the transmission/results
// state. The write surfaces (draft modal, sign step-up, cosign, discontinue, standing-order admin) keep
// their route-level TypeBox request bodies (already in the contract); only the read responses are enriched.
const OrderViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  kind: Type.String(),
  status: Type.String(),
  priority: Type.String(),
  version: Type.Integer(),
  drafterMembershipId: Type.String(),
  drafterDiscipline: Type.String(),
  orderingPhysicianMdmId: Type.String(),
  cosignRequired: Type.Boolean(),
  cosignStatus: Type.Union([Type.Literal("pending"), Type.Literal("attached"), Type.Null()]),
  transmissionStatus: Type.String(),
  resultsStatus: Type.String(),
  verbalDeadlineAt: Type.Union([Type.String(), Type.Null()]),
  discontinuationReason: Type.Union([Type.String(), Type.Null()]),
  replacesOrderId: Type.Union([Type.String(), Type.Null()]),
  triggeringAssessmentId: Type.Union([Type.String(), Type.Null()]),
  triggeringHopeAssessmentId: Type.Union([Type.String(), Type.Null()]),
  signedAt: Type.Union([Type.String(), Type.Null()]),
  signedBy: Type.Union([Type.String(), Type.Null()]),
  completedAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
const StandingOrderViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  kind: Type.String(),
  cadence: Type.String(),
  status: Type.String(),
  nextSpawnAt: Type.Union([Type.String(), Type.Null()]),
  spawnCount: Type.Integer(),
  maxSpawns: Type.Union([Type.Integer(), Type.Null()]),
});
const VerbalPolicyViewSchema = Type.Object({
  windowHours: Type.Integer(),
  businessHoursOnly: Type.Boolean(),
  lpnCosignRequiredKinds: Type.Array(Type.String()),
  npCosignRequiredKinds: Type.Array(Type.String()),
  platformFloorWindowHours: Type.Integer(),
  policyVersion: Type.String(),
});
const OrderListResponseSchema = Type.Object({ orders: Type.Array(OrderViewSchema) });
const StandingOrderListResponseSchema = Type.Object({
  standingOrders: Type.Array(StandingOrderViewSchema),
});

// ── M12 DoseSpot prescribing read DTOs (Track B, M12-T09) ──────────────────────────────────────────
// Mirror MedicationOrderRouteService's view projections (apps/backend/src/modules/12-dosespot/routes/
// service.ts — MedicationOrderView / RefillRequestView / PrescriberRosterView / RefillInboxPolicyView /
// ControlledSubstancePolicyView). The UI reads only the fields it renders; the SERVER is authoritative for
// the §2.2 D2 medication-order lifecycle status, the §2.7 D9 refill state, the controlled-substance / EPCS
// posture, and every scope (RLS + ABAC). The write surfaces (the prescribe modal, the sign / sign-controlled
// step-up, verbal / cosign / discontinue / correct / refill-decide / roster / policy mutations) keep their
// route-level TypeBox request bodies (already in the contract); only the read responses are enriched.
const MedicationOrderViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  medClass: Type.String(),
  status: Type.String(),
  drugName: Type.String(),
  strength: Type.String(),
  doseForm: Type.String(),
  route: Type.String(),
  rxnormRxcui: Type.Union([Type.String(), Type.Null()]),
  ndc: Type.Union([Type.String(), Type.Null()]),
  version: Type.Integer(),
  prescriberMembershipId: Type.String(),
  prescriberDiscipline: Type.String(),
  prescribingPhysicianMdmId: Type.String(),
  dispensingPharmacyMdmId: Type.Union([Type.String(), Type.Null()]),
  isControlledSubstance: Type.Boolean(),
  deaSchedule: Type.Union([Type.String(), Type.Null()]),
  cosignRequired: Type.Boolean(),
  cosignStatus: Type.Union([Type.Literal("pending"), Type.Literal("attached"), Type.Null()]),
  refillsRemaining: Type.Integer(),
  derivedFromRefillId: Type.Union([Type.String(), Type.Null()]),
  replacesMedicationOrderId: Type.Union([Type.String(), Type.Null()]),
  signedAt: Type.Union([Type.String(), Type.Null()]),
  signedBy: Type.Union([Type.String(), Type.Null()]),
  transmittedAt: Type.Union([Type.String(), Type.Null()]),
  discontinuedAt: Type.Union([Type.String(), Type.Null()]),
  discontinuationReason: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
const RefillRequestViewSchema = Type.Object({
  id: Type.String(),
  patientId: Type.String(),
  sourceMedicationOrderId: Type.String(),
  status: Type.String(),
  requestedAt: Type.String(),
  prescriberMembershipId: Type.Union([Type.String(), Type.Null()]),
  resultingMedicationOrderId: Type.Union([Type.String(), Type.Null()]),
});
const PrescriberRosterViewSchema = Type.Object({
  membershipId: Type.String(),
  enrolled: Type.Boolean(),
  deaAuthorizedSchedules: Type.Array(Type.String()),
  ial2Status: Type.String(),
});
const RefillInboxPolicyViewSchema = Type.Object({
  slaWarnHours: Type.Integer(),
  slaCriticalHours: Type.Integer(),
  platformFloorWarnHours: Type.Integer(),
  platformFloorCriticalHours: Type.Integer(),
});
const ControlledSubstancePolicyViewSchema = Type.Object({
  scheduleIiMaxRefills: Type.Integer(),
  scheduleIiiToVMaxRefills: Type.Integer(),
  epcsCertificationStatus: Type.String(),
});
const MedicationOrderListResponseSchema = Type.Object({
  orders: Type.Array(MedicationOrderViewSchema),
});
const MedicationOrderListQuerySchema = Type.Object({
  patientId: Type.Optional(Type.String()),
  prescriberId: Type.Optional(Type.String()),
  medClass: Type.Optional(Type.String()),
  status: Type.Optional(Type.String()),
});
const MedicationHistoryListResponseSchema = Type.Object({
  records: Type.Array(
    Type.Object({ id: Type.String(), drugName: Type.String(), source: Type.String() }),
  ),
});
const RefillListResponseSchema = Type.Object({ refills: Type.Array(RefillRequestViewSchema) });
const PrescriberRosterListResponseSchema = Type.Object({
  prescribers: Type.Array(PrescriberRosterViewSchema),
});
const TransmissionStatusResponseSchema = Type.Object({
  orderId: Type.String(),
  status: Type.String(),
  retryHistory: Type.Array(
    Type.Object({
      attempt: Type.Integer(),
      at: Type.String(),
      errorClass: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});

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
    summary:
      "Patient assessment timeline — every captured scale, newest first; §7.6 SUD-redacted per caller (§5.2)",
    response: AssessmentListResponseSchema,
  },
  "GET /api/v1/patients/:patientId/assessments/summary": {
    summary:
      "Assessment summary — latest value per scale family across all scales; SUD-redacted per caller (§5.2)",
    response: AssessmentSummaryResponseSchema,
  },
  "GET /api/v1/patients/:patientId/scales/:scaleType/series": {
    summary:
      "Per-scale scored series over a [from,to] window with significant-change markers (§5.2)",
    query: ScaleSeriesQuerySchema,
    response: ScaleSeriesResponseSchema,
  },
  "GET /api/v1/patients/:patientId/significant-changes": {
    summary:
      "Per-patient significant-change worklist — open/escalated changes with ack state (§5.2)",
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
  // M10 HOPE Engine (Track B — Timepoint Dashboard / Patient Timeline / SFV Worklist / Assessment Detail /
  // Submission Worklist + Detail / HQRP Compliance Dashboard, M10-T08). Read responses only; the recording
  // modal, sign/correct, skip, retry, assemble, and admin-regenerate write routes keep their route-level
  // TypeBox request bodies (already in the contract). The server is authoritative for J2051/late/snapshot.
  "GET /api/v1/hope/schedules": {
    summary: "HOPE timepoint dashboard — open/closing/late/expired schedules (§5.1/§5.2)",
    query: HopeScheduleListQuerySchema,
    response: HopeScheduleListResponseSchema,
  },
  "GET /api/v1/hope/schedules/:id": {
    summary: "HOPE schedule detail with derived window state (§5.2)",
    response: HopeScheduleViewSchema,
  },
  "GET /api/v1/patients/:patientId/hope/assessments": {
    summary: "Patient HOPE timeline — Admission → HUV1 → HUV2 → SFV(s) → Discharge (§5.1/§5.2)",
    response: HopeAssessmentListResponseSchema,
  },
  "GET /api/v1/hope/assessments/:id": {
    summary: "HOPE assessment detail — snapshot, J2051 trigger outcome, submission status (§5.2)",
    response: HopeAssessmentViewSchema,
  },
  "GET /api/v1/hope/assessments/:id/validation": {
    summary: "On-demand pre-submission validation findings for one HOPE assessment (§5.2)",
    response: HopeValidationResponseSchema,
  },
  "GET /api/v1/hope/sfv": {
    summary:
      "SFV worklist — open/overdue/missed symptom-follow-up visits across the org (§5.1/§5.2)",
    query: HopeSfvWorklistQuerySchema,
    response: HopeSfvListResponseSchema,
  },
  "GET /api/v1/hope/sfv/:id": {
    summary: "SFV detail — triggering symptoms + 2-calendar-day countdown (§5.2)",
    response: HopeSfvViewSchema,
  },
  "GET /api/v1/hope/submissions": {
    summary: "HOPE submission worklist — batches per ProviderEntity, per-period (§5.1/§5.2)",
    query: HopeSubmissionListQuerySchema,
    response: HopeSubmissionListResponseSchema,
  },
  "GET /api/v1/hope/submissions/:id": {
    summary: "HOPE submission detail — per-item outcomes, rejection findings, retry control (§5.2)",
    response: HopeSubmissionViewSchema,
  },
  "GET /api/v1/hope/dashboard/compliance": {
    summary:
      "HQRP compliance dashboard — on-time / SFV on-time / submission acceptance rates (§5.2)",
    query: HopeDashboardQuerySchema,
    response: HopeComplianceViewSchema,
  },
  // M11 Orders (Track B — Patient Orders / Signature Inbox / Verbal-Expiring / Cosign / Results-Review /
  // Standing-Order admin, M11-T08). Read responses only; the write routes keep their route-level TypeBox
  // request bodies (already in the contract). The server is authoritative for the §2.2 D2 lifecycle.
  "GET /api/v1/orders": {
    summary: "List orders by patient / admission / kind / status (§4.1; ABAC caseload_or_scope)",
    query: OrderListQuerySchema,
    response: OrderListResponseSchema,
  },
  "GET /api/v1/orders/:id": {
    summary:
      "Order detail — lifecycle status, signatures, verbal deadline, transmission/results state (§4.1)",
    response: OrderViewSchema,
  },
  "GET /api/v1/orders/pending-signature": {
    summary: "Physician pending-signature inbox — orders in pending_signature (§4.1 / §5.2)",
    response: OrderListResponseSchema,
  },
  "GET /api/v1/orders/verbal-expiring": {
    summary:
      "RN verbal-expiring queue — verbal_pending orders with a live 48h countdown (§4.1 / §5.2 D3)",
    response: OrderListResponseSchema,
  },
  "GET /api/v1/orders/cosign-pending": {
    summary:
      "RN cosign-pending queue — orders awaiting an RN/supervisor cosignature (§4.1 / §5.2 §2.5)",
    response: OrderListResponseSchema,
  },
  "GET /api/v1/orders/results-pending-review": {
    summary: "Lab orders with results received awaiting clinician Mark-reviewed (§4.1 / §5.2 D17)",
    response: OrderListResponseSchema,
  },
  "GET /api/v1/standing-orders": {
    summary: "Standing-order templates — cadence, next-spawn, spawn count (§4.1 / §5.2 D5)",
    response: StandingOrderListResponseSchema,
  },
  "GET /api/v1/standing-orders/:id": {
    summary: "Standing-order template detail + spawn history (§4.1 / §5.2 D5)",
    response: StandingOrderViewSchema,
  },
  "GET /api/v1/admin/orders/verbal-policy": {
    summary:
      "Org verbal-order policy — window hours, cosign kinds, platform floor (§4.1 / §2.3 D3)",
    response: VerbalPolicyViewSchema,
  },
  // M12 DoseSpot prescribing (Track B — Patient Medications / Medication Detail / Sign Inbox / Verbal-Orders
  // Queue / Refill Inbox + Detail / Medication Reconciliation / Prescriber Roster / Prescribing Policy,
  // M12-T09). Read responses only; the write routes keep their route-level TypeBox request bodies (already in
  // the contract). The server is authoritative for the §2.2 D2 lifecycle, the §2.7 D9 refill state, and the
  // controlled-substance / EPCS posture (`dosespot.epcs` OFF in Phase 1).
  "GET /api/v1/medication-orders": {
    summary:
      "List medication orders by patient / prescriber / med-class / status (§4.1; ABAC caseload_or_scope)",
    query: MedicationOrderListQuerySchema,
    response: MedicationOrderListResponseSchema,
  },
  "GET /api/v1/medication-orders/:id": {
    summary:
      "Medication-order detail — lifecycle status, signatures, controlled/EPCS posture, refills (§4.1)",
    response: MedicationOrderViewSchema,
  },
  "GET /api/v1/medication-orders/:id/transmission": {
    summary: "DoseSpot transmission status incl. retry history (§4.1 / §2.6)",
    response: TransmissionStatusResponseSchema,
  },
  "GET /api/v1/patients/:patientId/medications/active": {
    summary: "Active medications for a patient (chart medication list; §4.1 / §6.1)",
    response: MedicationOrderListResponseSchema,
  },
  "GET /api/v1/patients/:patientId/medications/history": {
    summary:
      "Medication-history records for a patient (DoseSpot MedHx; §4.1 / §6.1 reconciliation)",
    response: MedicationHistoryListResponseSchema,
  },
  "GET /api/v1/refills": {
    summary: "Refill inbox — pending refills the caller may decide (§4.1; ABAC refill_inbox_scope)",
    response: RefillListResponseSchema,
  },
  "GET /api/v1/refills/:id": {
    summary:
      "Refill detail — source order + request fields for approve/deny (§4.1; ABAC refill_inbox_scope)",
    response: RefillRequestViewSchema,
  },
  "GET /api/v1/admin/dosespot-prescribers": {
    summary:
      "Per-tenant DoseSpot prescriber roster — DEA schedules, IAL2 status, enrollment (§4.1 / §6.1)",
    response: PrescriberRosterListResponseSchema,
  },
  "GET /api/v1/admin/refill-inbox-policy": {
    summary: "Refill-inbox SLA policy — warn/critical hours + platform floors (§4.1 / §2.7 D9)",
    response: RefillInboxPolicyViewSchema,
  },
  "GET /api/v1/admin/controlled-substance-policy": {
    summary:
      "Controlled-substance policy — refill caps + EPCS certification status (§4.1 / 21 CFR 1306.22 / D18)",
    response: ControlledSubstancePolicyViewSchema,
  },
  // M13 eMAR administration (Track B — Patient eMAR / Administration Detail / IV Continuous Session /
  // Missed-Dose Inbox / Reconciliation Worksheet / Comfort Kit View / Administration Policy, M13-T10). Read
  // responses only; the record / witness-attest / caregiver-cosign / reconcile-decide / comfort-kit / policy
  // write routes keep their route-level TypeBox request bodies (already in the contract). The server is
  // authoritative for the §2.2 lifecycle, the §2.5 late-entry tier, the §2.9 BCMA match result, and the §7.2
  // SUD read gate (SUD-flagged rows skipped without a Part 2 release).
  "GET /api/v1/administrations": {
    summary:
      "List a patient's administrations — eMAR projection + caregiver-attested cosign rows (§4.1 / §6.1)",
    query: EmarAdministrationListQuerySchema,
    response: AdministrationListResponseSchema,
  },
  "GET /api/v1/administrations/:id": {
    summary:
      "Administration detail — lifecycle, late-entry tier, witness pair, BCMA match (§4.1 / §6.1 #11)",
    response: AdministrationViewSchema,
  },
  "GET /api/v1/administrations/iv-sessions/:sessionId": {
    summary:
      "IV continuous session — the ordered start→rate_change→stop segment sequence (§4.1 / §6.1 #5)",
    response: IvSessionViewSchema,
  },
  "GET /api/v1/scheduled-doses": {
    summary: "Scheduled-dose timeline for a patient (the eMAR next-24h projection; §4.1 / §6.1 #1)",
    query: EmarScheduledDoseQuerySchema,
    response: ScheduledDoseListResponseSchema,
  },
  "GET /api/v1/missed-doses": {
    summary: "Missed-dose inbox — unacknowledged misses for a patient (§4.1 / §6.1 #8)",
    query: EmarMissedDoseQuerySchema,
    response: MissedDoseListResponseSchema,
  },
  "GET /api/v1/reconciliation/worksheets": {
    summary:
      "Reconciliation worksheets for a patient (admission/transfer/discharge/recert; §4.1 / §6.1 #6)",
    query: EmarWorksheetQuerySchema,
    response: WorksheetListResponseSchema,
  },
  "GET /api/v1/reconciliation/worksheets/:id": {
    summary:
      "Reconciliation worksheet — per-line sources + decisions + finalize readiness (§4.1 / §6.1 #6)",
    response: WorksheetViewSchema,
  },
  "GET /api/v1/comfort-kits/deployments": {
    summary: "Comfort-kit deployments for a patient (drawdown + disposal status; §4.1 / §6.1 #7)",
    query: EmarDeploymentQuerySchema,
    response: DeploymentListResponseSchema,
  },
  "GET /api/v1/comfort-kits/deployments/:id": {
    summary:
      "Comfort-kit deployment detail — remaining quantity + replenishment + disposal (§4.1 / §6.1 #7)",
    response: DeploymentViewSchema,
  },
  "GET /api/v1/admin/administration-policy": {
    summary:
      "Tenant administration policy — grace window, PRN reassessment defaults (§4.1 / §6.1 #12)",
    response: AdministrationPolicyViewSchema,
  },
  // M22 Document Management (Track B — DOC.Explorer / DOC.VersionHistory / INTAKE.BatchDetail /
  // FORM.TemplateLibrary, M22-T10). Read responses only; the upload / tag / export / intake-review /
  // classify / publish write routes keep their route-level TypeBox request bodies (already in the
  // contract). The SERVER is authoritative for §4.6 RBAC + §4.7 ABAC, legal-hold blocks (§8.6), the
  // §4.12 signed-URL TTL floor, and SUD redaction — the screens never decide authorization.
  "GET /api/v1/documents": {
    summary:
      "List documents — filtered by patient / aggregate / retention class, cursor-paginated (§4.1 / §5.1 DOC.Explorer)",
    query: M22DocumentListQuerySchema,
    response: M22DocumentListResponseSchema,
  },
  "GET /api/v1/documents/:id": {
    summary:
      "Document metadata + current version metadata (§4.1 / §5.1 DOC.SignedUrlPreview header)",
    response: M22DocumentViewSchema,
  },
  "GET /api/v1/documents/:id/versions": {
    summary:
      "Version history — author/version chain for the side-by-side diff (§4.1 / §5.1 DOC.VersionHistory)",
    query: M22VersionListQuerySchema,
    response: M22VersionListResponseSchema,
  },
  "GET /api/v1/intake/uploads/:id": {
    summary:
      "Intake batch — pipeline status + page count for the DocLens review queue (§4.1 / §5.1 INTAKE.BatchDetail)",
    response: M22IntakeBatchViewSchema,
  },
  "GET /api/v1/intake/uploads/:id/jobs": {
    summary:
      "Extraction jobs for a batch — per-job pipeline status, cursor-paginated (§4.1 / §5.1 INTAKE.BatchDetail)",
    response: M22IntakeJobListResponseSchema,
  },
  "GET /api/v1/form-templates": {
    summary:
      "Browse the platform-floor form templates with version metadata (§4.1 / §5.1 FORM.TemplateLibrary)",
    query: M22TemplateListQuerySchema,
    response: M22FormTemplateListResponseSchema,
  },
  // ── M23 Billing — Medicare (§4.1 route surface) ──────────────────────────────────────────────────────
  // Request bodies (POST/PATCH) + filter queries (list/read GETs) reuse the SAME TypeBox validators the
  // handlers `parse(...)` against (billing-typebox + the @wardenx/billing route-contract schemas). Responses
  // are attached ONLY where a real exported TypeBox response schema matches the handler return — the assemble
  // route (ClaimAssembleResponse) and the two internal seam reads (Claim-day projection / accepted
  // submissions). The other handlers return TS view interfaces (ClaimDetailView / *AcceptedView / *View), not
  // TypeBox, so their responses are omitted (no fabrication). Org/actor/membership binding is server-side, so
  // no body/query carries an org or membership id.
  //
  // ── claims core (claims.routes.ts, §4.1 #1–#13) ──
  "POST /api/v1/billing/claims/assemble": {
    summary: "Assemble a server-authoritative DRAFT claim (lines + HIPPS + SIA + initial validation run, §4.1 #1)",
    body: ClaimAssembleRequest,
    response: ClaimAssembleResponse,
  },
  "GET /api/v1/billing/claims": {
    summary: "List claims — cursor-paginated; filter by state / patient / ProviderEntity (§4.1 #2)",
    query: ClaimListQuerySchema,
  },
  "GET /api/v1/billing/claims/:id": {
    summary: "Single-claim detail — lines + HIPPS + SIA + latest run + submissions + acks (§4.1 #3)",
  },
  "PATCH /api/v1/billing/claims/:id": {
    summary: "DRAFT re-assembly edit — replace line set + totals; If-Match version; coder ICD-only scope (§4.1 #4)",
    body: ClaimPatchDraftBodySchema,
  },
  "DELETE /api/v1/billing/claims/:id": {
    summary: "Delete a DRAFT claim (DRAFT-only; AI-block + idempotency, §4.1 #5)",
  },
  "POST /api/v1/billing/claims/:id/validate": {
    summary: "Trigger a validation_run for a claim (the manual re-run / initial trigger; 202, §4.1 #6)",
    body: ManualValidateRequest,
  },
  "POST /api/v1/billing/claims/:id/submit": {
    summary: "READY → SUBMITTED — emits m23.claim.submit_requested (PE scope + step-up + If-Match; 202, §4.1 #7)",
  },
  "POST /api/v1/billing/claims/:id/replace": {
    summary: "Build a TOB-817 replacement DRAFT (copies the original's lines; step-up + If-Match; 201, §4.1 #8)",
    body: ClaimReplaceRequest,
  },
  "POST /api/v1/billing/claims/:id/void": {
    summary: "Build a TOB-818 void DRAFT (no service lines; step-up + If-Match; 201, §4.1 #9)",
    body: ClaimVoidRequest,
  },
  "GET /api/v1/billing/claims/:id/lines": {
    summary: "The claim_line projection for a claim (§4.1 #10)",
  },
  "GET /api/v1/billing/claims/:id/state-history": {
    summary: "Per-claim transition timeline (cursor-paginated, §4.1 #11)",
  },
  "GET /api/v1/billing/claims/:id/submissions": {
    summary: "All dispatch attempts for a claim (§4.1 #12)",
  },
  "GET /api/v1/billing/claims/:id/acknowledgments": {
    summary: "All 999 / 277CA / 835 acknowledgments for a claim (§4.1 #13)",
  },
  // ── validation + override (validation.routes.ts) — paths are /api/v1/claims/... (no /billing prefix) ──
  "GET /api/v1/claims/:id/validation-runs": {
    summary: "List a claim's validation runs, most recent first (§4.1 #14)",
  },
  "GET /api/v1/claims/:id/validation-runs/:runId": {
    summary: "Single validation run — per-rule results + override status (§4.1 #15)",
  },
  "POST /api/v1/claims/:id/validate": {
    summary: "Trigger a manual_re_run validation; state → validating (202, §4.1 #6)",
  },
  "POST /api/v1/claims/:id/validation-runs/:runId/results/:resultId/override": {
    summary: "Override a failed validation result — approver-role ABAC + step-up (201, §4.1 #16)",
    body: OverrideValidationResultBodySchema,
  },
  // ── rule-config overlay (rule-config.routes.ts) ──
  "GET /api/v1/billing/rule-configs": {
    summary: "List validation-rule overlay rows — platform snapshot + tenant overlays (cursor-paginated, §4.1 #18)",
    query: RuleConfigListQuerySchema,
  },
  "GET /api/v1/billing/rule-configs/:id": {
    summary: "Read a single validation-rule overlay row (§4.1)",
  },
  "POST /api/v1/billing/rule-configs/custom": {
    summary: "Create a tenant CUSTOM validation rule (regulatory-required forbidden; 201, §4.1 #20)",
    body: CreateRuleConfigBodySchema,
  },
  "PATCH /api/v1/billing/rule-configs/:id": {
    summary: "Overlay edit — disable / re-severity / re-parameterize a rule (If-Match, §4.1 #19)",
    body: UpdateRuleConfigBodySchema,
  },
  "DELETE /api/v1/billing/rule-configs/:id": {
    summary: "Revert a rule overlay to the platform default (If-Match, §4.1 #21)",
  },
  // ── NOE fast path (noe.routes.ts) ──
  "GET /api/v1/noe-records": {
    summary: "List NOE records — timely-filing worklist, cursor-paginated (§4.1 #24)",
    query: NoeListQuerySchema,
  },
  "GET /api/v1/noe-records/:id": {
    summary: "NOE detail (§4.1 #25)",
  },
  "POST /api/v1/noe-records/:id/submit": {
    summary: "READY → SUBMITTED — emits m23.noe.submit_requested (step-up; 202, §4.1 #26)",
  },
  "POST /api/v1/noe-records/:id/cancel": {
    summary: "Cancel a DRAFT/READY NOE — election-reversed guard fact (§4.1 #27)",
    body: CancelNoeBodySchema,
  },
  // ── NOTR fast path (notr.routes.ts) ──
  "GET /api/v1/notr-records": {
    summary: "List NOTR records — timely-filing worklist, cursor-paginated (§4.1 #28)",
    query: NotrListQuerySchema,
  },
  "GET /api/v1/notr-records/:id": {
    summary: "NOTR detail (§4.1 #29)",
  },
  "POST /api/v1/notr-records/:id/submit": {
    summary: "READY → SUBMITTED — emits m23.notr.submit_requested (step-up; 202, §4.1 #30)",
  },
  "POST /api/v1/notr-records/:id/cancel": {
    summary: "Cancel a DRAFT/READY NOTR — terminating-event-reversed guard fact (§4.1 #31)",
    body: CancelNotrBodySchema,
  },
  // ── eligibility (eligibility.routes.ts) ──
  "POST /api/v1/billing/eligibility/check": {
    summary: "Force / refresh-on-stale a 270/271 eligibility round-trip (202; no MBI on the wire, §4.1 #22)",
    body: CheckEligibilityBodySchema,
  },
  "GET /api/v1/billing/eligibility": {
    summary: "Per-patient eligibility-check history (§4.1 #23)",
    query: BillingPatientQuerySchema,
  },
  "GET /api/v1/billing/eligibility/latest": {
    summary: "The latest eligibility check for a patient (auto-refresh-on-stale read, §4.1)",
    query: BillingPatientQuerySchema,
  },
  // ── sequestration policy (sequestration-policy.routes.ts) ──
  "GET /api/v1/billing/sequestration-policies": {
    summary: "Per-ProviderEntity sequestration-percentage timeline — effective-dated rows (D11, §4.1 #32)",
    query: RequiredProviderEntityQuerySchema,
  },
  "GET /api/v1/billing/sequestration-policies/active": {
    summary: "The active-on-now sequestration policy for a ProviderEntity (or null, §4.1)",
    query: RequiredProviderEntityQuerySchema,
  },
  "POST /api/v1/billing/sequestration-policies": {
    summary: "Forward-date a new sequestration policy row (percentage is a decimal string; 201, §4.1 #33)",
    body: ForwardDateSequestrationBodySchema,
  },
  // ── MAC credentials (mac-credentials.routes.ts, §3.6) ──
  "GET /api/v1/billing/mac-credentials": {
    summary: "List per-ProviderEntity MAC credentials — secrets masked, cursor-paginated (§4.1 #34)",
    query: MacCredentialListQuerySchema,
  },
  "GET /api/v1/billing/mac-credentials/:providerEntityId": {
    summary: "The MAC credential for one ProviderEntity, or null (§4.1)",
  },
  "POST /api/v1/billing/mac-credentials": {
    summary: "Upsert a MAC credential — clientSecret write-only/encrypted at the boundary; step-up (§4.1 #35)",
    body: UpsertMacCredentialBodySchema,
  },
  // ── AR dashboard + metrics (metrics.routes.ts) ──
  "GET /api/v1/billing/ar-dashboard": {
    summary: "AR-aging dashboard — aging buckets + denial / NOE-NOTR window-breach rates (org-wide or per-PE, §4.1 #37)",
    query: BillingMetricsQuerySchema,
  },
  "GET /api/v1/billing/metrics": {
    summary: "Per-window claim metric buckets (the M33 reporting consumer; org-wide or per-PE, §4.1 #38)",
    query: BillingMetricsQuerySchema,
  },
  // ── internal service-to-service seams (internal.routes.ts; system-principal only) ──
  "GET /api/v1/internal/billing/claim-day-projection": {
    summary: "Per-patient / org day rollups by level-of-care (M26 cap + M27 cost-report consumers, §4.1 #39)",
    query: ClaimDayProjectionQuery,
    response: ClaimDayProjectionResponse,
  },
  "GET /api/v1/internal/billing/submissions": {
    summary: "Accepted submissions in a window (M25 remittance 835→claim matching, §4.1 #40)",
    query: AcceptedSubmissionsQuery,
    response: AcceptedSubmissionsResponse,
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
  "GET /api/v1/patients/census-metrics": {
    summary: "Census KPI metrics — active count + per-status breakdown (§4.2)",
    response: CensusMetricsResponseSchema,
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
  // M14 IDG (Track B — read surfaces the §5 screens consume; M14-T07). Reads only — the lifecycle / decision /
  // attendance / agenda / action-item / amendment write surfaces fill in as those write paths harden.
  "GET /api/v1/idg/schedule": {
    summary:
      "Meeting schedule for a location/range — next-weeks meetings, location-scoped (§4.1 / §5)",
    query: IdgScheduleQuerySchema,
    response: IdgScheduleListResponseSchema,
  },
  "GET /api/v1/idg/meetings/:id": {
    summary: "One meeting's lifecycle view — status + scheduled window + adjournment (§4.1 / §5)",
    response: IdgMeetingViewSchema,
  },
  "GET /api/v1/idg/meetings/:id/packets": {
    summary: "Per-patient packet digests for a meeting — readiness + freeze state (§4.1 / §5)",
    response: IdgPacketListResponseSchema,
  },
  "GET /api/v1/idg/meetings/:meetingId/packets/:patientId": {
    summary:
      "One patient's packet digest in a meeting — chart-embed read (§4.1 / §5; SUD-redacted server-side)",
    response: IdgPacketDigestViewSchema,
  },
  "GET /api/v1/idg/action-items": {
    summary: "The caller's action items — open / in-progress queue (§4.1 / §5 'My Action Items')",
    query: IdgActionItemListQuerySchema,
    response: IdgActionItemListResponseSchema,
  },
  "GET /api/v1/idg/meetings/:id/minutes": {
    summary: "A meeting's minutes — in-progress or finalized (§4.1 / §5)",
    response: IdgMinutesViewSchema,
  },
  // M17 Scheduling (Track B — the §5.1 read surfaces the day/week/map/proposals/recurring/time-off/availability/
  // metrics screens consume; M17-T08). Reads only — the create/publish/edit/reschedule/cancel/reassign/approve
  // write routes keep their route-level TypeBox request bodies (already in the contract).
  "GET /api/v1/visits": {
    summary:
      "Visits in caseload/scope — clinician/patient/status/date-window filtered (§4.1 / §5.1)",
    query: SchedVisitListQuerySchema,
    response: SchedVisitListResponseSchema,
  },
  "GET /api/v1/visits/:visitId": {
    summary:
      "One visit's detail — status + scheduled window + assignment (§4.1 / §5.1 visit detail)",
    response: SchedVisitViewSchema,
  },
  "GET /api/v1/visit-proposals": {
    summary:
      "The scheduler proposal inbox — pending frequency/order/IDG/supervisory proposals (§5.1)",
    query: SchedProposalListQuerySchema,
    response: SchedProposalListResponseSchema,
  },
  "GET /api/v1/recurring-visits": {
    summary: "A patient's recurring-visit policies — active/discontinued (§5.1 recurring)",
    query: SchedRecurringListQuerySchema,
    response: SchedRecurringListResponseSchema,
  },
  "GET /api/v1/availability": {
    summary: "A membership's weekly availability pattern (§5.1 availability editor)",
    query: SchedAvailabilityQuerySchema,
    response: SchedAvailabilityViewSchema,
  },
  "GET /api/v1/time-off": {
    summary: "Time-off requests — approval queue / my-PTO, membership/state/date filtered (§5.1)",
    query: SchedTimeOffListQuerySchema,
    response: SchedTimeOffListResponseSchema,
  },
  "GET /api/v1/day-view": {
    summary: "Day-view grid — a clinician's visits for one service date (§5.1 day)",
    query: SchedDayViewQuerySchema,
    response: SchedDayViewResponseSchema,
  },
  "GET /api/v1/week-view": {
    summary: "Week-view grid — a clinician's visits across a week (§5.1 week)",
    query: SchedWeekViewQuerySchema,
    response: SchedWeekViewResponseSchema,
  },
  "GET /api/v1/map-view": {
    summary: "Map-view ordered stops for a clinician day (coords-only polylines, D9; §5.1 map)",
    query: SchedMapViewQuerySchema,
    response: SchedMapViewResponseSchema,
  },
  "GET /api/v1/metrics/visits": {
    summary:
      "Org-wide visit metrics — on-time / no-show / reschedule rates (§5.1 scheduling-metrics)",
    query: SchedMetricsQuerySchema,
    response: SchedVisitMetricsResponseSchema,
  },
  "GET /api/v1/metrics/route-efficiency": {
    summary: "Per-clinician route-efficiency metrics — proposed miles + override rate (§5.1)",
    query: SchedRouteEfficiencyQuerySchema,
    response: SchedRouteEfficiencyResponseSchema,
  },

  // ── M18 EVV read surfaces (§5.1, Track B / M18-T07) ───────────────────────────────────────────────────
  "GET /api/v1/evv/events": {
    summary: "EVV event ledger — coordinate-free capture events, filterable (§5.1 events)",
    query: EvvEventListQuery,
    response: EvvEventListResponse,
  },
  "GET /api/v1/evv/events/:eventId": {
    summary:
      "EVV single-event detail — raw + computed fields, coordinates redacted unless evv.read_coords (§5.1 event)",
    query: EvvEventGetQuery,
    response: EvvEventView,
  },
  "GET /api/v1/evv/devices": {
    summary:
      "EVV devices — self or team list with approval/integrity status (§5.1 devices/pending, me/evv/devices)",
    query: EvvMembershipIdQuery,
    response: EvvDeviceListResponse,
  },
  "GET /api/v1/evv/geofence-policy": {
    summary:
      "EVV geofence policy — tenant tighten-only default + per-address overrides (§5.1 geofence-policy)",
    response: EvvGeofencePolicyView,
  },
  "GET /api/v1/evv/missing-resolutions": {
    summary:
      "EVV missing-resolution queue — open + recently-closed late-checkout resolutions (§5.1 missing-resolutions)",
    query: EvvMissingResolutionListQuery,
    response: EvvMissingResolutionListResponse,
  },
  "GET /api/v1/evv/aggregator-submissions": {
    summary:
      "EVV aggregator submission queue — per-state submission status + rejection detail (§5.1 aggregator-submissions)",
    query: EvvAggregatorListQuery,
    response: EvvAggregatorSubmissionListResponse,
  },
  "GET /api/v1/evv/metrics": {
    summary:
      "EVV metrics — compliance / late-checkout / geofence-deviation / GPS-spoof / aggregator-acceptance rates (§5.1 dashboard, metrics)",
    query: EvvMetricsQuery,
    response: EvvMetricsView,
  },

  // M33 Reporting & Dashboards (Track B — Reporting Catalog / Admin / Schedules / Dashboards, M33-T*).
  // Typing the read queries + the drilldown body the screens call removes the `as never` client casts.
  "GET /api/v1/reporting/dashboards": {
    summary: "Reporting dashboard catalog (cursor-paginated)",
    query: DashboardListQuerySchema,
  },
  "GET /api/v1/reporting/admin/mvs": {
    summary: "Materialized-view admin registry (cursor-paginated)",
    query: MvListQuerySchema,
  },
  "GET /api/v1/reporting/schedules": {
    summary: "Report schedules — optional status filter (§4.1)",
    query: ScheduleListQuery,
  },
  "POST /api/v1/reporting/drilldown/emit": {
    summary: "Resolve a tile's drilldown URL template + dimension context into a signed drilldown",
    body: DrilldownEmitRequest,
  },

  // M34 SaaS Tenant Platform (Track B — Tenant Inventory / BAA Register / Feature Flags / Onboarding /
  // Support Grants / Tenant + DSAR Export queues). Typing the read queries + write bodies the admin
  // screens call removes the `as never` client casts.
  "GET /api/v1/platform/tenants": {
    summary: "Platform tenant inventory — status/search filters (§4.1)",
    query: TenantListQuerySchema,
  },
  "GET /api/v1/platform/baa-register": {
    summary: "Platform BAA register — optional tenant filter (§4.1)",
    query: BaaRegisterListQuerySchema,
  },
  "GET /api/v1/platform/feature-flags": {
    summary: "Platform feature-flag registry — optional org filter (§4.1)",
    query: FeatureFlagListQuerySchema,
  },
  "POST /api/v1/platform/feature-flags/:flagKey/kill-switch": {
    summary: "Toggle a feature flag's kill switch (org-scoped or platform-wide)",
    body: KillSwitchRequest,
  },
  "GET /api/v1/platform/onboarding-templates": {
    summary: "Platform onboarding-template catalog (cursor-paginated)",
    query: OnboardingTemplateListQuerySchema,
  },
  "POST /api/v1/platform/onboarding-templates": {
    summary: "Create or update a platform onboarding template",
    body: UpsertOnboardingTemplateRequest,
  },
  "GET /api/v1/tenant/tenant-export-jobs": {
    summary: "Tenant data-export job queue (cursor-paginated)",
    query: TenantExportListQuerySchema,
  },
  "GET /api/v1/tenant/dsar-export-jobs": {
    summary: "Tenant DSAR export job queue (cursor-paginated)",
    query: DsarListQuerySchema,
  },
  "POST /api/v1/tenant/support-consent-grants": {
    summary:
      "Issue a tenant-scoped support-access consent grant (§6/D10 step-up enforced server-side)",
    body: SupportConsentGrantRequest,
  },
};
