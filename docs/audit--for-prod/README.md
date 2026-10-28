# ChartWarden production-readiness audit

Baseline: commit `75e53c73c32396efaaf51bf03bf9c92597831069` on
`fix/m22-disclosure-dialog-followups`, audited 2026-10-27. Decision: **NOT_READY**.

The shared checkout changed concurrently near the end of the audit to commit `ac87c7b4c7b853041e1f43d63187171f7c74ea19`
on `fix/platform-pool-guard`. The findings and runtime results remain scoped to the captured baseline;
the later checkout received a separate architecture-fitness recheck only. See `evidence/baseline.md`.

This directory contains the independent, evidence-first audit requested by the user. Production
source was not modified. The only repository changes are reports, redacted evidence, and one
isolated synthetic reproduction harness.

## Result at a glance

| Severity | Count |
|---|---:|
| P0 | 0 |
| P1 | 4 |
| P2 | 11 |
| P3 | 3 |

The strongest blockers are a runtime-confirmed payer-transition/Medicare assembly defect
(`CW-QA-0001`), release without mandatory full CI (`CW-QA-0002`), missing production object-store
backup evidence (`CW-QA-0013`), and unsafe post-migration automatic rollback (`CW-QA-0017`).

## Navigation

- Start with [01-executive-summary.md](01-executive-summary.md).
- The canonical finding records are [findings.json](findings.json) and [findings.csv](findings.csv).
- Command results and reproduction material are under [evidence/](evidence/).
- [26-audit-coverage-matrix.md](26-audit-coverage-matrix.md) distinguishes inspected, tested,
  blocked, and unverified scope.

## Method and status

Stages A–C and adversarial finding review were completed across the actual monorepo. Runtime work
included full migration/RLS baselines plus targeted authentication, admission, HOPE, Medicare, and
remittance live suites on a private PostgreSQL container. Browser/E2E execution, production-scale
load, live external-vendor exchanges, production backup inspection, and organizational compliance
evidence remained blocked or outside repository access and are never represented as passes.

