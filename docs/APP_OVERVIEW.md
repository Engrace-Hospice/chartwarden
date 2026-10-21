# ChartWarden — App Overview for New Developers

A guided map of *what this codebase is and how it fits together*, for an engineer joining the
project. It complements, and doesn't repeat, these companion docs:

- [`CLAUDE.md`](../CLAUDE.md) — the canonical repo guide (authority rules, document map, current
  build status). Read this first if you haven't.
- [`docs/DEVELOPMENT.md`](./DEVELOPMENT.md) — the step-by-step runbook (install, build, gates,
  "how to add a module").
- [`docs/BUSINESS_LOGIC.md`](./BUSINESS_LOGIC.md) — what each module's business logic actually
  does (state machines, rules, workflows), grounded in code.
- [`docs/README.md`](./README.md) — master index of every document under `docs/`.

This doc is the missing piece between those: the mental model of the *system* — tech stack, repo
layout, and the architectural patterns that repeat across all 40 modules — so reading any one
module's code feels familiar rather than starting from zero.

---

## What this app is

ChartWarden is a **multi-tenant hospice EHR (electronic health record) SaaS**. It covers the full
operational surface of a hospice organization: clinical documentation (admissions, care plans,
encounters, assessments, medications, IDG team meetings), field operations (scheduling, EVV,
on-call triage, field safety, supplies/DME, inpatient units), the Medicare/Medicaid revenue cycle
(billing, remittance, cap management, cost reports), regulatory/quality reporting (HQRP, CAHPS,
QAPI, incident and infection surveillance), and platform concerns (multi-tenant provisioning,
subscription billing, patient/family portal, AI governance, FHIR interop, HL7 interfaces).

The repo is simultaneously three things layered on top of each other:

1. **A specification corpus** — `docs/modules/`, `docs/design/`, `docs/architecture/` describe
   what each of the 40 modules and their UI screens are supposed to do. These are *implementation
   proposals*, not ground truth — see the Authority Rule below.
2. **An architecture-fitness kit** — code under `architecture/` and `scripts/` that mechanically
   enforces structural rules (module boundaries, tenancy shape, table ownership, ABAC predicate
   resolution, OpenAPI contract coverage) as CI gates, independent of whether a module's *business
   logic* is any good.
3. **The staged implementation itself** — real, working code for all 40 modules, currently on
   `main`. This is what you'll spend most of your time reading and editing.

**Authority rule**: architecture docs (`docs/architecture/`) win over module/UI specs
(`docs/modules/`, `docs/design/`) in any conflict. When code and a spec disagree, treat the spec
as the thing that's wrong (or aspirational) — verify against the actual code, not the proposal.

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime / package manager | **Bun** (≥1.3) — `bun install`, `bun run`, workspaces via `bun.lock` |
| Language | TypeScript, project-references build (`tsc -b`) across every `apps/*` and `packages/*` |
| Backend HTTP framework | **Fastify** |
| Database | **PostgreSQL** (pgvector-enabled image), accessed via **Drizzle ORM** (`drizzle-orm` + raw `pg`) |
| Multi-tenancy | Postgres **Row-Level Security (RLS)**, `FORCE ROW LEVEL SECURITY`, org context set per-request/per-transaction |
| Background jobs | **BullMQ** over **Redis** (cron-style jobs, watchdogs, outbox dispatch, worker sidecars) |
| Auth | **Better Auth**, including passkey/WebAuthn (`@better-auth/passkey`, `@simplewebauthn/server`) |
| Frontend framework | **React** + **React Router**, built with **Vite** |
| Styling | **Tailwind CSS** (custom design-token theme, "Lantern" design system) |
| Component workshop | **Storybook** |
| Lint / format | **Biome** (advisory — not a blocking CI gate) |
| Tests | **Vitest** (unit + "live" integration suites against a real throwaway Postgres) |
| E2E | **Playwright** (`e2e/`) |
| Observability | `prom-client` (Prometheus metrics) |
| Node tooling pin | `.nvmrc` → Node 22 (Bun is the actual runtime; Node is pinned for tools that want it) |

---

## Repo layout

