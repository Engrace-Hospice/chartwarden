# 00 — Executive Summary

**System:** WardenX — multi-tenant hospice EHR SaaS (40 modules).
**Audit date:** 2026-08-03 · **Branch:** `main` @ `91e5b09` · **Method:** eight parallel evidence-based specialist audits (architecture, types/contracts, API, database, security, workflows/UI, tests, ops) over the running codebase, with the highest-severity findings re-verified directly against source by the lead auditor. Read-only.

---

## Verdict: **NOT PRODUCTION READY**

WardenX is an unusually well-*engineered* codebase whose gates are all green — clean install, clean production build, 6,746 passing tests, and 17 passing architecture-fitness gates. That green status is exactly the trap. **Every one of the nine production-blocking defects below passes every gate**, because they live in the spaces the gates were built not to see: runtime wiring, cross-module event delivery, UI-to-backend workflow completion, and the difference between "a name resolves" and "the right code answers."

The dominant theme is a **wiring gap between a complete backend and its production composition root**: complete Drizzle services, seams, erasers, and audit sinks exist, but the composition root binds *in-memory stubs* in their place for a large set of modules, and the transactional outbox every module publishes into has no consumer at all. The second theme is a **thin, read-only UI**: the clinical core and revenue cycle have full backends that the web app cannot drive.

**Production-readiness score: 2.4 / 5** (see `15-production-readiness-scorecard.md`).

**Release recommendation:** Do not deploy to any environment handling real PHI. The build is a strong *engineering* baseline but not a *product* that can be operated, audited, or recovered in production today.

---

## Finding totals

| Severity | Count (distinct, post-dedup) |
|---|---|
| **Critical** | **9** |
| High | 33 |
| Medium | 34 |
| Low | 17 |
| Verified fixed since prior audits | 26 |

Counts aggregate the eight dimension reports; cross-dimension duplicates (e.g. SEC-002 = API-004; FLOW-008 root = PARAM-001/002) are counted once.

---

## The 9 production blockers (P0)

Five of these share **one root cause**: the composition root threads a live `db` handle into the *outer* `wireModuleSeams` / `wireModuleErasers` / module-mount functions, but the per-module registrars are then invoked **without arguments**, so their `deps.store ?? createInMemory…Store()` fallback silently selects an in-memory store *despite* the live database.

| # | ID | Blocker | Evidence (verified) |
|---|---|---|---|
| 1 | **ARCH-007** | **Right-to-erasure deletes nothing.** ~25 data-class erasers run over in-memory Maps in production; a HIPAA/CCPA erasure request returns a success destruction-certificate having touched zero Postgres rows. | `index.ts:1141-1157` call registrars with no args; `06-admission/erasers/admission-eraser.ts:112` falls back to `createInMemoryAdmissionEraseStore()`. |
| 2 | **ARCH-003** | **Cross-module reads answer empty in production.** ~15 modules register seams over empty in-memory stores; portal patient-identity resolution, FHIR projections, and M22 document storage silently return nothing — indistinguishable from true negatives. | `registerAssessmentSeams()` `index.ts:561` (no args) → `createInMemoryAssessmentReaderStore()`; `PatientMutator` writes vanish into a Map. |
| 3 | **ARCH-015** | **No admin can grant a role; UI permission-gating reads empty.** M3's route surface binds `_fixedPerms([])` so `/me/permissions` returns `[]` for everyone and the anti-escalation check blocks every grant. (General `requirePermission` guards are unaffected — they use the live DB resolver.) | `03-authorization/index.ts:108`; docstring `:93-94` admits it. |
| 4 | **ARCH-006** | **Authorization-plane audit events are discarded.** M3 (role grant/revoke, break-glass invocation) and M4 (audit-log-search accounting) bind an in-memory audit executor in production; the record of who read the audit log dies with the process while the API reports success. | `03-authorization/index.ts:109`, `04-audit/index.ts:78` = `createInMemoryAuditExecutor()`. |
| 5 | **OPS-001** | **The transactional outbox has no dispatcher.** ~48 files write `outbox_event` rows; nothing reads `status='pending'` (zero `SKIP LOCKED`). Every cross-module event consumer (M22 render, M33 refresh, M14 fan-out) is dead wiring, and the table grows unbounded. | `index.ts:41-46` imports only write-side helpers; `22-documents/outbox-consumers/bindings.ts:40` `DEFERRED=true`. |
| 6 | **ARCH-001** | **Assessment- and order-cosignature are permanently 403.** `cosigner_role_match` is registered by M8, M9, and M11 with incompatible target contracts; silent first-wins (mount order) gives M8 the name, so M9/M11 cosign routes deny every caller. | `{08,09,11}-*/abac-predicates.ts` `if (registry.has(name)) continue`; corroborated by prior memory note. |
| 7 | **FLOW-001** | **The clinical core is a read-only shell.** 0 of 31 M8 encounter write routes and ~0 of ~40 M6 admission routes have a UI caller; no one can sign, cosign, admit, or activate from the web app. | `apps/web/src/modules/08-encounters` has 0 `client.POST`; `cosignature-queue.tsx` shows a 48h countdown with no cosign action. |
| 8 | **FLOW-008** | **Every Medicare claim write fails at runtime.** The shared client never sends the mandatory `Idempotency-Key` (400 on assemble/submit/override); override never unblocks submit; replace/void payloads are schema-invalid; the step-up password is collected then discarded. | `client.ts:34-43` vs `claims.routes.ts` `IDEMPOTENT`; `claim-editor.tsx:159`. Root shared with PARAM-001/002. |
| 9 | **FLOW-007** | **User onboarding is impossible.** No email sender is wired (`identity-stores-db.ts:19-25`: "an invitation cannot currently be accepted by anyone"), no sign-up/set-password screen exists, and role assignment has no UI — while the UI falsely prints "Invitation sent." | `staff-management.tsx:94`; `accept-invitation.tsx:4-6`. |

