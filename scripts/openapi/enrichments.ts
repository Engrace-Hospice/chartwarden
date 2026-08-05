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
  AuthContextResponseSchema as M2AuthContextResponseSchema,
  CollaboratorConsumeRequestSchema as M2CollaboratorConsumeRequestSchema,
  CollaboratorConsumeResponseSchema as M2CollaboratorConsumeResponseSchema,
  CollaboratorInviteRequestSchema as M2CollaboratorInviteRequestSchema,
  CollaboratorInviteResponseSchema as M2CollaboratorInviteResponseSchema,
  InvitationAcceptRequestSchema as M2InvitationAcceptRequestSchema,
  InvitationAcceptedResponseSchema as M2InvitationAcceptedResponseSchema,
  InvitationCreatedResponseSchema as M2InvitationCreatedResponseSchema,
  InvitationListResponseSchema as M2InvitationListResponseSchema,
  InvitationPeekResponseSchema as M2InvitationPeekResponseSchema,
  InvitationRescindedResponseSchema as M2InvitationRescindedResponseSchema,
  InvitationResendRequestSchema as M2InvitationResendRequestSchema,
  InvitationResendResponseSchema as M2InvitationResendResponseSchema,
  MemberPatchRequestSchema as M2MemberPatchRequestSchema,
  MemberRevokedResponseSchema as M2MemberRevokedResponseSchema,
  MembersListQuerySchema as M2MembersListQuerySchema,
  MembersListResponseSchema as M2MembersListResponseSchema,
  MembershipListResponseSchema as M2MembershipListResponseSchema,
  MembershipViewSchema as M2MembershipViewSchema,
  OrgBindingResponseSchema as M2OrgBindingResponseSchema,
  OrgInvitationCreateRequestSchema as M2OrgInvitationCreateRequestSchema,
  SelectOrganizationRequestSchema as M2SelectOrganizationRequestSchema,
  StepUpInitiateRequestSchema as M2StepUpInitiateRequestSchema,
  StepUpInitiateResponseSchema as M2StepUpInitiateResponseSchema,
  StepUpVerifyRequestSchema as M2StepUpVerifyRequestSchema,
  StepUpVerifyResponseSchema as M2StepUpVerifyResponseSchema,
  UserDeactivateRequestSchema as M2UserDeactivateRequestSchema,
  UserDeactivatedResponseSchema as M2UserDeactivatedResponseSchema,
} from "../../apps/backend/src/modules/02-identity/routes/identity-typebox";
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
// M6 Admission — the §4.2 request bodies/queries the handlers `parse(...)` + the §4.2 response DTOs
// (pinned to the service read views by compile-time `Conforms` aliases in admission-typebox.ts).
import {
  AdmissionActivateSchema,
  AdmissionCreateSchema,
  AdmissionDetailResponseSchema,
  AdmissionHoldSchema,
  AdmissionListQuerySchema,
  AdmissionResumeSchema,
  AdmissionUpdateSchema,
  CtiDraftSchema,
  CtiMarkLateSchema,
  CtiSignSchema,
  CtiVoidSchema,
  DischargeCosignSchema,
  DischargeCreateSchema,
  ElectionPeriodCreateSchema,
  ElectionPeriodPatchSchema,
  ElectionSignSchema,
  ElectionStatementDraftSchema,
  ElectionVoidSchema,
  F2fAttestSchema,
  F2fCompleteSchema,
  F2fOverrideWindowSchema,
  F2fScheduleSchema,
  LocChangeSchema,
  LocConfirmBedSchema,
  LocPatchSchema,
  ComplianceCloseSchema as M6ComplianceCloseSchema,
  ComplianceListQuerySchema as M6ComplianceListQuerySchema,
  ComplianceOverrideSchema as M6ComplianceOverrideSchema,
  SummaryItemsResponseSchema as M6SummaryItemsResponseSchema,
  SummaryPageResponseSchema as M6SummaryPageResponseSchema,
  SummaryRowResponseSchema as M6SummaryRowResponseSchema,
  NorAcknowledgeSchema,
  PatientElectionCertificationResponseSchema,
  ReferralAcceptResponseSchema,
  ReferralAcceptSchema,
  ReferralCreateSchema,
  ReferralDeclineSchema,
  ReferralListQuerySchema,
  ReferralTriageSchema,
  ReferralUpdateSchema,
  RevocationCreateSchema,
  TransferInSchema,
  TransferOutSchema,
} from "../../apps/backend/src/modules/06-admission/routes/admission-typebox";
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
  PatientIdgHistoryResponseSchema as IdgPatientHistoryResponseSchema,
  ScheduleListResponseSchema as IdgScheduleListResponseSchema,
  ScheduleQuerySchema as IdgScheduleQuerySchema,
} from "../../apps/backend/src/modules/14-idg/routes/idg-typebox";
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
// M20 Field Safety — the §4.2 request bodies + list queries the §4.1 handlers `parse(...)` /
// `parseQuery(...)`. Same exported schemas as the validator, so the published contract cannot drift
// from what the boundary actually enforces. Only the 25 routes that take a body or a query appear
// below; the five that carry neither (the by-id reads and `/sos/active`) are path-params only and
// the emitter derives those from the path.
import {
  AcknowledgeSosBody as M20AcknowledgeSosBody,
  AmendCheckInBody as M20AmendCheckInBody,
  CancelSosBody as M20CancelSosBody,
  CheckInListQuery as M20CheckInListQuery,
  ConsentQuery as M20ConsentQuery,
  CreateHighRiskAreaBody as M20CreateHighRiskAreaBody,
  CreateIncidentBody as M20CreateIncidentBody,
  CreateSubscriptionBody as M20CreateSubscriptionBody,
  DashboardQuery as M20DashboardQuery,
  GrantConsentBody as M20GrantConsentBody,
  HighRiskAreaListQuery as M20HighRiskAreaListQuery,
  IncidentListQuery as M20IncidentListQuery,
  LocationStreamQuery as M20LocationStreamQuery,
  OshaSignoffBody as M20OshaSignoffBody,
  PatchHighRiskAreaBody as M20PatchHighRiskAreaBody,
  PatchIncidentBody as M20PatchIncidentBody,
  PatchPolicyBody as M20PatchPolicyBody,
  PolicyQuery as M20PolicyQuery,
  RaiseSosBody as M20RaiseSosBody,
  RecordCheckInBody as M20RecordCheckInBody,
  ResolveSosBody as M20ResolveSosBody,
  RevokeConsentBody as M20RevokeConsentBody,
  SubmitIncidentBody as M20SubmitIncidentBody,
  SubscriptionListQuery as M20SubscriptionListQuery,
  TransitionIncidentBody as M20TransitionIncidentBody,
} from "../../apps/backend/src/modules/20-field-safety/routes/m20-typebox";
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
  MetricsQuerySchema as BillingMetricsQuerySchema,
  PatientQuerySchema as BillingPatientQuerySchema,
  CancelNoeBodySchema,
  CancelNotrBodySchema,
  CheckEligibilityBodySchema,
  ClaimListQuerySchema,
  ClaimPatchDraftBodySchema,
  CreateRuleConfigBodySchema,
  ForwardDateSequestrationBodySchema,
  MacCredentialListQuerySchema,
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
// M26 Cap Management — the §4.2 request/response schemas the route handlers bind (the @wardenx/cap-management
// contracts re-exported via modules/26-cap/routes/m26-typebox so the enrichment matches the module path).
import {
  AcknowledgeEventRequest as CapAcknowledgeEventRequest,
  AmendConstantRequest as CapAmendConstantRequest,
  CloseCapPeriodRequest as CapCloseCapPeriodRequest,
  FinalizeSettlementRequest as CapFinalizeSettlementRequest,
  InpatientProjectionDto as CapInpatientProjectionDto,
  LockMethodologyRequest as CapLockMethodologyRequest,
  OpenCapPeriodRequest as CapOpenCapPeriodRequest,
  CapPeriodDto,
  CapPeriodListResponse,
  ProjectionListResponse as CapProjectionListResponse,
  ProjectionSnapshotDto as CapProjectionSnapshotDto,
  PsrImportRequest as CapPsrImportRequest,
  PublishConstantRequest as CapPublishConstantRequest,
  ReopenCapPeriodRequest as CapReopenCapPeriodRequest,
  ResolveVarianceRequest as CapResolveVarianceRequest,
  SettlementDto as CapSettlementDto,
} from "../../apps/backend/src/modules/26-cap/routes/m26-typebox";
// M27 Cost Report — the §4.1 request bodies + list query the cost-report routes bind (the realigned
// Form CMS-1984-14 surface; modules/27-cost-report/routes path flips the OpenAPI-enriched flag).
import {
  AddBadDebtBodySchema,
  ApproveForSubmitBodySchema,
  CostReportListQuerySchema,
  CreateCostReportBodySchema,
  CreateValidationRuleBodySchema,
  PatchCostReportBodySchema,
  PutWorksheetBodySchema,
  RecordAcknowledgmentBodySchema,
  ReopenBodySchema,
  SubmitBodySchema,
} from "../../apps/backend/src/modules/27-cost-report/routes/cost-report-typebox";
// M28 FHIR Gateway — the §4.2 request bodies + list queries the §4.1 route handlers validate against.
import {
  AcceptProposalBody as M28AcceptProposalBody,
  ApproveClientBody as M28ApproveClientBody,
  BulkExportListQuery as M28BulkExportListQuery,
  ClientListQuery as M28ClientListQuery,
  CreateClientBody as M28CreateClientBody,
  ExportQuery as M28ExportQuery,
  InboundListQuery as M28InboundListQuery,
  InitiateBulkExportBody as M28InitiateBulkExportBody,
  PutConfigBody as M28PutConfigBody,
  RejectProposalBody as M28RejectProposalBody,
  ResourceSearchQuery as M28ResourceSearchQuery,
  RevokeClientBody as M28RevokeClientBody,
  SuspendClientBody as M28SuspendClientBody,
  TokenFormBody as M28TokenFormBody,
  ValidateCodeBody as M28ValidateCodeBody,
} from "../../apps/backend/src/modules/28-fhir/routes/m28-typebox";
// M29 External Interfaces — the §4.1 operator + §4.2 clinician request bodies + list queries the route
// handlers `parse(...)` / `parseQuery(...)`. Same exported schemas, so the contract cannot drift from the
// validator. NOTE the feed-type vocabulary: the §4.3 sketch used `hl7v2_inbound_adt` …; the T02 pgEnum
// (`adt_inbound` | `lab_inbound` | `orm_outbound`) wins, and the enrichment publishes what the validator
// enforces rather than the prose.
import {
  AcceptProposalBody as M29AcceptProposalBody,
  AttachPatientBody as M29AttachPatientBody,
  CreateFeedBody as M29CreateFeedBody,
  DeferProposalBody as M29DeferProposalBody,
  DiscardObservationBody as M29DiscardObservationBody,
  FeedListQuery as M29FeedListQuery,
  InboundMessageListQuery as M29InboundMessageListQuery,
  MintCredentialBody as M29MintCredentialBody,
  NppesSyncRunListQuery as M29NppesSyncRunListQuery,
  NppesSyncTriggerBody as M29NppesSyncTriggerBody,
  ObservationListQuery as M29ObservationListQuery,
  OutboundMessageListQuery as M29OutboundMessageListQuery,
  ProposalListQuery as M29ProposalListQuery,
  RejectProposalBody as M29RejectProposalBody,
  RevokeFeedBody as M29RevokeFeedBody,
  SuspendFeedBody as M29SuspendFeedBody,
  UpdateFeedBody as M29UpdateFeedBody,
} from "../../apps/backend/src/modules/29-external-interfaces/routes/m29-typebox";
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
  IncidentDetailResponseSchema,
  IncidentListQuerySchema,
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
// M32 AI Platform — the §4.1 request bodies + list queries the route handlers `parse(...)` /
// `parseQuery(...)`. Same exported schemas, so the contract cannot drift from the validator. Note the
// CLOSED string-literal unions: every wire enum mirrors a `@wardenx/db` pgEnum, because a wire enum
// published as `Type.String()` is a silent lie (the M30 lesson) — and note what has no schema at all,
// which is every prompt / response / chart-context payload (§4.1 keeps `aiSdk.invoke` off REST).
import {
  ActivateKillSwitchBody as M32ActivateKillSwitchBody,
  ActivatePromptTemplateBody as M32ActivatePromptTemplateBody,
  CapabilityListQuery as M32CapabilityListQuery,
  DeactivateKillSwitchBody as M32DeactivateKillSwitchBody,
  DriftQuery as M32DriftQuery,
  EvaluationRunQuery as M32EvaluationRunQuery,
  FileHallucinationReportBody as M32FileHallucinationReportBody,
  HallucinationQueueQuery as M32HallucinationQueueQuery,
  InvocationSearchQuery as M32InvocationSearchQuery,
  PublishCalibrationBody as M32PublishCalibrationBody,
  QueueEvaluationRunBody as M32QueueEvaluationRunBody,
  RecordClinicianOptOutBody as M32RecordClinicianOptOutBody,
  RecordTenantOptInBody as M32RecordTenantOptInBody,
  RegisterCapabilityBody as M32RegisterCapabilityBody,
  RevokeTenantOptInBody as M32RevokeTenantOptInBody,
  SetRoutingOverrideBody as M32SetRoutingOverrideBody,
  TokenForecastQuery as M32TokenForecastQuery,
  TokenLedgerQuery as M32TokenLedgerQuery,
  TransitionCapabilityBody as M32TransitionCapabilityBody,
  TriageHallucinationReportBody as M32TriageHallucinationReportBody,
} from "../../apps/backend/src/modules/32-ai-platform/routes/m32-typebox";
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
import {
  AddDpoaAgentBodySchema,
  AddRecipientBodySchema,
  BereavementOutreachBodySchema,
  CreateDraftBodySchema as ConsentCreateDraftBodySchema,
  ConsentDpoaAgentListResponseSchema,
  EvalAuditQuerySchema as ConsentEvalAuditByPatientQuerySchema,
  ConsentEvalAuditQuerySchema,
  ConsentListResponseSchema,
  ConsentRecipientListResponseSchema,
  RevokeBodySchema as ConsentRevokeBodySchema,
  ExpiringConsentsQuerySchema,
  ExpiringConsentsResponseSchema,
  RemoveRecipientBodySchema,
  RenewBodySchema,
  SupersedeBodySchema,
  UpdateDpoaAgentBodySchema,
  UpdateDraftBodySchema,
  UpsertOverlayBodySchema,
} from "../../apps/backend/src/modules/39-consent/routes/consent-typebox";
import { SearchQuerySchema as MdmSearchQuerySchema } from "../../apps/backend/src/modules/40-mdm/routes/mdm-typebox";

// M3 Authorization (§4.3–4.4) — request bodies + response DTOs the route handlers parse/return.
// Every symbol M3-aliased. Response DTOs mirror ../authz-ports views (RoleView, MembershipRoleView,
// BreakGlassView, EngagementView, EngagementSummary) + the @wardenx/auth permission mirror, each pinned
// by a compile-time `Conforms` alias in the source file.
import {
  // request bodies
  AssignRoleBody as M3AssignRoleBody,
  // response DTOs
  AuditorEnrolledResponseSchema as M3AuditorEnrolledResponseSchema,
  BreakGlassInvokedResponseSchema as M3BreakGlassInvokedResponseSchema,
  BreakGlassListResponseSchema as M3BreakGlassListResponseSchema,
  BreakGlassStatusResponseSchema as M3BreakGlassStatusResponseSchema,
  CreateEngagementBody as M3CreateEngagementBody,
  CreateRoleBody as M3CreateRoleBody,
  EngagementResponseSchema as M3EngagementResponseSchema,
  EngagementSummaryResponseSchema as M3EngagementSummaryResponseSchema,
  EnrollAuditorBody as M3EnrollAuditorBody,
  InvokeBreakGlassBody as M3InvokeBreakGlassBody,
  MePermissionsResponseSchema as M3MePermissionsResponseSchema,
  MembershipRoleListResponseSchema as M3MembershipRoleListResponseSchema,
  MembershipRoleResponseSchema as M3MembershipRoleResponseSchema,
  PermissionsResponseSchema as M3PermissionsResponseSchema,
  RoleDeletedResponseSchema as M3RoleDeletedResponseSchema,
  RoleGrantRevokedResponseSchema as M3RoleGrantRevokedResponseSchema,
  RoleListResponseSchema as M3RoleListResponseSchema,
  RoleResponseSchema as M3RoleResponseSchema,
  UpdateEngagementBody as M3UpdateEngagementBody,
  UpdateRoleBody as M3UpdateRoleBody,
} from "../../apps/backend/src/modules/03-authorization/routes/authz-typebox";

import {
  AccountingQuerySchema as M4EAccountingQuerySchema,
  AccountingResponseSchema as M4EAccountingResponseSchema,
  AuditEventSchema as M4EAuditEventSchema,
  AuditEventsQuerySchema as M4EAuditEventsQuerySchema,
  AuditEventsResponseSchema as M4EAuditEventsResponseSchema,
  PatientAccessQuerySchema as M4EPatientAccessQuerySchema,
  PatientAccessResponseSchema as M4EPatientAccessResponseSchema,
} from "../../apps/backend/src/modules/04-audit/routes/audit-typebox";

// M05 Patient & Demographics — OpenAPI enrichment imports. EVERY symbol is M5E-aliased because the
// M5 patient schemas are ALREADY imported un-aliased in scripts/openapi/enrichments.ts; the M5E prefix
// avoids a redeclaration collision when this block is merged in via a later Object.assign.
import {
  AddAddressResponseSchema as M5EAddAddressResponseSchema,
  AddressBodySchema as M5EAddressBodySchema,
  AdmitBodySchema as M5EAdmitBodySchema,
  AdmitResultResponseSchema as M5EAdmitResultResponseSchema,
  AmendmentBodySchema as M5EAmendmentBodySchema,
  AmendmentResponseSchema as M5EAmendmentResponseSchema,
  CensusMetricsResponseSchema as M5ECensusMetricsResponseSchema,
  DenyBodySchema as M5EDenyBodySchema,
  PatientAddressesResponseSchema as M5EPatientAddressesResponseSchema,
  PatientCareTeamResponseSchema as M5EPatientCareTeamResponseSchema,
  PatientDemographicsSchema as M5EPatientDemographicsSchema,
  PatientIdentifiersResponseSchema as M5EPatientIdentifiersResponseSchema,
  PatientListQuerySchema as M5EPatientListQuerySchema,
  PatientListResponseSchema as M5EPatientListResponseSchema,
  PatientPayersResponseSchema as M5EPatientPayersResponseSchema,
  PatientPrivacyFlagsResponseSchema as M5EPatientPrivacyFlagsResponseSchema,
  PatientSummarySchema as M5EPatientSummarySchema,
} from "../../apps/backend/src/modules/05-patient/routes/patient-typebox";

// M15 Discipline Care Plans — request schemas (§4.2) + response DTOs (§4.1 views, pinned by `Conforms`
// in m15-typebox.ts). Every symbol M15-aliased. Merge into the existing top-of-file import in
// scripts/openapi/enrichments.ts (this REPLACES the current M15 import block — it now also pulls the
// response DTOs). The later `Object.assign` (m15-block.ts) wins over the earlier M15 entries.
import {
  // response DTOs (§4.2)
  AideSupervisoryVisitViewResponseSchema as M15AideSupervisoryVisitViewResponseSchema,
  // request bodies / list queries
  DisciplineAssessmentViewResponseSchema as M15DisciplineAssessmentViewResponseSchema,
  DisciplineGoalViewResponseSchema as M15DisciplineGoalViewResponseSchema,
  DisciplineInterventionViewResponseSchema as M15DisciplineInterventionViewResponseSchema,
  DisciplinePlanDetailResponseSchema as M15DisciplinePlanDetailResponseSchema,
  DisciplinePlanListPageResponseSchema as M15DisciplinePlanListPageResponseSchema,
  DisciplinePlanSummaryResponseSchema as M15DisciplinePlanSummaryResponseSchema,
  DisciplinePlanVersionDetailResponseSchema as M15DisciplinePlanVersionDetailResponseSchema,
  DisciplinePlanVersionListPageResponseSchema as M15DisciplinePlanVersionListPageResponseSchema,
  RelevantElementsPageResponseSchema as M15RelevantElementsPageResponseSchema,
  SupervisoryCadencePageResponseSchema as M15SupervisoryCadencePageResponseSchema,
  VolunteerAssignmentViewResponseSchema as M15VolunteerAssignmentViewResponseSchema,
  VolunteerComplianceGateListPageResponseSchema as M15VolunteerComplianceGateListPageResponseSchema,
  VolunteerComplianceGateViewResponseSchema as M15VolunteerComplianceGateViewResponseSchema,
  VolunteerEffectiveStatusViewResponseSchema as M15VolunteerEffectiveStatusViewResponseSchema,
  VolunteerHourEntryViewResponseSchema as M15VolunteerHourEntryViewResponseSchema,
} from "../../apps/backend/src/modules/15-discipline-care-plans/routes/m15-typebox";

// M16 Bereavement — enrichment imports. Request schemas (already imported in enrichments.ts under these
// same M16* aliases — dedupe on merge) + the new §4.1 RESPONSE DTOs. Every symbol M16-aliased.
import {
  // ── request bodies + list queries (§4.2) ──
  BereavementClosureViewResponseSchema as M16ClosureResponse,
  BereavementContactLogViewResponseSchema as M16ContactLogResponse,
  // ── §4.1 response DTOs (F0 enrichment; pinned to the read/write service views by Conforms) ──
  BereavedContactRowViewResponseSchema as M16ContactRowResponse,
  CounselorDashboardViewResponseSchema as M16CounselorDashboardResponse,
  BereavementOutreachPageResponseSchema as M16OutreachPageResponse,
  BereavementOutreachRowViewResponseSchema as M16OutreachRowResponse,
  PlanActivationViewResponseSchema as M16PlanActivationResponse,
  BereavementPlanDetailResponseSchema as M16PlanDetailResponse,
  BereavementPlanPageResponseSchema as M16PlanPageResponse,
  BereavementRiskScorePageResponseSchema as M16RiskScorePageResponse,
  BereavementRiskScoreViewResponseSchema as M16RiskScoreResponse,
  ScheduleRegenerationViewResponseSchema as M16ScheduleRegenResponse,
  SupervisorDashboardViewResponseSchema as M16SupervisorDashboardResponse,
} from "../../apps/backend/src/modules/16-bereavement/routes/m16-typebox";

// M19 On-Call Triage — enrichment imports. Replaces the existing M19 import block in
// scripts/openapi/enrichments.ts: it re-exports every §4.2 request schema PLUS the new §4.2 response DTOs
// (pinned to the read/write-service views by `Conforms` in m19-typebox), every symbol M19-aliased.
import {
  // request bodies / queries (unchanged — same exported schemas the route handlers parse())
  AnswerWriteResultResponse as M19AnswerWriteResultResponse,
  CurrentOnCallResponse as M19CurrentOnCallResponse,
  EscalationInboxItemResponse as M19EscalationInboxItemResponse,
  EscalationInboxPageResponse as M19EscalationInboxPageResponse,
  OnCallShiftPageResponse as M19OnCallShiftPageResponse,
  OnCallShiftViewResponse as M19OnCallShiftViewResponse,
  OncallPolicyResponse as M19OncallPolicyResponse,
  OpenTriageCallResultResponse as M19OpenTriageCallResultResponse,
  PaperReentryWorklistResponse as M19PaperReentryWorklistResponse,
  PortalRecentPageResponse as M19PortalRecentPageResponse,
  TriageCallListPageResponse as M19TriageCallListPageResponse,
  TriageCallResponse as M19TriageCallResponse,
  TriageProtocolPageResponse as M19TriageProtocolPageResponse,
  TriageProtocolViewResponse as M19TriageProtocolViewResponse,
  TriageTranscriptResponse as M19TriageTranscriptResponse,
  VendorBindingListResponse as M19VendorBindingListResponse,
  VendorBindingViewResponse as M19VendorBindingViewResponse,
} from "../../apps/backend/src/modules/19-oncall/routes/m19-typebox";

// M20 Field Safety — the §4.1 request bodies/queries the route handlers `parse(...)`/`parseQuery(...)`
// plus the §4.2 response DTOs (pinned to the read/write service views by `Conforms`). All symbols
// M20-aliased. Path is relative to scripts/openapi/enrichments.ts.
import {
  // request bodies
  // response DTOs
  ActiveSosResponse as M20ActiveSosResponse,
  CancelSosResponse as M20CancelSosResponse,
  // list queries
  DeleteSubscriptionResponse as M20DeleteSubscriptionResponse,
  RaiseSosResponse as M20RaiseSosResponse,
  RecordCheckInResponse as M20RecordCheckInResponse,
  SafetyCheckInResponse as M20SafetyCheckInResponse,
  SafetyConsentResponse as M20SafetyConsentResponse,
  SafetyConsentSurfaceResponse as M20SafetyConsentSurfaceResponse,
  SafetyDashboardResponse as M20SafetyDashboardResponse,
  SafetyHighRiskAreaPageResponse as M20SafetyHighRiskAreaPageResponse,
  SafetyHighRiskAreaResponse as M20SafetyHighRiskAreaResponse,
  SafetyIncidentPageResponse as M20SafetyIncidentPageResponse,
  SafetyIncidentResponse as M20SafetyIncidentResponse,
  SafetyMyDayResponse as M20SafetyMyDayResponse,
  SafetyPolicyEffectiveResponse as M20SafetyPolicyEffectiveResponse,
  SafetySosAlertResponse as M20SafetySosAlertResponse,
  SafetySubscriptionPageResponse as M20SafetySubscriptionPageResponse,
  SafetySubscriptionResponse as M20SafetySubscriptionResponse,
  SosLocationStreamResponse as M20SosLocationStreamResponse,
} from "../../apps/backend/src/modules/20-field-safety/routes/m20-typebox";

// M21 Supplies, DME & Comfort Kits — OpenAPI enrichment imports (paste into scripts/openapi/enrichments.ts).
// All request schemas + the §4.2 response DTOs live in the module's TypeBox file; every symbol is M21-aliased.
import {
  // request bodies (§4.2)
  ComfortKitReturnDetailSchema as M21ComfortKitReturnDetailSchema,
  ComfortKitReturnListResponseSchema as M21ComfortKitReturnListResponseSchema,
  ComfortKitTemplateListResponseSchema as M21ComfortKitTemplateListResponseSchema,
  ComfortKitTemplateViewSchema as M21ComfortKitTemplateViewSchema,
  CreateSupplyRequestResultSchema as M21CreateSupplyRequestResultSchema,
  DispatchDetailSchema as M21DispatchDetailSchema,
  DispatchListResponseSchema as M21DispatchListResponseSchema,
  ParStockListResponseSchema as M21ParStockListResponseSchema,
  ParStockViewSchema as M21ParStockViewSchema,
  PerpetualLogViewSchema as M21PerpetualLogViewSchema,
  ReconcileReturnResultSchema as M21ReconcileReturnResultSchema,
  SupplyItemListResponseSchema as M21SupplyItemListResponseSchema,
  SupplyItemViewSchema as M21SupplyItemViewSchema,
  SupplyRequestDetailSchema as M21SupplyRequestDetailSchema,
  SupplyRequestListResponseSchema as M21SupplyRequestListResponseSchema,
  VendorRoutingRuleListResponseSchema as M21VendorRoutingRuleListResponseSchema,
  VendorRoutingRuleViewSchema as M21VendorRoutingRuleViewSchema,
} from "../../apps/backend/src/modules/21-supplies/routes/m21-typebox";

// M25 Remittance & Denials — OpenAPI enrichment imports (every symbol M25-aliased).
// Append to scripts/openapi/enrichments.ts's import section.
import {
  // request bodies
  AdjustmentOverrideRequestSchema as M25AdjustmentOverrideRequestSchema,
  // mutation / seam / ad-hoc responses
  AdjustmentOverrideResponseSchema as M25AdjustmentOverrideResponseSchema,
  AppealAttachRequestSchema as M25AppealAttachRequestSchema,
  AppealCreateRequestSchema as M25AppealCreateRequestSchema,
  AppealDecideRequestSchema as M25AppealDecideRequestSchema,
  // detail responses
  AppealDetailSchema as M25AppealDetailSchema,
  AppealSubmitRequestSchema as M25AppealSubmitRequestSchema,
  // list/page responses
  AppealSummaryPageSchema as M25AppealSummaryPageSchema,
  AppealWithdrawRequestSchema as M25AppealWithdrawRequestSchema,
  DenialAssignRequestSchema as M25DenialAssignRequestSchema,
  DenialCloseWriteOffRequestSchema as M25DenialCloseWriteOffRequestSchema,
  DenialEscalateRequestSchema as M25DenialEscalateRequestSchema,
  DenialMetricsViewSchema as M25DenialMetricsViewSchema,
  DenialReopenRequestSchema as M25DenialReopenRequestSchema,
  DenialResolveRequestSchema as M25DenialResolveRequestSchema,
  DenialWorklistItemSchema as M25DenialWorklistItemSchema,
  DenialWorklistPageSchema as M25DenialWorklistPageSchema,
  // list query
  ManualMatchRequestSchema as M25ManualMatchRequestSchema,
  ManualMatchResponseSchema as M25ManualMatchResponseSchema,
  PrLedgerItemsResponseSchema as M25PrLedgerItemsResponseSchema,
  RemittanceAdviceReaderResponseSchema as M25RemittanceAdviceReaderResponseSchema,
  RemittanceAdviceSummaryPageSchema as M25RemittanceAdviceSummaryPageSchema,
  RemittanceAdviceSummarySchema as M25RemittanceAdviceSummarySchema,
  RemittanceLineSummaryPageSchema as M25RemittanceLineSummaryPageSchema,
  RemittanceLineSummarySchema as M25RemittanceLineSummarySchema,
  ReplayQueuedResponseSchema as M25ReplayQueuedResponseSchema,
  TaxonomyMergedViewSchema as M25TaxonomyMergedViewSchema,
  TaxonomyOverlayPatchSchema as M25TaxonomyOverlayPatchSchema,
  VersionedResultSchema as M25VersionedResultSchema,
} from "../../apps/backend/src/modules/25-remittance/routes/m25-typebox";

// M26 Cap Management — §4.2 request/response schemas. Bodies are the @wardenx/cap-management contracts;
// responses mirror the read/write-service VIEW interfaces (the shapes the handlers actually return),
// pinned by Conforms in m26-typebox.ts. Every symbol is M26-aliased.
import {
  // response DTOs (service views)
  CapAccrualLinePageResponse as M26AccrualLinePageResponse,
  // request bodies
  AcknowledgeEventRequest as M26AcknowledgeEventRequest,
  AmendConstantRequest as M26AmendConstantRequest,
  CapDashboardViewDto as M26DashboardViewDto,
  FinalizeSettlementRequest as M26FinalizeSettlementRequest,
  CapInpatientAccrualViewDto as M26InpatientAccrualViewDto,
  LockMethodologyRequest as M26LockMethodologyRequest,
  OpenCapPeriodRequest as M26OpenCapPeriodRequest,
  CapPatientAccrualViewDto as M26PatientAccrualViewDto,
  CapPeriodViewDto as M26PeriodViewDto,
  CapPeriodViewListResponse as M26PeriodViewListResponse,
  CapPlatformConstantViewListResponse as M26PlatformConstantViewListResponse,
  CapProjectionViewDto as M26ProjectionViewDto,
  CapProjectionViewListResponse as M26ProjectionViewListResponse,
  CapPsrImportQueuedResponse as M26PsrImportQueuedResponse,
  PsrImportRequest as M26PsrImportRequest,
  CapPsrImportViewDto as M26PsrImportViewDto,
  CapPsrVarianceViewListResponse as M26PsrVarianceViewListResponse,
  CapPublishConstantAckResponse as M26PublishConstantAckResponse,
  PublishConstantRequest as M26PublishConstantRequest,
  ReopenCapPeriodRequest as M26ReopenCapPeriodRequest,
  ResolveVarianceRequest as M26ResolveVarianceRequest,
  CapSettlementViewDto as M26SettlementViewDto,
  CapThresholdEventViewListResponse as M26ThresholdEventViewListResponse,
} from "../../apps/backend/src/modules/26-cap/routes/m26-typebox";

// M27 Cost Report (Form CMS-1984-14; §4.1) — request bodies/queries + §4.2 response DTOs.
// Paste into scripts/openapi/enrichments.ts (replaces/extends the existing partial M27 import block).
import {
  AddBadDebtBodySchema as M27AddBadDebtBodySchema,
  AllocationAcceptedResponseSchema as M27AllocationAcceptedResponseSchema,
  ApplyMappingBodySchema as M27ApplyMappingBodySchema,
  ApproveForSubmitBodySchema as M27ApproveForSubmitBodySchema,
  BadDebtRecordListResponseSchema as M27BadDebtRecordListResponseSchema,
  BadDebtRecordResponseSchema as M27BadDebtRecordResponseSchema,
  ComplianceWindowOrNullResponseSchema as M27ComplianceWindowOrNullResponseSchema,
  ComplianceWindowResponseSchema as M27ComplianceWindowResponseSchema,
  CostCenterMappingListResponseSchema as M27CostCenterMappingListResponseSchema,
  CostReportDetailResponseSchema as M27CostReportDetailResponseSchema,
  CostReportListQuerySchema as M27CostReportListQuerySchema,
  CostReportPageResponseSchema as M27CostReportPageResponseSchema,
  CreateCostReportBodySchema as M27CreateCostReportBodySchema,
  CreateValidationRuleBodySchema as M27CreateValidationRuleBodySchema,
  DeadlineExtensionBodySchema as M27DeadlineExtensionBodySchema,
  EcrSubmissionListResponseSchema as M27EcrSubmissionListResponseSchema,
  EcrSubmissionResponseSchema as M27EcrSubmissionResponseSchema,
  ImportJobAcceptedResponseSchema as M27ImportJobAcceptedResponseSchema,
  ManualTrialBalanceBodySchema as M27ManualTrialBalanceBodySchema,
  ManualWageDataBodySchema as M27ManualWageDataBodySchema,
  MappingPreviewResponseSchema as M27MappingPreviewResponseSchema,
  OverrideValidationResultBodySchema as M27OverrideValidationResultBodySchema,
  PatchCostReportBodySchema as M27PatchCostReportBodySchema,
  PreviewMappingBodySchema as M27PreviewMappingBodySchema,
  PutWorksheetBodySchema as M27PutWorksheetBodySchema,
  RecordAcknowledgmentBodySchema as M27RecordAcknowledgmentBodySchema,
  RefreshInputsAcceptedResponseSchema as M27RefreshInputsAcceptedResponseSchema,
  ReopenBodySchema as M27ReopenBodySchema,
  ResetMappingBodySchema as M27ResetMappingBodySchema,
  SnapshotDetailResponseSchema as M27SnapshotDetailResponseSchema,
  SnapshotSummaryListResponseSchema as M27SnapshotSummaryListResponseSchema,
  StatisticDataOrNullResponseSchema as M27StatisticDataOrNullResponseSchema,
  StatisticsRefreshAcceptedResponseSchema as M27StatisticsRefreshAcceptedResponseSchema,
  SubmitBodySchema as M27SubmitBodySchema,
  SubmitPastDeadlineBodySchema as M27SubmitPastDeadlineBodySchema,
  TrialBalanceImportListResponseSchema as M27TrialBalanceImportListResponseSchema,
  TrialBalanceImportResponseSchema as M27TrialBalanceImportResponseSchema,
  UpdateBadDebtBodySchema as M27UpdateBadDebtBodySchema,
  UpdateValidationRuleBodySchema as M27UpdateValidationRuleBodySchema,
  ValidationJobAcceptedResponseSchema as M27ValidationJobAcceptedResponseSchema,
  ValidationOverrideResponseSchema as M27ValidationOverrideResponseSchema,
  ValidationRuleListResponseSchema as M27ValidationRuleListResponseSchema,
  ValidationRuleResponseSchema as M27ValidationRuleResponseSchema,
  ValidationRunDetailResponseSchema as M27ValidationRunDetailResponseSchema,
  ValidationRunSummaryListResponseSchema as M27ValidationRunSummaryListResponseSchema,
  WageDataImportListResponseSchema as M27WageDataImportListResponseSchema,
  WageDataImportResponseSchema as M27WageDataImportResponseSchema,
  WorksheetResponseSchema as M27WorksheetResponseSchema,
} from "../../apps/backend/src/modules/27-cost-report/routes/cost-report-typebox";

// M33 Reporting & Dashboards — OpenAPI enrichment imports (paste into scripts/openapi/enrichments.ts).
// NOTE: existing M33 imports already pull DashboardListQuerySchema/MvListQuerySchema (reporting-typebox)
// and DrilldownEmitRequest/ScheduleListQuery (write-typebox). Extend those two import blocks with the
// symbols below (kept M33-aliased here; the file's existing imports are un-aliased, so on paste either
// alias-import a fresh block or merge names, avoiding duplicate identifiers).

// ── from reporting-typebox.ts (READ + admin + metric-seam responses; request queries) ──────────────
import {
  BaseListQuerySchema as M33BaseListQuerySchema,
  DashboardListQuerySchema as M33DashboardListQuerySchema,
  DashboardListResponseSchema as M33DashboardListResponseSchema,
  DashboardSummaryViewSchema as M33DashboardSummaryViewSchema,
  DrilldownAuditListQuerySchema as M33DrilldownAuditListQuerySchema,
  DrilldownAuditListResponseSchema as M33DrilldownAuditListResponseSchema,
  MetricListQuerySchema as M33MetricListQuerySchema,
  MetricSeamQuerySchema as M33MetricSeamQuerySchema,
  MetricSeamViewSchema as M33MetricSeamViewSchema,
  MvCommandAcceptedSchema as M33MvCommandAcceptedSchema,
  MvListQuerySchema as M33MvListQuerySchema,
  MvMetadataListResponseSchema as M33MvMetadataListResponseSchema,
  ReplicaLagViewSchema as M33ReplicaLagViewSchema,
  ReportBaseDetailViewSchema as M33ReportBaseDetailViewSchema,
  ReportBaseListResponseSchema as M33ReportBaseListResponseSchema,
  ReportMetricListResponseSchema as M33ReportMetricListResponseSchema,
  TileFreshnessViewSchema as M33TileFreshnessViewSchema,
  TileReadQuery as M33TileReadQuery,
  TileReadResponse as M33TileReadResponse,
} from "../../apps/backend/src/modules/33-reporting/routes/reporting-typebox";

// ── from write-typebox.ts (MUTATING + export/drilldown request bodies + response DTOs) ─────────────
import {
  CreateDefinitionRequest as M33CreateDefinitionRequest,
  CreateVersionRequest as M33CreateVersionRequest,
  CreateViewRequest as M33CreateViewRequest,
  DefinitionListQuery as M33DefinitionListQuery,
  DefinitionListResponseSchema as M33DefinitionListResponseSchema,
  DefinitionVersionListResponseSchema as M33DefinitionVersionListResponseSchema,
  DefinitionVersionViewSchema as M33DefinitionVersionViewSchema,
  DefinitionViewSchema as M33DefinitionViewSchema,
  DeleteAllRunsResponseSchema as M33DeleteAllRunsResponseSchema,
  DrilldownBulkExportRequest as M33DrilldownBulkExportRequest,
  DrilldownEmitRequest as M33DrilldownEmitRequest,
  DrilldownEmitResponseSchema as M33DrilldownEmitResponseSchema,
  ExportAcceptedResponseSchema as M33ExportAcceptedResponseSchema,
  ExportRequest as M33ExportRequest,
  PublishVersionResponseSchema as M33PublishVersionResponseSchema,
  ScheduleListQuery as M33ScheduleListQuery,
  ScheduleListResponseSchema as M33ScheduleListResponseSchema,
  ScheduleRunListQuery as M33ScheduleRunListQuery,
  ScheduleRunListResponseSchema as M33ScheduleRunListResponseSchema,
  ScheduleRunViewSchema as M33ScheduleRunViewSchema,
  ScheduleViewSchema as M33ScheduleViewSchema,
  ScheduledReportCreate as M33ScheduledReportCreate,
  ShareViewRequest as M33ShareViewRequest,
  ShareViewResponseSchema as M33ShareViewResponseSchema,
  UpdateScheduleRequest as M33UpdateScheduleRequest,
  UpdateViewRequest as M33UpdateViewRequest,
  ViewListQuery as M33ViewListQuery,
  ViewListResponseSchema as M33ViewListResponseSchema,
  ViewViewSchema as M33ViewViewSchema,
} from "../../apps/backend/src/modules/33-reporting/routes/write-typebox";

// M34 SaaS Tenant Platform — OpenAPI enrichment imports (deficit → 0; all 48 routes across
// routes/platform/*, routes/tenant/*, routes/public/*). Every symbol is M34-aliased to avoid
// colliding with the pre-existing partial M34 import block (which this block supersedes — later
// Object.assign wins). Response DTOs mirror the service views and are Conforms-pinned in the
// respective *-typebox.ts files.

// ── platform-ops surface (routes/platform/platform-typebox.ts) ──────────────────────────────────────
import {
  // queries
  BaaRegisterListQuerySchema as M34BaaRegisterListQuerySchema,
  BaaRegisterListResponseSchema as M34BaaRegisterListResponseSchema,
  CloseSessionAckSchema as M34CloseSessionAckSchema,
  CloseSessionRequest as M34CloseSessionRequest,
  // bodies
  CreateBaaRequest as M34CreateBaaRequest,
  DekRotateRequest as M34DekRotateRequest,
  ElevateSessionAckSchema as M34ElevateSessionAckSchema,
  FeatureFlagListQuerySchema as M34FeatureFlagListQuerySchema,
  FeatureFlagListResponseSchema as M34FeatureFlagListResponseSchema,
  FeatureFlagViewSchema as M34FeatureFlagViewSchema,
  InvitationListQuerySchema as M34InvitationListQuerySchema,
  InvitationListResponseSchema as M34InvitationListResponseSchema,
  IssueInvitationRequest as M34IssueInvitationRequest,
  KeyRingMetadataViewSchema as M34KeyRingMetadataViewSchema,
  KillSwitchRequest as M34KillSwitchRequest,
  OffboardTenantRequest as M34OffboardTenantRequest,
  OnboardingTemplateListQuerySchema as M34OnboardingTemplateListQuerySchema,
  OnboardingTemplateListResponseSchema as M34OnboardingTemplateListResponseSchema,
  OnboardingTemplateViewSchema as M34OnboardingTemplateViewSchema,
  // responses
  BaaRecordViewSchema as M34PlatformBaaRecordViewSchema,
  ProvisionTenantRequest as M34ProvisionTenantRequest,
  QualifyIntentAckSchema as M34QualifyIntentAckSchema,
  QualifyIntentRequest as M34QualifyIntentRequest,
  RejectIntentAckSchema as M34RejectIntentAckSchema,
  RejectIntentRequest as M34RejectIntentRequest,
  RevokeInvitationAckSchema as M34RevokeInvitationAckSchema,
  SessionEventListQuerySchema as M34SessionEventListQuerySchema,
  ShredTenantRequest as M34ShredTenantRequest,
  SignupIntentListQuerySchema as M34SignupIntentListQuerySchema,
  SignupIntentListResponseSchema as M34SignupIntentListResponseSchema,
  StartSessionAckSchema as M34StartSessionAckSchema,
  StartSessionRequest as M34StartSessionRequest,
  StatusTransitionRequest as M34StatusTransitionRequest,
  SupportSessionEventListResponseSchema as M34SupportSessionEventListResponseSchema,
  SupportSessionListQuerySchema as M34SupportSessionListQuerySchema,
  SupportSessionListResponseSchema as M34SupportSessionListResponseSchema,
  TenantInvitationViewSchema as M34TenantInvitationViewSchema,
  TenantJobAckSchema as M34TenantJobAckSchema,
  TenantListQuerySchema as M34TenantListQuerySchema,
  TenantListResponseSchema as M34TenantListResponseSchema,
  TenantOverviewViewSchema as M34TenantOverviewViewSchema,
  TenantStatusAckSchema as M34TenantStatusAckSchema,
  UpdateBaaRequest as M34UpdateBaaRequest,
  UpsertFeatureFlagRequest as M34UpsertFeatureFlagRequest,
  UpsertOnboardingTemplateRequest as M34UpsertOnboardingTemplateRequest,
} from "../../apps/backend/src/modules/34-saas-tenant-platform/routes/platform/platform-typebox";

// ── tenant-scoped surface (routes/tenant/tenant-typebox.ts) ─────────────────────────────────────────
import {
  // bodies
  BaaAttestRequest as M34BaaAttestRequest,
  // queries
  BaaListQuerySchema as M34BaaListQuerySchema,
  // responses
  BaaRecordListResponseSchema as M34BaaRecordListResponseSchema,
  DownloadUrlViewSchema as M34DownloadUrlViewSchema,
  DsarDenyRequest as M34DsarDenyRequest,
  DsarExportJobListResponseSchema as M34DsarExportJobListResponseSchema,
  DsarExportJobViewSchema as M34DsarExportJobViewSchema,
  DsarExportRequest as M34DsarExportRequest,
  DsarExtendRequest as M34DsarExtendRequest,
  DsarListQuerySchema as M34DsarListQuerySchema,
  GrantListQuerySchema as M34GrantListQuerySchema,
  OnboardingBlockRequest as M34OnboardingBlockRequest,
  OnboardingCompleteRequest as M34OnboardingCompleteRequest,
  OnboardingListQuerySchema as M34OnboardingListQuerySchema,
  OnboardingTaskListResponseSchema as M34OnboardingTaskListResponseSchema,
  OnboardingTaskViewSchema as M34OnboardingTaskViewSchema,
  RevokeConsentGrantRequest as M34RevokeConsentGrantRequest,
  SupportConsentGrantListResponseSchema as M34SupportConsentGrantListResponseSchema,
  SupportConsentGrantViewSchema as M34SupportConsentGrantViewSchema,
  BaaRecordViewSchema as M34TenantBaaRecordViewSchema,
  TenantExportJobListResponseSchema as M34TenantExportJobListResponseSchema,
  TenantExportJobViewSchema as M34TenantExportJobViewSchema,
  TenantExportListQuerySchema as M34TenantExportListQuerySchema,
  TenantExportRequest as M34TenantExportRequest,
  SupportConsentGrantRequest as M34TenantSupportConsentGrantRequest,
} from "../../apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/tenant-typebox";

// ── public self-serve surface (routes/typebox.ts) ───────────────────────────────────────────────────
import {
  AcceptInvitationAckSchema as M34AcceptInvitationAckSchema,
  AcceptInvitationRequest as M34AcceptInvitationRequest,
  PublicSignupIntentAckSchema as M34PublicSignupIntentAckSchema,
  PublicSignupIntentRequest as M34PublicSignupIntentRequest,
  VerifyEmailAckSchema as M34VerifyEmailAckSchema,
} from "../../apps/backend/src/modules/34-saas-tenant-platform/routes/typebox";

// ── M36 Secure Messaging & Alerts — request + response schema imports (all M36-aliased) ──
import {
  // request schemas (query / body) — reused as-is
  AddMemberBodySchema as M36AddMemberBodySchema,
  // §4.2 response DTOs (added this task, pinned by Conforms to the route-service views)
  AlertInboxResponseSchema as M36AlertInboxResponseSchema,
  AlertRuleListResponseSchema as M36AlertRuleListResponseSchema,
  AlertRulePatchSchema as M36AlertRulePatchSchema,
  AlertRuleResponseSchema as M36AlertRuleResponseSchema,
  AnnounceBodySchema as M36AnnounceBodySchema,
  ChannelDetailResponseSchema as M36ChannelDetailResponseSchema,
  ChannelListResponseSchema as M36ChannelListResponseSchema,
  DeliveryEndpointResponseSchema as M36DeliveryEndpointResponseSchema,
  EditMessageBodySchema as M36EditMessageBodySchema,
  EditMessageResponseSchema as M36EditMessageResponseSchema,
  ListMessagesQuerySchema as M36ListMessagesQuerySchema,
  MessageListResponseSchema as M36MessageListResponseSchema,
  NotificationPreferencesResponseSchema as M36NotificationPreferencesResponseSchema,
  OpenDmBodySchema as M36OpenDmBodySchema,
  OpenDmResponseSchema as M36OpenDmResponseSchema,
  PreferencesBodySchema as M36PreferencesBodySchema,
  PutPreferencesResponseSchema as M36PutPreferencesResponseSchema,
  ReadBodySchema as M36ReadBodySchema,
  RegisterEndpointBodySchema as M36RegisterEndpointBodySchema,
  SendMessageBodySchema as M36SendMessageBodySchema,
  SendMessageResponseSchema as M36SendMessageResponseSchema,
  VerifyEndpointBodySchema as M36VerifyEndpointBodySchema,
} from "../../apps/backend/src/modules/36-messaging/routes/messaging-typebox";

// M38 Clinical Terminology Service — response DTOs (all M38-aliased).
// Merge these named imports into scripts/openapi/enrichments.ts. NOTE: an existing import already
// brings in `SearchQuerySchema as TerminologySearchQuerySchema` (line ~585) — keep that one; these
// are the added response/echo schemas. Request query/param schemas are reused from source.
import {
  ConceptResponseSchema as M38ConceptResponseSchema,
  DeprecationLookupResponseSchema as M38DeprecationLookupResponseSchema,
  ExpandQuerySchema as M38ExpandQuerySchema,
  ExpandResponseSchema as M38ExpandResponseSchema,
  ExtensionBodySchema as M38ExtensionBodySchema,
  ExtensionCreatedResponseSchema as M38ExtensionCreatedResponseSchema,
  IsMemberQuerySchema as M38IsMemberQuerySchema,
  LookupQuerySchema as M38LookupQuerySchema,
  MembershipResponseSchema as M38MembershipResponseSchema,
  ValidateQuerySchema as M38ValidateQuerySchema,
  ValidateResponseSchema as M38ValidateResponseSchema,
} from "../../apps/backend/src/modules/38-terminology/routes/terminology-typebox";

// M39 Consent & Authorization Management — OpenAPI enrichment import.
// Paste into scripts/openapi/enrichments.ts. Every symbol is M39-aliased. A LATER Object.assign block
// (m39-block.ts) re-covers ALL 27 M39 routes, so it wins over the existing partial M39 entries.
import {
  // ── response DTOs (mirror service.ts views, pinned by Conforms) ──
  ActivePrimaryDpoaResponseSchema as M39ActivePrimaryDpoaResponse,
  // ── request bodies + queries (the module's own validators) ──
  AddDpoaAgentBodySchema as M39AddDpoaAgentBody,
  AddRecipientBodySchema as M39AddRecipientBody,
  BereavementOutreachBodySchema as M39BereavementOutreachBody,
  CascadeRetryResponseSchema as M39CascadeRetryResponse,
  ConsentCatalogListResponseSchema as M39ConsentCatalogListResponse,
  ConsentDpoaAgentListResponseSchema as M39ConsentDpoaAgentListResponse,
  ConsentDpoaAgentResponseSchema as M39ConsentDpoaAgentResponse,
  ConsentEvalAuditQuerySchema as M39ConsentEvalAuditQuery,
  ConsentListResponseSchema as M39ConsentListResponse,
  ConsentRecipientListResponseSchema as M39ConsentRecipientListResponse,
  ConsentRecipientResponseSchema as M39ConsentRecipientResponse,
  ConsentRecordResponseSchema as M39ConsentRecordResponse,
  ConsentRenewalCycleListResponseSchema as M39ConsentRenewalCycleListResponse,
  ConsentTypeOverlayResponseSchema as M39ConsentTypeOverlayResponse,
  ConsentVersionChainResponseSchema as M39ConsentVersionChainResponse,
  CreateDraftBodySchema as M39CreateDraftBody,
  DelegatedAccessListResponseSchema as M39DelegatedAccessListResponse,
  EvalAuditQuerySchema as M39EvalAuditByPatientQuery,
  EvalAuditPageResponseSchema as M39EvalAuditPageResponse,
  ExpiringConsentsQuerySchema as M39ExpiringConsentsQuery,
  ExpiringConsentsResponseSchema as M39ExpiringConsentsResponse,
  PostMortemEligibilityListResponseSchema as M39PostMortemEligibilityListResponse,
  ReRenderReceiptResponseSchema as M39ReRenderReceiptResponse,
  RemoveRecipientBodySchema as M39RemoveRecipientBody,
  RenewBodySchema as M39RenewBody,
  RevokeBodySchema as M39RevokeBody,
  SignConsentBodySchema as M39SignConsentBody,
  SupersedeBodySchema as M39SupersedeBody,
  UpdateDpoaAgentBodySchema as M39UpdateDpoaAgentBody,
  UpdateDraftBodySchema as M39UpdateDraftBody,
  UpsertOverlayBodySchema as M39UpsertOverlayBody,
} from "../../apps/backend/src/modules/39-consent/routes/consent-typebox";

// M40 MDM response/request enrichment imports — every symbol M40-aliased to avoid colliding with
// the existing local `MdmSearchResponseSchema` / `MdmResolvedSummarySchema` consts in enrichments.ts.
// NOTE: `SearchQuerySchema as MdmSearchQuerySchema` is ALREADY imported near line 586 — reuse it,
// do not re-import.
import {
  BaaBodySchema as M40BaaBodySchema,
  MdmBaaCreatedResponseSchema as M40BaaCreatedResponseSchema,
  MdmBaaListResponseSchema as M40BaaListResponseSchema,
  GetOrCreateBodySchema as M40GetOrCreateBodySchema,
  MdmGetOrCreateResponseSchema as M40GetOrCreateResponseSchema,
  LicenseBodySchema as M40LicenseBodySchema,
  MdmLicenseRecordedResponseSchema as M40LicenseRecordedResponseSchema,
  MdmMergeApprovedResponseSchema as M40MergeApprovedResponseSchema,
  MdmMergeRequestsResponseSchema as M40MergeRequestsResponseSchema,
  NppesLookupBodySchema as M40NppesLookupBodySchema,
  MdmNppesLookupResponseSchema as M40NppesLookupResponseSchema,
  MdmNppesSyncLogResponseSchema as M40NppesSyncLogResponseSchema,
  MdmOverlayAppliedResponseSchema as M40OverlayAppliedResponseSchema,
  OverlayBodySchema as M40OverlayBodySchema,
  MdmProvisionalPromotedResponseSchema as M40ProvisionalPromotedResponseSchema,
  RejectBodySchema as M40RejectBodySchema,
  MdmRelationshipsResponseSchema as M40RelationshipsResponseSchema,
  MdmResolvedResponseSchema as M40ResolvedResponseSchema,
  MdmSearchResponseSchema as M40SearchResponseSchema,
} from "../../apps/backend/src/modules/40-mdm/routes/mdm-typebox";

import {
  BootstrapCarePlanSchema as M7BootstrapCarePlanSchema,
  CarePlanForPatientResponseSchema as M7CarePlanForPatientResponseSchema,
  CarePlanSummaryResponseSchema as M7CarePlanSummaryResponseSchema,
  CarePlanVersionPageResponseSchema as M7CarePlanVersionPageResponseSchema,
  CarePlanVersionResponseSchema as M7CarePlanVersionResponseSchema,
  CreateGoalSchema as M7CreateGoalSchema,
  CreateInterventionSchema as M7CreateInterventionSchema,
  CreateProblemSchema as M7CreateProblemSchema,
  CreateVersionSchema as M7CreateVersionSchema,
  DiscontinueInterventionSchema as M7DiscontinueInterventionSchema,
  FinalizeVersionSchema as M7FinalizeVersionSchema,
  OverdueStatusResponseSchema as M7OverdueStatusResponseSchema,
  PatchGoalSchema as M7PatchGoalSchema,
  PatchInterventionSchema as M7PatchInterventionSchema,
  PatchProblemSchema as M7PatchProblemSchema,
  RelevantElementsQuerySchema as M7RelevantElementsQuerySchema,
  RelevantElementsResponseSchema as M7RelevantElementsResponseSchema,
  ResolveProblemSchema as M7ResolveProblemSchema,
  ReturnToDraftSchema as M7ReturnToDraftSchema,
  SignVersionSchema as M7SignVersionSchema,
} from "../../apps/backend/src/modules/07-care-plan/routes/care-plan-typebox";
import {
  AddendumFinalizeResponseSchema as M8AddendumFinalizeResponseSchema,
  AddendumSelectionsResponseSchema as M8AddendumSelectionsResponseSchema,
  AddendumSignResponseSchema as M8AddendumSignResponseSchema,
  AdministrativeOverrideSchema as M8AdministrativeOverrideSchema,
  BillableQuerySchema as M8BillableQuerySchema,
  BillableResponseSchema as M8BillableResponseSchema,
  CaptureMileageSchema as M8CaptureMileageSchema,
  CaptureVitalsSchema as M8CaptureVitalsSchema,
  CarePlanLinkResponseSchema as M8CarePlanLinkResponseSchema,
  CarePlanLinkSchema as M8CarePlanLinkSchema,
  CosignSignResponseSchema as M8CosignSignResponseSchema,
  CosignatureReadResponseSchema as M8CosignatureReadResponseSchema,
  CosignatureStatusResponseSchema as M8CosignatureStatusResponseSchema,
  CreateAddendumResponseSchema as M8CreateAddendumResponseSchema,
  CreateAddendumSchema as M8CreateAddendumSchema,
  CreateEncounterSchema as M8CreateEncounterSchema,
  CreatedEncounterResponseSchema as M8CreatedEncounterResponseSchema,
  EncounterListQuerySchema as M8EncounterListQuerySchema,
  EncounterListResponseSchema as M8EncounterListResponseSchema,
  EncounterStatusResponseSchema as M8EncounterStatusResponseSchema,
  EncounterViewResponseSchema as M8EncounterViewResponseSchema,
  EvvReconcileResponseSchema as M8EvvReconcileResponseSchema,
  EvvReconcileSchema as M8EvvReconcileSchema,
  FinalizeEncounterSchema as M8FinalizeEncounterSchema,
  FinalizeResponseSchema as M8FinalizeResponseSchema,
  HearthnoteEnhanceSchema as M8HearthnoteEnhanceSchema,
  LateEntryOverrideSchema as M8LateEntryOverrideSchema,
  MileageResultResponseSchema as M8MileageResultResponseSchema,
  ModificationDecisionSchema as M8ModificationDecisionSchema,
  ModificationResponseSchema as M8ModificationResponseSchema,
  RenderPayloadResponseSchema as M8RenderPayloadResponseSchema,
  SelectionsUpdateResponseSchema as M8SelectionsUpdateResponseSchema,
  SignEncounterSchema as M8SignEncounterSchema,
  SignResponseSchema as M8SignResponseSchema,
  SignedSinceQuerySchema as M8SignedSinceQuerySchema,
  SupervisorReleaseSchema as M8SupervisorReleaseSchema,
  UpdateSelectionsSchema as M8UpdateSelectionsSchema,
  VitalsResultResponseSchema as M8VitalsResultResponseSchema,
  VoidEncounterSchema as M8VoidEncounterSchema,
  VoidResponseSchema as M8VoidResponseSchema,
} from "../../apps/backend/src/modules/08-encounters/routes/encounters-typebox";
import {
  AcknowledgeChangeSchema as M9AcknowledgeChangeSchema,
  AssessmentListQuerySchema as M9AssessmentListQuerySchema,
  AssessmentListResponseSchema as M9AssessmentListResponseSchema,
  AssessmentSummaryResponseSchema as M9AssessmentSummaryResponseSchema,
  AssessmentViewResponseSchema as M9AssessmentViewResponseSchema,
  CorrectAssessmentSchema as M9CorrectAssessmentSchema,
  CosignatureSchema as M9CosignatureSchema,
  CreateLicenseSchema as M9CreateLicenseSchema,
  DeltaQuerySchema as M9DeltaQuerySchema,
  LatestBatchQuerySchema as M9LatestBatchQuerySchema,
  LatestBatchResponseSchema as M9LatestBatchResponseSchema,
  RecordAssessmentSchema as M9RecordAssessmentSchema,
  ScaleDeltaResponseSchema as M9ScaleDeltaResponseSchema,
  ScaleLicenseListResponseSchema as M9ScaleLicenseListResponseSchema,
  ScalePolicyListResponseSchema as M9ScalePolicyListResponseSchema,
  ScaleSeriesResponseSchema as M9ScaleSeriesResponseSchema,
  SeriesBatchQuerySchema as M9SeriesBatchQuerySchema,
  SeriesQuerySchema as M9SeriesQuerySchema,
  SignificantChangeListResponseSchema as M9SignificantChangeListResponseSchema,
  UpdateLicenseSchema as M9UpdateLicenseSchema,
  UpdateScalePolicySchema as M9UpdateScalePolicySchema,
} from "../../apps/backend/src/modules/09-assessments/routes/assessments-typebox";
import {
  AssembleSubmissionSchema as M10AssembleSubmissionSchema,
  CorrectTimepointSchema as M10CorrectTimepointSchema,
  DashboardQuerySchema as M10DashboardQuerySchema,
  HopeAssessmentListResponseSchema as M10HopeAssessmentListResponseSchema,
  HopeAssessmentResponseSchema as M10HopeAssessmentResponseSchema,
  HopeComplianceResponseSchema as M10HopeComplianceResponseSchema,
  HopeRegenerateResponseSchema as M10HopeRegenerateResponseSchema,
  HopeScheduleListResponseSchema as M10HopeScheduleListResponseSchema,
  HopeScheduleResponseSchema as M10HopeScheduleResponseSchema,
  HopeSfvListResponseSchema as M10HopeSfvListResponseSchema,
  HopeSfvResponseSchema as M10HopeSfvResponseSchema,
  HopeSubmissionListResponseSchema as M10HopeSubmissionListResponseSchema,
  HopeSubmissionResponseSchema as M10HopeSubmissionResponseSchema,
  HopeSummaryRequestedResponseSchema as M10HopeSummaryRequestedResponseSchema,
  HopeValidationResponseSchema as M10HopeValidationResponseSchema,
  RecordSfvSchema as M10RecordSfvSchema,
  RecordTimepointSchema as M10RecordTimepointSchema,
  RegenerateSchedulesSchema as M10RegenerateSchedulesSchema,
  RetrySubmissionSchema as M10RetrySubmissionSchema,
  ScheduleListQuerySchema as M10ScheduleListQuerySchema,
  SfvWorklistQuerySchema as M10SfvWorklistQuerySchema,
  SignTimepointSchema as M10SignTimepointSchema,
  SkipScheduleSchema as M10SkipScheduleSchema,
  SubmissionListQuerySchema as M10SubmissionListQuerySchema,
  SummaryPdfSchema as M10SummaryPdfSchema,
  UpdateDraftSchema as M10UpdateDraftSchema,
} from "../../apps/backend/src/modules/10-hope/routes/hope-typebox";
import {
  CompleteOrderRequest as M11CompleteOrderRequest,
  CorrectOrderRequest as M11CorrectOrderRequest,
  CosignRequest as M11CosignRequest,
  CreateOrderRequest as M11CreateOrderRequest,
  CreateStandingOrderRequest as M11CreateStandingOrderRequest,
  DiscontinueRequest as M11DiscontinueRequest,
  DiscontinueStandingOrderRequest as M11DiscontinueStandingOrderRequest,
  OrderListQuerySchema as M11OrderListQuerySchema,
  OrderListResponseSchema as M11OrderListResponseSchema,
  OrderViewResponseSchema as M11OrderViewResponseSchema,
  RecordVerbalRequest as M11RecordVerbalRequest,
  RegenerateVerbalTimerRequest as M11RegenerateVerbalTimerRequest,
  RequestSignatureRequest as M11RequestSignatureRequest,
  SignOnBehalfRequest as M11SignOnBehalfRequest,
  SignOrderRequest as M11SignOrderRequest,
  SpawnResponseSchema as M11SpawnResponseSchema,
  SpawnStandingOrderRequest as M11SpawnStandingOrderRequest,
  StandingOrderListResponseSchema as M11StandingOrderListResponseSchema,
  StandingOrderViewResponseSchema as M11StandingOrderViewResponseSchema,
  SuggestionsResponseSchema as M11SuggestionsResponseSchema,
  UpdateOrderRequest as M11UpdateOrderRequest,
  UpdateStandingOrderRequest as M11UpdateStandingOrderRequest,
  VerbalPolicyRequest as M11VerbalPolicyRequest,
  VerbalPolicyViewResponseSchema as M11VerbalPolicyViewResponseSchema,
} from "../../apps/backend/src/modules/11-orders/routes/orders-typebox";
import {
  ApproveRefillRequest as M12ApproveRefillRequest,
  CompleteRequest as M12CompleteRequest,
  ControlledSubstancePolicyRequest as M12ControlledSubstancePolicyRequest,
  ControlledSubstancePolicyResponseSchema as M12ControlledSubstancePolicyResponseSchema,
  CorrectMedicationOrderRequest as M12CorrectMedicationOrderRequest,
  CosignRequest as M12CosignRequest,
  CreateMedicationOrderRequest as M12CreateMedicationOrderRequest,
  DenyRefillRequest as M12DenyRefillRequest,
  DiscontinueRequest as M12DiscontinueRequest,
  EnrollPrescriberRequest as M12EnrollPrescriberRequest,
  HistoryRefreshResponseSchema as M12HistoryRefreshResponseSchema,
  MedicationHistoryResponseSchema as M12MedicationHistoryResponseSchema,
  MedicationOrderListQuerySchema as M12MedicationOrderListQuerySchema,
  MedicationOrderListResponseSchema as M12MedicationOrderListResponseSchema,
  MedicationOrderResponseSchema as M12MedicationOrderResponseSchema,
  NewOrderIdResponseSchema as M12NewOrderIdResponseSchema,
  PrescriberRosterListResponseSchema as M12PrescriberRosterListResponseSchema,
  ReconcileRequest as M12ReconcileRequest,
  RecordVerbalRequest as M12RecordVerbalRequest,
  RefillInboxPolicyRequest as M12RefillInboxPolicyRequest,
  RefillInboxPolicyResponseSchema as M12RefillInboxPolicyResponseSchema,
  RefillListResponseSchema as M12RefillListResponseSchema,
  RefillRequestResponseSchema as M12RefillRequestResponseSchema,
  RequestSignatureRequest as M12RequestSignatureRequest,
  RevokePrescriberRequest as M12RevokePrescriberRequest,
  RxBenefitLookupRequest as M12RxBenefitLookupRequest,
  SignControlledCompleteRequest as M12SignControlledCompleteRequest,
  SignControlledInitiateRequest as M12SignControlledInitiateRequest,
  SignMedicationOrderRequest as M12SignMedicationOrderRequest,
  TransmissionResponseSchema as M12TransmissionResponseSchema,
  UpdateMedicationOrderRequest as M12UpdateMedicationOrderRequest,
} from "../../apps/backend/src/modules/12-dosespot/routes/dosespot-typebox";
import {
  AcknowledgeCaregiverRequest as M13AcknowledgeCaregiverRequest,
  AcknowledgeReturnRequest as M13AcknowledgeReturnRequest,
  AddCaregiverReportedLineRequest as M13AddCaregiverReportedLineRequest,
  AdministrationListQuerySchema as M13AdministrationListQuerySchema,
  AdministrationListResponseSchema as M13AdministrationListResponseSchema,
  AdministrationPolicyRequest as M13AdministrationPolicyRequest,
  AdministrationPolicyViewSchema as M13AdministrationPolicyViewSchema,
  AdministrationViewSchema as M13AdministrationViewSchema,
  CorrectAdministrationRequest as M13CorrectAdministrationRequest,
  DeploymentListResponseSchema as M13DeploymentListResponseSchema,
  DeploymentQuerySchema as M13DeploymentQuerySchema,
  DeploymentViewSchema as M13DeploymentViewSchema,
  DisputeCaregiverRequest as M13DisputeCaregiverRequest,
  FinalizeReconciliationRequest as M13FinalizeReconciliationRequest,
  IntentionalHoldRequest as M13IntentionalHoldRequest,
  IvSessionViewSchema as M13IvSessionViewSchema,
  MissedDoseListResponseSchema as M13MissedDoseListResponseSchema,
  MissedDoseQuerySchema as M13MissedDoseQuerySchema,
  OfflineSyncRequest as M13OfflineSyncRequest,
  RecordAdministrationRequest as M13RecordAdministrationRequest,
  RecordCaregiverAttestedRequest as M13RecordCaregiverAttestedRequest,
  RecordDecisionRequest as M13RecordDecisionRequest,
  RecordRefusalRequest as M13RecordRefusalRequest,
  ScheduledDoseListResponseSchema as M13ScheduledDoseListResponseSchema,
  ScheduledDoseQuerySchema as M13ScheduledDoseQuerySchema,
  UpdateDecisionRequest as M13UpdateDecisionRequest,
  VoidAdministrationRequest as M13VoidAdministrationRequest,
  VoidReconciliationRequest as M13VoidReconciliationRequest,
  WitnessAttestRequest as M13WitnessAttestRequest,
  WorksheetListResponseSchema as M13WorksheetListResponseSchema,
  WorksheetQuerySchema as M13WorksheetQuerySchema,
  WorksheetViewSchema as M13WorksheetViewSchema,
} from "../../apps/backend/src/modules/13-emar/routes/emar-typebox";
import {
  ActionItemListQuerySchema as M14ActionItemListQuerySchema,
  ActionItemListResponseSchema as M14ActionItemListResponseSchema,
  ActionItemViewSchema as M14ActionItemViewSchema,
  AddAgendaItemRequest as M14AddAgendaItemRequest,
  AdjournMeetingRequest as M14AdjournMeetingRequest,
  AgendaItemViewSchema as M14AgendaItemViewSchema,
  AmendmentResponseSchema as M14AmendmentResponseSchema,
  AttendanceViewSchema as M14AttendanceViewSchema,
  CancelMeetingRequest as M14CancelMeetingRequest,
  CreateActionItemRequest as M14CreateActionItemRequest,
  DecisionViewSchema as M14DecisionViewSchema,
  MeetingViewSchema as M14MeetingViewSchema,
  MinutesViewSchema as M14MinutesViewSchema,
  PacketDigestViewSchema as M14PacketDigestViewSchema,
  PacketListResponseSchema as M14PacketListResponseSchema,
  RecordAttendanceRequest as M14RecordAttendanceRequest,
  RecordDecisionRequest as M14RecordDecisionRequest,
  RecurringPolicyRequest as M14RecurringPolicyRequest,
  RecurringPolicyViewSchema as M14RecurringPolicyViewSchema,
  RemovedResponseSchema as M14RemovedResponseSchema,
  RescheduleMeetingRequest as M14RescheduleMeetingRequest,
  ScheduleListResponseSchema as M14ScheduleListResponseSchema,
  ScheduleQuerySchema as M14ScheduleQuerySchema,
  SubmitAmendmentRequest as M14SubmitAmendmentRequest,
  SupersedeDecisionRequest as M14SupersedeDecisionRequest,
  UpdateActionItemRequest as M14UpdateActionItemRequest,
  UpdateAgendaItemRequest as M14UpdateAgendaItemRequest,
  UpdateAttendanceRequest as M14UpdateAttendanceRequest,
  UpdateDecisionRequest as M14UpdateDecisionRequest,
} from "../../apps/backend/src/modules/14-idg/routes/idg-typebox";
import {
  ApproveTimeOffRequest as M17ApproveTimeOffRequest,
  AvailabilityQuerySchema as M17AvailabilityQuerySchema,
  AvailabilityViewSchema as M17AvailabilityViewSchema,
  CancelTimeOffRequest as M17CancelTimeOffRequest,
  CancelVisitRequest as M17CancelVisitRequest,
  CreateRecurringVisitRequest as M17CreateRecurringVisitRequest,
  CreateVisitRequest as M17CreateVisitRequest,
  DayViewQuerySchema as M17DayViewQuerySchema,
  DayViewResponseSchema as M17DayViewResponseSchema,
  DenyTimeOffRequest as M17DenyTimeOffRequest,
  DiscontinueRecurringVisitRequest as M17DiscontinueRecurringVisitRequest,
  DismissProposalRequest as M17DismissProposalRequest,
  EditVisitRequest as M17EditVisitRequest,
  MapViewQuerySchema as M17MapViewQuerySchema,
  MapViewResponseSchema as M17MapViewResponseSchema,
  MetricsQuerySchema as M17MetricsQuerySchema,
  NoShowVisitRequest as M17NoShowVisitRequest,
  OptimizeDayRequest as M17OptimizeDayRequest,
  OptimizeDayResponseSchema as M17OptimizeDayResponseSchema,
  PortalUpcomingQuerySchema as M17PortalUpcomingQuerySchema,
  PortalUpcomingResponseSchema as M17PortalUpcomingResponseSchema,
  ProposalListQuerySchema as M17ProposalListQuerySchema,
  ProposalListResponseSchema as M17ProposalListResponseSchema,
  ProposalViewSchema as M17ProposalViewSchema,
  ReassignVisitRequest as M17ReassignVisitRequest,
  RecurringListQuerySchema as M17RecurringListQuerySchema,
  RecurringListResponseSchema as M17RecurringListResponseSchema,
  RecurringViewSchema as M17RecurringViewSchema,
  RequestTimeOffRequest as M17RequestTimeOffRequest,
  RescheduleResponseSchema as M17RescheduleResponseSchema,
  RescheduleVisitRequest as M17RescheduleVisitRequest,
  RouteEfficiencyQuerySchema as M17RouteEfficiencyQuerySchema,
  RouteEfficiencyResponseSchema as M17RouteEfficiencyResponseSchema,
  StartVisitRequest as M17StartVisitRequest,
  TimeOffListQuerySchema as M17TimeOffListQuerySchema,
  TimeOffListResponseSchema as M17TimeOffListResponseSchema,
  TimeOffViewSchema as M17TimeOffViewSchema,
  UpsertAvailabilityRequest as M17UpsertAvailabilityRequest,
  VisitListQuerySchema as M17VisitListQuerySchema,
  VisitListResponseSchema as M17VisitListResponseSchema,
  VisitMetricsResponseSchema as M17VisitMetricsResponseSchema,
  VisitViewSchema as M17VisitViewSchema,
  WeekViewQuerySchema as M17WeekViewQuerySchema,
  WeekViewResponseSchema as M17WeekViewResponseSchema,
} from "../../apps/backend/src/modules/17-scheduling/routes/scheduling-typebox";
import {
  AggregatorListQuery as M18AggregatorListQuery,
  CancelSubmissionRequest as M18CancelSubmissionRequest,
  CheckInRequest as M18CheckInRequest,
  CheckOutRequest as M18CheckOutRequest,
  ClinicianAttestResolutionRequest as M18ClinicianAttestResolutionRequest,
  CorrectEventRequest as M18CorrectEventRequest,
  CreatePerAddressOverrideRequest as M18CreatePerAddressOverrideRequest,
  EditTenantPolicyRequest as M18EditTenantPolicyRequest,
  EventGetQuery as M18EventGetQuery,
  EventListQuery as M18EventListQuery,
  EvvAggregatorSubmissionListResponse as M18EvvAggregatorSubmissionListResponse,
  EvvAggregatorSubmissionView as M18EvvAggregatorSubmissionView,
  EvvArrivalView as M18EvvArrivalView,
  EvvBracketView as M18EvvBracketView,
  EvvCheckResultListResponse as M18EvvCheckResultListResponse,
  EvvCheckResultView as M18EvvCheckResultView,
  EvvDeviceListResponse as M18EvvDeviceListResponse,
  EvvDeviceView as M18EvvDeviceView,
  EvvEventListResponse as M18EvvEventListResponse,
  EvvEventView as M18EvvEventView,
  EvvGeofencePolicyView as M18EvvGeofencePolicyView,
  EvvLocationListResponse as M18EvvLocationListResponse,
  EvvMetricsView as M18EvvMetricsView,
  EvvMissingResolutionListResponse as M18EvvMissingResolutionListResponse,
  EvvMissingResolutionView as M18EvvMissingResolutionView,
  MembershipIdQuery as M18MembershipIdQuery,
  MetricsQuery as M18MetricsQuery,
  MissingResolutionListQuery as M18MissingResolutionListQuery,
  OfflineSyncRequest as M18OfflineSyncRequest,
  RejectDeviceRequest as M18RejectDeviceRequest,
  ResubmitSubmissionRequest as M18ResubmitSubmissionRequest,
  RetireDeviceRequest as M18RetireDeviceRequest,
  SelfRegisterDeviceRequest as M18SelfRegisterDeviceRequest,
  SupervisorOverrideResolutionRequest as M18SupervisorOverrideResolutionRequest,
  SuspendDeviceRequest as M18SuspendDeviceRequest,
} from "../../apps/backend/src/modules/18-evv/routes/evv-typebox";
import {
  AbandonReviewRequest as M22AbandonReviewRequest,
  AddTagRequest as M22AddTagRequest,
  BulkApproveRequest as M22BulkApproveRequest,
  ClassificationListResponseSchema as M22ClassificationListResponseSchema,
  ClassificationQuerySchema as M22ClassificationQuerySchema,
  CompleteReviewRequest as M22CompleteReviewRequest,
  CompleteVerifiedUploadRequest as M22CompleteVerifiedUploadRequest,
  CompleteVerifiedUploadResponse as M22CompleteVerifiedUploadResponse,
  ConfirmClassificationRequest as M22ConfirmClassificationRequest,
  DiscardBatchRequest as M22DiscardBatchRequest,
  ExportPhiBundleRequest as M22ExportPhiBundleRequest,
  FormFillResponseSchema as M22FormFillResponseSchema,
  FormTemplateResponseSchema as M22FormTemplateResponseSchema,
  FormTemplateVersionResponseSchema as M22FormTemplateVersionResponseSchema,
  InitiateVerifiedUploadRequest as M22InitiateVerifiedUploadRequest,
  InitiateVerifiedUploadResponse as M22InitiateVerifiedUploadResponse,
  IntakeUploadRequest as M22IntakeUploadRequest,
  JobDetailResponseSchema as M22JobDetailResponseSchema,
  JobQuerySchema as M22JobQuerySchema,
  JobsListQuerySchema as M22JobsListQuerySchema,
  OpenReviewRequest as M22OpenReviewRequest,
  PatchDocumentRequest as M22PatchDocumentRequest,
  PublishOverlayRequest as M22PublishOverlayRequest,
  PublishTemplateRequest as M22PublishTemplateRequest,
  RecordDecisionRequest as M22RecordDecisionRequest,
  ResolveDiscrepancyRequest as M22ResolveDiscrepancyRequest,
  RetryRenderRequest as M22RetryRenderRequest,
  ReviewDetailResponseSchema as M22ReviewDetailResponseSchema,
  ReviewQuerySchema as M22ReviewQuerySchema,
  SignedUrlRequest as M22SignedUrlRequest,
  SignedUrlResponseSchema as M22SignedUrlResponseSchema,
  TenantOverlayListResponseSchema as M22TenantOverlayListResponseSchema,
  UploadDocumentRequest as M22UploadDocumentRequest,
  UploadVersionRequest as M22UploadVersionRequest,
  VersionViewSchema as M22VersionViewSchema,
} from "../../apps/backend/src/modules/22-documents/routes/documents-typebox";
// M31 Portal/Telehealth (§4.2) — the request/response contracts the §4.1 route handlers parse/return.
import {
  AccountSuspendRequest as M31AccountSuspendRequest,
  AckResponse as M31AckResponse,
  AmendmentSubmitRequest as M31AmendmentSubmitRequest,
  AmendmentSubmitResponse as M31AmendmentSubmitResponse,
  CarePlanSummaryResponse as M31CarePlanSummaryResponse,
  CareSummaryResponse as M31CareSummaryResponse,
  CaregiverAttestedAdministrationRequest as M31CaregiverAttestRequest,
  CaregiverAttestedAdministrationResponse as M31CaregiverAttestResponse,
  DocumentDownloadUrlResponse as M31DocumentDownloadUrlResponse,
  InviteBereavedRequest as M31InviteBereavedRequest,
  LayListResponse as M31LayListResponse,
  MessageSendRequest as M31MessageSendRequest,
  MessageSendResponse as M31MessageSendResponse,
  MessagesChannelResponse as M31MessagesChannelResponse,
  NotificationPreferenceUpdateRequest as M31NotificationPreferenceUpdateRequest,
  NotificationPreferencesResponse as M31NotificationPreferencesResponse,
  PortalAccountGrantListResponse as M31PortalAccountGrantListResponse,
  PortalAccountListResponse as M31PortalAccountListResponse,
  PortalAuditViewResponse as M31PortalAuditViewResponse,
  PortalDocumentUploadInitRequest as M31PortalDocumentUploadInitRequest,
  PortalDocumentUploadInitResponse as M31PortalDocumentUploadInitResponse,
  PortalEngagementResponse as M31PortalEngagementResponse,
  PortalInvitationIssueRequest as M31PortalInvitationIssueRequest,
  PortalInvitationIssueResponse as M31PortalInvitationIssueResponse,
  PortalInvitationListResponse as M31PortalInvitationListResponse,
  PortalSessionCurrentResponse as M31PortalSessionCurrentResponse,
  SelectPatientRequest as M31SelectPatientRequest,
  SelectPatientResponse as M31SelectPatientResponse,
  StartRecordingRequest as M31StartRecordingRequest,
  StepUpRequest as M31StepUpRequest,
  TelehealthJoinResponse as M31TelehealthJoinResponse,
  TelehealthVisitDetailResponse as M31TelehealthVisitDetailResponse,
  TelehealthVisitListResponse as M31TelehealthVisitListResponse,
  UploadCompleteResponse as M31UploadCompleteResponse,
  WebhookAckResponse as M31WebhookAckResponse,
  WithinQuery as M31WithinQuery,
} from "../../apps/backend/src/modules/31-portal/routes/portal-typebox";

// M35 Subscription Billing — the §4.4 request/response wire contracts the §4.1–4.3 handlers `parse(...)` /
// return (subscription-typebox.ts). Reused verbatim so the published contract cannot drift from the
// validator (the M30/M31 precedent).
import {
  AckResponseDto as M35AckResponseDto,
  AddMeterBodySchema as M35AddMeterBody,
  AdminSubscriptionListQuerySchema as M35AdminSubscriptionListQuery,
  ApplyPromoBodySchema as M35ApplyPromoBody,
  AttachPaymentMethodBodySchema as M35AttachPaymentMethodBody,
  BillingStatusDto as M35BillingStatusDto,
  ChangePlanBodySchema as M35ChangePlanBody,
  CreatePlanBodySchema as M35CreatePlanBody,
  CreatePromoBodySchema as M35CreatePromoBody,
  CreateSubscriptionBodySchema as M35CreateSubscriptionBody,
  CurrentRevenueResponseDto as M35CurrentRevenueResponseDto,
  DenyRefundBodySchema as M35DenyRefundBody,
  DunningDto as M35DunningDto,
  DunningListQuerySchema as M35DunningListQuery,
  DunningListResponseDto as M35DunningListResponseDto,
  InvoiceDetailDto as M35InvoiceDetailDto,
  InvoiceListResponseDto as M35InvoiceListResponseDto,
  ListQuerySchema as M35ListQuery,
  MeterAdminDto as M35MeterAdminDto,
  PauseSubscriptionBodySchema as M35PauseSubscriptionBody,
  PaymentMethodDto as M35PaymentMethodDto,
  PaymentMethodListResponseDto as M35PaymentMethodListResponseDto,
  PlanAdminDto as M35PlanAdminDto,
  PlanAdminListResponseDto as M35PlanAdminListResponseDto,
  PlanCatalogListResponseDto as M35PlanCatalogListResponseDto,
  PromoApplicationDto as M35PromoApplicationDto,
  PromoDto as M35PromoDto,
  PromoListResponseDto as M35PromoListResponseDto,
  RedirectUrlDto as M35RedirectUrlDto,
  RefundDto as M35RefundDto,
  RefundListResponseDto as M35RefundListResponseDto,
  RequestRefundBodySchema as M35RequestRefundBody,
  RevenueSnapshotDto as M35RevenueSnapshotDto,
  RevenueSnapshotListResponseDto as M35RevenueSnapshotListResponseDto,
  RevokePromoBodySchema as M35RevokePromoBody,
  SetupIntentResponseDto as M35SetupIntentResponseDto,
  SubscriptionAdminListResponseDto as M35SubscriptionAdminListResponseDto,
  SubscriptionAdminResponseDto as M35SubscriptionAdminResponseDto,
  SubscriptionResponseDto as M35SubscriptionResponseDto,
  UpdateMeterBodySchema as M35UpdateMeterBody,
  UpdatePlanBodySchema as M35UpdatePlanBody,
  UpdatePromoBodySchema as M35UpdatePromoBody,
  UsageCurrentResponseDto as M35UsageCurrentResponseDto,
  UsageHistoryResponseDto as M35UsageHistoryResponseDto,
  WebhookReceiptListResponseDto as M35WebhookReceiptListResponseDto,
} from "../../apps/backend/src/modules/35-subscription/routes/subscription-typebox";

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
const ComplianceListQuerySchema = Type.Object({
  state: Type.Optional(Type.String()),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer()),
});
const AdmissionPageResponseSchema = Type.Object({
  items: Type.Array(AdmissionSummaryRowSchema),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
const AdmissionListResponseSchema = Type.Object({ items: Type.Array(AdmissionSummaryRowSchema) });

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
  /**
   * Request headers the route's pre-handlers require or read (e.g. `Idempotency-Key`,
   * `If-Match`) — each becomes an `in: header` OpenAPI parameter. Reused literally by
   * `emit.ts`; keep the header name in its canonical casing (matched case-insensitively
   * by clients/servers, but kept stable here for doc readability).
   */
  headers?: Record<string, { required?: boolean; description?: string }>;
  /** The route's actual success status code (`reply.code(...)`). Default 200 when omitted. */
  status?: 200 | 201 | 202 | 204;
  /** Human summary for the operation. */
  summary?: string;
}

// Shared header specs for the two concurrency pre-handlers (`requireIdempotencyKey`/`requireIfMatch`,
// TASK-020) — reused literally on every route that mounts them so the contract and the guard never drift.
const IDEMPOTENCY_KEY_HEADER: RouteEnrichment["headers"] = {
  "Idempotency-Key": {
    required: true,
    description:
      "Client-generated key (1-128 chars). A retried request with the same key + body returns the cached result instead of re-executing (§4.1.1).",
  },
};
const IF_MATCH_HEADER: RouteEnrichment["headers"] = {
  "If-Match": {
    required: true,
    description:
      "The row version the caller last read. A stale value fails with 412 STALE_VERSION (§7.7/§2.5).",
  },
};
const IDEMPOTENCY_AND_IF_MATCH_HEADERS: RouteEnrichment["headers"] = {
  ...IDEMPOTENCY_KEY_HEADER,
  ...IF_MATCH_HEADER,
};

/** `METHOD /path` → enrichment. Keys MUST match a scanned route (openapi:check enforces). */
export const ROUTE_ENRICHMENTS: Record<string, RouteEnrichment> = {
  // ── M35 Subscription Billing (§4.1 tenant + §4.2 platform-ops + §4.3 webhook). 55 routes; every one
  // ships its request/response contract (subscription-typebox.ts) so the generated client is fully typed
  // and the new-module deficit floor stays 0. Money is INTEGER CENTS; no PHI (§8.5).
  "GET /api/v1/plans": { response: M35PlanCatalogListResponseDto, summary: "List active plans" },
  "GET /api/v1/subscription": {
    response: M35SubscriptionResponseDto,
    summary: "Read current subscription",
  },
  "POST /api/v1/subscription": {
    body: M35CreateSubscriptionBody,
    response: M35SubscriptionResponseDto,
    summary: "Create subscription",
  },
  "PATCH /api/v1/subscription": {
    body: M35ChangePlanBody,
    response: M35SubscriptionResponseDto,
    summary: "Change plan",
  },
  "POST /api/v1/subscription/cancel": {
    response: M35SubscriptionResponseDto,
    summary: "Cancel at period end",
  },
  "POST /api/v1/subscription/resume": {
    response: M35SubscriptionResponseDto,
    summary: "Resume subscription",
  },
  "POST /api/v1/subscription/apply_promo": {
    body: M35ApplyPromoBody,
    response: M35PromoApplicationDto,
    summary: "Apply promo code",
  },
  "GET /api/v1/payment_methods": {
    response: M35PaymentMethodListResponseDto,
    summary: "List payment methods",
  },
  "POST /api/v1/payment_methods/setup_intent": {
    response: M35SetupIntentResponseDto,
    summary: "Create Stripe SetupIntent",
  },
  "POST /api/v1/payment_methods/attach": {
    body: M35AttachPaymentMethodBody,
    response: M35PaymentMethodDto,
    summary: "Attach payment method",
  },
  "PATCH /api/v1/payment_methods/:id/set_default": {
    response: M35PaymentMethodDto,
    summary: "Set default payment method",
  },
  "DELETE /api/v1/payment_methods/:id": {
    response: M35AckResponseDto,
    summary: "Detach payment method",
  },
  "GET /api/v1/invoices": {
    query: M35ListQuery,
    response: M35InvoiceListResponseDto,
    summary: "List invoices",
  },
  "GET /api/v1/invoices/:id": { response: M35InvoiceDetailDto, summary: "Read invoice detail" },
  "GET /api/v1/invoices/:id/hosted_url": {
    response: M35RedirectUrlDto,
    summary: "Stripe-hosted invoice url",
  },
  "GET /api/v1/invoices/:id/pdf": { response: M35RedirectUrlDto, summary: "Invoice PDF url" },
  "GET /api/v1/usage/current": {
    response: M35UsageCurrentResponseDto,
    summary: "Current-period usage",
  },
  "GET /api/v1/usage/history": {
    query: M35ListQuery,
    response: M35UsageHistoryResponseDto,
    summary: "Historical usage",
  },
  "GET /api/v1/billing/status": {
    response: M35BillingStatusDto,
    summary: "Lightweight billing status",
  },
  "GET /api/admin/plans": {
    response: M35PlanAdminListResponseDto,
    summary: "List all plans (admin)",
  },
  "GET /api/admin/plans/:id": { response: M35PlanAdminDto, summary: "Read a plan (admin)" },
  "POST /api/admin/plans": {
    body: M35CreatePlanBody,
    response: M35PlanAdminDto,
    summary: "Create draft plan",
  },
  "PATCH /api/admin/plans/:id": {
    body: M35UpdatePlanBody,
    response: M35PlanAdminDto,
    summary: "Update draft plan",
  },
  "POST /api/admin/plans/:id/activate": { response: M35PlanAdminDto, summary: "Activate plan" },
  "POST /api/admin/plans/:id/deprecate": { response: M35PlanAdminDto, summary: "Deprecate plan" },
  "POST /api/admin/plans/:id/meters": {
    body: M35AddMeterBody,
    response: M35MeterAdminDto,
    summary: "Add meter",
  },
  "PATCH /api/admin/plans/:id/meters/:meterId": {
    body: M35UpdateMeterBody,
    response: M35MeterAdminDto,
    summary: "Update meter",
  },
  "GET /api/admin/subscriptions": {
    query: M35AdminSubscriptionListQuery,
    response: M35SubscriptionAdminListResponseDto,
    summary: "List subscriptions (admin)",
  },
  "GET /api/admin/subscriptions/:id": {
    response: M35SubscriptionAdminResponseDto,
    summary: "Read any subscription",
  },
  "POST /api/admin/subscriptions/:id/pause": {
    body: M35PauseSubscriptionBody,
    response: M35SubscriptionAdminResponseDto,
    summary: "Pause subscription",
  },
  "POST /api/admin/subscriptions/:id/resume": {
    response: M35SubscriptionAdminResponseDto,
    summary: "Resume subscription (admin)",
  },
  "POST /api/admin/subscriptions/:id/cancel": {
    response: M35SubscriptionAdminResponseDto,
    summary: "Cancel immediately",
  },
  "POST /api/admin/subscriptions/:id/apply_promo": {
    body: M35ApplyPromoBody,
    response: M35PromoApplicationDto,
    summary: "Apply promo (admin)",
  },
  "POST /api/admin/subscriptions/:id/revoke_promo": {
    body: M35RevokePromoBody,
    response: M35AckResponseDto,
    summary: "Revoke applied promo",
  },
  "GET /api/admin/dunning": {
    query: M35DunningListQuery,
    response: M35DunningListResponseDto,
    summary: "List subscriptions in dunning (admin)",
  },
  "POST /api/admin/dunning/:subscriptionId/skip_stage": {
    response: M35DunningDto,
    summary: "Skip dunning stage",
  },
  "POST /api/admin/dunning/:subscriptionId/reset": {
    response: M35DunningDto,
    summary: "Reset dunning",
  },
  "POST /api/admin/refunds": {
    body: M35RequestRefundBody,
    response: M35RefundDto,
    summary: "Request refund",
  },
  "POST /api/admin/refunds/:id/approve": { response: M35RefundDto, summary: "Approve refund" },
  "POST /api/admin/refunds/:id/deny": {
    body: M35DenyRefundBody,
    response: M35RefundDto,
    summary: "Deny refund",
  },
  "GET /api/admin/refunds": {
    query: M35ListQuery,
    response: M35RefundListResponseDto,
    summary: "List refunds",
  },
  "GET /api/admin/refunds/:id": { response: M35RefundDto, summary: "Read a refund (admin)" },
  "GET /api/admin/promos": { response: M35PromoListResponseDto, summary: "List promos" },
  "GET /api/admin/promos/:id": { response: M35PromoDto, summary: "Read a promo (admin)" },
  "POST /api/admin/promos": {
    body: M35CreatePromoBody,
    response: M35PromoDto,
    summary: "Create promo",
  },
  "PATCH /api/admin/promos/:id": {
    body: M35UpdatePromoBody,
    response: M35PromoDto,
    summary: "Update promo",
  },
  "POST /api/admin/promos/:id/deactivate": { response: M35PromoDto, summary: "Deactivate promo" },
  "GET /api/admin/revenue/snapshots": {
    query: M35ListQuery,
    response: M35RevenueSnapshotListResponseDto,
    summary: "List MRR/ARR snapshots",
  },
  "GET /api/admin/revenue/current": {
    response: M35CurrentRevenueResponseDto,
    summary: "Live MRR estimate",
  },
  "POST /api/admin/revenue/snapshots/compute": {
    response: M35RevenueSnapshotDto,
    summary: "Recompute MRR/ARR",
  },
  "GET /api/admin/usage/:organizationId/current": {
    response: M35UsageCurrentResponseDto,
    summary: "Tenant usage drill-down",
  },
  "GET /api/admin/webhooks/stripe/recent": {
    query: M35ListQuery,
    response: M35WebhookReceiptListResponseDto,
    summary: "Recent webhook receipts",
  },
  "POST /api/admin/webhooks/stripe/replay/:eventId": {
    response: M35AckResponseDto,
    summary: "Replay a webhook",
  },
  "POST /api/v1/webhooks/stripe": { summary: "Inbound Stripe webhook (HMAC-verified)" },

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
    summary:
      "Assemble a server-authoritative DRAFT claim (lines + HIPPS + SIA + initial validation run, §4.1 #1)",
    body: ClaimAssembleRequest,
    response: ClaimAssembleResponse,
    headers: IDEMPOTENCY_KEY_HEADER,
    status: 201,
  },
  "GET /api/v1/billing/claims": {
    summary: "List claims — cursor-paginated; filter by state / patient / ProviderEntity (§4.1 #2)",
    query: ClaimListQuerySchema,
  },
  "GET /api/v1/billing/claims/:id": {
    summary:
      "Single-claim detail — lines + HIPPS + SIA + latest run + submissions + acks (§4.1 #3)",
  },
  "PATCH /api/v1/billing/claims/:id": {
    summary:
      "DRAFT re-assembly edit — replace line set + totals; If-Match version; coder ICD-only scope (§4.1 #4)",
    body: ClaimPatchDraftBodySchema,
    headers: IDEMPOTENCY_AND_IF_MATCH_HEADERS,
  },
  "DELETE /api/v1/billing/claims/:id": {
    summary: "Delete a DRAFT claim (DRAFT-only; AI-block + idempotency, §4.1 #5)",
    headers: IDEMPOTENCY_KEY_HEADER,
    status: 204,
  },
  "POST /api/v1/billing/claims/:id/validate": {
    summary:
      "Trigger a validation_run for a claim (the manual re-run / initial trigger; 202, §4.1 #6)",
    body: ManualValidateRequest,
    headers: IDEMPOTENCY_KEY_HEADER,
    status: 202,
  },
  "POST /api/v1/billing/claims/:id/submit": {
    summary:
      "READY → SUBMITTED — emits m23.claim.submit_requested (PE scope + step-up + If-Match; 202, §4.1 #7)",
    headers: IDEMPOTENCY_AND_IF_MATCH_HEADERS,
    status: 202,
  },
  "POST /api/v1/billing/claims/:id/replace": {
    summary:
      "Build a TOB-817 replacement DRAFT (copies the original's lines; step-up + If-Match; 201, §4.1 #8)",
    body: ClaimReplaceRequest,
    headers: IDEMPOTENCY_AND_IF_MATCH_HEADERS,
    status: 201,
  },
  "POST /api/v1/billing/claims/:id/void": {
    summary: "Build a TOB-818 void DRAFT (no service lines; step-up + If-Match; 201, §4.1 #9)",
    body: ClaimVoidRequest,
    headers: IDEMPOTENCY_AND_IF_MATCH_HEADERS,
    status: 201,
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
    headers: IDEMPOTENCY_KEY_HEADER,
    status: 202,
  },
  "POST /api/v1/claims/:id/validation-runs/:runId/results/:resultId/override": {
    summary: "Override a failed validation result — approver-role ABAC + step-up (201, §4.1 #16)",
    body: OverrideValidationResultBodySchema,
    headers: IDEMPOTENCY_KEY_HEADER,
    status: 201,
  },
  // ── rule-config overlay (rule-config.routes.ts) ──
  "GET /api/v1/billing/rule-configs": {
    summary:
      "List validation-rule overlay rows — platform snapshot + tenant overlays (cursor-paginated, §4.1 #18)",
    query: RuleConfigListQuerySchema,
  },
  "GET /api/v1/billing/rule-configs/:id": {
    summary: "Read a single validation-rule overlay row (§4.1)",
  },
  "POST /api/v1/billing/rule-configs/custom": {
    summary:
      "Create a tenant CUSTOM validation rule (regulatory-required forbidden; 201, §4.1 #20)",
    body: CreateRuleConfigBodySchema,
    headers: IDEMPOTENCY_KEY_HEADER,
    status: 201,
  },
  "PATCH /api/v1/billing/rule-configs/:id": {
    summary: "Overlay edit — disable / re-severity / re-parameterize a rule (If-Match, §4.1 #19)",
    body: UpdateRuleConfigBodySchema,
    headers: IDEMPOTENCY_AND_IF_MATCH_HEADERS,
  },
  "DELETE /api/v1/billing/rule-configs/:id": {
    summary: "Revert a rule overlay to the platform default (If-Match, §4.1 #21)",
    headers: IDEMPOTENCY_AND_IF_MATCH_HEADERS,
    status: 204,
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
    summary:
      "Force / refresh-on-stale a 270/271 eligibility round-trip (202; no MBI on the wire, §4.1 #22)",
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
    summary:
      "Per-ProviderEntity sequestration-percentage timeline — effective-dated rows (D11, §4.1 #32)",
    query: RequiredProviderEntityQuerySchema,
  },
  "GET /api/v1/billing/sequestration-policies/active": {
    summary: "The active-on-now sequestration policy for a ProviderEntity (or null, §4.1)",
    query: RequiredProviderEntityQuerySchema,
  },
  "POST /api/v1/billing/sequestration-policies": {
    summary:
      "Forward-date a new sequestration policy row (percentage is a decimal string; 201, §4.1 #33)",
    body: ForwardDateSequestrationBodySchema,
  },
  // ── MAC credentials (mac-credentials.routes.ts, §3.6) ──
  "GET /api/v1/billing/mac-credentials": {
    summary:
      "List per-ProviderEntity MAC credentials — secrets masked, cursor-paginated (§4.1 #34)",
    query: MacCredentialListQuerySchema,
  },
  "GET /api/v1/billing/mac-credentials/:providerEntityId": {
    summary: "The MAC credential for one ProviderEntity, or null (§4.1)",
  },
  "POST /api/v1/billing/mac-credentials": {
    summary:
      "Upsert a MAC credential — clientSecret write-only/encrypted at the boundary; step-up (§4.1 #35)",
    body: UpsertMacCredentialBodySchema,
  },
  // ── AR dashboard + metrics (metrics.routes.ts) ──
  "GET /api/v1/billing/ar-dashboard": {
    summary:
      "AR-aging dashboard — aging buckets + denial / NOE-NOTR window-breach rates (org-wide or per-PE, §4.1 #37)",
    query: BillingMetricsQuerySchema,
  },
  "GET /api/v1/billing/metrics": {
    summary:
      "Per-window claim metric buckets (the M33 reporting consumer; org-wide or per-PE, §4.1 #38)",
    query: BillingMetricsQuerySchema,
  },
  // ── internal service-to-service seams (internal.routes.ts; system-principal only) ──
  "GET /api/v1/internal/billing/claim-day-projection": {
    summary:
      "Per-patient / org day rollups by level-of-care (M26 cap + M27 cost-report consumers, §4.1 #39)",
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
  "GET /api/v1/patients/:patientId/idg-history": {
    summary:
      "A patient's IDG review history — meetings reviewed in, with per-meeting decisions + action items (metadata only)",
    response: IdgPatientHistoryResponseSchema,
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
    summary:
      "Medicaid claim workbench — cursor-paginated, filterable by state/kind/MCO/patient (§4.1)",
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
    summary:
      "Run the §11 rule registry against the claim — returns the new validation run id (§4.1)",
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
    summary:
      "Every acknowledgment received — 999 / 277CA / state-specific outcome + error codes (§5.1)",
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
    summary:
      "Medicaid billing metrics — denial rate, open count, MCO breakdown, aging (M33-fed; §5.1)",
    query: M24ProviderEntityQuery,
    response: M24ArMetricsDto,
  },
  "GET /api/v1/medicaid-rule-config": {
    summary:
      "Per-tenant validation-rule overlay over the platform floor (regulatory rules lock; §11)",
    response: M24RuleConfigListResponse,
  },
  "PATCH /api/v1/medicaid-rule-config/:ruleKey": {
    summary:
      "Edit a rule overlay — enable/disable + parameters; regulatory-required rules reject (§11)",
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
    summary:
      "NF Room & Board pass-through arrangements — facility, effective dates, per-diems (§2.4)",
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
    summary:
      "Open a new cap period (snapshots the platform constant; emits m26.cap.year_opened; §4.1)",
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
    summary:
      "Lock the streamlined/proportional methodology — one-time, step-up required (D2/D12; §4.1)",
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
    summary:
      "Acknowledge a threshold event — records actor + timestamp (does not clear the breach; §4.1)",
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
    summary:
      "Propose a settlement worksheet from current accruals (cap_period_in_settlement ABAC; §4.1)",
    response: CapSettlementDto,
  },
  "PATCH /api/v1/cap/settlements/:periodId/finalize": {
    summary: "Finalize settlement — step-up; in_settlement → settled (D12; M26-F06; §4.1)",
    body: CapFinalizeSettlementRequest,
    response: CapSettlementDto,
  },
  "POST /api/v1/platform/cap/constants": {
    summary:
      "Publish a CMS per-cap-year cap amount — platform-admin (cap_platform_admin ABAC; D3; §4.1)",
    body: CapPublishConstantRequest,
  },
  "PATCH /api/v1/platform/cap/constants/:capYear": {
    summary: "Amend a published cap amount before first tenant use — platform-admin (D3; §4.1)",
    body: CapAmendConstantRequest,
  },

  // ── M27 Cost Report (Form CMS-1984-14; §4.1) ───────────────────────────────────────────────────────────
  "GET /api/v1/cost-reports": {
    summary:
      "List cost reports by (ProviderEntity, fiscal year) + lifecycle state (cost_report.read; §4.1)",
    query: CostReportListQuerySchema,
  },
  "POST /api/v1/cost-reports": {
    summary:
      "Create a cost report for a ProviderEntity + fiscal-year-end (cost_report.create; D1; §4.1)",
    body: CreateCostReportBodySchema,
  },
  "PATCH /api/v1/cost-reports/:id": {
    summary:
      "Edit cost-report metadata — bad-debt-claimed / wage source; version-checked (cost_report.edit; §4.1)",
    body: PatchCostReportBodySchema,
  },
  "PUT /api/v1/cost-reports/:id/worksheets/:code": {
    summary: "Write a worksheet's TypeBox-validated data jsonb (cost_report.edit; §4.2)",
    body: PutWorksheetBodySchema,
  },
  "POST /api/v1/cost-reports/:id/bad-debt": {
    summary:
      "Add a Medicare bad-debt entry — deductible/coinsurance (cost_report.edit_bad_debt; D7; §4.1)",
    body: AddBadDebtBodySchema,
  },
  "POST /api/v1/cost-reports/:id/validations/:vid/overrides": {
    summary:
      "Override a validation result — elevated approval + reason + audit (cost_report.override_validation; §11.B)",
    body: M27OverrideValidationResultBodySchema,
  },
  "POST /api/v1/cost-reports/:id/approve-for-submit": {
    summary:
      "Approve a cost report for submission — step-up (cost_report.approve_for_submit; D14; §4.1)",
    body: ApproveForSubmitBodySchema,
  },
  "POST /api/v1/cost-reports/:id/submit": {
    summary:
      "Submit — step-up + attestation; builds the content-hashed snapshot (cost_report.submit; D10/D14; §4.1)",
    body: SubmitBodySchema,
  },
  "POST /api/v1/cost-reports/:id/reopen": {
    summary:
      "Reopen a submitted cost report — elevated approval + documented reason (cost_report.reopen_submitted; D19; §4.1)",
    body: ReopenBodySchema,
  },
  "POST /api/v1/cost-reports/:id/ecr-submissions/:sid/acknowledgments": {
    summary:
      "Record the MCReF acknowledgment / rejection for a submission (cost_report.record_acknowledgment; §4.1)",
    body: RecordAcknowledgmentBodySchema,
  },
  "POST /api/v1/cost-report-validation-rules": {
    summary:
      "Create a tenant validation rule layered on the platform floor (cost_report.manage_rules; D21; §11.B)",
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
    summary:
      "Discipline-plan worklist — cursor-paginated, filterable by patient/admission/kind/status (§4.1 #1)",
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
    summary:
      "Revoke a satisfied gate — reason required; cascades the volunteer to inactive (§4.1 #22)",
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
    summary:
      "System-principal seam — discipline goals/interventions for a patient's plans (§4.1 #25)",
    query: M15RelevantElementsQuerySchema,
  },
  "GET /internal/discipline-plans/msw-risk-factors": {
    summary:
      "System-principal seam — MSW psychosocial risk factors for an admission (M16; §4.1 #26)",
    query: M15RiskFactorQuerySchema,
  },
  "GET /internal/discipline-plans/volunteer-effective-status": {
    summary:
      "System-principal seam — a volunteer's effective 418.78 status; fail-CLOSED (an unreadable gate store answers not-active; §4.1 #27)",
    query: M15VolunteerStatusQuerySchema,
  },
  "GET /internal/discipline-plans/supervisory-cadence": {
    summary:
      "System-principal seam — the supervisory-cadence worklist for a scope (M17/M14; §4.1 #28)",
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
    summary:
      "The append-only risk-score ledger — per-survivor and plan-level, newest first (§4.1 #29)",
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
    summary:
      "The D11 SKU catalog — the platform rows UNION the tenant overlay, one browsable list (§4.1 #11)",
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

  // ── M31 Patient/Family Portal & Telehealth (§4.1–4.2). The lay-language reads publish a typed 2xx body;
  // the writes reuse the SAME TypeBox schema the handler `parse`s (portal-typebox.ts), so the published
  // contract cannot drift from the validator. Every lay read body is the D17-minimized projection. ──
  "POST /api/v1/portal/sessions/select-patient": {
    summary: "Bind the portal session to (patient, active grant) after login (D2)",
    body: M31SelectPatientRequest,
    response: M31SelectPatientResponse,
  },
  "GET /api/v1/portal/sessions/current": {
    summary: "Current portal session context (account, active patient, scope set)",
    response: M31PortalSessionCurrentResponse,
  },
  "POST /api/v1/portal/sessions/logout": {
    summary: "Server-side portal session close",
    response: M31AckResponse,
  },
  "POST /api/v1/portal/sessions/step-up": {
    summary: "TOTP step-up for high-PHI portal actions",
    body: M31StepUpRequest,
    response: M31AckResponse,
  },
  "GET /api/v1/portal/care-summary": {
    summary: "The portal home view — lay-language aggregate of the upstream reader seams",
    response: M31CareSummaryResponse,
  },
  "GET /api/v1/portal/care-plan/summary": {
    summary: "Lay-language care-plan summary (M7 §5.4)",
    response: M31CarePlanSummaryResponse,
  },
  "GET /api/v1/portal/discipline-plans/summary": {
    summary: "Discipline-plan lay summaries (M15 §5.3)",
    response: M31LayListResponse,
  },
  "GET /api/v1/portal/visits/upcoming": {
    summary: "Upcoming visits (M17 PortalVisitReader), lay DTO",
    query: M31WithinQuery,
    response: M31LayListResponse,
  },
  "GET /api/v1/portal/visits/history": {
    summary: "Visit history (M8 SignedEncountersReader), lay DTO",
    response: M31LayListResponse,
  },
  "GET /api/v1/portal/medications/active": {
    summary: "Active medications (M12 portal summary), SUD-redacted",
    response: M31LayListResponse,
  },
  "GET /api/v1/portal/administrations/recent": {
    summary: "Recent administrations (M13 portal summary), lay DTO",
    response: M31LayListResponse,
  },
  "GET /api/v1/portal/assessments/trend": {
    summary: "Symptom-trend view (M9 ScaleSeriesProvider), lay transform",
    response: M31LayListResponse,
  },
  "GET /api/v1/portal/hope/timepoints": {
    summary: "HOPE patient-facing subset (M10 HopeTimepointProvider)",
    response: M31LayListResponse,
  },
  "GET /api/v1/portal/orders/non-medication": {
    summary: "Non-medication order summary (M11), lay DTO",
    response: M31LayListResponse,
  },
  "GET /api/v1/portal/supplies/upcoming": {
    summary: "Upcoming supply deliveries (M21 portal view)",
    response: M31LayListResponse,
  },
  "GET /api/v1/portal/triage-entries": {
    summary: "Triage call log, lay DTO (M19 portal reader)",
    query: M31WithinQuery,
    response: M31LayListResponse,
  },
  "GET /api/v1/portal/triage-entries/me": {
    summary: "Own-initiated triage entries, lay DTO",
    query: M31WithinQuery,
    response: M31LayListResponse,
  },
  "GET /api/v1/portal/documents": {
    summary: "Disclosed documents list (M22 PortalDocumentReader)",
    response: M31LayListResponse,
  },
  "GET /api/v1/portal/documents/:documentId/download-url": {
    summary: "Mint a 60-min watermarked download URL (M22)",
    response: M31DocumentDownloadUrlResponse,
  },
  "POST /api/v1/portal/documents/upload-init": {
    summary: "Stage an M22 intake upload; returns a signed URL",
    body: M31PortalDocumentUploadInitRequest,
    response: M31PortalDocumentUploadInitResponse,
  },
  "POST /api/v1/portal/documents/upload-complete/:uploadId": {
    summary: "Confirm the M22 intake batch received",
    response: M31UploadCompleteResponse,
  },
  "POST /api/v1/portal/administrations/caregiver-attested": {
    summary: "Caregiver-attested administration into M13 (D10); TOTP step-up",
    body: M31CaregiverAttestRequest,
    response: M31CaregiverAttestResponse,
  },
  "POST /api/v1/portal/amendments/submit": {
    summary: "Submit a §164.526 amendment request to M5; TOTP step-up",
    body: M31AmendmentSubmitRequest,
    response: M31AmendmentSubmitResponse,
  },
  "GET /api/v1/portal/amendments": {
    summary: "Own amendment requests (portal-submitted)",
    response: M31LayListResponse,
  },
  "GET /api/v1/portal/messages/channel": {
    summary: "The care-team channel id + last-read pointer (M36)",
    response: M31MessagesChannelResponse,
  },
  "POST /api/v1/portal/messages/send": {
    summary: "Send to the care team (thin pass-through to M36)",
    body: M31MessageSendRequest,
    response: M31MessageSendResponse,
  },
  "GET /api/v1/portal/bereavement/program": {
    summary: "Bereavement program overview (M16 publicView), window-gated",
    response: M31LayListResponse,
  },
  "GET /api/v1/portal/bereavement/resources": {
    summary: "External grief resources (M40) + tenant catalog (M22)",
    response: M31LayListResponse,
  },
  "POST /api/v1/portal/bereavement/opt-out": {
    summary: "Self opt-out of the bereavement program (M16)",
    response: M31AckResponse,
  },
  "GET /api/v1/portal/notification-preferences": {
    summary: "Per-channel + quiet-hours notification preferences",
    response: M31NotificationPreferencesResponse,
  },
  "PATCH /api/v1/portal/notification-preferences/:id": {
    summary: "Update a notification preference (optimistic concurrency)",
    body: M31NotificationPreferenceUpdateRequest,
    response: M31AckResponse,
  },
  "POST /api/v1/portal/telehealth/visits/:visitId/join": {
    summary: "Portal-side telehealth join — mints a participant token (consent + ABAC gated)",
    response: M31TelehealthJoinResponse,
  },
  "POST /api/v1/portal/telehealth/visits/:visitId/leave": {
    summary: "Portal-side telehealth leave (idempotent)",
    response: M31AckResponse,
  },
  "POST /api/v1/telehealth/visits/:visitId/join": {
    summary: "Clinician-side telehealth join — mints a participant token",
    response: M31TelehealthJoinResponse,
  },
  "POST /api/v1/telehealth/visits/:visitId/leave": {
    summary: "Clinician-side telehealth leave",
    response: M31AckResponse,
  },
  "POST /api/v1/telehealth/visits/:visitId/start-recording": {
    summary: "Start recording — D9 state-aware gate + step-up",
    body: M31StartRecordingRequest,
    response: M31AckResponse,
  },
  "POST /api/v1/telehealth/visits/:visitId/stop-recording": {
    summary: "Stop recording (idempotent)",
    response: M31AckResponse,
  },
  "POST /api/v1/telehealth/visits/:visitId/end": {
    summary: "Server-forced end of the telehealth visit",
    response: M31AckResponse,
  },
  "POST /api/v1/telehealth/webhooks/daily-co": {
    summary: "Signature-verified Daily.co webhook ingest (D13)",
    response: M31WebhookAckResponse,
  },
  "POST /api/v1/telehealth/webhooks/twilio-video": {
    summary: "Signature-verified Twilio Video webhook ingest (vendor-pluggable)",
    response: M31WebhookAckResponse,
  },
  "POST /api/v1/admin/portal-invitations": {
    summary: "Issue a magic-link portal invite (D4)",
    body: M31PortalInvitationIssueRequest,
    response: M31PortalInvitationIssueResponse,
  },
  "GET /api/v1/admin/portal-invitations": {
    summary: "Per-patient portal invite list",
    response: M31PortalInvitationListResponse,
  },
  "POST /api/v1/admin/portal-invitations/:id/revoke": {
    summary: "Revoke a portal invite before acceptance",
    response: M31AckResponse,
  },
  "POST /api/v1/admin/portal-accounts/:id/invite-bereaved": {
    summary: "Issue a post-death bereaved invite (M16-coordinated)",
    body: M31InviteBereavedRequest,
    response: M31AckResponse,
  },
  "POST /api/v1/admin/portal-accounts/:id/suspend": {
    summary: "Org-admin temporary disable of a portal account; step-up",
    body: M31AccountSuspendRequest,
    response: M31AckResponse,
  },
  "POST /api/v1/admin/portal-accounts/:id/reinstate": {
    summary: "Reverse a portal-account suspension; step-up",
    body: M31AccountSuspendRequest,
    response: M31AckResponse,
  },
  "GET /api/v1/admin/portal-accounts": {
    summary: "Per-tenant portal account roster",
    response: M31PortalAccountListResponse,
  },
  "GET /api/v1/admin/portal-accounts/:id/access-grants": {
    summary: "Per-account grant list",
    response: M31PortalAccountGrantListResponse,
  },
  "GET /api/v1/admin/portal-accounts/:id/audit-views": {
    summary: "Per-account §164.528 disclosure-accounting view",
    response: M31PortalAuditViewResponse,
  },
  "GET /api/v1/admin/telehealth/visits": {
    summary: "Per-tenant telehealth visit roster",
    response: M31TelehealthVisitListResponse,
  },
  "GET /api/v1/admin/telehealth/visits/:id": {
    summary: "Per-visit telehealth detail",
    response: M31TelehealthVisitDetailResponse,
  },
  "POST /api/v1/admin/telehealth/visits/:id/halt-recording": {
    summary: "Compliance-officer emergency recording stop; step-up",
    response: M31AckResponse,
  },
  "GET /api/v1/auditor/portal-engagement/:engagementId": {
    summary: "Engagement-scoped auditor view of portal engagement",
    response: M31PortalEngagementResponse,
  },
};

// ---------------------------------------------------------------------------
// M20 Field Safety — §4.2 request contracts for the §4.1 surface (M20-T06).
// Each summary states what the boundary REFUSES, not just what it accepts: the
// generated client is the only place a web caller sees why a shape is illegal.
// ---------------------------------------------------------------------------
Object.assign(ROUTE_ENRICHMENTS, {
  // --- §7.1 check-ins (§4.1 #1-#4) ---
  "POST /api/v1/safety/check-ins": {
    summary:
      "Record a check-in against an obligation — the attribution column is stamped from the SESSION (routes/actor.ts), so a caller cannot post an attestation as somebody else whatever they send (§4.1 #1)",
    body: M20RecordCheckInBody,
  },
  "PATCH /api/v1/safety/check-ins/:checkInId": {
    summary:
      "Amend within the 5-minute grace — a correction is a NEW row that supersedes (§2.2.1); the original stays readable because it is what the supervisor may already have acted on (§4.1 #3)",
    body: M20AmendCheckInBody,
  },
  "GET /api/v1/safety/check-ins/me/today": {
    summary:
      "The clinician's own day — what she owes and what she has posted. Scoped to the SESSION's membership inside the read service, so `/me/today` cannot be pointed at a colleague (§4.1 #4)",
    query: M20CheckInListQuery,
  },
  // --- §2.2.2 SOS (§4.1 #5-#11) ---
  "POST /api/v1/safety/sos": {
    summary:
      "The press — deliberately NO idempotency key: a duplicate alert is recoverable, a swallowed one is not. `field_eligible_for_sos` gates who may PRESS; nothing downstream of the row gates the fan-out (M20-F05 / S13, §4.1 #5)",
    body: M20RaiseSosBody,
  },
  "POST /api/v1/safety/sos/:sosAlertId/cancel": {
    summary:
      "The D5 mid-visit cancel (biometric). A REJECTED cancel is a 200 carrying `cancel_attempted_but_rejected`, never a 4xx — an error would tell a hostile actor holding the device that their tap did something (§4.1 #6)",
    body: M20CancelSosBody,
  },
  "POST /api/v1/safety/sos/:sosAlertId/acknowledge": {
    summary:
      "A responder answers — the §2.2.6 acknowledgment row is written in the SAME transaction, so an `acknowledged` alert nobody signed is unrepresentable (§4.1 #7)",
    body: M20AcknowledgeSosBody,
  },
  "POST /api/v1/safety/sos/:sosAlertId/resolve": {
    summary:
      "Resolve, or convert into an incident — `openIncidentFromOutcome` dispatches to a DIFFERENT §2.2.2 command (`openIncident`, not `resolve`) because they are different terminal states (§4.1 #8)",
    body: M20ResolveSosBody,
  },
  "GET /api/v1/safety/sos/:sosAlertId/location-stream": {
    summary:
      "The D6 coordinate stream — readable only while the consent that produced it stands; `continuous_location_during_sos` additionally requires the TENANT flag before a single row may exist (§4.1 #10)",
    query: M20LocationStreamQuery,
  },
  // --- §2.2.3 incidents (§4.1 #12-#17) ---
  "POST /api/v1/safety/incidents": {
    summary:
      "Open a draft — `affectedClinicianMembershipId` is the ONE membership a caller may name (the §2.2.3 supervisor-opens-on-behalf-of path), and `incident_subject_or_supervisor` is what keeps naming somebody else a supervisor-only act (§4.1 #12)",
    body: M20CreateIncidentBody,
  },
  "GET /api/v1/safety/incidents": {
    summary:
      "The review queue — narrowed to the caller's own incidents inside the read service when they hold no oversight role: the guard admits them to the route, the service decides which rows (§4.1 #13)",
    query: M20IncidentListQuery,
  },
  "PATCH /api/v1/safety/incidents/:incidentId": {
    summary:
      "Edit a draft — the `(draft)` qualifier is enforced by the service, not the shape (§4.1 #14)",
    body: M20PatchIncidentBody,
  },
  "POST /api/v1/safety/incidents/:incidentId/submit": {
    summary:
      "Submit for review — D9's gate: `oshaReportable: true` without the signed-off pair is a 422 that NAMES the fix, not a constraint violation surfacing on a clinician's Submit button (§4.1 #15)",
    body: M20SubmitIncidentBody,
  },
  "POST /api/v1/safety/incidents/:incidentId/state": {
    summary:
      "The supervisor state machine (§2.2.3) — `reopened` re-enters review on the SAME row, because a second row would break the workers-comp timeline an insurer reads (§4.1 #16)",
    body: M20TransitionIncidentBody,
  },
  "POST /api/v1/safety/incidents/:incidentId/osha-signoff": {
    summary: "§7.6 / D9's OSHA-equivalent sign-off — step-up asserted at the route (§4.1 #17)",
    body: M20OshaSignoffBody,
  },
  // --- §2.2.4 policy + §2.2.5/D8 subscriptions + §7.6 areas (§4.1 #18-#25) ---
  "GET /api/v1/safety/policy": {
    summary:
      "The effective policy — §2.2.4's `asOf` is the REPLAY arm: a 2031 review of a 2026 incident has to read the 2026 thresholds, and reading today's would turn a policy that tightened into a regression that never happened (§4.1 #18)",
    query: M20PolicyQuery,
  },
  "PATCH /api/v1/safety/policy": {
    summary: "Edit the policy — step-up asserted at the route (§4.1 #19)",
    body: M20PatchPolicyBody,
  },
  "GET /api/v1/safety/supervisor-subscriptions": {
    summary:
      "Who watches whom (§2.2.5 / D8) — dashboard VISIBILITY is RBAC+ABAC and deliberately independent: a supervisor may SEE a board she is not paged for, and D8 exists because the inverse (visible to everyone, paged by nobody) is the §7.8 failure (§4.1 #20)",
    query: M20SubscriptionListQuery,
  },
  "POST /api/v1/safety/supervisor-subscriptions": {
    summary:
      "Add one — the scope-selector pairing (§3.3's `m20_sss_scope_integrity`) and the vacation-forward pairing are re-checked in the service so the DON is told WHICH selector is missing rather than shown a constraint name (§4.1 #21)",
    body: M20CreateSubscriptionBody,
  },
  "GET /api/v1/safety/high-risk-areas": {
    summary:
      "The advisory polygons in force — `includeExpired` defaults FALSE so the pre-visit advisory never surfaces a polygon retired last winter; the editor asks for history explicitly (§4.1 #23)",
    query: M20HighRiskAreaListQuery,
  },
  "POST /api/v1/safety/high-risk-areas": {
    summary:
      "Draw one (§7.6) — M20-F07: no PostGIS, so ring closure and the ≥4-point minimum are validated in app code the moment the Compliance Officer draws it, not on the night a clinician is standing in it (§4.1 #24)",
    body: M20CreateHighRiskAreaBody,
  },
  "PATCH /api/v1/safety/high-risk-areas/:areaId": {
    summary:
      "Edit or retire one — retiring is `effectiveTo`, never a delete: an incident review has to be able to ask what advisory was in force on the day (§4.1 #25)",
    body: M20PatchHighRiskAreaBody,
  },
  // --- §7.8 dashboard + M20-F16 consent (§4.1 #26-#29) ---
  "GET /api/v1/safety/dashboard": {
    summary:
      "The live-awareness board — open obligations, active alerts, and the coverage gaps behind them (§4.1 #26)",
    query: M20DashboardQuery,
  },
  "GET /api/v1/safety/consent": {
    summary: "My own consents — the three §M20-F16 purposes and their current state (§4.1 #27)",
    query: M20ConsentQuery,
  },
  "POST /api/v1/safety/consent/grant": {
    summary:
      "Grant one purpose — the three are separately grantable (M20-F16): declining `sos_coordinates` never disables SOS, and `continuous_location_during_sos` additionally needs the TENANT's `sosContinuousLocationEnabled` before a stream row may exist (§4.1 #28)",
    body: M20GrantConsentBody,
  },
  "POST /api/v1/safety/consent/revoke": {
    summary:
      "Revoke one purpose — writes `revoked`, never `expired`: the rotation sweep owns the second, and a coercion review reads exactly that difference (§2.2.8, §4.1 #29)",
    body: M20RevokeConsentBody,
  },
});

// ---------------------------------------------------------------------------
// M32 AI Platform — §4.1 request contracts for the thirty-two-route surface
// (M32-T07). Every summary states what the boundary REFUSES, not just what it
// accepts: the generated client is the only place a web caller sees why a shape
// is illegal — and in this module the refusals ARE the governance model (the
// four `automated_*` kill-switch actor kinds are unspellable; no body carries a
// prompt, a response or a chart context; no body names an organization).
// ---------------------------------------------------------------------------
Object.assign(ROUTE_ENRICHMENTS, {
  // --- §2.2 capability registry + lifecycle (R1-R6) ---
  "POST /api/v1/ai/capabilities": {
    summary:
      "Register a capability into PROPOSED (R1). The SIGNER role rides the body and is checked against §2.2's own registration edge; the ACTING MEMBERSHIP is stamped from the session, so a caller may say which role they sign as and may not say that somebody else signed",
    body: M32RegisterCapabilityBody,
  },
  "GET /api/v1/ai/capabilities": {
    summary:
      "List the platform-shared capability registry (R2). §6 grants the read to every clinical role — a clinician offered an AI-enhanced note may look up what the capability is and which lifecycle state it is in. `hotPhase1` is an INVENTORY fact, not a column, and the response reports the filter as unapplied rather than silently ignoring it",
    query: M32CapabilityListQuery,
  },
  "GET /api/v1/ai/capabilities/:capabilityId": {
    summary:
      "Capability detail (R3): the row, the §2.2 posture it publishes to consumers, its lifecycle ledger, its calibration trail and the states it can reach next — one read, because four would show a capability mid-transition as four inconsistent panels",
  },
  "POST /api/v1/ai/capabilities/:capabilityId/transitions": {
    summary:
      "Walk a §2.2 lifecycle edge (R4). STEP-UP: the stage-4 → stage-5 edge is what makes a capability servable against real charts. The FSM, the signer-role check and D10's evaluation-evidence check all re-run inside the service — the guard is the cheap early refusal, not the authority",
    body: M32TransitionCapabilityBody,
  },
  "POST /api/v1/ai/capabilities/:capabilityId/calibration": {
    summary:
      "Publish a calibration (R5): supersede the incumbent and insert the new `is_current` row in ONE store call — `ai_cap_calib_current_per_backend_idx` makes any other ordering a constraint violation rather than a race",
    body: M32PublishCalibrationBody,
  },
  "GET /api/v1/ai/capabilities/:capabilityId/calibration/history": {
    summary:
      "Calibration trail (R6). Behind `ai_safety_owner` rather than the open capability read: a calibration row states the decision boundary a model is held to, which is the one piece of the registry an adversary could use to shape an input that lands just inside it (§8.1 tampering)",
  },
  // --- D8 kill switch (R7-R9) ---
  "POST /api/v1/ai/capabilities/:capabilityId/kill-switch": {
    summary:
      "Activate the kill switch (R7). `scope: 'platform'` writes the `organization_id IS NULL` row that stops EVERY agency and requires the safety-owner arm specifically; `scope: 'tenant'` resolves to the SESSION's org and never to a supplied id. The four `automated_*` actor kinds are UNSPELLABLE here, so a human cannot file a stop as though a monitor had raised it",
    body: M32ActivateKillSwitchBody,
  },
  "DELETE /api/v1/ai/capabilities/:capabilityId/kill-switch": {
    summary:
      "Lift the kill switch (R8). `resolutionNarrative` is REQUIRED (§3.2.12) and the activation half of the row is left ALONE — who stopped it and why is exactly what a post-mortem reads. Step-up is on this direction too: resuming a capability somebody paused during a SEV-1 is what a stolen session would want",
    body: M32DeactivateKillSwitchBody,
  },
  "GET /api/v1/ai/kill-switches": {
    summary:
      "The §5.1.3 dashboard (R9) — the DISJUNCTION of this org's rows and the platform rows, which is the same disjunction the gate applies. A view of only the tenant's own rows would tell an agency a capability was running while a platform switch had it stopped",
  },
  // --- §5.3 tenant opt-in / §5.4 clinician opt-out (R10-R15) ---
  "POST /api/v1/ai/tenant-opt-in": {
    summary:
      "Record the tenant opt-in (R10 / W4). The four §5.3.1 acknowledgments arrive as EVIDENCE — the reference strings and the attestation text AS SHOWN, not booleans — and W4.1's resolver decides whether they resolve. With the Phase-1 denying resolver every cloud-reachable opt-in is REFUSED, naming the specific gate",
    body: M32RecordTenantOptInBody,
  },
  "DELETE /api/v1/ai/tenant-opt-in/:capabilityId": {
    summary:
      "Revoke (default) or pause (`mode: 'pause'`) the tenant opt-in (R11 / §10.6). An unqualified DELETE WITHDRAWS: a route that silently paused would leave an agency believing it had stopped while the acknowledgment evidence — and M35's metering — said otherwise. A reason is ACCEPTED, never required",
    body: M32RevokeTenantOptInBody,
  },
  "GET /api/v1/ai/tenant-opt-in": {
    summary:
      "The org's opt-in records (R12). Granted to `tenant_admin` and `compliance_officer`: the frozen acknowledgment evidence is what a privacy review reads to answer who agreed to what, and when",
  },
  "POST /api/v1/ai/clinician-opt-out": {
    summary:
      "The clinician turns a capability off for herself (R13 / §5.4). Takes NO membership id — the acting membership is stamped from the session, so this cannot be pointed at a colleague. Idempotent by rule: a second tap returns the live row and writes nothing",
    body: M32RecordClinicianOptOutBody,
  },
  "DELETE /api/v1/ai/clinician-opt-out/:capabilityId": {
    summary:
      "The clinician re-enables the capability for herself (R14). The ROW IS KEPT and stamped `reverted_at` — §5.4's history is the record that she once declined, which is what makes a later coercion question answerable. A delete would erase the only evidence of it",
  },
  "GET /api/v1/ai/clinician-opt-out": {
    summary:
      "Her own opt-out history, reverted rows included — that IS the history (R15). Scoped to the SESSION's membership inside the service",
  },
  // --- §164.528 disclosure ledger (R16-R17) ---
  "GET /api/v1/ai/invocations": {
    summary:
      "The compliance search over `ai_invocation` (R16) — the §164.528 disclosure ledger. PHI masking is STRUCTURAL: the projection has no field for the prompt, the response or the chart context at all, and `wardenx.phi.full_read` unlocks only the patient identity and the free-text error. Without it a row still reports `touchedPatientChart`, which is the fact the accounting turns on. Default window: 90 days (the table is RANGE-partitioned on `invoked_at`)",
    query: M32InvocationSearchQuery,
  },
  "GET /api/v1/ai/invocations/:invocationId": {
    summary:
      "One invocation (R17). 404-on-deny, not 403: an invocation id is 1:1 with 'this named patient's chart went to a model vendor at this hour', which §8.2's isolation test asks to be unprobeable",
  },
  // --- D9 hallucination report → triage (R18-R20) ---
  "POST /api/v1/ai/hallucination-reports": {
    summary:
      "File a hallucination report (R18) — the only write a clinician makes in this module, and §5.5's widget's contract. The narrative is DEK-enveloped before it is stored; with no cipher bound the route refuses 503 rather than writing prose in the clear into a column named `_cipher`. A `critical` severity returns D16's SEV-1 follow-up PLAN attached, so the caller can see that filing this is about to stop a capability platform-wide",
    body: M32FileHallucinationReportBody,
  },
  "GET /api/v1/ai/hallucination-reports": {
    summary:
      "The triage queue (R19). Defaults to the two OPEN statuses §3.2.10's partial index covers — that IS the working set; a queue that opened on every closed report ever filed would need a filter before it was usable",
    query: M32HallucinationQueueQuery,
  },
  "POST /api/v1/ai/hallucination-reports/:reportId/triage": {
    summary:
      "Record the triage decision (R20 / W5.5-5.6). The computed FOLLOW-UP rides the response for the §4.8 queue; `followUpAction: 'none'` is a RECORDED decision, so 'we decided nothing was needed' stays distinguishable from 'the worker never ran'",
    body: M32TriageHallucinationReportBody,
  },
  // --- W2 token spend (R21-R22) ---
  "GET /api/v1/ai/tokens/ledger": {
    summary:
      "The token ledger plus the window total (R21). The window is the CALENDAR MONTH, because that is what §3.8 partitions `ai_token_ledger` by and what §1.1's budget is stated in — a rolling 30 days would straddle two partitions and answer a different question from the one the cap enforces",
    query: M32TokenLedgerQuery,
  },
  "GET /api/v1/ai/tokens/forecast": {
    summary:
      "Spend vs. caps with a linear burn-rate projection (R22). Nothing here predicts. `softCap`, `hardCap` and `projectedBreach` are ALL `null` when M2 states no budget — an absent bound is not an unbounded one, and a green 'no breach projected' tile minted from a missing configuration is the failure this avoids",
    query: M32TokenForecastQuery,
  },
  // --- W8 routing sovereignty (R23-R25) ---
  "POST /api/v1/ai/routing-overrides": {
    summary:
      "Pin a capability's routing (R23 / W8 `local_only`). `effectiveAt` defaults to NOW and not to the start of the day: a sovereignty decision takes effect when the admin makes it, and back-dating one would claim a period during which calls had already gone to a cloud backend",
    body: M32SetRoutingOverrideBody,
  },
  "DELETE /api/v1/ai/routing-overrides/:capabilityId": {
    summary:
      "Remove an override by CLOSING its §3.2.13 window (R24) — never by deleting the row. A delete would erase the record that the agency once required `local_only`, which is exactly the evidence a data-residency question asks for, and would free a window the EXCLUDE constraint had already reserved. 404 when no override is live, rather than a silent success that would read as 'removed'",
  },
  "GET /api/v1/ai/routing-overrides": {
    summary:
      "List routing overrides including EXPIRED rows (R25) — the question a data-residency review asks is 'what was in force in March', not 'what is in force now'",
  },
  // --- D10 evaluation runs (R26-R28) ---
  "POST /api/v1/ai/evaluations": {
    summary:
      "Queue an evaluation run (R26). `status` is NOT an input — §3.2.11 inserts every run `pending`; a body that could set `passed` would let an operator mint the D10 evidence a stage-3 transition then cites, which is the one thing the evidence check exists to prevent",
    body: M32QueueEvaluationRunBody,
  },
  "GET /api/v1/ai/evaluations": {
    summary: "Recent evaluation runs, filterable by capability and status (R27)",
    query: M32EvaluationRunQuery,
  },
  "GET /api/v1/ai/evaluations/:runId": {
    summary:
      "One evaluation run with its metric snapshot and MLflow handle (R28). MLflow stays the record of the run; `summary_metrics` is the headline §3.2.11 keeps so a governance review need not reach into a second system to see why an edge was approved",
  },
  // --- §4.5 / §8.5 prompt registry (R29-R30) ---
  "GET /api/v1/ai/prompts/:capabilityKey/active": {
    summary:
      "The active template's METADATA (R29) — never its body. §8.5: the body is the platform's prompt-injection surface, PR-gated in `packages/prompts` with a clinical-reviewer attestation, and an HTTP route serving it would be a second distribution channel with none of that review attached. 404 when the capability genuinely has no active template",
  },
  "POST /api/v1/ai/prompts/:capabilityKey/activate": {
    summary:
      "Activate a template version (R30). INSERT-AND-DEPRECATE, not a status flip: §3.5's immutability trigger rejects an UPDATE flipping an existing row to `active`. The ARTIFACT is read and hashed inside the service — the submitted `templateContentHash` is a claim to VERIFY, not a value to store. STEP-UP: the active template is what every consumer's D18 boot validator reads",
    body: M32ActivatePromptTemplateBody,
  },
  // --- D11 drift + backend health (R31-R32) ---
  "GET /api/v1/ai/drift/recent": {
    summary:
      "Drift findings within the last N hours (R31). M32 owns NO drift table: §4.8's sweep publishes `m32.drift.detected` and writes a `drift_response` EVALUATION RUN, which is the durable record — so the response names its `source`, and an empty list cannot be mistaken for 'no drift' when it may mean 'no sweep has run'",
    query: M32DriftQuery,
  },
  "GET /api/v1/ai/health": {
    summary:
      "Liveness plus per-backend health (R32). Reports `ok` in capability-shell mode: with `ai.full` OFF, 'no healthy backend' is the EXPECTED state, and reporting `degraded` for the platform's intended posture is the fastest way to teach an operator to ignore the endpoint. `lastHealthStatus: 'unknown'` is a real state — a backend nobody has probed is not healthy",
  },
});

// ── M6 Admission, Election & Certification (§4.2). All 46 routes published NO request/response contract
// (client typed every body/query/response as `never`), so the module's 40-route enrichment deficit was the
// single largest in the corpus. Each entry reuses the SAME TypeBox schema the handler `parse`s (bodies +
// list queries) or a response DTO pinned to the service read view by a compile-time `Conforms` alias.
Object.assign(ROUTE_ENRICHMENTS, {
  // Referral (routes 1–7)
  "POST /api/v1/referrals": { summary: "Receive a referral (§5.1)", body: ReferralCreateSchema },
  "GET /api/v1/referrals": {
    summary: "Referral worklist (cursor-paginated)",
    query: ReferralListQuerySchema,
    response: M6SummaryPageResponseSchema,
  },
  "GET /api/v1/referrals/:id": {
    summary: "One referral's summary + state",
    response: M6SummaryRowResponseSchema,
  },
  "PATCH /api/v1/referrals/:id": { summary: "Update a referral", body: ReferralUpdateSchema },
  "POST /api/v1/referrals/:id/triage": {
    summary: "Record a triage outcome (eligible/ineligible)",
    body: ReferralTriageSchema,
  },
  "POST /api/v1/referrals/:id/accept": {
    summary: "Accept a referral → seed the admission",
    body: ReferralAcceptSchema,
    response: ReferralAcceptResponseSchema,
  },
  "POST /api/v1/referrals/:id/decline": {
    summary: "Decline a referral",
    body: ReferralDeclineSchema,
  },
  // Admission (routes 8–14)
  "POST /api/v1/admissions": {
    summary: "Create an admission (§5.2)",
    body: AdmissionCreateSchema,
    response: M6SummaryRowResponseSchema,
  },
  "GET /api/v1/admissions": {
    summary: "Admission census (cursor-paginated, filterable by state)",
    query: AdmissionListQuerySchema,
    response: M6SummaryPageResponseSchema,
  },
  "GET /api/v1/admissions/:id": {
    summary: "The admission aggregate + R-AC-01 activation gate (§5.2.5)",
    response: AdmissionDetailResponseSchema,
  },
  "PATCH /api/v1/admissions/:id": { summary: "Update an admission", body: AdmissionUpdateSchema },
  "POST /api/v1/admissions/:id/hold": {
    summary: "Place the admission on hold",
    body: AdmissionHoldSchema,
  },
  "POST /api/v1/admissions/:id/resume": {
    summary: "Resume a held admission",
    body: AdmissionResumeSchema,
  },
  "POST /api/v1/admissions/:id/activate": {
    summary: "Activate the admission (only when the R-AC-01 gate is satisfied)",
    body: AdmissionActivateSchema,
  },
  // Election statement & period (routes 15–21)
  "POST /api/v1/admissions/:id/election-statements": {
    summary: "Draft the beneficiary's election statement",
    body: ElectionStatementDraftSchema,
  },
  "GET /api/v1/election-statements/:id": {
    summary: "One election statement's summary + state",
    response: M6SummaryRowResponseSchema,
  },
  "POST /api/v1/election-statements/:id/sign": {
    summary: "Sign the election statement",
    body: ElectionSignSchema,
  },
  "POST /api/v1/election-statements/:id/void": {
    summary: "Void an election statement",
    body: ElectionVoidSchema,
  },
  "GET /api/v1/admissions/:id/election-periods": {
    summary: "The admission's benefit-period ladder",
    response: M6SummaryItemsResponseSchema,
  },
  "GET /api/v1/patients/:patientId/election-certification": {
    summary:
      "The patient's Election & Certification aggregate (admission + period ladder + windows)",
    response: PatientElectionCertificationResponseSchema,
  },
  "POST /api/v1/admissions/:id/election-periods": {
    summary: "Open the next benefit period",
    body: ElectionPeriodCreateSchema,
  },
  "PATCH /api/v1/election-periods/:id": {
    summary: "Patch a pending election period",
    body: ElectionPeriodPatchSchema,
  },
  // CTI (routes 22–27)
  "POST /api/v1/election-periods/:id/cti": {
    summary: "Draft the certification of terminal illness for the period",
    body: CtiDraftSchema,
  },
  "GET /api/v1/cti/:id": {
    summary: "One CTI's summary + state",
    response: M6SummaryRowResponseSchema,
  },
  "POST /api/v1/cti/:id/sign-hospice-md": {
    summary: "Hospice medical director signs the CTI",
    body: CtiSignSchema,
  },
  "POST /api/v1/cti/:id/sign-attending": {
    summary: "Attending physician signs the CTI (period 1)",
    body: CtiSignSchema,
  },
  "POST /api/v1/cti/:id/void": { summary: "Void a CTI", body: CtiVoidSchema },
  "POST /api/v1/cti/:id/mark-late": {
    summary: "Mark a CTI signed late (written-cert deadline)",
    body: CtiMarkLateSchema,
  },
  // F2F (routes 28–32)
  "POST /api/v1/admissions/:id/face-to-face": {
    summary: "Schedule the face-to-face recertification encounter",
    body: F2fScheduleSchema,
  },
  "GET /api/v1/face-to-face/:id": {
    summary: "One F2F encounter's summary + state",
    response: M6SummaryRowResponseSchema,
  },
  "POST /api/v1/face-to-face/:id/complete": {
    summary: "Mark the F2F encounter completed",
    body: F2fCompleteSchema,
  },
  "POST /api/v1/face-to-face/:id/attest": {
    summary: "Physician attests the F2F encounter (§6.2 ABAC)",
    body: F2fAttestSchema,
  },
  "POST /api/v1/face-to-face/:id/override-window": {
    summary: "Override the F2F timing window (privileged)",
    body: F2fOverrideWindowSchema,
  },
  // Level of care (routes 33–35)
  "POST /api/v1/admissions/:id/level-of-care": {
    summary: "Record a level-of-care change (§5.6)",
    body: LocChangeSchema,
  },
  "GET /api/v1/admissions/:id/level-of-care": {
    summary: "The admission's level-of-care history",
    response: M6SummaryItemsResponseSchema,
  },
  "PATCH /api/v1/level-of-care/:id": {
    summary: "Correct a level-of-care period",
    body: LocPatchSchema,
  },
  "POST /api/v1/level-of-care/:id/confirm-bed": {
    summary:
      "The §2.3.5 confirm handshake — verifies a real M37 bed assignment, then assigning → active",
    body: LocConfirmBedSchema,
  },
  // Revocation / transfer / discharge (routes 36–40)
  "POST /api/v1/admissions/:id/revocation": {
    summary: "Record a benefit revocation",
    body: RevocationCreateSchema,
  },
  "POST /api/v1/admissions/:id/transfer-out": {
    summary: "Transfer the beneficiary out to another hospice",
    body: TransferOutSchema,
  },
  "POST /api/v1/admissions/:id/transfer-in": {
    summary: "Transfer a beneficiary in (inherits the prior benefit period)",
    body: TransferInSchema,
  },
  "POST /api/v1/admissions/:id/discharge": {
    summary: "Discharge the admission (§6.3: permission key derived from reason)",
    body: DischargeCreateSchema,
  },
  "POST /api/v1/discharges/:id/cosign-for-cause": {
    summary: "Medical-director cosign for a for-cause discharge (§6.3 ABAC)",
    body: DischargeCosignSchema,
  },
  // NOR (routes 41–42)
  "POST /api/v1/admissions/:id/nor": {
    summary: "Acknowledge the notice of rights",
    body: NorAcknowledgeSchema,
  },
  "GET /api/v1/admissions/:id/nor": {
    summary: "The admission's notice-of-rights acknowledgment",
    response: M6SummaryRowResponseSchema,
  },
  // Compliance windows (routes 43–46)
  "GET /api/v1/admissions/:id/compliance-windows": {
    summary: "Open compliance windows for the admission",
    response: M6SummaryItemsResponseSchema,
  },
  "GET /api/v1/compliance-windows": {
    summary: "Org-wide compliance-window worklist (cursor-paginated)",
    query: M6ComplianceListQuerySchema,
    response: M6SummaryPageResponseSchema,
  },
  "POST /api/v1/compliance-windows/:id/close": {
    summary: "Close a compliance window",
    body: M6ComplianceCloseSchema,
  },
  "POST /api/v1/compliance-windows/:id/override": {
    summary: "Override a compliance window (privileged, §6.4 ABAC)",
    body: M6ComplianceOverrideSchema,
  },
});

// ── M07 Care Plan (IPOC) — §4.1 (19 routes) ──────────────────────────────────────────────────────
Object.assign(ROUTE_ENRICHMENTS, {
  "GET /api/v1/patients/:patientId/care-plan": {
    summary: "The patient's care plan aggregate (SUD-filtered per §7.6)",
    response: M7CarePlanForPatientResponseSchema,
  },
  "POST /api/v1/patients/:patientId/care-plan": {
    summary: "Bootstrap the care plan + its initial draft version",
    body: M7BootstrapCarePlanSchema,
  },
  "GET /api/v1/care-plans/:planId/versions": {
    summary: "The plan's version ladder",
    response: M7CarePlanVersionPageResponseSchema,
  },
  "GET /api/v1/care-plans/:planId/versions/:versionId": {
    summary: "One care-plan version's detail + signature state",
    response: M7CarePlanVersionResponseSchema,
  },
  "POST /api/v1/care-plans/:planId/versions": {
    summary: "Open a new care-plan version",
    body: M7CreateVersionSchema,
  },
  "POST /api/v1/care-plans/:planId/versions/:versionId/finalize": {
    summary: "Finalize a version to in-review (locks the Required Signer Set)",
    body: M7FinalizeVersionSchema,
  },
  "POST /api/v1/care-plans/:planId/versions/:versionId/signatures": {
    summary: "Record a signature toward the version's §11 D5 quorum",
    body: M7SignVersionSchema,
  },
  "POST /api/v1/care-plans/:planId/versions/:versionId/return-to-draft": {
    summary: "Return an in-review version to draft (clears signatures, D8)",
    body: M7ReturnToDraftSchema,
  },
  "POST /api/v1/care-plans/:planId/problems": {
    summary: "Add a problem to the plan",
    body: M7CreateProblemSchema,
  },
  "PATCH /api/v1/care-plans/:planId/problems/:elementId": {
    summary: "Patch a problem (optimistic If-Match)",
    body: M7PatchProblemSchema,
    headers: IDEMPOTENCY_AND_IF_MATCH_HEADERS,
  },
  "POST /api/v1/care-plans/:planId/problems/:elementId/resolve": {
    summary: "Resolve a problem with a resolution note",
    body: M7ResolveProblemSchema,
  },
  "POST /api/v1/care-plans/:planId/goals": {
    summary: "Add a goal (agent-stated requires active DPOA consent)",
    body: M7CreateGoalSchema,
  },
  "PATCH /api/v1/care-plans/:planId/goals/:elementId": {
    summary: "Patch a goal (verbatim original_text immutable, D6)",
    body: M7PatchGoalSchema,
    headers: IDEMPOTENCY_AND_IF_MATCH_HEADERS,
  },
  "POST /api/v1/care-plans/:planId/interventions": {
    summary: "Add an intervention (§7.4 discipline_scope enforced)",
    body: M7CreateInterventionSchema,
  },
  "PATCH /api/v1/care-plans/:planId/interventions/:elementId": {
    summary: "Patch an intervention (optimistic If-Match)",
    body: M7PatchInterventionSchema,
    headers: IDEMPOTENCY_AND_IF_MATCH_HEADERS,
  },
  "POST /api/v1/care-plans/:planId/interventions/:elementId/discontinue": {
    summary: "Discontinue an intervention",
    body: M7DiscontinueInterventionSchema,
  },
  "GET /api/v1/care-plans/:planId/summary": {
    summary: "The plan's lay-language active summary",
    response: M7CarePlanSummaryResponseSchema,
  },
  "GET /api/v1/care-plans/:planId/overdue-status": {
    summary: "The 5-/15-day CoP 418.56 review-gate status",
    query: M7RelevantElementsQuerySchema,
    response: M7OverdueStatusResponseSchema,
  },
  "GET /api/v1/internal/care-plan/relevant-elements": {
    summary: "Encounter element picker (active problems/goals/interventions by discipline)",
    query: M7RelevantElementsQuerySchema,
    response: M7RelevantElementsResponseSchema,
  },
});

// ── M08 Encounters & Visit Notes (§4.1, 31 routes) ────────────────────────────────────────────────
Object.assign(ROUTE_ENRICHMENTS, {
  "POST /api/v1/encounters": {
    summary: "Create a draft encounter",
    body: M8CreateEncounterSchema,
    response: M8CreatedEncounterResponseSchema,
  },
  "GET /api/v1/encounters": {
    summary: "List encounters for the org (filterable)",
    query: M8EncounterListQuerySchema,
    response: M8EncounterListResponseSchema,
  },
  "GET /api/v1/encounters/cosignature-queue": {
    summary: "RN cosignature work queue",
    response: M8EncounterListResponseSchema,
  },
  "GET /api/v1/encounters/my-drafts": {
    summary: "The caller's open draft encounters",
    response: M8EncounterListResponseSchema,
  },
  "GET /api/v1/encounters/:encounterId": {
    summary: "Read one encounter",
    response: M8EncounterViewResponseSchema,
  },
  "PATCH /api/v1/encounters/:encounterId/selections": {
    summary: "Update draft selections (§7.7 If-Match)",
    body: M8UpdateSelectionsSchema,
    response: M8SelectionsUpdateResponseSchema,
    headers: IF_MATCH_HEADER,
  },
  "POST /api/v1/encounters/:encounterId/vitals": {
    summary: "Capture a vitals set",
    body: M8CaptureVitalsSchema,
    response: M8VitalsResultResponseSchema,
  },
  "PATCH /api/v1/encounters/:encounterId/vitals/:vitalId": {
    summary: "Edit a vitals set (§7.7 If-Match)",
    body: M8CaptureVitalsSchema,
    response: M8VitalsResultResponseSchema,
    headers: IF_MATCH_HEADER,
  },
  "POST /api/v1/encounters/:encounterId/mileage": {
    summary: "Capture per-encounter mileage (D10)",
    body: M8CaptureMileageSchema,
    response: M8MileageResultResponseSchema,
  },
  "PATCH /api/v1/encounters/:encounterId/mileage": {
    summary: "Edit per-encounter mileage (§7.7 If-Match)",
    body: M8CaptureMileageSchema,
    response: M8MileageResultResponseSchema,
    headers: IF_MATCH_HEADER,
  },
  "POST /api/v1/encounters/:encounterId/care-plan-links": {
    summary: "Link the encounter to care-plan elements",
    body: M8CarePlanLinkSchema,
    response: M8CarePlanLinkResponseSchema,
  },
  "DELETE /api/v1/encounters/:encounterId/care-plan-links/:linkId": {
    summary: "Remove a care-plan link while draft",
  },
  "POST /api/v1/encounters/:encounterId/evv-reconcile": {
    summary: "Document an EVV-missing reason (D9 fallback)",
    body: M8EvvReconcileSchema,
    response: M8EvvReconcileResponseSchema,
  },
  "POST /api/v1/encounters/:encounterId/finalize": {
    summary: "Finalize the encounter (Layer-3 gate preview)",
    body: M8FinalizeEncounterSchema,
    response: M8FinalizeResponseSchema,
  },
  "POST /api/v1/encounters/:encounterId/hearthnote/enhance": {
    summary: "Invoke HearthNote Layer-2 enhancement",
    body: M8HearthnoteEnhanceSchema,
    response: M8ModificationResponseSchema,
  },
  "PATCH /api/v1/encounters/:encounterId/hearthnote/modifications/:modId/decisions": {
    summary: "Record a per-passage accept/edit/reject decision",
    body: M8ModificationDecisionSchema,
    response: M8ModificationResponseSchema,
  },
  "POST /api/v1/encounters/:encounterId/sign": {
    summary: "Sign the encounter (Layer-3 gate; D13 step-up)",
    body: M8SignEncounterSchema,
    response: M8SignResponseSchema,
  },
  "POST /api/v1/encounters/:encounterId/late-entry-override": {
    summary: "Significant late-entry tier override (supervisor)",
    body: M8LateEntryOverrideSchema,
    response: M8EncounterStatusResponseSchema,
  },
  "POST /api/v1/encounters/:encounterId/administrative-override": {
    summary: "Administrative >14-day override (director)",
    body: M8AdministrativeOverrideSchema,
    response: M8EncounterStatusResponseSchema,
  },
  "POST /api/v1/encounters/:encounterId/void": {
    summary: "Void a draft (admin-only; reason >= 40 chars)",
    body: M8VoidEncounterSchema,
    response: M8VoidResponseSchema,
  },
  "GET /api/v1/encounters/:encounterId/cosignature": {
    summary: "Read cosignature-request state",
    response: M8CosignatureReadResponseSchema,
  },
  "POST /api/v1/encounters/:encounterId/cosignature/acknowledge": {
    summary: "Cosigner acknowledges (§4.6 cosigner_role_match)",
    response: M8CosignatureStatusResponseSchema,
  },
  "POST /api/v1/encounters/:encounterId/cosignature/sign": {
    summary: "Cosigner signs (§4.6 cosigner_role_match; D13 step-up)",
    body: M8SignEncounterSchema,
    response: M8CosignSignResponseSchema,
  },
  "POST /api/v1/encounters/:encounterId/cosignature/supervisor-release": {
    summary: "Supervisor releases past the 48h hard cap",
    body: M8SupervisorReleaseSchema,
    response: M8CosignatureStatusResponseSchema,
  },
  "POST /api/v1/encounters/:encounterId/addenda": {
    summary: "Create an addendum draft on a signed encounter",
    body: M8CreateAddendumSchema,
    response: M8CreateAddendumResponseSchema,
  },
  "PATCH /api/v1/encounters/:encounterId/addenda/:addendumId/selections": {
    summary: "Update addendum selections (§7.7 If-Match)",
    body: M8UpdateSelectionsSchema,
    response: M8AddendumSelectionsResponseSchema,
    headers: IF_MATCH_HEADER,
  },
  "POST /api/v1/encounters/:encounterId/addenda/:addendumId/finalize": {
    summary: "Finalize an addendum",
    body: M8FinalizeEncounterSchema,
    response: M8AddendumFinalizeResponseSchema,
  },
  "POST /api/v1/encounters/:encounterId/addenda/:addendumId/sign": {
    summary: "Sign an addendum (D13 step-up)",
    body: M8SignEncounterSchema,
    response: M8AddendumSignResponseSchema,
  },
  "GET /api/v1/internal/encounters/billable": {
    summary: "Internal: BillableEncounterReader seam (M23/M24)",
    query: M8BillableQuerySchema,
    response: M8BillableResponseSchema,
  },
  "GET /api/v1/internal/encounters/signed-since": {
    summary: "Internal: signed-since seam (M14 IDG aggregator)",
    query: M8SignedSinceQuerySchema,
    response: M8EncounterListResponseSchema,
  },
  "GET /api/v1/internal/encounters/:encounterId/render-payload": {
    summary: "Internal: M22 PDF-render payload",
    response: M8RenderPayloadResponseSchema,
  },
});

// ── M09 Clinical Assessments Suite (18 routes) ────────────────────────────────────────────────────
Object.assign(ROUTE_ENRICHMENTS, {
  "POST /api/v1/patients/:patientId/assessments": {
    summary: "Record a scale capture (server-scored; discipline-matrix ABAC)",
    body: M9RecordAssessmentSchema,
  },
  "POST /api/v1/patients/:patientId/assessments/:id/corrections": {
    summary: "Correction-of-record (append-only supersede; If-Match)",
    body: M9CorrectAssessmentSchema,
    headers: IF_MATCH_HEADER,
    status: 201,
  },
  "GET /api/v1/patients/:patientId/assessments": {
    summary: "Patient assessment timeline",
    query: M9AssessmentListQuerySchema,
    response: M9AssessmentListResponseSchema,
  },
  "GET /api/v1/patients/:patientId/assessments/summary": {
    summary: "Per-scale latest-capture summary surface",
    response: M9AssessmentSummaryResponseSchema,
  },
  "GET /api/v1/patients/:patientId/assessments/:id": {
    summary: "Read one assessment row",
    response: M9AssessmentViewResponseSchema,
  },
  "GET /api/v1/patients/:patientId/scales/:scaleType/latest": {
    summary: "Latest capture of one scale",
    response: M9AssessmentViewResponseSchema,
  },
  "GET /api/v1/patients/:patientId/scales/:scaleType/series": {
    summary: "Scored series over a [from, to] window",
    query: M9SeriesQuerySchema,
    response: M9ScaleSeriesResponseSchema,
  },
  "GET /api/v1/patients/:patientId/scales/:scaleType/delta": {
    summary: "Latest-vs-window delta for one scale",
    query: M9DeltaQuerySchema,
    response: M9ScaleDeltaResponseSchema,
  },
  "POST /api/v1/assessments/:id/cosignatures": {
    summary: "LPN cosignature (cosigner_role_match ABAC)",
    body: M9CosignatureSchema,
  },
  "GET /api/v1/patients/:patientId/significant-changes": {
    summary: "Significant-change worklist for a patient",
    response: M9SignificantChangeListResponseSchema,
  },
  "POST /api/v1/significant-changes/:eventId/acknowledge": {
    summary: "Acknowledge a significant-change event",
    body: M9AcknowledgeChangeSchema,
  },
  "GET /api/v1/internal/assessments/latest-batch": {
    summary: "Internal: LatestAssessmentProvider batch",
    query: M9LatestBatchQuerySchema,
    response: M9LatestBatchResponseSchema,
  },
  "GET /api/v1/internal/assessments/series-batch": {
    summary: "Internal: ScaleSeriesProvider batch",
    query: M9SeriesBatchQuerySchema,
    response: M9ScaleSeriesResponseSchema,
  },
  "GET /api/v1/admin/scales/licenses": {
    summary: "Admin: scale-license registry",
    response: M9ScaleLicenseListResponseSchema,
  },
  "POST /api/v1/admin/scales/licenses": {
    summary: "Admin: register a scale license",
    body: M9CreateLicenseSchema,
  },
  "PATCH /api/v1/admin/scales/licenses/:id": {
    summary: "Admin: update a scale license (partial)",
    body: M9UpdateLicenseSchema,
  },
  "GET /api/v1/admin/scales/policies": {
    summary: "Admin: scale-policy registry",
    response: M9ScalePolicyListResponseSchema,
  },
  "PATCH /api/v1/admin/scales/policies/:scaleType": {
    summary: "Admin: enable/disable a scale",
    body: M9UpdateScalePolicySchema,
  },
});

// ── M10 HOPE Engine (20 routes) ───────────────────────────────────────────────────────────────────
Object.assign(ROUTE_ENRICHMENTS, {
  "GET /api/v1/hope/schedules": {
    summary: "List HOPE timepoint schedules (filter by patient / status / RFA)",
    query: M10ScheduleListQuerySchema,
    response: M10HopeScheduleListResponseSchema,
  },
  "GET /api/v1/hope/schedules/:id": {
    summary: "One schedule with derived window state",
    response: M10HopeScheduleResponseSchema,
  },
  "POST /api/v1/hope/schedules/:id/skip": {
    summary: "Skip a schedule (requires reason code)",
    body: M10SkipScheduleSchema,
    response: M10HopeScheduleResponseSchema,
  },
  "POST /api/v1/admissions/:admissionId/hope/timepoints": {
    summary: "Record a new HOPE timepoint (draft; RN/NP/MD author)",
    body: M10RecordTimepointSchema,
    response: M10HopeAssessmentResponseSchema,
  },
  "POST /api/v1/admissions/:admissionId/hope/sfv": {
    summary: "Record an SFV completion (RFA-04; RN/NP author)",
    body: M10RecordSfvSchema,
    response: M10HopeAssessmentResponseSchema,
  },
  "PUT /api/v1/hope/assessments/:id": {
    summary: "Update a draft assessment",
    body: M10UpdateDraftSchema,
    response: M10HopeAssessmentResponseSchema,
  },
  "POST /api/v1/hope/assessments/:id/sign": {
    summary: "Sign a draft (runs the D4 J2051 trigger; snapshots PPS/ESAS-r)",
    body: M10SignTimepointSchema,
    response: M10HopeAssessmentResponseSchema,
  },
  "POST /api/v1/hope/assessments/:id/correct": {
    summary: "Insert a correction RFA (supersedes the original)",
    body: M10CorrectTimepointSchema,
    response: M10HopeAssessmentResponseSchema,
  },
  "GET /api/v1/hope/assessments/:id": {
    summary: "One assessment (sections, snapshot, validation findings)",
    response: M10HopeAssessmentResponseSchema,
  },
  "GET /api/v1/patients/:patientId/hope/assessments": {
    summary: "Patient HOPE timeline",
    response: M10HopeAssessmentListResponseSchema,
  },
  "POST /api/v1/hope/assessments/:id/summary-pdf": {
    summary: "Request the printable HOPE summary (emits summary_requested)",
    body: M10SummaryPdfSchema,
    response: M10HopeSummaryRequestedResponseSchema,
  },
  "GET /api/v1/hope/assessments/:id/validation": {
    summary: "On-demand pre-submission validation findings for one row",
    response: M10HopeValidationResponseSchema,
  },
  "GET /api/v1/hope/sfv": {
    summary: "Open / overdue / missed SFV worklist",
    query: M10SfvWorklistQuerySchema,
    response: M10HopeSfvListResponseSchema,
  },
  "GET /api/v1/hope/sfv/:id": { summary: "SFV detail", response: M10HopeSfvResponseSchema },
  "GET /api/v1/hope/submissions": {
    summary: "Submission batches per ProviderEntity",
    query: M10SubmissionListQuerySchema,
    response: M10HopeSubmissionListResponseSchema,
  },
  "GET /api/v1/hope/submissions/:id": {
    summary: "Submission detail with per-item outcomes",
    response: M10HopeSubmissionResponseSchema,
  },
  "POST /api/v1/hope/submissions/:id/retry": {
    summary: "Retry a rejected submission (re-validates, re-assembles)",
    body: M10RetrySubmissionSchema,
    response: M10HopeSubmissionResponseSchema,
  },
  "POST /api/v1/hope/submissions/assemble": {
    summary: "Force-assemble a submission outside the cron cadence",
    body: M10AssembleSubmissionSchema,
    response: M10HopeSubmissionResponseSchema,
  },
  "GET /api/v1/hope/dashboard/compliance": {
    summary: "Org-level HQRP compliance posture",
    query: M10DashboardQuerySchema,
    response: M10HopeComplianceResponseSchema,
  },
  "POST /api/v1/hope/admin/regenerate-schedules": {
    summary: "Admin: recompute schedules for an admission",
    body: M10RegenerateSchedulesSchema,
    response: M10HopeRegenerateResponseSchema,
  },
});

// ── M11 Orders (28 routes) — supersedes the earlier inline M11 GET entries (later Object.assign wins) ──
Object.assign(ROUTE_ENRICHMENTS, {
  "GET /api/v1/orders": {
    summary: "List orders by patient / admission / kind / status (ABAC caseload_or_scope)",
    query: M11OrderListQuerySchema,
    response: M11OrderListResponseSchema,
  },
  "GET /api/v1/orders/pending-signature": {
    summary: "Physician pending-signature inbox",
    response: M11OrderListResponseSchema,
  },
  "GET /api/v1/orders/verbal-expiring": {
    summary: "RN verbal-expiring queue (live 48h countdown)",
    response: M11OrderListResponseSchema,
  },
  "GET /api/v1/orders/cosign-pending": {
    summary: "RN cosign-pending queue",
    response: M11OrderListResponseSchema,
  },
  "GET /api/v1/orders/results-pending-review": {
    summary: "Lab orders with results awaiting Mark-reviewed (D17)",
    response: M11OrderListResponseSchema,
  },
  "GET /api/v1/orders/suggestions/:patientId": {
    summary: "Derived order-suggestion banner for a patient (D7)",
    response: M11SuggestionsResponseSchema,
  },
  "POST /api/v1/orders": {
    summary: "Create a draft order (discipline_can_order ABAC)",
    body: M11CreateOrderRequest,
    response: M11OrderViewResponseSchema,
  },
  "GET /api/v1/orders/:id": {
    summary: "Order detail (lifecycle, signatures, verbal deadline, results state)",
    response: M11OrderViewResponseSchema,
  },
  "PATCH /api/v1/orders/:id": {
    summary: "Edit a draft order (draft only)",
    body: M11UpdateOrderRequest,
    response: M11OrderViewResponseSchema,
  },
  "POST /api/v1/orders/:id/request-signature": {
    summary: "Draft -> pending_signature (resolves cosign requirement)",
    body: M11RequestSignatureRequest,
    response: M11OrderViewResponseSchema,
  },
  "POST /api/v1/orders/:id/sign": {
    summary: "Sign an order -> active (signer_eligible ABAC)",
    body: M11SignOrderRequest,
    response: M11OrderViewResponseSchema,
  },
  "POST /api/v1/orders/:id/sign-on-behalf": {
    summary: "Sign on behalf (medical_director only)",
    body: M11SignOnBehalfRequest,
    response: M11OrderViewResponseSchema,
  },
  "POST /api/v1/orders/:id/verbal": {
    summary: "Record as verbal -> verbal_pending (starts 48h timer)",
    body: M11RecordVerbalRequest,
    response: M11OrderViewResponseSchema,
  },
  "POST /api/v1/orders/:id/cosign": {
    summary: "Attach a cosignature (cosigner_role_match ABAC)",
    body: M11CosignRequest,
    response: M11OrderViewResponseSchema,
  },
  "POST /api/v1/orders/:id/discontinue": {
    summary: "Discontinue an active/pending/verbal order",
    body: M11DiscontinueRequest,
    response: M11OrderViewResponseSchema,
  },
  "POST /api/v1/orders/:id/correct": {
    summary: "Issue a corrected order (discipline_can_order ABAC)",
    body: M11CorrectOrderRequest,
    response: M11OrderViewResponseSchema,
  },
  "POST /api/v1/orders/:id/complete": {
    summary: "Manual completion (incl. lab Mark-reviewed)",
    body: M11CompleteOrderRequest,
    response: M11OrderViewResponseSchema,
  },
  "GET /api/v1/standing-orders": {
    summary: "Standing-order templates (cadence, next-spawn, count)",
    response: M11StandingOrderListResponseSchema,
  },
  "GET /api/v1/standing-orders/:id": {
    summary: "Standing-order template detail + spawn history",
    response: M11StandingOrderViewResponseSchema,
  },
  "POST /api/v1/standing-orders": {
    summary: "Create a standing-order template (D5 eligibility)",
    body: M11CreateStandingOrderRequest,
    response: M11StandingOrderViewResponseSchema,
  },
  "PATCH /api/v1/standing-orders/:id": {
    summary: "Edit a standing-order template",
    body: M11UpdateStandingOrderRequest,
    response: M11StandingOrderViewResponseSchema,
  },
  "POST /api/v1/standing-orders/:id/pause": {
    summary: "Pause a standing-order template",
    response: M11StandingOrderViewResponseSchema,
  },
  "POST /api/v1/standing-orders/:id/resume": {
    summary: "Resume a paused standing-order template",
    response: M11StandingOrderViewResponseSchema,
  },
  "POST /api/v1/standing-orders/:id/discontinue": {
    summary: "Discontinue a standing-order template",
    body: M11DiscontinueStandingOrderRequest,
    response: M11StandingOrderViewResponseSchema,
  },
  "POST /api/v1/standing-orders/:id/spawn": {
    summary: "PRN manual spawn from a standing-order template",
    body: M11SpawnStandingOrderRequest,
    response: M11SpawnResponseSchema,
  },
  "GET /api/v1/admin/orders/verbal-policy": {
    summary: "Org verbal-order policy (window, cosign kinds, floor)",
    response: M11VerbalPolicyViewResponseSchema,
  },
  "PUT /api/v1/admin/orders/verbal-policy": {
    summary: "Update org verbal-order policy (tighten-only, <=48h)",
    body: M11VerbalPolicyRequest,
    response: M11VerbalPolicyViewResponseSchema,
  },
  "POST /api/v1/admin/orders/regenerate-verbal-timer/:id": {
    summary: "Platform-ops verbal-timer regeneration (audited)",
    body: M11RegenerateVerbalTimerRequest,
    response: M11OrderViewResponseSchema,
  },
});

// ── M12 DoseSpot Integration (31 routes) ──────────────────────────────────────────────────────────
Object.assign(ROUTE_ENRICHMENTS, {
  "GET /api/v1/medication-orders": {
    summary: "List medication orders (filterable)",
    query: M12MedicationOrderListQuerySchema,
    response: M12MedicationOrderListResponseSchema,
  },
  "POST /api/v1/medication-orders": {
    summary: "Create a medication-order draft (prescriber_eligible ABAC)",
    body: M12CreateMedicationOrderRequest,
  },
  "GET /api/v1/medication-orders/:id": {
    summary: "One medication order's detail",
    response: M12MedicationOrderResponseSchema,
  },
  "PATCH /api/v1/medication-orders/:id": {
    summary: "Edit a medication-order draft",
    body: M12UpdateMedicationOrderRequest,
  },
  "POST /api/v1/medication-orders/:id/request-signature": {
    summary: "Move a draft to pending_signature",
    body: M12RequestSignatureRequest,
  },
  "POST /api/v1/medication-orders/:id/sign": {
    summary: "Standard sign a medication order",
    body: M12SignMedicationOrderRequest,
  },
  "POST /api/v1/medication-orders/:id/sign-controlled/initiate": {
    summary: "Initiate an EPCS controlled-substance sign (2FA nonce; dea_schedule_authorized ABAC)",
    body: M12SignControlledInitiateRequest,
  },
  "POST /api/v1/medication-orders/:id/sign-controlled/complete": {
    summary: "Complete an EPCS controlled-substance sign (second factor)",
    body: M12SignControlledCompleteRequest,
  },
  "POST /api/v1/medication-orders/:id/verbal": {
    summary: "Record a medication order as verbal",
    body: M12RecordVerbalRequest,
  },
  "POST /api/v1/medication-orders/:id/cosign": {
    summary: "Attach a cosignature (no self-cosign)",
    body: M12CosignRequest,
  },
  "POST /api/v1/medication-orders/:id/discontinue": {
    summary: "Discontinue a medication order",
    body: M12DiscontinueRequest,
  },
  "POST /api/v1/medication-orders/:id/complete": {
    summary: "Complete a medication order (no-refills-no-renewal)",
    body: M12CompleteRequest,
  },
  "POST /api/v1/medication-orders/:id/correct": {
    summary: "Issue a corrected replacement order (prescriber_eligible ABAC)",
    body: M12CorrectMedicationOrderRequest,
  },
  "POST /api/v1/medication-orders/:id/retransmit": {
    summary: "Retransmit a transmission_failed order (mints a corrected order)",
    response: M12NewOrderIdResponseSchema,
  },
  "GET /api/v1/medication-orders/:id/transmission": {
    summary: "DoseSpot transmission status + retry history",
    response: M12TransmissionResponseSchema,
  },
  "GET /api/v1/patients/:patientId/medications/active": {
    summary: "Active medications for a patient",
    response: M12MedicationOrderListResponseSchema,
  },
  "GET /api/v1/patients/:patientId/medications/history": {
    summary: "Medication-history list for a patient",
    response: M12MedicationHistoryResponseSchema,
  },
  "POST /api/v1/patients/:patientId/medications/history/refresh": {
    summary: "Enqueue a DoseSpot MedHx refresh",
    response: M12HistoryRefreshResponseSchema,
  },
  "POST /api/v1/medication-history-records/:id/reconcile": {
    summary: "Reconcile a medication-history record",
    body: M12ReconcileRequest,
  },
  "GET /api/v1/refills": {
    summary: "Refill inbox (refill_inbox_scope ABAC)",
    response: M12RefillListResponseSchema,
  },
  "GET /api/v1/refills/:id": {
    summary: "One refill request's detail",
    response: M12RefillRequestResponseSchema,
  },
  "POST /api/v1/refills/:id/approve": {
    summary: "Approve a refill (mints a new medication order)",
    body: M12ApproveRefillRequest,
  },
  "POST /api/v1/refills/:id/deny": { summary: "Deny a refill request", body: M12DenyRefillRequest },
  "POST /api/v1/rx-benefit/lookup": {
    summary: "Cached RxBenefit coverage lookup",
    body: M12RxBenefitLookupRequest,
  },
  "GET /api/v1/admin/dosespot-prescribers": {
    summary: "Per-tenant DoseSpot prescriber roster",
    response: M12PrescriberRosterListResponseSchema,
  },
  "POST /api/v1/admin/dosespot-prescribers/:membershipId/enroll": {
    summary: "Enroll a prescriber into DoseSpot",
    body: M12EnrollPrescriberRequest,
  },
  "POST /api/v1/admin/dosespot-prescribers/:membershipId/revoke": {
    summary: "Revoke a prescriber",
    body: M12RevokePrescriberRequest,
  },
  "GET /api/v1/admin/refill-inbox-policy": {
    summary: "Refill-inbox SLA policy",
    response: M12RefillInboxPolicyResponseSchema,
  },
  "PATCH /api/v1/admin/refill-inbox-policy": {
    summary: "Update the refill-inbox SLA policy (tighten-only)",
    body: M12RefillInboxPolicyRequest,
  },
  "GET /api/v1/admin/controlled-substance-policy": {
    summary: "Controlled-substance refill policy",
    response: M12ControlledSubstancePolicyResponseSchema,
  },
  "PATCH /api/v1/admin/controlled-substance-policy": {
    summary: "Update the controlled-substance refill policy (tighten-only, 21 CFR 1306.22)",
    body: M12ControlledSubstancePolicyRequest,
  },
});

// ── M13 eMAR & Med Administration (28 routes) ─────────────────────────────────────────────────────
Object.assign(ROUTE_ENRICHMENTS, {
  "POST /api/v1/administrations": {
    summary:
      "Record a clinician administration (five-rights; administering_clinician_eligible ABAC)",
    body: M13RecordAdministrationRequest,
  },
  "POST /api/v1/administrations/witness-attest": {
    summary: "Mint a single-use controlled-substance witness-attestation token (D7)",
    body: M13WitnessAttestRequest,
  },
  "POST /api/v1/administrations/caregiver-attested": {
    summary: "Record a caregiver-attested administration via the M31 portal (D10)",
    body: M13RecordCaregiverAttestedRequest,
  },
  "POST /api/v1/administrations/:id/acknowledge-caregiver": {
    summary: "RN acknowledges a caregiver-attested row (caregiver_attested_review_required ABAC)",
    body: M13AcknowledgeCaregiverRequest,
  },
  "POST /api/v1/administrations/:id/dispute-caregiver": {
    summary: "RN disputes a caregiver-attested row",
    body: M13DisputeCaregiverRequest,
  },
  "POST /api/v1/administrations/:id/correct": {
    summary: "Correct a committed administration (supersede)",
    body: M13CorrectAdministrationRequest,
  },
  "POST /api/v1/administrations/:id/void": {
    summary: "Administrative hard-void (recorded in error)",
    body: M13VoidAdministrationRequest,
  },
  "GET /api/v1/administrations/:id": {
    summary: "Read one administration",
    response: M13AdministrationViewSchema,
  },
  "GET /api/v1/administrations": {
    summary: "List a patient's administrations (administered-at window)",
    query: M13AdministrationListQuerySchema,
    response: M13AdministrationListResponseSchema,
  },
  "GET /api/v1/administrations/iv-sessions/:sessionId": {
    summary: "Read an IV-continuous session's segment sequence",
    response: M13IvSessionViewSchema,
  },
  "POST /api/v1/administrations/refuse": {
    summary: "Record a refusal (administering_clinician_eligible ABAC)",
    body: M13RecordRefusalRequest,
  },
  "POST /api/v1/administrations/offline-sync": {
    summary: "Bulk offline-queue sync from device (D18)",
    body: M13OfflineSyncRequest,
  },
  "GET /api/v1/scheduled-doses": {
    summary: "Read the scheduled-dose timeline for a patient",
    query: M13ScheduledDoseQuerySchema,
    response: M13ScheduledDoseListResponseSchema,
  },
  "POST /api/v1/scheduled-doses/:id/intentional-hold": {
    summary: "Record an intentional hold before the grace window expires",
    body: M13IntentionalHoldRequest,
  },
  "GET /api/v1/missed-doses": {
    summary: "List missed doses for a patient",
    query: M13MissedDoseQuerySchema,
    response: M13MissedDoseListResponseSchema,
  },
  "POST /api/v1/missed-doses/:id/acknowledge": {
    summary: "Case manager acknowledges a missed dose",
  },
  "GET /api/v1/reconciliation/worksheets": {
    summary: "List reconciliation worksheets for a patient",
    query: M13WorksheetQuerySchema,
    response: M13WorksheetListResponseSchema,
  },
  "GET /api/v1/reconciliation/worksheets/:id": {
    summary: "Read one worksheet with its lines + decisions",
    response: M13WorksheetViewSchema,
  },
  "POST /api/v1/reconciliation/worksheets/:id/decisions": {
    summary: "Record a per-line reconciliation decision (reconciliation_authoring_eligible ABAC)",
    body: M13RecordDecisionRequest,
  },
  "PATCH /api/v1/reconciliation/worksheets/:id/decisions/:lineId": {
    summary: "Update a per-line decision before finalization",
    body: M13UpdateDecisionRequest,
  },
  "POST /api/v1/reconciliation/worksheets/:id/add-caregiver-reported-line": {
    summary: "Add a caregiver-reported home-med line",
    body: M13AddCaregiverReportedLineRequest,
  },
  "POST /api/v1/reconciliation/worksheets/:id/finalize": {
    summary: "Finalize the worksheet (emits m13.reconciliation.completed)",
    body: M13FinalizeReconciliationRequest,
  },
  "POST /api/v1/reconciliation/worksheets/:id/void": {
    summary: "Void a reconciliation worksheet",
    body: M13VoidReconciliationRequest,
  },
  "GET /api/v1/comfort-kits/deployments": {
    summary: "List comfort-kit deployments for a patient",
    query: M13DeploymentQuerySchema,
    response: M13DeploymentListResponseSchema,
  },
  "GET /api/v1/comfort-kits/deployments/:id": {
    summary: "Read one deployment with its drawdowns",
    response: M13DeploymentViewSchema,
  },
  "POST /api/v1/comfort-kits/deployments/:id/acknowledge-return": {
    summary: "Manual return acknowledgment (Phase-1 fallback)",
    body: M13AcknowledgeReturnRequest,
  },
  "GET /api/v1/admin/administration-policy": {
    summary: "Read tenant administration policy",
    response: M13AdministrationPolicyViewSchema,
  },
  "PUT /api/v1/admin/administration-policy": {
    summary: "Update tenant administration policy",
    body: M13AdministrationPolicyRequest,
  },
});

// ── M14 IDG (§4.1 — 26 routes) ────────────────────────────────────────────────────────────────────
Object.assign(ROUTE_ENRICHMENTS, {
  "GET /api/v1/idg/schedule": {
    summary: "List the IDG meeting schedule for a location/range",
    query: M14ScheduleQuerySchema,
    response: M14ScheduleListResponseSchema,
  },
  "POST /api/v1/idg/recurring-policies": {
    summary: "Create a recurring IDG meeting policy",
    body: M14RecurringPolicyRequest,
    response: M14RecurringPolicyViewSchema,
  },
  "PATCH /api/v1/idg/recurring-policies/:id": {
    summary: "Update a recurring IDG meeting policy",
    body: M14RecurringPolicyRequest,
    response: M14RecurringPolicyViewSchema,
  },
  "GET /api/v1/idg/meetings/:id": {
    summary: "Read one IDG meeting's lifecycle view",
    response: M14MeetingViewSchema,
  },
  "POST /api/v1/idg/meetings/:id/cancel": {
    summary: "Cancel a meeting (per-patient review-floor ABAC)",
    body: M14CancelMeetingRequest,
  },
  "POST /api/v1/idg/meetings/:id/reschedule": {
    summary: "Reschedule a meeting (per-patient review-floor ABAC)",
    body: M14RescheduleMeetingRequest,
  },
  "POST /api/v1/idg/meetings/:id/packets/build": {
    summary: "Trigger the per-patient packet build",
    response: M14MeetingViewSchema,
  },
  "POST /api/v1/idg/meetings/:id/start": {
    summary: "Start the meeting (open decision/action-item writes)",
    response: M14MeetingViewSchema,
  },
  "POST /api/v1/idg/meetings/:id/adjourn": {
    summary: "Adjourn the meeting (commit point; fresh step-up, D13)",
    body: M14AdjournMeetingRequest,
  },
  "POST /api/v1/idg/meetings/:id/attendance": {
    summary: "Self check-in attendance for a meeting",
    body: M14RecordAttendanceRequest,
    response: M14AttendanceViewSchema,
  },
  "PATCH /api/v1/idg/attendance/:id": {
    summary: "Coordinator amends an attendance row",
    body: M14UpdateAttendanceRequest,
    response: M14AttendanceViewSchema,
  },
  "DELETE /api/v1/idg/attendance/:id": {
    summary: "Remove an erroneous attendance row (pre-start only)",
    response: M14RemovedResponseSchema,
  },
  "GET /api/v1/idg/meetings/:id/packets": {
    summary: "List a meeting's per-patient packets",
    response: M14PacketListResponseSchema,
  },
  "GET /api/v1/idg/meetings/:meetingId/packets/:patientId": {
    summary: "Read one patient's packet (SUD redaction applied)",
    response: M14PacketDigestViewSchema,
  },
  "POST /api/v1/idg/meetings/:id/agenda": {
    summary: "Add an agenda item to a meeting",
    body: M14AddAgendaItemRequest,
    response: M14AgendaItemViewSchema,
  },
  "PATCH /api/v1/idg/agenda/:id": {
    summary: "Update an agenda item",
    body: M14UpdateAgendaItemRequest,
    response: M14AgendaItemViewSchema,
  },
  "DELETE /api/v1/idg/agenda/:id": {
    summary: "Remove an agenda item",
    response: M14RemovedResponseSchema,
  },
  "POST /api/v1/idg/meetings/:id/decisions": {
    summary: "Record a decision (quorate_decision ABAC)",
    body: M14RecordDecisionRequest,
    response: M14DecisionViewSchema,
  },
  "PATCH /api/v1/idg/decisions/:id": {
    summary: "Update an open decision (open status only)",
    body: M14UpdateDecisionRequest,
    response: M14DecisionViewSchema,
  },
  "POST /api/v1/idg/decisions/:id/supersede": {
    summary: "Supersede a prior decision (§2.8)",
    body: M14SupersedeDecisionRequest,
    response: M14DecisionViewSchema,
  },
  "POST /api/v1/idg/meetings/:id/action-items": {
    summary: "Create an action item",
    body: M14CreateActionItemRequest,
    response: M14ActionItemViewSchema,
  },
  "PATCH /api/v1/idg/action-items/:id": {
    summary: "Update an action item (assignee self-service or coordinator)",
    body: M14UpdateActionItemRequest,
    response: M14ActionItemViewSchema,
  },
  "DELETE /api/v1/idg/action-items/:id": {
    summary: "Remove an action item (pre-adjourn only)",
    response: M14RemovedResponseSchema,
  },
  "GET /api/v1/idg/action-items": {
    summary: "List action items (assignee self-scoped)",
    query: M14ActionItemListQuerySchema,
    response: M14ActionItemListResponseSchema,
  },
  "GET /api/v1/idg/meetings/:id/minutes": {
    summary: "Read a meeting's minutes",
    response: M14MinutesViewSchema,
  },
  "POST /api/v1/idg/minutes/:id/amendments": {
    summary: "Submit a minutes amendment (final minutes only)",
    body: M14SubmitAmendmentRequest,
    response: M14AmendmentResponseSchema,
  },
});

// ── M17 Scheduling & Route Optimization (29 routes) — supersedes the earlier inline Sched* GET block ──
Object.assign(ROUTE_ENRICHMENTS, {
  "GET /api/v1/visits": {
    summary: "Visits in caseload/scope (clinician/patient/status/date filtered)",
    query: M17VisitListQuerySchema,
    response: M17VisitListResponseSchema,
  },
  "GET /api/v1/visits/:visitId": {
    summary: "One visit's detail (status + scheduled window + assignment)",
    response: M17VisitViewSchema,
  },
  "POST /api/v1/visits": {
    summary: "Manual visit create (runs the D8 pre-schedule gate)",
    body: M17CreateVisitRequest,
    response: M17VisitViewSchema,
  },
  "PATCH /api/v1/visits/:visitId": {
    summary: "Edit times / discipline / assignment (reruns D8 gate)",
    body: M17EditVisitRequest,
    response: M17VisitViewSchema,
  },
  "POST /api/v1/visits/:visitId/start": {
    summary: "Self-attest start (EVV-missing path; step-up-fresh)",
    body: M17StartVisitRequest,
    response: M17VisitViewSchema,
  },
  "POST /api/v1/visits/:visitId/cancel": {
    summary: "Cancel a visit (reason + reason code)",
    body: M17CancelVisitRequest,
    response: M17VisitViewSchema,
  },
  "POST /api/v1/visits/:visitId/reschedule": {
    summary: "Reschedule (returns the newly-created visit, 201)",
    body: M17RescheduleVisitRequest,
    response: M17RescheduleResponseSchema,
  },
  "POST /api/v1/visits/:visitId/no-show": {
    summary: "Mark no-show (triggers reassign-or-followup)",
    body: M17NoShowVisitRequest,
    response: M17VisitViewSchema,
  },
  "POST /api/v1/visits/:visitId/reassign": {
    summary: "Reassign-only (reruns the D8 gate)",
    body: M17ReassignVisitRequest,
    response: M17VisitViewSchema,
  },
  "GET /api/v1/visit-proposals": {
    summary: "The scheduler proposal inbox",
    query: M17ProposalListQuerySchema,
    response: M17ProposalListResponseSchema,
  },
  "POST /api/v1/visit-proposals/:proposalId/publish": {
    summary: "Publish a proposal as a real visit (201)",
    response: M17VisitViewSchema,
  },
  "POST /api/v1/visit-proposals/:proposalId/dismiss": {
    summary: "Dismiss a scheduler proposal",
    body: M17DismissProposalRequest,
    response: M17ProposalViewSchema,
  },
  "GET /api/v1/recurring-visits": {
    summary: "A patient's recurring-visit policies",
    query: M17RecurringListQuerySchema,
    response: M17RecurringListResponseSchema,
  },
  "POST /api/v1/recurring-visits": {
    summary: "Create a recurring policy (validates RRULE subset; 201)",
    body: M17CreateRecurringVisitRequest,
    response: M17RecurringViewSchema,
  },
  "POST /api/v1/recurring-visits/:id/discontinue": {
    summary: "Discontinue a recurring policy (cascade-cancels future)",
    body: M17DiscontinueRecurringVisitRequest,
    response: M17RecurringViewSchema,
  },
  "GET /api/v1/availability": {
    summary: "A membership's weekly availability pattern",
    query: M17AvailabilityQuerySchema,
    response: M17AvailabilityViewSchema,
  },
  "PUT /api/v1/availability/:membershipId": {
    summary: "Upsert a membership's weekly availability",
    body: M17UpsertAvailabilityRequest,
    response: M17AvailabilityViewSchema,
  },
  "GET /api/v1/time-off": {
    summary: "Time-off requests (approval queue / my-PTO)",
    query: M17TimeOffListQuerySchema,
    response: M17TimeOffListResponseSchema,
  },
  "POST /api/v1/time-off": {
    summary: "Request PTO (201)",
    body: M17RequestTimeOffRequest,
    response: M17TimeOffViewSchema,
  },
  "POST /api/v1/time-off/:id/approve": {
    summary: "Approve PTO (triggers reassignment scan)",
    body: M17ApproveTimeOffRequest,
    response: M17TimeOffViewSchema,
  },
  "POST /api/v1/time-off/:id/deny": {
    summary: "Deny PTO (reason)",
    body: M17DenyTimeOffRequest,
    response: M17TimeOffViewSchema,
  },
  "POST /api/v1/time-off/:id/cancel": {
    summary: "Cancel own pre-start PTO",
    body: M17CancelTimeOffRequest,
    response: M17TimeOffViewSchema,
  },
  "GET /api/v1/day-view": {
    summary: "Day-view grid (a clinician's visits for one date)",
    query: M17DayViewQuerySchema,
    response: M17DayViewResponseSchema,
  },
  "GET /api/v1/week-view": {
    summary: "Week-view grid (a clinician's visits across a week)",
    query: M17WeekViewQuerySchema,
    response: M17WeekViewResponseSchema,
  },
  "GET /api/v1/map-view": {
    summary: "Map-view ordered stops (coords-only polylines, D9)",
    query: M17MapViewQuerySchema,
    response: M17MapViewResponseSchema,
  },
  "POST /api/v1/optimize-day": {
    summary: "On-demand route optimisation (degraded when flag OFF)",
    body: M17OptimizeDayRequest,
    response: M17OptimizeDayResponseSchema,
  },
  "GET /api/v1/portal/upcoming": {
    summary: "Portal upcoming visits (lay-language, scrubbed)",
    query: M17PortalUpcomingQuerySchema,
    response: M17PortalUpcomingResponseSchema,
  },
  "GET /api/v1/metrics/visits": {
    summary: "Org-wide visit metrics (on-time / no-show / reschedule)",
    query: M17MetricsQuerySchema,
    response: M17VisitMetricsResponseSchema,
  },
  "GET /api/v1/metrics/route-efficiency": {
    summary: "Per-clinician route-efficiency metrics",
    query: M17RouteEfficiencyQuerySchema,
    response: M17RouteEfficiencyResponseSchema,
  },
});

// ── M18 EVV (25 routes) ───────────────────────────────────────────────────────────────────────────
Object.assign(ROUTE_ENRICHMENTS, {
  "POST /api/v1/evv/check-in": {
    summary: "Record a check-in (§4.7 capture predicates gate)",
    body: M18CheckInRequest,
    response: M18EvvCheckResultView,
  },
  "POST /api/v1/evv/check-out": {
    summary: "Record a check-out",
    body: M18CheckOutRequest,
    response: M18EvvCheckResultView,
  },
  "POST /api/v1/evv/offline-sync": {
    summary: "Batch offline-sync of capture events (idempotent on device+localId)",
    body: M18OfflineSyncRequest,
    response: M18EvvCheckResultListResponse,
  },
  "POST /api/v1/evv/events/:eventId/correct": {
    summary: "Correction-of-record (Clinical Supervisor+, fresh step-up)",
    body: M18CorrectEventRequest,
    response: M18EvvCheckResultView,
  },
  "GET /api/v1/evv/events/:eventId": {
    summary: "One EVV event (coordinate-free projection)",
    query: M18EventGetQuery,
    response: M18EvvEventView,
  },
  "GET /api/v1/evv/events": {
    summary: "List EVV events by filters",
    query: M18EventListQuery,
    response: M18EvvEventListResponse,
  },
  "GET /api/v1/evv/visits/:visitId/bracket": {
    summary: "The EVV bracket for a visit (M8 EvvBracketResolver source)",
    response: M18EvvBracketView,
  },
  "GET /api/v1/evv/devices": {
    summary: "List registered devices (self or supervisor)",
    query: M18MembershipIdQuery,
    response: M18EvvDeviceListResponse,
  },
  "POST /api/v1/evv/devices/self-register": {
    summary: "Clinician self-registers a device (-> pending_approval)",
    body: M18SelfRegisterDeviceRequest,
    response: M18EvvDeviceView,
  },
  "POST /api/v1/evv/devices/:id/approve": {
    summary: "Approve a pending device",
    response: M18EvvDeviceView,
  },
  "POST /api/v1/evv/devices/:id/reject": {
    summary: "Reject a pending device",
    body: M18RejectDeviceRequest,
    response: M18EvvDeviceView,
  },
  "POST /api/v1/evv/devices/:id/suspend": {
    summary: "Suspend a device",
    body: M18SuspendDeviceRequest,
    response: M18EvvDeviceView,
  },
  "POST /api/v1/evv/devices/:id/retire": {
    summary: "Retire a device",
    body: M18RetireDeviceRequest,
    response: M18EvvDeviceView,
  },
  "GET /api/v1/evv/geofence-policy": {
    summary: "Read geofence policy (tenant + per-address overrides)",
    response: M18EvvGeofencePolicyView,
  },
  "PATCH /api/v1/evv/geofence-policy/tenant": {
    summary: "Edit tenant tighten-only policy",
    body: M18EditTenantPolicyRequest,
    response: M18EvvGeofencePolicyView,
  },
  "POST /api/v1/evv/geofence-policy/per-address": {
    summary: "Create/replace a per-address override (reason >=30 chars)",
    body: M18CreatePerAddressOverrideRequest,
    response: M18EvvGeofencePolicyView,
  },
  "GET /api/v1/evv/missing-resolutions": {
    summary: "Open + recently-closed resolution queue",
    query: M18MissingResolutionListQuery,
    response: M18EvvMissingResolutionListResponse,
  },
  "POST /api/v1/evv/missing-resolutions/:id/clinician-attest": {
    summary: "Assigned clinician self-attests (reason >=40; D6 <=24h)",
    body: M18ClinicianAttestResolutionRequest,
    response: M18EvvMissingResolutionView,
  },
  "POST /api/v1/evv/missing-resolutions/:id/supervisor-override": {
    summary: "Supervisor override (step-up; reason >=60; D6 <=7d)",
    body: M18SupervisorOverrideResolutionRequest,
    response: M18EvvMissingResolutionView,
  },
  "GET /api/v1/evv/aggregator-submissions": {
    summary: "Per-state aggregator submission queue + status",
    query: M18AggregatorListQuery,
    response: M18EvvAggregatorSubmissionListResponse,
  },
  "POST /api/v1/evv/aggregator-submissions/:id/resubmit": {
    summary: "Operator-initiated resubmit (from rejected/timeout)",
    body: M18ResubmitSubmissionRequest,
    response: M18EvvAggregatorSubmissionView,
  },
  "POST /api/v1/evv/aggregator-submissions/:id/cancel": {
    summary: "Operator-initiated cancel (from a non-terminal status)",
    body: M18CancelSubmissionRequest,
    response: M18EvvAggregatorSubmissionView,
  },
  "GET /api/v1/evv/metrics": {
    summary: "EVV metrics (M30/M33 dashboard source)",
    query: M18MetricsQuery,
    response: M18EvvMetricsView,
  },
  "GET /api/v1/evv/clinician-current-location": {
    summary: "Clinician last-known location (M20 live-awareness; D10)",
    query: M18MembershipIdQuery,
    response: M18EvvLocationListResponse,
  },
  "GET /api/v1/portal/visits/:visitId/arrival": {
    summary: "Portal arrival surface (timestamps only, no coordinates)",
    response: M18EvvArrivalView,
  },
});

// ── M22 Document Management (33 routes) ───────────────────────────────────────────────────────────
Object.assign(ROUTE_ENRICHMENTS, {
  "POST /api/v1/document-uploads": {
    summary: "Initiate a checksum-enforced direct document upload",
    body: M22InitiateVerifiedUploadRequest,
    response: M22InitiateVerifiedUploadResponse,
  },
  "POST /api/v1/document-uploads/:id/complete": {
    summary: "Verify uploaded object metadata and atomically commit its document version",
    body: M22CompleteVerifiedUploadRequest,
    response: M22CompleteVerifiedUploadResponse,
  },
  "DELETE /api/v1/document-uploads/:id": {
    summary: "Abort a pending document upload and destroy its staged object versions",
  },
  "POST /api/v1/documents": {
    summary: "Upload a new document (creates version v1)",
    body: M22UploadDocumentRequest,
  },
  "GET /api/v1/documents": {
    summary: "List documents (filtered, cursor-paginated)",
    query: M22DocumentListQuerySchema,
    response: M22DocumentListResponseSchema,
  },
  "POST /api/v1/documents/:id/versions": {
    summary: "Upload a new version of an existing document",
    body: M22UploadVersionRequest,
  },
  "GET /api/v1/documents/:id/versions": {
    summary: "Version history (cursor-paginated)",
    query: M22VersionListQuerySchema,
    response: M22VersionListResponseSchema,
  },
  "GET /api/v1/documents/:id/versions/:versionId/content": {
    summary: "Mint a short-lived signed URL for the version content (BAA gate)",
    query: M22SignedUrlRequest,
    response: M22SignedUrlResponseSchema,
  },
  "GET /api/v1/documents/:id/versions/:versionId": {
    summary: "Read version metadata",
    response: M22VersionViewSchema,
  },
  "GET /api/v1/documents/:id": {
    summary: "Read document metadata + current version",
    response: M22DocumentViewSchema,
  },
  "PATCH /api/v1/documents/:id": {
    summary: "Edit document metadata (legal-hold aware)",
    body: M22PatchDocumentRequest,
  },
  "POST /api/v1/documents/:id/tags": { summary: "Add a tag to a document", body: M22AddTagRequest },
  "DELETE /api/v1/documents/:id/tags/:tagId": { summary: "Remove a tag from a document" },
  "POST /api/v1/documents/:id/export-phi-bundle": {
    summary: "§164.524 right-of-access bulk PHI export (step-up)",
    body: M22ExportPhiBundleRequest,
  },
  "POST /api/v1/intake/uploads": {
    summary: "Upload a new intake batch",
    body: M22IntakeUploadRequest,
  },
  "GET /api/v1/intake/uploads/:id": {
    summary: "Read batch metadata + pipeline status",
    response: M22IntakeBatchViewSchema,
  },
  "GET /api/v1/intake/uploads/:id/classification": {
    summary: "Classifier output (cursor-paginated)",
    query: M22ClassificationQuerySchema,
    response: M22ClassificationListResponseSchema,
  },
  "POST /api/v1/intake/uploads/:id/classification/confirm": {
    summary: "Human-confirm classifier results",
    body: M22ConfirmClassificationRequest,
  },
  "GET /api/v1/intake/uploads/:id/jobs": {
    summary: "Extraction jobs for the batch (cursor-paginated)",
    query: M22JobsListQuerySchema,
    response: M22IntakeJobListResponseSchema,
  },
  "GET /api/v1/intake/jobs/:id": {
    summary: "Read a job + its extraction candidates (cursor-paginated)",
    query: M22JobQuerySchema,
    response: M22JobDetailResponseSchema,
  },
  "POST /api/v1/intake/uploads/:id/review": {
    summary: "Open an extraction-review session (acquires lock)",
    body: M22OpenReviewRequest,
  },
  "GET /api/v1/intake/reviews/:id": {
    summary: "Read review state (candidates + decisions, cursor-paginated)",
    query: M22ReviewQuerySchema,
    response: M22ReviewDetailResponseSchema,
  },
  "POST /api/v1/intake/reviews/:id/decisions": {
    summary: "Record a per-candidate decision (§4.7 ABAC)",
    body: M22RecordDecisionRequest,
  },
  "POST /api/v1/intake/reviews/:id/decisions:bulk-approve": {
    summary: "Bulk-approve low-risk candidates (high-risk -> 422)",
    body: M22BulkApproveRequest,
  },
  "POST /api/v1/intake/reviews/:id/discrepancies/:discrepancyId/resolve": {
    summary: "Resolve a discrepancy",
    body: M22ResolveDiscrepancyRequest,
  },
  "POST /api/v1/intake/reviews/:id/complete": {
    summary: "Attest + trigger the writeback dispatcher",
    body: M22CompleteReviewRequest,
  },
  "POST /api/v1/intake/reviews/:id/abandon": {
    summary: "Release the review lock (decisions preserved)",
    body: M22AbandonReviewRequest,
  },
  "POST /api/v1/intake/uploads/:id/discard": {
    summary: "Mark a batch non-actionable",
    body: M22DiscardBatchRequest,
  },
  "GET /api/v1/form-templates": {
    summary: "List form templates (cursor-paginated)",
    query: M22TemplateListQuerySchema,
    response: M22FormTemplateListResponseSchema,
  },
  "GET /api/v1/form-templates/:key": {
    summary: "Read a template + its active version",
    response: M22FormTemplateResponseSchema,
  },
  "GET /api/v1/form-templates/:key/versions/:versionId": {
    summary: "Read a specific template version",
    response: M22FormTemplateVersionResponseSchema,
  },
  "POST /api/v1/admin/form-templates/:key/versions": {
    summary: "Publish a new template version (platform-only, §4.7 ABAC)",
    body: M22PublishTemplateRequest,
  },
  "GET /api/v1/tenant-overlays": {
    summary: "List the org's published overlays",
    response: M22TenantOverlayListResponseSchema,
  },
  "PUT /api/v1/tenant-overlays/:templateKey": {
    summary: "Publish a tenant overlay (step-up + If-Match, §4.7 ABAC)",
    body: M22PublishOverlayRequest,
    headers: IF_MATCH_HEADER,
  },
  "GET /api/v1/admin/form-fills/:id": {
    summary: "Inspect a form-fill render record (platform-only debug)",
    response: M22FormFillResponseSchema,
  },
  "POST /api/v1/admin/form-fills/:id/retry": {
    summary: "Manually retry a failed render (platform-only, step-up)",
    body: M22RetryRenderRequest,
  },
});

// ── M22 DocLens extraction routes (extraction/extraction-routes.ts — a second route file). Behind the
// DocLens flag (OFF → 503), so the agent sweep missed them; both mutate and carry a real parsed body.
import {
  CommitReviewRequest as M22CommitReviewRequest,
  RunBatchRequest as M22RunBatchRequest,
} from "../../apps/backend/src/modules/22-documents/extraction/extraction-routes";
Object.assign(ROUTE_ENRICHMENTS, {
  "POST /api/v1/intake/uploads/:id/extraction/run": {
    summary: "DocLens: run the extraction pipeline over a batch (flag-gated, 503 when OFF)",
    body: M22RunBatchRequest,
  },
  "POST /api/v1/intake/jobs/:id/extraction/commit": {
    summary: "DocLens: commit a reviewed extraction job's field decisions (flag-gated)",
    body: M22CommitReviewRequest,
  },
});

// ═══ WAVE 2: remaining green-module enrichment ═══
Object.assign(ROUTE_ENRICHMENTS, {
  // M2 identity routes (routes/identity-routes.ts — §7.1–7.7). Bodies read manually via
  // readString/readStringArray; DTOs mirror the routes' real shapes (MembershipView/OrgBinding pinned).
  "GET /api/v1/auth/memberships": {
    summary: "List the caller's memberships (pre-org, §7.2)",
    response: M2MembershipListResponseSchema,
  },
  "GET /api/v1/auth/context": {
    summary: "App-shell identity/role/permission projection (FB-T15)",
    response: M2AuthContextResponseSchema,
  },
  "POST /api/v1/auth/select-organization": {
    summary: "Bind the pre-org session to exactly one org (one-time, §7.2)",
    body: M2SelectOrganizationRequestSchema,
    response: M2OrgBindingResponseSchema,
  },
  "POST /api/v1/orgs/:id/invitations": {
    summary: "Invite a user to an org (member.invite, §7.1)",
    body: M2OrgInvitationCreateRequestSchema,
    response: M2InvitationCreatedResponseSchema,
  },
  "POST /api/v1/invitations/accept": {
    summary: "Consume an invite token → membership (§7.1)",
    body: M2InvitationAcceptRequestSchema,
    response: M2InvitationAcceptedResponseSchema,
  },
  "DELETE /api/v1/orgs/:id/invitations/:invId": {
    summary: "Rescind a pending invite (member.invite)",
    response: M2InvitationRescindedResponseSchema,
  },
  "GET /api/v1/orgs/:id/invitations": {
    summary: "List an org's invitation roster — pending/accepted/revoked (member.invite, TASK-030)",
    response: M2InvitationListResponseSchema,
  },
  "POST /api/v1/orgs/:id/invitations/:invId/resend": {
    summary: "Re-mint a pending invite's token + expiry, invalidating the prior link (TASK-030)",
    body: M2InvitationResendRequestSchema,
    response: M2InvitationResendResponseSchema,
  },
  "GET /api/v1/invitations/:token": {
    summary: "Pre-auth preview of a still-pending token's target email/org (TASK-030, §7.1)",
    response: M2InvitationPeekResponseSchema,
  },
  "GET /api/v1/orgs/:id/members": {
    summary: "List an org's memberships + pending-invites KPI (member.manage, §7.5)",
    query: M2MembersListQuerySchema,
    response: M2MembersListResponseSchema,
  },
  "PATCH /api/v1/orgs/:id/members/:mId": {
    summary: "Suspend/reinstate and/or re-scope a membership (member.manage, §7.5)",
    body: M2MemberPatchRequestSchema,
    response: M2MembershipViewSchema,
  },
  "DELETE /api/v1/orgs/:id/members/:mId": {
    summary: "Revoke a membership + reap its sessions (member.manage, §7.5)",
    response: M2MemberRevokedResponseSchema,
  },
  "POST /api/v1/users/:id/deactivate": {
    summary: "Full offboard: disable credentials + reap all sessions (user.deactivate, §7.5)",
    body: M2UserDeactivateRequestSchema,
    response: M2UserDeactivatedResponseSchema,
  },
  "POST /api/v1/collaborators/invite": {
    summary: "Mint a per-patient magic-link (caseload_membership ABAC, §7.6)",
    body: M2CollaboratorInviteRequestSchema,
    response: M2CollaboratorInviteResponseSchema,
  },
  "POST /api/v1/collaborators/consume": {
    summary: "Consume the link → scoped external-collaborator session (§7.6)",
    body: M2CollaboratorConsumeRequestSchema,
    response: M2CollaboratorConsumeResponseSchema,
  },
  // M2 step-up routes (routes/session-step-up.ts — §4.4; only WebAuthn/TOTP qualify, SMS 400).
  "POST /api/v1/sessions/step-up/initiate": {
    summary: "Start an MFA step-up challenge (WebAuthn or TOTP, §4.4)",
    body: M2StepUpInitiateRequestSchema,
    response: M2StepUpInitiateResponseSchema,
  },
  "POST /api/v1/sessions/step-up": {
    summary: "Verify a step-up challenge; paired-write freshness on success (§4.4.1, D8)",
    body: M2StepUpVerifyRequestSchema,
    response: M2StepUpVerifyResponseSchema,
  },
});

// ── M3 Authorization (17 routes — role catalog + assignment, break-glass, auditor engagements) ──────
// Full request + response contracts. Bodies reuse the boundary schemas; responses mirror the
// ../authz-ports views (RoleView / MembershipRoleView / BreakGlassView / EngagementView /
// EngagementSummary) + the @wardenx/auth permission mirror, each pinned by a `Conforms` alias.
Object.assign(ROUTE_ENRICHMENTS, {
  // §6 role catalog + assignment
  "GET /api/v1/permissions": {
    summary: "The permission catalog (mirror rows, §6)",
    response: M3PermissionsResponseSchema,
  },
  "GET /api/v1/roles": {
    summary: "List role catalog for the org (templates + customized, §6)",
    response: M3RoleListResponseSchema,
  },
  "POST /api/v1/roles": {
    summary: "Clone/extend a platform template into an org-owned custom role (§7.6)",
    body: M3CreateRoleBody,
    response: M3RoleResponseSchema,
  },
  "PATCH /api/v1/roles/:id": {
    summary: "Rename / enable / edit a role's permission set (§7.6)",
    body: M3UpdateRoleBody,
    response: M3RoleResponseSchema,
  },
  "DELETE /api/v1/roles/:id": {
    summary: "Delete a custom role (system_locked → 409, §3.4.1)",
    response: M3RoleDeletedResponseSchema,
  },
  "GET /api/v1/memberships/:id/roles": {
    summary: "List a membership's role grants (§6)",
    response: M3MembershipRoleListResponseSchema,
  },
  "POST /api/v1/memberships/:id/roles": {
    summary: "Grant a role onto a membership (§6 anti-escalation applies)",
    body: M3AssignRoleBody,
    response: M3MembershipRoleResponseSchema,
  },
  "DELETE /api/v1/memberships/:id/roles/:rid": {
    summary: "Revoke a role grant from a membership (§6)",
    response: M3RoleGrantRevokedResponseSchema,
  },
  "GET /api/v1/me/permissions": {
    summary: "The caller's effective permission keys (drives UI gating, §4.3)",
    response: M3MePermissionsResponseSchema,
  },

  // §7.4 break-glass emergency access
  "POST /api/v1/breakglass": {
    summary: "Invoke break-glass emergency access (§7.4; reason ≥10 chars)",
    body: M3InvokeBreakGlassBody,
    response: M3BreakGlassInvokedResponseSchema,
  },
  "POST /api/v1/breakglass/:id/cosign": {
    summary: "Co-sign a break-glass event → active (§7.4)",
    response: M3BreakGlassStatusResponseSchema,
  },
  "POST /api/v1/breakglass/:id/revoke": {
    summary: "Revoke an open break-glass event (§7.4)",
    response: M3BreakGlassStatusResponseSchema,
  },
  "GET /api/v1/breakglass": {
    summary: "List break-glass events for the org (§7.4)",
    response: M3BreakGlassListResponseSchema,
  },

  // §7.5 auditor engagements
  "POST /api/v1/engagements": {
    summary: "Open an auditor engagement over a defined slice + window (§7.5)",
    body: M3CreateEngagementBody,
    response: M3EngagementResponseSchema,
  },
  "PATCH /api/v1/engagements/:id": {
    summary: "Shorten an engagement window or cancel it (§7.5)",
    body: M3UpdateEngagementBody,
    response: M3EngagementResponseSchema,
  },
  "POST /api/v1/engagements/:id/auditors": {
    summary: "Enroll an auditor — M2 mints the magic link out-of-band (D4)",
    body: M3EnrollAuditorBody,
    response: M3AuditorEnrolledResponseSchema,
  },
  "GET /api/v1/engagements/:id/summary": {
    summary: "Post-engagement report — auditors enrolled + resources touched (§5.2)",
    response: M3EngagementSummaryResponseSchema,
  },
});

// M04 Audit & Compliance Log — full route enrichment (4 GET reads over the append-only
// audit_event log). Response DTOs are pinned to the @wardenx/audit AuditQuery port via Conforms in
// audit-typebox.ts. No mutating routes → no request bodies.
Object.assign(ROUTE_ENRICHMENTS, {
  // §4.2 — Compliance / survey / incident event search (cursor-paginated).
  "GET /api/v1/audit/events": {
    summary: "Search audit events (cursor-paginated, §4.2/§4.3)",
    query: M4EAuditEventsQuerySchema,
    response: M4EAuditEventsResponseSchema,
  },
  // §4.2 — single-event detail (the before/after diff). Path param only, no query.
  "GET /api/v1/audit/events/:id": {
    summary: "Fetch one audit event by id — the before/after diff (§4.2)",
    response: M4EAuditEventSchema,
  },
  // §10.2 — "who touched this chart": per-patient internal access history.
  "GET /api/v1/audit/patients/:patientId/access": {
    summary: "Per-patient internal access history — who touched this chart (§10.2)",
    query: M4EPatientAccessQuerySchema,
    response: M4EPatientAccessResponseSchema,
  },
  // §7.1 / §164.528 / 42 CFR §2.13 — patient accounting of disclosures (scope-gated).
  "GET /api/v1/audit/patients/:patientId/accounting": {
    summary: "Patient accounting of disclosures — §164.528 / 42 CFR §2.13, scope-gated (§7.1)",
    query: M4EAccountingQuerySchema,
    response: M4EAccountingResponseSchema,
  },
});

// M05 Patient & Demographics — full route enrichment. Covers ALL 14 routes across
// apps/backend/src/modules/05-patient/routes/patient-routes.ts so the module's unenriched-route deficit
// drops to 0. This Object.assign runs AFTER the existing M5 block in enrichments.ts, so it SUPERSEDES it:
// the previously-bare write routes gain response DTOs, and `POST /api/v1/amendments/:id/accept` — the one
// route with NO entry — is now enriched. Response DTOs are pinned to the service read/return views by the
// `Conforms` aliases in patient-typebox.ts.
Object.assign(ROUTE_ENRICHMENTS, {
  // --- reads (§3.3–§3.5, §4.2) ---------------------------------------------------------------------
  "GET /api/v1/patients": {
    summary: "Patient census / list (cursor-paginated, §4.2)",
    query: M5EPatientListQuerySchema,
    response: M5EPatientListResponseSchema,
  },
  "GET /api/v1/patients/census-metrics": {
    summary: "Census KPI metrics — active count + per-status breakdown (§4.2)",
    response: M5ECensusMetricsResponseSchema,
  },
  "GET /api/v1/patients/:id": {
    summary: "Fetch a patient by id (merge-redirect aware, §4.8)",
    response: M5EPatientSummarySchema,
  },
  "GET /api/v1/patients/:id/demographics": {
    summary: "Patient demographics tab — name parts + SOGI/race/ethnicity codes + language (§3.3)",
    response: M5EPatientDemographicsSchema,
  },
  "GET /api/v1/patients/:id/identifiers": {
    summary: "Patient identifiers — ssn/state_id masked to last4 (§3.3/§2.2)",
    response: M5EPatientIdentifiersResponseSchema,
  },
  "GET /api/v1/patients/:id/addresses": {
    summary: "Patient address history — D5 append-only; current + closed rows (§3.3)",
    response: M5EPatientAddressesResponseSchema,
  },
  "GET /api/v1/patients/:id/payers": {
    summary: "Patient coverage / payers — ranked coverages; payer name resolved via M40 (§3.4)",
    response: M5EPatientPayersResponseSchema,
  },
  "GET /api/v1/patients/:id/care-team": {
    summary: "Patient care team — assignment roster + caregivers + emergency contacts (§3.4/§3.5)",
    response: M5EPatientCareTeamResponseSchema,
  },
  "GET /api/v1/patients/:id/privacy-flags": {
    summary:
      "Patient privacy flags — active restrictions snapshot; SUD §7.6 fail-closed (§3.5/D10)",
    response: M5EPatientPrivacyFlagsResponseSchema,
  },

  // --- writes (§7.1 admit / §7.4 address cascade / §7.7 right-to-amend) -----------------------------
  "POST /api/v1/patients": {
    summary: "Admit a patient (§7.1 duplicate-check; 201 created | soft_review, hard dup → 409)",
    body: M5EAdmitBodySchema,
    response: M5EAdmitResultResponseSchema,
  },
  "POST /api/v1/patients/:id/addresses": {
    summary: "Append a patient address (§7.4 cascade; isPrimary rotates the current primary)",
    body: M5EAddressBodySchema,
    response: M5EAddAddressResponseSchema,
  },
  "POST /api/v1/patients/:id/amendments": {
    summary: "Open a record-amendment request (§7.7, 60-day SLA)",
    body: M5EAmendmentBodySchema,
    response: M5EAmendmentResponseSchema,
  },
  "POST /api/v1/amendments/:id/accept": {
    summary: "Accept an amendment request (§7.7)",
    response: M5EAmendmentResponseSchema,
  },
  "POST /api/v1/amendments/:id/deny": {
    summary: "Deny an amendment request (denial reason required, §7.7)",
    body: M5EDenyBodySchema,
    response: M5EAmendmentResponseSchema,
  },
});

// M15 Discipline Care Plans — FULL §4.1 surface (28 routes). Append after the last existing
// `Object.assign(ROUTE_ENRICHMENTS, {...})`; later Object.assign wins, so this SUPERSEDES the earlier M15
// entries and closes the 5-route response deficit (the two view reads + the version-detail read + the two
// sign mutations that published no response contract). Org / acting-membership binding is server-side
// (§8.6 S); Idempotency-Key (§F08) and If-Match (§2.5) ride headers, enforced by preHandlers, not bodies.
Object.assign(ROUTE_ENRICHMENTS, {
  "GET /api/v1/discipline-plans": {
    summary:
      "Discipline-plan worklist — cursor-paginated, filterable by patient/admission/kind/status (§4.1 #1)",
    query: M15PlanListQuerySchema,
    response: M15DisciplinePlanListPageResponseSchema,
  },
  "GET /api/v1/discipline-plans/:planId": {
    summary:
      "The full plan — goals/interventions/assessments/supervisory visits/volunteer assignments, SQL-filtered per §7.8/§7.9 with the withheld categories on `redacted_categories` (§4.1 #2)",
    response: M15DisciplinePlanDetailResponseSchema,
  },
  "GET /api/v1/discipline-plans/:planId/summary": {
    summary:
      "The patient-shareable summary — both confidential categories always stripped (§7.9; §4.1 #3)",
    response: M15DisciplinePlanSummaryResponseSchema,
  },
  "GET /api/v1/discipline-plans/:planId/versions": {
    summary: "The plan's version chain, cursor-paginated by sequence (§4.1 #4)",
    query: M15VersionListQuerySchema,
    response: M15DisciplinePlanVersionListPageResponseSchema,
  },
  "GET /api/v1/discipline-plans/:planId/versions/:versionId": {
    summary:
      "One version with its sealed state snapshot, frozen D11 quorum and collected signatures (§4.1 #5)",
    response: M15DisciplinePlanVersionDetailResponseSchema,
  },
  "POST /api/v1/discipline-plans/:planId/versions/:versionId/finalize": {
    summary:
      "Finalize a draft version — seals the state snapshot and freezes the D11 quorum, which a tenant may tighten but never loosen (§4.1 #6)",
    body: M15FinalizeVersionBody,
    response: M15DisciplinePlanVersionDetailResponseSchema,
  },
  "POST /api/v1/discipline-plans/:planId/versions/:versionId/sign": {
    summary:
      "Sign one slot of the sealed quorum — step-up; the last signature flips the version to signed and triggers the plan-PDF render (§4.1 #7)",
    body: M15SignVersionBody,
    response: M15DisciplinePlanVersionDetailResponseSchema,
  },
  "POST /api/v1/discipline-plans/:planId/goals": {
    summary: "Author a discipline goal refining an IPOC problem (§4.1 #8)",
    body: M15CreateGoalBody,
    response: M15DisciplineGoalViewResponseSchema,
  },
  "PATCH /api/v1/discipline-plans/:planId/goals/:goalId": {
    summary:
      "Edit a goal — a status event and/or the refinement fields; `originalText` is immutable (§2.3; §4.1 #9)",
    body: M15UpdateGoalBody,
    response: M15DisciplineGoalViewResponseSchema,
  },
  "POST /api/v1/discipline-plans/:planId/interventions": {
    summary: "Author a discipline intervention (§4.1 #10)",
    body: M15CreateInterventionBody,
    response: M15DisciplineInterventionViewResponseSchema,
  },
  "PATCH /api/v1/discipline-plans/:planId/interventions/:interventionId": {
    summary: "Edit an intervention — discontinue (reason required) / complete / refine (§4.1 #11)",
    body: M15UpdateInterventionBody,
    response: M15DisciplineInterventionViewResponseSchema,
  },
  "POST /api/v1/discipline-plans/:planId/assessments": {
    summary:
      "Capture a discipline assessment (draft); `data` is validated against the per-kind schema, and the SUD / family-violence flags drive every later read's SQL filter (§4.1 #12)",
    body: M15CreateAssessmentBody,
    response: M15DisciplineAssessmentViewResponseSchema,
  },
  "POST /api/v1/discipline-plans/:planId/assessments/:assessmentId/sign": {
    summary:
      "Sign a drafted assessment — step-up; closes the D10 initial-assessment clock when `isInitial` (§4.1 #13)",
    response: M15DisciplineAssessmentViewResponseSchema,
  },
  "POST /api/v1/discipline-plans/:planId/assessments/:assessmentId/amend": {
    summary:
      "Amend a signed assessment — append-only correction of record; the superseded row is retained (§4.1 #14)",
    body: M15AmendAssessmentBody,
    response: M15DisciplineAssessmentViewResponseSchema,
  },
  "POST /api/v1/discipline-plans/:planId/aide-supervisory-visits": {
    summary:
      "Record an RN supervisory attestation (42 CFR §418.76(h)); a null sourceEncounterId is a phone-only contact and does NOT re-arm the 14-day clock (§4.1 #15)",
    body: M15CreateSupervisoryVisitBody,
    response: M15AideSupervisoryVisitViewResponseSchema,
  },
  "POST /api/v1/discipline-plans/:planId/aide-supervisory-visits/:visitId/sign": {
    summary: "Sign a recorded supervisory attestation — step-up (§4.1 #16)",
    response: M15AideSupervisoryVisitViewResponseSchema,
  },
  "POST /api/v1/discipline-plans/:planId/volunteer-assignments": {
    summary:
      "Create a volunteer assignment — the 418.78 gate check runs unless a documented overrideReason is supplied (§8.6; §4.1 #17)",
    body: M15CreateVolunteerAssignmentBody,
    response: M15VolunteerAssignmentViewResponseSchema,
  },
  "PATCH /api/v1/discipline-plans/:planId/volunteer-assignments/:assignmentId": {
    summary:
      "Edit / acknowledge / inactivate / reactivate an assignment — reactivation is always manual (§7.5; §4.1 #18)",
    body: M15UpdateVolunteerAssignmentBody,
    response: M15VolunteerAssignmentViewResponseSchema,
  },
  "GET /api/v1/volunteer-compliance-gates": {
    summary:
      "Volunteer compliance-gate worklist — cursor-paginated; status is re-derived over the validity window as of now (§2.2.6; §4.1 #19)",
    query: M15GateListQuerySchema,
    response: M15VolunteerComplianceGateListPageResponseSchema,
  },
  "POST /api/v1/volunteer-compliance-gates": {
    summary: "Record a 42 CFR §418.78(b)/(d) compliance gate for a volunteer (§4.1 #20)",
    body: M15CreateVolunteerGateBody,
    response: M15VolunteerComplianceGateViewResponseSchema,
  },
  "PATCH /api/v1/volunteer-compliance-gates/:gateId": {
    summary: "Correct a recorded gate's validity window / evidence (§4.1 #21)",
    body: M15UpdateVolunteerGateBody,
    response: M15VolunteerComplianceGateViewResponseSchema,
  },
  "POST /api/v1/volunteer-compliance-gates/:gateId/revoke": {
    summary:
      "Revoke a satisfied gate — reason required; cascades the volunteer to inactive (§4.1 #22)",
    body: M15RevokeVolunteerGateBody,
    response: M15VolunteerComplianceGateViewResponseSchema,
  },
  "GET /api/v1/volunteer-hour-ratio": {
    summary:
      "The 418.78(e) 5% ratio for one provider entity × fiscal year; an unbound cost basis returns `unavailable` with its reason, never a 0% breach (§7.6; §4.1 #23)",
    query: M15HourRatioQuerySchema,
    // summary-only: the service returns `unknown` — the ratio is a discriminated `available | unavailable`
    // envelope whose unbound-M27-denominator branch (M15-F04) has no frozen view to mirror.
  },
  "POST /api/v1/volunteer-hour-entries": {
    summary:
      "Record an audited manual hour adjustment — the only ledger path that may carry negative minutes (§4.1 #24)",
    body: M15CreateHourEntryBody,
    response: M15VolunteerHourEntryViewResponseSchema,
  },
  "GET /internal/discipline-plans/relevant-elements": {
    summary:
      "System-principal seam — discipline goals/interventions for a patient's plans (§4.1 #25)",
    query: M15RelevantElementsQuerySchema,
    response: M15RelevantElementsPageResponseSchema,
  },
  "GET /internal/discipline-plans/msw-risk-factors": {
    summary:
      "System-principal seam — MSW psychosocial risk factors for an admission (M16; §4.1 #26)",
    query: M15RiskFactorQuerySchema,
    // summary-only: the service returns `CursorPage<unknown>` — the MSW risk-factor row shape is not yet a
    // frozen view (it materializes from M16's ingestion), so there is nothing to mirror without fabrication.
  },
  "GET /internal/discipline-plans/volunteer-effective-status": {
    summary:
      "System-principal seam — a volunteer's effective 418.78 status; fail-CLOSED (an unreadable gate store answers not-active; §4.1 #27)",
    query: M15VolunteerStatusQuerySchema,
    response: M15VolunteerEffectiveStatusViewResponseSchema,
  },
  "GET /internal/discipline-plans/supervisory-cadence": {
    summary:
      "System-principal seam — the supervisory-cadence worklist for a scope (M17/M14; §4.1 #28)",
    query: M15SupervisoryCadenceQuerySchema,
    response: M15SupervisoryCadencePageResponseSchema,
  },
});

// M16 Bereavement — enrichment block for ALL 33 §4.1 routes (later Object.assign wins over the existing
// M16 entries, so every route is re-listed here with its request contract AND its typed 2xx response). The
// two previously-omitted reads (GET /plans/:planId, GET /plans/:planId/closure) are now covered → deficit 0.
Object.assign(ROUTE_ENRICHMENTS, {
  // ── plans.routes.ts ──
  "GET /api/v1/bereavement/plans": {
    summary:
      "Bereavement plan worklist — cursor-paginated; the counselor's own caseload by default, widened by the filters for an oversight role (§4.1 #1)",
    query: M16PlanListQuerySchema,
    response: M16PlanPageResponse,
  },
  "GET /api/v1/bereavement/plans/:planId": {
    summary:
      "Bereavement plan detail — the header with its rolled-up roster + risk; an off-caseload plan 404s (never 403) so the response can't reveal a patient died (§4.1 #2)",
    response: M16PlanDetailResponse,
  },
  "POST /api/v1/bereavement/plans/:planId/assign-counselor": {
    summary: "Assign the bereavement counselor — eligible → initiating (§4.1 #3)",
    body: M16AssignCounselorBody,
    response: M16PlanDetailResponse,
  },
  "POST /api/v1/bereavement/plans/:planId/assign-volunteer": {
    summary:
      "Assign a bereavement volunteer — the 42 CFR §418.78 gates resolve through Module 15's compliance seam, never the body (§4.1 #4)",
    body: M16AssignVolunteerBody,
    response: M16PlanDetailResponse,
  },
  "POST /api/v1/bereavement/plans/:planId/seed-roster-and-schedule": {
    summary:
      "Seed the survivor roster from M5 and materialize the D4 platform-floor schedule — initiating → active (§4.1 #5)",
    body: M16SeedRosterAndScheduleBody,
    response: M16PlanActivationResponse,
  },
  "POST /api/v1/bereavement/plans/:planId/pause": {
    summary:
      "Pause the plan — cancels every future-dated touchpoint; a recorded reason is mandatory, because a pause without one is a lapse (§4.1 #6)",
    body: M16PausePlanBody,
    response: M16PlanDetailResponse,
  },
  "POST /api/v1/bereavement/plans/:planId/resume": {
    summary:
      "Resume the plan — regenerates the schedule FROM NOW; a touchpoint whose due date passed during the pause is not resurrected as a backdated obligation (§4.1 #7)",
    body: M16ResumePlanBody,
    response: M16PlanDetailResponse,
  },
  "POST /api/v1/bereavement/plans/:planId/close-early": {
    summary:
      "D7 early close — step-up; ≥40-char narrative; lands the closure row awaiting the supervisor cosign (§4.1 #8)",
    body: M16CloseEarlyBody,
    response: M16ClosureResponse,
  },
  "POST /api/v1/bereavement/plans/:planId/cosign-close": {
    summary:
      "The clinical-supervisor cosign that ratifies an early close — step-up; the cosigner is the server-assembled acting membership (§4.1 #9)",
    body: M16CosignCloseBody,
    response: M16ClosureResponse,
  },
  "GET /api/v1/bereavement/plans/:planId/closure": {
    summary:
      "The §3.3.7 closure record — the §7.15 survey-reconstruction rollup; a closed plan is outside the window, so oversight or the plan's own counselor reads it (§4.1 #10)",
    response: M16ClosureResponse,
  },
  "GET /api/v1/bereavement/plans/:planId/outreach": {
    summary: "The plan's touchpoints, scheduled and historical, cursor-paginated (§4.1 #19)",
    query: M16OutreachListQuerySchema,
    response: M16OutreachPageResponse,
  },
  "POST /api/v1/bereavement/plans/:planId/regenerate-schedule": {
    summary:
      "Regenerate the FORWARD outreach book — whole plan or one survivor; never writes a backdated obligation (§4.1 #27)",
    body: M16RegenerateScheduleBody,
    response: M16ScheduleRegenResponse,
  },
  "POST /api/v1/bereavement/plans/:planId/recompute-risk": {
    summary:
      "Recompute the deterministic D3/D17 risk score (Layer 2 narrative only when the platform's full-AI capability is on) — ALWAYS an append; the ledger refuses UPDATE (§4.1 #28)",
    body: M16RecomputeRiskBody,
    response: M16RiskScoreResponse,
  },
  "GET /api/v1/bereavement/plans/:planId/risk-scores": {
    summary:
      "The append-only risk-score ledger — per-survivor and plan-level, newest first (§4.1 #29)",
    query: M16RiskScoreListQuerySchema,
    response: M16RiskScorePageResponse,
  },
  "POST /api/v1/bereavement/plans/:planId/initiate-contact": {
    summary:
      "The counselor's FIRST contact — D18-gated: an external-source plan awaiting its medical-director cosign is refused with the machine-readable gate reason, not a bare 403 (§4.1 #33)",
    body: M16InitiateContactBody,
    response: M16OutreachRowResponse,
  },

  // ── contacts.routes.ts ──
  "POST /api/v1/bereavement/plans/:planId/contacts": {
    summary: "Add a bereaved contact to an open plan — lands `proposed` (§4.1 #11)",
    body: M16CreateContactBody,
    response: M16ContactRowResponse,
  },
  "PATCH /api/v1/bereavement/contacts/:contactId": {
    summary:
      "Update a survivor's preferences / channels — `If-Match` required, because a blind overwrite could send a condolence letter to an address the family already corrected (§4.1 #12)",
    body: M16UpdateContactBody,
    response: M16ContactRowResponse,
  },
  "POST /api/v1/bereavement/contacts/:contactId/confirm": {
    summary:
      "Confirm a survivor — proposed → active; the M39 consent verdict is resolved server-side and fails CLOSED (§4.1 #13)",
    body: M16ConfirmContactBody,
    response: M16ContactRowResponse,
  },
  "POST /api/v1/bereavement/contacts/:contactId/opt-out": {
    summary:
      "Record a per-survivor opt-out (D9) — staff, or the survivor's own portal session; `m39_revocation_cascade` is never accepted from the wire (§4.1 #14)",
    body: M16OptOutBody,
    response: M16ContactRowResponse,
  },
  "POST /api/v1/bereavement/contacts/:contactId/rescind-opt-out": {
    summary:
      "Undo an opt-out — the D9 90-day window binds the self-service path; a counselor rescind must say why (§4.1 #15)",
    body: M16RescindOptOutBody,
    response: M16ContactRowResponse,
  },
  "POST /api/v1/bereavement/contacts/:contactId/mark-deceased": {
    summary:
      "Mark the survivor deceased — the lifecycle's only terminal state, so the verified date and its source are both required (§4.1 #16)",
    body: M16MarkDeceasedBody,
    response: M16ContactRowResponse,
  },
  "POST /api/v1/bereavement/contacts/:contactId/mark-unreachable": {
    summary:
      "Accept the nightly three-strikes proposal — the threshold is enforced by the lifecycle machine, so an early call is refused (§4.1 #17)",
    body: M16MarkUnreachableBody,
    response: M16ContactRowResponse,
  },
  "POST /api/v1/bereavement/contacts/:contactId/flag-complicated-grief": {
    summary:
      "§7.7 complicated-grief escalation — ends the program for this survivor and routes them to the named M40 resource, which is REQUIRED (§4.1 #18)",
    body: M16FlagComplicatedGriefBody,
    response: M16ContactRowResponse,
  },
  "POST /api/v1/bereavement/contacts/:contactId/log-direct": {
    summary:
      "Log an ad-hoc contact with no scheduled outreach — the kind must be one the survivor allows, stricter than the schedule generator (§4.1 #26)",
    body: M16LogDirectContactBody,
    response: M16ContactLogResponse,
  },
  "POST /api/v1/bereavement/contacts/:contactId/refer-external": {
    summary:
      "Log an M40 external-resource referral WITHOUT ending the program — a different clinical fact from the §7.7 escalation (§4.1 #32)",
    body: M16ReferExternalBody,
    response: M16ContactLogResponse,
  },

  // ── outreach.routes.ts ──
  "POST /api/v1/bereavement/outreach/:outreachId/start": {
    summary: "Start a touchpoint — scheduled → in_progress (§4.1 #20)",
    body: M16StartOutreachBody,
    response: M16OutreachRowResponse,
  },
  "POST /api/v1/bereavement/outreach/:outreachId/complete": {
    summary:
      "Complete a touchpoint, writing its contact log in the SAME transaction. D15: the in-person branch REQUIRES the M8 encounter and every other kind must NOT carry one (§4.1 #21)",
    body: M16CompleteOutreachBody,
    response: M16OutreachRowResponse,
  },
  "POST /api/v1/bereavement/outreach/:outreachId/decline": {
    summary:
      "The survivor declined THIS touchpoint — not an opt-out: the forward schedule continues untouched (§4.1 #22)",
    body: M16OutreachOutcomeBody,
    response: M16OutreachRowResponse,
  },
  "POST /api/v1/bereavement/outreach/:outreachId/no-response": {
    summary: "No response after retries — feeds the three-strikes unreachable proposal (§4.1 #23)",
    body: M16OutreachOutcomeBody,
    response: M16OutreachRowResponse,
  },
  "POST /api/v1/bereavement/outreach/:outreachId/cancel": {
    summary: "Cancel a scheduled touchpoint — a reason is mandatory (§4.1 #24)",
    body: M16CancelOutreachBody,
    response: M16OutreachRowResponse,
  },
  "POST /api/v1/bereavement/outreach/:outreachId/late-attempt": {
    summary:
      "Re-open a missed touchpoint inside the 7-day late grace — audit-flagged, but NOT a compliance failure (§4.1 #25)",
    body: M16LateAttemptBody,
    response: M16OutreachRowResponse,
  },

  // ── dashboard.routes.ts ──
  "GET /api/v1/bereavement/dashboard/counselor": {
    summary:
      "The caller's OWN bereavement caseload plus what is due in N days — the counselor id comes from the session, never a query param (§4.1 #30)",
    query: M16CounselorDashboardQuerySchema,
    response: M16CounselorDashboardResponse,
  },
  "GET /api/v1/bereavement/dashboard/supervisor": {
    summary:
      "Full-tenant bereavement rollups, optionally narrowed to one CCN / location — COUNTS, never rates (§4.1 #31)",
    query: M16SupervisorDashboardQuerySchema,
    response: M16SupervisorDashboardResponse,
  },
});

// M19 On-Call Triage — full §4.1 route enrichment (all 38 routes), now carrying the §4.2 response DTOs.
// Placed AFTER the existing M19 Object.assign so the later assignment wins per key; every route is
// re-declared with its response so the deficit reaches 0 and `client:gen` stops typing bodies `never`.
Object.assign(ROUTE_ENRICHMENTS, {
  // ── triage-call lifecycle (§4.1 rows 1-14 + §2.7 paper re-entry) ──
  "POST /api/v1/triage-calls": {
    summary:
      "Open a triage call — `source` is pinned to `manual` and the covering shift is resolved server-side, because attributing a call to somebody else's coverage window would forge the CoP 418.100(c)(2) record (§4.1 #1)",
    body: M19OpenTriageCallBody,
    response: M19OpenTriageCallResultResponse,
  },
  "GET /api/v1/triage-calls": {
    summary:
      "The supervisor board / caseload list — cursor-paginated (offset is refused); `openOnly` is the six-state live set, which deliberately includes `documented_pending_encounter` (§4.1 #2)",
    query: M19ListTriageCallsQuery,
    response: M19TriageCallListPageResponse,
  },
  "GET /api/v1/triage-calls/:triageCallId": {
    summary:
      "The full call — the STAFF projection or the PHI-minimized VENDOR one depending on the session class (a different TYPE, not a filtered one) (§4.1 #3)",
    response: M19TriageCallResponse,
  },
  "POST /api/v1/triage-calls/:triageCallId/identify-patient": {
    summary:
      "Resolve the caller to a served person — patient AND admission together, because M8's encounter creator requires both NOT NULL (§4.1 #4)",
    body: M19IdentifyPatientBody,
    response: M19TriageCallResponse,
  },
  "POST /api/v1/triage-calls/:triageCallId/apply-protocol": {
    summary:
      "Pin the protocol (D4) and, when the catalog row demands it, write the D7 mandatory escalation in the SAME transaction; `aiOverrideReason` is required only above the §8.6 confidence floor (§4.1 #5)",
    body: M19ApplyProtocolBody,
    response: M19TriageCallResponse,
  },
  "POST /api/v1/triage-calls/:triageCallId/answers": {
    summary:
      "Append one answer — a DISCRIMINATED value union, so 'exactly one typed value' is a 422 at the boundary rather than a CHECK violation from the driver; `red_flag_hit` is absent because D5 makes it the server's (§4.1 #6)",
    body: M19RecordAnswerBody,
    response: M19AnswerWriteResultResponse,
  },
  "PATCH /api/v1/triage-calls/:triageCallId/answers/:answerId/correct": {
    summary:
      "Append a CORRECTION (§2.2.3 amend-by-append) — the original row is preserved, because a 'no' later corrected to 'yes' means the call HAD a red flag (§4.1 #7)",
    body: M19CorrectAnswerBody,
    response: M19AnswerWriteResultResponse,
  },
  "POST /api/v1/triage-calls/:triageCallId/complete-protocol": {
    summary:
      "Close the protocol walk — the machine's two §2.3 gates run: every required question answered, and no red-flag escalation still open (§4.1 #8)",
    response: M19TriageCallResponse,
  },
  "POST /api/v1/triage-calls/:triageCallId/awaiting-callback": {
    summary:
      "Park the call on a callback; it stays in the open set so it keeps its place on the supervisor board while the SLA detector watches the clock (§4.1 #9)",
    body: M19AwaitingCallbackBody,
    response: M19TriageCallResponse,
  },
  "POST /api/v1/triage-calls/:triageCallId/resume": {
    summary:
      "Resume the same walk at the server's own cursor — no answer is discarded and none is re-asked (§4.1 #10)",
    response: M19TriageCallResponse,
  },
  "POST /api/v1/triage-calls/:triageCallId/disposition": {
    summary:
      "Select the disposition (D6) over the PUBLISHED `TriageDispositionData` union — one route for both §2.2.1 edges into `documented_pending_encounter` (§4.1 #11)",
    body: M19SelectDispositionBody,
    response: M19TriageCallResponse,
  },
  "POST /api/v1/triage-calls/:triageCallId/document": {
    summary:
      "Invoke M8's `EncounterCreator` (D8). The call does NOT reach `documented` here — that transition belongs to the `m8.encounter.signed` consumer (§4.1 #12)",
    body: M19DocumentCallBody,
    response: M19TriageCallResponse,
  },
  "POST /api/v1/triage-calls/:triageCallId/abandon": {
    summary:
      "The caller disconnected. A mandatory escalation still blocks: 'the caller hung up' is not an answer to 'did a human respond to the suicidal-ideation page?' (§4.1 #13)",
    body: M19AbandonCallBody,
    response: M19TriageCallResponse,
  },
  "GET /api/v1/triage-calls/:triageCallId/transcript-decrypt": {
    summary:
      "Decrypt the transcript — distinct permission + M2 step-up + a per-access M4 audit row; the plaintext never rides the detail DTO (§8.7.2 / §4.1 #14)",
    response: M19TriageTranscriptResponse,
  },
  "POST /api/v1/triage-calls/paper-reentry": {
    summary:
      "§2.7 BCP paper-origin re-entry — its own permission plus a step-up, because the back-dated `opened_at` is §8.3.2's way a coverage gap gets hidden; the instant is range-checked against the worklist row's outage window",
    body: M19PaperReentryBody,
    response: M19OpenTriageCallResultResponse,
  },
  "GET /api/v1/triage-calls/paper-reentry/worklist": {
    summary:
      "The DON's outstanding paper-re-entry worklist — outage-window scheduling metadata only (no patient, no caller, no clinical content) (§2.7)",
    response: M19PaperReentryWorklistResponse,
  },
  // ── escalations (§4.1 rows 15-18) ──
  "POST /api/v1/triage-calls/:triageCallId/escalations": {
    summary:
      "Raise an escalation on a call — gated by the CALL's predicate, not the escalation ones, because the actor raising the page is the clinician working the call (§4.1 #15)",
    body: M19EscalateBody,
    response: M19EscalationInboxItemResponse,
  },
  "GET /api/v1/escalations": {
    summary:
      "The escalation inbox, narrowed server-side to the actor's tier band; `openOnly` defaults TRUE because an inbox shows what is outstanding (§4.1 #16)",
    query: M19ListEscalationsQuery,
    response: M19EscalationInboxPageResponse,
  },
  "POST /api/v1/escalations/:escalationId/acknowledge": {
    summary:
      "Acknowledge — the write §7.2 waits on; until it lands the call may take no disposition but the hand-off (§4.1 #17)",
    body: M19AcknowledgeEscalationBody,
    response: M19EscalationInboxItemResponse,
  },
  "POST /api/v1/escalations/:escalationId/resolve": {
    summary:
      "Resolve with the escalated party's own account (≥ 30 chars) — the ONLY place a MANDATORY row can reach `resolved` (§2.2.4 / §4.1 #18)",
    body: M19ResolveEscalationBody,
    response: M19EscalationInboxItemResponse,
  },
  // ── shifts + policy (§4.1 rows 19-26) ──
  "GET /api/v1/oncall/shifts": {
    summary: "The on-call schedule, cursor-paginated (§4.1 #19)",
    query: M19ListShiftsQuery,
    response: M19OnCallShiftPageResponse,
  },
  "POST /api/v1/oncall/shifts": {
    summary:
      "Manual shift create — `policySnapshot` is NOT a body field: D7 pins it from the tenant policy at activation, and a caller-supplied snapshot would be a caller-supplied answer to 'which ladder was in effect that night' (§4.1 #20)",
    body: M19CreateShiftBody,
    response: M19OnCallShiftViewResponse,
  },
  "PATCH /api/v1/oncall/shifts/:shiftId/cancel": {
    summary:
      "Cancel with a reason. No outbox event: a shift that never activated was never in M36's `on_call` channel, so the hole it leaves is the coverage-gap watchdog's finding (§4.1 #21)",
    body: M19CancelShiftBody,
    response: M19OnCallShiftViewResponse,
  },
  "POST /api/v1/oncall/shifts/:shiftId/open": {
    summary:
      "Manual 'go on shift' — pins the D7 policy snapshot and emits the single canonical shift-open topic M36's synchronizer and M20's SOS path both subscribe to (§4.1 #22)",
    body: M19ShiftTransitionBody,
    response: M19OnCallShiftViewResponse,
  },
  "POST /api/v1/oncall/shifts/:shiftId/close": {
    summary:
      "Manual close — removes the departing actor from M36's channel; messages sent during their tenure stay attributed to them (§4.1 #23)",
    body: M19ShiftTransitionBody,
    response: M19OnCallShiftViewResponse,
  },
  "GET /api/v1/oncall/current": {
    summary:
      "Who is on call NOW, keyed PER ProviderEntity and never unioned — CoP 418.100(c)(2) is per-CCN, and `actors: []` for an entity is a REAL answer (a coverage gap), not an empty result (§4.1 #24)",
    query: M19CurrentOnCallQuery,
    response: M19CurrentOnCallResponse,
  },
  "GET /api/v1/oncall/policy": {
    summary:
      "The tenant on-call policy for one ProviderEntity. NOT auto-created on read: a default invented at read time would be pinned onto shifts as though the tenant had chosen it (§4.1 #25)",
    query: M19PolicyQuery,
    response: M19OncallPolicyResponse,
  },
  "PATCH /api/v1/oncall/policy": {
    summary:
      "Edit the policy (step-up) — a `hybrid`/`centralized` selection where the D3 flag is off is REFUSED rather than accepted-and-ignored, so a tenant can never believe a vendor is answering their nights (§4.1 #26)",
    body: M19PatchOncallPolicyBody,
    query: M19PolicyQuery,
    response: M19OncallPolicyResponse,
  },
  // ── protocol catalog (§4.1 rows 27-32) ──
  "GET /api/v1/triage-protocols": {
    summary:
      "The catalog — the org-less platform floor plus this tenant's own rows (D4), effective-dated by default (§4.1 #27)",
    query: M19ListProtocolsQuery,
    response: M19TriageProtocolPageResponse,
  },
  "GET /api/v1/triage-protocols/:protocolId": {
    summary:
      "One protocol with its ordered questions — what the §5 stepper renders from (§4.1 #28)",
    response: M19TriageProtocolViewResponse,
  },
  "POST /api/v1/triage-protocols": {
    summary:
      "Author a TENANT-CUSTOM protocol (step-up). `isSystemLocked` is absent: accepting and ignoring it would leave the DON believing they had authored a protected question (§4.1 #29)",
    body: M19CreateProtocolBody,
    response: M19TriageProtocolViewResponse,
  },
  "PATCH /api/v1/triage-protocols/:protocolId": {
    summary:
      "Edit a tenant protocol — a platform-floor row is refused with its key NAMED, because '0 rows updated' is not an answer a DON can act on (§4.1 #30)",
    body: M19PatchProtocolBody,
    response: M19TriageProtocolViewResponse,
  },
  "POST /api/v1/triage-protocols/:protocolId/questions": {
    summary:
      "Add a question — a tenant cannot write a child row against an org-less parent, so the attempt is refused with the protocol named rather than failing as a policy violation (§4.1 #31)",
    body: M19ProtocolQuestionBody,
    response: M19TriageProtocolViewResponse,
  },
  "PATCH /api/v1/triage-protocol-questions/:questionId": {
    summary:
      "Edit one question — a system-locked question is refused: it is the D5 red-flag predicate behind a platform-floor mandatory escalation, and editing it is the cheapest way to disable one (§4.1 #32)",
    body: M19PatchProtocolQuestionBody,
    response: M19TriageProtocolViewResponse,
  },
  // ── external vendor bindings (§4.1 rows 33-35) ──
  "GET /api/v1/oncall/external-vendors": {
    summary:
      "The tenant's vendor bindings, each with whether its §8.5 adapter is actually loaded — NO secret is projected (ADR-0026) (§4.1 #33)",
    response: M19VendorBindingListResponse,
  },
  "POST /api/v1/oncall/external-vendors": {
    summary:
      "Create a vendor binding (step-up). The BAA is a PRECONDITION, and there is deliberately NO secret field — ADR-0026 puts vendor credentials in the platform secret store, and the absence of the field is the control (§4.1 #34)",
    body: M19CreateVendorBindingBody,
    response: M19VendorBindingViewResponse,
  },
  "PATCH /api/v1/oncall/external-vendors/:vendorId": {
    summary:
      "BAA renewal updates only — the narrow request shape IS the rule: changing the adapter key or the minimization profile would silently re-point live PHI at a different contract (§4.1 #35)",
    body: M19PatchVendorBindingBody,
    response: M19VendorBindingViewResponse,
  },
  // ── portal projection (§4.1 row 36) ──
  "GET /api/v1/portal/triage/recent": {
    summary:
      "The M31 portal projection — lay-language, caregiver-scoped, with the D11 advisory and the D13 vendor-handoff details excluded BY CONSTRUCTION rather than by filtering (§4.1 #36)",
    query: M19PortalRecentQuery,
    response: M19PortalRecentPageResponse,
  },
});

// ── M20 Field Safety (30 routes: check-ins · SOS spine · incidents + D9 sign-off · policy/subscriptions/
// high-risk-areas · dashboard + consent). Every route carries a typed response; the SOS press fans out
// on a minimal body (coordinates OPTIONAL, M20-F16) and still returns its parsed RaiseSosResponse. ──
Object.assign(ROUTE_ENRICHMENTS, {
  // check-ins.routes.ts (rows 1-4)
  "POST /api/v1/safety/check-ins": {
    summary: "Record a safety check-in (attestation; no If-Match, idempotency-keyed)",
    body: M20RecordCheckInBody,
    response: M20RecordCheckInResponse,
  },
  "GET /api/v1/safety/check-ins/:checkInId": {
    summary: "Read one check-in (self ∨ supervisor; 404 on deny)",
    response: M20SafetyCheckInResponse,
  },
  "PATCH /api/v1/safety/check-ins/:checkInId": {
    summary: "Amend within the 5-minute grace (supersedes, never mutates)",
    body: M20AmendCheckInBody,
    response: M20SafetyCheckInResponse,
  },
  "GET /api/v1/safety/check-ins/me/today": {
    summary: "The clinician's own day: obligations + posted check-ins",
    query: M20CheckInListQuery,
    response: M20SafetyMyDayResponse,
  },

  // sos.routes.ts (rows 5-11)
  "POST /api/v1/safety/sos": {
    summary: "The SOS press (no idempotency key; coordinates optional, M20-F16)",
    body: M20RaiseSosBody,
    response: M20RaiseSosResponse,
  },
  "POST /api/v1/safety/sos/:sosAlertId/cancel": {
    summary: "D5 cancel (a rejected cancel is a 200, never a 4xx)",
    body: M20CancelSosBody,
    response: M20CancelSosResponse,
  },
  "POST /api/v1/safety/sos/:sosAlertId/acknowledge": {
    summary: "A responder acknowledges (ack row on the same tx)",
    body: M20AcknowledgeSosBody,
    response: M20SafetySosAlertResponse,
  },
  "POST /api/v1/safety/sos/:sosAlertId/resolve": {
    summary: "Resolve, or convert into an incident (dispatches on the flag)",
    body: M20ResolveSosBody,
    response: M20SafetySosAlertResponse,
  },
  "GET /api/v1/safety/sos/active": {
    summary: "The active-SOS board tile (registered before :sosAlertId)",
    response: M20ActiveSosResponse,
  },
  "GET /api/v1/safety/sos/:sosAlertId": {
    summary: "Alert detail with §2.2.2 ledger + §2.2.6 acknowledgments",
    response: M20SafetySosAlertResponse,
  },
  "GET /api/v1/safety/sos/:sosAlertId/location-stream": {
    summary: "The D6 coordinate stream (own permission + warn-audit; ≥40-char reason once closed)",
    query: M20LocationStreamQuery,
    response: M20SosLocationStreamResponse,
  },

  // incidents.routes.ts (rows 12-17)
  "POST /api/v1/safety/incidents": {
    summary:
      "Open a draft incident (affectedClinicianMembershipId is the one caller-named membership)",
    body: M20CreateIncidentBody,
    response: M20SafetyIncidentResponse,
  },
  "GET /api/v1/safety/incidents": {
    summary: "The review queue (narrowed to own incidents without oversight)",
    query: M20IncidentListQuery,
    response: M20SafetyIncidentPageResponse,
  },
  "GET /api/v1/safety/incidents/:incidentId": {
    summary: "One incident (narrative is a cipher until a decipher is bound)",
    response: M20SafetyIncidentResponse,
  },
  "PATCH /api/v1/safety/incidents/:incidentId": {
    summary: "Edit a draft (the draft qualifier runs in the transaction)",
    body: M20PatchIncidentBody,
    response: M20SafetyIncidentResponse,
  },
  "POST /api/v1/safety/incidents/:incidentId/submit": {
    summary: "Submit for review (oshaReportable:true needs the signed-off pair)",
    body: M20SubmitIncidentBody,
    response: M20SafetyIncidentResponse,
  },
  "POST /api/v1/safety/incidents/:incidentId/state": {
    summary: "The supervisor state machine (§2.2.3; reopened re-enters review)",
    body: M20TransitionIncidentBody,
    response: M20SafetyIncidentResponse,
  },
  "POST /api/v1/safety/incidents/:incidentId/osha-signoff": {
    summary: "D9 OSHA-equivalent sign-off (step-up; state code + reporting-window clock)",
    body: M20OshaSignoffBody,
    response: M20SafetyIncidentResponse,
  },

  // admin.routes.ts (rows 18-25)
  "GET /api/v1/safety/policy": {
    summary: "The effective policy (asOf is the §2.2.4 replay arm)",
    query: M20PolicyQuery,
    response: M20SafetyPolicyEffectiveResponse,
  },
  "PATCH /api/v1/safety/policy": {
    summary: "Edit the policy (step-up; editReason ≥30; a NEW version row)",
    body: M20PatchPolicyBody,
    response: M20SafetyPolicyEffectiveResponse,
  },
  "GET /api/v1/safety/supervisor-subscriptions": {
    summary: "Who watches whom (§2.2.5 / D8)",
    query: M20SubscriptionListQuery,
    response: M20SafetySubscriptionPageResponse,
  },
  "POST /api/v1/safety/supervisor-subscriptions": {
    summary: "Add a subscription (scope-selector pairing re-checked in service)",
    body: M20CreateSubscriptionBody,
    response: M20SafetySubscriptionResponse,
  },
  "DELETE /api/v1/safety/supervisor-subscriptions/:subscriptionId": {
    summary: "Deactivate (always succeeds; reports coverageGapsCreated)",
    response: M20DeleteSubscriptionResponse,
  },
  "GET /api/v1/safety/high-risk-areas": {
    summary: "The advisory polygons in force (includeExpired defaults false)",
    query: M20HighRiskAreaListQuery,
    response: M20SafetyHighRiskAreaPageResponse,
  },
  "POST /api/v1/safety/high-risk-areas": {
    summary: "Draw an advisory polygon (M20-F07: ring validity in app code, no PostGIS)",
    body: M20CreateHighRiskAreaBody,
    response: M20SafetyHighRiskAreaResponse,
  },
  "PATCH /api/v1/safety/high-risk-areas/:areaId": {
    summary: "Edit or retire an area (retire is effectiveTo, never a delete)",
    body: M20PatchHighRiskAreaBody,
    response: M20SafetyHighRiskAreaResponse,
  },

  // dashboard.routes.ts (rows 26-29)
  "GET /api/v1/safety/dashboard": {
    summary: "The supervisor live-awareness board (no coordinate; own row without oversight)",
    query: M20DashboardQuery,
    response: M20SafetyDashboardResponse,
  },
  "GET /api/v1/safety/consent": {
    summary: "The clinician's own consent surface (membership from the session)",
    query: M20ConsentQuery,
    response: M20SafetyConsentSurfaceResponse,
  },
  "POST /api/v1/safety/consent/grant": {
    summary: "Grant one consent purpose (three are separately grantable, M20-F16)",
    body: M20GrantConsentBody,
    response: M20SafetyConsentResponse,
  },
  "POST /api/v1/safety/consent/revoke": {
    summary: "Revoke one purpose (writes revoked, never expired)",
    body: M20RevokeConsentBody,
    response: M20SafetyConsentResponse,
  },
});

// ── M21 Supplies, DME & Comfort Kits (37 routes) ────────────────────────────────────────────────────
Object.assign(ROUTE_ENRICHMENTS, {
  // supply-requests.routes.ts — §4.1 rows 1–10 (the §2.2 fulfillment machine)
  "POST /api/v1/supplies/supply-requests": {
    summary: "Create a supply / DME / comfort-kit request (freezes the D4 routing record; 201)",
    body: M21CreateSupplyRequestBody,
    response: M21CreateSupplyRequestResultSchema,
  },
  "GET /api/v1/supplies/supply-requests": {
    summary: "Supply-team worklist (cursor-paginated; openOnly default)",
    query: M21ListSupplyRequestsQuery,
    response: M21SupplyRequestListResponseSchema,
  },
  "GET /api/v1/supplies/supply-requests/:supplyRequestId": {
    summary: "Request detail (D13 delivery text + frozen D4 routing record)",
    response: M21SupplyRequestDetailSchema,
  },
  "POST /api/v1/supplies/supply-requests/:supplyRequestId/assign-vendor": {
    summary: "D4 vendor override (recorded on top of the ladder trace; If-Match)",
    body: M21AssignVendorBody,
    response: M21SupplyRequestDetailSchema,
  },
  "POST /api/v1/supplies/supply-requests/:supplyRequestId/mark-ordered": {
    summary: "Vendor accepted (PO reference; If-Match)",
    body: M21MarkOrderedBody,
    response: M21SupplyRequestDetailSchema,
  },
  "POST /api/v1/supplies/supply-requests/:supplyRequestId/mark-in-transit": {
    summary: "Record shipment identifiers (If-Match)",
    body: M21MarkInTransitBody,
    response: M21SupplyRequestDetailSchema,
  },
  "POST /api/v1/supplies/supply-requests/:supplyRequestId/mark-delivered": {
    summary: "D7 courier attestation (deliveredBy stamped from session; If-Match)",
    body: M21MarkDeliveredBody,
    response: M21SupplyRequestDetailSchema,
  },
  "POST /api/v1/supplies/supply-requests/:supplyRequestId/confirm-received": {
    summary: "Caregiver/clinician confirms receipt (If-Match)",
    body: M21ConfirmReceivedBody,
    response: M21SupplyRequestDetailSchema,
  },
  "POST /api/v1/supplies/supply-requests/:supplyRequestId/cancel": {
    summary: "Cancel (service picks the immediate vs two-phase edge; If-Match)",
    body: M21CancelRequestBody,
    response: M21SupplyRequestDetailSchema,
  },
  "POST /api/v1/supplies/supply-requests/:supplyRequestId/return": {
    summary: "Initiate an equipment return (the DME pickup path; If-Match)",
    body: M21ReturnRequestBody,
    response: M21SupplyRequestDetailSchema,
  },

  // catalog.routes.ts — §4.1 rows 11–19 (D11 SKU catalog + §2.3 kit templates)
  "GET /api/v1/supplies/supply-items": {
    summary: "SKU catalog (platform rows UNION the tenant overlay)",
    query: M21ListSupplyItemsQuery,
    response: M21SupplyItemListResponseSchema,
  },
  "POST /api/v1/supplies/supply-items": {
    summary: "Create a canonical HCPCS-keyed SKU (PLATFORM-ONLY; 201)",
    body: M21CreateSupplyItemBody,
    response: M21SupplyItemViewSchema,
  },
  "GET /api/v1/supplies/supply-items/:id": {
    summary: "One SKU (platform or overlay; disjoint id space)",
    response: M21SupplyItemViewSchema,
  },
  "POST /api/v1/supplies/supply-items/:id/retire": {
    summary: "Retire a canonical SKU (effective-dating, PLATFORM-ONLY)",
    body: M21RetireSupplyItemBody,
    response: M21SupplyItemViewSchema,
  },
  "POST /api/v1/supplies/tenant-supply-items": {
    summary: "Create a tenant-local non-billable item (D11 overlay; 201)",
    body: M21UpsertTenantSupplyItemBody,
    response: M21SupplyItemViewSchema,
  },
  "PUT /api/v1/supplies/tenant-supply-items/:id": {
    summary: "Edit a tenant-local item",
    body: M21UpsertTenantSupplyItemBody,
    response: M21SupplyItemViewSchema,
  },
  "GET /api/v1/supplies/comfort-kit-templates": {
    summary: "Comfort-kit templates (D3 floor row included by default)",
    query: M21ListTemplatesQuery,
    response: M21ComfortKitTemplateListResponseSchema,
  },
  "POST /api/v1/supplies/comfort-kit-templates": {
    summary: "Author a tenant template (D3 four-medication floor validated first; 201)",
    body: M21CreateTemplateBody,
    response: M21ComfortKitTemplateViewSchema,
  },
  "PUT /api/v1/supplies/comfort-kit-templates/:templateId": {
    summary: "Supersede a template (INSERTS a new row via replaces_template_id)",
    body: M21SupersedeTemplateBody,
    response: M21ComfortKitTemplateViewSchema,
  },

  // comfort-kits.routes.ts — §4.1 rows 20–27 + the DEA §1304 perpetual log / retriever / unreturnable edges
  "POST /api/v1/supplies/comfort-kit-dispatches": {
    summary: "Dispatch a comfort kit (§2.5 five refusals + DEA outbound log, one tx; step-up; 201)",
    body: M21CreateDispatchBody,
    response: M21DispatchDetailSchema,
  },
  "GET /api/v1/supplies/comfort-kit-dispatches": {
    summary: "Dispatch list (per patient / Location / IPU room)",
    query: M21ListDispatchesQuery,
    response: M21DispatchListResponseSchema,
  },
  "GET /api/v1/supplies/comfort-kit-dispatches/:dispatchId": {
    summary: "Dispatch detail with the full per-line DEA 1304 manifest",
    response: M21DispatchDetailSchema,
  },
  "POST /api/v1/supplies/comfort-kit-dispatches/:dispatchId/deploy-at-patient": {
    summary: "Mark the kit physically at the patient (event M13 builds deployments from; If-Match)",
    body: M21DeployAtPatientBody,
    response: M21DispatchDetailSchema,
  },
  "GET /api/v1/supplies/comfort-kit-dispatches/:dispatchId/perpetual-log": {
    summary: "§8.1 DEA 21 CFR §1304 perpetual log for one kit",
    response: M21PerpetualLogViewSchema,
  },
  "POST /api/v1/supplies/comfort-kit-returns": {
    summary: "Open a return obligation (refused before M13 acks the deployment; 201)",
    body: M21CreateReturnBody,
    response: M21ComfortKitReturnDetailSchema,
  },
  "GET /api/v1/supplies/comfort-kit-returns": {
    summary: "Reconciliation worklist (oldest due first; daysOverdue read-time)",
    query: M21ListReturnsQuery,
    response: M21ComfortKitReturnListResponseSchema,
  },
  "GET /api/v1/supplies/comfort-kit-returns/:returnId": {
    summary: "Return detail with per-line accounting + disposal record",
    response: M21ComfortKitReturnDetailSchema,
  },
  "POST /api/v1/supplies/comfort-kit-returns/:returnId/assign-retriever": {
    summary: "Assign the supply-team member who will physically retrieve (If-Match)",
    body: M21AssignRetrieverBody,
    response: M21ComfortKitReturnDetailSchema,
  },
  "POST /api/v1/supplies/comfort-kit-returns/:returnId/reconcile": {
    summary:
      "Reconcile (D8 discrepancy COMPUTED, never accepted; SoD predicate + step-up; If-Match)",
    body: M21ReconcileReturnBody,
    response: M21ReconcileReturnResultSchema,
  },
  "POST /api/v1/supplies/comfort-kit-returns/:returnId/declare-unreturnable": {
    summary: "§2.6 90-day assumption of loss (attested reason; step-up; If-Match)",
    body: M21DeclareUnreturnableBody,
    response: M21ComfortKitReturnDetailSchema,
  },

  // operations.routes.ts — §4.1 rows 28–34 (D4 vendor-routing ladder + D5 par-stock shelf)
  "GET /api/v1/supplies/vendor-routing-rules": {
    summary: "The D4 routing ladder (most-specific first; platform floor + overlay)",
    query: M21ListRoutingRulesQuery,
    response: M21VendorRoutingRuleListResponseSchema,
  },
  "POST /api/v1/supplies/vendor-routing-rules": {
    summary: "Author a routing rule (platform scope refused; 201)",
    body: M21UpsertRoutingRuleBody,
    response: M21VendorRoutingRuleViewSchema,
  },
  "PUT /api/v1/supplies/vendor-routing-rules/:ruleId": {
    summary: "Edit a routing rule",
    body: M21UpsertRoutingRuleBody,
    response: M21VendorRoutingRuleViewSchema,
  },
  "DELETE /api/v1/supplies/vendor-routing-rules/:ruleId": {
    summary: "Retire a routing rule (is_active=false; NOT a delete — history must resolve)",
    response: M21VendorRoutingRuleViewSchema,
  },
  "GET /api/v1/supplies/par-stock": {
    summary: "Hub shelf with DERIVED severity band (ok/below_threshold/critical_low/depleted)",
    query: M21ListParStockQuery,
    response: M21ParStockListResponseSchema,
  },
  "PUT /api/v1/supplies/par-stock/:parStockId": {
    summary: "Edit par thresholds (ordering mirrored at boundary; If-Match)",
    body: M21UpdateParStockBody,
    response: M21ParStockViewSchema,
  },
  "POST /api/v1/supplies/par-stock/observe": {
    summary: "Record an on-hand count (SETS the shelf, never adjusts; §2.7 pure rule)",
    body: M21ObserveParStockBody,
    response: M21ParStockViewSchema,
  },
});

// M25 Remittance & Denials — FULL enrichment (all 31 routes). Later Object.assign wins, so this
// supersedes the earlier partial M25 block and drives the module's unenriched deficit to 0.
Object.assign(ROUTE_ENRICHMENTS, {
  // ── remittance.routes.ts (§4.1 routes 1-8) ────────────────────────────────────────────────────
  "GET /api/v1/remittance/advices": {
    summary: "Remittance advices (835 headers, cursor-paginated, §4.12)",
    query: M25ListQuerySchema,
    response: M25RemittanceAdviceSummaryPageSchema,
  },
  "GET /api/v1/remittance/advices/:id": {
    summary: "Remittance advice detail (835 header, §4.1)",
    response: M25RemittanceAdviceSummarySchema,
  },
  "POST /api/v1/remittance/advices/:id/replay": {
    summary: "Queue a remittance advice for re-parse/replay (§4.1)",
    response: M25ReplayQueuedResponseSchema,
  },
  "GET /api/v1/remittance/lines": {
    summary: "Remittance service lines (cursor-paginated, §4.12)",
    query: M25ListQuerySchema,
    response: M25RemittanceLineSummaryPageSchema,
  },
  "GET /api/v1/remittance/lines/:id": {
    summary: "Remittance service line detail (§4.1)",
    response: M25RemittanceLineSummarySchema,
  },
  "GET /api/v1/remittance/unmatched": {
    summary: "Unmatched remittance lines awaiting manual match (cursor-paginated, §4.1)",
    query: M25ListQuerySchema,
    response: M25RemittanceLineSummaryPageSchema,
  },
  "POST /api/v1/remittance/lines/:id/manual-match": {
    summary: "Manually match a remittance line to a claim (§4.1)",
    body: M25ManualMatchRequestSchema,
    response: M25ManualMatchResponseSchema,
  },
  "POST /api/v1/remittance/adjustments/:id/override": {
    summary: "Override an adjustment's taxonomy classification (step-up, §4.1)",
    body: M25AdjustmentOverrideRequestSchema,
    response: M25AdjustmentOverrideResponseSchema,
  },

  // ── denials.routes.ts (§4.1 routes 9-18) ──────────────────────────────────────────────────────
  "GET /api/v1/denials": {
    summary: "Denial worklist (cursor-paginated, §4.12)",
    query: M25ListQuerySchema,
    response: M25DenialWorklistPageSchema,
  },
  "GET /api/v1/denials/:id": {
    summary: "Denial case detail (§4.1)",
    response: M25DenialWorklistItemSchema,
  },
  "PATCH /api/v1/denials/:id/assign": {
    summary: "Assign a denial case to a membership (§4.1)",
    body: M25DenialAssignRequestSchema,
    response: M25VersionedResultSchema,
  },
  "PATCH /api/v1/denials/:id/start": {
    summary: "Start work on a denial case (→ in_progress, §4.1)",
    response: M25VersionedResultSchema,
  },
  "PATCH /api/v1/denials/:id/escalate": {
    summary: "Escalate a denial case (§4.1)",
    body: M25DenialEscalateRequestSchema,
    response: M25VersionedResultSchema,
  },
  "PATCH /api/v1/denials/:id/resolve": {
    summary: "Resolve a denial case (§4.1)",
    body: M25DenialResolveRequestSchema,
    response: M25VersionedResultSchema,
  },
  "POST /api/v1/denials/:id/close": {
    summary: "Close a resolved denial case (§4.1)",
    response: M25VersionedResultSchema,
  },
  "POST /api/v1/denials/:id/close-write-off": {
    summary: "Close a denial case as a write-off (step-up, §4.1)",
    body: M25DenialCloseWriteOffRequestSchema,
    response: M25VersionedResultSchema,
  },
  "POST /api/v1/denials/:id/reopen": {
    summary: "Reopen a closed denial case (§4.1)",
    body: M25DenialReopenRequestSchema,
    response: M25VersionedResultSchema,
  },
  "POST /api/v1/denials/:id/appeals": {
    summary: "Open an appeal against a denial case (§4.1)",
    body: M25AppealCreateRequestSchema,
    response: M25VersionedResultSchema,
  },

  // ── appeals.routes.ts (§4.1 routes 19-26) ─────────────────────────────────────────────────────
  "GET /api/v1/appeals": {
    summary: "Appeal tracker (cursor-paginated, §4.12)",
    query: M25ListQuerySchema,
    response: M25AppealSummaryPageSchema,
  },
  "GET /api/v1/appeals/:id": {
    summary: "Appeal case detail + event timeline (§4.1)",
    response: M25AppealDetailSchema,
  },
  "PATCH /api/v1/appeals/:id/attach": {
    summary: "Attach a supporting M22 document to an appeal (§4.1)",
    body: M25AppealAttachRequestSchema,
    response: M25VersionedResultSchema,
  },
  "POST /api/v1/appeals/:id/submit": {
    summary: "Submit an appeal to the payer (within-deadline + step-up, §4.1)",
    body: M25AppealSubmitRequestSchema,
    response: M25VersionedResultSchema,
  },
  "PATCH /api/v1/appeals/:id/ack": {
    summary: "Record the payer's receipt acknowledgement of an appeal (§4.1)",
    response: M25VersionedResultSchema,
  },
  "POST /api/v1/appeals/:id/decide": {
    summary: "Record the payer's appeal decision (typed outcome, §4.1)",
    body: M25AppealDecideRequestSchema,
    response: M25VersionedResultSchema,
  },
  "POST /api/v1/appeals/:id/withdraw": {
    summary: "Withdraw a submitted appeal (§4.1)",
    body: M25AppealWithdrawRequestSchema,
    response: M25VersionedResultSchema,
  },
  "POST /api/v1/appeals/:id/close": {
    summary: "Close a decided/withdrawn appeal case (§4.1)",
    response: M25VersionedResultSchema,
  },

  // ── taxonomy.routes.ts (§4.1 routes 27-28) ────────────────────────────────────────────────────
  "GET /api/v1/taxonomy/carc/:code": {
    summary: "Merged CARC/RARC taxonomy view — M38 floor + tenant overlay (§4.1)",
    response: M25TaxonomyMergedViewSchema,
  },
  "PATCH /api/v1/taxonomy/overlays/:carc": {
    summary: "Patch the tenant CARC taxonomy overlay (§4.1)",
    body: M25TaxonomyOverlayPatchSchema,
    response: M25VersionedResultSchema,
  },

  // ── internal.routes.ts (§4.1 routes 29-31, §17 system-principal seams) ─────────────────────────
  "GET /api/v1/internal/remittance/reader": {
    summary: "Internal RemittanceReader seam — advice by id (§17 system principal)",
    response: M25RemittanceAdviceReaderResponseSchema,
  },
  "GET /api/v1/internal/denials/metrics": {
    summary: "Internal DenialMetricsProvider seam — aging/open aggregates (§17 system principal)",
    response: M25DenialMetricsViewSchema,
  },
  "GET /api/v1/internal/patient-responsibility": {
    summary: "Internal PatientResponsibilityReader seam — PR ledger rows (§17 system principal)",
    response: M25PrLedgerItemsResponseSchema,
  },
});

// M26 Cap Management (§4.1) — full route coverage. A LATER Object.assign than the base M26 block, so
// these entries WIN: every read that returned a bare §4.1 view interface now publishes its response DTO
// (the 8-route deficit), and every write's response is re-pinned to the service VIEW it actually returns
// (not the contracts.* DTO). Bodies are the §4.2 contract schemas the handlers `parse()`; org/actor
// binding is server-side, so no body carries an org/user id. `close` parses no body (params only). The
// three 204 mutations (acknowledge / amend / resolve) carry a body but no response. Queries are read via
// qStr (no TypeBox query schema exists), so none are published.
Object.assign(ROUTE_ENRICHMENTS, {
  // ── cap periods ──
  "GET /api/v1/cap/periods": {
    summary: "List cap periods for the calling tenant — status + methodology (§4.1)",
    response: M26PeriodViewListResponse,
  },
  "POST /api/v1/cap/periods": {
    summary:
      "Open a new cap period (snapshots the platform constant; emits m26.cap.year_opened; §4.1)",
    body: M26OpenCapPeriodRequest,
    response: M26PeriodViewDto,
  },
  "GET /api/v1/cap/periods/:periodId": {
    summary: "Single cap period including methodology lock + status (§4.1)",
    response: M26PeriodViewDto,
  },
  "PATCH /api/v1/cap/periods/:periodId/close": {
    summary: "Close a cap period — active → in_settlement (cap_period_open ABAC; M26-F06; §4.1)",
    response: M26PeriodViewDto,
  },
  "PATCH /api/v1/cap/periods/:periodId/reopen": {
    summary: "Reopen a settled period — step-up required (cap_period_settled ABAC; D12; §4.1)",
    body: M26ReopenCapPeriodRequest,
    response: M26PeriodViewDto,
  },
  "POST /api/v1/cap/periods/:periodId/methodology": {
    summary:
      "Lock the streamlined/proportional methodology — one-time, step-up required (D2/D12; §4.1)",
    body: M26LockMethodologyRequest,
    response: M26PeriodViewDto,
  },
  // ── projections ──
  "GET /api/v1/cap/projections": {
    summary: "Latest projection snapshots (agency + inpatient) for a period (§4.1)",
    response: M26ProjectionViewListResponse,
  },
  "GET /api/v1/cap/projections/agency/:periodId": {
    summary: "Agency-aggregate projection snapshot — utilization + band (§4.1)",
    response: M26ProjectionViewDto,
  },
  "GET /api/v1/cap/projections/patient/:periodId/:patientId": {
    summary: "Per-patient projection snapshot — contribution + band (§4.1)",
    response: M26ProjectionViewDto,
  },
  "GET /api/v1/cap/projections/inpatient/:periodId": {
    summary: "Inpatient (20%) cap utilization — GIP+IRC day count + band (§4.1)",
    response: M26ProjectionViewDto,
  },
  "POST /api/v1/cap/projections/:periodId/recompute": {
    summary: "Force an immediate projection recompute (cap_period_open ABAC; §4.1)",
    response: M26ProjectionViewListResponse,
  },
  // ── accruals ──
  "GET /api/v1/cap/accruals/patient/:periodId/:patientId": {
    summary:
      "Per-patient accrual — paid + outstanding-billed cents, first election, last-paid-through (§4.1)",
    response: M26PatientAccrualViewDto,
  },
  "GET /api/v1/cap/accruals/patient/:periodId/:patientId/lines": {
    summary:
      "Per-patient accrual source lines — cursor-paginated (source kind/id, amount cents, service span; §4.1)",
    response: M26AccrualLinePageResponse,
  },
  "GET /api/v1/cap/accruals/inpatient/:periodId": {
    summary: "Inpatient accrual — GIP/IRC/total patient days + inpatient pct for the period (§4.1)",
    response: M26InpatientAccrualViewDto,
  },
  // ── threshold events ──
  "GET /api/v1/cap/threshold-events": {
    summary: "Threshold-event queue — filter by period/scope/band and unacknowledged-only (§4.1)",
    response: M26ThresholdEventViewListResponse,
  },
  "PATCH /api/v1/cap/threshold-events/:eventId/acknowledge": {
    summary:
      "Acknowledge a threshold event — records actor + timestamp (does not clear the breach; 204; §4.1)",
    body: M26AcknowledgeEventRequest,
  },
  // ── dashboard ──
  "GET /api/v1/cap/dashboard": {
    summary:
      "Cap-watch dashboard composite — period + agency/inpatient projection + recent events + open variances (§4.1)",
    response: M26DashboardViewDto,
  },
  // ── PS&R ──
  "POST /api/v1/cap/periods/:periodId/psr-imports": {
    summary: "Upload a PS&R CSV — sha256-deduped, queued for reconciliation (202; §4.1)",
    body: M26PsrImportRequest,
    response: M26PsrImportQueuedResponse,
  },
  "GET /api/v1/cap/psr-imports/:importId": {
    summary:
      "PS&R import status — MAC region, PSR period span, parse status/error, PSR totals (§4.1)",
    response: M26PsrImportViewDto,
  },
  "GET /api/v1/cap/psr-imports/:importId/reconciliation": {
    summary:
      "PS&R reconciliation lines — per-scope M26-accrual vs PSR amount + variance + status (§4.1)",
    response: M26PsrVarianceViewListResponse,
  },
  "PATCH /api/v1/cap/psr-imports/:importId/reconciliation/:lineId/resolve": {
    summary: "Resolve a variance line with a categorical reason + note (204; §4.1)",
    body: M26ResolveVarianceRequest,
  },
  // ── settlement ──
  "GET /api/v1/cap/settlements/:periodId": {
    summary: "Settlement worksheet — final paid/cap/overage + owed direction (§4.1)",
    response: M26SettlementViewDto,
  },
  "POST /api/v1/cap/settlements/:periodId/propose": {
    summary:
      "Propose a settlement worksheet from current accruals (cap_period_in_settlement ABAC; 201; §4.1)",
    response: M26SettlementViewDto,
  },
  "PATCH /api/v1/cap/settlements/:periodId/finalize": {
    summary: "Finalize settlement — step-up; in_settlement → settled (D12; M26-F06; §4.1)",
    body: M26FinalizeSettlementRequest,
    response: M26SettlementViewDto,
  },
  // ── platform constants ──
  "GET /api/v1/platform/cap/constants": {
    summary:
      "List CMS per-cap-year cap amounts — platform-admin (cap_platform_admin ABAC; D3; §4.1)",
    response: M26PlatformConstantViewListResponse,
  },
  "POST /api/v1/platform/cap/constants": {
    summary:
      "Publish a CMS per-cap-year cap amount — platform-admin (cap_platform_admin ABAC; D3; 201; §4.1)",
    body: M26PublishConstantRequest,
    response: M26PublishConstantAckResponse,
  },
  "PATCH /api/v1/platform/cap/constants/:capYear": {
    summary:
      "Amend a published cap amount before first tenant use — platform-admin (D3; 204; §4.1)",
    body: M26AmendConstantRequest,
  },
});

// ── M27 Cost Report (Form CMS-1984-14; §4.1 — all 45 routes, F0 response enrichment) ──────────────────
// Later Object.assign wins: this supersedes the earlier partial M27 block (11 request-only entries) and
// closes the deficit to 0 by pairing every route with its §4.2 response DTO. Money is INTEGER CENTS (D8);
// M27 carries no PHI (D18). Reads/writes returning opaque jsonb (worksheet `data`, statistic breakdowns,
// snapshot materialized payloads) publish the envelope with `Type.Unknown()` internals.
Object.assign(ROUTE_ENRICHMENTS, {
  // ── cost-report lifecycle root ──
  "GET /api/v1/cost-reports": {
    summary:
      "List cost reports by (ProviderEntity, fiscal year) + lifecycle state (cost_report.read; §4.1)",
    query: M27CostReportListQuerySchema,
    response: M27CostReportPageResponseSchema,
  },
  "POST /api/v1/cost-reports": {
    summary:
      "Create a cost report for a ProviderEntity + fiscal-year-end (cost_report.create; D1; §4.1)",
    body: M27CreateCostReportBodySchema,
    response: M27CostReportDetailResponseSchema,
  },
  "GET /api/v1/cost-reports/:id": {
    summary:
      "Read one cost report — summary + latest snapshot/validation/submission + compliance window (§4.1)",
    response: M27CostReportDetailResponseSchema,
  },
  "PATCH /api/v1/cost-reports/:id": {
    summary:
      "Edit cost-report metadata — bad-debt-claimed / wage source; version-checked (cost_report.edit; §4.1)",
    body: M27PatchCostReportBodySchema,
    response: M27CostReportDetailResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/refresh-inputs": {
    summary: "Enqueue trial-balance + wage-data + statistics refresh (cost_report.edit; §4.8)",
    response: M27RefreshInputsAcceptedResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/allocate": {
    summary: "Enqueue the step-down allocation recompute (cost_report.edit; §4.8)",
    response: M27AllocationAcceptedResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/return-to-draft": {
    summary: "Return a validating/ready report to draft (cost_report.edit; §4.1)",
    response: M27CostReportDetailResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/approve-for-submit": {
    summary:
      "Approve a cost report for submission — step-up (cost_report.approve_for_submit; D14; §4.1)",
    body: M27ApproveForSubmitBodySchema,
    response: M27CostReportDetailResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/submit": {
    summary:
      "Submit — step-up + attestation; builds the content-hashed snapshot (cost_report.submit; D10/D14; §4.1)",
    body: M27SubmitBodySchema,
    response: M27CostReportDetailResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/submit-past-deadline": {
    summary:
      "Submit past the effective deadline — documented reason + attestation (cost_report.submit; §4.1)",
    body: M27SubmitPastDeadlineBodySchema,
    response: M27CostReportDetailResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/reopen": {
    summary:
      "Reopen a submitted cost report — elevated approval + documented reason (cost_report.reopen_submitted; D19; §4.1)",
    body: M27ReopenBodySchema,
    response: M27CostReportDetailResponseSchema,
  },

  // ── worksheets ──
  "GET /api/v1/cost-reports/:id/worksheets/:code": {
    summary:
      "Read a worksheet's data jsonb (lazy — TypeBox default when unpopulated; cost_report.read; §4.2)",
    response: M27WorksheetResponseSchema,
  },
  "PUT /api/v1/cost-reports/:id/worksheets/:code": {
    summary: "Write a worksheet's TypeBox-validated data jsonb (cost_report.edit; §4.2)",
    body: M27PutWorksheetBodySchema,
    response: M27WorksheetResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/worksheets/:code/compute": {
    summary: "Enqueue a single-worksheet recompute (cost_report.edit; §4.8)",
    response: M27AllocationAcceptedResponseSchema,
  },

  // ── cost-center mappings ──
  "GET /api/v1/cost-reports/:id/cost-center-mappings": {
    summary: "List the effective Xero->CMS cost-center mappings (cost_report.read; §4.1)",
    response: M27CostCenterMappingListResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/cost-center-mappings/preview": {
    summary:
      "Dry-run a mapping change — changed accounts + unmapped GL accounts, no write (cost_report.edit; §4.1)",
    body: M27PreviewMappingBodySchema,
    response: M27MappingPreviewResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/cost-center-mappings/apply": {
    summary: "Apply tenant mapping overrides/extensions (cost_report.edit; §4.1)",
    body: M27ApplyMappingBodySchema,
    response: M27CostCenterMappingListResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/cost-center-mappings/reset-to-platform-default": {
    summary:
      "Reset mappings to the platform default (optionally keep tenant overrides) (cost_report.edit; §4.1)",
    body: M27ResetMappingBodySchema,
    response: M27CostCenterMappingListResponseSchema,
  },

  // ── bad debt ──
  "GET /api/v1/cost-reports/:id/bad-debt": {
    summary: "List Medicare bad-debt entries (cost_report.read; D7; §4.1)",
    response: M27BadDebtRecordListResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/bad-debt": {
    summary:
      "Add a Medicare bad-debt entry — deductible/coinsurance (cost_report.edit_bad_debt; D7; §4.1)",
    body: M27AddBadDebtBodySchema,
    response: M27BadDebtRecordResponseSchema,
  },
  "PATCH /api/v1/cost-reports/:id/bad-debt/:recordId": {
    summary: "Edit a bad-debt entry (cost_report.edit_bad_debt; D7; §4.1)",
    body: M27UpdateBadDebtBodySchema,
    response: M27BadDebtRecordResponseSchema,
  },
  "DELETE /api/v1/cost-reports/:id/bad-debt/:recordId": {
    summary:
      "Soft-delete a bad-debt entry (returns the tombstoned record; cost_report.edit_bad_debt; §4.1)",
    response: M27BadDebtRecordResponseSchema,
  },

  // ── statistics ──
  "GET /api/v1/cost-reports/:id/statistics": {
    summary:
      "Read the census/visit/FTE statistics block (null until refreshed; cost_report.read; §4.1)",
    response: M27StatisticDataOrNullResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/statistics/refresh": {
    summary: "Enqueue a statistics recompute (cost_report.edit; §4.8)",
    response: M27StatisticsRefreshAcceptedResponseSchema,
  },

  // ── imports ──
  "GET /api/v1/cost-reports/:id/imports/trial-balance": {
    summary: "List trial-balance import runs (cost_report.read; §4.1)",
    response: M27TrialBalanceImportListResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/imports/trial-balance": {
    summary: "Trigger a Xero trial-balance pull (cost_report.edit; §4.8)",
    response: M27ImportJobAcceptedResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/imports/trial-balance/manual": {
    summary: "Manual trial-balance upload — pre-normalized GL rows (cost_report.edit; §4.1)",
    body: M27ManualTrialBalanceBodySchema,
    response: M27TrialBalanceImportResponseSchema,
  },
  "GET /api/v1/cost-reports/:id/imports/wage-data": {
    summary: "List wage-data import runs (cost_report.read; §4.1)",
    response: M27WageDataImportListResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/imports/wage-data": {
    summary: "Trigger a Gusto wage-data pull (cost_report.edit; §4.8)",
    response: M27ImportJobAcceptedResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/imports/wage-data/manual": {
    summary: "Manual wage-data upload — pre-normalized wage rows (cost_report.edit; §4.1)",
    body: M27ManualWageDataBodySchema,
    response: M27WageDataImportResponseSchema,
  },

  // ── validations ──
  "GET /api/v1/cost-reports/:id/validations": {
    summary: "List validation runs for a cost report (cost_report.read; §4.1)",
    response: M27ValidationRunSummaryListResponseSchema,
  },
  "GET /api/v1/cost-reports/:id/validations/:vid": {
    summary:
      "Read one validation run + its per-rule results and overrides (cost_report.read; §4.1)",
    response: M27ValidationRunDetailResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/validate": {
    summary: "Enqueue a validation run against the effective rule set (cost_report.edit; §4.8)",
    response: M27ValidationJobAcceptedResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/validations/:vid/overrides": {
    summary:
      "Override a validation result — elevated approval + reason + audit (cost_report.override_validation; §11.B)",
    body: M27OverrideValidationResultBodySchema,
    response: M27ValidationOverrideResponseSchema,
  },

  // ── ECR submissions ──
  "GET /api/v1/cost-reports/:id/ecr-submissions": {
    summary: "List MCReF ECR submissions (cost_report.read; §4.1)",
    response: M27EcrSubmissionListResponseSchema,
  },
  "GET /api/v1/cost-reports/:id/ecr-submissions/:sid": {
    summary: "Read one ECR submission + MCReF acknowledgment/rejection (cost_report.read; §4.1)",
    response: M27EcrSubmissionResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/ecr-submissions/:sid/acknowledgments": {
    summary:
      "Record the MCReF acknowledgment / rejection for a submission (cost_report.record_acknowledgment; §4.1)",
    body: M27RecordAcknowledgmentBodySchema,
    response: M27EcrSubmissionResponseSchema,
  },

  // ── snapshots ──
  "GET /api/v1/cost-reports/:id/snapshots": {
    summary: "List content-hashed submission/reopen snapshots (cost_report.read; §4.1)",
    response: M27SnapshotSummaryListResponseSchema,
  },
  "GET /api/v1/cost-reports/:id/snapshots/:sid": {
    summary:
      "Read one snapshot + its materialized inputs/worksheet payload (audit-read-logged; cost_report.read; §4.1)",
    response: M27SnapshotDetailResponseSchema,
  },

  // ── compliance window ──
  "GET /api/v1/cost-reports/:id/compliance-window": {
    summary:
      "Read the deadline/alert-tier compliance window (null when none; cost_report.read; §4.1)",
    response: M27ComplianceWindowOrNullResponseSchema,
  },
  "POST /api/v1/cost-reports/:id/deadline-extensions": {
    summary: "Record a MAC-granted deadline extension (cost_report.edit; §4.1)",
    body: M27DeadlineExtensionBodySchema,
    response: M27ComplianceWindowResponseSchema,
  },

  // ── validation-rule library ──
  "GET /api/v1/cost-report-validation-rules": {
    summary:
      "List the effective validation-rule library — platform floor + tenant layer (cost_report.read; §11.B)",
    response: M27ValidationRuleListResponseSchema,
  },
  "POST /api/v1/cost-report-validation-rules": {
    summary:
      "Create a tenant validation rule layered on the platform floor (cost_report.manage_rules; D21; §11.B)",
    body: M27CreateValidationRuleBodySchema,
    response: M27ValidationRuleResponseSchema,
  },
  "PATCH /api/v1/cost-report-validation-rules/:id": {
    summary: "Edit a tenant validation rule (cost_report.manage_rules; §11.B)",
    body: M27UpdateValidationRuleBodySchema,
    response: M27ValidationRuleResponseSchema,
  },
  "POST /api/v1/cost-report-validation-rules/:id/disable": {
    summary: "Deprecate/disable a tenant validation rule (cost_report.manage_rules; §11.B)",
    response: M27ValidationRuleResponseSchema,
  },
});

// M30 HQRP & Quality — closes the last 3 unenriched routes (deficit 3 → 0).
//
// All three are mutating POSTs with NO request body and NO query: the transition is server-derived
// from the :incidentId path param (submit/close) or from nothing (risk-register MV refresh). No body
// contract exists to publish, so each is `summary`-only — the same shape the module already uses for
// its bodyless mutations. `Object.assign` (later wins) so these merge over any prior ROUTE_ENRICHMENTS.
Object.assign(ROUTE_ENRICHMENTS, {
  "POST /api/v1/quality/incidents/:incidentId/submit": {
    summary: "Submit an incident (draft → submitted)",
  },
  "POST /api/v1/quality/incidents/:incidentId/close": {
    summary: "Close an incident (resolved → closed, follow-up complete)",
  },
  "POST /api/v1/quality/risk-register/refresh": {
    summary: "Force a risk-register materialized-view refresh",
  },
});

// ── M33 Reporting & Dashboards (42 routes) — full enrichment. Later Object.assign wins, so this block
// supersedes the 4 earlier partial Track-B entries (dashboards / admin/mvs / schedules / drilldown-emit),
// adding their response DTOs. CSV export (#32) + bulk drilldown export (#36) hijack the response and stream
// chunked CSV — no JSON body — so they are summary-only. Everything else carries a request contract and/or
// a response DTO pinned to the service view by `Conforms` (reporting-typebox READ views / write-typebox
// mutating + export/drilldown views).
Object.assign(ROUTE_ENRICHMENTS, {
  // ── dashboards + tiles (#1–#4) ──
  "GET /api/v1/reporting/dashboards": {
    summary: "List dashboards in the actor's org scope (cursor-paginated)",
    query: M33DashboardListQuerySchema,
    response: M33DashboardListResponseSchema,
  },
  "GET /api/v1/reporting/dashboards/:dashboardId": {
    summary: "Read one dashboard (share-scope visibility gate)",
    response: M33DashboardSummaryViewSchema,
  },
  "GET /api/v1/reporting/tiles/:tileKey": {
    summary: "Read a tile: compile+execute its spec (aggregate-only, D6)",
    query: M33TileReadQuery,
    response: M33TileReadResponse,
  },
  "GET /api/v1/reporting/tiles/:tileKey/freshness": {
    summary: "Tile freshness badge (data_freshness_seconds + as-of)",
    response: M33TileFreshnessViewSchema,
  },

  // ── report bases + metric catalog (#5–#7) ──
  "GET /api/v1/reporting/bases": {
    summary: "List report bases (status-filtered, cursor-paginated)",
    query: M33BaseListQuerySchema,
    response: M33ReportBaseListResponseSchema,
  },
  "GET /api/v1/reporting/bases/:baseKey": {
    summary: "Read one report base (dimensions + measures + drilldown template)",
    response: M33ReportBaseDetailViewSchema,
  },
  "GET /api/v1/reporting/metrics": {
    summary: "List the platform metric catalog (status-filtered, cursor-paginated)",
    query: M33MetricListQuerySchema,
    response: M33ReportMetricListResponseSchema,
  },

  // ── report definitions + D9 immutable version chain (#8–#14) ──
  "POST /api/v1/reporting/definitions": {
    summary: "Create a tenant definition + its initial draft (v1) spec (201)",
    body: M33CreateDefinitionRequest,
    response: M33DefinitionViewSchema,
  },
  "GET /api/v1/reporting/definitions": {
    summary: "List the org's definitions (status/authorship-filtered, cursor-paginated)",
    query: M33DefinitionListQuery,
    response: M33DefinitionListResponseSchema,
  },
  "GET /api/v1/reporting/definitions/:id": {
    summary: "Read one definition (latest-version pointer + lock)",
    response: M33DefinitionViewSchema,
  },
  "GET /api/v1/reporting/definitions/:id/versions": {
    summary: "List a definition's version chain (newest first, D9)",
    query: M33DefinitionListQuery,
    response: M33DefinitionVersionListResponseSchema,
  },
  "POST /api/v1/reporting/definitions/:id/versions": {
    summary: "Append a NEW immutable version (editing is never in-place, D9) (201)",
    body: M33CreateVersionRequest,
    response: M33DefinitionVersionViewSchema,
  },
  "POST /api/v1/reporting/definitions/:id/versions/:vid/publish": {
    summary: "Publish a version: promote to latest, supersede the prior (D9) (201)",
    response: M33PublishVersionResponseSchema,
  },
  "POST /api/v1/reporting/definitions/:id/archive": {
    summary: "Archive a definition (terminal; version chain retained) (201)",
    response: M33DefinitionViewSchema,
  },

  // ── saved views + sharing (#15–#21) ──
  "GET /api/v1/reporting/views": {
    summary: "List views (scope=mine own / scope=org shared; cursor-paginated)",
    query: M33ViewListQuery,
    response: M33ViewListResponseSchema,
  },
  "POST /api/v1/reporting/views": {
    summary: "Create a saved view over a published definition version (201)",
    body: M33CreateViewRequest,
    response: M33ViewViewSchema,
  },
  "GET /api/v1/reporting/views/:id": {
    summary: "Read one view (§4.7.2 visibility ladder gates access)",
    response: M33ViewViewSchema,
  },
  "PATCH /api/v1/reporting/views/:id": {
    summary: "Edit a view (display / pinned filters / share scope)",
    body: M33UpdateViewRequest,
    response: M33ViewViewSchema,
  },
  "POST /api/v1/reporting/views/:id/share": {
    summary: "Set a view's share scope (D17; org needs report.share.org) (201)",
    body: M33ShareViewRequest,
    response: M33ShareViewResponseSchema,
  },
  "POST /api/v1/reporting/views/:id/set-org-default": {
    summary: "Set the single org-default view (Org Admin, D17) (201)",
    response: M33ViewViewSchema,
  },
  "POST /api/v1/reporting/views/:id/archive": {
    summary: "Archive a view (clears the org-default flag) (201)",
    response: M33ViewViewSchema,
  },

  // ── scheduled reports (#22–#31) ──
  "GET /api/v1/reporting/schedules": {
    summary: "List schedules (status-filtered, cursor-paginated)",
    query: M33ScheduleListQuery,
    response: M33ScheduleListResponseSchema,
  },
  "POST /api/v1/reporting/schedules": {
    summary: "Create a schedule (§2.3 cron/recipient/pdf-row-limit rules) (201)",
    body: M33ScheduledReportCreate,
    response: M33ScheduleViewSchema,
  },
  "GET /api/v1/reporting/schedules/:id": {
    summary: "Read one schedule",
    response: M33ScheduleViewSchema,
  },
  "PATCH /api/v1/reporting/schedules/:id": {
    summary: "Edit a schedule (re-validates the §2.3 rules on changed fields)",
    body: M33UpdateScheduleRequest,
    response: M33ScheduleViewSchema,
  },
  "POST /api/v1/reporting/schedules/:id/pause": {
    summary: "Pause a schedule (clears next_run_at) (201)",
    response: M33ScheduleViewSchema,
  },
  "POST /api/v1/reporting/schedules/:id/resume": {
    summary: "Resume a paused schedule (recomputes next_run_at) (201)",
    response: M33ScheduleViewSchema,
  },
  "POST /api/v1/reporting/schedules/:id/cancel": {
    summary: "Cancel a schedule (terminal) (201)",
    response: M33ScheduleViewSchema,
  },
  "POST /api/v1/reporting/schedules/:id/delete_all_runs": {
    summary: "Bulk-delete the run history (step-up + org-admin, D11)",
    response: M33DeleteAllRunsResponseSchema,
  },
  "GET /api/v1/reporting/schedules/:id/runs": {
    summary: "Read a schedule's run ledger (newest first, cursor-paginated)",
    query: M33ScheduleRunListQuery,
    response: M33ScheduleRunListResponseSchema,
  },
  "GET /api/v1/reporting/schedules/runs/:runId": {
    summary: "Read one run (M22 document back-ref + failure telemetry)",
    response: M33ScheduleRunViewSchema,
  },

  // ── exports (#32–#34) ── (#32 CSV streams the response → summary-only)
  "POST /api/v1/reporting/views/:id/export.csv": {
    summary:
      "Stream a saved view as CSV (direct replica stream; §4.8 250k cap → 413). Response is a chunked CSV stream, not JSON",
    body: M33ExportRequest,
  },
  "POST /api/v1/reporting/views/:id/export.pdf": {
    summary: "Request a PDF render (M22 handshake; ≤5000-row gate → 413) → 202",
    body: M33ExportRequest,
    response: M33ExportAcceptedResponseSchema,
  },
  "POST /api/v1/reporting/views/:id/export.xlsx": {
    summary: "Request an XLSX render (M22 handshake; no row gate) → 202",
    body: M33ExportRequest,
    response: M33ExportAcceptedResponseSchema,
  },

  // ── drilldown (#35–#36) ── (#36 bulk export streams the response → summary-only)
  "POST /api/v1/reporting/drilldown/emit": {
    summary: "Resolve + consent-narrow a drilldown URL + write the audit row (W-R-05) (201)",
    body: M33DrilldownEmitRequest,
    response: M33DrilldownEmitResponseSchema,
  },
  "POST /api/v1/reporting/drilldown/bulk_export": {
    summary:
      "Compliance bulk drilldown export (step-up + device attestation, §12.4). Response is a chunked CSV stream, not JSON",
    body: M33DrilldownBulkExportRequest,
  },

  // ── platform / compliance admin (#37–#41) ──
  "GET /api/v1/reporting/admin/mvs": {
    summary: "List the registered materialized views (refresh telemetry + status)",
    query: M33MvListQuerySchema,
    response: M33MvMetadataListResponseSchema,
  },
  "POST /api/v1/reporting/admin/mvs/:mvKey/refresh": {
    summary: "Refresh an MV (enqueues the on-primary worker) → 202",
    response: M33MvCommandAcceptedSchema,
  },
  "POST /api/v1/reporting/admin/mvs/:mvKey/suspend": {
    summary: "Suspend an MV (halt its refresh schedule) → 202",
    response: M33MvCommandAcceptedSchema,
  },
  "GET /api/v1/reporting/admin/lag": {
    summary: "Read the replica-lag posture (the D14 breaker + freshness)",
    response: M33ReplicaLagViewSchema,
  },
  "GET /api/v1/reporting/admin/audit/drilldowns": {
    summary: "Query the compliance drilldown-audit trail (query_filters_cipher denylisted)",
    query: M33DrilldownAuditListQuerySchema,
    response: M33DrilldownAuditListResponseSchema,
  },

  // ── internal MetricsProvider seam (#42) ──
  "GET /api/v1/reporting/metrics_seam/dashboard/:metricKey": {
    summary: "Read a single dashboard metric at an as-of/window (backs the MetricsProvider seam)",
    query: M33MetricSeamQuerySchema,
    response: M33MetricSeamViewSchema,
  },
});

// ── M34 SaaS Tenant Platform (48 routes — full request/response contracts; deficit → 0) ──────────────
// Tenant-scoped (DSAR §164.524 / tenant-export / onboarding / support-consent / BAA), platform-ops
// (tenant lifecycle / key-ring / support-sessions / onboarding-templates / feature-flags / invitations /
// BAA register / signup-intent triage), and the public self-serve signup surface. Org/actor binding is
// server-side, so no body carries an org/membership id. Empty request bodies (fulfill / start-task /
// elevate / verify-email) are summary-only — no requestBody. This block supersedes the earlier partial
// M34 entries (later Object.assign wins).
Object.assign(ROUTE_ENRICHMENTS, {
  // ── tenant-scoped BAA (§4.1) ──
  "GET /api/v1/tenant/baa": {
    summary: "Tenant's platform→tenant BAA history (cursor-paginated; D11)",
    query: M34BaaListQuerySchema,
    response: M34BaaRecordListResponseSchema,
  },
  "POST /api/v1/tenant/baa/:id/attest": {
    summary: "Compliance-officer attestation of a BAA record (step-up)",
    body: M34BaaAttestRequest,
    response: M34TenantBaaRecordViewSchema,
  },

  // ── tenant-scoped DSAR export jobs (§164.524) ──
  "POST /api/v1/tenant/dsar-export-jobs": {
    summary: "Request a patient-scoped DSAR export (enqueues tenant.dsar_export; §164.524)",
    body: M34DsarExportRequest,
    response: M34DsarExportJobViewSchema,
  },
  "GET /api/v1/tenant/dsar-export-jobs": {
    summary: "The tenant's DSAR export queue (filtered, cursor-paginated)",
    query: M34DsarListQuerySchema,
    response: M34DsarExportJobListResponseSchema,
  },
  "POST /api/v1/tenant/dsar-export-jobs/:id/fulfill": {
    summary: "Flip a DSAR job to fulfilled + trigger presigned-URL email (step-up)",
    response: M34DsarExportJobViewSchema,
  },
  "POST /api/v1/tenant/dsar-export-jobs/:id/extend": {
    summary: "One-time §164.524 30-day extension",
    body: M34DsarExtendRequest,
    response: M34DsarExportJobViewSchema,
  },
  "POST /api/v1/tenant/dsar-export-jobs/:id/deny": {
    summary: "Deny a DSAR job with a permitted-denial reason (step-up)",
    body: M34DsarDenyRequest,
    response: M34DsarExportJobViewSchema,
  },
  "GET /api/v1/tenant/dsar-export-jobs/:id/download": {
    summary: "Mint a 24h presigned DSAR bundle URL (SEC-052; rate-limited)",
    response: M34DownloadUrlViewSchema,
  },

  // ── tenant-scoped full export jobs ──
  "POST /api/v1/tenant/tenant-export-jobs": {
    summary: "Request a tenant-wide export archive (enqueues tenant.export; step-up)",
    body: M34TenantExportRequest,
    response: M34TenantExportJobViewSchema,
  },
  "GET /api/v1/tenant/tenant-export-jobs": {
    summary: "The tenant's export queue (filtered, cursor-paginated)",
    query: M34TenantExportListQuerySchema,
    response: M34TenantExportJobListResponseSchema,
  },
  "GET /api/v1/tenant/tenant-export-jobs/:id/download": {
    summary: "Mint a 24h presigned tenant-export URL (SEC-052; step-up)",
    response: M34DownloadUrlViewSchema,
  },

  // ── tenant-scoped onboarding ──
  "GET /api/v1/tenant/onboarding": {
    summary: "Tenant's onboarding state (D3; cursor-paginated)",
    query: M34OnboardingListQuerySchema,
    response: M34OnboardingTaskListResponseSchema,
  },
  "POST /api/v1/tenant/onboarding/:taskId/start": {
    summary: "Advance an onboarding task pending → in_progress",
    response: M34OnboardingTaskViewSchema,
  },
  "POST /api/v1/tenant/onboarding/:taskId/complete": {
    summary: "Complete a task with evidence (precondition DSL → 422 if false)",
    body: M34OnboardingCompleteRequest,
    response: M34OnboardingTaskViewSchema,
  },
  "POST /api/v1/tenant/onboarding/:taskId/block": {
    summary: "Block a task with a reason (emits M36 alert)",
    body: M34OnboardingBlockRequest,
    response: M34OnboardingTaskViewSchema,
  },

  // ── tenant-scoped support-consent grants ──
  "GET /api/v1/tenant/support-consent-grants": {
    summary: "Tenant's support-access consent grants (cursor-paginated)",
    query: M34GrantListQuerySchema,
    response: M34SupportConsentGrantListResponseSchema,
  },
  "POST /api/v1/tenant/support-consent-grants": {
    summary: "Issue a support-access consent grant (≤72h; compliance-officer; step-up)",
    body: M34TenantSupportConsentGrantRequest,
    response: M34SupportConsentGrantViewSchema,
  },
  "POST /api/v1/tenant/support-consent-grants/:id/revoke": {
    summary: "Revoke a grant (cascades to any open support_session)",
    body: M34RevokeConsentGrantRequest,
    response: M34SupportConsentGrantViewSchema,
  },

  // ── platform-ops tenant lifecycle (§4.1) ──
  "GET /api/v1/platform/tenants": {
    summary: "Platform tenant inventory (cross-tenant; status/plan/search filters)",
    query: M34TenantListQuerySchema,
    response: M34TenantListResponseSchema,
  },
  "POST /api/v1/platform/tenants": {
    summary:
      "Provision a tenant from a signup_intent or raw input (enqueues tenant.provision; step-up)",
    body: M34ProvisionTenantRequest,
    response: M34TenantJobAckSchema,
  },
  "GET /api/v1/platform/tenants/:orgSlug": {
    summary: "Full tenant overview (account + status event + key-ring + onboarding + BAA; §5.2)",
    response: M34TenantOverviewViewSchema,
  },
  "POST /api/v1/platform/tenants/:orgSlug/status": {
    summary: "Apply a lifecycle status transition (eleven-state machine; step-up)",
    body: M34StatusTransitionRequest,
    response: M34TenantStatusAckSchema,
  },
  "POST /api/v1/platform/tenants/:orgSlug/offboard": {
    summary: "Initiate offboarding cascade (step-up)",
    body: M34OffboardTenantRequest,
    response: M34TenantStatusAckSchema,
  },
  "POST /api/v1/platform/tenants/:orgSlug/shred": {
    summary: "Execute the cryptographic shred (enqueues tenant.shred; passkey-2min + co-signer)",
    body: M34ShredTenantRequest,
    response: M34TenantJobAckSchema,
  },
  "POST /api/v1/platform/tenants/:orgSlug/dek-rotate": {
    summary: "Request a DEK rotation (enqueues tenant.dek_rotate; step-up)",
    body: M34DekRotateRequest,
    response: M34TenantJobAckSchema,
  },
  "GET /api/v1/platform/tenants/:orgSlug/key-ring": {
    summary: "Read key-ring METADATA only (ciphertext never exposed; §3.5)",
    response: M34KeyRingMetadataViewSchema,
  },

  // ── platform-ops support sessions (break-glass; F01/D8/D16) ──
  "GET /api/v1/platform/support-sessions": {
    summary: "Active + recent support sessions across tenants (cursor-paginated)",
    query: M34SupportSessionListQuerySchema,
    response: M34SupportSessionListResponseSchema,
  },
  "GET /api/v1/platform/support-sessions/:id/events": {
    summary: "A session's event ledger — the surveyor trail (cursor-paginated; audited)",
    query: M34SessionEventListQuerySchema,
    response: M34SupportSessionEventListResponseSchema,
  },
  "POST /api/v1/platform/support-sessions": {
    summary: "Start a session against a consent grant (distinct-actor + passkey-5min step-up)",
    body: M34StartSessionRequest,
    response: M34StartSessionAckSchema,
  },
  "POST /api/v1/platform/support-sessions/:id/elevate": {
    summary: "Elevate for the PHI write window (fresh passkey-2min; Part 2-heightened → 403)",
    response: M34ElevateSessionAckSchema,
  },
  "POST /api/v1/platform/support-sessions/:id/close": {
    summary: "Close a session with reason='manual' (no step-up)",
    body: M34CloseSessionRequest,
    response: M34CloseSessionAckSchema,
  },

  // ── platform-ops onboarding-template catalog ──
  "GET /api/v1/platform/onboarding-templates": {
    summary: "Platform onboarding-template catalog (cursor-paginated)",
    query: M34OnboardingTemplateListQuerySchema,
    response: M34OnboardingTemplateListResponseSchema,
  },
  "POST /api/v1/platform/onboarding-templates": {
    summary: "Add/edit a NON-canonical onboarding template (step-up; canonical is migration-only)",
    body: M34UpsertOnboardingTemplateRequest,
    response: M34OnboardingTemplateViewSchema,
  },

  // ── platform-ops feature-flag admin (delegates to M1 FeatureFlagAdmin; D13) ──
  "GET /api/v1/platform/feature-flags": {
    summary: "Platform-global + per-tenant feature flags (cursor-paginated)",
    query: M34FeatureFlagListQuerySchema,
    response: M34FeatureFlagListResponseSchema,
  },
  "POST /api/v1/platform/feature-flags": {
    summary: "Create/update a feature flag via the M1 admin seam (step-up)",
    body: M34UpsertFeatureFlagRequest,
    response: M34FeatureFlagViewSchema,
  },
  "POST /api/v1/platform/feature-flags/:flagKey/kill-switch": {
    summary: "Toggle a flag's kill switch (emits M36 emergency alert; step-up)",
    body: M34KillSwitchRequest,
    response: M34FeatureFlagViewSchema,
  },

  // ── platform-ops tenant invitations ──
  "GET /api/v1/platform/tenant-invitations": {
    summary: "Platform → first-admin invitations across tenants (cursor-paginated)",
    query: M34InvitationListQuerySchema,
    response: M34InvitationListResponseSchema,
  },
  "POST /api/v1/platform/tenant-invitations": {
    summary: "Issue a single-use first-admin invitation token (sent via M36; step-up)",
    body: M34IssueInvitationRequest,
    response: M34TenantInvitationViewSchema,
  },
  "DELETE /api/v1/platform/tenant-invitations/:id": {
    summary: "Revoke a pending invitation",
    response: M34RevokeInvitationAckSchema,
  },

  // ── platform-ops BAA register (§3.8/D11) ──
  "GET /api/v1/platform/baa-register": {
    summary: "Platform→tenant BAA register across tenants (cursor-paginated)",
    query: M34BaaRegisterListQuerySchema,
    response: M34BaaRegisterListResponseSchema,
  },
  "POST /api/v1/platform/baa-register": {
    summary: "File a BAA record for a (tenant_account, addendum_version) — UNIQUE",
    body: M34CreateBaaRequest,
    response: M34PlatformBaaRecordViewSchema,
  },
  "PATCH /api/v1/platform/baa-register/:id": {
    summary: "Update a BAA record (execution/termination/dates/contacts/document linkage)",
    body: M34UpdateBaaRequest,
    response: M34PlatformBaaRecordViewSchema,
  },

  // ── platform-ops signup-intent triage (F02/ADR-0010) ──
  "GET /api/v1/platform/signup-intents": {
    summary: "Signup-intent triage queue (status/source filters; cursor-paginated)",
    query: M34SignupIntentListQuerySchema,
    response: M34SignupIntentListResponseSchema,
  },
  "POST /api/v1/platform/signup-intents/:id/qualify": {
    summary: "Qualify an intent (new → qualified; enqueues tenant.provision)",
    body: M34QualifyIntentRequest,
    response: M34QualifyIntentAckSchema,
  },
  "POST /api/v1/platform/signup-intents/:id/reject": {
    summary: "Reject an intent (new → rejected) with a recorded rationale",
    body: M34RejectIntentRequest,
    response: M34RejectIntentAckSchema,
  },

  // ── public self-serve signup (§7.1 Phase-3; flag-gated 503 when OFF) ──
  "POST /api/v1/public/signup-intents": {
    summary: "Public self-serve signup intake (no session; source server-pinned; rate-limited)",
    body: M34PublicSignupIntentRequest,
    response: M34PublicSignupIntentAckSchema,
  },
  "POST /api/v1/public/signup-intents/:tokenHash/verify-email": {
    summary: "Consume the single-use email-verification token (idempotent re-consume → 409)",
    response: M34VerifyEmailAckSchema,
  },
  "POST /api/v1/public/tenant-invitations/:tokenHash/accept": {
    summary: "Accept the platform → first-admin invitation (creates M2 user + first org_admin)",
    body: M34AcceptInvitationRequest,
    response: M34AcceptInvitationAckSchema,
  },
});

// ── M36 Secure Messaging & Alerts (22 routes: 19 messaging/notification/alert + 3 vendor webhooks) ──
// Webhook routes carry no session auth and no TypeBox body (Twilio/Postmark urlencoded vendor callback
// read as a raw Record<string,string>) and return 204 → summary-only. The four other 204 mutations
// (delete message / remove member / remove endpoint) are summary-only. `announce` reuses the
// send-message response shape; verify-endpoint reuses the register-endpoint response shape.
Object.assign(ROUTE_ENRICHMENTS, {
  // channels & messages (§4.2)
  "GET /api/v1/messaging/channels": {
    summary: "List the channels the actor is a member of",
    response: M36ChannelListResponseSchema,
  },
  "GET /api/v1/messaging/channels/:id": {
    summary: "Channel detail + recent members (channel_visibility ABAC)",
    response: M36ChannelDetailResponseSchema,
  },
  "GET /api/v1/messaging/channels/:id/messages": {
    summary: "Paginated message history (bodies decrypted for entitled readers)",
    query: M36ListMessagesQuerySchema,
    response: M36MessageListResponseSchema,
  },
  "POST /api/v1/messaging/channels/:id/messages": {
    summary: "Post a message (201; CHANNEL_ARCHIVED 410)",
    body: M36SendMessageBodySchema,
    response: M36SendMessageResponseSchema,
  },
  "PATCH /api/v1/messaging/messages/:id": {
    summary: "Edit a message within the edit window (author-only)",
    body: M36EditMessageBodySchema,
    response: M36EditMessageResponseSchema,
  },
  "DELETE /api/v1/messaging/messages/:id": { summary: "Soft-delete a message (author-only; 204)" },
  "POST /api/v1/messaging/messages/:id/read": {
    summary: "Mark message(s) read — single or up-through-id (204)",
    body: M36ReadBodySchema,
  },
  "POST /api/v1/messaging/dm": {
    summary: "Open or find a 1:1 DM channel (idempotent; 200/201)",
    body: M36OpenDmBodySchema,
    response: M36OpenDmResponseSchema,
  },
  "POST /api/v1/messaging/channels/:id/members": {
    summary: "Add a manual member (admin override on auto channels; 204)",
    body: M36AddMemberBodySchema,
  },
  "DELETE /api/v1/messaging/channels/:id/members/:userId": {
    summary: "Remove a channel member (204)",
  },
  "POST /api/v1/messaging/announce": {
    summary: "Post to the tenant announcement channel (org_admin; 201)",
    body: M36AnnounceBodySchema,
    response: M36SendMessageResponseSchema,
  },

  // notification preferences & endpoints (§4.2; SELF-only)
  "GET /api/v1/notifications/preferences": {
    summary: "Read the actor's notification preferences",
    response: M36NotificationPreferencesResponseSchema,
  },
  "PUT /api/v1/notifications/preferences": {
    summary: "Replace preferences (INVALID_ROUTING_MAP 422 / VACATION_FORWARD_* 409)",
    body: M36PreferencesBodySchema,
    response: M36PutPreferencesResponseSchema,
  },
  "POST /api/v1/notifications/endpoints": {
    summary: "Register a push/sms/email delivery endpoint (201)",
    body: M36RegisterEndpointBodySchema,
    response: M36DeliveryEndpointResponseSchema,
  },
  "POST /api/v1/notifications/endpoints/:id/verify": {
    summary: "Confirm an endpoint verification token",
    body: M36VerifyEndpointBodySchema,
    response: M36DeliveryEndpointResponseSchema,
  },
  "DELETE /api/v1/notifications/endpoints/:id": { summary: "Remove a delivery endpoint (204)" },

  // alerts (§4.2)
  "GET /api/v1/alerts/inbox": {
    summary: "The actor's recent alerts with delivery status",
    response: M36AlertInboxResponseSchema,
  },
  "GET /api/v1/alert-rules": {
    summary: "Tenant + inherited platform alert rules",
    response: M36AlertRuleListResponseSchema,
  },
  "PATCH /api/v1/alert-rules/:id": {
    summary: "Enable/disable/override a rule (SYSTEM_LOCKED 403; clones platform default)",
    body: M36AlertRulePatchSchema,
    response: M36AlertRuleResponseSchema,
  },

  // vendor delivery webhooks (§4.9) — signature-authed, raw urlencoded vendor body, 204 → summary-only
  "POST /webhooks/twilio/sms-status": {
    summary:
      "Twilio SMS delivery-status callback (HMAC-verified; reconciles notification_delivery)",
  },
  "POST /webhooks/twilio/voice-status": {
    summary: "Twilio Voice (SOS) delivery-status callback (HMAC-verified)",
  },
  "POST /webhooks/postmark/event": {
    summary: "Postmark bounce/delivery event callback (IP allowlist + bearer)",
  },
});

// M38 Clinical Terminology Service — enrichment block for ALL M38 routes (§4.1–4.2).
// Append as a trailing `Object.assign(ROUTE_ENRICHMENTS, { ... })` — later wins, so re-covering
// `GET /:system/search` (already enriched upstream) is harmless. Paths are exact `METHOD /path`.
Object.assign(ROUTE_ENRICHMENTS, {
  // Binary validate (hot path on claim lines / problem lists) — ValidateResult + echoed asOf.
  "GET /api/v1/terminology/:system/validate": {
    summary: "Version-aware validate a (system, code) at asOf (§4.2)",
    query: M38ValidateQuerySchema,
    response: M38ValidateResponseSchema,
  },
  // Search (exact/fuzzy/semantic) — re-covered here; matches the upstream entry.
  "GET /api/v1/terminology/:system/search": {
    summary: "Search concepts within a code system (§4.2)",
    query: TerminologySearchQuerySchema,
    response: TerminologySearchResponseSchema,
  },
  // Deprecation successor mapping.
  "GET /api/v1/terminology/:system/:code/deprecation": {
    summary: "Deprecation successor mapping for a code, or null (§4.2)",
    response: M38DeprecationLookupResponseSchema,
  },
  // Lookup full concept (system-specific properties; per-system `properties` union is open).
  "GET /api/v1/terminology/:system/:code": {
    summary: "Lookup a full concept at asOf (§4.2)",
    query: M38LookupQuerySchema,
    response: M38ConceptResponseSchema,
  },
  // Value-set expansion at asOf (paginated; unioned with tenant extensions).
  "GET /api/v1/terminology/value-sets/:id/expand": {
    summary: "Expand a value set at asOf, with tenant extensions (§4.2)",
    query: M38ExpandQuerySchema,
    response: M38ExpandResponseSchema,
  },
  // (system, code, asOf) → membership with provenance.
  "GET /api/v1/terminology/value-sets/:id/is-member": {
    summary: "Membership of a (system, code) in a value set + provenance (§4.2)",
    query: M38IsMemberQuerySchema,
    response: M38MembershipResponseSchema,
  },
  // Tenant adds a (system, code) to a value set — the ONLY tenant write (§7.4/§7.6); 201.
  "POST /api/v1/terminology/value-sets/:id/extensions": {
    summary: "Add a (system, code) tenant extension to a value set (§4.2)",
    body: M38ExtensionBodySchema,
    response: M38ExtensionCreatedResponseSchema,
  },
  // Tenant removes an extension (soft-delete) — 204, no response body → summary-only.
  "DELETE /api/v1/terminology/value-sets/:id/extensions/:extId": {
    summary: "Remove a tenant value-set extension (soft-delete; 204, §4.2)",
  },
});

// M39 Consent & Authorization Management — complete route enrichment (all 27 routes).
// Paste AFTER the existing partial M39 block; a later Object.assign wins, so this supersedes it and
// drives the module deficit to 0. Routes 25-27 (portal) do not exist yet (no portal session_class).
Object.assign(ROUTE_ENRICHMENTS, {
  // ── catalog + overlay (routes 1-2) ──
  "GET /api/v1/consent-types": {
    summary: "Consent-type catalog + applicable tenant overlay (§4.1 #1)",
    response: M39ConsentCatalogListResponse,
  },
  "POST /api/v1/consent-types/overlay": {
    summary: "Publish a TIGHTEN-ONLY tenant consent-type overlay (§7.6, step-up)",
    body: M39UpsertOverlayBody,
    response: M39ConsentTypeOverlayResponse,
  },

  // ── record reads (routes 3-5) ──
  "GET /api/v1/patients/:patientId/consents": {
    summary: "A patient's ACTIVE consents (§4.1 #3)",
    response: M39ConsentListResponse,
  },
  "GET /api/v1/consents/:consentId": {
    summary: "Read a full consent record (§4.1 #4)",
    response: M39ConsentRecordResponse,
  },
  "GET /api/v1/consents/:consentId/version-chain": {
    summary: "Both ancestor chains — supersession (D1) + renewal (D13)",
    response: M39ConsentVersionChainResponse,
  },

  // ── record lifecycle (routes 6-10, 20) ──
  "POST /api/v1/patients/:patientId/consents": {
    summary: "Create a consent DRAFT for a patient (§4.1 #6)",
    body: M39CreateDraftBody,
    response: M39ConsentRecordResponse,
  },
  "PATCH /api/v1/consents/:consentId": {
    summary: "Edit a consent draft — only `status='draft'` is editable (D1)",
    body: M39UpdateDraftBody,
    response: M39ConsentRecordResponse,
  },
  "POST /api/v1/consents/:consentId/sign": {
    summary: "Sign a consent (step-up; emits m39.consent.signed)",
    body: M39SignConsentBody,
    response: M39ConsentRecordResponse,
  },
  "POST /api/v1/consents/:consentId/supersede": {
    summary: "Supersede an active consent with a new row (D1 append-only, step-up)",
    body: M39SupersedeBody,
    response: M39ConsentRecordResponse,
  },
  "POST /api/v1/consents/:consentId/revoke": {
    summary: "Revoke a consent (§7.3 cascade; staff revocation needs evidence, step-up)",
    body: M39RevokeBody,
    response: M39ConsentRecordResponse,
  },
  "POST /api/v1/consents/:consentId/renew": {
    summary: "Renew an expired/revoked consent (D13 renewal chain, step-up)",
    body: M39RenewBody,
    response: M39ConsentRecordResponse,
  },

  // ── recipients (routes 11-13) ──
  "GET /api/v1/consents/:consentId/recipients": {
    summary: "Named disclosure recipients on a consent, active + historical (D6)",
    response: M39ConsentRecipientListResponse,
  },
  "POST /api/v1/consents/:consentId/recipients": {
    summary: "Add a named disclosure recipient (D6, step-up)",
    body: M39AddRecipientBody,
    response: M39ConsentRecipientResponse,
  },
  "DELETE /api/v1/consents/:consentId/recipients/:recipientId": {
    summary: "Remove a named recipient — flips removed_at, never deletes (D6, step-up)",
    body: M39RemoveRecipientBody,
    response: M39ConsentRecipientResponse,
  },

  // ── DPOA agents (routes 14-17) ──
  "GET /api/v1/consents/:consentId/dpoa-agents": {
    summary: "Named DPOA agents on a consent, active + historical (D5)",
    response: M39ConsentDpoaAgentListResponse,
  },
  "POST /api/v1/consents/:consentId/dpoa-agents": {
    summary: "Name a DPOA agent (D5, step-up)",
    body: M39AddDpoaAgentBody,
    response: M39ConsentDpoaAgentResponse,
  },
  "PATCH /api/v1/consents/:consentId/dpoa-agents/:agentId": {
    summary: "Mutate a DPOA agent's scope / activation / term, or retire them (D5, step-up)",
    body: M39UpdateDpoaAgentBody,
    response: M39ConsentDpoaAgentResponse,
  },
  "GET /api/v1/patients/:patientId/dpoa/active-primary": {
    summary: "The patient's ACTIVE primary DPOA agent, or null (M7/M11/M14 consumer, D5)",
    response: M39ActivePrimaryDpoaResponse,
  },

  // ── expiry + renewal cycles (routes 18-19) ──
  "GET /api/v1/patients/:patientId/expiring-consents": {
    summary: "Consents inside the renewal window (cursor-paginated, §4.12)",
    query: M39ExpiringConsentsQuery,
    response: M39ExpiringConsentsResponse,
  },
  "GET /api/v1/consents/:consentId/renewal-cycle": {
    summary: "Open + closed renewal cycles on a consent (D8)",
    response: M39ConsentRenewalCycleListResponse,
  },

  // ── delegated access (route 21) ──
  "GET /api/v1/patients/:patientId/delegated-access": {
    summary: "The D10 delegated-access projection a portal/caregiver session resolves against",
    response: M39DelegatedAccessListResponse,
  },

  // ── decision audit (routes 22-23) ──
  "GET /api/v1/consents/:consentId/eval-audit": {
    summary: "Per-consent decision audit (cursor-paginated, §4.12)",
    query: M39ConsentEvalAuditQuery,
    response: M39EvalAuditPageResponse,
  },
  "GET /api/v1/consents/eval-audit/by-patient": {
    summary: "Patient-scoped consent-decision audit (cursor-paginated, §4.12)",
    query: M39EvalAuditByPatientQuery,
    response: M39EvalAuditPageResponse,
  },

  // ── admin + post-mortem (routes 24, 28-30) ──
  "POST /api/v1/consents/:consentId/document/re-render": {
    summary:
      "Re-emit m39.consent.signed so M22 re-renders the signed PDF (compliance-only, step-up)",
    response: M39ReRenderReceiptResponse,
  },
  "GET /api/v1/consents/post-mortem-eligible/:patientId": {
    summary: "Which of a patient's consents survive death vs terminate (M16 consumer, D13)",
    response: M39PostMortemEligibilityListResponse,
  },
  "POST /api/v1/consents/bereavement-outreach": {
    summary: "Capture post-mortem bereavement-outreach consent (D14, step-up)",
    body: M39BereavementOutreachBody,
    response: M39ConsentRecordResponse,
  },
  "POST /api/v1/consents/:consentId/cascade/retry": {
    summary: "Re-fire a stuck revocation cascade — reports partial_failed honestly (D7, step-up)",
    response: M39CascadeRetryResponse,
  },
});

// M40 MDM (Track A — Master Data Management console) — full route enrichment.
// Later Object.assign wins, so this re-covers `GET …/:kind/search` (already enriched upstream) and
// adds the other 13 routes → deficit 0. `MdmSearchQuerySchema` is the existing upstream import.
Object.assign(ROUTE_ENRICHMENTS, {
  // Reads through the MdmEntityProvider seam (canonical + this-tenant overlay; merged excluded).
  "GET /api/v1/mdm/:kind/search": {
    summary: "Search a kind's canonical master-data set (§4.2)",
    query: MdmSearchQuerySchema,
    response: M40SearchResponseSchema,
  },
  "GET /api/v1/mdm/:kind/:id": {
    summary: "Resolve one entity by kind — follows merged_into_id transparently (§4.2 / §7.2)",
    response: M40ResolvedResponseSchema,
  },
  "POST /api/v1/mdm/:kind/get-or-create": {
    summary: "Match by identifier; write a provisional if no canonical match (§4.2 / §7.1)",
    body: M40GetOrCreateBodySchema,
    response: M40GetOrCreateResponseSchema,
  },
  "PATCH /api/v1/mdm/:kind/:id/overlay": {
    summary: "Upsert this tenant's overlay (Phase-1: physician only) (§4.2)",
    body: M40OverlayBodySchema,
    response: M40OverlayAppliedResponseSchema,
  },
  "GET /api/v1/mdm/:kind/:id/relationships": {
    summary: "Canonical parent/children for the entity (no overlay join) (§4.2)",
    response: M40RelationshipsResponseSchema,
  },
  // Tenant BAA register + manual license entry.
  "GET /api/v1/mdm/baa": {
    summary: "The tenant's BAA register across MDM entities (§4.2)",
    response: M40BaaListResponseSchema,
  },
  "POST /api/v1/mdm/baa": {
    summary: "Record/update a BAA execution + expiration (§4.2)",
    body: M40BaaBodySchema,
    response: M40BaaCreatedResponseSchema,
  },
  "POST /api/v1/mdm/license/manual": {
    summary: "Enter/update a license + expiration — Phase-1 manual (§4.2)",
    body: M40LicenseBodySchema,
    response: M40LicenseRecordedResponseSchema,
  },
  // Platform-ops (keys never granted to a tenant role; approve additionally step-ups, §7.6).
  "GET /api/v1/admin/mdm/merge-requests": {
    summary: "Pending merge requests (platform-ops, §4.2)",
    response: M40MergeRequestsResponseSchema,
  },
  "POST /api/v1/admin/mdm/merge-requests/:id/approve": {
    summary: "Approve a merge — flips the duplicate to merged (step-up re-auth, §7.6)",
    response: M40MergeApprovedResponseSchema,
  },
  "POST /api/v1/admin/mdm/merge-requests/:id/reject": {
    summary: "Reject a pending merge with a reason — 204 no content (§4.2)",
    body: M40RejectBodySchema,
  },
  "POST /api/v1/admin/mdm/provisional/:id/promote": {
    summary: "Promote a provisional to canonical (§4.2)",
    response: M40ProvisionalPromotedResponseSchema,
  },
  "POST /api/v1/admin/mdm/nppes/lookup": {
    summary: "On-demand single-NPI NPPES sync (§4.2)",
    body: M40NppesLookupBodySchema,
    response: M40NppesLookupResponseSchema,
  },
  "GET /api/v1/admin/mdm/nppes/sync-log": {
    summary: "Recent NPPES sync outcomes (§4.2)",
    response: M40NppesSyncLogResponseSchema,
  },
});

// ---------------------------------------------------------------------------
// M28 FHIR Gateway — §4.1 request contracts for the thirty-nine-route surface
// (M28-T08). The FHIR-spec surface (R1-R22) authenticates with a SMART bearer
// token and returns `application/fhir+json` / OperationOutcome; the admin
// surface (R23-R39) uses the WardenX envelope. Phase 1 is READ-ONLY US Core
// R4 (`fhir.write` OFF), so every write-facing summary states what the
// boundary refuses.
// ---------------------------------------------------------------------------
Object.assign(ROUTE_ENRICHMENTS, {
  // --- FHIR-spec surface (R1-R18) ---
  "GET /fhir/r4/metadata": {
    summary:
      "The deterministic US Core R4 CapabilityStatement (R1). Anonymous per FHIR convention, rate-limited per-IP; the signed checksum is the survey-defense artifact (D11)",
  },
  "GET /fhir/.well-known/smart-configuration": {
    summary:
      "SMART Backend Services well-known config (R2). Anonymous; advertises the client-credentials + private_key_jwt token endpoint and the system/*.read scope model",
  },
  "POST /fhir/oauth2/token": {
    summary:
      "SMART Backend Services token mint (R3). Verifies the client_assertion JWT against the client's jwks_uri. Phase-1 fail-closed (`invalid_client`) until the platform-bypass client-resolution path is bound — no external client is provisioned yet",
    body: M28TokenFormBody,
  },
  "GET /fhir/r4/:resourceType/:id": {
    summary:
      "Single-resource read (R4). Bearer scope `system/{ResourceType}.read` required; the disclosure is D15-audited. Phase 1 returns a well-formed not-found OperationOutcome — the projection reader seams are fail-closed deny-stubs this wave",
  },
  "GET /fhir/r4/:resourceType": {
    summary:
      "Type-level search (R5). `patient` is the W-FHIR-14 US Core parameter. Returns a well-formed empty searchset Bundle in Phase 1; the scope check + disclosure audit are real",
    query: M28ResourceSearchQuery,
  },
  "GET /fhir/r4/Patient/:id/$everything": {
    summary:
      "Patient $everything (R6, D5). Requires read scope for every linked resource type; D15-audited. Returns a well-formed empty Bundle in Phase 1",
  },
  "POST /fhir/r4/$export": {
    summary:
      "System-level bulk export (R7, D4). 202 + Content-Location; the requested `_type` set must be a subset of the client's granted scopes or the deviating type is named in a 403 OperationOutcome",
    query: M28ExportQuery,
  },
  "POST /fhir/r4/Patient/$export": {
    summary: "All-patient bulk export (R9). Same scope + concurrency posture as the system export",
    query: M28ExportQuery,
  },
  "POST /fhir/r4/Group/:id/$export": {
    summary: "Group-scoped bulk export (R8). Same scope + concurrency posture as the system export",
    query: M28ExportQuery,
  },
  "GET /fhir/r4/$export-poll-status/:jobId": {
    summary:
      "Poll a bulk-export job (R10). 202 In-Progress | 200 Completed (with the output manifest) | 410 Expired once the 24h NDJSON TTL has passed",
  },
  "DELETE /fhir/r4/$export-poll-status/:jobId": {
    summary: "Cancel a bulk-export job (R11). 202 Accepted; the job's in-flight status is closed",
  },
  "GET /fhir/r4/CodeSystem/:system": {
    summary:
      "CodeSystem read (R12). Requires `system/CodeSystem.read`. Not served in Phase 1 (a warning OperationOutcome), which the terminology seam fills when M38 binds live",
  },
  "POST /fhir/r4/CodeSystem/$validate-code": {
    summary:
      "CodeSystem $validate-code (R13). Requires `system/CodeSystem.read`; returns a well-formed Parameters result",
    body: M28ValidateCodeBody,
  },
  "GET /fhir/r4/ValueSet/:vs": {
    summary: "ValueSet read (R14). Requires `system/ValueSet.read`; not served in Phase 1",
  },
  "GET /fhir/r4/ValueSet/:vs/$expand": {
    summary:
      "ValueSet $expand (R15). Requires `system/ValueSet.read`; returns a well-formed empty expansion in Phase 1",
  },
  "POST /fhir/r4/:resourceType": {
    summary:
      "Inbound staging (R16, D8). Requires `system/{ResourceType}.write`. M28 NEVER writes a native record — it stages the resource as a PROPOSAL the owner module (m5/m12) reviews; an unsupported resource type is a 501",
  },
  "GET /fhir/r5/*": {
    summary:
      "FHIR R5 is not supported (R17, D1/D7) — 415 Unsupported Media Type + OperationOutcome",
  },
  "GET /fhir/r6/*": {
    summary:
      "FHIR R6 is not supported (R18, D1/D7) — 415 Unsupported Media Type + OperationOutcome",
  },
  // --- client registry admin (R23-R30) ---
  "GET /api/v1/fhir/clients": {
    summary: "List the org's registered FHIR clients (R23)",
    query: M28ClientListQuery,
  },
  "POST /api/v1/fhir/clients": {
    summary:
      "Propose a new FHIR client (R24, D12). The proposing Org Admin is stamped as the FIRST of the two DISTINCT dual-approval approvers; `rate_limit_rps` is platform-floor / tighten-only and an override may only LOWER the tier floor",
    body: M28CreateClientBody,
  },
  "POST /api/v1/fhir/clients/:id/approve": {
    summary:
      "The Compliance Officer co-approves (R25, D12). The store refuses self-approval — the two approver memberships must be DISTINCT",
    body: M28ApproveClientBody,
  },
  "POST /api/v1/fhir/clients/:id/revoke": {
    summary:
      "Revoke a client (R26). Terminal; runs the W-FHIR-12 cascade — every live session is revoked and every in-flight export cancelled inside the same transaction. Rationale ≥40 chars",
    body: M28RevokeClientBody,
  },
  "POST /api/v1/fhir/clients/:id/suspend": {
    summary:
      "Suspend a client (R27). Reversible, but also runs the cascade — a suspended client's live bearer tokens must die now, not at their TTL",
    body: M28SuspendClientBody,
  },
  "POST /api/v1/fhir/clients/:id/credentials/rotate": {
    summary:
      "Rotate the API-key credential (R28). The prior credential is retired with a 30-day overlap; the plaintext secret is returned ONCE and never persisted in the clear",
  },
  "GET /api/v1/fhir/clients/:id/sessions": {
    summary: "List a client's active bearer sessions (R29)",
  },
  "POST /api/v1/fhir/clients/:id/sessions/:jti/revoke": {
    summary: "Manually revoke one session (R30) — a leaked bearer token dies immediately",
  },
  // --- bulk export admin (R31-R33) ---
  "GET /api/v1/fhir/bulk-export-jobs": {
    summary: "List the org's bulk-export jobs (R31)",
    query: M28BulkExportListQuery,
  },
  "POST /api/v1/fhir/bulk-export-jobs": {
    summary:
      "Operator-initiated bulk export (R32). The acting membership is stamped as the initiator, which is what `bulk_export_initiator_or_admin` reads at cancel time",
    body: M28InitiateBulkExportBody,
  },
  "POST /api/v1/fhir/bulk-export-jobs/:id/cancel": {
    summary:
      "Cancel a job (R33). Gated on `bulk_export_initiator_or_admin` (§4.7) — the initiator, the bearer client, or a cancel-permitted operator",
  },
  // --- inbound proposal review (R34-R36) ---
  "GET /api/v1/fhir/inbound-proposals": {
    summary: "The operator review queue of staged inbound proposals (R34)",
    query: M28InboundListQuery,
  },
  "POST /api/v1/fhir/inbound-proposals/:id/accept": {
    summary:
      "Accept a staged proposal (R35, D8). Gated on `fhir_inbound_owner_module_match` — only a reviewer holding the owner module's native write path may decide it. The owner module now owns the native record it created",
    body: M28AcceptProposalBody,
  },
  "POST /api/v1/fhir/inbound-proposals/:id/reject": {
    summary:
      "Reject a staged proposal (R36, D8). Gated on `fhir_inbound_owner_module_match`; the rationale must be ≥40 chars and the payload is destruction-scheduled at +30 days (§3.7)",
    body: M28RejectProposalBody,
  },
  // --- tenant config (R37-R39) ---
  "GET /api/v1/fhir/config": {
    summary: "Read the tenant's FHIR config (R37)",
  },
  "PUT /api/v1/fhir/config": {
    summary: "Upsert the tenant's FHIR host + identifier-URI base + review/dedup knobs (R38)",
    body: M28PutConfigBody,
  },
  "POST /api/v1/fhir/config/rotate-cursor-key": {
    summary:
      "Rotate the per-tenant HMAC cursor-signing key (R39). STEP-UP required — the rotation invalidates every outstanding signed search cursor, so a stolen session must not be able to do it. The key never leaves the server",
  },
});

// ── M29 External Interfaces (§4.1 operator + §4.2 clinician) ─────────────────────────────────────────
// Appended as a trailing `Object.assign(ROUTE_ENRICHMENTS, {...})` — later wins, so this covers every M29
// route the scanner discovers (openapi:coverage floor for a new module is 0 — an unenriched route fails).
Object.assign(ROUTE_ENRICHMENTS, {
  // §4.1.1 feed + credential admin
  "GET /api/admin/external-interfaces/feeds": {
    summary: "List the org's HL7/NPPES feeds, filterable by kind/status (§4.1.1)",
    query: M29FeedListQuery,
  },
  "POST /api/admin/external-interfaces/feeds": {
    summary:
      "Create a feed (step-up, D18). Lands `pending_approval`: the proposing operator is stamped as the first of two DISTINCT dual-approval actors; a compliance officer activates (§4.1.1)",
    body: M29CreateFeedBody,
  },
  "GET /api/admin/external-interfaces/feeds/:feedId": {
    summary: "Single feed detail incl. redacted credential metadata — NEVER ciphertext (§4.1.1)",
  },
  "PATCH /api/admin/external-interfaces/feeds/:feedId": {
    summary: "Edit non-credential feed metadata (step-up, D18) (§4.1.1)",
    body: M29UpdateFeedBody,
  },
  "POST /api/admin/external-interfaces/feeds/:feedId/activate": {
    summary:
      "Activate a feed: pending_approval → active. Requires a compliance co-approver DISTINCT from the operator (D18) AND the M40 BAA gate (`external_feed_baa_satisfied`, D16) (§4.1.1)",
  },
  "POST /api/admin/external-interfaces/feeds/:feedId/suspend": {
    summary: "Suspend an active feed; the listener unbinds (reason required, step-up) (§4.1.1)",
    body: M29SuspendFeedBody,
  },
  "POST /api/admin/external-interfaces/feeds/:feedId/revoke": {
    summary:
      "Terminally revoke a feed (dual-approval, `external_feed_compliance_co_approver_distinct`, D20; step-up). The row is retained so every message FK resolves (§4.1.1)",
    body: M29RevokeFeedBody,
  },
  "POST /api/admin/external-interfaces/feeds/:feedId/credentials": {
    summary:
      "Mint / rotate a channel credential (step-up, D18). The prior active credential of the kind is retired; the secret is stored as its sha256 digest (no DEK bound in Phase 1) and never returned in the clear (§4.1.1)",
    body: M29MintCredentialBody,
  },
  "GET /api/admin/external-interfaces/feeds/:feedId/credentials": {
    summary: "List credential metadata (fingerprint + status only, NEVER ciphertext) (§4.1.1)",
  },
  "GET /api/admin/external-interfaces/feeds/:feedId/health": {
    summary: "Current rolling per-hour health snapshot for a feed (§4.1.1)",
  },
  // §4.1.2 ADT proposal review
  "GET /api/admin/external-interfaces/inbound-proposals": {
    summary:
      "List the propose-then-review ADT queue, filterable by status/owner_module/feed (§4.1.2)",
    query: M29ProposalListQuery,
  },
  "GET /api/admin/external-interfaces/inbound-proposals/:proposalId": {
    summary: "Single ADT proposal detail (owner-module-scoped, D5) (§4.1.2)",
  },
  "POST /api/admin/external-interfaces/inbound-proposals/:proposalId/accept": {
    summary:
      "Adjudicate ACCEPT — apply via the owner module's native write path (`hl7_inbound_proposal_owner_module_match`, step-up D18). Decided-is-decided (§4.1.2)",
    body: M29AcceptProposalBody,
  },
  "POST /api/admin/external-interfaces/inbound-proposals/:proposalId/reject": {
    summary:
      "Adjudicate REJECT — no mutation; rationale ≥40 chars (W-XI-04); owner-module-gated + step-up (§4.1.2)",
    body: M29RejectProposalBody,
  },
  "POST /api/admin/external-interfaces/inbound-proposals/:proposalId/defer": {
    summary: "Punt a proposal to a caseload-RN task (M19 forward-seam); stays `pending` (§4.1.2)",
    body: M29DeferProposalBody,
  },
  // §4.1.3 message search / replay / retry / decrypt
  "GET /api/admin/external-interfaces/messages/inbound": {
    summary: "Search inbound HL7 messages (metadata only, no plaintext) (§4.1.3)",
    query: M29InboundMessageListQuery,
  },
  "GET /api/admin/external-interfaces/messages/inbound/:messageId": {
    summary:
      "Single inbound message — metadata only; plaintext is the dedicated decrypt route (§4.1.3)",
  },
  "POST /api/admin/external-interfaces/messages/inbound/:messageId/decrypt": {
    summary:
      "Server-side plaintext decrypt for compliance review (step-up; a §164.528 disclosure). Phase-1 fail-closed 501 until the per-tenant DEK envelope binds (§4.1.3)",
  },
  "POST /api/admin/external-interfaces/messages/inbound/:messageId/replay": {
    summary:
      "Re-enqueue a parse_error/rejected inbound message for parsing/matching (step-up) (§4.1.3)",
  },
  "GET /api/admin/external-interfaces/messages/outbound": {
    summary: "Search outbound HL7 messages, filterable by placer order / dispatch status (§4.1.3)",
    query: M29OutboundMessageListQuery,
  },
  "GET /api/admin/external-interfaces/messages/outbound/:messageId": {
    summary: "Single outbound message incl. the ACK/NACK chain (§4.1.3)",
  },
  "POST /api/admin/external-interfaces/messages/outbound/:messageId/retry": {
    summary:
      "Manual retry of a failed/dlq outbound message after a DLQ landing (D9; step-up) (§4.1.3)",
  },
  // §4.1.4 NPPES administration
  "GET /api/admin/external-interfaces/nppes/providers/:npi": {
    summary: "Read one cached platform-shared NPPES provider (public directory, no PHI) (§4.1.4)",
  },
  "GET /api/admin/external-interfaces/nppes/sync-runs": {
    summary: "List NPPES sync-run history (§4.1.4)",
    query: M29NppesSyncRunListQuery,
  },
  "POST /api/admin/external-interfaces/nppes/sync-runs": {
    summary:
      "Trigger a manual NPPES sync — platform-only (`nppes_platform_job_caller`, W-XI-12; step-up). A tenant session is refused; the real sync runs under the platform scheduler (§4.1.4)",
    body: M29NppesSyncTriggerBody,
  },
  // §4.1.5 ops
  "GET /api/admin/external-interfaces/health/aggregate": {
    summary:
      "Tenant feed-health overview — listener up/down, message + parse-error counts (§4.1.5)",
  },
  "GET /api/admin/external-interfaces/metrics/listener-status": {
    summary: "Per-feed listener socket status (up/down + last message time) (§4.1.5)",
  },
  // §4.2 clinician lab surface
  "GET /api/clinical/labs/observations": {
    summary: "List caseload lab observations, filterable by patient/loinc/abnormal-flag (§4.2)",
    query: M29ObservationListQuery,
  },
  "GET /api/clinical/labs/observations/unmatched": {
    summary:
      "The unmatched-lab review queue (failed patient-match cascade, D6; review-unmatched role) (§4.2)",
    query: M29ObservationListQuery,
  },
  "GET /api/clinical/labs/observations/:observationId": {
    summary:
      "Single observation with its value rows (`lab_observation_patient_caseload_or_scope`, D20) (§4.2)",
  },
  "POST /api/clinical/labs/observations/:observationId/attach-patient": {
    summary:
      "Manual patient attach for an unmatched result (step-up). Phase-1 fail-closed 501: materializing a lab_observation from the stored wire message lands in T-29.13 (§4.2)",
    body: M29AttachPatientBody,
  },
  "POST /api/clinical/labs/observations/:observationId/discard": {
    summary:
      "Discard an unmatched result (reason required, step-up). Phase-1 deferred to T-29.13 (§4.2)",
    body: M29DiscardObservationBody,
  },
  "POST /api/clinical/labs/observations/:observationId/acknowledge-abnormal": {
    summary: "RN acknowledges an abnormal-flag alert; clears the M36 badge (D7) (§4.2)",
  },
});

// ── M37 Inpatient Unit (IPU) Management — the §4.2 request/response DTOs the T11b core route spine binds
// (the same TypeBox schemas the handlers `parse(...)` / return, so the contract cannot drift). The
// remaining §4.1 routes are enriched as they land.
import {
  AdmissionListSchema as M37AdmissionListSchema,
  AdmissionViewSchema as M37AdmissionViewSchema,
  AdvanceBodyReleaseBodySchema as M37AdvanceBodyReleaseBodySchema,
  ApplyRestraintBodySchema as M37ApplyRestraintBodySchema,
  ApplyVisitorRestrictionBodySchema as M37ApplyVisitorRestrictionBodySchema,
  AssignBedBodySchema as M37AssignBedBodySchema,
  AssignEquipmentBedBodySchema as M37AssignEquipmentBedBodySchema,
  AssignStaffBodySchema as M37AssignStaffBodySchema,
  AttestGipBodySchema as M37AttestGipBodySchema,
  BedCleaningBodySchema as M37BedCleaningBodySchema,
  BedListSchema as M37BedListSchema,
  BedViewSchema as M37BedViewSchema,
  BodyReleaseViewSchema as M37BodyReleaseViewSchema,
  CensusListSchema as M37CensusListSchema,
  CheckInVisitorBodySchema as M37CheckInVisitorBodySchema,
  ConfirmBodySchema as M37ConfirmBodySchema,
  ConfirmTransferBodySchema as M37ConfirmTransferBodySchema,
  CreateBedBodySchema as M37CreateBedBodySchema,
  CreateEquipmentBodySchema as M37CreateEquipmentBodySchema,
  CreateRoomBodySchema as M37CreateRoomBodySchema,
  CreateShiftBodySchema as M37CreateShiftBodySchema,
  CreateUnitBodySchema as M37CreateUnitBodySchema,
  DischargeBodySchema as M37DischargeBodySchema,
  EquipmentListSchema as M37EquipmentListSchema,
  EquipmentViewSchema as M37EquipmentViewSchema,
  GipCriteriaViewSchema as M37GipCriteriaViewSchema,
  InitiateTransferBodySchema as M37InitiateTransferBodySchema,
  IrcEpisodeViewSchema as M37IrcEpisodeViewSchema,
  IrcOverrideBodySchema as M37IrcOverrideBodySchema,
  LiftVisitorRestrictionBodySchema as M37LiftVisitorRestrictionBodySchema,
  LogInspectionBodySchema as M37LogInspectionBodySchema,
  LogMaintenanceBodySchema as M37LogMaintenanceBodySchema,
  LogMealBodySchema as M37LogMealBodySchema,
  MealViewSchema as M37MealViewSchema,
  OpenAdmissionBodySchema as M37OpenAdmissionBodySchema,
  ReassessGipBodySchema as M37ReassessGipBodySchema,
  ReassessRestraintBodySchema as M37ReassessRestraintBodySchema,
  RequestBedBodySchema as M37RequestBedBodySchema,
  RestraintViewSchema as M37RestraintViewSchema,
  RnBreakGlassViewSchema as M37RnBreakGlassViewSchema,
  RnCoverageViewSchema as M37RnCoverageViewSchema,
  RoomListSchema as M37RoomListSchema,
  RoomViewSchema as M37RoomViewSchema,
  ShiftListSchema as M37ShiftListSchema,
  ShiftViewSchema as M37ShiftViewSchema,
  StaffAssignmentViewSchema as M37StaffAssignmentViewSchema,
  UnassignStaffBodySchema as M37UnassignStaffBodySchema,
  UnitListSchema as M37UnitListSchema,
  UnitViewSchema as M37UnitViewSchema,
  UpdateBedBodySchema as M37UpdateBedBodySchema,
  UpdateRoomBodySchema as M37UpdateRoomBodySchema,
  UpdateUnitBodySchema as M37UpdateUnitBodySchema,
  VisitorRestrictionViewSchema as M37VisitorRestrictionViewSchema,
  VisitorViewSchema as M37VisitorViewSchema,
} from "../../apps/backend/src/modules/37-ipu/routes/ipu-typebox";

Object.assign(ROUTE_ENRICHMENTS, {
  "GET /api/v1/inpatient-units": {
    response: M37UnitListSchema,
    summary: "List IPU units for the org (§4.1)",
  },
  "POST /api/v1/inpatient-units": {
    body: M37CreateUnitBodySchema,
    response: M37UnitViewSchema,
    summary: "Create an IPU unit (org admin; step-up). RN-coverage-exempt admin route (§2.3)",
  },
  "PATCH /api/v1/inpatient-units/:id": {
    body: M37UpdateUnitBodySchema,
    response: M37UnitViewSchema,
    summary: "Update IPU unit config (§4.1)",
  },
  "POST /api/v1/inpatient-units/:id/deactivate": {
    response: M37UnitViewSchema,
    summary: "Deactivate an IPU unit (step-up, §4.1)",
  },
  "GET /api/v1/inpatient-units/:id/rooms": {
    response: M37RoomListSchema,
    summary: "List rooms in a unit (§4.1)",
  },
  "POST /api/v1/inpatient-units/:id/rooms": {
    body: M37CreateRoomBodySchema,
    response: M37RoomViewSchema,
    summary: "Create a room (§4.1)",
  },
  "PATCH /api/v1/ipu-rooms/:id": {
    body: M37UpdateRoomBodySchema,
    response: M37RoomViewSchema,
    summary: "Update room config (§4.1)",
  },
  "GET /api/v1/ipu-rooms/:id/beds": {
    response: M37BedListSchema,
    summary: "List beds in a room (§4.1)",
  },
  "POST /api/v1/ipu-rooms/:id/beds": {
    body: M37CreateBedBodySchema,
    response: M37BedViewSchema,
    summary: "Create a bed (§4.1)",
  },
  "PATCH /api/v1/ipu-beds/:id": {
    body: M37UpdateBedBodySchema,
    response: M37BedViewSchema,
    summary: "Update bed geofence/label (§4.1)",
  },
  "GET /api/v1/ipu-admissions": {
    response: M37AdmissionListSchema,
    summary: "List IPU admissions (§4.1)",
  },
  "POST /api/v1/ipu-admissions": {
    body: M37OpenAdmissionBodySchema,
    response: M37AdmissionViewSchema,
    summary:
      "Open an IPU admission. GIP/IRC compose the m37.ipu.rn_coverage_active gate (412 IPU_RN_COVERAGE_UNAVAILABLE when the unit is uncovered); arranged remote-IPU bypasses (§2.2/§2.3)",
  },
  "GET /api/v1/ipu-admissions/:id": {
    response: M37AdmissionViewSchema,
    summary: "Read an IPU admission (§4.1)",
  },
  "POST /api/v1/ipu-beds/:id/cleaning-status": {
    body: M37BedCleaningBodySchema,
    response: M37BedViewSchema,
    summary:
      "Transition a bed's §2.12 cleaning state (409 ILLEGAL_BED_CLEANING_TRANSITION on an illegal edge); writes the ipu_bed_cleaning_event ledger row + emits the M33/M36 signal",
  },
  "POST /api/v1/ipu-admissions/:id/request-bed": {
    body: M37RequestBedBodySchema,
    response: M37AdmissionViewSchema,
    summary:
      "Transition an admission to bed_pending (RN-coverage gated; requires an active unit + a ready bed, §2.2)",
  },
  "POST /api/v1/ipu-admissions/:id/assign-bed": {
    body: M37AssignBedBodySchema,
    response: M37AdmissionViewSchema,
    summary:
      "Assign a specific bed (bed_assigned); reserves the bed + persists the assignment; 409 if the bed is not ready (§2.2)",
  },
  "POST /api/v1/ipu-admissions/:id/discharge": {
    body: M37DischargeBodySchema,
    response: M37AdmissionViewSchema,
    summary:
      "Discharge an admission; dirties the source bed + closes the irc_episode for an IRC stay (§2.2)",
  },
  "POST /api/v1/ipu-admissions/:id/confirm": {
    body: M37ConfirmBodySchema,
    response: M37AdmissionViewSchema,
    summary:
      "M6 LCP-ack handler: activate the admission; GIP requires attested criteria (412), IRC opens the episode (§2.2)",
  },
  "POST /api/v1/ipu-admissions/:id/initiate-transfer": {
    body: M37InitiateTransferBodySchema,
    response: M37AdmissionViewSchema,
    summary:
      "Begin a transfer (RN-coverage gated for to_unit); persists the transition ledger row (§2.2)",
  },
  "POST /api/v1/ipu-admissions/:id/confirm-transfer": {
    body: M37ConfirmTransferBodySchema,
    response: M37AdmissionViewSchema,
    summary: "Complete a transfer; dirties the source bed + ends the assignment (§2.2)",
  },
  "POST /api/v1/ipu-admissions/:id/gip-criteria": {
    body: M37AttestGipBodySchema,
    response: M37GipCriteriaViewSchema,
    summary:
      "Attest GIP criteria (step-up); the 3-kind discriminated union (422 on an invalid payload) (§2.4)",
  },
  "POST /api/v1/ipu-admissions/:id/gip-criteria/reassess": {
    body: M37ReassessGipBodySchema,
    response: M37GipCriteriaViewSchema,
    summary: "Record a GIP reassessment (rationale >=50) (§2.4)",
  },
  "POST /api/v1/ipu-admissions/:id/irc-cap-override": {
    body: M37IrcOverrideBodySchema,
    response: M37IrcEpisodeViewSchema,
    summary:
      "Break-glass IRC cap override (step-up; reason >=100; <=2 days) — recomputes the episode state (§2.5)",
  },
  "POST /api/v1/ipu-admissions/:id/restraint": {
    body: M37ApplyRestraintBodySchema,
    response: M37RestraintViewSchema,
    summary:
      "Apply a restraint (step-up + m37.ipu.rn_coverage_active). 422 on missing physician order / <100-char justification; 403 without step-up (§2.10)",
  },
  "POST /api/v1/ipu-restraint/:id/reassess": {
    body: M37ReassessRestraintBodySchema,
    response: M37RestraintViewSchema,
    summary:
      "Record a restraint reassessment (continue/modify/release); 409 on an already-released event (§2.10)",
  },
  "POST /api/v1/ipu-restraint/:id/release": {
    response: M37RestraintViewSchema,
    summary: "Release a restraint (§2.10)",
  },
  "GET /api/v1/ipu-shifts": { response: M37ShiftListSchema, summary: "List IPU shifts (§4.1)" },
  "POST /api/v1/ipu-shifts": {
    body: M37CreateShiftBodySchema,
    response: M37ShiftViewSchema,
    summary: "Create an IPU shift (§4.1)",
  },
  "POST /api/v1/ipu-shifts/:id/staff": {
    body: M37AssignStaffBodySchema,
    response: M37StaffAssignmentViewSchema,
    summary: "Assign staff to a shift (§4.1)",
  },
  "DELETE /api/v1/ipu-shifts/:id/staff": {
    body: M37UnassignStaffBodySchema,
    response: M37StaffAssignmentViewSchema,
    summary: "Cancel a staff assignment (§4.1)",
  },
  "GET /api/v1/ipu-units/:id/rn-coverage": {
    response: M37RnCoverageViewSchema,
    summary: "Read the unit's RN-coverage window grid (§2.3)",
  },
  "POST /api/v1/ipu-units/:id/rn-coverage/break-glass": {
    response: M37RnBreakGlassViewSchema,
    summary: "Invoke an RN-coverage break-glass override (step-up; max 4h; §2.3)",
  },
  "POST /api/v1/ipu-visitors": {
    body: M37CheckInVisitorBodySchema,
    response: M37VisitorViewSchema,
    summary: "Check in a visitor; 412 on full_block / immediate_family_only restriction (§2.7)",
  },
  "POST /api/v1/ipu-visitors/:id/check-out": {
    response: M37VisitorViewSchema,
    summary: "Check out a visitor (§4.1)",
  },
  "POST /api/v1/ipu-visitor-restrictions": {
    body: M37ApplyVisitorRestrictionBodySchema,
    response: M37VisitorRestrictionViewSchema,
    summary: "Apply a unit/patient visitor restriction (§2.7)",
  },
  "DELETE /api/v1/ipu-visitor-restrictions": {
    body: M37LiftVisitorRestrictionBodySchema,
    response: M37VisitorRestrictionViewSchema,
    summary: "Lift a visitor restriction (§2.7)",
  },
  "POST /api/v1/ipu-meals": {
    body: M37LogMealBodySchema,
    response: M37MealViewSchema,
    summary: "Log a meal-service entry (§2.8)",
  },
  "GET /api/v1/ipu-equipment": {
    response: M37EquipmentListSchema,
    summary: "List IPU equipment (§4.1)",
  },
  "POST /api/v1/ipu-equipment": {
    body: M37CreateEquipmentBodySchema,
    response: M37EquipmentViewSchema,
    summary: "Create an equipment asset (§4.1)",
  },
  "POST /api/v1/ipu-equipment/:id/maintenance": {
    body: M37LogMaintenanceBodySchema,
    response: M37EquipmentViewSchema,
    summary: "Log equipment maintenance (§2.9)",
  },
  "POST /api/v1/ipu-equipment/:id/inspection": {
    body: M37LogInspectionBodySchema,
    response: M37EquipmentViewSchema,
    summary: "Log a biomed inspection; rolls next_inspection_due_date forward (§2.9)",
  },
  "POST /api/v1/ipu-equipment/:id/assign-bed": {
    body: M37AssignEquipmentBedBodySchema,
    response: M37EquipmentViewSchema,
    summary:
      "Assign equipment to a bed/patient; 412 EQUIPMENT_INSPECTION_OVERDUE on an overdue inspection (§2.9)",
  },
  "GET /api/v1/ipu-body-release/:admissionId": {
    response: M37BodyReleaseViewSchema,
    summary: "Read a body-release record (§2.11)",
  },
  "POST /api/v1/ipu-body-release/:admissionId": {
    body: M37AdvanceBodyReleaseBodySchema,
    response: M37BodyReleaseViewSchema,
    summary:
      "Advance body-release (identifyFuneralHome/releaseBody/postClose); releaseBody resumes bed cleaning (§2.11)",
  },
  "GET /api/v1/ipu-census/:date": {
    response: M37CensusListSchema,
    summary: "Read the IPU census snapshot for a date (§4.1)",
  },
});

// ── WX-PR-015 body/response gap-fill — 35-subscription ─────────────────────────────────────────
// M35 Subscription Billing — WX-PR-015 body-schema fill-in for 10 admin/tenant action routes whose
// handlers accept a body but never `parse()` it (dunning reset/skip-stage, plan activate/deprecate,
// refund approve, subscription cancel/resume admin+tenant, setup_intent). Since the handlers read
// nothing off `request.body`, the honest contract is "no body fields" — a locally-authored empty-object
// schema (matches the same `Type.Object({}, { additionalProperties: false })` shape M02/M19 use for their
// genuinely-empty action bodies) rather than inventing fields the service layer never consumes.
const M35EmptyActionBody = Type.Object({}, { additionalProperties: false });

Object.assign(ROUTE_ENRICHMENTS, {
  "POST /api/admin/dunning/:subscriptionId/reset": {
    body: M35EmptyActionBody,
    response: M35DunningDto,
    summary: "Reset dunning",
  },
  "POST /api/admin/dunning/:subscriptionId/skip_stage": {
    body: M35EmptyActionBody,
    response: M35DunningDto,
    summary: "Skip dunning stage",
  },
  "POST /api/admin/plans/:id/activate": {
    body: M35EmptyActionBody,
    response: M35PlanAdminDto,
    summary: "Activate plan",
  },
  "POST /api/admin/plans/:id/deprecate": {
    body: M35EmptyActionBody,
    response: M35PlanAdminDto,
    summary: "Deprecate plan",
  },
  "POST /api/admin/refunds/:id/approve": {
    body: M35EmptyActionBody,
    response: M35RefundDto,
    summary: "Approve refund",
  },
  "POST /api/admin/subscriptions/:id/cancel": {
    body: M35EmptyActionBody,
    response: M35SubscriptionAdminResponseDto,
    summary: "Cancel immediately",
  },
  "POST /api/admin/subscriptions/:id/resume": {
    body: M35EmptyActionBody,
    response: M35SubscriptionAdminResponseDto,
    summary: "Resume subscription (admin)",
  },
  "POST /api/v1/payment_methods/setup_intent": {
    body: M35EmptyActionBody,
    response: M35SetupIntentResponseDto,
    summary: "Create Stripe SetupIntent",
  },
  "POST /api/v1/subscription/cancel": {
    body: M35EmptyActionBody,
    response: M35SubscriptionResponseDto,
    summary: "Cancel at period end",
  },
  "POST /api/v1/subscription/resume": {
    body: M35EmptyActionBody,
    response: M35SubscriptionResponseDto,
    summary: "Resume subscription",
  },
});

// ── WX-PR-015 body/response gap-fill — 25-remittance ─────────────────────────────────────────
// M25 Remittance & Denials — body-schema gap-fill for 3 routes whose handlers parse no request body
// (ack / start / close are pure state-transition PATCH/POST routes gated by the If-Match header only,
// not by any request.body field — see appeals.routes.ts / denials.routes.ts). No new imports are needed:
// `Type` (from "@sinclair/typebox") and `M25VersionedResultSchema` (from
// "../../apps/backend/src/modules/25-remittance/routes/m25-typebox") are already imported earlier in
// this file. This Object.assign re-states each route's existing `summary`/`response` verbatim (Object.assign
// replaces the whole entry per key, so omitting them would regress the routes already enriched at
// "PATCH /api/v1/denials/:id/start", "POST /api/v1/denials/:id/close", and "PATCH /api/v1/appeals/:id/ack")
// and adds an explicit empty-object `body` schema — honest to what the handler actually accepts (nothing).

const M25RemittanceEmptyBodySchema = Type.Object(
  {},
  {
    additionalProperties: false,
    description:
      "No body fields are read by this route; If-Match header carries the concurrency token.",
  },
);

Object.assign(ROUTE_ENRICHMENTS, {
  "PATCH /api/v1/appeals/:id/ack": {
    summary: "Record the payer's receipt acknowledgement of an appeal (§4.1)",
    body: M25RemittanceEmptyBodySchema,
    response: M25VersionedResultSchema,
  },
  "POST /api/v1/denials/:id/close": {
    summary: "Close a resolved denial case (§4.1)",
    body: M25RemittanceEmptyBodySchema,
    response: M25VersionedResultSchema,
  },
  "PATCH /api/v1/denials/:id/start": {
    summary: "Start work on a denial case (→ in_progress, §4.1)",
    body: M25RemittanceEmptyBodySchema,
    response: M25VersionedResultSchema,
  },
});

// ── WX-PR-015 body/response gap-fill — 31-portal ─────────────────────────────────────────
// M31 Portal/Telehealth (WX-PR-015) — body-schema gap fill. None of these 6 handlers actually parse a
// request body (verified in apps/backend/src/modules/31-portal/routes/{admin,write,session,telehealth}.routes.ts
// — no `parse(...)`/`request.body` read on any of them), so the accurate contract is an empty object body,
// not an invented shape. `summary`/`response` below are copied verbatim from the existing entries for these
// same keys earlier in this file so this Object.assign only ADDS `body` and does not regress them.
const M31EmptyBody = Type.Object({}, { additionalProperties: false });

Object.assign(ROUTE_ENRICHMENTS, {
  "POST /api/v1/admin/portal-invitations/:id/revoke": {
    summary: "Revoke a portal invite before acceptance",
    body: M31EmptyBody,
    response: M31AckResponse,
  },
  "POST /api/v1/portal/documents/upload-complete/:uploadId": {
    summary: "Confirm the M22 intake batch received",
    body: M31EmptyBody,
    response: M31UploadCompleteResponse,
  },
  "POST /api/v1/portal/sessions/logout": {
    summary: "Server-side portal session close",
    body: M31EmptyBody,
    response: M31AckResponse,
  },
  "POST /api/v1/portal/telehealth/visits/:visitId/leave": {
    summary: "Portal-side telehealth leave (idempotent)",
    body: M31EmptyBody,
    response: M31AckResponse,
  },
  "POST /api/v1/telehealth/visits/:visitId/join": {
    summary: "Clinician-side telehealth join — mints a participant token",
    body: M31EmptyBody,
    response: M31TelehealthJoinResponse,
  },
  "POST /api/v1/telehealth/visits/:visitId/leave": {
    summary: "Clinician-side telehealth leave",
    body: M31EmptyBody,
    response: M31AckResponse,
  },
});

// ── WX-PR-015 body/response gap-fill — 34-saas-tenant-platform ─────────────────────────────────────────
import { ElevateSessionRequest as M34ElevateSessionRequest } from "../../apps/backend/src/modules/34-saas-tenant-platform/routes/platform/platform-typebox";
import {
  DsarFulfillRequest as M34DsarFulfillRequest,
  OnboardingStartRequest as M34OnboardingStartRequest,
} from "../../apps/backend/src/modules/34-saas-tenant-platform/routes/tenant/tenant-typebox";

Object.assign(ROUTE_ENRICHMENTS, {
  "POST /api/v1/platform/support-sessions/:id/elevate": {
    summary: "Elevate for the PHI write window (fresh passkey-2min; Part 2-heightened → 403)",
    body: M34ElevateSessionRequest,
    response: M34ElevateSessionAckSchema,
  },
  "POST /api/v1/tenant/dsar-export-jobs/:id/fulfill": {
    summary: "Flip a DSAR job to fulfilled + trigger presigned-URL email (step-up)",
    body: M34DsarFulfillRequest,
    response: M34DsarExportJobViewSchema,
  },
  "POST /api/v1/tenant/onboarding/:taskId/start": {
    summary: "Advance an onboarding task pending → in_progress",
    body: M34OnboardingStartRequest,
    response: M34OnboardingTaskViewSchema,
  },
});

// ── WX-PR-015 body/response gap-fill — 30-quality ─────────────────────────────────────────
const M30EmptyIncidentActionBody = Type.Object({});

Object.assign(ROUTE_ENRICHMENTS, {
  "POST /api/v1/quality/incidents/:incidentId/submit": {
    body: M30EmptyIncidentActionBody,
    summary:
      "Submit a draft incident for triage (draft to submitted; reporter-owned, no body fields consumed) (Sec 4.1 R-54)",
  },
  "POST /api/v1/quality/incidents/:incidentId/close": {
    body: M30EmptyIncidentActionBody,
    summary:
      "Close a resolved incident (resolved to closed_followup_complete; no body fields consumed) (Sec 4.1 R-59)",
  },
});

// ── WX-PR-015 body/response gap-fill — 23-billing-medicare ─────────────────────────────────────────
// M23 Billing — Medicare: response schemas newly authored to mirror the REAL DTOs the route handlers
// return (apps/backend/src/modules/23-billing-medicare/routes/read-service.ts + read-service-drizzle.ts),
// NOT the packages/billing/src/schemas/*.ts contracts - those are marked TODO(P2) SKELETON shapes in
// packages/billing/src/contracts.ts and have drifted from the live Drizzle-backed projections (e.g. the
// package ClaimSummaryView omits organizationId/macJurisdiction/payerClaimControlNumber/
// totalExpectedPaymentCents that the live DTO carries, and the package PageOf() envelope omits hasMore
// that every live CursorPage carries). Reusing the drifted package schemas here would silently add/drop
// fields relative to what the handler actually returns, which is exactly what this enrichment pass must
// not do - so these are freshly authored, field-for-field, off the read-service.ts interfaces instead.
// The route-level QUERY schemas referenced below (ClaimListQuerySchema, NoeListQuerySchema, etc.) are
// already imported earlier in this file from billing-typebox and are reused as-is (module top-level scope).

const M23ClaimState = Type.Union([
  Type.Literal("draft"),
  Type.Literal("validating"),
  Type.Literal("ready"),
  Type.Literal("submitted"),
  Type.Literal("ack_pending"),
  Type.Literal("ack_accepted"),
  Type.Literal("ack_partial"),
  Type.Literal("ack_rejected"),
  Type.Literal("paid"),
  Type.Literal("partial_paid"),
  Type.Literal("denied"),
  Type.Literal("replaced"),
  Type.Literal("voided"),
]);
const M23TypeOfBill = Type.Union([
  Type.Literal("811"),
  Type.Literal("812"),
  Type.Literal("813"),
  Type.Literal("814"),
  Type.Literal("817"),
  Type.Literal("818"),
]);
const M23LevelOfCare = Type.Union([
  Type.Literal("routine_home_care"),
  Type.Literal("continuous_home_care"),
  Type.Literal("inpatient_respite_care"),
  Type.Literal("general_inpatient_care"),
]);
const M23NoticeState = Type.Union([
  Type.Literal("draft"),
  Type.Literal("ready"),
  Type.Literal("submitted"),
  Type.Literal("ack_pending"),
  Type.Literal("ack_accepted"),
  Type.Literal("ack_rejected"),
  Type.Literal("cancelled"),
]);
const M23EligibilityOutcome = Type.Union([
  Type.Literal("active_part_a"),
  Type.Literal("inactive_part_a"),
  Type.Literal("indeterminate"),
  Type.Literal("error"),
]);
const M23ValidationSeverity = Type.Union([
  Type.Literal("error"),
  Type.Literal("warn"),
  Type.Literal("info"),
]);
const M23OverrideRole = Type.Union([
  Type.Literal("billing_manager"),
  Type.Literal("compliance_officer"),
  Type.Literal("medical_director"),
  Type.Literal("org_admin"),
]);
const M23ValidationRunTrigger = Type.Union([
  Type.Literal("initial_assembly"),
  Type.Literal("pre_submission"),
  Type.Literal("re_validation_after_correction"),
  Type.Literal("re_validation_after_override"),
  Type.Literal("manual_re_run"),
]);
const M23ValidationRunOutcome = Type.Union([
  Type.Literal("all_pass"),
  Type.Literal("failures_present"),
  Type.Literal("overrides_required"),
  Type.Literal("ready_for_submission"),
]);
const M23ValidationResultOutcome = Type.Union([
  Type.Literal("pass"),
  Type.Literal("fail"),
  Type.Literal("warn"),
  Type.Literal("info"),
]);
const M23ClaimSubmissionKind = Type.Union([
  Type.Literal("claim_837i"),
  Type.Literal("noe"),
  Type.Literal("notr"),
]);
const M23ClaimSubmissionOutcome = Type.Union([
  Type.Literal("queued"),
  Type.Literal("generated"),
  Type.Literal("submitted"),
  Type.Literal("failed_worker"),
  Type.Literal("failed_portal"),
]);
const M23ClaimAcknowledgmentKind = Type.Union([
  Type.Literal("ack_999"),
  Type.Literal("ack_277ca"),
  Type.Literal("ack_835"),
]);
const M23NotrTriggerKind = Type.Union([
  Type.Literal("revocation"),
  Type.Literal("transfer_out"),
  Type.Literal("discharge"),
]);

const M23ClaimSummaryView = Type.Object({
  claimId: Type.String(),
  organizationId: Type.String(),
  providerEntityId: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  tob: M23TypeOfBill,
  state: M23ClaimState,
  serviceFrom: Type.String(),
  serviceTo: Type.String(),
  claimControlNumber: Type.String(),
  payerClaimControlNumber: Type.Union([Type.String(), Type.Null()]),
  macJurisdiction: Type.String(),
  totalChargeCents: Type.Integer(),
  totalExpectedPaymentCents: Type.Integer(),
  version: Type.Integer(),
});
const M23ClaimListResponse = Type.Object({
  items: Type.Array(M23ClaimSummaryView),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore: Type.Boolean(),
});
const M23ValidationRunView = Type.Object({
  validationRunId: Type.String(),
  claimId: Type.String(),
  trigger: M23ValidationRunTrigger,
  outcome: M23ValidationRunOutcome,
  rulesExecuted: Type.Integer(),
  rulesPassed: Type.Integer(),
  rulesFailed: Type.Integer(),
  rulesWarn: Type.Integer(),
  rulesInfo: Type.Integer(),
  startedAt: Type.String(),
  completedAt: Type.String(),
  durationMs: Type.Integer(),
  initiatedByMembershipId: Type.Union([Type.String(), Type.Null()]),
});
const M23ClaimPricingView = Type.Object({
  hipps: Type.Union([
    Type.Object({
      hippsCode: Type.String(),
      hippsRateCents: Type.Integer(),
      wageIndexCcn: Type.String(),
      wageIndexFiscalYear: Type.Integer(),
      wageIndexFactor: Type.String(),
      segments: Type.Unknown(),
      calculatedAt: Type.String(),
    }),
    Type.Null(),
  ]),
  sia: Type.Union([
    Type.Object({
      windowStart: Type.String(),
      totalQualifyingMinutes: Type.Integer(),
      siaAddOnCents: Type.Integer(),
      calculatedAt: Type.String(),
    }),
    Type.Null(),
  ]),
});
const M23ClaimDetailResponse = Type.Composite([
  M23ClaimSummaryView,
  Type.Object({
    electionPeriodIdFrom: Type.String(),
    electionPeriodIdTo: Type.String(),
    patientPayerId: Type.String(),
    sequestrationAppliedPct: Type.String(),
    sequestrationPolicyId: Type.String(),
    replacesClaimId: Type.Union([Type.String(), Type.Null()]),
    replacedByClaimId: Type.Union([Type.String(), Type.Null()]),
    replacementReason: Type.Union([Type.String(), Type.Null()]),
    latestValidationRunId: Type.Union([Type.String(), Type.Null()]),
    latestSubmissionId: Type.Union([Type.String(), Type.Null()]),
    acknowledgmentDocumentId: Type.Union([Type.String(), Type.Null()]),
    latestValidation: Type.Union([M23ValidationRunView, Type.Null()]),
    pricing: M23ClaimPricingView,
    createdAt: Type.String(),
    updatedAt: Type.String(),
  }),
]);
const M23ClaimLineView = Type.Object({
  claimLineId: Type.String(),
  claimId: Type.String(),
  lineNumber: Type.Integer(),
  revenueCode: Type.String(),
  qCode: Type.String(),
  levelOfCare: M23LevelOfCare,
  hcpcsCode: Type.Union([Type.String(), Type.Null()]),
  serviceDateFrom: Type.String(),
  serviceDateTo: Type.String(),
  unitCount: Type.Number(),
  unitRateCents: Type.Integer(),
  lineChargeCents: Type.Integer(),
  levelOfCarePeriodId: Type.String(),
  modifiers: Type.Array(Type.String()),
  icdPointerPositions: Type.Array(Type.Integer()),
  backingEncounterIds: Type.Array(Type.String()),
});
const M23ClaimLinesResponse = Type.Array(M23ClaimLineView);
const M23ClaimStateHistoryView = Type.Object({
  historyId: Type.String(),
  claimId: Type.String(),
  fromState: Type.Union([M23ClaimState, Type.Null()]),
  toState: M23ClaimState,
  at: Type.String(),
  actorMembershipId: Type.Union([Type.String(), Type.Null()]),
  actorKind: Type.String(),
  reason: Type.Union([Type.String(), Type.Null()]),
  validationRunId: Type.Union([Type.String(), Type.Null()]),
  submissionId: Type.Union([Type.String(), Type.Null()]),
  acknowledgmentId: Type.Union([Type.String(), Type.Null()]),
  remittanceAdviceId: Type.Union([Type.String(), Type.Null()]),
});
const M23ClaimStateHistoryResponse = Type.Object({
  items: Type.Array(M23ClaimStateHistoryView),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore: Type.Boolean(),
});
const M23ClaimSubmissionView = Type.Object({
  submissionId: Type.String(),
  providerEntityId: Type.String(),
  kind: M23ClaimSubmissionKind,
  claimId: Type.Union([Type.String(), Type.Null()]),
  noeId: Type.Union([Type.String(), Type.Null()]),
  notrId: Type.Union([Type.String(), Type.Null()]),
  claimControlNumber: Type.String(),
  attemptIndex: Type.Integer(),
  outcome: M23ClaimSubmissionOutcome,
  outcomeReason: Type.Union([Type.String(), Type.Null()]),
  generatedFileUri: Type.Union([Type.String(), Type.Null()]),
  submittedAt: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
const M23ClaimSubmissionsResponse = Type.Array(M23ClaimSubmissionView);
const M23ClaimAcknowledgmentView = Type.Object({
  acknowledgmentId: Type.String(),
  submissionId: Type.String(),
  claimId: Type.Union([Type.String(), Type.Null()]),
  kind: M23ClaimAcknowledgmentKind,
  macJurisdiction: Type.String(),
  ackReceivedAt: Type.String(),
  parsedAt: Type.String(),
  outcomeStatus: Type.String(),
  parsedPayload: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.String(),
});
const M23ClaimAcknowledgmentsResponse = Type.Array(M23ClaimAcknowledgmentView);

const M23ValidationResultView = Type.Object({
  resultId: Type.String(),
  validationRunId: Type.String(),
  ruleKey: Type.String(),
  ruleVersion: Type.Integer(),
  severity: M23ValidationSeverity,
  outcome: M23ValidationResultOutcome,
  remediation: Type.Record(Type.String(), Type.Unknown()),
  overridden: Type.Boolean(),
  override: Type.Union([
    Type.Object({
      overrideId: Type.String(),
      resultId: Type.String(),
      overrideMembershipId: Type.String(),
      overrideRoleApplied: M23OverrideRole,
      reason: Type.String(),
      appliedAt: Type.String(),
    }),
    Type.Null(),
  ]),
  recordedAt: Type.String(),
});
const M23ValidationRunDetailView = Type.Composite([
  M23ValidationRunView,
  Type.Object({ results: Type.Array(M23ValidationResultView) }),
]);
const M23ClaimValidationRunsResponse = Type.Object({
  claimId: Type.String(),
  runs: Type.Array(M23ValidationRunView),
});

const M23NoeView = Type.Object({
  noeId: Type.String(),
  organizationId: Type.String(),
  providerEntityId: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  electionPeriodId: Type.String(),
  state: M23NoticeState,
  electionEffectiveDate: Type.String(),
  windowTargetAt: Type.String(),
  windowBreachedAt: Type.Union([Type.String(), Type.Null()]),
  noeControlNumber: Type.String(),
  payerNoeControlNumber: Type.Union([Type.String(), Type.Null()]),
  latestSubmissionId: Type.Union([Type.String(), Type.Null()]),
  latestAcknowledgmentId: Type.Union([Type.String(), Type.Null()]),
  confirmationDocumentId: Type.Union([Type.String(), Type.Null()]),
  version: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
const M23NoeListResponse = Type.Object({
  items: Type.Array(M23NoeView),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore: Type.Boolean(),
});
const M23NotrView = Type.Object({
  notrId: Type.String(),
  organizationId: Type.String(),
  providerEntityId: Type.String(),
  patientId: Type.String(),
  admissionId: Type.String(),
  triggerKind: M23NotrTriggerKind,
  revocationEventId: Type.Union([Type.String(), Type.Null()]),
  transferEventId: Type.Union([Type.String(), Type.Null()]),
  dischargeEventId: Type.Union([Type.String(), Type.Null()]),
  effectiveEndDate: Type.String(),
  windowTargetAt: Type.String(),
  windowBreachedAt: Type.Union([Type.String(), Type.Null()]),
  state: M23NoticeState,
  notrControlNumber: Type.String(),
  payerNotrControlNumber: Type.Union([Type.String(), Type.Null()]),
  latestSubmissionId: Type.Union([Type.String(), Type.Null()]),
  latestAcknowledgmentId: Type.Union([Type.String(), Type.Null()]),
  confirmationDocumentId: Type.Union([Type.String(), Type.Null()]),
  version: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
const M23NotrListResponse = Type.Object({
  items: Type.Array(M23NotrView),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore: Type.Boolean(),
});

const M23EligibilityCheckView = Type.Object({
  checkId: Type.String(),
  providerEntityId: Type.String(),
  patientId: Type.String(),
  asOfServiceDate: Type.String(),
  outcome: M23EligibilityOutcome,
  parsedPayload: Type.Record(Type.String(), Type.Unknown()),
  checkedAt: Type.String(),
  staleAt: Type.String(),
});
const M23EligibilityListResponse = Type.Object({ items: Type.Array(M23EligibilityCheckView) });
const M23EligibilityLatestResponse = Type.Union([M23EligibilityCheckView, Type.Null()]);

const M23RuleConfigView = Type.Object({
  ruleConfigId: Type.String(),
  organizationId: Type.String(),
  ruleKey: Type.String(),
  ruleVersion: Type.Integer(),
  isCustom: Type.Boolean(),
  enabled: Type.Boolean(),
  severity: M23ValidationSeverity,
  overrideRoleRequired: Type.Union([M23OverrideRole, Type.Null()]),
  parameters: Type.Record(Type.String(), Type.Unknown()),
  regulatoryRequiredSnapshot: Type.Boolean(),
  predicateDsl: Type.Unknown(),
  setByMembershipId: Type.String(),
  setReason: Type.Union([Type.String(), Type.Null()]),
  version: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
const M23RuleConfigListResponse = Type.Object({
  items: Type.Array(M23RuleConfigView),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore: Type.Boolean(),
});

const M23SequestrationPolicyView = Type.Object({
  policyId: Type.String(),
  organizationId: Type.String(),
  providerEntityId: Type.String(),
  percentage: Type.String(),
  effectiveFrom: Type.String(),
  effectiveTo: Type.Union([Type.String(), Type.Null()]),
  setByMembershipId: Type.String(),
  setReason: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
const M23SequestrationPolicyListResponse = Type.Object({
  policies: Type.Array(M23SequestrationPolicyView),
});
const M23SequestrationPolicyActiveResponse = Type.Union([M23SequestrationPolicyView, Type.Null()]);

const M23MacCredentialView = Type.Object({
  credentialId: Type.String(),
  organizationId: Type.String(),
  providerEntityId: Type.String(),
  macJurisdiction: Type.String(),
  submitterId: Type.String(),
  tradingPartnerId: Type.String(),
  clientId: Type.String(),
  hasSecret: Type.Boolean(),
  baaRecordRef: Type.Union([Type.String(), Type.Null()]),
  credentialExpiresAt: Type.Union([Type.String(), Type.Null()]),
  lastSandboxTestAt: Type.Union([Type.String(), Type.Null()]),
  version: Type.Integer(),
  createdAt: Type.String(),
  updatedAt: Type.String(),
});
const M23MacCredentialListResponse = Type.Object({
  items: Type.Array(M23MacCredentialView),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
  hasMore: Type.Boolean(),
});
const M23MacCredentialByProviderResponse = Type.Union([M23MacCredentialView, Type.Null()]);

const M23ArAgingDto = Type.Object({
  bucket0to30Cents: Type.Integer(),
  bucket31to60Cents: Type.Integer(),
  bucket61to90Cents: Type.Integer(),
  bucket90PlusCents: Type.Integer(),
});
const M23MetricsBucket = Type.Object({
  key: Type.String(),
  count: Type.Integer(),
  amountCents: Type.Integer(),
});
const M23MetricsResponse = Type.Object({ buckets: Type.Array(M23MetricsBucket) });

Object.assign(ROUTE_ENRICHMENTS, {
  "GET /api/v1/billing/ar-dashboard": {
    summary:
      "AR-aging dashboard - aging buckets + denial / NOE-NOTR window-breach rates (org-wide or per-PE, §4.1 #37)",
    query: BillingMetricsQuerySchema,
    response: M23ArAgingDto,
  },
  "GET /api/v1/billing/claims": {
    summary: "List claims - cursor-paginated; filter by state / patient / ProviderEntity (§4.1 #2)",
    query: ClaimListQuerySchema,
    response: M23ClaimListResponse,
  },
  "GET /api/v1/billing/claims/:id": {
    summary:
      "Single-claim detail - lines + HIPPS + SIA + latest run + submissions + acks (§4.1 #3)",
    response: M23ClaimDetailResponse,
  },
  "GET /api/v1/billing/claims/:id/acknowledgments": {
    summary: "All 999 / 277CA / 835 acknowledgments for a claim (§4.1 #13)",
    response: M23ClaimAcknowledgmentsResponse,
  },
  "GET /api/v1/billing/claims/:id/lines": {
    summary: "The claim_line projection for a claim (§4.1 #10)",
    response: M23ClaimLinesResponse,
  },
  "GET /api/v1/billing/claims/:id/state-history": {
    summary: "Per-claim transition timeline (cursor-paginated, §4.1 #11)",
    response: M23ClaimStateHistoryResponse,
  },
  "GET /api/v1/billing/claims/:id/submissions": {
    summary: "All dispatch attempts for a claim (§4.1 #12)",
    response: M23ClaimSubmissionsResponse,
  },
  "GET /api/v1/billing/eligibility": {
    summary: "Per-patient eligibility-check history (§4.1 #23)",
    query: BillingPatientQuerySchema,
    response: M23EligibilityListResponse,
  },
  "GET /api/v1/billing/eligibility/latest": {
    summary: "The latest eligibility check for a patient (auto-refresh-on-stale read, §4.1)",
    query: BillingPatientQuerySchema,
    response: M23EligibilityLatestResponse,
  },
  "GET /api/v1/billing/mac-credentials": {
    summary:
      "List per-ProviderEntity MAC credentials - secrets masked, cursor-paginated (§4.1 #34)",
    query: MacCredentialListQuerySchema,
    response: M23MacCredentialListResponse,
  },
  "GET /api/v1/billing/mac-credentials/:providerEntityId": {
    summary: "The MAC credential for one ProviderEntity, or null (§4.1)",
    response: M23MacCredentialByProviderResponse,
  },
  "GET /api/v1/billing/metrics": {
    summary:
      "Per-window claim metric buckets (the M33 reporting consumer; org-wide or per-PE, §4.1 #38)",
    query: BillingMetricsQuerySchema,
    response: M23MetricsResponse,
  },
  "GET /api/v1/billing/rule-configs": {
    summary:
      "List validation-rule overlay rows - platform snapshot + tenant overlays (cursor-paginated, §4.1 #18)",
    query: RuleConfigListQuerySchema,
    response: M23RuleConfigListResponse,
  },
  "GET /api/v1/billing/rule-configs/:id": {
    summary: "Read a single validation-rule overlay row (§4.1)",
    response: M23RuleConfigView,
  },
  "GET /api/v1/billing/sequestration-policies": {
    summary:
      "Per-ProviderEntity sequestration-percentage timeline - effective-dated rows (D11, §4.1 #32)",
    query: RequiredProviderEntityQuerySchema,
    response: M23SequestrationPolicyListResponse,
  },
  "GET /api/v1/billing/sequestration-policies/active": {
    summary: "The active-on-now sequestration policy for a ProviderEntity (or null, §4.1)",
    query: RequiredProviderEntityQuerySchema,
    response: M23SequestrationPolicyActiveResponse,
  },
  "GET /api/v1/claims/:id/validation-runs": {
    summary: "List a claim's validation runs, most recent first (§4.1 #14)",
    response: M23ClaimValidationRunsResponse,
  },
  "GET /api/v1/claims/:id/validation-runs/:runId": {
    summary: "Single validation run - per-rule results + override status (§4.1 #15)",
    response: M23ValidationRunDetailView,
  },
  "GET /api/v1/noe-records": {
    summary: "List NOE records - timely-filing worklist, cursor-paginated (§4.1 #24)",
    query: NoeListQuerySchema,
    response: M23NoeListResponse,
  },
  "GET /api/v1/noe-records/:id": {
    summary: "NOE detail (§4.1 #25)",
    response: M23NoeView,
  },
  "GET /api/v1/notr-records": {
    summary: "List NOTR records - timely-filing worklist, cursor-paginated (§4.1 #28)",
    query: NotrListQuerySchema,
    response: M23NotrListResponse,
  },
  "GET /api/v1/notr-records/:id": {
    summary: "NOTR detail (§4.1 #29)",
    response: M23NotrView,
  },
});

// ── WX-PR-015 body/response gap-fill — 28-fhir ─────────────────────────────────────────
// M28 FHIR Gateway — response-contract backfill (WX-PR-015). Reuses the existing M28 import block's
// bindings (M28ClientListQuery, M28BulkExportListQuery, M28InboundListQuery, M28ResourceSearchQuery) —
// only NEW symbols are imported here.
import {
  FhirClientStatusSchema as M28FhirClientStatusSchema,
  FhirClientTierSchema as M28FhirClientTierSchema,
  FhirClientTypeSchema as M28FhirClientTypeSchema,
  FhirInboundOwnerModuleSchema as M28FhirInboundOwnerModuleSchema,
  FhirInboundStatusSchema as M28FhirInboundStatusSchema,
  InboundResourceBody as M28InboundResourceBody,
} from "../../apps/backend/src/modules/28-fhir/routes/m28-typebox";

// ── newly authored response schemas (mirror store.ts DTOs / route handler return shapes) ──────────────

const M28FhirClientSummarySchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  name: Type.String(),
  type: M28FhirClientTypeSchema,
  tier: M28FhirClientTierSchema,
  status: M28FhirClientStatusSchema,
  baaContractReference: Type.String(),
  approvedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
});

const M28ClientListResponse = Type.Object({
  clients: Type.Array(M28FhirClientSummarySchema),
});

const M28FhirSessionSummarySchema = Type.Object({
  jti: Type.String({ format: "uuid" }),
  clientId: Type.String({ format: "uuid" }),
  scopesGranted: Type.Array(Type.String()),
  issuedAt: Type.String({ format: "date-time" }),
  expiresAt: Type.String({ format: "date-time" }),
  revokedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});

const M28ClientSessionsResponse = Type.Object({
  sessions: Type.Array(M28FhirSessionSummarySchema),
});

const M28FhirBulkExportJobViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  clientId: Type.String({ format: "uuid" }),
  requestKind: Type.Union([Type.Literal("system"), Type.Literal("group"), Type.Literal("patient")]),
  resourceTypes: Type.Array(Type.String()),
  status: Type.String(),
  initiatedByMembershipId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  createdAt: Type.String({ format: "date-time" }),
  completedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  expiresAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});

const M28BulkExportListResponse = Type.Object({
  jobs: Type.Array(M28FhirBulkExportJobViewSchema),
});

const M28FhirInboundProposalViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  resourceType: Type.String(),
  sourceClientId: Type.String({ format: "uuid" }),
  sourceFhirId: Type.Union([Type.String(), Type.Null()]),
  ownerModule: M28FhirInboundOwnerModuleSchema,
  proposalStatus: M28FhirInboundStatusSchema,
  payloadSha256: Type.String(),
  proposedAt: Type.String({ format: "date-time" }),
  decidedByMembershipId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
  decidedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  decisionRationale: Type.Union([Type.String(), Type.Null()]),
  acceptedAggregateId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
});

const M28InboundProposalsResponse = Type.Object({
  proposals: Type.Array(M28FhirInboundProposalViewSchema),
});

const M28FhirTenantConfigViewSchema = Type.Object({
  organizationId: Type.String({ format: "uuid" }),
  tenantFhirHost: Type.String(),
  identifierUriBase: Type.String(),
  inboundReviewSlaHours: Type.Integer(),
  exportDedupWindowMinutes: Type.Integer(),
  cursorKeyFingerprint: Type.String(),
});

const M28ConfigResponse = Type.Object({
  config: Type.Union([M28FhirTenantConfigViewSchema, Type.Null()]),
});

// ── FHIR-spec surface response shapes (Phase-1: read-only US Core R4; operation-outcome.ts DTO) ────────

const M28FhirOperationOutcomeResponse = Type.Object({
  resourceType: Type.Literal("OperationOutcome"),
  issue: Type.Array(
    Type.Object({
      severity: Type.Union([
        Type.Literal("fatal"),
        Type.Literal("error"),
        Type.Literal("warning"),
        Type.Literal("information"),
      ]),
      code: Type.Union([
        Type.Literal("not-found"),
        Type.Literal("not-supported"),
        Type.Literal("forbidden"),
        Type.Literal("security"),
        Type.Literal("invalid"),
        Type.Literal("processing"),
        Type.Literal("throttled"),
        Type.Literal("login"),
        Type.Literal("unknown"),
      ]),
      diagnostics: Type.String(),
      details: Type.Optional(
        Type.Object({
          coding: Type.Array(Type.Object({ system: Type.String(), code: Type.String() })),
        }),
      ),
    }),
  ),
});

const M28SmartConfigurationResponse = Type.Object({
  token_endpoint: Type.String(),
  token_endpoint_auth_methods_supported: Type.Array(Type.String()),
  token_endpoint_auth_signing_alg_values_supported: Type.Array(Type.String()),
  grant_types_supported: Type.Array(Type.String()),
  scopes_supported: Type.Array(Type.String()),
  capabilities: Type.Array(Type.String()),
});

const M28CapabilityStatementResponse = Type.Object({
  resourceType: Type.Literal("CapabilityStatement"),
  status: Type.Literal("active"),
  date: Type.String(),
  kind: Type.Literal("instance"),
  fhirVersion: Type.String(),
  format: Type.Array(Type.String()),
  implementation: Type.Object({ description: Type.String(), url: Type.String() }),
  rest: Type.Array(
    Type.Object({
      mode: Type.Literal("server"),
      resource: Type.Array(
        Type.Object({
          type: Type.String(),
          interaction: Type.Array(Type.Object({ code: Type.String() })),
          searchParam: Type.Optional(
            Type.Array(Type.Object({ name: Type.String(), type: Type.String() })),
          ),
        }),
      ),
      operation: Type.Array(Type.Object({ name: Type.String(), definition: Type.String() })),
    }),
  ),
});

const M28SearchsetBundleResponse = Type.Object({
  resourceType: Type.Literal("Bundle"),
  type: Type.Literal("searchset"),
  total: Type.Integer(),
  entry: Type.Array(Type.Unknown()),
  link: Type.Optional(Type.Array(Type.Unknown())),
});

const M28ExportPollStatusResponse = Type.Union([
  Type.Object({
    transactionTime: Type.Union([Type.String(), Type.Null()]),
    request: Type.String(),
    requiresAccessToken: Type.Boolean(),
    output: Type.Array(Type.Unknown()),
  }),
  Type.Object({ status: Type.String() }),
]);

const M28ValueSetExpandResponse = Type.Object({
  resourceType: Type.Literal("ValueSet"),
  status: Type.Literal("active"),
  expansion: Type.Object({ total: Type.Integer(), contains: Type.Array(Type.Unknown()) }),
});

Object.assign(ROUTE_ENRICHMENTS, {
  "GET /fhir/r4/metadata": {
    summary:
      "The deterministic US Core R4 CapabilityStatement (R1). Anonymous per FHIR convention, rate-limited per-IP; the signed checksum is the survey-defense artifact (D11)",
    response: M28CapabilityStatementResponse,
  },
  "GET /fhir/.well-known/smart-configuration": {
    summary:
      "SMART Backend Services well-known config (R2). Anonymous; advertises the client-credentials + private_key_jwt token endpoint and the system/*.read scope model",
    response: M28SmartConfigurationResponse,
  },
  "GET /fhir/r4/:resourceType/:id": {
    summary:
      "Single-resource read (R4). Bearer scope `system/{ResourceType}.read` required; the disclosure is D15-audited. Phase 1 returns a well-formed not-found OperationOutcome — the projection reader seams are fail-closed deny-stubs this wave",
    response: M28FhirOperationOutcomeResponse,
  },
  "GET /fhir/r4/:resourceType": {
    summary:
      "Type-level search (R5). `patient` is the W-FHIR-14 US Core parameter. Returns a well-formed empty searchset Bundle in Phase 1; the scope check + disclosure audit are real",
    query: M28ResourceSearchQuery,
    response: M28SearchsetBundleResponse,
  },
  "GET /fhir/r4/Patient/:id/$everything": {
    summary:
      "Patient $everything (R6, D5). Requires read scope for every linked resource type; D15-audited. Returns a well-formed empty Bundle in Phase 1",
    response: M28SearchsetBundleResponse,
  },
  "GET /fhir/r4/$export-poll-status/:jobId": {
    summary:
      "Poll a bulk-export job (R10). 202 In-Progress | 200 Completed (with the output manifest) | 410 Expired once the 24h NDJSON TTL has passed",
    response: M28ExportPollStatusResponse,
  },
  "GET /fhir/r4/CodeSystem/:system": {
    summary:
      "CodeSystem read (R12). Requires `system/CodeSystem.read`. Not served in Phase 1 (a warning OperationOutcome), which the terminology seam fills when M38 binds live",
    response: M28FhirOperationOutcomeResponse,
  },
  "POST /fhir/r4/:resourceType": {
    summary:
      "Inbound staging (R16, D8). Requires `system/{ResourceType}.write`. M28 NEVER writes a native record — it stages the resource as a PROPOSAL the owner module (m5/m12) reviews; an unsupported resource type is a 501",
    body: M28InboundResourceBody,
  },
  "GET /fhir/r4/ValueSet/:vs": {
    summary: "ValueSet read (R14). Requires `system/ValueSet.read`; not served in Phase 1",
    response: M28FhirOperationOutcomeResponse,
  },
  "GET /fhir/r4/ValueSet/:vs/$expand": {
    summary:
      "ValueSet $expand (R15). Requires `system/ValueSet.read`; returns a well-formed empty expansion in Phase 1",
    response: M28ValueSetExpandResponse,
  },
  "GET /fhir/r5/*": {
    summary:
      "FHIR R5 is not supported (R17, D1/D7) — 415 Unsupported Media Type + OperationOutcome",
    response: M28FhirOperationOutcomeResponse,
  },
  "GET /fhir/r6/*": {
    summary:
      "FHIR R6 is not supported (R18, D1/D7) — 415 Unsupported Media Type + OperationOutcome",
    response: M28FhirOperationOutcomeResponse,
  },
  "GET /api/v1/fhir/clients": {
    summary: "List the org's registered FHIR clients (R23)",
    query: M28ClientListQuery,
    response: M28ClientListResponse,
  },
  "GET /api/v1/fhir/clients/:id/sessions": {
    summary: "List a client's active bearer sessions (R29)",
    response: M28ClientSessionsResponse,
  },
  "GET /api/v1/fhir/bulk-export-jobs": {
    summary: "List the org's bulk-export jobs (R31)",
    query: M28BulkExportListQuery,
    response: M28BulkExportListResponse,
  },
  "GET /api/v1/fhir/inbound-proposals": {
    summary: "The operator review queue of staged inbound proposals (R34)",
    query: M28InboundListQuery,
    response: M28InboundProposalsResponse,
  },
  "GET /api/v1/fhir/config": {
    summary: "Read the tenant's FHIR config (R37)",
    response: M28ConfigResponse,
  },
});

// ── WX-PR-015 body/response gap-fill — 29-external-interfaces ─────────────────────────────────────────
// ── M29 External Interfaces — response DTOs (WX-PR-015) ─────────────────────────────────────────────────
// Mirrors the route-facing DTOs `apps/backend/src/modules/29-external-interfaces/routes/store.ts` declares
// (FeedSummary/FeedDetail/CredentialSummary/FeedHealthView/ProposalSummary/ProposalDetail/
// InboundMessageView/OutboundMessageView/NppesProviderView/SyncRunView/FeedHealthAggregate/
// ListenerStatusView/LabObservationSummary/LabObservationDetail/UnmatchedLabView/Page<T>) field-for-field —
// the SAME vocabulary unions the request-side `m29-typebox.ts` schemas already publish, so list/detail
// responses cannot drift from what the handlers actually return.
import {
  AbnormalFlagSchema as M29AbnormalFlagSchema,
  CredentialKindSchema as M29CredentialKindSchema,
  FeedKindSchema as M29FeedKindSchema,
  FeedProtocolSchema as M29FeedProtocolSchema,
  FeedStatusSchema as M29FeedStatusSchema,
  OutboundStatusSchema as M29OutboundStatusSchema,
  ParseStatusSchema as M29ParseStatusSchema,
  ProposalOwnerModuleSchema as M29ProposalOwnerModuleSchema,
  ProposalStatusSchema as M29ProposalStatusSchema,
} from "../../apps/backend/src/modules/29-external-interfaces/routes/m29-typebox";

const M29PageOf = <T extends TSchema>(item: T) =>
  Type.Object({
    items: Type.Array(item),
    nextCursor: Type.Optional(Type.String()),
  });

const M29FeedSummarySchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  kind: M29FeedKindSchema,
  displayName: Type.String(),
  status: M29FeedStatusSchema,
  protocol: M29FeedProtocolSchema,
  host: Type.Union([Type.String(), Type.Null()]),
  port: Type.Integer(),
  baaContractRef: Type.Union([Type.String(), Type.Null()]),
  baaExpiresOn: Type.Union([Type.String(), Type.Null()]),
  activeFrom: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});

const M29FeedDetailSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  kind: M29FeedKindSchema,
  displayName: Type.String(),
  status: M29FeedStatusSchema,
  protocol: M29FeedProtocolSchema,
  host: Type.Union([Type.String(), Type.Null()]),
  port: Type.Integer(),
  baaContractRef: Type.Union([Type.String(), Type.Null()]),
  baaExpiresOn: Type.Union([Type.String(), Type.Null()]),
  activeFrom: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
  channelCertPin: Type.Union([Type.String(), Type.Null()]),
  sendingFacilityAllowlist: Type.Array(Type.String()),
  rateLimitMsgPerSec: Type.Integer(),
  proposedByMembershipId: Type.String(),
  approvedByOpId: Type.Union([Type.String(), Type.Null()]),
  approvedByComplId: Type.Union([Type.String(), Type.Null()]),
  approvedAt: Type.Union([Type.String(), Type.Null()]),
  revokedAt: Type.Union([Type.String(), Type.Null()]),
});

const M29FeedListResponse = M29PageOf(M29FeedSummarySchema);
const M29FeedDetailResponse = Type.Object({ feed: M29FeedDetailSchema });

const M29CredentialSummarySchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  feedId: Type.String({ format: "uuid" }),
  kind: M29CredentialKindSchema,
  fingerprint: Type.String(),
  status: Type.Union([Type.Literal("active"), Type.Literal("retired")]),
  rotatedAt: Type.String(),
  createdAt: Type.String(),
});
const M29CredentialListResponse = Type.Object({
  credentials: Type.Array(M29CredentialSummarySchema),
});

const M29FeedHealthViewSchema = Type.Object({
  feedId: Type.String({ format: "uuid" }),
  hourBucket: Type.String(),
  listenerUpSeconds: Type.Integer(),
  listenerDownSeconds: Type.Integer(),
  inboundMessageCount: Type.Integer(),
  outboundMessageCount: Type.Integer(),
  ackAaCount: Type.Integer(),
  ackAeCount: Type.Integer(),
  ackArCount: Type.Integer(),
  ackTimeoutCount: Type.Integer(),
  parseErrorCount: Type.Integer(),
  senderRejectedCount: Type.Integer(),
  lastMessageAt: Type.Union([Type.String(), Type.Null()]),
});
const M29FeedHealthResponse = Type.Object({
  health: Type.Union([M29FeedHealthViewSchema, Type.Null()]),
});

const M29FeedHealthAggregateSchema = Type.Object({
  feedCount: Type.Integer(),
  activeFeedCount: Type.Integer(),
  listenersUp: Type.Integer(),
  listenersDown: Type.Integer(),
  inboundMessageCount: Type.Integer(),
  outboundMessageCount: Type.Integer(),
  parseErrorCount: Type.Integer(),
});
const M29HealthAggregateResponse = Type.Object({ health: M29FeedHealthAggregateSchema });

const M29ListenerStatusViewSchema = Type.Object({
  feedId: Type.String({ format: "uuid" }),
  displayName: Type.String(),
  status: M29FeedStatusSchema,
  listenerUp: Type.Boolean(),
  lastMessageAt: Type.Union([Type.String(), Type.Null()]),
});
const M29ListenerStatusResponse = Type.Object({
  listeners: Type.Array(M29ListenerStatusViewSchema),
});

const M29ProposalSummarySchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  sourceMessageId: Type.String({ format: "uuid" }),
  resourceKind: Type.String(),
  matchOutcome: Type.String(),
  matchedPatientId: Type.Union([Type.String(), Type.Null()]),
  ownerModule: M29ProposalOwnerModuleSchema,
  proposalStatus: M29ProposalStatusSchema,
  proposedAt: Type.String(),
  expiresAt: Type.String(),
});
const M29ProposalDetailSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  sourceMessageId: Type.String({ format: "uuid" }),
  resourceKind: Type.String(),
  matchOutcome: Type.String(),
  matchedPatientId: Type.Union([Type.String(), Type.Null()]),
  ownerModule: M29ProposalOwnerModuleSchema,
  proposalStatus: M29ProposalStatusSchema,
  proposedAt: Type.String(),
  expiresAt: Type.String(),
  matchConfidence: Type.Union([Type.Number(), Type.Null()]),
  matchCandidateIds: Type.Array(Type.String()),
  decidedByMembershipId: Type.Union([Type.String(), Type.Null()]),
  decidedAt: Type.Union([Type.String(), Type.Null()]),
  decisionRationale: Type.Union([Type.String(), Type.Null()]),
  acceptedAggregateId: Type.Union([Type.String(), Type.Null()]),
});
const M29ProposalListResponse = M29PageOf(M29ProposalSummarySchema);
const M29ProposalDetailResponse = Type.Object({ proposal: M29ProposalDetailSchema });

const M29InboundMessageViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  feedId: Type.String({ format: "uuid" }),
  messageType: Type.String(),
  messageControlId: Type.String(),
  payloadSha256: Type.String(),
  parseStatus: M29ParseStatusSchema,
  sendingFacilityRawId: Type.String(),
  matchedPatientId: Type.Union([Type.String(), Type.Null()]),
  receivedAt: Type.String(),
});
const M29InboundMessageListResponse = M29PageOf(M29InboundMessageViewSchema);
const M29InboundMessageResponse = Type.Object({ message: M29InboundMessageViewSchema });

const M29OutboundMessageViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  feedId: Type.String({ format: "uuid" }),
  messageType: Type.String(),
  messageControlId: Type.String(),
  payloadSha256: Type.String(),
  status: M29OutboundStatusSchema,
  sourceAggregateId: Type.String({ format: "uuid" }),
  ackStatus: Type.Union([Type.String(), Type.Null()]),
  retryCount: Type.Integer(),
  queuedAt: Type.String(),
  transmittedAt: Type.Union([Type.String(), Type.Null()]),
});
const M29OutboundMessageListResponse = M29PageOf(M29OutboundMessageViewSchema);
const M29OutboundMessageResponse = Type.Object({ message: M29OutboundMessageViewSchema });

const M29NppesProviderViewSchema = Type.Object({
  npi: Type.String(),
  enumerationType: Type.String(),
  status: Type.String(),
  basic: Type.Unknown(),
  addresses: Type.Unknown(),
  taxonomies: Type.Unknown(),
  deactivationDate: Type.Union([Type.String(), Type.Null()]),
  lastUpdatedInNppes: Type.Union([Type.String(), Type.Null()]),
  fetchedAt: Type.String(),
});
const M29NppesProviderResponse = Type.Object({ provider: M29NppesProviderViewSchema });

const M29SyncRunViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  kind: Type.String(),
  triggeredBy: Type.String(),
  status: Type.String(),
  startedAt: Type.String(),
  completedAt: Type.Union([Type.String(), Type.Null()]),
  providersFetchedCount: Type.Integer(),
  providersUpdatedCount: Type.Integer(),
  providersDeactivatedCount: Type.Integer(),
  errorsCount: Type.Integer(),
});
const M29SyncRunListResponse = M29PageOf(M29SyncRunViewSchema);

const M29LabAbnormalSummarySchema = Type.Union([
  Type.Literal("any_critical"),
  Type.Literal("any_abnormal"),
  Type.Literal("all_normal"),
  Type.Literal("no_flags"),
]);

const M29LabObservationSummarySchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  patientId: Type.String({ format: "uuid" }),
  orderId: Type.Union([Type.String(), Type.Null()]),
  loincCode: Type.String(),
  loincDisplayText: Type.String(),
  observationDate: Type.String(),
  resultStatus: Type.String(),
  abnormalSummary: M29LabAbnormalSummarySchema,
  attachedDocumentId: Type.Union([Type.String(), Type.Null()]),
  receivedAt: Type.String(),
});
const M29LabObservationValueViewSchema = Type.Object({
  obxSetId: Type.Integer(),
  loincCode: Type.String(),
  loincDisplayText: Type.String(),
  valueType: Type.String(),
  numericValue: Type.Union([Type.Number(), Type.Null()]),
  stringValue: Type.Union([Type.String(), Type.Null()]),
  units: Type.Union([Type.String(), Type.Null()]),
  referenceRange: Type.Union([Type.String(), Type.Null()]),
  abnormalFlag: Type.Union([M29AbnormalFlagSchema, Type.Null()]),
});
const M29LabObservationDetailSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  patientId: Type.String({ format: "uuid" }),
  orderId: Type.Union([Type.String(), Type.Null()]),
  loincCode: Type.String(),
  loincDisplayText: Type.String(),
  observationDate: Type.String(),
  resultStatus: Type.String(),
  abnormalSummary: M29LabAbnormalSummarySchema,
  attachedDocumentId: Type.Union([Type.String(), Type.Null()]),
  receivedAt: Type.String(),
  values: Type.Array(M29LabObservationValueViewSchema),
});
const M29ObservationListResponse = M29PageOf(M29LabObservationSummarySchema);
const M29ObservationDetailResponse = Type.Object({ observation: M29LabObservationDetailSchema });

const M29UnmatchedLabViewSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  observationId: Type.String({ format: "uuid" }),
  sourceMessageId: Type.String({ format: "uuid" }),
  obrPlacerOrderNumber: Type.Union([Type.String(), Type.Null()]),
  matchMethod: Type.String(),
  candidatePatientId: Type.Union([Type.String(), Type.Null()]),
  candidateMatchLevel: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String(),
});
const M29UnmatchedObservationListResponse = M29PageOf(M29UnmatchedLabViewSchema);

// NOTE on `POST /api/admin/external-interfaces/feeds/:feedId/activate`: the handler
// (`routes/feed.routes.ts`) never calls `parse()`/`parseQuery()` on `request.body` — the route reads only
// the `:feedId` param and the actor, so there is no request-body contract to publish (no `body` key below,
// per the "never invent a shape the handler doesn't validate" rule). It DOES have a real response gap
// (`{ feed: FeedDetail }`), which is what's filled in here. The other 17 keys below restate each route's
// pre-existing `summary`/`body`/`query` verbatim (a later `Object.assign` replaces the whole per-key value,
// not a deep merge) and add only the previously-missing `response`.
Object.assign(ROUTE_ENRICHMENTS, {
  "GET /api/admin/external-interfaces/feeds": {
    summary: "List the org's HL7/NPPES feeds, filterable by kind/status (§4.1.1)",
    query: M29FeedListQuery,
    response: M29FeedListResponse,
  },
  "GET /api/admin/external-interfaces/feeds/:feedId": {
    summary: "Single feed detail incl. redacted credential metadata — NEVER ciphertext (§4.1.1)",
    response: M29FeedDetailResponse,
  },
  "POST /api/admin/external-interfaces/feeds/:feedId/activate": {
    summary:
      "Activate a feed: pending_approval → active. Requires a compliance co-approver DISTINCT from the operator (D18) AND the M40 BAA gate (`external_feed_baa_satisfied`, D16) (§4.1.1)",
    response: M29FeedDetailResponse,
  },
  "GET /api/admin/external-interfaces/feeds/:feedId/credentials": {
    summary: "List credential metadata (fingerprint + status only, NEVER ciphertext) (§4.1.1)",
    response: M29CredentialListResponse,
  },
  "GET /api/admin/external-interfaces/feeds/:feedId/health": {
    summary: "Current rolling per-hour health snapshot for a feed (§4.1.1)",
    response: M29FeedHealthResponse,
  },
  "GET /api/admin/external-interfaces/health/aggregate": {
    summary:
      "Tenant feed-health overview — listener up/down, message + parse-error counts (§4.1.5)",
    response: M29HealthAggregateResponse,
  },
  "GET /api/admin/external-interfaces/inbound-proposals": {
    summary:
      "List the propose-then-review ADT queue, filterable by status/owner_module/feed (§4.1.2)",
    query: M29ProposalListQuery,
    response: M29ProposalListResponse,
  },
  "GET /api/admin/external-interfaces/inbound-proposals/:proposalId": {
    summary: "Single ADT proposal detail (owner-module-scoped, D5) (§4.1.2)",
    response: M29ProposalDetailResponse,
  },
  "GET /api/admin/external-interfaces/messages/inbound": {
    summary: "Search inbound HL7 messages (metadata only, no plaintext) (§4.1.3)",
    query: M29InboundMessageListQuery,
    response: M29InboundMessageListResponse,
  },
  "GET /api/admin/external-interfaces/messages/inbound/:messageId": {
    summary:
      "Single inbound message — metadata only; plaintext is the dedicated decrypt route (§4.1.3)",
    response: M29InboundMessageResponse,
  },
  "GET /api/admin/external-interfaces/messages/outbound": {
    summary: "Search outbound HL7 messages, filterable by placer order / dispatch status (§4.1.3)",
    query: M29OutboundMessageListQuery,
    response: M29OutboundMessageListResponse,
  },
  "GET /api/admin/external-interfaces/messages/outbound/:messageId": {
    summary: "Single outbound message incl. the ACK/NACK chain (§4.1.3)",
    response: M29OutboundMessageResponse,
  },
  "GET /api/admin/external-interfaces/metrics/listener-status": {
    summary: "Per-feed listener socket status (up/down + last message time) (§4.1.5)",
    response: M29ListenerStatusResponse,
  },
  "GET /api/admin/external-interfaces/nppes/providers/:npi": {
    summary: "Read one cached platform-shared NPPES provider (public directory, no PHI) (§4.1.4)",
    response: M29NppesProviderResponse,
  },
  "GET /api/admin/external-interfaces/nppes/sync-runs": {
    summary: "List NPPES sync-run history (§4.1.4)",
    query: M29NppesSyncRunListQuery,
    response: M29SyncRunListResponse,
  },
  "GET /api/clinical/labs/observations": {
    summary: "List caseload lab observations, filterable by patient/loinc/abnormal-flag (§4.2)",
    query: M29ObservationListQuery,
    response: M29ObservationListResponse,
  },
  "GET /api/clinical/labs/observations/unmatched": {
    summary:
      "The unmatched-lab review queue (failed patient-match cascade, D6; review-unmatched role) (§4.2)",
    query: M29ObservationListQuery,
    response: M29UnmatchedObservationListResponse,
  },
  "GET /api/clinical/labs/observations/:observationId": {
    summary:
      "Single observation with its value rows (`lab_observation_patient_caseload_or_scope`, D20) (§4.2)",
    response: M29ObservationDetailResponse,
  },
});

// ── WX-PR-015 body/response gap-fill — 32-ai-platform ─────────────────────────────────────────
// M32 AI Platform — WX-PR-015 response contracts for the 17 GET routes whose OpenAPI entries (added
// earlier, see the "GET /api/v1/ai/capabilities" etc. block above) carry a summary/query but no
// `response`. Every shape below mirrors a real TS interface field-for-field: `AiCapabilityGovernanceRow`
// + `AiLifecycleEventRow` + `AiCalibrationRow` (governance/store.ts), `AiClinicianOptOutRow` /
// `AiTenantOptInRow` (governance/store.ts), `AiEvaluationRunRowProjection` / `AiHallucinationReportRowProjection`
// / `AiKillSwitchRowProjection` (safety/store.ts), `AiInvocationLedgerView` / `AiTokenLedgerEntryView` /
// `AiTokenForecastView` / `AiHealthView` (read-service.ts), `AiRoutingOverrideRowProjection`
// (invocation/store.ts) and the R29 hand-projected prompt-metadata literal in safety-ops.routes.ts.
// None of these row shapes has a TypeBox mirror anywhere in the module (M32-T07's m32-typebox.ts only
// ever needed request bodies/queries — §4.1's own routes prove it by hand-projecting every read), so
// they are authored fresh here rather than imported, per the enrichment-agent instructions. The
// STRING-LITERAL VOCAB is reused from `m32-typebox.ts` wherever it already exists there, and authored
// fresh only for the handful of unions that file never needed (hitl outcome, routing decision, eval
// decision, kill-switch actor kind, tenant opt-in status, capability consumer posture).
//
// Each entry below is merged onto its EXISTING `ROUTE_ENRICHMENTS[key]` (spread-preserved, not
// overwritten) because the M32-T07 batch already populated `summary`/`query` for every one of these
// fifteen GET routes earlier in this file — a bare `Object.assign` here would silently drop that work.
import {
  LifecycleApprovalKind as M32VocabApprovalKind,
  EvaluationRunStage as M32VocabEvalStage,
  EvaluationRunStatus as M32VocabEvalStatus,
  HallucinationKind as M32VocabHallucinationKind,
  HallucinationSeverity as M32VocabHallucinationSeverity,
  InvocationStatus as M32VocabInvocationStatus,
  KillSwitchReason as M32VocabKillSwitchReason,
  CapabilityLifecycleState as M32VocabLifecycleState,
  CapabilityOwningRole as M32VocabOwningRole,
  CapabilityRiskTier as M32VocabRiskTier,
  RoutingOverrideReason as M32VocabRoutingOverrideReason,
  RoutingPreference as M32VocabRoutingPreference,
  HallucinationTriageDisposition as M32VocabTriageDisposition,
  HallucinationTriageStatus as M32VocabTriageStatus,
} from "../../apps/backend/src/modules/32-ai-platform/routes/m32-typebox";

const M32RespUuid = Type.String({ format: "uuid" });
const M32RespInstant = Type.String({ format: "date-time" });
const M32RespInstantOrNull = Type.Union([Type.String({ format: "date-time" }), Type.Null()]);
const M32RespStrOrNull = Type.Union([Type.String(), Type.Null()]);

// ── vocab this file's routes need but `m32-typebox.ts` never did (response-only unions) ───────────────

const M32VocabHitlOutcome = Type.Union([
  Type.Literal("accepted"),
  Type.Literal("edited"),
  Type.Literal("rejected"),
  Type.Literal("pending"),
  Type.Literal("not_applicable"),
]);

const M32VocabRoutingDecision = Type.Union([
  Type.Literal("primary"),
  Type.Literal("fallback_1"),
  Type.Literal("fallback_2"),
]);

const M32VocabEvalDecision = Type.Union([
  Type.Literal("approve_for_pilot"),
  Type.Literal("approve_for_ga"),
  Type.Literal("reject"),
  Type.Literal("recalibrate_thresholds"),
  Type.Literal("no_decision"),
]);

const M32VocabKillSwitchActorKind = Type.Union([
  Type.Literal("ai_safety_owner"),
  Type.Literal("incident_commander"),
  Type.Literal("automated_cost_watch"),
  Type.Literal("automated_drift_monitor"),
  Type.Literal("automated_vendor_health_monitor"),
  Type.Literal("automated_lifecycle_demotion"),
]);

const M32VocabTenantOptInStatus = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("opted_out"),
]);

const M32VocabUnavailableReason = Type.Union([
  Type.Literal("phase_1_capability_shell"),
  Type.Literal("lifecycle_state_below_approved"),
  Type.Literal("lifecycle_state_retired"),
  Type.Literal("not_enrolled_as_pilot_tenant"),
  Type.Literal("tenant_not_opted_in"),
  Type.Literal("clinician_opted_out"),
  Type.Literal("kill_switch_active"),
  Type.Literal("token_hard_cap_reached"),
  Type.Literal("phi_minimization_failure"),
  Type.Literal("backend_unhealthy"),
  Type.Literal("provider_unregistered"),
  Type.Literal("output_validation_failed_after_retry"),
]);

/** `AiCapabilityConsumerPosture` (packages/types/src/ai-platform.ts) — the §2.2 posture R3 publishes. */
const M32VocabConsumerPosture = Type.Union([
  Type.Object({ kind: Type.Literal("unavailable"), reason: M32VocabUnavailableReason }),
  Type.Object({ kind: Type.Literal("pilot_tenants_only") }),
  Type.Object({ kind: Type.Literal("generally_available") }),
  Type.Object({ kind: Type.Literal("existing_opt_ins_only") }),
]);

// ── row schemas ─────────────────────────────────────────────────────────────────────────────────────

/** `AiCapabilityGovernanceRow` (governance/store.ts). */
const M32CapabilityGovernanceRowSchema = Type.Object({
  id: M32RespUuid,
  capabilityKey: Type.String(),
  displayName: Type.String(),
  riskTier: M32VocabRiskTier,
  lifecycleState: M32VocabLifecycleState,
  defaultBackendKey: Type.String(),
  allowedBackendKeys: Type.Array(Type.String()),
  tenantOptInRequired: Type.Boolean(),
  clinicianOptOutSupported: Type.Boolean(),
  currentPromptTemplateKey: M32RespStrOrNull,
  firstApprovedAt: M32RespInstantOrNull,
  lastReapprovedAt: M32RespInstantOrNull,
  nextReapprovalDueAt: M32RespInstantOrNull,
});

/** `AiLifecycleEventRow` (governance/store.ts) — one §2.2 ledger entry. */
const M32LifecycleEventRowSchema = Type.Object({
  id: M32RespUuid,
  capabilityId: M32RespUuid,
  fromState: Type.Union([M32VocabLifecycleState, Type.Null()]),
  toState: M32VocabLifecycleState,
  actorMembershipId: M32RespUuid,
  actorRole: M32VocabOwningRole,
  approvalKind: M32VocabApprovalKind,
  reason: Type.String(),
  rationaleText: Type.String(),
  linkedEvaluationRunId: M32RespStrOrNull,
  stageArtifacts: Type.Record(Type.String(), Type.Unknown()),
  transitionedAt: M32RespInstant,
});

/** `AiCalibrationRow` (governance/store.ts) — one §3.2.3 calibration publication. */
const M32CalibrationRowSchema = Type.Object({
  id: M32RespUuid,
  capabilityId: M32RespUuid,
  backendKey: Type.String(),
  thresholds: Type.Unknown(),
  baselineMetrics: Type.Unknown(),
  baselineSetAt: M32RespInstant,
  baselineEvaluationRunId: Type.String(),
  isCurrent: Type.Boolean(),
  supersededReason: M32RespStrOrNull,
  supersededById: M32RespStrOrNull,
  createdAt: M32RespInstant,
  supersededAt: M32RespInstantOrNull,
});

/** `AiClinicianOptOutRow` (governance/store.ts). */
const M32ClinicianOptOutRowSchema = Type.Object({
  id: M32RespUuid,
  organizationId: M32RespUuid,
  membershipId: M32RespUuid,
  capabilityId: M32RespUuid,
  optedOut: Type.Boolean(),
  reason: M32RespStrOrNull,
  optedOutAt: M32RespInstant,
  revertedAt: M32RespInstantOrNull,
});

/** `AiTenantOptInRow` (governance/store.ts). */
const M32TenantOptInRowSchema = Type.Object({
  id: M32RespUuid,
  organizationId: M32RespUuid,
  capabilityId: M32RespUuid,
  status: M32VocabTenantOptInStatus,
  orgAdminMembershipId: M32RespUuid,
  routingPreferenceSnapshot: M32VocabRoutingPreference,
  pilotEnrollment: Type.Boolean(),
  optedInAt: M32RespInstantOrNull,
  pausedAt: M32RespInstantOrNull,
  pausedReason: M32RespStrOrNull,
  optedOutAt: M32RespInstantOrNull,
  optedOutReason: M32RespStrOrNull,
});

/** `AiEvaluationRunRowProjection` (safety/store.ts, extends `AiEvaluationRunSnapshot`). */
const M32EvaluationRunRowSchema = Type.Object({
  id: M32RespUuid,
  capabilityId: M32RespUuid,
  backendId: M32RespUuid,
  stage: M32VocabEvalStage,
  status: M32VocabEvalStatus,
  decision: M32VocabEvalDecision,
  startedAt: M32RespInstantOrNull,
  completedAt: M32RespInstantOrNull,
  datasetVersionRef: Type.String(),
  mlflowRunId: Type.String(),
  summaryMetrics: Type.Record(Type.String(), Type.Unknown()),
  initiatedByMembershipId: M32RespUuid,
  createdAt: M32RespInstant,
});

/** `AiHallucinationReportRowProjection` (safety/store.ts) — the §5.1.5 triage-queue row (no cipher). */
const M32HallucinationReportRowSchema = Type.Object({
  id: M32RespUuid,
  organizationId: M32RespUuid,
  providerEntityId: M32RespUuid,
  locationId: M32RespStrOrNull,
  invocationId: M32RespStrOrNull,
  capabilityId: M32RespUuid,
  reporterMembershipId: M32RespUuid,
  reporterRole: Type.String(),
  severity: M32VocabHallucinationSeverity,
  hallucinationKind: M32VocabHallucinationKind,
  triageStatus: M32VocabTriageStatus,
  triageOwnerMembershipId: M32RespStrOrNull,
  triageDisposition: Type.Union([M32VocabTriageDisposition, Type.Null()]),
  mitigationActionRef: M32RespStrOrNull,
  reportedAt: M32RespInstant,
  triagedAt: M32RespInstantOrNull,
  closedAt: M32RespInstantOrNull,
});

/** `AiKillSwitchRowProjection` (safety/store.ts, extends `AiKillSwitchRowSnapshot`). */
const M32KillSwitchRowSchema = Type.Object({
  id: M32RespUuid,
  organizationId: M32RespStrOrNull,
  capabilityId: M32RespUuid,
  active: Type.Boolean(),
  reason: Type.Union([M32VocabKillSwitchReason, Type.Null()]),
  activationActorKind: Type.Union([M32VocabKillSwitchActorKind, Type.Null()]),
  activationActorMembershipId: M32RespStrOrNull,
  activationMessage: M32RespStrOrNull,
  activatedAt: M32RespInstantOrNull,
  deactivationActorKind: Type.Union([M32VocabKillSwitchActorKind, Type.Null()]),
  deactivationActorMembershipId: M32RespStrOrNull,
  deactivationMessage: M32RespStrOrNull,
  deactivatedAt: M32RespInstantOrNull,
});

/** `AiRoutingOverrideRowProjection` (invocation/store.ts). */
const M32RoutingOverrideRowSchema = Type.Object({
  id: M32RespUuid,
  organizationId: M32RespUuid,
  capabilityId: M32RespUuid,
  backendKeyPreference: Type.String(),
  overrideReason: M32VocabRoutingOverrideReason,
  setByMembershipId: M32RespUuid,
  effectiveAt: M32RespInstant,
  expiresAt: M32RespInstantOrNull,
});

/** `AiInvocationLedgerView` (read-service.ts) — the §164.528 disclosure-ledger row, masking-ready. */
const M32InvocationLedgerViewSchema = Type.Object({
  invocationId: M32RespUuid,
  organizationId: M32RespUuid,
  providerEntityId: M32RespUuid,
  locationId: M32RespStrOrNull,
  capabilityId: M32RespUuid,
  capabilityKey: Type.String(),
  backendId: M32RespUuid,
  backendKey: Type.String(),
  modelVersionPin: Type.String(),
  promptTemplateVersion: M32RespStrOrNull,
  actorMembershipId: M32RespUuid,
  actorRole: Type.String(),
  patientId: M32RespStrOrNull,
  touchedPatientChart: Type.Boolean(),
  consumerCorrelationId: M32RespStrOrNull,
  routingDecision: M32VocabRoutingDecision,
  routingReason: Type.String(),
  inputTokenCount: Type.Integer(),
  outputTokenCount: Type.Integer(),
  durationMs: Type.Integer(),
  status: M32VocabInvocationStatus,
  errorClass: M32RespStrOrNull,
  errorMessage: M32RespStrOrNull,
  hitlOutcome: M32VocabHitlOutcome,
  zdrConfirmed: Type.Boolean(),
  invokedAt: M32RespInstant,
  completedAt: M32RespInstantOrNull,
  disclosedToVendor: Type.Boolean(),
});

/** `AiTokenLedgerEntryView` (read-service.ts). */
const M32TokenLedgerEntryViewSchema = Type.Object({
  ledgerId: M32RespUuid,
  capabilityId: M32RespUuid,
  backendId: M32RespUuid,
  inputTokens: Type.Integer(),
  outputTokens: Type.Integer(),
  cloudCostUsd: M32RespStrOrNull,
  localComputeAttribution: M32RespStrOrNull,
  accruedAt: M32RespInstant,
});

/** `AiTokenForecastView` (read-service.ts) — spend vs. caps; `null` caps mean "unconfigured". */
const M32TokenForecastViewSchema = Type.Object({
  capabilityId: M32RespUuid,
  capabilityKey: Type.String(),
  windowStart: M32RespInstant,
  windowEnd: M32RespInstant,
  spentTokens: Type.Integer(),
  softCap: Type.Union([Type.Integer(), Type.Null()]),
  hardCap: Type.Union([Type.Integer(), Type.Null()]),
  burnRatePerHour: Type.Number(),
  projectedWindowTotal: Type.Number(),
  projectedBreach: Type.Union([Type.Boolean(), Type.Null()]),
});

/** `AiBackendHealthView` (read-service.ts). */
const M32BackendHealthViewSchema = Type.Object({
  backendId: M32RespUuid,
  backendKey: Type.String(),
  kind: Type.String(),
  isActive: Type.Boolean(),
  lastHealthStatus: Type.String(),
  zdrStatus: Type.String(),
  modelVersionPin: Type.String(),
});

/** `AiHealthView` (read-service.ts) — R32's envelope. */
const M32HealthViewSchema = Type.Object({
  status: Type.Union([Type.Literal("ok"), Type.Literal("degraded")]),
  checkedAt: M32RespInstant,
  backends: Type.Array(M32BackendHealthViewSchema),
  capabilityShellMode: Type.Boolean(),
});

// ── response envelopes, one per route ──────────────────────────────────────────────────────────────

/** R2 — GET /api/v1/ai/capabilities. */
const M32CapabilityListResponse = Type.Object({
  capabilities: Type.Array(M32CapabilityGovernanceRowSchema),
  hotPhase1FilterApplied: Type.Boolean(),
});

/** R3 — GET /api/v1/ai/capabilities/:capabilityId (`AiCapabilityGovernanceDetail`, governance/service.ts). */
const M32CapabilityDetailResponse = Type.Object({
  capability: M32CapabilityGovernanceRowSchema,
  posture: M32VocabConsumerPosture,
  lifecycleEvents: Type.Array(M32LifecycleEventRowSchema),
  calibrations: Type.Array(M32CalibrationRowSchema),
  permittedNextStates: Type.Array(M32VocabLifecycleState),
});

/** R6 — GET /api/v1/ai/capabilities/:capabilityId/calibration/history. */
const M32CalibrationHistoryResponse = Type.Object({
  calibrations: Type.Array(M32CalibrationRowSchema),
});

/** R15 — GET /api/v1/ai/clinician-opt-out. */
const M32ClinicianOptOutListResponse = Type.Object({
  optOuts: Type.Array(M32ClinicianOptOutRowSchema),
});

/** R31 — GET /api/v1/ai/drift/recent (`AiDriftFindingView[]`, read-service.ts). */
const M32DriftRecentResponse = Type.Object({
  source: Type.String(),
  withinHours: Type.Integer(),
  findings: Type.Array(
    Type.Object({ run: M32EvaluationRunRowSchema, capabilityKey: Type.String() }),
  ),
});

/** R27 — GET /api/v1/ai/evaluations. */
const M32EvaluationListResponse = Type.Object({
  runs: Type.Array(M32EvaluationRunRowSchema),
});

/** R18 — GET /api/v1/ai/hallucination-reports. */
const M32HallucinationListResponse = Type.Object({
  reports: Type.Array(M32HallucinationReportRowSchema),
});

/** R32 — GET /api/v1/ai/health. */
const M32HealthResponse = M32HealthViewSchema;

/** R16 — GET /api/v1/ai/invocations (`AiInvocationLedgerPage` + the route's `phiMasked`). */
const M32InvocationSearchResponse = Type.Object({
  rows: Type.Array(M32InvocationLedgerViewSchema),
  nextInvokedAtBefore: M32RespStrOrNull,
  phiMasked: Type.Boolean(),
});

/** R17 — GET /api/v1/ai/invocations/:invocationId (the ledger row + the route's `phiMasked`). */
const M32InvocationDetailResponse = Type.Object({
  ...M32InvocationLedgerViewSchema.properties,
  phiMasked: Type.Boolean(),
});

/** R9 — GET /api/v1/ai/kill-switches. */
const M32KillSwitchListResponse = Type.Object({
  killSwitches: Type.Array(M32KillSwitchRowSchema),
});

/** R29 — GET /api/v1/ai/prompts/:capabilityKey/active. The route hand-projects `ActivePromptDetail`
 *  (packages/ai-platform/src/prompts/prompt-registry.ts) field by field to keep `promptBody` off the
 *  wire (see the handler's own comment); this mirrors exactly that projection. */
const M32PromptActiveResponse = Type.Object({
  capabilityKey: Type.String(),
  templateKey: Type.String(),
  version: Type.Integer(),
  contentHash: Type.String(),
  outputEntityTargetPrefix: Type.String(),
  outputTypePrefix: Type.String(),
  gitArtifactPath: Type.String(),
  approvedAt: M32RespInstantOrNull,
  inputSchemaRef: Type.String(),
  outputSchemaRef: Type.String(),
  compatibleBackendKeys: Type.Array(Type.String()),
  clinicalReviewerAttestation: M32RespStrOrNull,
});

/** R25 — GET /api/v1/ai/routing-overrides. */
const M32RoutingOverrideListResponse = Type.Object({
  overrides: Type.Array(M32RoutingOverrideRowSchema),
});

/** R12 — GET /api/v1/ai/tenant-opt-in. */
const M32TenantOptInListResponse = Type.Object({
  optIns: Type.Array(M32TenantOptInRowSchema),
});

/** R22 — GET /api/v1/ai/tokens/forecast. */
const M32TokenForecastResponse = Type.Object({
  forecasts: Type.Array(M32TokenForecastViewSchema),
});

/** R21 — GET /api/v1/ai/tokens/ledger (`AiTokenLedgerPage`, read-service.ts). */
const M32TokenLedgerResponse = Type.Object({
  entries: Type.Array(M32TokenLedgerEntryViewSchema),
  windowInputTokens: Type.Integer(),
  windowOutputTokens: Type.Integer(),
});

/** R28 — GET /api/v1/ai/evaluations/:runId (bare row; `readAiEvaluationRun` returns it unwrapped). */
const M32EvaluationDetailResponse = M32EvaluationRunRowSchema;

// Every one of these 17 keys already has an entry earlier in this file (M32-T07's summary/query batch)
// — spread-preserve it and add ONLY `response`, so this pass cannot clobber that work.
Object.assign(ROUTE_ENRICHMENTS, {
  "GET /api/v1/ai/capabilities": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/capabilities"],
    response: M32CapabilityListResponse,
  },
  "GET /api/v1/ai/capabilities/:capabilityId": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/capabilities/:capabilityId"],
    response: M32CapabilityDetailResponse,
  },
  "GET /api/v1/ai/capabilities/:capabilityId/calibration/history": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/capabilities/:capabilityId/calibration/history"],
    response: M32CalibrationHistoryResponse,
  },
  "GET /api/v1/ai/clinician-opt-out": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/clinician-opt-out"],
    response: M32ClinicianOptOutListResponse,
  },
  "GET /api/v1/ai/drift/recent": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/drift/recent"],
    response: M32DriftRecentResponse,
  },
  "GET /api/v1/ai/evaluations": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/evaluations"],
    response: M32EvaluationListResponse,
  },
  "GET /api/v1/ai/evaluations/:runId": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/evaluations/:runId"],
    response: M32EvaluationDetailResponse,
  },
  "GET /api/v1/ai/hallucination-reports": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/hallucination-reports"],
    response: M32HallucinationListResponse,
  },
  "GET /api/v1/ai/health": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/health"],
    response: M32HealthResponse,
  },
  "GET /api/v1/ai/invocations": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/invocations"],
    response: M32InvocationSearchResponse,
  },
  "GET /api/v1/ai/invocations/:invocationId": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/invocations/:invocationId"],
    response: M32InvocationDetailResponse,
  },
  "GET /api/v1/ai/kill-switches": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/kill-switches"],
    response: M32KillSwitchListResponse,
  },
  "GET /api/v1/ai/prompts/:capabilityKey/active": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/prompts/:capabilityKey/active"],
    response: M32PromptActiveResponse,
  },
  "GET /api/v1/ai/routing-overrides": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/routing-overrides"],
    response: M32RoutingOverrideListResponse,
  },
  "GET /api/v1/ai/tenant-opt-in": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/tenant-opt-in"],
    response: M32TenantOptInListResponse,
  },
  "GET /api/v1/ai/tokens/forecast": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/tokens/forecast"],
    response: M32TokenForecastResponse,
  },
  "GET /api/v1/ai/tokens/ledger": {
    ...ROUTE_ENRICHMENTS["GET /api/v1/ai/tokens/ledger"],
    response: M32TokenLedgerResponse,
  },
});

// WX-PR-020 (OPS-004) — M1 operator outbox visibility (apps/backend/src/bootstrap/routes/ops-outbox.ts).
const OpsOutboxStatus = Type.Union([
  Type.Literal("pending"),
  Type.Literal("dispatching"),
  Type.Literal("dispatched"),
  Type.Literal("failed"),
]);
const OpsOutboxRowSummary = Type.Object({
  id: Type.String({ format: "uuid" }),
  eventType: Type.String(),
  aggregateKind: Type.String(),
  aggregateId: Type.String({ format: "uuid" }),
  status: OpsOutboxStatus,
  attemptCount: Type.Integer(),
  createdAt: Type.String({ format: "date-time" }),
  dispatchedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
  nextAttemptAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
});
const OpsOutboxListQuery = Type.Object({
  status: Type.Optional(OpsOutboxStatus),
  before: Type.Optional(Type.String({ format: "date-time" })),
  limit: Type.Optional(Type.String()),
});
const OpsOutboxListResponse = Type.Object({
  data: Type.Array(OpsOutboxRowSummary),
  nextCursor: Type.Union([Type.String(), Type.Null()]),
});
const OpsOutboxDetailResponse = Type.Object({
  ...OpsOutboxRowSummary.properties,
  lastError: Type.Union([Type.String(), Type.Null()]),
  payload: Type.Unknown(),
});

Object.assign(ROUTE_ENRICHMENTS, {
  "GET /api/v1/ops/outbox": {
    summary: "List outbox events (operator recovery view, WX-PR-020)",
    query: OpsOutboxListQuery,
    response: OpsOutboxListResponse,
  },
  "GET /api/v1/ops/outbox/:id": {
    summary: "Outbox event detail — full payload + last error (operator recovery view, WX-PR-020)",
    response: OpsOutboxDetailResponse,
  },
});
