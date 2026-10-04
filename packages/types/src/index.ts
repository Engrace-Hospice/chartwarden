// @wardenx/types — leaf package (depends on nothing app-specific; importable by all).
// Home for seam interface types + outbox event-name/payload types per ADR-0005 D1/D3:
// seam interfaces live here (NOT in the banned packages/foundation), so cross-module
// seam/outbox consumption needs no dependsOn import edge. M1-T10 adds the standard error
// envelope/classes (§4.3) + the per-request HTTP context shape (§4.5). M2-T04 re-homes
// the SESSION_POLICY / STEP_UP_POLICY platform-floor constants here (ADR-0005 D3 / M02-F03).
export * from "./seams";
export * from "./outbox";
export * from "./alert-payloads";
export * from "./patient";
export * from "./admission";
export * from "./care-plan";
export * from "./encounter";
export * from "./assessment";
export * from "./hope";
export * from "./orders";
export * from "./dosespot";
export * from "./emar";
export * from "./idg";
export * from "./discipline-plans";
export * from "./bereavement";
export * from "./supplies";
export * from "./oncall";
export * from "./safety";
export * from "./ai-platform";
export * from "./fhir";
export * from "./external-interfaces";
export * from "./scheduling";
export * from "./evv";
export * from "./documents";
export * from "./doclens-sud";
export * from "./doclens-writeback";
export * from "./doclens-clinical-writeback";
export * from "./portal";
export * from "./subscription-billing";
export * from "./inpatient";
export * from "./screen-registry";
export * from "./errors";
export * from "./http-context";
export * from "./policy/session-policy";
export * from "./policy/step-up-policy";
