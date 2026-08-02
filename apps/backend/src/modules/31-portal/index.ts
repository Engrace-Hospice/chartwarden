// apps/backend/src/modules/31-portal — Module 31 Patient/Family Portal & Telehealth backend.
//
// M31-T03 lands the §2.2 portal domain core under ./lifecycle: the portal session class (§8.1), the
// magic-link invitation state machine (§7.1), the grant scope-set resolver (§2.3/§6.4), the M39
// portal-access foundation gate (§4.4/§8.2), and the bereaved lateral flip (§7.5/D6). M31-T04 adds the
// ./read-surfaces lay-language read layer (§4.4/§8.4): consume the upstream portal-summary seams + M38 lay
// labels, project to D17-minimized views, fail-CLOSED for disclosure. The schema (T02) lives in packages/db;
// routes / permissions / ABAC / outbox consumers land in later tasks.
export * from "./lifecycle/index";
export * from "./read-surfaces/index";