---

## Top architectural risks

1. **The in-memory-in-production wiring pattern** (blockers 1–4) — one defect class, several compliance-grade blast radii. A boot assertion ("with `db` present, no registered impl may be backed by a `createInMemory*` store") would have caught all of them.
2. **Gates that check names, not behavior** — `arch:abac-predicates` is green while three cosign surfaces collide (ARCH-001/002); `check-table-ownership` is blind to the `schema.<table>` import style so ~35 cross-module accesses escape (ARCH-017); `check-fitness-gaps` trusts any file's `*REQUIRED_SEAMS` so M31 self-certifies three seams that cannot exist (ARCH-018).
3. **Tenant-isolation regression** — FORCE RLS covers only partition leaves post-migration-0118, so ~66 tables from M28/M29/M35/M37 enable-without-force; the repo's own invariant test would fail on a full replay (DB-002). M29/M35 have zero executed cross-tenant proof (DB-003).
4. **No operational substrate** — no deployment artifact, no worker process, a readiness probe that cannot fail, no metrics/tracing, and a backup/restore plan that exists only in prose (OPS-004/005/012/016).

## Top workflow failures
Clinical documentation (FLOW-001), Medicare billing (FLOW-008), and user onboarding (FLOW-007) cannot be completed from the UI. The revenue cycle, IPU (M37), quality (M30), and interfaces (M29) are backends with little or no operable front end.

## Most important missing screens (production-blocking)
M29 unmatched-labs / abnormal-result queue (patient-safety loop, P0); M29 HL7 interface console; M30 CAHPS + SRA; M37 bed board + restraint reassessment (CoP timing); M28 FHIR client console; M31 staff-admin portal pane; the invitee onboarding flow (FLOW-007). See `09-missing-screens-specification.md`.

---

## Estimated remediation phases (dependency-ordered; see `13-remediation-roadmap.md`)
- **Phase 0 — containment:** stop the silent-success lies (erasers, audit sinks, false "Invitation sent"/EVV 100%). Fail closed instead of fake-succeeding.
- **Phase 1 — production wiring:** bind Drizzle stores into every seam/eraser/audit registrar + a boot assertion; build the outbox dispatcher; fix the M3 permission resolver.
- **Phase 2 — security & data integrity:** FORCE-RLS resweep (0154) + zero-policy platform tables; witness signing key; PHI read-audit perimeter; env-validation completeness.
- **Phase 3 — architecture correctness:** cosign predicate split; gate blind spots (table-ownership, abac collisions, seam self-certification).
- **Phase 4 — core workflows:** clinical write ceremonies, claim writes, onboarding.
- **Phases 5–8:** missing screens, UI/UX & design-system consolidation, test/reliability hardening, performance & production validation.

## Go / No-Go
**NO-GO for production.** Re-evaluate after Phases 0–2 close every P0 and the DB-002/DB-003 isolation gaps are proven, at which point a limited pilot with synthetic data and a completed Phase 4 becomes discussable.
