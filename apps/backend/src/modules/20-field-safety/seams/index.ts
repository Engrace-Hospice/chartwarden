// apps/backend/src/modules/20-field-safety/seams — M20's seam boundary.
//
// `./consumed` (M20-T04) holds the §4.4 accessors for the seams M20 READS: M17's `VisitReader` /
// `VisitAssignmentReader`, M18's `EvvLocationProvider`, M19's `OnCallProvider` and M5's `PatientReader`.
//
// The seven §4.3 seams M20 PUBLISHES (`SafetyDashboardProvider`, `SafetyContextReader`,
// `SafetyIncidentReader`, `SafetyMetricsProvider`, `SafetyCheckInProvider`, `SafetyPolicyProvider`,
// `SafetySupervisorProvider`) land here at M20-T05, alongside the §4.5 `field_safety_composed` recipient
// resolver that composes `SafetySupervisorProvider` with the D14 after-hours union M20-T04 built.
export * from "./consumed";
