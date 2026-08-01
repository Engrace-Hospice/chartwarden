// apps/web/src/modules/20-field-safety — M20 Field Safety web slice (Track B / ADR-0030, §5).
// The workforce-safety surface: the supervisor live-awareness board and its check-in status ledger; the
// active-SOS centre with the §2.2.6 acknowledgment ceremony; one alert end to end, including the D6
// coordinate stream behind its own permission, its own written reason and its own warn-severity audit
// row; the incident register, the report form and the §2.2.3 lifecycle with §7.6/D9's step-up'd OSHA
// sign-off; the D4 policy editor with its per-knob bands and §2.2.4 replay read; D8's supervisor
// subscriptions with the §2.2.5 coverage-gap report; D12's advisory polygons; the page-derived metrics
// census; and the clinician's own §5.2 surface — the SOS control with its D5 cancel window, her check-in
// obligations, her 90-day history, and the three separately grantable D6/D10 consents.
export { fieldSafetyScreens } from "./screens";
export { SafetyDashboardScreen } from "./safety-dashboard";
export { ActiveSosScreen } from "./sos-active";
export { SosDetailScreen } from "./sos-detail";
export { IncidentLedgerScreen } from "./incident-ledger";
export { IncidentDetailScreen } from "./incident-detail";
export { IncidentNewScreen } from "./incident-new";
export { CheckInLedgerScreen } from "./check-in-ledger";
export { SafetyPolicyScreen } from "./safety-policy";
export { SupervisorSubscriptionsScreen } from "./supervisor-subscriptions";
export { HighRiskAreasScreen } from "./high-risk-areas";
export { SafetyMetricsScreen } from "./safety-metrics";
export { MySafetyScreen } from "./my-safety";
export { MyCheckInsScreen } from "./my-check-ins";
export { MyConsentScreen } from "./my-consent";
