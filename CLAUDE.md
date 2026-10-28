# ChartWarden — Repository Guide

Multi-tenant hospice EHR SaaS. This repo is the **specification corpus + architecture-fitness kit +
staged implementation monorepo**. Every module, M41 commercial billing ([ADR-0100](./docs/adr/ADR-0100-commercial-billing-module-41.md)) included, has real implementation on `main`; the generated
**implementation-status matrix** is the per-module truth (`bun run status:matrix` →
`audit/implementation-status/IMPLEMENTATION_STATUS.md`). **Do not restate counts here** (routes,
tables, pairs, suites) — read the generated reports under `audit/` instead; a hand-maintained mirror of
a generated number goes stale and gets repeated back as a finding.

> **Findings history lives elsewhere.** The per-finding narrative (F-0xx), the #248 outbox-binding
> rounds, and the incident history behind each fitness gate are split by topic under
> [`docs/history/`](./docs/history/README.md) (index there). Consult the relevant file when touching an
> area (grep it for the module or `F-NNN`); it is not required reading for every task.

> **Building/extending the code?** Start at [`docs/DEVELOPMENT.md`](./docs/DEVELOPMENT.md)
> (runbook + "how to add a module") and [`docs/PHASE_0_SCAFFOLD_PLAN.md`](./docs/PHASE_0_SCAFFOLD_PLAN.md).
> One-time: `bun install && bun run build && bun run arch:fitness && bun run test` (all green).
> The `apps/`+`packages/` tree is **generated from the manifest** via `bun run scaffold`; the
> `arch:parity` gate keeps tree↔manifest 1:1. See [ADR-0027](./docs/adr/ADR-0027-phase-0-toolchain-and-scaffold.md).

## Authority rule

Architecture documents are authoritative. Module and UI screen specifications are implementation
proposals. **If a module or screen spec conflicts with architecture, architecture wins.**

## Document map

[`docs/README.md`](./docs/README.md) is the master index of every document under `docs/`.

