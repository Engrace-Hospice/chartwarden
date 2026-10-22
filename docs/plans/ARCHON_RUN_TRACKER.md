# ChartWarden — Archon Run Tracker

The ordered command list to build ChartWarden with Archon (`chartwarden-piv` workflow), plus a status tracker
to follow each run. See [`../ARCHON_SETUP.md`](../ARCHON_SETUP.md) for install + the harness model and
[`../IMPLEMENTATION_ROADMAP.md`](../IMPLEMENTATION_ROADMAP.md) for the per-wave plans.

## How to use this tracker
- Run each command from a **normal terminal** (not nested in Claude Code), at the repo root.
- Each run: creates an isolated worktree → loops the plan task-by-task, gating on
  `bun run build && bun run arch:fitness && bun run test` → **pauses at the approval node** → opens a PR.
- **Merge each wave's PR before starting the next** (later waves assume earlier seams exist).
- Update the **Status** column as you go. Legend: `☐` not started · `▶` running · `👀` in review
  (approval gate) · `✅` merged.

## Prerequisites (once)
- [x] **PRs #1 + #2 merged** — `main` is the buildable baseline.
- [ ] `cd <path-to-your-checkout> && git checkout main && git pull`
- [ ] `bun install` (auto-activates the pre-push gate via `prepare`) — or `bun run setup:hooks`
- [ ] `archon validate workflows chartwarden-piv` → `1 valid, 0 with errors`
- [ ] `archon workflow list` shows `chartwarden-piv`

> **Enforcement (free, private repo):** no GitHub branch protection (paid-only on private). `main` is
> guarded by CI-on-every-PR (`build-and-verify`) + the `.githooks/pre-push` gate + PR discipline. See
> `../DEVELOPMENT.md` → "Enforcement model".

---

## Phase 1 (29 modules)