```
apps/
  backend/     Fastify API — every module's routes/services/domain logic (apps/backend/src/modules/NN-*)
  web/         Main clinical/staff web app (React SPA)
  admin/       Platform admin console SPA (M34 shell)
  portal/      Patient/family portal SPA (M31)
packages/      ~50 shared/domain packages — one per module's pure domain logic, plus
               cross-cutting libraries (db, auth, audit, shared, ui, types, tenancy, ...)
architecture/  Enforcement code: module-manifest.ts (source of truth for module ownership),
               dependency-cruiser rules
scripts/       Fitness-gate scripts (check-tenancy, check-table-ownership, report-*, db/*)
docs/          Spec corpus + architecture docs + ADRs + design/UI corpus (see docs/README.md)
audit/         Generated, point-in-time reports (implementation status, OpenAPI coverage,
               UI parity, frame fidelity, fitness enforcement) — regenerated by scripts, not
               hand-edited
e2e/           Playwright end-to-end suite
```

### The four apps

- **`apps/backend`** — the API. One Fastify instance; routes are grouped per numbered module
  directory under `apps/backend/src/modules/`. Bootstrap/cross-cutting plumbing (auth, security
  headers, CSRF, idempotency, rate limiting, PHI-read-audit gate, outbox dispatcher) lives in
  `apps/backend/src/bootstrap/`. `index.ts` is the HTTP entry point; `worker.ts` is the BullMQ
  worker process entry point (background jobs run in a **separate process**, not inline in the
  API server).
- **`apps/web`** — the clinical/staff-facing SPA (the main app most users see). Screens are
  organized per module under `src/modules/`, mounted through `src/shell/` (app chrome, nav,
  auth-gated routing) and registered in `src/main.tsx`.
- **`apps/admin`** — the platform operations console (tenant provisioning, feature flags,
  support sessions, billing ops). Backed by M34; deliberately does **not** import the `web` app's
  shell registry — it's a separate SPA with its own shell.
- **`apps/portal`** — the patient/family-facing SPA (M31). Consent-gated at every PHI route;
  invisible to the internal `ui:parity` report (it has its own flat screen manifest, not the
  `web`/`admin` pattern).

### Packages

Each backend module that has non-trivial pure business logic keeps that logic in its own
`packages/<name>` (e.g. `packages/billing` for M23, `packages/orders` for M11, `packages/idg` for
M14) — state machines, validation rules, calculators — decoupled from Fastify/Drizzle so it's
independently unit-testable. `apps/backend/src/modules/NN-*` is the thin HTTP/DB adapter layer on
top. A handful of shared/infrastructure packages underpin everything:

- `packages/db` — Drizzle schema + the SQL migrations (`packages/db/migrations/`)
- `packages/auth` — Better Auth config, passkey/WebAuthn
- `packages/audit` — the Audit Capture Contract (trigger generator, read-audit declarations)
- `packages/tenancy` — RLS/org-context helpers
- `packages/shared` — cross-cutting utilities, including the money kernel (`@chartwarden/shared/money`)
- `packages/types` — shared TypeScript types/contracts used across module boundaries
- `packages/ui` — the shared component library / design-token system ("Lantern") used by `web` (and partly `admin`)

---

## Anatomy of a backend module

Every module directory under `apps/backend/src/modules/NN-name/` follows roughly the same shape
(not every module has every piece — e.g. M22 has no outbox):

```
NN-name/
  index.ts                 module registration (routes, seams, consumers wired into the host)
  routes/                  Fastify route handlers (TypeBox schemas for request/response)
  state-machines/          pure transition-table state machines (guards, effects)
  abac-predicates.ts       named ABAC predicates this module registers into M3's registry
  seams/                   published seams (what this module exposes to others) +
                            consumed-seam adapters (what it expects from other modules)
  consumers/                event consumers reacting to another module's outbox events
  outbox-consumers/         (naming varies) — consumers of this module's own or others' events
  events-by-mN.ts           this module's outbox event catalog (mN. namespace)
  jobs/                     BullMQ job definitions (crons, watchdogs, workers)
  erasers/                  right-to-erasure / tenant-offboarding data deletion logic
```

Reading a module for the first time: start at `index.ts` to see what's wired, then `routes/` to
see the HTTP surface, then follow into `state-machines/` or the backing `packages/<name>` for the
actual business logic.

---

## Core architectural patterns

These patterns repeat across nearly every module. Understanding them once means every module
reads the same way.

### 1. The manifest is the single source of truth

