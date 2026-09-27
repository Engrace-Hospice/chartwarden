# WardenX — M6 Admission live-wire (Archon task plan)

Make **Module 6 (Admission, Election & Certification)** real end-to-end. Wave D built M6 — tables,
seams, the §4.1 route inventory (46 routes), the in-memory `AdmissionRouteService` slice, and the
four `apps/web/src/modules/06-admission` screens — but the routes are **not mounted** in the
composition root (`apps/backend/src/index.ts` wires only `registerAdmissionSeams` + erasers), and the
service is the in-memory slice. So the admission census / detail / referral-inbox / compliance screens
call endpoints that 404, and `patient.status` only changes via direct seed. This wave mounts the
routes over a **Drizzle-backed `AdmissionRouteService`** (reads first, then the full write lifecycle),
seeds real admissions, and proves it with tests. **Same model as the Frontend-Backlog wave
(`WAVE_FRONTEND_BACKLOG_PLAN.md`) — read its header + standing obligations first.** The gate is
unchanged: `bun run build && bun run arch:fitness && bun run test` all green.

> **Pattern to mirror.** The M5 live store `apps/backend/src/modules/05-patient/patient-route-service-db.ts`
> and the M40 `apps/backend/src/modules/40-mdm/mdm-store-db.ts` are the templates: a `createDb…RouteService`
> that runs under `withOrgContext` (RLS backstops as `wardenx_app`, never the superuser), org bound
> from `request.context` (never the body). The **in-memory `createInMemoryAdmissionBackend`**
> (`routes/service.ts`) is the behavioral reference for every method — match its state machine,
> optimistic-concurrency (`ifVersion`), `MutationResult` shape, and event names. The §4.4 outbox names
> live in `events-by-m6.ts`; the §4.6 ABAC role-predicate resolvers in `abac-predicates.ts`.

### Standing obligations (every task)

1. **Backend-first + contract.** Mounting routes regenerates the contract: run `bun run openapi:emit`
   (else `openapi:check` fails) **and** `bun run client:gen`, committing both. Non-trivial bodies get an
   `enrichments.ts` entry.
2. **RLS-correct Drizzle.** All reads/writes run under `withOrgContext` as `wardenx_app`, scoped by the
   request org/session. No cross-module schema imports (M6 owns its tables only). Extend
   `rls-isolation.live.test.ts` where cross-tenant isolation matters (CI `rls-live`).
3. **No new authz on the frontend.** Routes keep the real `requirePermission`/`requireAbac` guards on
   the `M6_CONTRIBUTED_PERMISSIONS` keys already in M3.
4. **No manifest `codePaths` change** — the M6 backend `routes/` + the `apps/web/src/modules/06-admission`
   slice are already on `main`. Mount lines live in M1's composition root (its job).

Specs: `docs/modules/WARDENX_MODULE_06_ADMISSION_ELECTION_CERTIFICATION_SPEC_v0_4.md` (§4.1 routes,
§4.5 permissions, §4.6 ABAC, §2.3 state machines, §6.3 discharge, §7.x workflows).

---

## M6L-T01 — Drizzle read paths + mount the routes

- deps: M6 on `main` · files: `apps/backend/src/modules/06-admission/admission-route-service-db.ts` (new),
  `apps/backend/src/index.ts`, `docs/api/openapi.json`, `packages/ui/src/api`
- do: new `createDbAdmissionRouteService(db)` returning the full `AdmissionRouteService` — implement the
  **READ methods for real** over Drizzle under `withOrgContext`: `listReferrals`/`getReferral`,
  `listAdmissions`(state filter, cursor)/`getAdmission` (→ `AdmissionDetail`), `listElectionPeriods`,
  `getElectionStatement`, `getCti`, `getFaceToFace`, `getLevelOfCare`, the NOR getter, and the
  compliance-window reads (org-wide + `byAdmission`). Every **write/transition method fail-clears 501**
  (`NOT_IMPLEMENTED`, "admission writes arrive in M6L-T02+") so the interface is satisfied. Mount
  `registerAdmissionRoutes(app, { service })` in `index.ts` (db branch) and register the M6 ABAC
  role-predicate resolvers (`abac-predicates.ts`) into M3, idempotently. `openapi:emit` will pick up the
  46 routes — regenerate the contract + client.
- accept: the 6 screen-driving GETs (`/api/v1/admissions`, `/admissions/:id`, `/admissions/:id/election-periods`,
  `/admissions/:id/compliance-windows`, `/compliance-windows`, `/referrals`) return 200 under an org-bound
  session; writes return 501; mount smoke test; `bun run build && arch:fitness && test` green.

## M6L-T02 — Referral + admission write lifecycle

