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
import {
  AdjustmentOverrideRequestSchema,
  AppealAttachRequestSchema,
  AppealCreateRequestSchema,
  AppealDecideRequestSchema,
  AppealSubmitRequestSchema,
  AppealSummaryPageSchema,
  AppealWithdrawRequestSchema,
  DenialAssignRequestSchema,
  DenialCloseWriteOffRequestSchema,
  DenialEscalateRequestSchema,
  DenialReopenRequestSchema,
  DenialResolveRequestSchema,
  DenialWorklistPageSchema,
  M25ListQuerySchema,
  ManualMatchRequestSchema,
  RemittanceAdviceSummaryPageSchema,
  RemittanceLineSummaryPageSchema,
  TaxonomyOverlayPatchSchema,
} from "../../apps/backend/src/modules/25-remittance/routes/m25-typebox";
import {
  AddDpoaAgentBodySchema,
  AddRecipientBodySchema,
  ConsentDpoaAgentListResponseSchema,
  ConsentListResponseSchema,
  ConsentRecipientListResponseSchema,
  ExpiringConsentsResponseSchema,
  BereavementOutreachBodySchema,
  ConsentEvalAuditQuerySchema,
  CreateDraftBodySchema as ConsentCreateDraftBodySchema,
  EvalAuditQuerySchema as ConsentEvalAuditByPatientQuerySchema,
  RevokeBodySchema as ConsentRevokeBodySchema,
  ExpiringConsentsQuerySchema,
  RemoveRecipientBodySchema,
  RenewBodySchema,
  SupersedeBodySchema,
  UpdateDpoaAgentBodySchema,
  UpdateDraftBodySchema,
  UpsertOverlayBodySchema,
} from "../../apps/backend/src/modules/39-consent/routes/consent-typebox";
import {
  AssignRoleBody,
  CreateEngagementBody,
  CreateRoleBody,
  EnrollAuditorBody,
  InvokeBreakGlassBody,
  UpdateEngagementBody,
  UpdateRoleBody,
} from "../../apps/backend/src/modules/03-authorization/routes/authz-typebox";
import {
  AbuseAllegationListQuerySchema,
  AddInvestigationNoteBodySchema,
  AddQapiPipBodySchema,
  AddSraFindingBodySchema,
  AdoptQapiProgramBodySchema,
  BindCahpsVendorBodySchema,
  CahpsDecedentListQuerySchema,
  CahpsDecedentListResponseSchema,
  CahpsExportJobResponseSchema,
  CahpsResultListQuerySchema,
  CahpsResultListResponseSchema,
  CahpsVendorResponseSchema,
  CharterQapiProjectBodySchema,
  CloseQapiPipBodySchema,
  CloseSraCycleBodySchema,
  CompleteMortalityReviewBodySchema,
  CopCitationListQuerySchema,
  CopCitationListResponseSchema,
  CreateCahpsExportBodySchema,
  CreateIncidentBodySchema,
  CreateQapiIndicatorBodySchema,
  EnqueueRecomputeBodySchema,
  ExcludeCahpsDecedentBodySchema,
  IncidentListQuerySchema,
  IncidentDetailResponseSchema,
  IncidentListResponseSchema,
  InfectionEventListQuerySchema,
  InfectionEventListResponseSchema,
  InfectionOutbreakListQuerySchema,
  InfectionOutbreakListResponseSchema,
  IngestCahpsResultsBodySchema,
  MeasureListQuerySchema,
  MeasureListResponseSchema,
  MeasureValueSeriesResponseSchema,
  MeasureValueSnapshotResponseSchema,
  MeasureValuesQuerySchema,
  MortalityListQuerySchema,
  MortalityListResponseSchema,
  MortalityReviewDetailResponseSchema,
  OpenInvestigationBodySchema,
  OpenSraCycleBodySchema,
  PlanSraRemediationBodySchema,
  QapiGovernanceListQuerySchema,
  QapiGovernanceListResponseSchema,
  QapiIndicatorListQuerySchema,
  QapiIndicatorListResponseSchema,
  QapiPipListQuerySchema,
  QapiPipListResponseSchema,
  QapiProgramListQuerySchema,
  QapiProgramListResponseSchema,
  QapiProjectListQuerySchema,
  QapiProjectListResponseSchema,
  RecomputeQueueResponseSchema,
  RecordInfectionEventBodySchema,
  RecordQapiGovernanceBodySchema,
  ReopenIncidentBodySchema,
  ResolveIncidentBodySchema,
  ReviewCopCitationBodySchema,
  RiskRegisterListQuerySchema,
  RiskRegisterListResponseSchema,
  SraCycleDetailResponseSchema,
  SraCycleListQuerySchema,
  SraCycleListResponseSchema,
  TriageIncidentBodySchema,
  UpdateCopCitationBodySchema,
  UpdateIncidentBodySchema,
  UpdateInfectionOutbreakBodySchema,
  UpdateMortalityReviewBodySchema,
  UpdateQapiGovernanceBodySchema,
  UpdateQapiIndicatorBodySchema,
  UpdateQapiProjectBodySchema,
  UpdateSraFindingBodySchema,
  UpdateSraRemediationBodySchema,
} from "../../apps/backend/src/modules/30-quality/routes/quality-typebox";
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
// M24 Billing — Medicaid — the §4.2 request bodies / list queries / response DTOs for the state-Medicaid
// claim, R&B, rule-overlay, eligibility, and trading-partner surfaces (modules/24-billing-medicaid/routes).
import {
  AcknowledgmentListResponse as M24AcknowledgmentListResponse,
  ApplyOverrideBody as M24ApplyOverrideBody,
  ApplyOverrideResponse as M24ApplyOverrideResponse,
  ArDashboardDto as M24ArDashboardDto,
  ArMetricsDto as M24ArMetricsDto,
  AssembleClaimBody as M24AssembleClaimBody,
  ClaimDto as M24ClaimDto,
  ClaimLineListResponse as M24ClaimLineListResponse,
  ClaimListQuery as M24ClaimListQuery,
  ClaimListResponse as M24ClaimListResponse,
  CreateCustomRuleBody as M24CreateCustomRuleBody,
  CreateCustomRuleResponse as M24CreateCustomRuleResponse,
  CreateRbArrangementBody as M24CreateRbArrangementBody,
  EditRbArrangementBody as M24EditRbArrangementBody,
  EditRuleConfigBody as M24EditRuleConfigBody,
  EligibilityCheckListResponse as M24EligibilityCheckListResponse,
  EligibilityListQuery as M24EligibilityListQuery,
  LoadRateScheduleBody as M24LoadRateScheduleBody,
  LoadRateScheduleResponse as M24LoadRateScheduleResponse,
  OverrideRbDayBody as M24OverrideRbDayBody,
  ProviderEntityQuery as M24ProviderEntityQuery,
  RbArrangementDto as M24RbArrangementDto,
  RbArrangementListQuery as M24RbArrangementListQuery,
  RbArrangementListResponse as M24RbArrangementListResponse,
  RbDayListQuery as M24RbDayListQuery,
  RbDayListResponse as M24RbDayListResponse,
  RefreshEligibilityBody as M24RefreshEligibilityBody,
  RefreshEligibilityResponse as M24RefreshEligibilityResponse,
  RegisterPlatformRuleBody as M24RegisterPlatformRuleBody,
  ReplaceClaimBody as M24ReplaceClaimBody,
  RuleConfigListResponse as M24RuleConfigListResponse,
  SubmissionListResponse as M24SubmissionListResponse,
  SubmitClaimBody as M24SubmitClaimBody,
  TerminateRbArrangementBody as M24TerminateRbArrangementBody,
  TestCredentialResponse as M24TestCredentialResponse,
  TradingPartnerCredentialListResponse as M24TradingPartnerCredentialListResponse,
  UpdateDraftClaimBody as M24UpdateDraftClaimBody,
  UpsertCredentialBody as M24UpsertCredentialBody,
  UpsertCredentialResponse as M24UpsertCredentialResponse,
  ValidateClaimResponse as M24ValidateClaimResponse,
  ValidationOverrideListResponse as M24ValidationOverrideListResponse,
  ValidationRunDto as M24ValidationRunDto,
  ValidationRunListResponse as M24ValidationRunListResponse,
  ValidationWorklistDto as M24ValidationWorklistDto,
  ValidationWorklistQuery as M24ValidationWorklistQuery,
  VoidClaimBody as M24VoidClaimBody,
} from "../../apps/backend/src/modules/24-billing-medicaid/routes/m24-typebox";
// M26 Cap Management — the §4.2 request/response schemas the route handlers bind (the @wardenx/cap-management
// contracts re-exported via modules/26-cap/routes/m26-typebox so the enrichment matches the module path).
import {
  AcknowledgeEventRequest as CapAcknowledgeEventRequest,
  AmendConstantRequest as CapAmendConstantRequest,
  CapPeriodDto,
  CapPeriodListResponse,
  CloseCapPeriodRequest as CapCloseCapPeriodRequest,
  FinalizeSettlementRequest as CapFinalizeSettlementRequest,
  InpatientProjectionDto as CapInpatientProjectionDto,
  LockMethodologyRequest as CapLockMethodologyRequest,
  OpenCapPeriodRequest as CapOpenCapPeriodRequest,
  ProjectionListResponse as CapProjectionListResponse,
  ProjectionSnapshotDto as CapProjectionSnapshotDto,
  PsrImportRequest as CapPsrImportRequest,
  PublishConstantRequest as CapPublishConstantRequest,
  ReopenCapPeriodRequest as CapReopenCapPeriodRequest,
  ResolveVarianceRequest as CapResolveVarianceRequest,
  SettlementDto as CapSettlementDto,
} from "../../apps/backend/src/modules/26-cap/routes/m26-typebox";
// M15 Discipline Care Plans — the §4.2 request bodies + list queries the route handlers `parse(...)` /
// `parseQuery(...)`. Same exported schemas, so the contract cannot drift from the validator; the M15-T07
// web screens call the surface these type.
import {
  AmendAssessmentBody as M15AmendAssessmentBody,
  CreateAssessmentBody as M15CreateAssessmentBody,
  CreateGoalBody as M15CreateGoalBody,
  CreateHourEntryBody as M15CreateHourEntryBody,
  CreateInterventionBody as M15CreateInterventionBody,
  CreateSupervisoryVisitBody as M15CreateSupervisoryVisitBody,
  CreateVolunteerAssignmentBody as M15CreateVolunteerAssignmentBody,
  CreateVolunteerGateBody as M15CreateVolunteerGateBody,
  FinalizeVersionBody as M15FinalizeVersionBody,
  GateListQuerySchema as M15GateListQuerySchema,
  HourRatioQuerySchema as M15HourRatioQuerySchema,
  PlanListQuerySchema as M15PlanListQuerySchema,
  RelevantElementsQuerySchema as M15RelevantElementsQuerySchema,
  RevokeVolunteerGateBody as M15RevokeVolunteerGateBody,
  RiskFactorQuerySchema as M15RiskFactorQuerySchema,
  SignVersionBody as M15SignVersionBody,
  SupervisoryCadenceQuerySchema as M15SupervisoryCadenceQuerySchema,
  UpdateGoalBody as M15UpdateGoalBody,
  UpdateInterventionBody as M15UpdateInterventionBody,
  UpdateVolunteerAssignmentBody as M15UpdateVolunteerAssignmentBody,
  UpdateVolunteerGateBody as M15UpdateVolunteerGateBody,
  VersionListQuerySchema as M15VersionListQuerySchema,
  VolunteerStatusQuerySchema as M15VolunteerStatusQuerySchema,
} from "../../apps/backend/src/modules/15-discipline-care-plans/routes/m15-typebox";
// M16 Bereavement — the §4.2 request bodies + list queries the §4.1 route handlers `parse(...)` /
// `parseQuery(...)`. Same exported schemas, so the contract cannot drift from the validator; the M16-T07
// web screens call the surface these type.
import {
  AssignCounselorBody as M16AssignCounselorBody,
  AssignVolunteerBody as M16AssignVolunteerBody,
  CancelOutreachBody as M16CancelOutreachBody,
  CloseEarlyBody as M16CloseEarlyBody,
  CompleteOutreachBody as M16CompleteOutreachBody,
  ConfirmContactBody as M16ConfirmContactBody,
  CosignCloseBody as M16CosignCloseBody,
  CounselorDashboardQuerySchema as M16CounselorDashboardQuerySchema,
  CreateContactBody as M16CreateContactBody,
  FlagComplicatedGriefBody as M16FlagComplicatedGriefBody,
  InitiateContactBody as M16InitiateContactBody,
  LateAttemptBody as M16LateAttemptBody,
  LogDirectContactBody as M16LogDirectContactBody,
  MarkDeceasedBody as M16MarkDeceasedBody,
  MarkUnreachableBody as M16MarkUnreachableBody,
  OptOutBody as M16OptOutBody,
  OutreachListQuerySchema as M16OutreachListQuerySchema,
  OutreachOutcomeBody as M16OutreachOutcomeBody,
  PausePlanBody as M16PausePlanBody,
  PlanListQuerySchema as M16PlanListQuerySchema,
  RecomputeRiskBody as M16RecomputeRiskBody,
  ReferExternalBody as M16ReferExternalBody,
  RegenerateScheduleBody as M16RegenerateScheduleBody,
  RescindOptOutBody as M16RescindOptOutBody,
  ResumePlanBody as M16ResumePlanBody,
  RiskScoreListQuerySchema as M16RiskScoreListQuerySchema,
  SeedRosterAndScheduleBody as M16SeedRosterAndScheduleBody,
  StartOutreachBody as M16StartOutreachBody,
  SupervisorDashboardQuerySchema as M16SupervisorDashboardQuerySchema,
  UpdateContactBody as M16UpdateContactBody,
} from "../../apps/backend/src/modules/16-bereavement/routes/m16-typebox";
// M19 On-Call Triage — the §4.2 request bodies + list queries the §4.1 route handlers `parse(...)` /
// `parseQuery(...)`. Same exported schemas, so the contract cannot drift from the validator; the M19-T08
// web screens call the surface these type. Note what is deliberately ABSENT from every body and therefore
// from the published contract: no organization, no acting membership, no vendor identity, no
// `red_flag_hit`, no `onCallShiftId` and no `policySnapshot` — each is server-derived, and their absence
// from the schema is the structural half of §8.3's spoofing controls.
import {
  AbandonCallBody as M19AbandonCallBody,
  AcknowledgeEscalationBody as M19AcknowledgeEscalationBody,
  ApplyProtocolBody as M19ApplyProtocolBody,
  AwaitingCallbackBody as M19AwaitingCallbackBody,
  CancelShiftBody as M19CancelShiftBody,
  CorrectAnswerBody as M19CorrectAnswerBody,
  CreateProtocolBody as M19CreateProtocolBody,
  CreateShiftBody as M19CreateShiftBody,
  CreateVendorBindingBody as M19CreateVendorBindingBody,
  CurrentOnCallQuery as M19CurrentOnCallQuery,
  DocumentCallBody as M19DocumentCallBody,
  EscalateBody as M19EscalateBody,
  IdentifyPatientBody as M19IdentifyPatientBody,
  ListEscalationsQuery as M19ListEscalationsQuery,
  ListProtocolsQuery as M19ListProtocolsQuery,
  ListShiftsQuery as M19ListShiftsQuery,
  ListTriageCallsQuery as M19ListTriageCallsQuery,
  OpenTriageCallBody as M19OpenTriageCallBody,
  PaperReentryBody as M19PaperReentryBody,
  PatchOncallPolicyBody as M19PatchOncallPolicyBody,
  PatchProtocolBody as M19PatchProtocolBody,
  PatchProtocolQuestionBody as M19PatchProtocolQuestionBody,
  PatchVendorBindingBody as M19PatchVendorBindingBody,
  PolicyQuery as M19PolicyQuery,
  PortalRecentQuery as M19PortalRecentQuery,
  ProtocolQuestionBody as M19ProtocolQuestionBody,
  RecordAnswerBody as M19RecordAnswerBody,
  ResolveEscalationBody as M19ResolveEscalationBody,
  SelectDispositionBody as M19SelectDispositionBody,
  ShiftTransitionBody as M19ShiftTransitionBody,
} from "../../apps/backend/src/modules/19-oncall/routes/m19-typebox";
// M21 Supplies / DME / Comfort Kits — the §4.2 request bodies + list queries the §4.1 route handlers
// `parse(...)` / `parseQuery(...)`. Same exported schemas, so the contract cannot drift from the validator;
// the M21-T06 web screens call the surface these type. Note the decimal-STRING quantities: §4.2.2's sketch
// types them as numbers, the `numeric` columns win, and the enrichment publishes what the validator
// enforces rather than what the prose proposed.
import {
  AssignRetrieverBody as M21AssignRetrieverBody,
  AssignVendorBody as M21AssignVendorBody,
  CancelRequestBody as M21CancelRequestBody,
  ConfirmReceivedBody as M21ConfirmReceivedBody,
  CreateDispatchBody as M21CreateDispatchBody,
  CreateReturnBody as M21CreateReturnBody,
  CreateSupplyItemBody as M21CreateSupplyItemBody,
  CreateSupplyRequestBody as M21CreateSupplyRequestBody,
  CreateTemplateBody as M21CreateTemplateBody,
  DeclareUnreturnableBody as M21DeclareUnreturnableBody,
  DeployAtPatientBody as M21DeployAtPatientBody,
  ListDispatchesQuery as M21ListDispatchesQuery,
  ListParStockQuery as M21ListParStockQuery,
  ListReturnsQuery as M21ListReturnsQuery,
  ListRoutingRulesQuery as M21ListRoutingRulesQuery,
  ListSupplyItemsQuery as M21ListSupplyItemsQuery,
  ListSupplyRequestsQuery as M21ListSupplyRequestsQuery,
  ListTemplatesQuery as M21ListTemplatesQuery,
  MarkDeliveredBody as M21MarkDeliveredBody,
  MarkInTransitBody as M21MarkInTransitBody,
  MarkOrderedBody as M21MarkOrderedBody,
  ObserveParStockBody as M21ObserveParStockBody,
  ReconcileReturnBody as M21ReconcileReturnBody,
  RetireSupplyItemBody as M21RetireSupplyItemBody,
  ReturnRequestBody as M21ReturnRequestBody,
  SupersedeTemplateBody as M21SupersedeTemplateBody,
  UpdateParStockBody as M21UpdateParStockBody,
  UpsertRoutingRuleBody as M21UpsertRoutingRuleBody,
  UpsertTenantSupplyItemBody as M21UpsertTenantSupplyItemBody,
} from "../../apps/backend/src/modules/21-supplies/routes/m21-typebox";
// M27 Cost Report — the §4.1 request bodies + list query the cost-report routes bind (the realigned
// Form CMS-1984-14 surface; modules/27-cost-report/routes path flips the OpenAPI-enriched flag).
import {
  AddBadDebtBodySchema,
  ApproveForSubmitBodySchema,
  CostReportListQuerySchema,
  CreateCostReportBodySchema,
  CreateValidationRuleBodySchema,
  OverrideValidationResultBodySchema,
  PatchCostReportBodySchema,
  PutWorksheetBodySchema,
  RecordAcknowledgmentBodySchema,
  ReopenBodySchema,
  SubmitBodySchema,
} from "../../apps/backend/src/modules/27-cost-report/routes/cost-report-typebox";
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
  // ── M30 HQRP & Quality (§4.1–4.2). 47 routes across seven sub-surfaces (CAHPS / CoP / incidents /
  // infection / measures / mortality / QAPI / SRA / risk register) published with NO request contract:
  // the generated client typed every body and query as `never`, so nothing could call M30 in a typed way.
  // Each entry reuses the SAME TypeBox schema the handler already `parse`s (quality-typebox.ts exports 65),
  // so the published contract cannot drift from the validator.
  //
  // Responses too, as of the DTO pass: all 24 M30 GETs now publish a typed 2xx body. The response
  // schemas mirror `read-service.ts`'s view interfaces (that file is the contract, quality-typebox's
  // §4.1 RESPONSE DTOs are its wire projection) and a compile-time conformance test pins the two
  // together, so a view field added or renamed breaks the build rather than the client.
  // The seven detail/singleton reads had NO entry at all — not even a summary — so each published a
  // bare 200 with `content?: never`. They are reads, so response-only.
  "GET /api/v1/quality/cahps/vendor": {
    summary: "The org's active CAHPS vendor binding (null before the first binding)",
    response: CahpsVendorResponseSchema,
  },
  "GET /api/v1/quality/cahps/export/:exportId": {
    summary: "A CAHPS export job + its signed download URL once complete",
    response: CahpsExportJobResponseSchema,
  },
  "GET /api/v1/quality/incidents/:incidentId": {
    summary: "Incident detail — state history, investigation notes, CAP plan",
    response: IncidentDetailResponseSchema,
  },
  "GET /api/v1/quality/measures/recompute/queue": {
    summary: "Pending measure-recompute jobs (bare array — bounded by the queue)",
    response: RecomputeQueueResponseSchema,
  },
  "GET /api/v1/quality/measures/:measureId/values/:valueId/snapshot": {
    summary: "The reproducibility snapshot behind one emitted measure value (D1)",
    response: MeasureValueSnapshotResponseSchema,
  },
  "GET /api/v1/quality/mortality/:reviewId": {
    summary: "Mortality-review detail — the three review dimensions",
    response: MortalityReviewDetailResponseSchema,
  },
  "GET /api/v1/quality/sra/cycles/:cycleId": {
    summary: "SRA cycle detail — progress, findings, remediations",
    response: SraCycleDetailResponseSchema,
  },
  "POST /api/v1/quality/cahps/vendor": {
    summary: "Bind the org's CAHPS survey vendor (§4.1)",
    body: BindCahpsVendorBodySchema,
  },
  "GET /api/v1/quality/cahps/decedents": {
    summary: "Monthly CAHPS decedent sample (CMS exclusions applied)",
    query: CahpsDecedentListQuerySchema,
    response: CahpsDecedentListResponseSchema,
  },
  "POST /api/v1/quality/cahps/decedents/:sampleId/exclude": {
    summary: "Exclude a decedent from the CAHPS sample (CMS criteria)",
    body: ExcludeCahpsDecedentBodySchema,
  },
  "POST /api/v1/quality/cahps/export": {
    summary: "Open a CAHPS vendor export (encrypted caregiver PHI, §3.6)",
    body: CreateCahpsExportBodySchema,
  },
  "POST /api/v1/quality/cahps/results/ingest": {
    summary: "Ingest vendor-returned CAHPS result aggregates",
    body: IngestCahpsResultsBodySchema,
  },
  "GET /api/v1/quality/cahps/results": {
    summary: "Ingested CAHPS results by reporting period",
    query: CahpsResultListQuerySchema,
    response: CahpsResultListResponseSchema,
  },
  "GET /api/v1/quality/cop/citations": {
    summary: "CoP survey citations (§1.2 compliance posture)",
    query: CopCitationListQuerySchema,
    response: CopCitationListResponseSchema,
  },
  "PATCH /api/v1/quality/cop/citations/:citationId": {
    summary: "Update a CoP citation's remediation state",
    body: UpdateCopCitationBodySchema,
  },
  "POST /api/v1/quality/cop/citations/:citationId/review": {
    summary: "Record a compliance review of a CoP citation",
    body: ReviewCopCitationBodySchema,
  },
  "GET /api/v1/quality/incidents": {
    summary: "Incident register (kind / severity / state filters)",
    query: IncidentListQuerySchema,
    response: IncidentListResponseSchema,
  },
  "GET /api/v1/quality/incidents/abuse-allegations": {
    summary: "Abuse-allegation incidents (mandatory-reporter surface)",
    query: AbuseAllegationListQuerySchema,
    response: IncidentListResponseSchema,
  },
  "POST /api/v1/quality/incidents": {
    summary: "Report an incident",
    body: CreateIncidentBodySchema,
  },
  "PATCH /api/v1/quality/incidents/:incidentId": {
    summary: "Update an incident",
    body: UpdateIncidentBodySchema,
  },
  "POST /api/v1/quality/incidents/:incidentId/triage": {
    summary: "Triage an incident (severity + routing)",
    body: TriageIncidentBodySchema,
  },
  "POST /api/v1/quality/incidents/:incidentId/investigation": {
    summary: "Append an investigation note",
    body: AddInvestigationNoteBodySchema,
  },
  "POST /api/v1/quality/incidents/:incidentId/investigate": {
    summary: "Open the investigation on an incident",
    body: OpenInvestigationBodySchema,
  },
  "POST /api/v1/quality/incidents/:incidentId/resolve": {
    summary: "Resolve an incident",
    body: ResolveIncidentBodySchema,
  },
  "POST /api/v1/quality/incidents/:incidentId/reopen": {
    summary: "Reopen a closed incident",
    body: ReopenIncidentBodySchema,
  },
  "GET /api/v1/quality/infection/events": {
    summary: "Infection surveillance events",
    query: InfectionEventListQuerySchema,
    response: InfectionEventListResponseSchema,
  },
  "POST /api/v1/quality/infection/events": {
    summary: "Record an infection surveillance event",
    body: RecordInfectionEventBodySchema,
  },
  "GET /api/v1/quality/infection/outbreaks": {
    summary: "Infection outbreak cases",
    query: InfectionOutbreakListQuerySchema,
    response: InfectionOutbreakListResponseSchema,
  },
  "PATCH /api/v1/quality/infection/outbreaks/:caseId": {
    summary: "Update an outbreak case",
    body: UpdateInfectionOutbreakBodySchema,
  },
  "GET /api/v1/quality/measures": {
    summary: "The FY measure catalog + latest values (aggregate-only)",
    query: MeasureListQuerySchema,
    response: MeasureListResponseSchema,
  },
  "GET /api/v1/quality/measures/:measureId/values": {
    summary: "Measure value series across a window",
    query: MeasureValuesQuerySchema,
    response: MeasureValueSeriesResponseSchema,
  },
  "POST /api/v1/quality/measures/recompute": {
    summary: "Enqueue a measure recompute (§4.8)",
    body: EnqueueRecomputeBodySchema,
  },
  "GET /api/v1/quality/mortality": {
    summary: "Mortality reviews (30-day target)",
    query: MortalityListQuerySchema,
    response: MortalityListResponseSchema,
  },
  "PATCH /api/v1/quality/mortality/:reviewId": {
    summary: "Update a mortality review",
    body: UpdateMortalityReviewBodySchema,
  },
  "POST /api/v1/quality/mortality/:reviewId/complete": {
    summary: "Complete a mortality review",
    body: CompleteMortalityReviewBodySchema,
  },
  "GET /api/v1/quality/qapi/programs": {
    summary: "QAPI programs",
    query: QapiProgramListQuerySchema,
    response: QapiProgramListResponseSchema,
  },
  "POST /api/v1/quality/qapi/programs": {
    summary: "Adopt a QAPI program",
    body: AdoptQapiProgramBodySchema,
  },
  "PATCH /api/v1/quality/qapi/programs/:programId/governance": {
    summary: "Update a QAPI program's governance cadence",
    body: UpdateQapiGovernanceBodySchema,
  },
  "GET /api/v1/quality/qapi/indicators": {
    summary: "QAPI indicators (tenant may TIGHTEN a platform target)",
    query: QapiIndicatorListQuerySchema,
    response: QapiIndicatorListResponseSchema,
  },
  "POST /api/v1/quality/qapi/indicators": {
    summary: "Create a QAPI indicator",
    body: CreateQapiIndicatorBodySchema,
  },
  "PATCH /api/v1/quality/qapi/indicators/:indicatorId": {
    summary: "Update a QAPI indicator",
    body: UpdateQapiIndicatorBodySchema,
  },
  "GET /api/v1/quality/qapi/projects": {
    summary: "QAPI projects by phase",
    query: QapiProjectListQuerySchema,
    response: QapiProjectListResponseSchema,
  },
  "POST /api/v1/quality/qapi/projects": {
    summary: "Charter a QAPI project",
    body: CharterQapiProjectBodySchema,
  },
  "PATCH /api/v1/quality/qapi/projects/:projectId": {
    summary: "Update a QAPI project",
    body: UpdateQapiProjectBodySchema,
  },
  "GET /api/v1/quality/qapi/projects/:projectId/pips": {
    summary: "PIPs under a QAPI project",
    query: QapiPipListQuerySchema,
    response: QapiPipListResponseSchema,
  },
  "POST /api/v1/quality/qapi/projects/:projectId/pips": {
    summary: "Add a PIP to a QAPI project",
    body: AddQapiPipBodySchema,
  },
  "POST /api/v1/quality/qapi/pips/:pipId/close": {
    summary: "Close a PIP",
    body: CloseQapiPipBodySchema,
  },
  "POST /api/v1/quality/qapi/governance": {
    summary: "Record QAPI governance minutes",
    body: RecordQapiGovernanceBodySchema,
  },
  "GET /api/v1/quality/qapi/governance": {
    summary: "QAPI governance minutes",
    query: QapiGovernanceListQuerySchema,
    response: QapiGovernanceListResponseSchema,
  },
  "GET /api/v1/quality/risk-register": {
    summary: "Risk register — open SRA findings, incidents, CAPs, CoP status",
    query: RiskRegisterListQuerySchema,
    response: RiskRegisterListResponseSchema,
  },
  "GET /api/v1/quality/sra/cycles": {
    summary: "Security risk assessment cycles (§164.308)",
    query: SraCycleListQuerySchema,
    response: SraCycleListResponseSchema,
  },
  "POST /api/v1/quality/sra/cycles": {
    summary: "Open an SRA cycle",
    body: OpenSraCycleBodySchema,
  },
  "POST /api/v1/quality/sra/cycles/:cycleId/findings": {
    summary: "Add a finding to an SRA cycle",
    body: AddSraFindingBodySchema,
  },
  "PATCH /api/v1/quality/sra/findings/:findingId": {
    summary: "Update an SRA finding",
    body: UpdateSraFindingBodySchema,
  },
  "POST /api/v1/quality/sra/findings/:findingId/remediation": {
    summary: "Plan remediation for an SRA finding",
    body: PlanSraRemediationBodySchema,
  },
  "PATCH /api/v1/quality/sra/remediation/:remediationId": {
    summary: "Update an SRA remediation",
    body: UpdateSraRemediationBodySchema,
  },
  "POST /api/v1/quality/sra/cycles/:cycleId/close": {
    summary: "Close an SRA cycle (two-person close)",
    body: CloseSraCycleBodySchema,
  },

  // ── M25 Remittance & Denials (§4.1). The four cursor-paginated reads the built screens call get a
  // typed response so the client stops handing them `never` (the screens were casting through
  // `res.data as unknown as Page<DenialRow>` with a hand-maintained row shape); every write route gets
  // the SAME TypeBox body its handler already `parse`s, so the contract cannot drift from the validator.
  "GET /api/v1/denials": {
    summary: "Denial worklist (cursor-paginated, §4.12)",
    query: M25ListQuerySchema,
    response: DenialWorklistPageSchema,
  },
  "GET /api/v1/appeals": {
    summary: "Appeal tracker (cursor-paginated, §4.12)",
    query: M25ListQuerySchema,
    response: AppealSummaryPageSchema,
  },
  "GET /api/v1/remittance/advices": {
    summary: "Remittance advices (835 headers, cursor-paginated, §4.12)",
    query: M25ListQuerySchema,
    response: RemittanceAdviceSummaryPageSchema,
  },
  "GET /api/v1/remittance/lines": {
    summary: "Remittance service lines (cursor-paginated, §4.12)",
    query: M25ListQuerySchema,
    response: RemittanceLineSummaryPageSchema,
  },
  "GET /api/v1/remittance/unmatched": {
    summary: "Unmatched remittance lines awaiting manual match (§4.1)",
    query: M25ListQuerySchema,
    response: RemittanceLineSummaryPageSchema,
  },
  "POST /api/v1/remittance/lines/:id/manual-match": {
    summary: "Manually match a remittance line to a claim (§4.1)",
    body: ManualMatchRequestSchema,
  },
  "POST /api/v1/remittance/adjustments/:id/override": {
    summary: "Override an adjustment's taxonomy classification (§4.1)",
    body: AdjustmentOverrideRequestSchema,
  },
  "PATCH /api/v1/denials/:id/assign": {
    summary: "Assign a denial case to a membership (§4.1)",
    body: DenialAssignRequestSchema,
  },
  "PATCH /api/v1/denials/:id/escalate": {
    summary: "Escalate a denial case (§4.1)",
    body: DenialEscalateRequestSchema,
  },
  "PATCH /api/v1/denials/:id/resolve": {
    summary: "Resolve a denial case (§4.1)",
    body: DenialResolveRequestSchema,
  },
  "POST /api/v1/denials/:id/close-write-off": {
    summary: "Close a denial case as a write-off (§4.1)",
    body: DenialCloseWriteOffRequestSchema,
  },
  "POST /api/v1/denials/:id/reopen": {
    summary: "Reopen a closed denial case (§4.1)",
    body: DenialReopenRequestSchema,
  },
  "POST /api/v1/denials/:id/appeals": {
    summary: "Open an appeal against a denial case (§4.1)",
    body: AppealCreateRequestSchema,
  },
  "PATCH /api/v1/appeals/:id/attach": {
    summary: "Attach supporting evidence to an appeal (§4.1)",
    body: AppealAttachRequestSchema,
  },
  "POST /api/v1/appeals/:id/submit": {
    summary: "Submit an appeal to the payer (§4.1)",
    body: AppealSubmitRequestSchema,
  },
  "POST /api/v1/appeals/:id/decide": {
    summary: "Record the payer's appeal decision (§4.1)",
    body: AppealDecideRequestSchema,
  },
  "POST /api/v1/appeals/:id/withdraw": {
    summary: "Withdraw a submitted appeal (§4.1)",
    body: AppealWithdrawRequestSchema,
  },
  "PATCH /api/v1/taxonomy/overlays/:carc": {
    summary: "Patch the tenant CARC taxonomy overlay (§4.1)",
    body: TaxonomyOverlayPatchSchema,
  },

  // ── M39 Consent (§4.1–4.2). Bodies + queries from the module's own validators.
  "POST /api/v1/consent-types/overlay": {
    summary: "Publish a TIGHTEN-ONLY tenant consent-type overlay (§7.6)",
    body: UpsertOverlayBodySchema,
  },
  "POST /api/v1/patients/:patientId/consents": {
    summary: "Create a consent DRAFT for a patient (§4.1)",
    body: ConsentCreateDraftBodySchema,
  },
  "PATCH /api/v1/consents/:consentId": {
    summary: "Edit a consent draft — only `status='draft'` is editable (D1)",
    body: UpdateDraftBodySchema,
  },
  "POST /api/v1/consents/:consentId/supersede": {
    summary: "Supersede an active consent with a new row (D1 append-only)",
    body: SupersedeBodySchema,
  },
  "POST /api/v1/consents/:consentId/revoke": {
    summary: "Revoke a consent (§7.3 cascade; staff revocation needs evidence)",
    body: ConsentRevokeBodySchema,
  },
  "POST /api/v1/consents/:consentId/renew": {
    summary: "Renew an expired/revoked consent (D13 renewal chain)",
    body: RenewBodySchema,
  },
  "POST /api/v1/consents/:consentId/recipients": {
    summary: "Add a named disclosure recipient (D6)",
    body: AddRecipientBodySchema,
  },
  "DELETE /api/v1/consents/:consentId/recipients/:recipientId": {
    summary: "Remove a named recipient — flips removed_at, never deletes (D6)",
    body: RemoveRecipientBodySchema,
  },
  "POST /api/v1/consents/:consentId/dpoa-agents": {
    summary: "Name a DPOA agent (D5)",
    body: AddDpoaAgentBodySchema,
  },
  "PATCH /api/v1/consents/:consentId/dpoa-agents/:agentId": {
    summary: "Mutate a DPOA agent's scope / activation / term, or retire them (D5)",
    body: UpdateDpoaAgentBodySchema,
  },
  "POST /api/v1/consents/bereavement-outreach": {
    summary: "Capture post-mortem bereavement-outreach consent (D14)",
    body: BereavementOutreachBodySchema,
  },
  "GET /api/v1/patients/:patientId/expiring-consents": {
    summary: "Consents inside the renewal window (cursor-paginated, §4.12)",
    query: ExpiringConsentsQuerySchema,
    response: ExpiringConsentsResponseSchema,
  },
  "GET /api/v1/patients/:patientId/consents": {
    summary: "A patient's ACTIVE consents (§4.1)",
    response: ConsentListResponseSchema,
  },
  "GET /api/v1/consents/:consentId/recipients": {
    summary: "Named disclosure recipients on a consent, active + historical (D6)",
    response: ConsentRecipientListResponseSchema,
  },
  "GET /api/v1/consents/:consentId/dpoa-agents": {
    summary: "Named DPOA agents on a consent, active + historical (D5)",
    response: ConsentDpoaAgentListResponseSchema,
  },
  "GET /api/v1/consents/:consentId/eval-audit": {
    summary: "Per-consent decision audit (cursor-paginated, §4.12)",
    query: ConsentEvalAuditQuerySchema,
  },
  "GET /api/v1/consents/eval-audit/by-patient": {
    summary: "Patient-scoped consent-decision audit (cursor-paginated, §4.12)",
    query: ConsentEvalAuditByPatientQuerySchema,
  },

  // ── M3 Authorization (§4.3–4.4). The bodies its routes now validate at the boundary — the surface
  // that GRANTS PERMISSIONS had no request contract in the published API at all.
  "POST /api/v1/roles": {
    summary: "Clone/extend a platform template into an org-owned custom role (§7.6)",
    body: CreateRoleBody,
  },
  "PATCH /api/v1/roles/:id": {
    summary: "Rename / enable / edit a role's permission set (§7.6)",
    body: UpdateRoleBody,
  },
  "POST /api/v1/memberships/:id/roles": {
    summary: "Grant a role onto a membership (§6 anti-escalation applies)",
    body: AssignRoleBody,
  },
  "POST /api/v1/breakglass": {
    summary: "Invoke break-glass emergency access (§7.4; reason ≥10 chars)",
    body: InvokeBreakGlassBody,
  },
  "POST /api/v1/engagements": {
    summary: "Open an auditor engagement over a defined slice + window (§7.5)",
    body: CreateEngagementBody,
  },
  "PATCH /api/v1/engagements/:id": {
    summary: "Shorten an engagement window or cancel it (§7.5)",
    body: UpdateEngagementBody,
  },
  "POST /api/v1/engagements/:id/auditors": {
    summary: "Enroll an auditor — M2 mints the magic link out-of-band (D4)",
    body: EnrollAuditorBody,
  },

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

  // ── M24 Billing — Medicaid (§4.1) — claim lifecycle + validation/override, per-tenant rule overlay,
  // eligibility, NF Room & Board arrangements/days, state trading-partner credentials, platform admin.
  // Money is integer cents (D8); org/actor binding is server-side, so no body carries an org/membership id;
  // secrets are write-only and the Recipient ID is never returned (only the masked last-4; D12 / §3.6).
  "GET /api/v1/medicaid-claims": {
    summary: "Medicaid claim workbench — cursor-paginated, filterable by state/kind/MCO/patient (§4.1)",
    query: M24ClaimListQuery,
    response: M24ClaimListResponse,
  },
  "POST /api/v1/medicaid-claims": {
    summary:
      "Assemble a Medicaid claim draft over a patient + service range (Idempotency-Key required; §2.1)",
    body: M24AssembleClaimBody,
    response: M24ClaimDto,
  },
  "GET /api/v1/medicaid-claims/:id": {
    summary: "Single Medicaid claim — state, TOB, control number, COB + R&B linkage (§4.1)",
    response: M24ClaimDto,
  },
  "PATCH /api/v1/medicaid-claims/:id": {
    summary: "Edit a DRAFT claim's MCO routing target — If-Match version required (§2.5)",
    body: M24UpdateDraftClaimBody,
    response: M24ClaimDto,
  },
  "DELETE /api/v1/medicaid-claims/:id": {
    summary: "Delete a DRAFT claim — If-Match version required (§2.5)",
  },
  "POST /api/v1/medicaid-claims/:id/validate": {
    summary: "Run the §11 rule registry against the claim — returns the new validation run id (§4.1)",
    response: M24ValidateClaimResponse,
  },
  "POST /api/v1/medicaid-claims/:id/submit": {
    summary:
      "Submit to the state MMIS / MCO channel — step-up + Idempotency-Key; adapter resolves the channel (D12; §4.4)",
    body: M24SubmitClaimBody,
    response: M24ClaimDto,
  },
  "POST /api/v1/medicaid-claims/:id/replace": {
    summary: "Build the TOB-817 replacement draft — step-up; reason ≥40 chars (D12; §2.3)",
    body: M24ReplaceClaimBody,
    response: M24ClaimDto,
  },
  "POST /api/v1/medicaid-claims/:id/void": {
    summary: "Build the TOB-818 void draft — step-up; reason ≥40 chars (D12; §2.3)",
    body: M24VoidClaimBody,
    response: M24ClaimDto,
  },
  "POST /api/v1/medicaid-claims/:id/abandon": {
    summary: "Abandon a pre-submission claim — terminal, If-Match version required (§2.2)",
    response: M24ClaimDto,
  },
  "GET /api/v1/medicaid-claims/:id/lines": {
    summary: "Claim service lines — rev/Q code, LOC, units, rate + the R&B day linkage (§3.2)",
    response: M24ClaimLineListResponse,
  },
  "GET /api/v1/medicaid-claims/:id/submissions": {
    summary: "Every submission attempt with adapter vendor/version, result + retry history (§5.1)",
    response: M24SubmissionListResponse,
  },
  "GET /api/v1/medicaid-claims/:id/acknowledgments": {
    summary: "Every acknowledgment received — 999 / 277CA / state-specific outcome + error codes (§5.1)",
    response: M24AcknowledgmentListResponse,
  },
  "GET /api/v1/medicaid-claims/:id/validation-runs": {
    summary: "Validation-run history for a claim, most recent first (§11)",
    response: M24ValidationRunListResponse,
  },
  "GET /api/v1/medicaid-validation-runs/:id": {
    summary: "A single validation run including its per-rule results + remediation hints (§11)",
    response: M24ValidationRunDto,
  },
  "POST /api/v1/medicaid-validation-results/:id/override": {
    summary:
      "Override a failed rule — role-eligibility + step-up + AI-actor reject; reason ≥40 chars (D12/D14; §4.7)",
    body: M24ApplyOverrideBody,
    response: M24ApplyOverrideResponse,
  },
  "GET /api/v1/medicaid-validation-worklist": {
    summary:
      "Org-wide blocked-claim worklist grouped by the failing rule holding each claim (§5.1) — the response reports the blocked-claim denominator and whether the scan was truncated",
    query: M24ValidationWorklistQuery,
    response: M24ValidationWorklistDto,
  },
  "GET /api/v1/medicaid-validation-overrides": {
    summary: "Org-wide override history — actor, role, reason, ruleKey, claim reference (§5.1)",
    response: M24ValidationOverrideListResponse,
  },
  "GET /api/v1/medicaid-ar-dashboard": {
    summary: "Medicaid AR aging — open claims bucketed by age and by service state (§5.1)",
    query: M24ProviderEntityQuery,
    response: M24ArDashboardDto,
  },
  "GET /api/v1/medicaid-ar-dashboard/metrics": {
    summary: "Medicaid billing metrics — denial rate, open count, MCO breakdown, aging (M33-fed; §5.1)",
    query: M24ProviderEntityQuery,
    response: M24ArMetricsDto,
  },
  "GET /api/v1/medicaid-rule-config": {
    summary: "Per-tenant validation-rule overlay over the platform floor (regulatory rules lock; §11)",
    response: M24RuleConfigListResponse,
  },
  "PATCH /api/v1/medicaid-rule-config/:ruleKey": {
    summary: "Edit a rule overlay — enable/disable + parameters; regulatory-required rules reject (§11)",
    body: M24EditRuleConfigBody,
  },
  "POST /api/v1/medicaid-rule-config/custom": {
    summary: "Create a tenant custom rule over the §11 predicate DSL (§11)",
    body: M24CreateCustomRuleBody,
    response: M24CreateCustomRuleResponse,
  },
  "DELETE /api/v1/medicaid-rule-config/:ruleKey": {
    summary: "Delete a tenant custom rule — If-Match version required (§11)",
  },
  "GET /api/v1/medicaid-eligibility-checks": {
    summary:
      "Per-patient eligibility history with the MCO assignment timeline — masked Recipient ID only (D12; §3.6)",
    query: M24EligibilityListQuery,
    response: M24EligibilityCheckListResponse,
  },
  "POST /api/v1/medicaid-eligibility-checks": {
    summary: "Refresh a patient's state/MCO eligibility as of a service date (adapter-gated; §4.4)",
    body: M24RefreshEligibilityBody,
    response: M24RefreshEligibilityResponse,
  },
  "GET /api/v1/rb-arrangements": {
    summary: "NF Room & Board pass-through arrangements — facility, effective dates, per-diems (§2.4)",
    query: M24RbArrangementListQuery,
    response: M24RbArrangementListResponse,
  },
  "POST /api/v1/rb-arrangements": {
    summary: "Create an NF Room & Board arrangement (DRAFT; no-overlap enforced per patient; §2.4)",
    body: M24CreateRbArrangementBody,
    response: M24RbArrangementDto,
  },
  "GET /api/v1/rb-arrangements/:id": {
    summary: "A single R&B arrangement including its day-by-day status table (§5.1)",
    response: M24RbArrangementDto,
  },
  "PATCH /api/v1/rb-arrangements/:id": {
    summary: "Edit a DRAFT arrangement's per-diems / end date — If-Match version required (§2.5)",
    body: M24EditRbArrangementBody,
    response: M24RbArrangementDto,
  },
  "POST /api/v1/rb-arrangements/:id/activate": {
    summary: "Activate a DRAFT arrangement — begins day generation (§2.4)",
    response: M24RbArrangementDto,
  },
  "POST /api/v1/rb-arrangements/:id/terminate": {
    summary: "Terminate an ACTIVE arrangement — reason ≥40 chars (§2.4)",
    body: M24TerminateRbArrangementBody,
    response: M24RbArrangementDto,
  },
  "GET /api/v1/rb-days": {
    summary: "R&B days — per-day LOC, per-diem snapshot, billable/excluded status (§2.4)",
    query: M24RbDayListQuery,
    response: M24RbDayListResponse,
  },
  "PATCH /api/v1/rb-days/:id": {
    summary: "Flip a single R&B day's status with a reason — If-Match version required (§5.1)",
    body: M24OverrideRbDayBody,
  },
  "GET /api/v1/state-medicaid-trading-partner-credentials": {
    summary: "Per-PE per-state trading-partner credentials — secrets never returned (§3.6)",
    query: M24ProviderEntityQuery,
    response: M24TradingPartnerCredentialListResponse,
  },
  "POST /api/v1/state-medicaid-trading-partner-credentials": {
    summary: "Create or update a state trading-partner credential — secrets are write-only (§3.6)",
    body: M24UpsertCredentialBody,
    response: M24UpsertCredentialResponse,
  },
  "POST /api/v1/state-medicaid-trading-partner-credentials/:id/test": {
    summary: "Run the adapter's sandbox connectivity test and record the outcome (§4.4)",
    response: M24TestCredentialResponse,
  },
  "POST /api/v1/admin/platform-medicaid-rules": {
    summary: "Register a platform-floor Medicaid validation rule — platform admin only (§11)",
    body: M24RegisterPlatformRuleBody,
  },
  "POST /api/v1/admin/state-rate-schedule-load": {
    summary: "Queue a state rate-schedule load for an effective year — platform admin only (§4.4)",
    body: M24LoadRateScheduleBody,
    response: M24LoadRateScheduleResponse,
  },

  // ── M26 Cap Management (§4.1) — cap-period lifecycle, projections, threshold queue, PS&R, settlement,
  // platform constants. Bodies/responses are the §4.2 contract schemas the handlers bind; org/actor binding
  // is server-side, so no body carries an org/user id. Reads returning view interfaces (dashboard/accrual/
  // psr) are omitted (no fabrication) — params auto-derive from the path.
  "GET /api/v1/cap/periods": {
    summary: "List cap periods for the calling tenant — status + methodology (§4.1)",
    response: CapPeriodListResponse,
  },
  "POST /api/v1/cap/periods": {
    summary: "Open a new cap period (snapshots the platform constant; emits m26.cap.year_opened; §4.1)",
    body: CapOpenCapPeriodRequest,
    response: CapPeriodDto,
  },
  "GET /api/v1/cap/periods/:periodId": {
    summary: "Single cap period including methodology lock + status (§4.1)",
    response: CapPeriodDto,
  },
  "PATCH /api/v1/cap/periods/:periodId/close": {
    summary: "Close a cap period — active → in_settlement (cap_period_open ABAC; M26-F06; §4.1)",
    body: CapCloseCapPeriodRequest,
    response: CapPeriodDto,
  },
  "PATCH /api/v1/cap/periods/:periodId/reopen": {
    summary: "Reopen a settled period — step-up required (cap_period_settled ABAC; D12; §4.1)",
    body: CapReopenCapPeriodRequest,
    response: CapPeriodDto,
  },
  "POST /api/v1/cap/periods/:periodId/methodology": {
    summary: "Lock the streamlined/proportional methodology — one-time, step-up required (D2/D12; §4.1)",
    body: CapLockMethodologyRequest,
    response: CapPeriodDto,
  },
  "GET /api/v1/cap/projections": {
    summary: "Latest projection snapshots (agency + inpatient) for a period (§4.1)",
    response: CapProjectionListResponse,
  },
  "GET /api/v1/cap/projections/agency/:periodId": {
    summary: "Agency-aggregate projection snapshot — utilization + band (§4.1)",
    response: CapProjectionSnapshotDto,
  },
  "GET /api/v1/cap/projections/patient/:periodId/:patientId": {
    summary: "Per-patient projection snapshot — contribution + band (§4.1)",
    response: CapProjectionSnapshotDto,
  },
  "GET /api/v1/cap/projections/inpatient/:periodId": {
    summary: "Inpatient (20%) cap utilization — GIP+IRC day count + band (§4.1)",
    response: CapInpatientProjectionDto,
  },
  "POST /api/v1/cap/projections/:periodId/recompute": {
    summary: "Force an immediate projection recompute (cap_period_open ABAC; §4.1)",
    response: CapProjectionListResponse,
  },
  "PATCH /api/v1/cap/threshold-events/:eventId/acknowledge": {
    summary: "Acknowledge a threshold event — records actor + timestamp (does not clear the breach; §4.1)",
    body: CapAcknowledgeEventRequest,
  },
  "POST /api/v1/cap/periods/:periodId/psr-imports": {
    summary: "Upload a PS&R CSV — sha256-deduped, queued for reconciliation (202; §4.1)",
    body: CapPsrImportRequest,
  },
  "PATCH /api/v1/cap/psr-imports/:importId/reconciliation/:lineId/resolve": {
    summary: "Resolve a variance line with a categorical reason + note (§4.1)",
    body: CapResolveVarianceRequest,
  },
  "GET /api/v1/cap/settlements/:periodId": {
    summary: "Settlement worksheet — final paid/cap/overage + owed direction (§4.1)",
    response: CapSettlementDto,
  },
  "POST /api/v1/cap/settlements/:periodId/propose": {
    summary: "Propose a settlement worksheet from current accruals (cap_period_in_settlement ABAC; §4.1)",
    response: CapSettlementDto,
  },
  "PATCH /api/v1/cap/settlements/:periodId/finalize": {
    summary: "Finalize settlement — step-up; in_settlement → settled (D12; M26-F06; §4.1)",
    body: CapFinalizeSettlementRequest,
    response: CapSettlementDto,
  },
  "POST /api/v1/platform/cap/constants": {
    summary: "Publish a CMS per-cap-year cap amount — platform-admin (cap_platform_admin ABAC; D3; §4.1)",
    body: CapPublishConstantRequest,
  },
  "PATCH /api/v1/platform/cap/constants/:capYear": {
    summary: "Amend a published cap amount before first tenant use — platform-admin (D3; §4.1)",
    body: CapAmendConstantRequest,
  },

  // ── M27 Cost Report (Form CMS-1984-14; §4.1) ───────────────────────────────────────────────────────────
  "GET /api/v1/cost-reports": {
    summary: "List cost reports by (ProviderEntity, fiscal year) + lifecycle state (cost_report.read; §4.1)",
    query: CostReportListQuerySchema,
  },
  "POST /api/v1/cost-reports": {
    summary: "Create a cost report for a ProviderEntity + fiscal-year-end (cost_report.create; D1; §4.1)",
    body: CreateCostReportBodySchema,
  },
  "PATCH /api/v1/cost-reports/:id": {
    summary: "Edit cost-report metadata — bad-debt-claimed / wage source; version-checked (cost_report.edit; §4.1)",
    body: PatchCostReportBodySchema,
  },
  "PUT /api/v1/cost-reports/:id/worksheets/:code": {
    summary: "Write a worksheet's TypeBox-validated data jsonb (cost_report.edit; §4.2)",
    body: PutWorksheetBodySchema,
  },
  "POST /api/v1/cost-reports/:id/bad-debt": {
    summary: "Add a Medicare bad-debt entry — deductible/coinsurance (cost_report.edit_bad_debt; D7; §4.1)",
    body: AddBadDebtBodySchema,
  },
  "POST /api/v1/cost-reports/:id/validations/:vid/overrides": {
    summary: "Override a validation result — elevated approval + reason + audit (cost_report.override_validation; §11.B)",
    body: OverrideValidationResultBodySchema,
  },
  "POST /api/v1/cost-reports/:id/approve-for-submit": {
    summary: "Approve a cost report for submission — step-up (cost_report.approve_for_submit; D14; §4.1)",
    body: ApproveForSubmitBodySchema,
  },
  "POST /api/v1/cost-reports/:id/submit": {
    summary: "Submit — step-up + attestation; builds the content-hashed snapshot (cost_report.submit; D10/D14; §4.1)",
    body: SubmitBodySchema,
  },
  "POST /api/v1/cost-reports/:id/reopen": {
    summary: "Reopen a submitted cost report — elevated approval + documented reason (cost_report.reopen_submitted; D19; §4.1)",
    body: ReopenBodySchema,
  },
  "POST /api/v1/cost-reports/:id/ecr-submissions/:sid/acknowledgments": {
    summary: "Record the MCReF acknowledgment / rejection for a submission (cost_report.record_acknowledgment; §4.1)",
    body: RecordAcknowledgmentBodySchema,
  },
  "POST /api/v1/cost-report-validation-rules": {
    summary: "Create a tenant validation rule layered on the platform floor (cost_report.manage_rules; D21; §11.B)",
    body: CreateValidationRuleBodySchema,
  },

  // ── M15 Discipline Care Plans (§4.1) — the four CoP discipline plans, their version/signature ladder,
  // the 418.76(h) aide supervisory attestation and the 418.78 volunteer surface. Org / acting membership
  // binding is server-side (§8.6 S), so NO body or query carries an org or membership id for the actor.
  // Every mutation additionally requires an `Idempotency-Key` (§F08) and every PATCH / state transition an
  // `If-Match` row version (§2.5) — both header contracts enforced by preHandlers, not by a body field.
  // Reads returning the §4.1 view interfaces are omitted rather than sketched (the M26 posture — no
  // fabrication); their params auto-derive from the path.
  "GET /api/v1/discipline-plans": {
    summary: "Discipline-plan worklist — cursor-paginated, filterable by patient/admission/kind/status (§4.1 #1)",
    query: M15PlanListQuerySchema,
  },
  "GET /api/v1/discipline-plans/:planId/versions": {
    summary: "The plan's version chain, cursor-paginated by sequence (§4.1 #4)",
    query: M15VersionListQuerySchema,
  },
  "POST /api/v1/discipline-plans/:planId/versions/:versionId/finalize": {
    summary:
      "Finalize a draft version — seals the state snapshot and freezes the D11 quorum, which a tenant may tighten but never loosen (§4.1 #6)",
    body: M15FinalizeVersionBody,
  },
  "POST /api/v1/discipline-plans/:planId/versions/:versionId/sign": {
    summary:
      "Sign one slot of the sealed quorum — step-up; the last signature flips the version to signed and triggers the plan-PDF render (§4.1 #7)",
    body: M15SignVersionBody,
  },
  "POST /api/v1/discipline-plans/:planId/goals": {
    summary: "Author a discipline goal refining an IPOC problem (§4.1 #8)",
    body: M15CreateGoalBody,
  },
  "PATCH /api/v1/discipline-plans/:planId/goals/:goalId": {
    summary:
      "Edit a goal — a status event and/or the refinement fields; `originalText` is immutable (§2.3; §4.1 #9)",
    body: M15UpdateGoalBody,
  },
  "POST /api/v1/discipline-plans/:planId/interventions": {
    summary: "Author a discipline intervention (§4.1 #10)",
    body: M15CreateInterventionBody,
  },
  "PATCH /api/v1/discipline-plans/:planId/interventions/:interventionId": {
    summary: "Edit an intervention — discontinue (reason required) / complete / refine (§4.1 #11)",
    body: M15UpdateInterventionBody,
  },
  "POST /api/v1/discipline-plans/:planId/assessments": {
    summary:
      "Capture a discipline assessment (draft); `data` is validated against the per-kind schema, and the SUD / family-violence flags drive every later read's SQL filter (§4.1 #12)",
    body: M15CreateAssessmentBody,
  },
  "POST /api/v1/discipline-plans/:planId/assessments/:assessmentId/amend": {
    summary:
      "Amend a signed assessment — append-only correction of record; the superseded row is retained (§4.1 #14)",
    body: M15AmendAssessmentBody,
  },
  "POST /api/v1/discipline-plans/:planId/aide-supervisory-visits": {
    summary:
      "Record an RN supervisory attestation (42 CFR §418.76(h)); a null sourceEncounterId is a phone-only contact and does NOT re-arm the 14-day clock (§4.1 #15)",
    body: M15CreateSupervisoryVisitBody,
  },
  "POST /api/v1/discipline-plans/:planId/volunteer-assignments": {
    summary:
      "Create a volunteer assignment — the 418.78 gate check runs unless a documented overrideReason is supplied (§8.6; §4.1 #17)",
    body: M15CreateVolunteerAssignmentBody,
  },
  "PATCH /api/v1/discipline-plans/:planId/volunteer-assignments/:assignmentId": {
    summary:
      "Edit / acknowledge / inactivate / reactivate an assignment — reactivation is always manual (§7.5; §4.1 #18)",
    body: M15UpdateVolunteerAssignmentBody,
  },
  "GET /api/v1/volunteer-compliance-gates": {
    summary:
      "Volunteer compliance-gate worklist — cursor-paginated; status is re-derived over the validity window as of now (§2.2.6; §4.1 #19)",
    query: M15GateListQuerySchema,
  },
  "POST /api/v1/volunteer-compliance-gates": {
    summary: "Record a 42 CFR §418.78(b)/(d) compliance gate for a volunteer (§4.1 #20)",
    body: M15CreateVolunteerGateBody,
  },
  "PATCH /api/v1/volunteer-compliance-gates/:gateId": {
    summary: "Correct a recorded gate's validity window / evidence (§4.1 #21)",
    body: M15UpdateVolunteerGateBody,
  },
  "POST /api/v1/volunteer-compliance-gates/:gateId/revoke": {
    summary: "Revoke a satisfied gate — reason required; cascades the volunteer to inactive (§4.1 #22)",
    body: M15RevokeVolunteerGateBody,
  },
  "GET /api/v1/volunteer-hour-ratio": {
    summary:
      "The 418.78(e) 5% ratio for one provider entity × fiscal year; an unbound cost basis returns `unavailable` with its reason, never a 0% breach (§7.6; §4.1 #23)",
    query: M15HourRatioQuerySchema,
  },
  "POST /api/v1/volunteer-hour-entries": {
    summary:
      "Record an audited manual hour adjustment — the only ledger path that may carry negative minutes (§4.1 #24)",
    body: M15CreateHourEntryBody,
  },
  "GET /internal/discipline-plans/relevant-elements": {
    summary: "System-principal seam — discipline goals/interventions for a patient's plans (§4.1 #25)",
    query: M15RelevantElementsQuerySchema,
  },
  "GET /internal/discipline-plans/msw-risk-factors": {
    summary: "System-principal seam — MSW psychosocial risk factors for an admission (M16; §4.1 #26)",
    query: M15RiskFactorQuerySchema,
  },
  "GET /internal/discipline-plans/volunteer-effective-status": {
    summary:
      "System-principal seam — a volunteer's effective 418.78 status; fail-CLOSED (an unreadable gate store answers not-active; §4.1 #27)",
    query: M15VolunteerStatusQuerySchema,
  },
  "GET /internal/discipline-plans/supervisory-cadence": {
    summary: "System-principal seam — the supervisory-cadence worklist for a scope (M17/M14; §4.1 #28)",
    query: M15SupervisoryCadenceQuerySchema,
  },

  // ── M16 Bereavement (§4.1) — the 42 CFR §418.64(d) 13-month survivor-follow-up program: the plan
  // ladder, the per-survivor lifecycle, the D4 touchpoint book, the D3/D17 risk ledger and the two
  // dashboards. Org / acting membership binding is server-side (§6.1's boundary spoofing control), so NO
  // body or query carries an org id or an acting membership id. Every mutation additionally requires an
  // `Idempotency-Key` (ADR-0021) and every state transition an `If-Match` row version (§2.5) — both
  // header contracts enforced by preHandlers, not by a body field. Reads returning the §4.1 view
  // interfaces are omitted rather than sketched (the M15/M26 no-fabrication posture); their params
  // auto-derive from the path.
  "GET /api/v1/bereavement/plans": {
    summary:
      "Bereavement plan worklist — cursor-paginated; the counselor's own caseload by default, widened by the filters for an oversight role (§4.1 #1)",
    query: M16PlanListQuerySchema,
  },
  "POST /api/v1/bereavement/plans/:planId/assign-counselor": {
    summary: "Assign the bereavement counselor — eligible → initiating (§4.1 #3)",
    body: M16AssignCounselorBody,
  },
  "POST /api/v1/bereavement/plans/:planId/assign-volunteer": {
    summary:
      "Assign a bereavement volunteer — the 42 CFR §418.78 gates resolve through Module 15's compliance seam, never the body (§4.1 #4)",
    body: M16AssignVolunteerBody,
  },
  "POST /api/v1/bereavement/plans/:planId/seed-roster-and-schedule": {
    summary:
      "Seed the survivor roster from M5 and materialize the D4 platform-floor schedule — initiating → active (§4.1 #5)",
    body: M16SeedRosterAndScheduleBody,
  },
  "POST /api/v1/bereavement/plans/:planId/pause": {
    summary:
      "Pause the plan — cancels every future-dated touchpoint; a recorded reason is mandatory, because a pause without one is a lapse (§4.1 #6)",
    body: M16PausePlanBody,
  },
  "POST /api/v1/bereavement/plans/:planId/resume": {
    summary:
      "Resume the plan — regenerates the schedule FROM NOW; a touchpoint whose due date passed during the pause is not resurrected as a backdated obligation (§4.1 #7)",
    body: M16ResumePlanBody,
  },
  "POST /api/v1/bereavement/plans/:planId/close-early": {
    summary:
      "D7 early close — step-up; ≥40-char narrative; lands the closure row awaiting the supervisor cosign (§4.1 #8)",
    body: M16CloseEarlyBody,
  },
  "POST /api/v1/bereavement/plans/:planId/cosign-close": {
    summary:
      "The clinical-supervisor cosign that ratifies an early close — step-up; the cosigner is the server-assembled acting membership (§4.1 #9)",
    body: M16CosignCloseBody,
  },
  "GET /api/v1/bereavement/plans/:planId/outreach": {
    summary: "The plan's touchpoints, scheduled and historical, cursor-paginated (§4.1 #19)",
    query: M16OutreachListQuerySchema,
  },
  "POST /api/v1/bereavement/plans/:planId/regenerate-schedule": {
    summary:
      "Regenerate the FORWARD outreach book — whole plan or one survivor; never writes a backdated obligation (§4.1 #27)",
    body: M16RegenerateScheduleBody,
  },
  "POST /api/v1/bereavement/plans/:planId/recompute-risk": {
    summary:
      "Recompute the deterministic D3/D17 risk score (Layer 2 narrative only when the platform's full-AI capability is on) — ALWAYS an append; the ledger refuses UPDATE (§4.1 #28)",
    body: M16RecomputeRiskBody,
  },
  "GET /api/v1/bereavement/plans/:planId/risk-scores": {
    summary: "The append-only risk-score ledger — per-survivor and plan-level, newest first (§4.1 #29)",
    query: M16RiskScoreListQuerySchema,
  },
  "POST /api/v1/bereavement/plans/:planId/initiate-contact": {
    summary:
      "The counselor's FIRST contact — D18-gated: an external-source plan awaiting its medical-director cosign is refused with the machine-readable gate reason, not a bare 403 (§4.1 #33)",
    body: M16InitiateContactBody,
  },
  "POST /api/v1/bereavement/plans/:planId/contacts": {
    summary: "Add a bereaved contact to an open plan — lands `proposed` (§4.1 #11)",
    body: M16CreateContactBody,
  },
  "PATCH /api/v1/bereavement/contacts/:contactId": {
    summary:
      "Update a survivor's preferences / channels — `If-Match` required, because a blind overwrite could send a condolence letter to an address the family already corrected (§4.1 #12)",
    body: M16UpdateContactBody,
  },
  "POST /api/v1/bereavement/contacts/:contactId/confirm": {
    summary:
      "Confirm a survivor — proposed → active; the M39 consent verdict is resolved server-side and fails CLOSED (§4.1 #13)",
    body: M16ConfirmContactBody,
  },
  "POST /api/v1/bereavement/contacts/:contactId/opt-out": {
    summary:
      "Record a per-survivor opt-out (D9) — staff, or the survivor's own portal session; `m39_revocation_cascade` is never accepted from the wire (§4.1 #14)",
    body: M16OptOutBody,
  },
  "POST /api/v1/bereavement/contacts/:contactId/rescind-opt-out": {
    summary:
      "Undo an opt-out — the D9 90-day window binds the self-service path; a counselor rescind must say why (§4.1 #15)",
    body: M16RescindOptOutBody,
  },
  "POST /api/v1/bereavement/contacts/:contactId/mark-deceased": {
    summary:
      "Mark the survivor deceased — the lifecycle's only terminal state, so the verified date and its source are both required (§4.1 #16)",
    body: M16MarkDeceasedBody,
  },
  "POST /api/v1/bereavement/contacts/:contactId/mark-unreachable": {
    summary:
      "Accept the nightly three-strikes proposal — the threshold is enforced by the lifecycle machine, so an early call is refused (§4.1 #17)",
    body: M16MarkUnreachableBody,
  },
  "POST /api/v1/bereavement/contacts/:contactId/flag-complicated-grief": {
    summary:
      "§7.7 complicated-grief escalation — ends the program for this survivor and routes them to the named M40 resource, which is REQUIRED (§4.1 #18)",
    body: M16FlagComplicatedGriefBody,
  },
  "POST /api/v1/bereavement/contacts/:contactId/log-direct": {
    summary:
      "Log an ad-hoc contact with no scheduled outreach — the kind must be one the survivor allows, stricter than the schedule generator (§4.1 #26)",
    body: M16LogDirectContactBody,
  },
  "POST /api/v1/bereavement/contacts/:contactId/refer-external": {
    summary:
      "Log an M40 external-resource referral WITHOUT ending the program — a different clinical fact from the §7.7 escalation (§4.1 #32)",
    body: M16ReferExternalBody,
  },
  "POST /api/v1/bereavement/outreach/:outreachId/start": {
    summary: "Start a touchpoint — scheduled → in_progress (§4.1 #20)",
    body: M16StartOutreachBody,
  },
  "POST /api/v1/bereavement/outreach/:outreachId/complete": {
    summary:
      "Complete a touchpoint, writing its contact log in the SAME transaction. D15: the in-person branch REQUIRES the M8 encounter and every other kind must NOT carry one (§4.1 #21)",
    body: M16CompleteOutreachBody,
  },
  "POST /api/v1/bereavement/outreach/:outreachId/decline": {
    summary:
      "The survivor declined THIS touchpoint — not an opt-out: the forward schedule continues untouched (§4.1 #22)",
    body: M16OutreachOutcomeBody,
  },
  "POST /api/v1/bereavement/outreach/:outreachId/no-response": {
    summary: "No response after retries — feeds the three-strikes unreachable proposal (§4.1 #23)",
    body: M16OutreachOutcomeBody,
  },
  "POST /api/v1/bereavement/outreach/:outreachId/cancel": {
    summary: "Cancel a scheduled touchpoint — a reason is mandatory (§4.1 #24)",
    body: M16CancelOutreachBody,
  },
  "POST /api/v1/bereavement/outreach/:outreachId/late-attempt": {
    summary:
      "Re-open a missed touchpoint inside the 7-day late grace — audit-flagged, but NOT a compliance failure (§4.1 #25)",
    body: M16LateAttemptBody,
  },
  "GET /api/v1/bereavement/dashboard/counselor": {
    summary:
      "The caller's OWN bereavement caseload plus what is due in N days — the counselor id comes from the session, never a query param (§4.1 #30)",
    query: M16CounselorDashboardQuerySchema,
  },
  "GET /api/v1/bereavement/dashboard/supervisor": {
    summary:
      "Full-tenant bereavement rollups, optionally narrowed to one CCN / location — COUNTS, never rates (§4.1 #31)",
    query: M16SupervisorDashboardQuerySchema,
  },

  // ── M19 On-Call Triage (§4.1) — the §2.2.1 call machine, the D5 server-gated protocol walk, the D7
  // escalation ladder, the CoP 418.100(c)(2) shift roster, the D4 two-layer protocol catalog, the tenant
  // policy, the §8.5 vendor bindings and the §2.7 BCP paper re-entry. Org, acting membership and vendor
  // identity are ALL server-side (routes/actor.ts), so no body or query carries any of them — the ONE
  // membership id a caller may supply is `escalatedToMembershipId`, because an escalation is by definition
  // addressed to a second person. Every mutation additionally requires an `Idempotency-Key` (ADR-0021) and
  // every state transition an `If-Match` carrying the row's INTEGER `version` (§2.5, unlike M21's
  // timestamp ETag); both are header contracts enforced by preHandlers, not body fields. Reads returning
  // the §4.1 view interfaces are omitted rather than sketched (the M15/M16/M21/M26 no-fabrication
  // posture); their params auto-derive from the path.
  "POST /api/v1/triage-calls": {
    summary:
      "Open a triage call — `source` is pinned to `manual` and the covering shift is resolved server-side, because attributing a call to somebody else's coverage window would forge the CoP 418.100(c)(2) record (§4.1 #1)",
    body: M19OpenTriageCallBody,
  },
  "GET /api/v1/triage-calls": {
    summary:
      "The supervisor board / caseload list — cursor-paginated (offset is refused); `openOnly` is the six-state live set, which deliberately includes `documented_pending_encounter` (§4.1 #2)",
    query: M19ListTriageCallsQuery,
  },
  "POST /api/v1/triage-calls/:triageCallId/identify-patient": {
    summary:
      "Resolve the caller to a served person — patient AND admission together, because M8's encounter creator requires both NOT NULL (§4.1 #4)",
    body: M19IdentifyPatientBody,
  },
  "POST /api/v1/triage-calls/:triageCallId/apply-protocol": {
    summary:
      "Pin the protocol (D4) and, when the catalog row demands it, write the D7 mandatory escalation in the SAME transaction; `aiOverrideReason` is required only above the §8.6 confidence floor (§4.1 #5)",
    body: M19ApplyProtocolBody,
  },
  "POST /api/v1/triage-calls/:triageCallId/answers": {
    summary:
      "Append one answer — a DISCRIMINATED value union, so 'exactly one typed value' is a 422 at the boundary rather than a CHECK violation from the driver; `red_flag_hit` is absent because D5 makes it the server's (§4.1 #6)",
    body: M19RecordAnswerBody,
  },
  "PATCH /api/v1/triage-calls/:triageCallId/answers/:answerId/correct": {
    summary:
      "Append a CORRECTION (§2.2.3 amend-by-append) — the original row is preserved, because a 'no' later corrected to 'yes' means the call HAD a red flag (§4.1 #7)",
    body: M19CorrectAnswerBody,
  },
  "POST /api/v1/triage-calls/:triageCallId/awaiting-callback": {
    summary:
      "Park the call on a callback; it stays in the open set so it keeps its place on the supervisor board while the SLA detector watches the clock (§4.1 #9)",
    body: M19AwaitingCallbackBody,
  },
  "POST /api/v1/triage-calls/:triageCallId/disposition": {
    summary:
      "Select the disposition (D6) over the PUBLISHED `TriageDispositionData` union — one route for both §2.2.1 edges into `documented_pending_encounter` (§4.1 #11)",
    body: M19SelectDispositionBody,
  },
  "POST /api/v1/triage-calls/:triageCallId/document": {
    summary:
      "Invoke M8's `EncounterCreator` (D8). The call does NOT reach `documented` here — that transition belongs to the `m8.encounter.signed` consumer (§4.1 #12)",
    body: M19DocumentCallBody,
  },
  "POST /api/v1/triage-calls/:triageCallId/abandon": {
    summary:
      "The caller disconnected. A mandatory escalation still blocks: 'the caller hung up' is not an answer to 'did a human respond to the suicidal-ideation page?' (§4.1 #13)",
    body: M19AbandonCallBody,
  },
  "POST /api/v1/triage-calls/paper-reentry": {
    summary:
      "§2.7 BCP paper-origin re-entry — its own permission plus a step-up, because the back-dated `opened_at` is §8.3.2's way a coverage gap gets hidden; the instant is range-checked against the worklist row's outage window",
    body: M19PaperReentryBody,
  },
  "POST /api/v1/triage-calls/:triageCallId/escalations": {
    summary:
      "Raise an escalation on a call — gated by the CALL's predicate, not the escalation ones, because the actor raising the page is the clinician working the call (§4.1 #15)",
    body: M19EscalateBody,
  },
  "GET /api/v1/escalations": {
    summary:
      "The escalation inbox, narrowed server-side to the actor's tier band; `openOnly` defaults TRUE because an inbox shows what is outstanding (§4.1 #16)",
    query: M19ListEscalationsQuery,
  },
  "POST /api/v1/escalations/:escalationId/acknowledge": {
    summary:
      "Acknowledge — the write §7.2 waits on; until it lands the call may take no disposition but the hand-off (§4.1 #17)",
    body: M19AcknowledgeEscalationBody,
  },
  "POST /api/v1/escalations/:escalationId/resolve": {
    summary:
      "Resolve with the escalated party's own account (≥ 30 chars) — the ONLY place a MANDATORY row can reach `resolved` (§2.2.4 / §4.1 #18)",
    body: M19ResolveEscalationBody,
  },
  "GET /api/v1/oncall/shifts": {
    summary: "The on-call schedule, cursor-paginated (§4.1 #19)",
    query: M19ListShiftsQuery,
  },
  "POST /api/v1/oncall/shifts": {
    summary:
      "Manual shift create — `policySnapshot` is NOT a body field: D7 pins it from the tenant policy at activation, and a caller-supplied snapshot would be a caller-supplied answer to 'which ladder was in effect that night' (§4.1 #20)",
    body: M19CreateShiftBody,
  },
  "PATCH /api/v1/oncall/shifts/:shiftId/cancel": {
    summary:
      "Cancel with a reason. No outbox event: a shift that never activated was never in M36's `on_call` channel, so the hole it leaves is the coverage-gap watchdog's finding (§4.1 #21)",
    body: M19CancelShiftBody,
  },
  "POST /api/v1/oncall/shifts/:shiftId/open": {
    summary:
      "Manual 'go on shift' — pins the D7 policy snapshot and emits the single canonical shift-open topic M36's synchronizer and M20's SOS path both subscribe to (§4.1 #22)",
    body: M19ShiftTransitionBody,
  },
  "POST /api/v1/oncall/shifts/:shiftId/close": {
    summary:
      "Manual close — removes the departing actor from M36's channel; messages sent during their tenure stay attributed to them (§4.1 #23)",
    body: M19ShiftTransitionBody,
  },
  "GET /api/v1/oncall/current": {
    summary:
      "Who is on call NOW, keyed PER ProviderEntity and never unioned — CoP 418.100(c)(2) is per-CCN, and `actors: []` for an entity is a REAL answer (a coverage gap), not an empty result (§4.1 #24)",
    query: M19CurrentOnCallQuery,
  },
  "GET /api/v1/oncall/policy": {
    summary:
      "The tenant on-call policy for one ProviderEntity. NOT auto-created on read: a default invented at read time would be pinned onto shifts as though the tenant had chosen it (§4.1 #25)",
    query: M19PolicyQuery,
  },
  "PATCH /api/v1/oncall/policy": {
    summary:
      "Edit the policy (step-up) — a `hybrid`/`centralized` selection where the D3 flag is off is REFUSED rather than accepted-and-ignored, so a tenant can never believe a vendor is answering their nights (§4.1 #26)",
    body: M19PatchOncallPolicyBody,
    query: M19PolicyQuery,
  },
  "GET /api/v1/triage-protocols": {
    summary:
      "The catalog — the org-less platform floor plus this tenant's own rows (D4), effective-dated by default (§4.1 #27)",
    query: M19ListProtocolsQuery,
  },
  "POST /api/v1/triage-protocols": {
    summary:
      "Author a TENANT-CUSTOM protocol (step-up). `isSystemLocked` is absent: accepting and ignoring it would leave the DON believing they had authored a protected question (§4.1 #29)",
    body: M19CreateProtocolBody,
  },
  "PATCH /api/v1/triage-protocols/:protocolId": {
    summary:
      "Edit a tenant protocol — a platform-floor row is refused with its key NAMED, because '0 rows updated' is not an answer a DON can act on (§4.1 #30)",
    body: M19PatchProtocolBody,
  },
  "POST /api/v1/triage-protocols/:protocolId/questions": {
    summary:
      "Add a question — a tenant cannot write a child row against an org-less parent, so the attempt is refused with the protocol named rather than failing as a policy violation (§4.1 #31)",
    body: M19ProtocolQuestionBody,
  },
  "PATCH /api/v1/triage-protocol-questions/:questionId": {
    summary:
      "Edit one question — a system-locked question is refused: it is the D5 red-flag predicate behind a platform-floor mandatory escalation, and editing it is the cheapest way to disable one (§4.1 #32)",
    body: M19PatchProtocolQuestionBody,
  },
  "POST /api/v1/oncall/external-vendors": {
    summary:
      "Create a vendor binding (step-up). The BAA is a PRECONDITION, and there is deliberately NO secret field — ADR-0026 puts vendor credentials in the platform secret store, and the absence of the field is the control (§4.1 #34)",
    body: M19CreateVendorBindingBody,
  },
  "PATCH /api/v1/oncall/external-vendors/:vendorId": {
    summary:
      "BAA renewal updates only — the narrow request shape IS the rule: changing the adapter key or the minimization profile would silently re-point live PHI at a different contract (§4.1 #35)",
    body: M19PatchVendorBindingBody,
  },
  "GET /api/v1/portal/triage/recent": {
    summary:
      "The M31 portal projection — lay-language, caregiver-scoped, with the D11 advisory and the D13 vendor-handoff details excluded BY CONSTRUCTION rather than by filtering (§4.1 #36)",
    query: M19PortalRecentQuery,
  },
  // ── M21 Supplies, DME & Comfort Kits (§4.1) — the §2.2 fulfillment machine, the D11 SKU catalog, the D3
  // kit templates, the DEA 21 CFR §1304 dispatch/return chain of custody, the D4 vendor-routing ladder and
  // the D5 par shelf. Org / acting membership binding is server-side (routes/actor.ts is the DEA
  // chain-of-custody control at the boundary), so NO body or query carries an org id or an acting
  // membership id — the ONE exception is the reconciliation's disposal WITNESS, who is by definition a
  // second person. Every mutation additionally requires an `Idempotency-Key` (ADR-0021) and every state
  // transition an `If-Match` carrying the row's `updated_at` (§7.2 — M21's tables have no version counter);
  // both are header contracts enforced by preHandlers, not body fields. Reads returning the §4.1 view
  // interfaces are omitted rather than sketched (the M15/M16/M26 no-fabrication posture); their params
  // auto-derive from the path.
  "POST /api/v1/supplies/supply-requests": {
    summary:
      "Create a DME / supply / comfort-kit request — the §4.4 dispatcher predicate applies CONDITIONALLY, only when the kind is a comfort-kit deploy (§4.1 #1)",
    body: M21CreateSupplyRequestBody,
  },
  "GET /api/v1/supplies/supply-requests": {
    summary:
      "The supply-team worklist — cursor-paginated; `openOnly` narrows to the §2.2 non-terminal set, which is the dashboard's default view (§4.1 #2)",
    query: M21ListSupplyRequestsQuery,
  },
  "POST /api/v1/supplies/supply-requests/:supplyRequestId/assign-vendor": {
    summary:
      "D4 vendor override — the ladder still runs and the override is recorded ON TOP of its trace, so the record shows both the rules evaluated and the human decision that overrode them (§4.1 #4)",
    body: M21AssignVendorBody,
  },
  "POST /api/v1/supplies/supply-requests/:supplyRequestId/mark-ordered": {
    summary:
      "The vendor accepted — Phase-1 portal/email/fax entry, Phase-2 the EDI 855 acknowledgment (§4.1 #5)",
    body: M21MarkOrderedBody,
  },
  "POST /api/v1/supplies/supply-requests/:supplyRequestId/mark-in-transit": {
    summary: "Shipment identifiers — Phase-1 manual, Phase-2 the EDI 856 ASN (§4.1 #6)",
    body: M21MarkInTransitBody,
  },
  "POST /api/v1/supplies/supply-requests/:supplyRequestId/mark-delivered": {
    summary:
      "D7 courier attestation — the delivering membership is stamped from the SESSION and is not a body field: a courier who could name someone else has attested to nothing (§4.1 #7)",
    body: M21MarkDeliveredBody,
  },
  "POST /api/v1/supplies/supply-requests/:supplyRequestId/confirm-received": {
    summary:
      "Caregiver / clinician receipt confirmation — `system_auto_confirm` is NOT accepted here, it is the 72h fallback the worker writes (§4.1 #8)",
    body: M21ConfirmReceivedBody,
  },
  "POST /api/v1/supplies/supply-requests/:supplyRequestId/cancel": {
    summary:
      "Cancel — ONE route for both §2.2 edges: immediate before `ordered`, two-phase after, so a caller never has to know which side of the vendor handshake the row sits on (§4.1 #9)",
    body: M21CancelRequestBody,
  },
  "POST /api/v1/supplies/supply-requests/:supplyRequestId/return": {
    summary:
      "Initiate an equipment return — the kit-only §2.2 `returned` branch; DME comes back through the M11 rental-pickup path instead (§4.1 #10)",
    body: M21ReturnRequestBody,
  },
  "GET /api/v1/supplies/supply-items": {
    summary: "The D11 SKU catalog — the platform rows UNION the tenant overlay, one browsable list (§4.1 #11)",
    query: M21ListSupplyItemsQuery,
  },
  "POST /api/v1/supplies/supply-items": {
    summary:
      "Create a canonical HCPCS-keyed SKU — PLATFORM-ONLY: `supply_item` carries no organization_id, so the permission is the first gate and the wardenx_admin-only write policy is the backstop (§4.1 #12)",
    body: M21CreateSupplyItemBody,
  },
  "POST /api/v1/supplies/supply-items/:id/retire": {
    summary:
      "Retire a canonical SKU — effective-dating, never deletion: a retired HCPCS code must keep resolving for every historical request written against it (§4.1 #14)",
    body: M21RetireSupplyItemBody,
  },
  "POST /api/v1/supplies/tenant-supply-items": {
    summary: "Create a tenant-local, non-billable overlay item (D11's tenant half; §4.1 #15)",
    body: M21UpsertTenantSupplyItemBody,
  },
  "PUT /api/v1/supplies/tenant-supply-items/:id": {
    summary: "Edit a tenant-local overlay item (§4.1 #16)",
    body: M21UpsertTenantSupplyItemBody,
  },
  "GET /api/v1/supplies/comfort-kit-templates": {
    summary:
      "The §2.3 comfort-kit templates — `includePlatformFloor` defaults ON so the admin screen shows the D3 floor row as locked; a picker passes false (§4.1 #17)",
    query: M21ListTemplatesQuery,
  },
  "POST /api/v1/supplies/comfort-kit-templates": {
    summary:
      "Author a tenant template — the D3 floor validation runs BEFORE anything is written, so a template that drops below the floor never exists even transiently (§4.1 #18)",
    body: M21CreateTemplateBody,
  },
  "PUT /api/v1/supplies/comfort-kit-templates/:templateId": {
    summary:
      "Supersede a template — this INSERTS a new row pointing back through `replaces_template_id` rather than patching, so a dispatch from three months ago still resolves the recipe it actually used (§4.1 #19)",
    body: M21SupersedeTemplateBody,
  },
  "POST /api/v1/supplies/comfort-kit-dispatches": {
    summary:
      "Dispatch a comfort kit — the DEA 21 CFR §1304 outbound log entry: §4.4's dispatcher predicate plus a step-up gate, and the §2.5 refusals, shelf decrement and per-line log all in ONE transaction (§4.1 #20)",
    body: M21CreateDispatchBody,
  },
  "GET /api/v1/supplies/comfort-kit-dispatches": {
    summary:
      "Dispatch list — per patient, per Location, or per IPU room for the D17 stock-kit view (§4.1 #21)",
    query: M21ListDispatchesQuery,
  },
  "POST /api/v1/supplies/comfort-kit-dispatches/:dispatchId/deploy-at-patient": {
    summary:
      "The kit is physically at the patient — the event M13 builds its deployment rows FROM, so the emitted payload carries the whole manifest rather than making M13 read back (§4.1 #23)",
    body: M21DeployAtPatientBody,
  },
  "POST /api/v1/supplies/comfort-kit-returns": {
    summary:
      "Open a return obligation — refused until M13 has acked the deployment, because a return with nothing to close is a count nobody can reconcile (§4.1 #24)",
    body: M21CreateReturnBody,
  },
  "GET /api/v1/supplies/comfort-kit-returns": {
    summary:
      "The reconciliation worklist — OLDEST due first, with `daysOverdue` computed at read time from `return_due_at` (§4.1 #25)",
    query: M21ListReturnsQuery,
  },
  "POST /api/v1/supplies/comfort-kit-returns/:returnId/assign-retriever": {
    summary:
      "Assign the supply-team member who will physically retrieve — §4.4's separation-of-duties clause compares them against the witness (§2.6)",
    body: M21AssignRetrieverBody,
  },
  "POST /api/v1/supplies/comfort-kit-returns/:returnId/reconcile": {
    summary:
      "Reconcile the physical count — step-up plus the reconciler predicate whose FIRST clause is separation of duties; the D8 discrepancy is COMPUTED from the quantities and never accepted from the body (§4.1 #27)",
    body: M21ReconcileReturnBody,
  },
  "POST /api/v1/supplies/comfort-kit-returns/:returnId/declare-unreturnable": {
    summary:
      "The 90-day assumption of loss — deliberately NOT folded into reconcile: writing off a kit that held a CII solution is a different authority from counting one that came back (§2.6)",
    body: M21DeclareUnreturnableBody,
  },
  "GET /api/v1/supplies/vendor-routing-rules": {
    summary:
      "The D4 ladder, most-specific first — the platform-scope rows come back for every tenant via the table's own floor-plus-overlay policy (§4.1 #28)",
    query: M21ListRoutingRulesQuery,
  },
  "POST /api/v1/supplies/vendor-routing-rules": {
    summary:
      "Author a routing rule — `platform` scope is absent from the union by design: a tenant may never author one, and the RLS write policy would refuse it anyway (§4.1 #29)",
    body: M21UpsertRoutingRuleBody,
  },
  "PUT /api/v1/supplies/vendor-routing-rules/:ruleId": {
    summary: "Edit a routing rule (§4.1 #30)",
    body: M21UpsertRoutingRuleBody,
  },
  "GET /api/v1/supplies/par-stock": {
    summary:
      "The hub shelf — `severity` is DERIVED per row and never stored, because a stored band goes stale the moment a threshold is edited (§4.1 #32)",
    query: M21ListParStockQuery,
  },
  "PUT /api/v1/supplies/par-stock/:parStockId": {
    summary:
      "Edit the par thresholds — the boundary mirrors §3.1.6's ordering CHECK, so an inverted pair is a field-anchored 422 rather than a 500 out of PostgreSQL (§4.1 #33)",
    body: M21UpdateParStockBody,
  },
  "POST /api/v1/supplies/par-stock/observe": {
    summary:
      "Record an on-hand count — this SETS the shelf rather than adjusting it, and the nightly cron (not this route) is the canonical emitter of the below-threshold alert (§4.1 #34)",
    body: M21ObserveParStockBody,
  },
};