`architecture/module-manifest.ts` declares, per module: its code paths, its `dependsOn` list, and
the Postgres tables it owns (the table count is a generated figure — see `audit/`, not this prose). The `apps/` + `packages/` tree is
**generated from this manifest** via `bun run scaffold`; `arch:parity` fails the build if the tree
and manifest drift apart. A module boundary violation (importing another module's internals
directly) is caught by `dependency-cruiser` (`architecture/.dependency-cruiser.cjs`), not just by
convention.

### 2. Multi-tenancy via Postgres RLS

Every PHI-bearing table carries an org-scoping column and `FORCE ROW LEVEL SECURITY`; the app sets
`app.org_id` per request/transaction and Postgres itself refuses cross-tenant reads/writes — this
is enforced at the database layer, not just in application code. `scripts/check-tenancy.ts`
enforces the three-column tenancy shape and forbids dangerous RLS patterns at the schema level. It
also reads the RLS policies the migrations leave BEHIND — replayed in apply order, so a policy a
later migration drops and replaces stops counting — and reports any surviving predicate that keys
on a session variable other than `app.org_id` without it, whatever else its migration contains.
Cross-tenant platform operations (tenant provisioning, support sessions, billing ops) run through
an explicit `withPlatformContext` runner rather than ever bypassing RLS silently.

### 3. Cross-module dependencies go through an opaque seam registry, never direct imports

A module that needs data or a capability from another module resolves it through a runtime seam
registry (`getSeam("SomeProvider")`) rather than importing that module's schema or service
directly. This keeps the dependency graph one-directional and enforceable by tooling. A seam that
hasn't been bound yet resolves to an explicit **deny-stub** — it fails closed (throws, or returns
an empty/unavailable result) rather than silently returning zero or null. You'll see this called
out constantly in code comments and in `docs/BUSINESS_LOGIC.md` — "seam not bound" is a normal,
expected state for a not-yet-built cross-module dependency, distinct from a bug.

### 4. ABAC/RBAC authorization, with break-glass and step-up escalation

Every route is protected by named ABAC predicates resolved from a central registry
(`packages/auth/src/abac/registry.ts` + each module's own `abac-predicates.ts`). The registry
**fails closed on an unknown predicate name** — a typo silently produces a permanently-403
endpoint with the whole build green (`bun run arch:abac-predicates` catches this). High-stakes
actions (claim submission, IDG adjournment, controlled-substance cosign, tenant destruction,
restraint application) additionally require **step-up** — a freshly-verified re-authentication,
checked server-side at the point of action, not just at login. **Break-glass** access exists as a
formal, time-boxed, single-patient emergency-access mechanism — never an org-wide bypass — with
every individual access under it separately audited.

### 5. Transactional outbox + async workers

Cross-module side effects (an admission activating, a claim getting paid, a death being recorded)
are published as `mN.*` events through a transactional outbox — written in the same DB transaction
as the state change, then dispatched asynchronously. Background processing (crons, watchdogs,
outbox dispatch, the FHIR/HL7/X12 sidecars) runs as BullMQ jobs in the separate `worker.ts`
process, not inline in the request/response cycle.

### 6. Audit is mandatory infrastructure, not a per-module afterthought

Every PHI table gets a write-audit trigger generated by `packages/audit`'s trigger generator.
Every PHI *read* route must explicitly declare itself audited — an undeclared PHI read route
**fails the build**, not just a runtime check. The `audit_event` table itself is append-only,
enforced at the Postgres ACL level (no UPDATE/DELETE grant to the app role) and verified live by a
dedicated integrity-report route. Legal holds and destruction certificates (for right-to-erasure)
are handled centrally by M4, and every module's erasure logic respects an active legal hold.

### 7. Tighten-only tenant policy overrides

Wherever a platform-default threshold exists (EVV geofence radius, bereavement outreach cadence,
controlled-substance refill limits, cap alert bands, restraint reassessment intervals), a tenant
may configure a *stricter* value but never a looser one than the platform floor. This is enforced
in code (explicit `*_EXCEEDS_FLOOR` / `*_LOOSENS_FLOOR` error paths), not just documented as a
policy.

### 8. PHI encryption at rest

Sensitive fields (prompts/responses in the AI ledger, chart context, DEKs) are envelope-encrypted;
encryption ports are injected and several are deliberately fail-closed/unbound in the current
build phase (e.g., M33's drilldown export refuses to write plaintext if no encryption port is
bound, rather than silently skipping encryption).

---

## How a request actually flows

1. Fastify receives the request; `bootstrap/plugins/` runs in order — security headers, CORS,
   rate limiting, authentication (resolves session or internal-service-token into
   `request.context`), CSRF (for cookie-session mutating requests), idempotency-key handling.
2. The module's route handler (TypeBox-schema'd request/response) checks ABAC via
   `requireAbac(_, "<predicate-name>")`, resolves org/actor context, and calls into the module's
   service layer.
