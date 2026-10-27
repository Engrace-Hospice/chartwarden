# 19 — Remediation roadmap

## Sprint 0 — Immediate containment

| Task | Findings | Priority | Files | Dependencies | Complexity | Implementation / acceptance / tests / risks / done |
|---|---|---|---|---|---|---|
| R-001 Payer interval integrity | 0001 | P1 | M5 payer service/reader, M23 adapter, migration | choose interval convention | High | Enforce non-overlap and one range-wide cross-kind resolver. Accept: ambiguous/interior changes fail before claim write. Tests: transition, concurrency, migration backfill. Risk: historical rows. Done: live tests + data audit green. |
| R-002 Reinstate release verification | 0002,0003 | P1 | ci.yml, deploy.yml | runner budget/debounce | Medium | Make release need reusable full CI after debounce. Accept: deliberate lint/test failure blocks image. Tests: workflow graph fixture. Risk: Actions cost. Done: protected verified commit only. |
| R-003 Production backup control | 0013 | P1 | backup/restore automation, runbook | off-site storage/KMS | High | Coordinated DB+objects, WAL/PITR, immutable off-site copies. Accept: witnessed full restore within approved RPO/RTO. Tests: RLS, checksums, document retrieval. Risk: false restore confidence. Done: recurring evidence. |
| R-004 Safe schema rollback | 0017 | P1 | deploy.sh, migration policy | R-002 | High | Enforce expand compatibility and refuse old-code restart when unknown. Accept: fault injection never activates incompatible pair. Tests: additive/incompatible/partial migration. Done: automated drill. |

R-001 and R-002 can run in parallel. R-003 can start in parallel but requires operational ownership.
R-004 follows an agreed migration contract and should land behind R-002.

## Sprint 1 — Build and type safety

| Task | Findings | Priority | Files | Dependencies | Complexity | Implementation / acceptance / tests / risks / done |
|---|---|---|---|---|---|---|
| R-005 Restore lint signal | 0003 | P2 | diagnostics across repo | R-002 optional | Medium | Fix behavioral/a11y first; isolate mechanical change. Accept: configured lint zero or approved shrinking baseline. Tests: full typecheck/build/test. Risk: mass-format conflicts. Done: release-enforced. |
| R-006 Deterministic Docling | 0009,0010 | P2 | worker Dockerfile/lock/workflow | upstream Pillow compatibility | Medium | Lock/hash CPU graph and run pytest/golden corpus. Accept: two builds resolve same graph. Tests: malformed and parser goldens. Risk: CVE/compat tension. Done: CI mandatory. |

## Sprint 2 — Core workflow correctness

| Task | Findings | Priority | Files | Dependencies | Complexity | Implementation / acceptance / tests / risks / done |
|---|---|---|---|---|---|---|
| R-007 HOPE discipline policy | 0006 | P2 | HOPE discipline, ABAC, docs | agency policy/effective date | Medium | Version policy and permit LPN/LVN where enabled. Accept: v1.03 behavior and denied unknown roles. Tests: service+ABAC+date. Risk: local scope-of-practice rules. Done: compliance review signed. |
| R-008 Payer preflight UX | 0007 | P2 | claim wizard/API model | R-001 semantics | Medium | Read-only early guidance; final server remains authoritative. Accept: early correction and no data loss. Tests: race and stale payer. Risk: false client confidence. Done: E2E. |

## Sprint 3 — Frontend and usability

| Task | Findings | Priority | Files | Dependencies | Complexity | Implementation / acceptance / tests / risks / done |
|---|---|---|---|---|---|---|
| R-009 Remove PHI Web Storage | 0014 | P2 | step-up drafts/addendum flows | short-lived server store | High | One-time encrypted server draft token or PHI-free resume. Accept: no PHI values in Web Storage. Tests: expiry/logout/lock/XSS boundary. Risk: lost edits. Done: browser security test. |
| R-010 Browser/a11y matrix | 0008 | P2 | Playwright projects/fixtures | isolated stack | High | Cover all SPAs, dynamic critical routes, six viewports, manual WCAG. Accept: critical paths + negative roles. Risk: flake/runtime. Done: scheduled and release tiers. |
| R-011 Bundle budgets | 0004,0005 | P2 | portal checker, route imports | valid measurement first | Medium | Fail missing assets, split eager graphs. Accept: real nonzero portal measure and all budgets pass. Tests: build artifact fixtures. Risk: chunk waterfall. Done: CI budget. |

## Sprint 4 — Reliability and integration

| Task | Findings | Priority | Files | Dependencies | Complexity | Implementation / acceptance / tests / risks / done |
|---|---|---|---|---|---|---|
| R-012 Runtime hardening | 0011,0012 | P2 | compose/ops | measured capacity | Medium | Pin image digests; set budgets/reservations/alerts. Accept: controlled update and burst recovery. Tests: pressure/failover. Risk: limits too low. Done: load evidence. |
| R-013 Live-suite hygiene | 0015,0016 | P3 | HOPE/M17 live tests | private DB runner | Low | Canonical role cleanup and on-call table coverage. Accept: order independence and 9/9 named/live. Done: CI matrix. |

## Sprint 5 — Production hardening

| Task | Findings | Priority | Files | Dependencies | Complexity | Implementation / acceptance / tests / risks / done |
|---|---|---|---|---|---|---|
| R-014 Evidence reconciliation | 0018 | P3 | guides/status/E2E comments | preceding feature truth | Low | Correct claims and heuristics. Accept: no listed contradiction. Tests: docs/status gates. Done: generated reports current. |
| R-015 Operational certification pack | blockers | P1 | runbooks/evidence | R-001–R-013 | High | Pen test, vendor sandboxes, load/failure drills, incident/backup/alert evidence. Accept: every gate has dated owner/evidence. Risk: paper compliance. Done: independent sign-off. |
