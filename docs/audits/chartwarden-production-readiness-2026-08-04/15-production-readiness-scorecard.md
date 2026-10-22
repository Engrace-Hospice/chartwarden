# Production Readiness Scorecard

Scores are ordinal, not percentages: **0 absent, 1 scaffold, 2 partial/high risk, 3 credible but conditional, 4 strong, 5 production-proven**.

| Category | Score | Evidence and rationale |
|---|---:|---|
| Architecture | 3 | Strong manifest/ownership/import/RLS fitness; runtime worker and outbox registries drift from declared intent (ARCH-001/002). |
| Code quality | 3 | Clear typed modules and fail-closed design; current lint failure, stale comments, and substantial incomplete composition. |
| Type safety | 4 | Forced strict composite build passes; 347 double assertions and disabled assertion/any lint reduce the score. |
| API contracts | 2 | Generated client and freshness checks pass, but 113 mutation bodies and 80 GET responses are missing. |
| Database integrity | 4 | 165 migrations apply cleanly/idempotently; strong ownership/RLS/audit triggers. Document placeholder versions and unverified performance prevent 5. |
| Security | 3 | Strong auth/RBAC/ABAC/RLS/step-up/env/log controls; nested audit paths, shared rate limit/CSRF, KMS gap, and advisory remain. |
| Workflow completeness | 1 | Multiple core/regulated workflows accept then fail or are entirely unwired. |
| UI completeness | 2 | 271 structurally reachable screens, but critical capture/recovery/readiness screens and backend paths are missing. |
| UI/UX consistency | 3 | Real design system and shell; only 17 screens mapped and most are partial. |
| Accessibility | 3 | Semantic lint, keyboard patterns, focus-trapped canonical modal; no axe/browser baseline and dialog exceptions. |
| Testing | 3 | 7,850 passing tests and excellent live DB/RLS breadth; no browser E2E/load and misleading module-level inject metric. |
| Reliability | 2 | Durable queues/outbox/retries/DLQ exist, but unbound workers and incomplete routing defeat normal reliability claims. |
| Observability | 3 | Structured PHI-safe logs, readiness, metrics, queue depth, correlation; no deployed traces/alerts/SLO evidence. |
| Deployment | 1 | Image builds; workflow explicitly does not deploy, promote, validate, or rollback. |
| Documentation | 3 | Exceptional architecture/spec corpus; volatile status narrative is stale and deploy/env docs are incomplete. |
| AI safety/provider resilience | 2 | Governance shell and fail-closed posture are good; no live multi-provider execution/failure evidence. |

## Overall Score

**3 / 5: strong engineering foundation, not production ready.** The ordinal overall score recognizes unusually broad static/live database controls while the verdict is driven by release-blocking workflow behavior. Production readiness is not an average: a Critical P0 failure keeps the release at NO-GO regardless of strengths elsewhere.

## Gate to Re-Score

Re-score only after Phase 0 and Phase 2/4 launch workflows have live evidence. A production-ready verdict requires zero unresolved P0 findings, all 20 production gates evaluated, and no “unable to verify” result for deployment, recovery, or performance.
