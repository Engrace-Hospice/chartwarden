// apps/web/src/modules/19-oncall — M19 On-Call Triage web slice (Track B / ADR-0030, §5.1).
// The after-hours surface: the supervisor board and the intake that starts a record; the §2.2.1 call
// machine as a working panel (server-gated protocol stepper, red-flag banner, disposition matrix,
// encounter hand-off); the D7 escalation inbox where the two writes §7.2 waits on live; the CoP
// 418.100(c)(2) coverage record — roster, shift, and the clinician's own "am I on call?" view; the D4
// two-layer protocol catalog with its red-flag predicate editor; the tenant policy and external-vendor
// configuration; the §2.7 business-continuity paper re-entry; and the page-derived program metrics.
export { oncallScreens } from "./screens";
export { TriageQueueScreen } from "./triage-queue";
export { TriageIntakeScreen } from "./triage-intake";
export { TriageCallPanel } from "./triage-panel";
export { TriageCallHistoryScreen } from "./triage-call-history";
export { TriageTranscriptScreen } from "./triage-transcript";
export { EscalationInboxScreen } from "./escalation-inbox";
export { OnCallShiftsScreen } from "./oncall-shifts";
export { OnCallShiftDetailScreen } from "./oncall-shift-detail";
export { MyOnCallScreen } from "./my-oncall";
export { TriageProtocolCatalogScreen } from "./protocol-catalog";
export { TriageProtocolDetailScreen } from "./protocol-detail";
export { OnCallPolicyScreen } from "./oncall-policy";
export { ExternalVendorAdminScreen } from "./vendor-admin";
export { PaperReentryWorklistScreen } from "./paper-reentry";
export { TriageMetricsScreen } from "./triage-metrics";