- deps: M6L-T01 · files: `admission-route-service-db.ts`, module
- do: implement the §2.3 **referral** state machine (`createReferral`/`triageReferral`/`acceptReferral`
  → mints the admission, `declineReferral`/`updateReferral`) and the **admission** lifecycle
  (`createAdmission`, `updateAdmission`, `holdAdmission`/`resumeAdmission`, `activateAdmission` →
  `patient.status` side-effect) over Drizzle, with optimistic concurrency (`ifVersion` → 412) and the
  `m6.*` outbox emits (`events-by-m6.ts`). Match `createInMemoryAdmissionBackend` semantics exactly.
- accept: §7.1/§7.2 referral-intake + admission-wizard behaviors hold against the live service; 412 on
  stale `ifVersion`; gate green.

## M6L-T03 — Election + CTI write lifecycle

- deps: M6L-T02 · files: `admission-route-service-db.ts`, module
- do: election statement `draft`/`sign`/`void`, election-period `create`/`patch`/link-cti; CTI
  `draft`/`signHospiceMd`/`signAttending`/`void`/`markLate` (§7.3) — over Drizzle with concurrency +
  outbox. Election authority / DPOA gating reads through the M39/M5 seams already bound in M6-T06.
- accept: §7.3 recert-CTI + election-sign workflows hold; gate green.

## M6L-T04 — F2F + LOC + NOR + discharge / transfer / revocation

- deps: M6L-T02 · files: `admission-route-service-db.ts`, module
- do: face-to-face `schedule`/`complete`/`attest`/`override-window` (§7.4/§7.5); level-of-care `change`
  (drives `m6.loc.changed`) + `patch`; NOR acknowledge; discharge (§6.3 reason-derived permission via
  `deriveDischargePermissionKey`, cosign-for-cause), transfer in/out, revocation — over Drizzle with the
  signer-identity ABAC resolvers (`abac-predicates.ts`) live.
- accept: §7.5/§7.6 + reason-specific discharge-permission tests hold against the live service; gate green.

## M6L-T05 — Compliance windows + jobs

- deps: M6L-T02 · files: `admission-route-service-db.ts`, `jobs/`, module
- do: compliance-window `close`/`override` writes; wire the §4.3 compliance-window scan job to the live
  store (pure processor + injected store port). Confirm the compliance-dashboard screen renders the
  live windows.
- accept: compliance close/override + window-scan behaviors hold; gate green.

## M6L-T06 — Admission demo seed (replaces the status-only census seed)

- deps: M6L-T02..T05 · files: `scripts/db/seed-admissions.ts` (new), `package.json`,
  `scripts/db/seed-census-active.ts` (retire/replace)
- do: seed the reference rows an admission needs (`provider_entity`, `location` for the demo org) +
  `external_physician` already seeded (`db:seed:mdm`), then admit the demo patients through real rows —
  `admission` (active), `election_period` (Medicare, period 1) + `election_statement` + `certification_of_terminal_illness`
  (signed), `level_of_care_period` (routine home care), a sample `compliance_window`, and one referral in
  the inbox. Under `session_replication_role = replica`, idempotent (fixed ids). Replace
  `db:seed:census` (status-only) in `db:reset` with `db:seed:admissions`; `patient.status` now follows
  from a real admission.
- accept: `bun run db:seed:admissions` idempotent; `/api/v1/admissions` returns the admitted roster;
  the census reflects `active`; gate green.

## M6L-T07 — §9 test plan + RLS live + ledger

- deps: all M6L · files: module `__tests__`, `rls-isolation.live.test.ts`, `docs/design/DEFERRED_SCREENS.md`
- do: the §7 workflow-acceptance suite against the live Drizzle service (admit → elect Medicare + CTI +
  F2F → LOC → compliance), cross-tenant RLS isolation on the M6 tables in the live lane, and flip the M6
  rows in the deferred-screens ledger to `done (live)`.
- accept: full suite + `rls-live` green; ledger updated; `bun run build && arch:fitness && test` green.

---

## Wave acceptance (the workflow's final gate)
1. `registerAdmissionRoutes` is mounted in the composition root over `createDbAdmissionRouteService`;
   the 4 M6 screens (census, detail, referral-inbox, compliance) are live end-to-end.
2. The full admission lifecycle (referral → admit → elect + CTI + F2F → LOC → discharge/transfer) works
   over Drizzle with optimistic concurrency + the `m6.*` outbox; reads + writes both real.
3. `db:seed:admissions` admits the demo patients through real rows; the census `active` status is
   admission-backed (not a direct status write).
4. `bun run build && bun run arch:fitness && bun run test` green; `rls-live` green on real Postgres.

> Run via Archon, e.g.:
> `archon workflow run wardenx-piv --branch feat/m6-live-wire "Use the plan at docs/plans/WAVE_M6_LIVE_WIRE_PLAN.md"`
