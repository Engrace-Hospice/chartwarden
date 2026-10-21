# WardenX — Implementation Roadmap (index)

**Status:** Living index. Phasing is authoritative from `WARDENX_ARCHITECTURE_v0_11.md` §20
(Build Sequence) and §20.A (Phased Delivery Plan); these plan files **operationalize** those
sections into buildable waves. If a plan file ever conflicts with architecture §20/§20.A,
**architecture wins** (per the repo authority rule) and the plan file is corrected.

## The phases

| Plan | Architecture ref | Theme | Modules | File |
|---|---|---|---|---|
| **Phase 0** | — (pre-build) | Buildable scaffold + fitness gates that actually run | 0 (infra) | [`PHASE_0_SCAFFOLD_PLAN.md`](./PHASE_0_SCAFFOLD_PLAN.md) |
| **Phase 1 (v1)** | §20.A Phase 1 | Engrace go-live — minimum to operate a real hospice | 29 | [`PHASE_1_PLAN.md`](./PHASE_1_PLAN.md) |
| **Phase 2 (v1.1)** | §20.A Phase 2 | AI activation + operational depth (competitive differentiation) | 10 new + 5 upgrades | [`PHASE_2_PLAN.md`](./PHASE_2_PLAN.md) |
| **Phase 3 (v1.2)** | §20.A Phase 3 | Multi-tenant scale + inpatient | 2 new + 4 upgrades | [`PHASE_3_PLAN.md`](./PHASE_3_PLAN.md) |
| **Phase 4 (v2)** | §20.A Phase 4 | State expansion, enterprise, certifications (future) | open | [`PHASE_4_PLAN.md`](./PHASE_4_PLAN.md) |

New builds: Phase 1 = 29, Phase 2 = 10, Phase 3 = 1 (M37) → 40 modules, each built exactly once.
Phase 2/3 "upgrades" re-open already-built modules to flip default-off flags; they are not new module
counts. (Architecture §20.A previously had an off-by-one — prose "28" vs 29 enumerated — now corrected
in `WARDENX_ARCHITECTURE_v0_11.md`.)

## Phase 1 wave plans (Archon task plans)

`PHASE_1_PLAN.md` schedules Phase 1 into dependency-ordered waves; each wave is decomposed into
**DoD-aligned, gate-bound tasks** an Archon workflow executes (see [`ARCHON_SETUP.md`](./ARCHON_SETUP.md)).
Each task closes on a specific fitness gate; cross-module access is seam/outbox only. To **run** them,
follow [`plans/ARCHON_RUN_TRACKER.md`](./plans/ARCHON_RUN_TRACKER.md) — the ordered command list + a
status checklist across all three phases.

| Wave | Modules | Plan |
|---|---|---|
| Slice | M1, M2 | [`plans/M01-M02_VERTICAL_SLICE_PLAN.md`](./plans/M01-M02_VERTICAL_SLICE_PLAN.md) (+ reusable per-module template) |
| A | M3, M4 | [`plans/WAVE_A_M3-M4_PLAN.md`](./plans/WAVE_A_M3-M4_PLAN.md) |
| B | M36, M38, M40 | [`plans/WAVE_B_M36-M38-M40_PLAN.md`](./plans/WAVE_B_M36-M38-M40_PLAN.md) |
| C | M5, M39 | [`plans/WAVE_C_M5-M39_PLAN.md`](./plans/WAVE_C_M5-M39_PLAN.md) |
| D | M6, M7, M8 | [`plans/WAVE_D_M6-M7-M8_PLAN.md`](./plans/WAVE_D_M6-M7-M8_PLAN.md) |
| E | M9, M10, M11, M12, M13 | [`plans/WAVE_E_M9-M13_PLAN.md`](./plans/WAVE_E_M9-M13_PLAN.md) |
| F | M14, M17, M18, M22 | [`plans/WAVE_F_M14-M17-M18-M22_PLAN.md`](./plans/WAVE_F_M14-M17-M18-M22_PLAN.md) |
| G | M23, M25, M26 | [`plans/WAVE_G_M23-M25-M26_PLAN.md`](./plans/WAVE_G_M23-M25-M26_PLAN.md) |
| H | M28, M29, M30, M32, M34 | [`plans/WAVE_H_M28-M29-M30-M32-M34_PLAN.md`](./plans/WAVE_H_M28-M29-M30-M32-M34_PLAN.md) |

All 29 Phase-1 modules are covered exactly once. Build order across waves is the §20 dependency order;
within a wave, the plan states the internal parallelism and which forward-seams/deny-stubs it opens or closes.

### Phase 2 wave plans

`PHASE_2_PLAN.md` = Part A (5 flag-activation upgrades to Phase-1 modules) + Part B (10 new modules).

