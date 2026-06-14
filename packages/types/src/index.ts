// @wardenx/types — leaf package (depends on nothing app-specific; importable by all).
// Home for seam interface types + outbox event-name/payload types per ADR-0005 D1/D3:
// seam interfaces live here (NOT in the banned packages/foundation), so cross-module
// seam/outbox consumption needs no dependsOn import edge.
export * from "./seams";
export * from "./outbox";
