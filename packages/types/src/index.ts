// @wardenx/types — leaf package (depends on nothing app-specific; importable by all).
// Home for seam interface types + outbox event-name/payload types per ADR-0005 D1/D3:
// seam interfaces live here (NOT in the banned packages/foundation), so cross-module
// seam/outbox consumption needs no dependsOn import edge. M1-T10 adds the standard error
// envelope/classes (§4.3) + the per-request HTTP context shape (§4.5). M2-T04 re-homes
// the SESSION_POLICY / STEP_UP_POLICY platform-floor constants here (ADR-0005 D3 / M02-F03).
export * from "./seams";
export * from "./outbox";
export * from "./errors";
export * from "./http-context";
export * from "./policy/session-policy";
export * from "./policy/step-up-policy";
