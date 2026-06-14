# ADR-0028 — Adapter packages join the manifest codePaths (fitness-governed)

- **Status:** Accepted (applied 2026-06-14 — manifest edited, `.cjs` mirror updated, 5 packages
  scaffolded; `arch:fitness` green at 36 packages)
- **Date:** 2026-06-14
- **Phase:** pre-build governance (applies before the Phase-2/Phase-3 modules that own these adapters build)
- **Resolves:** the "spec-referenced but in no `codePath`" gap flagged in the Phase-2/3 plans
  (`WAVE_P2-2`, `WAVE_P2-3`, `IMPLEMENTATION_ROADMAP`) — adapter packages the architecture §25.14
  adapter mandate requires, which the fitness kit cannot see because they belong to no module.
- **Depends on:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (manifest is the single
  source of truth; codePaths define ownership + import boundaries) and
  [ADR-0027](ADR-0027-phase-0-toolchain-and-scaffold.md) (the scaffold + `arch:parity` gate generated
  from codePaths; D-f "scaffold all packages empty").
- **Changes (on acceptance):** `architecture/module-manifest.ts` (`codePaths` for M10/M18/M19/M27 +
  `VENDOR_ADAPTERS` for the new SDKs); regenerate the tree via `bun run scaffold`. No `dependsOn` or
  `ownedTables` change (adapters own no tables).

## Context

Architecture §25.14 (the **adapter mandate**) requires every external vendor SDK / sidecar / URL /
credential to live in exactly one adapter package, so the rest of the corpus depends only on the
adapter's typed interface. The fitness kit enforces this three ways, **all keyed on the manifest's
`codePaths`**:

1. **dependency-cruiser** generates a module-boundary rule per module from its `codePaths`, plus the
   `vendor-adapter-*` rules from `VENDOR_ADAPTERS` (an SDK may be imported only inside its owner path).
2. **check-table-ownership.ts** scans each module's `codePaths`.
3. **scaffold-from-manifest.ts** (the `arch:parity` gate) requires every `codePath` to be a real dir
   and flags orphan `packages/*`.

Several adapter packages the specs reference are **in no `codePath`**, so they are invisible to all
three — a thin adapter could import a banned package, leak a vendor SDK, or drift, with no gate firing:

| Package | Owner (module) | What it adapts |
|---|---|---|
| `packages/evv-aggregators` | M18 EVV | per-state EVV aggregator vendors (pluggable, §4.5 D1) |
| `packages/triage-vendors` | M19 On-Call Triage | external triage-vendor APIs (§8.5) |
| `packages/xero-client` | M27 Cost Report | Xero GL SDK (§4.5 D6) |
| `packages/gusto-client` | M27 Cost Report | Gusto payroll SDK (§4.5 D6) |
| `packages/iqies-client` | M10 HOPE Engine | CMS iQIES HOPE-submission endpoint (§4.10) |

Phase 0 deferred these (ADR-0027 deviation note) to keep the scan set 1:1 with the manifest. They must
be governed **before** their owning module builds (M10 is Phase 1; M18/M19/M27 are Phase 2; the rule
should hold uniformly).

## Decision

**Add each cleanly single-module-owned adapter package to its owner module's `codePaths`, and register
its vendor SDK in `VENDOR_ADAPTERS`.** Specifically, in `architecture/module-manifest.ts`:

- M10 `codePaths`: add `"packages/iqies-client"`.
- M18 `codePaths`: add `"packages/evv-aggregators"`.
- M19 `codePaths`: add `"packages/triage-vendors"`.
- M27 `codePaths`: add `"packages/xero-client"`, `"packages/gusto-client"`.
- `VENDOR_ADAPTERS`: add the Xero and Gusto npm SDK package names → their adapter
  (`"xero-node": "packages/xero-client"`, `"@gusto/embedded-api"` or the chosen SDK →
  `"packages/gusto-client"`). `evv-aggregators` and `triage-vendors` are hand-rolled HTTP (no single
  SDK) — no `VENDOR_ADAPTERS` entry, but the boundary + ownership rules now cover them.

Each adapter, being part of its owner's boundary, may import its owner's `dependsOn` + leaves +
foundation helpers, and **only** the adapter may import its vendor SDK. Adapters own **no tables**.

### Explicitly NOT changed
- **`@wardenx/mobile-offline` stays manifest-exempt.** It is on-device sqlcipher with no `org_id`/RLS
  server contract (manifest header scope note); it is intentionally outside the server fitness model.

### Open item (deferred to a follow-up ADR) — `packages/x12-worker-client`
The X12 worker client is referenced by **both M23 (837 gen + 999/277CA parse) and M25 (835 parse)**. A
single package cannot be owned by two modules, and M23 may not import an M25-owned package (M23 has no
`dependsOn` edge to M25; only M25→M23 exists). **Recommended resolution (next ADR): split into two
packages** — `packages/x12-837-client` (M23-owned) and `packages/x12-835-client` (M25-owned), each
fronting the shared Python `x12-worker` sidecar — and update the Wave G plan's wording accordingly. Do
**not** add a shared `x12-worker-client` codePath, as that would force a single owner.

## Application

Per ADR-0027 D-f (scaffold all packages empty so the boundary graph is complete), **apply now**:

1. Edit `architecture/module-manifest.ts` (`codePaths` + `VENDOR_ADAPTERS`) and rebuild the `.cjs`
   mirror (`architecture/module-manifest.cjs`) the dependency-cruiser config requires.
2. `bun run scaffold` — generates the five empty governed packages (`package.json`/`tsconfig.json`/
   `src/index.ts`) and updates the root `tsconfig.json` references; `arch:parity` then passes 1:1.
3. `bun run arch:fitness` stays green (empty adapters import nothing); the packages are fitness-governed
   from day one, and the owning module fills them when it builds.

Alternative (rejected): defer each manifest edit to the module's first build task — rejected because it
re-introduces the Phase-0 gap (the adapter is ungoverned during the window it's being written, exactly
when a leak is most likely).

## Consequences

- The five adapter packages are covered by the boundary, vendor-adapter, ownership, and parity gates
  before any code lands in them.
- Package count rises from 31 → 36 (still 1:1 with the manifest; `arch:parity` enforces it).
- The Phase-2/3 wave plans' "⚠ manifest note" items (xero/gusto/triage-vendors/evv-aggregators) are
  resolved; M10's iQIES adapter is governed for Phase 1.
- `x12-worker-client` remains the one open adapter-ownership question, tracked for a follow-up ADR.