| Wave | Modules / upgrades | Plan |
|---|---|---|
| Part A | M32 `ai.full`, M8 `hearthnote.layer2`, M14 full IDG, M22 `documents.doclens`, M17 `route_optimization` | [`plans/PHASE_2A_UPGRADES_PLAN.md`](./plans/PHASE_2A_UPGRADES_PLAN.md) |
| P2-1 | M15, M16, M21, M24 | [`plans/WAVE_P2-1_M15-M16-M21-M24_PLAN.md`](./plans/WAVE_P2-1_M15-M16-M21-M24_PLAN.md) |
| P2-2 | M19, M20 | [`plans/WAVE_P2-2_M19-M20_PLAN.md`](./plans/WAVE_P2-2_M19-M20_PLAN.md) |
| P2-3 | M27, M31, M33, M35 | [`plans/WAVE_P2-3_M27-M31-M33-M35_PLAN.md`](./plans/WAVE_P2-3_M27-M31-M33-M35_PLAN.md) |

Phase 2 leaves only **M37 (Inpatient Unit)** for Phase 3, plus the Phase-3 flag activations. The
adapter packages those specs reference (`iqies-client`, `evv-aggregators`, `triage-vendors`,
`xero-client`, `gusto-client`) are now in their owners' manifest `codePaths` and fitness-governed
([ADR-0028](./adr/ADR-0028-adapter-package-codepaths.md), applied — 36 packages). `@chartwarden/mobile-offline`
stays intentionally exempt; `x12-worker-client` (split M23/M25 ownership) is the one open item, tracked
for a follow-up ADR.

### Phase 3 wave plans

`PHASE_3_PLAN.md` = 1 new build (M37) + 5 flag-activation upgrades (2 certification-gated).

| Wave | Modules / upgrades | Plan |
|---|---|---|
| New build | M37 IPU (26 tables; raw CREATE TABLE → pgTable first) | [`plans/WAVE_P3_M37_IPU_PLAN.md`](./plans/WAVE_P3_M37_IPU_PLAN.md) |
| Upgrades | M34 `saas.multi_tenant`, M30 `cahps`+`hvldl_hci`, M26 `cap.full_projection`, M28 `fhir.write`†, M12 `dosespot.epcs`† | [`plans/PHASE_3_UPGRADES_PLAN.md`](./plans/PHASE_3_UPGRADES_PLAN.md) |

† external certification gate (FHIR conformance / DEA EPCS) — flag stays off until certified.

**With Phase 3, all 40 modules are built and every feature flag activated.** All five phase decompositions
(Phase 0 scaffold + Phases 1–3 task plans) are complete; Phase 4/v2 is state expansion + enterprise
certification (`PHASE_4_PLAN.md`), not decomposed here.

## Rules that bind every phase

1. **Dependency order is law (§20).** A module is *done* — "tests + UI + audit + RBAC" — before a
   dependent module starts. Waves within a phase group modules with no unmet dependency.
2. **Phase discipline (ADR-0009).** A Phase-N module ships **Phase-N scope only**. Early-building a
   later-phase capability needs (a) an ADR moving the capability's phase **and** (b) a feature flag
   that **defaults off** until that phase activates. A spec may not move its own/sibling phase by
   assertion.
3. **No cross-phase critical path without a fallback.** If a Phase-N capability needs a later-phase
   module, either an ADR pulls the minimal surface forward, or the capability declares a documented
   degraded fallback.
4. **Every module = §20.B template complete.** Workflow acceptance criteria, screens, permissions,
   validations, audit events, route inventory, schema delta, DR tier, and INT inventory — all
   present and CI-gated, not optional prose.
5. **Every module passes the Phase 0 fitness gates.** `arch:boundaries`, `arch:tables`,
   `arch:tenancy`, `arch:ddl`, `arch:gaps`, `docs:ui` stay green on every PR. New tables match the
   manifest's `ownedTables`; cross-module reads go through seams/outbox (no edge), never direct
   schema imports.

## Definition of Done (universal, per module)

A module is not "done" until **all** of these hold:

- [ ] Drizzle schema for its `ownedTables` (server PG), with RLS policies + `withOrgContext` on
      every PHI route, and partitioning per M4 conventions where the spec requires it.
- [ ] Migrations generated and legal (`arch:ddl` green).
- [ ] Routes per the spec's route inventory, each behind `requirePermission`/`requireAbac` and (where
      specified) step-up auth.
- [ ] Permission keys + ABAC predicates registered into M3; audit events emitted per the spec's audit
      table (M4), with the PHI denylist applied.
- [ ] Published seams registered into the M1 seam registry; `validateSeams()` passes at boot.
- [ ] Outbox events emitted with the `mN.` catalog naming; consumers wired (or deny-stubbed if a
      consumer is a later phase).
- [ ] UI screens implemented per `docs/design/screens/*` using the declared layout pattern; `docs:ui` green.
- [ ] Eraser registered with M4; `validateErasers()` passes.
- [ ] DR tier + INT inventory declared; degraded-mode behavior documented where on a cross-phase path.
- [ ] Unit + integration tests (Vitest), including RLS cross-tenant isolation tests and the spec's
      enumerated test cases. Boundary/ownership/tenancy/ddl fixtures stay red on violations.

> The module spec under `docs/modules/` is the implementation proposal for each module; architecture
> wins on conflict. These phase files schedule **when** and **at what scope** each module is built —
> they do not restate the specs.
