# ChartWarden — Architecture Fitness & Boundary Enforcement

**Intended placement:** companion to ARCHITECTURE §25 (Patterns Catalog). *(The architecture
document's §25.15 is "Mobile Considerations"; this fitness content is the normative companion the
v0.12 Document-Control changelog points to, not a literal §25.15 replacement.)* Companion
artifacts live in `architecture/` and `scripts/`.

> **Phase-0 remediation (2026-06-11, ADR-0005).** The manifest-governance rules below were
> clarified to resolve the corpus's #1 build blocker (manifest rewrites + designed-in cycles).
> See **"Seam & outbox contracts"**, **"Foundation helper reachability"**, and **"`packages/shared` / `packages/types`
> is banned"** below; the authoritative rationale is `docs/adr/ADR-0005-manifest-single-source-of-truth.md`.

-----

## Why this exists

The module architecture (§11, §20) is modular **by design**, but until now it is enforced only by documents and discipline — and documents do not fail a build. Across 40 modules built largely by one engineer, the realistic failure mode is not a bad design decision; it is a deadline-driven shortcut that reaches across a module boundary, imports another module's schema directly, or smuggles a vendor SDK out of its adapter. Each such shortcut is invisible in review and compounds.

**Principle:** every boundary the architecture cares about is converted into a check that runs on every PR. The CI pipeline is the reviewer that a solo or small team otherwise lacks. The rule of thumb for the moment a deadline tempts a shortcut: **if you must cross a boundary, extend its interface in the manifest (a deliberate, reviewed change); never reach through it** — and the tooling makes reaching-through unmergeable anyway.

## The single source of truth

`architecture/module-manifest.ts` declares, per logical module:

- **codePaths** — the package(s) and backend route dir(s) the module owns
- **dependsOn** — the modules it may import from (verbatim from §20's dependency table)
- **ownedTables** — the DB tables it owns (authoritative once the module is specced)

Every fitness check reads this manifest. Adding a dependency or a table is a one-line, reviewed edit there — which is exactly the friction we want around a boundary change. The manifest doubles as the **seam registry**: `dependsOn` is the machine-readable list of cross-module contracts.

### Seam & outbox contracts — no import edge (ADR-0005 D1)

A `dependsOn` edge is required **only** for a *compile-time import* of the producer's package (its
exported repository/service/reader/types). A module that consumes another module **only** through
one of the two **boundary-clean contract channels** adds **no** `dependsOn` edge:

- **Outbox events** — subscribed by event name, payload type declared in the leaf `packages/types`.
- **Boot-registered seams** — an interface whose **type lives in `packages/types`** and whose
  **implementation is injected at boot** by the owning module, listed in `REQUIRED_SEAMS` and
  validated by `validateSeams()` (fail-at-boot).

Both channels are leaf-typed + runtime-wired, so there is no cross-package import for the
boundary rule to forbid — yet the contract is still explicit (event catalog / seam registry) and
still fail-loud (boot validation). This is how, e.g., M8's signing gate consults M9/M10
completeness (ADR-0007) and how M39 consumes M22 document rendering (ADR-0006) **without** edges
or cycles. Seam *interfaces* are defined **natively in `packages/types`**; a leaf must **never**
re-export a feature package (that is an import and fails *leaves-stay-leaves* — M09-F01).

### Foundation helper reachability (ADR-0005 D4)

