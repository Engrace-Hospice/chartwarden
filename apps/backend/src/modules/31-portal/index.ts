// apps/backend/src/modules/31-portal — Module 31 Patient/Family Portal & Telehealth backend.
//
// M31-T03 lands the §2.2 portal domain core under ./lifecycle: the portal session class (§8.1), the
// magic-link invitation state machine (§7.1), the grant scope-set resolver (§2.3/§6.4), the M39
// portal-access foundation gate (§4.4/§8.2), and the bereaved lateral flip (§7.5/D6). The schema (T02)
// lives in packages/db; routes / permissions / ABAC / outbox consumers land in later tasks.
export * from "./lifecycle/index";
