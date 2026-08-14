# Plans Execution Audit — 2026-08-14

Scope: all 22 documents in [`docs/plans/`](../docs/plans/) (+ `archon-prompt`), audited for
**execution truthfulness** against `main` and git history. Method: two parallel code-grounded
audits, sampling each plan's headline deliverables.

**The contract is unique to this corpus:** `docs/plans/**` is frozen by `arch:plan-integrity`
(plans are immutable authority inputs to the deterministic build harness; the gate exists because
a run once self-edited its own plan to skip a task — ADR-0030/the `df6c20c6` incident). Staleness
is therefore *by design*, no freshness gate makes sense over files that cannot drift, and this
audit changes **one** file (the run tracker, via the documented human `ALLOW_PLAN_EDITS` hatch —
its intended maintenance mode). Everything else is recorded here.

## 1. Execution scoreboard

| Plan | Status |
|---|---|
| M01-M02 vertical slice · Wave AUTH · Waves A, B, C, D, E, F, H · Waves P2-1, P2-2, P2-3, P3 (M37) · Admin-console/M35 · AUTH_T06 · FRONTEND_INTEGRATION (F0+Tracks A/B) · FRONTEND_BACKLOG (T01–T16) · archon-prompt runbook | **EXECUTED** (verified deliverable-by-deliverable) |
| WAVE_G (M23/M25/M26) | **PARTIAL** — modules + rule framework shipped, but the plan's execution substrate (the Python `x12-worker` sidecar) never existed (ADR-0037) and MAC transport is still the fail-closed `X12_WORKER_NOT_WIRED` stub |
| WAVE_M6_LIVE_WIRE | **PARTIAL** — T01–T05, T07 landed; T06's named seed artifacts never shipped (superseded in effect by `seed-scenario-admission-outcomes.ts`) |
| PHASE_2A_UPGRADES | **ABANDONED / NOT STARTED** — all five target flags (`ai.full`, `hearthnote.layer2`, `documents.doclens`, `scheduling.route_optimization`, full IDG) still default-OFF; everything it targets is built flag-ready by the Phase-1 waves |
| PHASE_3_UPGRADES | **ABANDONED / NOT STARTED** — all five flags (`saas.multi_tenant`, `quality.cahps`/`hvldl_hci`, `cap.full_projection`, `fhir.write`, `dosespot.epcs`) still OFF |

The two ABANDONED plans are the honest statement of **what "production activation" still means**
for this codebase — they are the flag-flip waves that were never run, and several ADR-compliance
backlog items (EPCS, CAHPS, fhir.write) live behind exactly these flags.

## 2. The live-doc contradiction (structural finding)

Five files inside the frozen tree are *coordination artifacts with mutable state*, which the
freeze makes unmaintainable: **ARCHON_RUN_TRACKER.md** (a Status column that stopped recording
after Wave C — 11 of 15 rows stale; updated to ✅ in this merge via the human hatch),
**AUTH_T06** (a findings/status memo whose closing "not yet runnable" is now false),
**FRONTEND_INTEGRATION_PLAN** (inline `✅ done` markers that froze mid-update — T02/T03 shipped
but were never marked), **M01-M02** (the M2-T09 "BLOCKED" block, resolved by ADR-0030, must stay
wrong forever — ironically the self-edit of this very file is why the freeze exists), and
**FRONTEND_BACKLOG** (embedded per-task status). Recommendation, deliberately NOT executed here:
either exempt a named `TRACKER`-suffix set from the freeze or move living trackers out of
`docs/plans/` — a policy decision.

## 3. Notable write-time/stale assertions (recorded only — plans stay frozen)

- WAVE_G described the Python sidecar in the present tense; its "architecture §12" citation now
  resolves to a section banner-marked `STATUS: TARGET — NOT BUILT`.
- Seam-name drift is widespread but harmless (plans predate the registry): `RemittanceReader`,
  `HqrpMeasureProvider`, `CostReportProvider`, `MedicareClaimReader`, `PatientDaysProvider` don't
  exist under those names.
- WAVE_H's "M32 headless, no web codePath" was superseded by GAP-049 (12 M32 screens now).
- PHASE_3 cites "ADR-005" meaning the M30 spec's *internal* register — a numbering collision with
  `docs/adr/ADR-0005` (the namespace note added to the corpora on 2026-08-14 covers this class).
- FRONTEND_BACKLOG's own done-invariant is violated by one ledger row: User Profile & Preferences
  remains `deferred (partial)` with all blockers merged — the one genuinely open Track-A item.
- Owned-table counts drifted upward plan→shipped in six waves (M7 6→7, M11 7→8, M12 6→7,
  M16 9→10, M17 7→8, M18 6→7, M22 17→18, M24 14→16) — growth, not loss.

## 4. Enforcement position

No new gate: the corpus cannot drift (frozen), link/citation health is clean (one soft class: the
`PHASE_N_PLAN.md` siblings cited by bare filename live in `docs/`, one level up). The freeze gate
itself (`arch:plan-integrity`) remains the enforcement, and this audit is the compliance layer.
