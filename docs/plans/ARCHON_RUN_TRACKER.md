# WardenX — Archon Run Tracker

The ordered command list to build WardenX with Archon (`wardenx-piv` workflow), plus a status tracker
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
- [ ] `cd /Users/fabrice/Apps/WardenX && git checkout main && git pull`
- [ ] `bun install` (auto-activates the pre-push gate via `prepare`) — or `bun run setup:hooks`
- [ ] `archon validate workflows wardenx-piv` → `1 valid, 0 with errors`
- [ ] `archon workflow list` shows `wardenx-piv`

> **Enforcement (free, private repo):** no GitHub branch protection (paid-only on private). `main` is
> guarded by CI-on-every-PR (`build-and-verify`) + the `.githooks/pre-push` gate + PR discipline. See
> `../DEVELOPMENT.md` → "Enforcement model".

---

## Phase 1 (29 modules)

| # | Wave | Modules | Command | Status | PR |
|---|---|---|---|---|---|
| 1 | Slice | M1, M2 | `archon workflow run wardenx-piv --branch feat/m1-m2-slice` | 👀 | [#3](https://github.com/fabwebdev/wardenx/pull/3) ‡ |
| 2 | A | M3, M4 | `archon workflow run wardenx-piv --branch feat/wave-a "Use the plan at docs/plans/WAVE_A_M3-M4_PLAN.md"` | ☐ | |
| 3 | B | M36, M38, M40 | `archon workflow run wardenx-piv --branch feat/wave-b "Use the plan at docs/plans/WAVE_B_M36-M38-M40_PLAN.md"` | ☐ | |
| 4 | C | M5, M39 | `archon workflow run wardenx-piv --branch feat/wave-c "Use the plan at docs/plans/WAVE_C_M5-M39_PLAN.md"` | ☐ | |
| 5 | D | M6, M7, M8 | `archon workflow run wardenx-piv --branch feat/wave-d "Use the plan at docs/plans/WAVE_D_M6-M7-M8_PLAN.md"` | ☐ | |
| 6 | E | M9, M10, M11, M12, M13 | `archon workflow run wardenx-piv --branch feat/wave-e "Use the plan at docs/plans/WAVE_E_M9-M13_PLAN.md"` | ☐ | |
| 7 | F | M14, M17, M18, M22 | `archon workflow run wardenx-piv --branch feat/wave-f "Use the plan at docs/plans/WAVE_F_M14-M17-M18-M22_PLAN.md"` | ☐ | |
| — | ✅ gate | — | ADR-0029 applied (x12-837-client→M23, x12-835-client→M25; 38 pkgs) — no action | ✅ | — |
| 8 | G | M23, M25, M26 | `archon workflow run wardenx-piv --branch feat/wave-g "Use the plan at docs/plans/WAVE_G_M23-M25-M26_PLAN.md"` | ☐ | |
| 9 | H | M28, M29, M30, M32, M34 | `archon workflow run wardenx-piv --branch feat/wave-h "Use the plan at docs/plans/WAVE_H_M28-M29-M30-M32-M34_PLAN.md"` | ☐ | |

‡ **Slice #1 (PR [#3](https://github.com/fabwebdev/wardenx/pull/3)) — in review, NOT yet merged.** The
`wardenx-piv` run was killed at the approval node (nested-Claude hang, [Archon#1067](https://github.com/coleam00/Archon/issues/1067));
PR opened manually. Two merge-blockers before this flips to ✅: (1) the RLS cross-tenant isolation test
(§7.2/§9.3) is `describe.skip`'d — run it against live PG; (2) M2-T09 frontend is **deferred** pending
the core-frontend-app decision ([ADR-0030](../adr/ADR-0030-core-frontend-app-ownership.md)). M3/M4
dependencies are intentional deny-stubs. **Don't start Wave A until PR #3 merges** (it assumes M1/M2 seams).

**Phase 1 done when:** all 29 modules at DoD; the end-to-end scenario passes (admit → elect → care plan
→ encounter → assessment → HOPE → order → eMAR → IDG → schedule → EVV → bill → 835 → cap projection).

## Phase 2 (10 new + 5 upgrades)

| # | Wave | Modules / upgrades | Command | Status | PR |
|---|---|---|---|---|---|
| 10 | Part A | M32 ai.full → M8 L2 → M14 full; M22 DocLens + M17 route-opt | `archon workflow run wardenx-piv --branch feat/p2a-upgrades "Use the plan at docs/plans/PHASE_2A_UPGRADES_PLAN.md"` | ☐ | |
| 11 | P2-1 | M15, M16, M21, M24 | `archon workflow run wardenx-piv --branch feat/p2-1 "Use the plan at docs/plans/WAVE_P2-1_M15-M16-M21-M24_PLAN.md"` | ☐ | |
| 12 | P2-2 | M19, M20 | `archon workflow run wardenx-piv --branch feat/p2-2 "Use the plan at docs/plans/WAVE_P2-2_M19-M20_PLAN.md"` | ☐ | |
| 13 | P2-3 | M27, M31, M33, M35 | `archon workflow run wardenx-piv --branch feat/p2-3 "Use the plan at docs/plans/WAVE_P2-3_M27-M31-M33-M35_PLAN.md"` | ☐ | |

## Phase 3 (M37 + 5 upgrades)

| # | Wave | Modules / upgrades | Command | Status | PR |
|---|---|---|---|---|---|
| 14 | New build | M37 IPU | `archon workflow run wardenx-piv --branch feat/m37-ipu "Use the plan at docs/plans/WAVE_P3_M37_IPU_PLAN.md"` | ☐ | |
| 15 | Upgrades | M34 multi-tenant, M30 CAHPS/HVLDL/HCI, M26 full cap, M28 fhir.write†, M12 epcs† | `archon workflow run wardenx-piv --branch feat/p3-upgrades "Use the plan at docs/plans/PHASE_3_UPGRADES_PLAN.md"` | ☐ | |

† certification-gated (FHIR conformance / DEA EPCS): the run produces flag-ready code; the flag stays
**off** until the external cert lands.

---

## Tips
- **Finer / per-module PRs (recommended for big waves E, G, H):** append `(Module N only)` to the
  message and run a wave's modules in its stated build order, e.g.
  `archon workflow run wardenx-piv --branch feat/m10-hope "Use the plan at docs/plans/WAVE_E_M9-M13_PLAN.md (Module 10 only)"`.
  Keeps review per-module (DoD is per-module).
- **Intra-wave order matters:** each plan states its internal parallelism / ordering (e.g. Wave E:
  M9 ∥ M11 → M10, M12 → M13; Wave C: M5 → M39). The implement-loop builds "next unstarted task" in plan
  order — respect it when scoping per-module.
- **Recover a failed run:** `archon workflow run wardenx-piv --resume` (resumes the most recent failed run).
- **Watch progress:** `archon workflow status` (CLI; v0.3.2 has no `serve`/web dashboard).
- **Don't nest:** launch from a normal terminal, not inside an existing Claude Code session
  (Archon drives its own `claude`).
- **Flags stay off until their phase:** no Phase-1 route may depend on a Phase-2/3 flag; no Phase-2
  route on a Phase-3 flag. The plans build flag-gated surfaces as deny-stubs until activation.

## Open ADRs to apply during the run
- [x] **ADR-0029** (`x12-worker-client` split) — applied (38 pkgs; Wave G plan corrected). No remaining
  ungoverned adapter packages (only `@wardenx/mobile-offline` stays intentionally exempt).