3. The service layer talks to Postgres via Drizzle, inside a transaction that has `app.org_id` set
   (RLS-scoped). Business rules live either inline or (for anything non-trivial) in the module's
   backing `packages/<name>` pure-domain code — state machines, validators, calculators.
4. Any cross-module side effect is written to the outbox in the same transaction; a separate
   dispatcher later delivers it to consumers (possibly in another module, possibly in the worker
   process).
5. PHI reads are audited at the route layer as part of the response path (or the boot-time gate
   fails the build if a route forgot to declare it).

---

## Testing strategy

- **Unit tests** (`*.test.ts`) run against the pure domain packages and mocked/in-memory
  adapters — fast, no database required.
- **"Live" tests** (`*.live.test.ts`) run against a real, throwaway local Postgres cluster (not
  mocked, not the superuser connection — RLS is actually exercised) to prove cross-tenant
  isolation and end-to-end write lifecycles. These are what the module-manifest's per-module
  `Live` status column in `IMPLEMENTATION_STATUS.md` tracks. Run individually via the
  `test:mNN:*:live` scripts in `package.json`, or the RLS-isolation suites via `test:rls:live:mNN`.
- **E2E** (`e2e/`, Playwright) drives the actual web app in a browser.
- `bun run test` (plain Vitest) runs the unit-test tier; live suites are opt-in (they need a local
  Postgres instance — see `docs/DEVELOPMENT.md` / the local-PG runbook memory) and are not part of
  the default fast loop.

---

## The gates ("architecture fitness")

`bun run arch:fitness` is the umbrella CI gate. It's checking **structural coherence**, not
feature completeness — a fully green `arch:fitness` says nothing about whether a module's business
logic is correct or even present. Notable sub-gates:

| Gate | What it actually catches |
|---|---|
| `arch:parity` | `apps/`+`packages/` tree drifted from `architecture/module-manifest.ts` |
| `arch:boundaries` | a module importing another module's internals directly |
| `arch:tables` | a table written by a module that doesn't own it |
| `arch:tenancy` | missing/malformed RLS shape on a PHI table |
| `arch:ddl` | illegal migration SQL (bad partition keys, CHECK subqueries, etc.) |
| `arch:gaps` | missing `mN.` event namespacing, incomplete seam registry, missing PHI RLS/audit trigger |
| `arch:abac-predicates` | a `requireAbac(_, "name")` referencing a predicate nobody registered |
| `arch:status-matrix` / `arch:ui-parity` / `arch:openapi-coverage` / `arch:frame-fidelity` | generated reports gone stale, or (openapi-coverage specifically) a **ratchet** — the count of unenriched routes may never rise |

`bun run status:matrix`, `bun run openapi:coverage`, `bun run ui:parity`, and `bun run
frame:fidelity` regenerate the corresponding `audit/*` reports — these are the fastest way to get
an accurate, current read on what's actually built versus scaffolded, per module.

---

## Where to look next

- **Understand a specific module's business logic** → [`docs/BUSINESS_LOGIC.md`](./BUSINESS_LOGIC.md)
- **Set up your local environment / run the app** → [`docs/DEVELOPMENT.md`](./DEVELOPMENT.md) and
  the local-app runbook it links
- **Find a module or UI spec** → [`docs/modules/README.md`](./modules/README.md),
  [`docs/design/CHARTWARDEN_UI_COMPLETE_SCREEN_INDEX.md`](./design/CHARTWARDEN_UI_COMPLETE_SCREEN_INDEX.md)
- **Understand *why* the architecture is shaped this way** → `docs/architecture/`
  (`CHARTWARDEN_ARCHITECTURE_v0_11.md` is the authoritative system design doc) and `docs/adr/`
- **Check current build status per module** → `audit/implementation-status/IMPLEMENTATION_STATUS.md`
  (regenerate with `bun run status:matrix`)
