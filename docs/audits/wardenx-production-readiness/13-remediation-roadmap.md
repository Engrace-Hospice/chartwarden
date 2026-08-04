# 13 — Remediation Roadmap

**Audit date:** 2026-08-03. Phases are dependency-ordered: each unblocks the next. Complexity is S/M/L/XL (effort, not calendar). "Findings addressed" cross-reference the dimension reports.

---

## Phase 0 — Immediate containment (stop the silent lies)
**Objective:** make every fake-success fail closed instead, so no compliance-grade attestation or clinical signal is false while the real fixes land.
- Findings: ARCH-007 (erasure), ARCH-006 (audit sinks), UI-003 (EVV 100%), FLOW-007 (false "Invitation sent"), UI-010 (silent saves).
- Actions: (a) make store-less erasers and in-memory audit executors **refuse to register** on a `db` boot (throw) rather than fake success; (b) EVV compliance renders "—" until a real numerator exists; (c) the invite UI stops printing "sent" until delivery is real; (d) silent writes get a confirmation/toast or a "not yet wired" notice.
- Dependencies: none. Risk: turning fake-success into visible failure will surface the true breadth of the gap — that is the point.
- Tests: a boot assertion test; an erasure test asserting failure (not success) when store-less.
- Acceptance: no code path returns success for an operation that performed no durable work.
- Complexity: **S–M**.

## Phase 1 — Build, type & production-wiring stabilization
**Objective:** bind real Drizzle stores everywhere the composition root currently falls back to in-memory, and deliver the outbox dispatcher. This is the single largest correctness win.
- Findings: **ARCH-003, ARCH-006, ARCH-007, ARCH-015** (the in-memory cluster), **OPS-001** (outbox), ARCH-005 (M2 collaborator/auditor/step-up), ARCH-011 (dead ClaimReader registrar), ARCH-004 (ClaimReader/DrugCostBillingReader stubs), PARAM-001/002 + TYPE-001 (contract emitter + de-cast).
- Files: `apps/backend/src/index.ts` (`wireModuleSeams` 513-1062, `wireModuleErasers` 1140-1237, M3/M4 mounts 1461/1464); each module's `seams/index.ts` + `erasers/*.ts` (pass `{db}`); `03-authorization/index.ts:108-109`; a new outbox relay + `bootstrap/outbox-persister.ts`; `scripts/openapi/emit.ts` + `enrichments.ts`.
- Dependencies: Phase 0's boot assertion makes regressions visible.
- Risk: broad wiring change; mitigate with the boot assertion + per-seam live tests.
- Tests: `getSeam("PatientReader").findById` returns a routed-in row; an erase deletes real rows; an emitted event reaches a consumer; `/me/permissions` non-empty for a seeded admin.
- Acceptance: zero `createInMemory*` bindings on a `DATABASE_URL` boot; outbox pending depth bounded; the boot assertion is a gate.
- Complexity: **L**.

## Phase 2 — Security & data-integrity remediation
**Objective:** close the tenant-isolation regression and the PHI/secret gaps.
- Findings: DB-002 (FORCE RLS), DB-004 (zero-policy platform tables), DB-003 (M29/M35 isolation proof), SEC-001 (witness secret), SEC-002/API-004 (PHI read-audit perimeter), SEC-005/OPS-010 (env validation), DB-005 (time-relative CHECKs).
- Files: a new `0154` forward migration re-running 0118's catalog sweep + adding `TO wardenx_admin` policies (never edit applied migrations); `bootstrap/env.ts`; `13-emar/emar-route-service-db.ts:75`; `bootstrap/index.ts` read-audit prefixes + clinical-core/portal/IPU GET annotations; new m29/m35 live-RLS suites.
- Dependencies: none hard, but the boot assertion (Phase 1) should be green first.
- Risk: the FORCE resweep must land **with** the zero-policy fix (DB-004) or the owner path breaks; sequence in one migration.
- Tests: `SELECT count(*) FROM pg_class WHERE relrowsecurity AND NOT relforcerowsecurity` = 0; m29/m35 suites pass in CI; prod boot fails without the witness key.
- Acceptance: gates 8 and 10 (report 02) move off Fail/Conditional.
- Complexity: **M–L**.