| # | Wave | Modules | Command | Status | PR |
|---|---|---|---|---|---|
| 1 | Slice | M1, M2 | `archon workflow run chartwarden-piv --branch feat/m1-m2-slice` | ✅ | [#3](https://github.com/fabwebdev/wardenx/pull/3) ‡ |
| 2 | A | M3, M4 | `archon workflow run chartwarden-piv --branch feat/wave-a "Use the plan at docs/plans/WAVE_A_M3-M4_PLAN.md"` | ✅ | [#4](https://github.com/fabwebdev/wardenx/pull/4) † |
| 3 | B | M36, M38, M40 | `archon workflow run chartwarden-piv --branch feat/wave-b "Use the plan at docs/plans/WAVE_B_M36-M38-M40_PLAN.md"` | ✅ | [#5](https://github.com/fabwebdev/wardenx/pull/5) § |
| 4 | C | M5, M39 | `archon workflow run chartwarden-piv --branch feat/wave-c "Use the plan at docs/plans/WAVE_C_M5-M39_PLAN.md"` | ✅ | M5 [#6](https://github.com/fabwebdev/wardenx/pull/6) · M39 [#7](https://github.com/fabwebdev/wardenx/pull/7) ✦ |
| 5 | D | M6, M7, M8 | `archon workflow run chartwarden-piv --branch feat/wave-d "Use the plan at docs/plans/WAVE_D_M6-M7-M8_PLAN.md"` | ✅ | merged (Wave D — M6/M7/M8) |
| 6 | E | M9, M10, M11, M12, M13 | `archon workflow run chartwarden-piv --branch feat/wave-e "Use the plan at docs/plans/WAVE_E_M9-M13_PLAN.md"` | ✅ | merged (Wave E — M9–M13) |
| 7 | F | M14, M17, M18, M22 | `archon workflow run chartwarden-piv --branch feat/wave-f "Use the plan at docs/plans/WAVE_F_M14-M17-M18-M22_PLAN.md"` | ✅ | merged (Wave F) |
| — | ✅ gate | — | ADR-0029 applied (x12-837-client→M23, x12-835-client→M25; 38 pkgs) — no action | ✅ | — |
| 8 | G | M23, M25, M26 | `archon workflow run chartwarden-piv --branch feat/wave-g "Use the plan at docs/plans/WAVE_G_M23-M25-M26_PLAN.md"` | ✅ | merged (Wave G — modules shipped; MAC transport remains fail-closed, ADR-0037) |
| 9 | H | M28, M29, M30, M32, M34 | `archon workflow run chartwarden-piv --branch feat/wave-h "Use the plan at docs/plans/WAVE_H_M28-M29-M30-M32-M34_PLAN.md"` | ✅ | merged (Wave H) |

‡ **Slice #1 (PR [#3](https://github.com/fabwebdev/wardenx/pull/3)) — MERGED 2026-06-15.** The
`chartwarden-piv` run was killed at the approval node (nested-Claude hang, [Archon#1067](https://github.com/coleam00/Archon/issues/1067))
and the PR opened manually. Both merge-blockers resolved before merge: (1) RLS cross-tenant isolation is
now **proven on real Postgres** (`rls-isolation.live.test.ts` + CI `rls-live` job) — which also caught &
fixed a write-breaking audit-trigger recursion through `audit_event`'s monthly partitions; (2) M2-T09
frontend was **decided** — [ADR-0030](../adr/ADR-0030-core-frontend-app-ownership.md) (Accepted) carves a
core `apps/web` (M1 shell + `apps/web/src/modules/02-identity` for M2), so the auth screens are a tracked
**follow-up PR**, not missing slice work. Remaining: M3/M4 deny-stubs clear with **Wave A (next)**.

† **Wave A (PR [#4](https://github.com/fabwebdev/wardenx/pull/4)) — MERGED 2026-06-15.** M3
Authorization + M4 Audit **backend**. The run built the full backend then died at the approve node again
(#1067) — recovered + PR'd manually; that hang (and a latent "nothing commits" bug) is now **fixed in
`chartwarden-piv` v0.3.0** ([ADR-0031](../adr/ADR-0031-chartwarden-piv-no-interactive-approve.md): no interactive
approve → auto-commit + auto-PR), so later waves complete on their own. CI green incl. `rls-live` (the M4
per-table trigger redesign does **not** reintroduce the partition recursion). Closes the M1/M2 deny-stubs
(route guards now real). Ratified the narrow `check-table-ownership.ts` helper-path exemption (M4 trigger
generator's `INSERT INTO audit_event`). Deferred: M3-T09 + M4 frontend → the ADR-0030 `apps/web`
follow-up. **Next: Wave B (M36/M38/M40)** — runs autonomously now (v0.3.0).

§ **Wave B (PR [#5](https://github.com/fabwebdev/wardenx/pull/5)) — MERGED 2026-06-20.** M36 Secure
Messaging + M38 Clinical Terminology + M40 Master Data Management **backend** — all 11 tasks each,
gate-green (build + arch:fitness + test, 872 passed). Migrations 0014–0019 add the 39 Wave-B tables
with RLS + M4 audit triggers; manifest/owned-tables unchanged. CI green incl. `rls-live` (cross-tenant
isolation proven on real Postgres for all three: platform reference-data lockdown §7.4 + two-tenant
overlay isolation §7.3). Consumer seams live + boot-validated: `TerminologyProvider`, `AlertEmitter`,
`MdmEntityProvider`, `BaaStatusProvider`. Phase-1 flag discipline holds (M38 semantic search behind
`ai.full` off; M40 M29 NPPES-sync consumers deny-stubbed with the nightly job as the Phase-1 path).
Deferred: all frontend screens (no `apps/web` codePath in the Wave-B manifests) → the ADR-0030 UI
follow-up. **Next: Wave C (M5/M39).**

✦ **Wave C is per-module (M5 → M39).** **M5 Patient & Demographics (PR
[#6](https://github.com/fabwebdev/wardenx/pull/6)) — MERGED 2026-06-20.** Built backend (all 12 M5
tasks, 924 tests) — the 16-table patient spine, the §2.3 match pipeline, and the three M3 boot-gate
seams now real (`CaseloadProvider` + `caseload_membership`, `PatientReader` merge-redirect,
`PatientMutator` D12 strip). Migrations 0020/0021 (16 tables + RLS + M4 audit triggers). CI green incl
`rls-live` (caught & fixed a `gin_trgm_ops` opclass syntax error only real PG surfaces). M5
`dependsOn += 1` (it closes M1 boot-gate seams via the M1 bootstrap registry). Deferred: screens
(no `apps/web` codePath → ADR-0030). M29 proposal + M39 consent consumers are forward-seam deny-stubs.

**M39 Consent & Authorization Management (PR [#7](https://github.com/fabwebdev/wardenx/pull/7)) —
MERGED 2026-06-20.** Built backend (all 11 M39 tasks, 1019 tests) — the 11-table consent platform
(append-only `consent_record` with supersession chains, per-recipient/per-DPOA-agent joins, the
monthly-partitioned INSERT-only `consent_eval_audit`) and the published **`ConsentEvaluator` seam**
(§4.3, the disclosure/redaction gate every PHI-egress module consults; fail-closed redaction §4.3.1 —
SUD decided in M39, HIV/MH/genetic delegated to M5). Migrations 0022/0023 (11 tables + RLS + dual-grant
catalog via the new `consent_catalog_writer` role + M4 audit triggers + the eval-audit partition +
immutability trigger). 15 perm keys + 11 ABAC predicate resolvers into M3; 14 `m39.consent.*` outbox
events drive M5's `patient_privacy_flag_snapshot` recompute end-to-end (the first SUD / 42 CFR Part 2
chain). CI green incl `rls-live` (cross-tenant isolation on real PG: dual-grant catalog lockdown, org
isolation, WITH CHECK, audit scrub, eval-audit immutability). The `consent` eraser refuses to destroy a
Part 2 release during the patient's lifetime (§3.8). Non-circular: M39→M22 via forward-seam deny-stub
(no 22→39 edge). Deferred: screens (no `apps/web` codePath → ADR-0030); W-CON-04/10/11 + M22/M28/M31
forward-seam consumers (Wave F / Phase 2). **WAVE C COMPLETE → Wave D (M6 Admission, M7 Care Plan,
M8 Encounters) unblocked.**

**Phase 1 done when:** all 29 modules at DoD; the end-to-end scenario passes (admit → elect → care plan
→ encounter → assessment → HOPE → order → eMAR → IDG → schedule → EVV → bill → 835 → cap projection).

## Frontend backlog (Track A — runs alongside the backend waves)

Makes the merged-module screens real end-to-end (mount routes + Drizzle-back the seams), fills the M5
Patient Chart's M5-owned tabs, ships the unblockable partials, and clears the M2 auth follow-ups. Not a
new module wave — see [`FRONTEND_INTEGRATION_PLAN.md`](./FRONTEND_INTEGRATION_PLAN.md) (Track A) and the
status ledger [`../design/DEFERRED_SCREENS.md`](../design/DEFERRED_SCREENS.md). Can run anytime after Wave C
(all its target modules — M2/M3/M4/M5/M36/M38/M39/M40 — are on `main`).

| # | Wave | Scope | Command | Status | PR |
|---|---|---|---|---|---|
| A | Track A | M36/M38/M39/M40 live-wire + M5 chart tabs + partials + auth follow-ups | `archon workflow run chartwarden-piv --branch feat/frontend-backlog "Use the plan at docs/plans/WAVE_FRONTEND_BACKLOG_PLAN.md"` | ✅ | merged (Track A + backlog T01–T16) |

> Per-group PRs recommended (the wave has 4 groups, FB-T01…T15): append e.g. `(Group 1 only)` /
> `(FB-T01 only)` to scope a run, like the big-wave per-module tip below. Group 1 (live-wiring) is the
> highest-value first slice.

## Phase 2 (10 new + 5 upgrades)

| # | Wave | Modules / upgrades | Command | Status | PR |
|---|---|---|---|---|---|
| 10 | Part A | M32 ai.full → M8 L2 → M14 full; M22 DocLens + M17 route-opt | `archon workflow run chartwarden-piv --branch feat/p2a-upgrades "Use the plan at docs/plans/PHASE_2A_UPGRADES_PLAN.md"` | ☐ | |
| 11 | P2-1 | M15, M16, M21, M24 | `archon workflow run chartwarden-piv --branch feat/p2-1 "Use the plan at docs/plans/WAVE_P2-1_M15-M16-M21-M24_PLAN.md"` | ✅ | merged (P2-1) |
| 12 | P2-2 | M19, M20 | `archon workflow run chartwarden-piv --branch feat/p2-2 "Use the plan at docs/plans/WAVE_P2-2_M19-M20_PLAN.md"` | ✅ | merged (P2-2) |
| 13 | P2-3 | M27, M31, M33, M35 | `archon workflow run chartwarden-piv --branch feat/p2-3 "Use the plan at docs/plans/WAVE_P2-3_M27-M31-M33-M35_PLAN.md"` | ✅ | merged (P2-3) |

## Phase 3 (M37 + 5 upgrades)

| # | Wave | Modules / upgrades | Command | Status | PR |
|---|---|---|---|---|---|
| 14 | New build | M37 IPU | `archon workflow run chartwarden-piv --branch feat/m37-ipu "Use the plan at docs/plans/WAVE_P3_M37_IPU_PLAN.md"` | ✅ | merged (M37 — 🟢 40) |
| 15 | Upgrades | M34 multi-tenant, M30 CAHPS/HVLDL/HCI, M26 full cap, M28 fhir.write†, M12 epcs† | `archon workflow run chartwarden-piv --branch feat/p3-upgrades "Use the plan at docs/plans/PHASE_3_UPGRADES_PLAN.md"` | ☐ | |

† certification-gated (FHIR conformance / DEA EPCS): the run produces flag-ready code; the flag stays
**off** until the external cert lands.

---

## Tips
- **Finer / per-module PRs (recommended for big waves E, G, H):** append `(Module N only)` to the
  message and run a wave's modules in its stated build order, e.g.
  `archon workflow run chartwarden-piv --branch feat/m10-hope "Use the plan at docs/plans/WAVE_E_M9-M13_PLAN.md (Module 10 only)"`.
  Keeps review per-module (DoD is per-module).
- **Intra-wave order matters:** each plan states its internal parallelism / ordering (e.g. Wave E:
  M9 ∥ M11 → M10, M12 → M13; Wave C: M5 → M39). The implement-loop builds "next unstarted task" in plan
  order — respect it when scoping per-module.
- **Recover a failed run:** `archon workflow run chartwarden-piv --resume` (resumes the most recent failed run).
- **Watch progress:** `archon workflow status` (CLI; v0.3.2 has no `serve`/web dashboard).
- **Don't nest:** launch from a normal terminal, not inside an existing Claude Code session
  (Archon drives its own `claude`).
- **Flags stay off until their phase:** no Phase-1 route may depend on a Phase-2/3 flag; no Phase-2
  route on a Phase-3 flag. The plans build flag-gated surfaces as deny-stubs until activation.

## Open ADRs to apply during the run
- [x] **ADR-0029** (`x12-worker-client` split) — applied (38 pkgs; Wave G plan corrected). No remaining
  ungoverned adapter packages (only `@chartwarden/mobile-offline` stays intentionally exempt).
