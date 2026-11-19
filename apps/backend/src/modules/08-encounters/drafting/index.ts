// apps/backend/src/modules/08-encounters/drafting — the visit-note draft (ADR-0114). PR C1: the per-tenant switch (policy service,
// DB-backed route service; routes in ../routes/drafting-routes.ts). PR C2b1: the draft read and the section resolution (service,
// Drizzle store; routes in ../routes/draft-section-routes.ts).
export * from "./policy-service";
export * from "./route-service";
// PR C2b1: the draft read, the section resolution, and their store.
export * from "./draft-service";
export { createDbRunInOrg, DRAFT_SECTION_AUDIT_EVENT } from "./db-draft-unit";
export type { DraftSectionView, DraftView } from "./draft-view";