## Phase 3 — Architecture & module-boundary correction
**Objective:** fix the behavioral defects the gates cannot see, and upgrade the gates.
- Findings: ARCH-001/002 (cosign predicate collision + registrar first-wins), ARCH-017 (table-ownership blind spot), ARCH-018 (M31 seam self-certification), ARCH-012 (seam last-wins), ARCH-008/009 (unassembled context fields), ARCH-021 (money kernel duplication), ARCH-019/020 (AI-catalog + denylist drift).
- Files: `{08,09,11}-*/abac-predicates.ts` (namespace to `mN.cosigner_role_match`); `scripts/check-table-ownership.ts`, `check-abac-predicates.ts`, `check-fitness-gaps.ts`; `authenticate.ts`/`request-context.ts` (assemble `providerEntityIds`/`locationIds`/`actorKind`); extract `@wardenx/money`.
- Dependencies: Phase 1 (context assembly interacts with seam wiring).
- Tests: RN cosigns an assessment and an order live; the table-ownership gate flags a synthetic `schema.visit` read from M18; duplicate ABAC name fails the gate.
- Acceptance: gate 7 (report 02) moves off Fail.
- Complexity: **M**.

## Phase 4 — Core workflow completion
**Objective:** make the product operable from the UI.
- Findings: FLOW-001/003 (clinical write ceremonies), FLOW-008 (claim writes), FLOW-007 (onboarding + role editor), FLOW-002 (dead routes), UI-010 (confirm/toast).
- Files: `apps/web/src/modules/{06,08}-*` write surfaces; `packages/ui/src/core/api/client.ts` (idempotency-key middleware); `23-billing-medicare` claim screens; `02-identity` onboarding + a transactional email sender; shared ConfirmDialog/toast.
- Dependencies: Phase 1 (contract emitter for headers), Phase 3 (cosign fix, context assembly), UI primitives (UI-005/010).
- Tests: sign→cosign, referral→admit→activate, assemble→validate→override→submit, invite→accept→role→sign-in — each end-to-end.
- Acceptance: gate 14 (report 02) moves off Fail.
- Complexity: **XL**.

## Phase 5 — Missing-screen implementation
- Findings: report 09 — P0/P1 first (M29 labs queue, HL7 console, M37 bed board/restraints, M30 CAHPS/SRA/QAPI, M28 FHIR console, M31 staff-admin, role editor), then P2.
- Dependencies: Phase 4 primitives; Phase 1 seam wiring (several read real data only after seams are Drizzle-backed).
- Acceptance: every P0/P1 backend capability has an operable, tested screen.
- Complexity: **XL**.

## Phase 6 — UI/UX & design-system consolidation
- Findings: UI-001/002/004/005/006/007/009/011. Export shared Modal/ConfirmDialog/toast; split Error/Empty + retry; `NavLink`+groups; promote module UI kits; code-splitting + responsive shell; extend UI gates to portal/admin.
- Dependencies: can proceed alongside Phases 4–5 (shared primitives feed them).
- Acceptance: gates 15, 16 (report 02) move off Fail.
- Complexity: **L**.

## Phase 7 — Testing & reliability hardening
- Findings: TEST-001 (HTTP smoke suites per module), TEST-002/DB-003/OPS-014 (live-RLS in CI for all modules; generate the matrix), TEST-003 (real-auth conformance), TEST-004 (jsdom smoke render), TEST-005 (gate self-tests), OPS-006/007/011 (graceful shutdown, DLQ promotion + alerts, Redis probe).
- Dependencies: Phases 1–4 (tests assert the fixed behavior).
- Acceptance: gate 4 (report 02) moves off Conditional; every module's routes have an inject suite; every live suite has a CI row.
- Complexity: **L**.

## Phase 8 — Performance & production validation
- Findings: OPS-004 (real readiness probe), OPS-005 (metrics/tracing/errors), OPS-012 (deploy pipeline + Dockerfile + worker entrypoint), OPS-013 (production migration path + gate), OPS-016 (backup/restore + a restore drill), PERF-001/002 (bundle split, eMAR batch), PERF-004 (react-router bump).
- Dependencies: all prior phases (validation is meaningful only on a wired, secured, operable system).
- Acceptance: gates 5, 12, 13, 17, 20 (report 02) move off Fail/Conditional; a clean-clone deploy + a restore drill succeed.
- Complexity: **XL**.

---

## Dependency graph (condensed)
```
Phase 0 (containment) ─▶ Phase 1 (wiring + outbox) ─┬─▶ Phase 2 (security/RLS)
                                                    ├─▶ Phase 3 (arch/gates)
                                                    └─▶ Phase 4 (workflows) ─▶ Phase 5 (screens)
Phase 6 (UI/UX) runs alongside 4–5 · Phase 7 (tests) trails each of 1–4 · Phase 8 (prod) last
```
