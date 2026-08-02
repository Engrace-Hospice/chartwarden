// apps/backend/src/modules/31-portal — Module 31 Patient/Family Portal & Telehealth backend.
//
// M31-T03 lands the §2.2 portal domain core under ./lifecycle: the portal session class (§8.1), the
// magic-link invitation state machine (§7.1), the grant scope-set resolver (§2.3/§6.4), the M39
// portal-access foundation gate (§4.4/§8.2), and the bereaved lateral flip (§7.5/D6). M31-T04 adds the
// ./read-surfaces lay-language read layer (§4.4/§8.4): consume the upstream portal-summary seams + M38 lay
// labels, project to D17-minimized views, fail-CLOSED for disclosure. M31-T05 adds the ./telehealth domain
// core (§7.2–§7.4 / D8 / D9 / D14): the visit lifecycle state machine, the audio-only Tier-3 fallback planner,
// and the two-party recording-consent gate — paired with the live Daily.co adapter in @wardenx/telehealth-client.
// The schema (T02) lives in packages/db; routes / permissions / ABAC / outbox consumers land in later tasks.
// M31-T06 adds ./write-paths (the three clinical-record write surfaces — caregiver-attested administration
// §7.7 incl. the resolver that CLOSES M13's deny-stub, document upload → M22 intake §7.8, amendment request →
// M5 §164.526 §7.9), ./seams (the seven §4.3 published reader seams + the §4.4 consumed contract + boot
// registration), and ./eraser (the §3.7/D15 destruction core). All PURE cores over injected ports; the
// routes / permissions / ABAC / outbox consumers + the composition-root seam/eraser wiring land in T07.
export * from "./lifecycle/index";
export * from "./read-surfaces/index";
export * from "./telehealth/index";
export * from "./write-paths/index";
export * from "./seams/index";
export * from "./eraser";
