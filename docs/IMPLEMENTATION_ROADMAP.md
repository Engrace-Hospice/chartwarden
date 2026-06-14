# WardenX — Implementation Roadmap (index)

**Status:** Living index. Phasing is authoritative from `WARDENX_ARCHITECTURE_v0_11.md` §20
(Build Sequence) and §20.A (Phased Delivery Plan); these plan files **operationalize** those
sections into buildable waves. If a plan file ever conflicts with architecture §20/§20.A,
**architecture wins** (per the repo authority rule) and the plan file is corrected.

## The phases

| Plan | Architecture ref | Theme | Modules | File |
|---|---|---|---|---|
| **Phase 0** | — (pre-build) | Buildable scaffold + fitness gates that actually run | 0 (infra) | [`PHASE_0_SCAFFOLD_PLAN.md`](./PHASE_0_SCAFFOLD_PLAN.md) |
| **Phase 1 (v1)** | §20.A Phase 1 | Engrace go-live — minimum to operate a real hospice | 29¹ | [`PHASE_1_PLAN.md`](./PHASE_1_PLAN.md) |
| **Phase 2 (v1.1)** | §20.A Phase 2 | AI activation + operational depth (competitive differentiation) | 10 new + 5 upgrades | [`PHASE_2_PLAN.md`](./PHASE_2_PLAN.md) |
| **Phase 3 (v1.2)** | §20.A Phase 3 | Multi-tenant scale + inpatient | 2 new + 4 upgrades | [`PHASE_3_PLAN.md`](./PHASE_3_PLAN.md) |
| **Phase 4 (v2)** | §20.A Phase 4 | State expansion, enterprise, certifications (future) | open | [`PHASE_4_PLAN.md`](./PHASE_4_PLAN.md) |

¹ Architecture §20.A *prose* says "28 of 40"; its enumerated table lists **29**. The table is
authoritative — see the flagged off-by-one in `PHASE_1_PLAN.md` §intro. New builds: Phase 1 = 29,
Phase 2 = 10, Phase 3 = 1 (M37) → 40 modules, each built exactly once. Phase 2/3 "upgrades" re-open
already-built modules to flip default-off flags; they are not new module counts.

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
- [ ] UI screens implemented per `docs/ui/screens/*` using the declared layout pattern; `docs:ui` green.
- [ ] Eraser registered with M4; `validateErasers()` passes.
- [ ] DR tier + INT inventory declared; degraded-mode behavior documented where on a cross-phase path.
- [ ] Unit + integration tests (Vitest), including RLS cross-tenant isolation tests and the spec's
      enumerated test cases. Boundary/ownership/tenancy/ddl fixtures stay red on violations.

> The module spec under `docs/modules/` is the implementation proposal for each module; architecture
> wins on conflict. These phase files schedule **when** and **at what scope** each module is built —
> they do not restate the specs.
