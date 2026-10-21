# ChartWarden — Phase 3 new build: M37 Inpatient Unit (IPU) Management

Phase 3 new build from `PHASE_3_PLAN.md` §2 — the largest single module (26 tables) and the most
self-contained. Activated only for tenants operating IPUs. **Conventions, determinism rules, the
validate gate, and the legend are inherited from `M01-M02_VERTICAL_SLICE_PLAN.md`.** Spec:
`docs/modules/CHARTWARDEN_MODULE_37_IPU_SPEC_v0_2.md` (has §5 W-IPU workflows).

> **⚠ Format outlier — convert first.** M37's spec authors schema as **raw `CREATE TABLE`** blocks.
> `check-table-ownership.ts` registers ownership only from Drizzle **`pgTable()`** declarations, so the
> 26 tables **must be converted to `pgTable` in `packages/db/src/schema` first** or `arch:tables` won't
> see them as M37-owned (and the DDL/tenancy/phi gates won't arm). This is task M37-T01.
>
> **Outbox-decoupled (PHASE_3 §5.2, D17):** M37 **never writes** M6/M23/M26/M27/M30 schema and they
> never write M37 — all coordination via outbox/seams. This keeps the largest module from
> destabilizing Phase-1/2 modules.
>
> **Seam that goes LIVE this module:** M37's **IV-pump safety overlay** (`ipu_iv_safety_overlay`)
> closes the M13 (Wave E) deferral of the IPU IV-pump overlay. M37 also publishes its **daily census**
> consumed by M23 (per-diem), M26 (inpatient cap), M27 (cost report) via outbox.
>
> **Step-up / break-glass:** restraint application and IRC-cap-override are step-up/break-glass actions.

> **Track B screens (ADR-0030) — built in-task, not deferred.** M37 owns `apps/web/src/modules/37-ipu`: M37-T01 adds that web codePath to the manifest + runs `bun run scaffold` (`arch:parity` 1:1); M37-T11 builds the §5 screens against the generated client and registers them into the M1 shell, flipping the matching `docs/design/DEFERRED_SCREENS.md` row → `done`. Backend-first preserved.

## Module 37 — IPU Management (deps: 6,8,11,13,17,23 · codePaths: apps/backend/src/modules/37-ipu, packages/inpatient, apps/web/src/modules/37-ipu) — 26 tables

- **M37-T01** **Convert raw `CREATE TABLE` → Drizzle `pgTable`** for all 26 tables (§3) in
  `packages/db/src/schema`; enums; `packages/inpatient` layout; seam/outbox types in `packages/types`.
  → `tsc -b`; `arch:tables` shows M37 owns its 26 tables (acceptance §6.1).
  **Track B (ADR-0030):** add `apps/web/src/modules/37-ipu` to the manifest `codePaths` and run
  `bun run scaffold` so the empty web slice exists (→ `arch:parity`).
- **M37-T02** RLS + M4 audit triggers (retention classes `phi_ipu_clinical` + `compliance`) + eraser
  registration + migration. → `arch:tenancy` + `arch:ddl` + `arch:gaps` green; RLS isolation drafted.
- **M37-T03** Hierarchy Unit→Room→Bed (§2.1): `inpatient_unit`/`ipu_room`/`ipu_bed`/`ipu_bed_assignment`;
  bed-cleaning state machine + turnover SLA (§2.12 D13, `ipu_bed_cleaning_event`, breach §5.10).
- **M37-T04** `ipu_admission` lifecycle (§2.2 D2) + `_state_history`/`_transition`; consume M6
  `LevelOfCareReader` (`level_of_care.requires_ipu_bed`) and confirm `ipu.bed_assigned` per M6
  §2.3.5; GIP admission from home (§5.1 W-IPU-01).
- **M37-T05** GIP criteria + per-encounter reassessment (§2.4 D4/D5): `gip_admission_criteria`/
  `gip_criteria_reassessment`; subscribe `m8.encounter.signed` filtered to IPU patients (§5.2); IV
  safety overlay (`ipu_iv_safety_overlay`) over M12/M13 IV-continuous — **closes the M13 deferral**.
- **M37-T06** IRC 5-day cap enforcer (§2.5 D6): `irc_episode`; arranged-inpatient-care CoP 418.112
  (§2.x, `ipu_remote_inpatient_episode`, §5.12); day-4 approaching / day-5 breach (§5.3 W-IPU-03).
- **M37-T07** **24/7 RN coverage invariant (§2.3 D3)** — `ipu_rn_coverage_window`/`ipu_shift`/
  `ipu_staff_assignment`; **block-severity enforcement** on projected gaps (§5.4 W-IPU-04, acceptance
  §6.1); nursing-note shift-coverage detection (§5.14).
- **M37-T08** Restraint policy + reassessment cadence (§2.10 D11, `ipu_restraint_event`/
  `_reassessment`, step-up, §5.6); visitor tracking + outbreak restriction (§2.7 D8, `ipu_visitor`/
  `_restriction`, §5.7); meal service (`ipu_meal_service`); equipment + biomed inspection (§2.9 D10,
  `ipu_equipment`/`_inspection`/`_maintenance`, overdue blocks assignment §5.8).
- **M37-T09** Post-mortem body-release coordination (§2.11 D12, `ipu_body_release`) — M40
  `FuneralHomeReader` + M22 body-release form render; death-in-IPU (§5.9 W-IPU-09).
- **M37-T10** Daily census materialization (§2.13 D14, `ipu_census_snapshot`); publish census via
  outbox (§4.4) → **M23 per-diem (§5.11), M26 inpatient cap, M27 cost report**; consumed seams (§4.5)
  from M6/M8/M11/M13/M17/M23; published seam contracts (§4.11) into M1. → `validateSeams`.
- **M37-T11** Routes (§4.1–4.2) + permission keys (§4.6) + ABAC (§4.7, 5 predicates) into M3; step-up
  for restraint + IRC-cap-override break-glass; **Track B/ADR-0030 screens (§5):** build under
  `apps/web/src/modules/37-ipu` against M37's generated client (`packages/ui/src/api`), registered
  into the M1 shell screen registry, flip the matching `docs/design/DEFERRED_SCREENS.md` row → `done`;
  tests (§5 W-IPU-01..14, **RLS isolation**) + sign-off. → `bun run test` + full `arch:fitness`.

---

## M37 acceptance
1. 26 tables converted to `pgTable` and owned by M37 (`arch:tables` green, acceptance §6.1); RLS +
   migrations; manifest changed only by adding M37's `apps/web/src/modules/37-ipu` codePath (Track B,
   `arch:parity` 1:1).
2. **24/7 RN-coverage block-severity enforcement demonstrated** (§6.1); IRC 5-day cap + GIP
   reassessment + restraint/visitor/equipment/body-release/census workflows pass (§5 W-IPU-*).
3. Fully outbox-decoupled (D17): no cross-module schema writes either direction (`arch:tables`
   raw-SQL/evasion scan green); IV-pump overlay closes the M13 deferral; census feeds M23/M26/M27.
4. RLS isolation passes for all 26 PHI tables.
5. `bun run build && bun run arch:fitness && bun run test` green; fixtures still red.

> Run via Archon, e.g.: `archon workflow run chartwarden-piv --branch feat/m37-ipu "Use the plan at docs/plans/WAVE_P3_M37_IPU_PLAN.md"`
