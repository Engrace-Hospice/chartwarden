# 05 — Bugs & Runtime Risks

**Audit date:** 2026-08-03 · **Branch:** `main` @ `91e5b09`.

Confirmed defects are separated from suspected risks. "Confirmed" = the failing path is demonstrable from source with a concrete trigger; "High confidence" = the mechanism is verified but the live trigger was not executed; "Suspected" = plausible from code shape, not proven.

## Confirmed runtime defects (fire in production on the stated trigger)

### BUG-001 — Right-to-erasure returns success having deleted nothing (Critical)
- Confirmed · Blocker · = **ARCH-007**. Trigger: any erase request for one of 25 data classes on a `DATABASE_URL` boot. `wireModuleErasers({db})` calls registrars argument-less (`index.ts:1141-1157`); `registerAdmissionErasers()` → `createInMemoryAdmissionEraseStore()` (`06-admission/erasers/admission-eraser.ts:112`). Result: zero Postgres rows touched, success certificate emitted.

### BUG-002 — Cross-module seam reads answer empty in production (Critical)
- Confirmed · Blocker · = **ARCH-003**. Trigger: portal session resolution / FHIR projection / any consumer of `getSeam("PatientReader"|"LatestAssessmentProvider"|…)`. `registerAssessmentSeams()` (`index.ts:561`) and peers bind in-memory stores. `PatientMutator` (a write seam) also lands in a Map — writes are lost.

### BUG-003 — No admin can grant a role; `/me/permissions` empty for all (Critical)
- Confirmed · Blocker · = **ARCH-015**. Trigger: `GET /api/v1/me/permissions` (returns `{permissions:[]}`) and any role grant (`assertNoEscalation` reads the empty set → 403). `03-authorization/index.ts:108` binds `_fixedPerms([])`.

### BUG-004 — Assessment- and order-cosignature 403 for every caller (Critical)
- Confirmed · Blocker · = **ARCH-001**. Trigger: `POST /assessments/:id/cosignatures`, `POST /orders/:id/cosign`. `cosigner_role_match` resolved by M8's resolver (mount-order first-wins); target carries `id`, never `encounterId` → deny.

### BUG-005 — Every Medicare claim write 400s on missing Idempotency-Key (Critical)
- Confirmed · Blocker · = **FLOW-008**. Trigger: any M23 write from the web app. `claims.routes.ts` `IDEMPOTENT` guard (`routes/concurrency.ts:52-58`) returns 400; `packages/ui/src/core/api/client.ts:34-43` never sets the header; M23 has no local minting (unlike M15/M16/M20/M21).

### BUG-006 — EVV dashboard always reports 100.0% compliance (High)
- Confirmed · Blocker (the metric) · = **UI-003**. `apps/backend/src/modules/18-evv/evv-route-service-db.ts:899-903` hardcodes `complianceRate: 1`, `lateCheckoutRate: 0`; `metrics(orgId)` ignores the UI's 30-day window (`:890`). A CMS-mandated program labeled "(30d)" shows a fixed perfect score.

### BUG-007 — Auth-plane audit events discarded in production (Critical)
- Confirmed · Blocker · = **ARCH-006**. Trigger: role grant/revoke, break-glass invocation (M3), audit-log search (M4). `createInMemoryAuditExecutor()` (`03-authorization/index.ts:109`, `04-audit/index.ts:78`) pushes to an array that is never read.

### BUG-008 — Referral row click drops the app shell into a chromeless 404 (High)
- Confirmed · = **FLOW-002**. `referral-inbox.tsx:103` navigates to unregistered `/referrals/:id` → catch-all NotFound (`system-pages.tsx:102`).

### BUG-009 — Backend outage logs the clinician out mid-shift (High)
- Confirmed · = **FLOW-004**. `session.tsx:74-76` maps any `/auth/context` failure (network, 5xx) to `anonymous` → hard redirect to `/login`; no retry, no route to the built `/offline` page.

### BUG-010 — Claim replace/void payloads are schema-invalid; override never unblocks submit (High)
- Confirmed · = **FLOW-008 detail**. `claim-workbench.tsx:244` sends `{reason:""}` vs required reason ≥20 chars + `ifVersion` (`packages/billing/src/schemas/claim-replace.ts:8-12`); `override-service.ts:139-232` records without re-evaluating while submit gates on `ready`.

### BUG-011 — User invitation reports success but is undeliverable and unacceptable (Critical)
- Confirmed · Blocker · = **FLOW-007**. No email sender wired (`identity-stores-db.ts:19-25`); token never returned; accept requires an authenticated actor but no sign-up screen exists; UI prints "Invitation sent."

## High-confidence risks (mechanism verified; live trigger not executed)

### BUG-012 — FORCE RLS regression → owner-bypass on ~66 tables under a `DATABASE_URL`-only migrate (High)
- = **DB-002**. If the migrator runs with only `DATABASE_URL` (app role becomes table owner), M28/M29/M35/M37 tables that enable-without-force stop applying policies to the app role. Latent until that ownership condition occurs; the repo's own invariant test (`rls-isolation.live.test.ts:2317`) would already fail on a full replay.

### BUG-013 — Provider-entity- and location-scoped write surfaces are dead (High)
- = **ARCH-008/009**. `providerEntityIds`/`locationIds` never assembled → M20 field-safety writes, M24 Medicaid claim submission, M32 hallucination filing, and all 13 M14 IDG meeting routes deny every caller (fail-closed).

### BUG-014 — `pg_restore` will fail on time-relative CHECK constraints (Medium)
- = **DB-005**. `0016:171` (`vacation_until > NOW()`) and `0075:268` will reject aged rows on COPY re-validation, breaking restore and later UPDATEs.

### BUG-015 — Outbox table grows unbounded; cross-module events never delivered (Critical)
- = **OPS-001**. No dispatcher reads `status='pending'`; no purge job.

### BUG-016 — Telehealth webhooks return 200 on a bad HMAC signature and drop the event (Low-Medium)
- = **API-008**. `31-portal/routes/telehealth.routes.ts:171-181` verifies then discards; never mutates lifecycle; masks upstream misconfiguration.

## Suspected / lower-confidence

- **BUG-017 (Low):** `05-patient/patient-route-service-db.ts:91-93` casts a decoded cursor to `[string,string,string]` after only a length check → 500 on a crafted cursor (parameterized, injection-safe).
- **BUG-018 (Low):** DOB age computed via `new Date(dob)` (UTC midnight) vs local getters → off-by-one in negative-UTC offsets (`patient-documents.tsx:235` + 3 more) — PARAM-004.
- **BUG-019 (Low):** framework 4xx (malformed JSON, body-limit) fall to a generic 500 (`error-handler.ts:19-41`) — API-009.
- **BUG-020 (Medium):** eMAR offline-sync runs a per-row transaction loop (`emar-route-service-db.ts:769-773`) — latency/lock risk on a full-shift sync — PERF-002.

## Notes on what is *not* broken
No `any`/ts-suppressions; body validation is sound across sampled modules; break-glass, idempotency, and the M2 identity stores are Drizzle-backed; the in-memory *route-service scaffolds* beside the Drizzle ones are **not** mounted in production (ARCH non-finding 8) — the in-memory problem is specifically in the seam/eraser/audit *wiring*, not the route services.