Shared list-screen `wx-*` chrome lives in `packages/ui/src/web/styles/list-chrome.css`; each app imports it after `@import "tailwindcss"`. Add list-chrome rules there, not to an app stylesheet. The shell (`wx-shell`, sidebar, header) and the base element defaults live in `app-shell.css` beside it, imported the same way by `apps/web` and `apps/admin`; design tokens stay per app (`apps/admin/src/index.css` keeps a copy of web's `@theme` — keep them in sync).

- **Module specs** → [`docs/modules/`](./docs/modules/) (index: `docs/modules/README.md`). Resolve specs
  there, not the repo root. Module 29 sub-tasks: `docs/modules/module-29-tasks/`.
- **UI screen specs** → [`docs/design/screens/`](./docs/design/screens/), indexed by
  `docs/design/CHARTWARDEN_UI_COMPLETE_SCREEN_INDEX.md`; layout patterns in
  `docs/design/CHARTWARDEN_UI_LAYOUT_PATTERNS.md`. Check with `bun run docs:ui`.
- **Architecture (authoritative)** → [`docs/architecture/`](./docs/architecture/): `CHARTWARDEN_ARCHITECTURE_v0_11.md`,
  `CHARTWARDEN_SYSTEM_DESIGN_v0.3.md`, `CHARTWARDEN_SECURITY_HARDENING_v0_2.md`, `CHARTWARDEN_AI_GOVERNANCE_v0.2.md`,
  `CHARTWARDEN_DR_BCP_v0.1.md`, `CHARTWARDEN_OPS_RUNBOOK_v0.1.md`, `CHARTWARDEN_INTEGRATIONS_v0_1.md`,
  `ARCHITECTURE_25_15_FITNESS.md`.
- **ADRs** → `docs/adr/`. **Review prompt templates** → `docs/reviews/`. **Audit reports** → `audit/`
  (they reference module specs by filename; resolve under `docs/modules/`).
- The repo-root `architecture/` directory is the *enforcement code*, distinct from the prose in
  `docs/architecture/`.

## Architecture-fitness kit

`architecture/module-manifest.ts` (+ `.cjs` mirror) is the single source of truth for each module's
`codePaths`, `dependsOn` and `ownedTables`; `architecture/.dependency-cruiser.cjs` enforces import
boundaries. `bun run arch:fitness` runs every gate below. Full rationale and incident history per gate:
the `docs/history/gates-*.md` files ([index](./docs/history/README.md)).

- `check-table-ownership`, `check-ddl-legality`, `check-fitness-gaps`, `check-ui-screens` — table
  ownership, DDL legality, event-catalog `mN.` convention / seam completeness / PHI RLS+audit triggers, UI corpus.
- `check-tenancy` (`arch:tenancy`) — three-column rule, `app.org_id` GUC, banned policy shapes, RLS enabled ⇒ FORCEd (net-effect replay of migrations).
- `check-migration-numbering` (`arch:migration-numbering`) — migration ordinals unique; gaps reported, not fatal.
- `check-migration-compat` (`arch:migration-compat`) — every migration from 1288 on declares `-- compat: expand` or `-- compat: contract` in its header; an `expand` claim with obviously contracting DDL (DROP, RENAME, ALTER … TYPE, NOT NULL without default) fails. A conservative heuristic: declare `contract` when unsure. `deploy.sh` auto-restores the previous release after a failed deploy only over checked `expand` migrations, otherwise it halts (exit 75) for an operator (#861).
- `check-test-typecheck-coverage` (`arch:test-typecheck`) — every test file vitest runs is in a typecheck program (`typecheck` = `tsc -b` + `typecheck:tests`).
- `check-manifest-mirror` (`arch:manifest-mirror`) — `.ts` and `.cjs` manifests agree on data and on `allowedImportPaths`/`allowedTables`.
- `check-merge-artifacts` (`arch:merge-artifacts`) — no committed conflict markers in any tracked file.
- `check-abac-predicates` (`arch:abac-predicates`) — every `requireAbac(_, name)` names a registered predicate; no deferral allowlist (register a denying predicate instead). Note: `PermissionDef.abac` is a declaration only; `requirePermission` never reads it.
- `check-abac-composed` (`arch:abac-composed`) — the converse of `arch:abac-predicates`: a predicate that is registered but that no `requireAbac` (directly or via a one-level local wrapper) composes fails the gate unless it is in `scripts/abac-uncomposed-allowlist.ts` WITH a reason. A ratchet: a newly composed or removed entry must be deleted from the list, so it only shrinks (a registered-but-never-composed predicate is a control that exists on paper only — GAP-067).
- `check-request-header-auth` (`arch:request-header-auth`) — every `request.headers[...]` read is registered `verified` or `not-authorization`; never decide authorization from an unverified header (use `requireStepUp` / `stepUpFreshFor`).
- `check-context-attributes` (`arch:context-attributes`) — every key read off `request.context.attributes` has a real producer or a declared blocker.
- `check-route-reachability` (`arch:route-reachability`) — every route registrar is reachable from `apps/backend/src/index.ts` (a barrel re-export is not an execution).
- `check-live-suite-coverage` (`arch:live-suites`) — every live suite has a `package.json` script and a CI job, both directions; exclusions are named, never silent.
- `check-release-gate` (`arch:release-gate`) — in `deploy.yml`, `release` transitively needs a job that `uses: ./.github/workflows/ci.yml` and `deploy` needs `release` (#846: a commented-out `verify` shipped untested from 2026-10-01). Run the same CI on a branch with `gh workflow run ci.yml --ref <branch>`.
- `check-queue-names` (`arch:queue-names`) — every BullMQ queue name (catalog entries, `*_QUEUE` constants, `dlq:` names) is declared by exactly one module/package; two owners on one name share a Redis queue and steal each other's jobs (M23/M27 `validation-run`). A deliberate reference to another owner's queue carries a `// queue-names:reference` marker.
- `check-outbox-bindings` (`arch:outbox-bindings`) — live consumer bindings ↔ event catalog agree; unbound (module, event) pairs must be in `scripts/outbox-deferred-consumers.ts` with a reason; per-module `*_SUBSCRIBED_EVENT_NAMES`-style lists must match the catalog (rule 6, exceptions in `scripts/outbox-subscription-exceptions.ts`). `bun run outbox:deferrals:update` regenerates lists, never reasons.
- `check-architecture-docs`, `check-module-docs`, `check-adr-docs` — architecture/module-spec/ADR corpus consistency (cited paths, versions, index parity, links).
- `check-openapi-provenance` (`arch:openapi-provenance`) — no duplicate/shadowed enrichment keys or imports, schemas from own directory. `report-openapi-coverage` (`arch:openapi-coverage`) — unenriched-route ratchet against `audit/openapi-coverage/baseline.json`; `client:check` keeps the typed client in sync.
- `check-pdf-template-coverage` (`arch:pdf-templates`) — every M22 renderer template key has a bespoke FormSpec/builder or sits in `scripts/pdf-generic-allowlist.ts` WITH a reason (a ratchet: a key that gained a builder must leave the list); the forms-library registry and the renderer table agree through an explicit alias map / forms-only list; every statically named render-request template is a published key.
- `check-compose-policy` (`arch:compose-policy`) — every literal image in `deploy/production/compose.yml` is `repo:tag@sha256:<digest>` and every service sets `mem_limit` and `cpus` (postgres also `mem_reservation`); `${VAR}` GHCR app images are exempt (deploy.sh verifies them).
- `check-error-envelope` (`arch:error-envelope`) — route handlers throw typed `ChartWardenError`/`NotFoundError`/`ConflictError`; no flat `{ error: ... }` replies, so every error carries the standard envelope.
- Live suites that guard a rule rather than a route (need a real catalog/DB, so not `arch:*` gates): `test:fk-indexes:live` asserts foreign keys are index-covered (the deliberately unindexed soft-deleted-parent FKs are an explicit, reasoned list); `test:m10:retention:live` proves the HOPE retention scan flags but never deletes and honours legal holds; `test:m2:auditor-enrolment:live` proves an auditor session reads nothing until the BAA is accepted and a second factor is proven.
- Advisory/parity reports (each has a `--check` mode inside `arch:fitness`): `status:matrix`, `ui:parity`, `frame:fidelity` (playbook: `docs/design/FRAME_FIDELITY_PLAYBOOK.md`), `arch:e2e-coverage`.

## Standing verification habits (learned the hard way — see [`docs/history/`](./docs/history/README.md))

- **Bound is not computing; green gates are proxies.** After adding an outbox consumer, grep
  `apps/backend/src/index.ts` for its factory — `arch:outbox-bindings` and `check:boot:platform` do not prove it is wired.
- **Prove RLS live, not on a superuser connection.** Live suites must connect as the real NOBYPASSRLS `chartwarden_app` role (`_live-app-role.ts`); a cross-tenant assertion on a superuser proves nothing.
- **Never run live suites against the shared Docker cluster.** They `DROP ROLE chartwarden_app`. Use a private `pgvector/pgvector:pg18` container on its own port with a fresh database per suite, one database at a time (roles are cluster-global, so drop the previous suite's database first). Start that Postgres with `-c max_locks_per_transaction=1024` (suites reboot `public` twice and `DROP SCHEMA public CASCADE` otherwise dies with "out of shared memory"; `resetPublicSchema` in `_live-app-role.ts` degrades to chunked drops but the setting is the real fix). A suite never carries its own role drop list: use `LIVE_DROP_ROLES` / `dropLiveRoles` from `apps/backend/__tests__/_live-app-role.ts`; `live-roles-canonical.test.ts` fails on a hand-written `ROLES` array or a migration role missing from it (a leftover `chartwarden_destruction` otherwise breaks migration 1142).
- **DoseSpot is unbound until configured.** `DOSESPOT_TENANT_CONFIGS` must hold a complete entry for a tenant before the M12 adapter sends anything; vendor field names are unverified until tested against a DoseSpot sandbox (`docs/history/m12-dosespot-adapter.md`).
- **Use the real catalog-validating publisher in tests**, not `NOOP_OUTBOX`; every payload/emit-site change needs the real-publisher live suite.
- **A value set or seam is not seeded just because its definition exists.** A gate that depends on reference data (e.g. M29's `sud_test_loinc`) must have that data in the database: `packages/terminology` seed lists are TS data until a migration inserts them. Prove membership live through the real adapter, not by reading the definition.
- **Auditor sessions are two-staged.** Redemption mints an enrolment-stage session (`scope.auditorStage`, fail closed) that reaches only the five `/api/v1/auditors/enrolment/*` routes; the `external_auditor` role is granted at activation (BAA terms plus a second factor), never at redemption. Any new auditor-readable route must be gated on the active stage via the stamped `attributes.engagementId`; add to the enrolment allowlist in `authenticate.ts` only deliberately.
- **A read-audit config needs a `resourceIdParam`.** Without it the read event's resource id is empty, the audit insert fails on the uuid cast, and the best-effort wrapper swallows it, so the read leaves no trail. Assert in the live suite that the read event lands.
- **Relay ticks and workers are not requests**: use org-explicit `...ForOrg` seam functions or `runWithRequestContext`; wrap tenant reads in `withOrgContext`.
- **Seam pull vs. outbox push**: check the consuming module's own spec before declaring a consumer; the consumer's decisive text beats the producer's guess.
- New migrations: check `arch:migration-numbering` against `main` first (branches collide on "next number"); mirror new enums/tables into code-side mirrors (`packages/db/src/enums.ts`, `packages/types`) and the manifest (`.ts` and `.cjs`).
- New live suite ⇒ `package.json` script **and** a `ci.yml` job row. After multi-agent/parallel edits run the full `bun run build`, `typecheck`, `arch:fitness`, non-live tests and `check:boot:platform` centrally; renumber colliding F-numbers.
- **This is a private repo — GitHub Actions minutes are metered, not free.** `deploy.yml`'s `verify` job (the full ~150-job CI matrix) runs behind a `debounce` job (#257) that waits out a quiet window and only proceeds if the triggering commit is still `main`'s HEAD; a burst of pushes should cost one matrix run, not one per push. Never add a second trigger (a raw `push`, an always-on `schedule`) that reaches `verify`/`release`/`deploy` without routing through that gate. During multi-round/multi-agent work, prefer batching several rounds into fewer pushes to `main` over pushing every round immediately — the debounce absorbs a burst, but it can't help if pushes never stop coming (see #257's incident: two concurrent sessions pushing every few minutes exhausted the month's Actions minutes and silently blocked every deploy, including a real production fix, for days).
- Follow the user's memory notes: `db:migrate` on the host resets the app role (use the Docker migrate); hit changed backend routes on the Docker stack before merging (main auto-deploys); **`AGENTS.md` must be a verbatim copy of this file**.

## Agent skills

- **Issue tracker:** GitHub Issues on `Engrace-Hospice/chartwarden` via `gh` — `docs/agents/issue-tracker.md`.
- **Triage labels:** five canonical roles, label string = name — `docs/agents/triage-labels.md`.
- **Domain docs:** single-context; repo-root `CONTEXT.md` (not yet created) plus `docs/adr/` — `docs/agents/domain.md`.

## Using ECC

[ECC](https://github.com/affaan-m/ECC) is an optional per-user Claude Code plugin (`ecc@ecc`); these notes
apply only when it is installed. **This file and the repo's own gates win over ECC's generic rules**
(its 80% coverage target, commit-and-push habit and PR flow included).

- **Plan first:** `/ecc:plan <task>` before any multi-file change — it grounds the plan in the code and
  waits for approval; `/ecc:plan-canvas` approves in the browser. Use `/ecc:plan-prd` only for
  multi-day module work.
- **Implement test-first** with the `tdd-workflow` skill (vitest); `/ecc:build-fix` after a failing
  `bun run typecheck`. The real gate is `bun run typecheck && bun run arch:fitness && bun run test`,
  not `/ecc:quality-gate` (it does not know `arch:fitness`).
- **Mandatory pre-PR review.** Before opening a PR, pushing to `main`, or merging, run `/ecc:code-review` on the branch diff (`git diff main...HEAD`) in a fresh agent, without being asked. Fix every CRITICAL/HIGH finding (or state why not) and re-run until none remain, then say in the PR body what the review found. Add `/ecc:react-review` for `apps/web`/`apps/admin` changes and `/ecc:security-scan` for auth/PHI/RLS code. A merge still needs the user's explicit go-ahead; this review does not replace it.
- **Review before the PR** in a fresh agent: `/ecc:code-review` (prefixed — the built-in
  `/code-review` is a different command), `/ecc:react-review` for `apps/web`, `/ecc:security-scan` for
  auth/PHI/RLS code. `database-migrations` / `postgres-patterns` are advice only; the custom migration
  runner, `arch:tenancy` and `arch:migration-numbering` decide.
- **Long work:** `/ecc:save-session` / `/ecc:resume-session` to hand context across sessions.
- **Avoid:** the multi-agent commands (`orch-*`, `multi-*`, `gan-*`, `epic-*`, `loop-start`,
  `santa-loop`) and `/ecc:pr` / `/ecc:prp-pr` — they push per round, which defeats the batching rule
  above and burns metered Actions minutes.
- **GateGuard** (an ECC hook) blocks a first-time file write until the importers, affected API, data
  shapes and the user's instruction are stated; answer it rather than disabling it
  (`ECC_GATEGUARD=off` / `GATEGUARD_EXEMPT_GLOBS` exist).
