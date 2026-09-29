# WardenX — Repository Guide

Multi-tenant hospice EHR SaaS. This repo is the **specification corpus + architecture-fitness kit +
staged implementation monorepo**. All 40 modules have real implementation on `main`; the generated
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

- **Module specs** → [`docs/modules/`](./docs/modules/) (index: `docs/modules/README.md`). Resolve specs
  there, not the repo root. Module 29 sub-tasks: `docs/modules/module-29-tasks/`.
- **UI screen specs** → [`docs/design/screens/`](./docs/design/screens/), indexed by
  `docs/design/WARDENX_UI_COMPLETE_SCREEN_INDEX.md`; layout patterns in
  `docs/design/WARDENX_UI_LAYOUT_PATTERNS.md`. Check with `bun run docs:ui`.
- **Architecture (authoritative)** → [`docs/architecture/`](./docs/architecture/): `WARDENX_ARCHITECTURE_v0_11.md`,
  `WARDENX_SYSTEM_DESIGN_v0.3.md`, `WARDENX_SECURITY_HARDENING_v0_2.md`, `WARDENX_AI_GOVERNANCE_v0.2.md`,
  `WARDENX_DR_BCP_v0.1.md`, `WARDENX_OPS_RUNBOOK_v0.1.md`, `WARDENX_INTEGRATIONS_v0_1.md`,
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
- `check-test-typecheck-coverage` (`arch:test-typecheck`) — every test file vitest runs is in a typecheck program (`typecheck` = `tsc -b` + `typecheck:tests`).
- `check-manifest-mirror` (`arch:manifest-mirror`) — `.ts` and `.cjs` manifests agree on data and on `allowedImportPaths`/`allowedTables`.
- `check-merge-artifacts` (`arch:merge-artifacts`) — no committed conflict markers in any tracked file.
- `check-abac-predicates` (`arch:abac-predicates`) — every `requireAbac(_, name)` names a registered predicate; no deferral allowlist (register a denying predicate instead). Note: `PermissionDef.abac` is a declaration only; `requirePermission` never reads it.
- `check-request-header-auth` (`arch:request-header-auth`) — every `request.headers[...]` read is registered `verified` or `not-authorization`; never decide authorization from an unverified header (use `requireStepUp` / `stepUpFreshFor`).
- `check-context-attributes` (`arch:context-attributes`) — every key read off `request.context.attributes` has a real producer or a declared blocker.
- `check-route-reachability` (`arch:route-reachability`) — every route registrar is reachable from `apps/backend/src/index.ts` (a barrel re-export is not an execution).
- `check-live-suite-coverage` (`arch:live-suites`) — every live suite has a `package.json` script and a CI job, both directions; exclusions are named, never silent.
- `check-outbox-bindings` (`arch:outbox-bindings`) — live consumer bindings ↔ event catalog agree; unbound (module, event) pairs must be in `scripts/outbox-deferred-consumers.ts` with a reason; per-module `*_SUBSCRIBED_EVENT_NAMES`-style lists must match the catalog (rule 6, exceptions in `scripts/outbox-subscription-exceptions.ts`). `bun run outbox:deferrals:update` regenerates lists, never reasons.
- `check-architecture-docs`, `check-module-docs`, `check-adr-docs` — architecture/module-spec/ADR corpus consistency (cited paths, versions, index parity, links).
- `check-openapi-provenance` (`arch:openapi-provenance`) — no duplicate/shadowed enrichment keys or imports, schemas from own directory. `report-openapi-coverage` (`arch:openapi-coverage`) — unenriched-route ratchet against `audit/openapi-coverage/baseline.json`; `client:check` keeps the typed client in sync.
- Advisory/parity reports (each has a `--check` mode inside `arch:fitness`): `status:matrix`, `ui:parity`, `frame:fidelity` (playbook: `docs/design/FRAME_FIDELITY_PLAYBOOK.md`), `audit-fitness`, `arch:e2e-coverage`.

## Standing verification habits (learned the hard way — see [`docs/history/`](./docs/history/README.md))

- **Bound is not computing; green gates are proxies.** After adding an outbox consumer, grep
  `apps/backend/src/index.ts` for its factory — `arch:outbox-bindings` and `check:boot:platform` do not prove it is wired.
- **Prove RLS live, not on a superuser connection.** Live suites must connect as the real NOBYPASSRLS `wardenx_app` role (`_live-app-role.ts`); a cross-tenant assertion on a superuser proves nothing.
- **Use the real catalog-validating publisher in tests**, not `NOOP_OUTBOX`; every payload/emit-site change needs the real-publisher live suite.
- **Relay ticks and workers are not requests**: use org-explicit `...ForOrg` seam functions or `runWithRequestContext`; wrap tenant reads in `withOrgContext`.
- **Seam pull vs. outbox push**: check the consuming module's own spec before declaring a consumer; the consumer's decisive text beats the producer's guess.
- New migrations: check `arch:migration-numbering` against `main` first (branches collide on "next number"); mirror new enums/tables into code-side mirrors (`packages/db/src/enums.ts`, `packages/types`) and the manifest (`.ts` and `.cjs`).
- New live suite ⇒ `package.json` script **and** a `ci.yml` job row. After multi-agent/parallel edits run the full `bun run build`, `typecheck`, `arch:fitness`, non-live tests and `check:boot:platform` centrally; renumber colliding F-numbers.
- Follow the user's memory notes: `db:migrate` on the host resets the app role (use the Docker migrate); hit changed backend routes on the Docker stack before merging (main auto-deploys); **`AGENTS.md` must be a verbatim copy of this file**.

## Agent skills

- **Issue tracker:** GitHub Issues on `Engrace-Hospice/wardenx` via `gh` — `docs/agents/issue-tracker.md`.
- **Triage labels:** five canonical roles, label string = name — `docs/agents/triage-labels.md`.
- **Domain docs:** single-context; repo-root `CONTEXT.md` (not yet created) plus `docs/adr/` — `docs/agents/domain.md`.