Every PHI route must call `requirePermission`/`requireAbac` (auth), `audit()` (audit), and run
under `withOrgContext()` (tenancy). Those helper packages — `packages/audit`, `packages/auth`,
`packages/tenancy`, plus the Drizzle schema-type surface `packages/db/src/schema` — are
**`FOUNDATION_HELPER_PACKAGES`**, appended to **every** module's allowed-import set, so a module
whose `dependsOn` omits 1–4 can still satisfy the mandates without a spurious edge. Guard rails
that remain: `check-table-ownership.ts` still blocks reading another module's tables; the
helper-only-table rule still blocks `audit_event`/`outbox_event`/`idempotency_key` schema; and
`no-circular` still forbids the foundation tier (M1–M3) from closing a cycle through a helper
(the foundation tier audits via M1's trigger mechanism, not `audit()`).

### `packages/shared` / `packages/types` is banned (ADR-0005 D3)

`packages/shared` / `packages/types` is in no manifest codePath and no architecture §4 package list. Its invented
contents are re-homed: outbox helper → `packages/shared`; `withOrgContext` + RLS generator →
`packages/tenancy`; `audit()` → `packages/audit`; seam interfaces + policy constants →
`packages/types`; schema/crypto/registries → `packages/db` or the owning feature package.

## The checks (all `error`-severity in CI)

| # | Check | Tool | Prevents |
|---|---|---|---|
| 1 | **Module import boundaries** | dependency-cruiser (rules generated from manifest) | A module importing code from an undeclared module. M8 may import its deps (6, 7, 36, 38) + leaves; importing M12 fails. |
| 2 | **Adapter mandate** | dependency-cruiser (`VENDOR_ADAPTERS`) | A vendor SDK (`stripe`, `twilio`, `@anthropic-ai/sdk`, …) imported outside its adapter package. Keeps vendor swaps to one package. |
| 3 | **Domain purity + FHIR direction** | dependency-cruiser | `packages/domain` importing I/O, app packages, or FHIR. Locks the §9 dependency direction. |
| 4 | **Leaves stay leaves** | dependency-cruiser | `shared`/`types`/`ui` importing feature packages (which would make everyone depend on everything). |
| 5 | **Helper-only tables** | dependency-cruiser + ownership check | Direct schema import of `audit_event` / `outbox_event` / `idempotency_key` outside their helper. |
| 6 | **Table ownership** | `scripts/check-table-ownership.ts` | The leak RLS cannot catch: same-tenant cross-module table access. Cross-module reads must go through the owner's repository, not its schema. |
| 7 | **No cycles** | dependency-cruiser (`no-circular`) | Dependency cycles that destroy independent build/test/reasoning. |
| 8 | **Explicit authz** | `scripts/check-abac-predicates.ts` (`arch:abac-predicates`) | Every `requireAbac(_, "<name>")` must name a predicate some module registers. M3's registry fails closed, so a typo'd name is a permanently dead 403 endpoint with the build green. **NOT a Biome rule** — earlier revisions of this table claimed `require-explicit-authz` was "already in place"; `biome.json` has no custom rules and Biome 1.9.4 has no plugin API, so that rule never existed. |
| 9 | **Read-audit** | `apps/backend/src/bootstrap/plugins/read-audit.ts` (runtime, fail-closed) + `arch:audit-denylist-sync` | A PHI read escaping the §164.528 accounting. Enforced at REQUEST TIME by a fail-closed coverage gate, not by a linter — the claimed Biome `require-read-audit` likewise never existed. |
| 10 | **Tenancy invariants** (ADR-0010) | `scripts/check-tenancy.ts` | A PHI table missing `organization_id`/`provider_entity_id`/`location_id`; an RLS policy keyed on any variable other than `app.org_id`; an `OR organization_id IS NULL` tenant-write or permissive-`OR` `FOR ALL` policy. |
| 11 | **Ownership evasions / RLS bypass** (ADR-0011) | `scripts/check-table-ownership.ts` (extended) | Raw SQL or a PL/pgSQL trigger naming another module's table; `withPlatformContext` touching PHI with no org predicate; a migration writing a helper-only table outside its helper path. |
| 12 | **PostgreSQL DDL legality** (ADR-0022) | `scripts/check-ddl-legality.ts` | A partitioned table's UNIQUE/PK not including the partition column; a subquery inside a CHECK constraint; a duplicate enum-type definition of the same kind — DDL that fails at migration time. |

Checks 1–7 are added by the original kit; 8–9 already exist from Modules 3–4; **10–11 by Phase-2**
(ADR-0010/0011); **12 by Phase-6** (ADR-0022). The Phase-6 §20.B **template requirements** (ADR-0021:
per-route Idempotency-Key, queue DLQ/retry, STRIDE, DR tier + degraded-mode, SEC-052, cursor
pagination, sqlcipher offline) are template-completeness lints over each spec. All are listed so the
full fitness surface is in one place.

## Why table ownership is separate from RLS

RLS enforces the **tenant** boundary: rows must match `app.org_id`. It says nothing about which **module** may touch which table. Module 8 reading Module 12's tables within the same org passes RLS cleanly. Table ownership is part of the module boundary, so it is enforced independently: a module may touch only its `ownedTables`; cross-module access goes through the owner's exported repository/service, never its Drizzle schema.

## Wiring (package.json + CI)

> **Do not read the gate list from this document — read it from `package.json`.** This section used
> to inline a four-gate `arch:fitness`; the real chain is **23 gates as of 2026-08-14** and grows. `ci.yml` already
> made this fix for its own stage label. The authoritative list is the `arch:fitness` script:
>
> ```bash
> bun run --silent arch:fitness --help 2>/dev/null; node -e "console.log(require('./package.json').scripts['arch:fitness'].split('&&').map(s=>s.trim()).join('\n'))"
> ```
>
> As of 2026-08-14 that is: `arch:parity`, `arch:boundaries`, `arch:tables`, `arch:tenancy`,
> `arch:ddl`, `arch:gaps`, `arch:ai-governance`, `arch:architecture-docs` (the corpus-freshness
> gate: cited paths exist, companion/ADR citations resolve, version headers parse — see
> `scripts/check-architecture-docs.ts`), `arch:plan-integrity`, `arch:status-matrix`,
> `arch:ui-parity`, `arch:frame-fidelity`, `arch:design-tokens`, `arch:abac-predicates`,
> `arch:live-suites`, `arch:org-indexes`, `arch:audit-denylist-sync`, `arch:audit-exceptions`,
> `docs:ui`, `openapi:check`, `arch:openapi-coverage`, `arch:inject-coverage`, `client:check`.

> **Layout (realized 2026-06-11).** The kit now lives in its intended layout: the manifest
> (`architecture/module-manifest.{ts,cjs}`) and the depcruise config (`architecture/.dependency-cruiser.cjs`,
> which `require`s the manifest as a sibling) sit under `architecture/`; the three check scripts
> (`scripts/check-table-ownership.ts`, `scripts/check-tenancy.ts`, `scripts/check-ddl-legality.ts`,
> each importing `../architecture/module-manifest`) sit under `scripts/`. The root `package.json`
> wires the `arch:*` scripts. The three `bun`-run checks run end-to-end today; `arch:boundaries`
> needs `bun install` (the `dependency-cruiser` devDependency) and the `apps`/`packages` source tree
> to exist before it reports.

CI runs `arch:fitness` as its own stage, after typecheck and before unit tests, in the existing pipeline:

```
lint (Biome — NOTE: `continue-on-error: true` in ci.yml, so a red lint does NOT fail the build;
      it carries no custom rules, see checks 8/9 above)
  → typecheck
  → arch:fitness  (boundaries + adapter mandate + domain/FHIR direction + table ownership + cycles)   ← NEW STAGE
  → unit tests
  → integration tests (Testcontainers)
  → RLS isolation tests
  → build
  → Playwright
  → SBOM
```

A failing fitness check blocks merge exactly like a failing test. The visual graph (`arch:graph`) is generated for the architecture docs so the real dependency graph can be eyeballed against §20's intended one.

## Operating rules

1. **Foundation interfaces freeze before consumers build.** Modules 1–4 (and 36/38/40) are high fan-in; once a clinical module depends on them, changing their public surface is expensive. Resolve their open questions and freeze public APIs as a set before Module 5 starts. Internal refactoring stays free; public-surface changes are deliberate, reviewed manifest/interface edits.
2. **Seams are typed and fail loud.** Cross-module contracts are TypeScript interfaces with boot-time validation, not conventions: the destruction `eraseFn`/`DataEraser` registry fails at startup if a PHI data class has no eraser; `CaseloadProvider` is an interface M5/M17 must implement; M4's permission keys are a compile-time contract with M3. A forgotten interface is a red build or a failed boot, never a silent runtime bug. **Seam interfaces live in `packages/types`; consuming a seam or an outbox event needs no `dependsOn` edge** (see "Seam & outbox contracts" above, ADR-0005 D1).
3. **Adding a dependency is an architecture decision.** It is a manifest edit, reviewed like any architecture change — not something that happens implicitly by typing an `import`. Any `dependsOn` delta beyond the manifest is made as **one consolidated ADR per module, with a transitive cycle analysis** (not just direct edges — ADR-0005 D5). CMSRs and spec footnotes may *document* a need but may never *authorize* an import the manifest forbids.
4. **The graph is regenerated, not hand-maintained.** `arch:graph` produces the picture from the code; drift between the picture and §20 is itself a signal.

## Files in this kit

| File | Purpose |
|---|---|
| `architecture/module-manifest.ts` | source of truth: codePaths, dependsOn, ownedTables, vendor adapters, helper-only tables |
| `architecture/module-manifest.cjs` | transpiled build the depcruise config requires (regenerate on manifest change) |
| `architecture/.dependency-cruiser.cjs` | generates checks 1–5, 7 from the manifest |
| `scripts/check-table-ownership.ts` | checks 6 + 11 (ownership + ADR-0011 evasions) |
| `scripts/check-tenancy.ts` | check 10 (ADR-0010 tenancy/RLS invariants) |
| `scripts/check-ddl-legality.ts` | check 12 (ADR-0022 PostgreSQL DDL legality) |

> **Superseded (2026-08-14).** The manifest is now authoritative for **all 40 modules** — every one
> has `codePaths`, `dependsOn` and a filled `ownedTables` (**464 tables**), and `arch:parity` keeps
> the generated `apps/`+`packages/` tree 1:1 with it. The tightening described above has completed;
> nothing is left to fill in.
>
> **`scripts/audit-fitness.ts` is wired to no `package.json` script** — it is a point-in-time
> enforcement audit (module matrix, table ownership, dependency graph/cycles) writing
> `audit/FITNESS_ENFORCEMENT_AUDIT.md`. Run it directly: `bun run scripts/audit-fitness.ts`.

<!-- verified-against: 6a6eb454a12a · 2026-08-14 -->
