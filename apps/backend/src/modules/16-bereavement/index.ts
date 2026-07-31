// apps/backend/src/modules/16-bereavement — Module 16 (Bereavement).
//
// M16-T03 landed the §2.2–§2.6 lifecycle core (`lifecycle/`) and the seam-consuming layer (`consumers/`,
// `seams/`) that resolves the M6 death fact those machines decide over — the handshake that CLOSES M6's
// `m6.bereavement.eligible` outbox. M16-T04 adds `risk/`: the §4.3.4 evidence extractor over M15's
// `MswRiskFactorReader` + M9's `ScaleSeriesProvider`, the §4.3.3 deterministic D3/D17 scorer that turns it
// into the immutable `bereavement_risk_score` draft, and the `ai.full`-gated M32 Layer-2 narrative adapter.
//
// M16-T05 completes `seams/`: the seven §4.6 / D13 PUBLISHED surfaces (`registerBereavementSeams`) over one
// injected `BereavementSeamStore`, registered into the M1 registry from the composition root ahead of
// `validateSeams()` — six reads plus M32's Layer-2 write-back, which APPENDS to the immutable score ledger.
//
// Still to land: the §4.1 routes with the §4.7 permission keys + §4.8 ABAC predicates + the §4.9 workers that
// execute these machines' side effects (M16-T06), and the §5 screens (M16-T07).
export * from "./lifecycle/index";
export * from "./consumers/index";
export * from "./risk/index";
export * from "./seams/index";
