# ADR-0005 — Manifest as single source of truth: seam/outbox consumption needs no import edge; ban `packages/foundation`; foundation-helper reachability

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 0 (architecture / manifest correction)
- **Resolves:** X1, X2, X12; M01-F01, M02-F03, M03-F02/F07, M04-F05, M09-F01, M10-F01; Build-Blocking #1/#3/#4
- **Changes:** `module-manifest.ts`, `module-manifest.cjs`, `ARCHITECTURE_25_15_FITNESS.md`, `CHARTWARDEN_ARCHITECTURE_v0_11.md` §25.15

## Context

The manifest (`module-manifest.ts`) is the single source of truth: `dependsOn` is the
machine-readable cross-module contract list, and the fitness checks generate import-boundary,
ownership, and cycle rules from it. Nearly every module spec quietly diverged from it, producing
the corpus's #1 build blocker. Three recurring confusions drove this:

1. **What requires a `dependsOn` edge.** Specs added import edges merely to consume an **outbox
   event** or a **boot-registered seam** — and frequently invented edges that create cycles.
   They also cited a non-existent "lock precedent that surfaces all imports incl. foundation."
2. **Where seam interfaces and helpers live.** Six specs invented a `packages/foundation`
   package (in neither the manifest nor architecture §4). FHIR mappers, state machines, and
   re-exported feature seams were placed in the pure leaf `packages/domain`, breaking the
   `domain-is-pure` / `leaves-stay-leaves` fitness checks by design.
3. **Reaching the mandated helpers.** Every PHI route must call `requirePermission`/`requireAbac`
   (auth), `audit()` (audit), and run under `withOrgContext()` (tenancy). Many modules' `dependsOn`
   omits 1–4, so they cannot mechanically import those helpers, yet are required to use them.

## Decision

### D1 — A `dependsOn` edge is required only for a compile-time import of the producer's package

A module adds `dependsOn` for module *M* **only if** it imports *M*'s code (its exported
repository/service/reader, types from *M*'s codePath, etc.) at compile time.

It does **not** add an edge when it consumes *M* only through either of the two **boundary-clean
contract channels**:

- **Outbox events** — subscribing by event name, with the payload type declared in the leaf
  `packages/types`. (At-least-once + idempotent-consumer semantics per ARCH-263.)
- **Boot-registered seams** — calling an interface whose **type lives in the leaf
  `packages/types`** and whose **implementation is injected at boot** by the owning module. The
  seam must be listed in `REQUIRED_SEAMS` and validated by `validateSeams()` (fail-at-boot).

Rationale: both channels are leaf-typed and runtime-wired, so they create no compile-time import
of the producer's package — there is nothing for the boundary rule to forbid, and the contract is
still explicit (event catalog + seam registry) and still fail-loud (boot validation).

### D2 — Seam interfaces live in `packages/types`; never re-export a feature package from a leaf

- Seam **interface types** are defined **natively in `packages/types`** (pure types, zero
  imports from feature/app packages). The **owning feature package implements** them (correct
  direction, like `CaseloadProvider`). A leaf must never `re-export` a feature package — that is
  an import and fails `leaves-stay-leaves`/`domain-is-pure` (M09-F01).
- FHIR mapping lives **only** in `packages/fhir`; the domain never imports FHIR (`fhir-direction`).
- Drizzle schema lives in `packages/db/src/schema/<module>/`; **table ownership** is enforced by
  `check-table-ownership.ts` (by `pgTable` name → `ownedTables`), independently of imports.

### D3 — `packages/foundation` is banned

`packages/foundation` exists in no manifest codePath and no architecture §4 package list. Its
contents are re-homed:

| Invented home | Correct home |
|---|---|
| outbox publish / dispatcher | `packages/shared` (helper) |
| `withOrgContext` + RLS generator | `packages/tenancy` (M1) |
| `audit()` / `auditRead()` | `packages/audit` (M4) |
| seam interface types, policy constants | `packages/types` (leaf) |
| crypto envelope, settings/CMSR registries | `packages/db` / owning feature package |

### D4 — Foundation helper packages are implicitly importable by every module

Add a `FOUNDATION_HELPER_PACKAGES` set, appended to every module's allowed-import set, so a
module may call the mandated platform helpers **without** listing 1–4 in `dependsOn`:

- `packages/audit` — `audit()` / `auditRead()`
- `packages/auth` — `requireSession` / `requirePermission` / `requireAbac` guard middleware
  (public surface; M2/M3 internals remain private by convention/review — a depcruise sub-path
  refinement to `packages/auth/src/middleware` + `…/seams` is a follow-up)
- `packages/tenancy` — `withOrgContext()` + the RLS policy generator
- `packages/db/src/schema` — Drizzle **schema types** (data access to *other* modules' tables is
  still blocked by `check-table-ownership.ts` and the helper-only-table rule)

This makes M03-F02 ("M3 needs M1 surfaces but `dependsOn` is `[2]`") and the corpus-wide
"`packages/auth` reachability" suspicion resolve **without** per-module `dependsOn` edits. The
`no-circular` rule still forbids the foundation tier (M1–M3) from actually importing a helper
that would close a cycle; the foundation tier audits via M1's trigger mechanism, not `audit()`.

### D5 — Process rule: one consolidated ADR per module for `dependsOn` deltas

When a module is (re-)specced, any change to its `dependsOn` beyond the manifest is made as a
**single consolidated ADR** for that module, including a **transitive cycle analysis** (not just
direct edges — the M22 patch failed because it checked only direct edges). CMSRs and spec
footnotes may **document** a need but may **never** authorize an import the manifest forbids.

## Consequences

- The manifest header, `allowedImportPaths`, and `ARCHITECTURE_25_15_FITNESS.md` are updated to
  encode D1–D4. A new architecture subsection §25.15 records the seam/outbox-no-edge rule.
- Foundation re-locks (M01–M04, Phase 1) drop `packages/foundation`, place seam interfaces in
  `packages/types`, and rely on `FOUNDATION_HELPER_PACKAGES`.
- The 22↔39 manifest cycle is fixed under this rule by [ADR-0006](ADR-0006-resolve-manifest-22-39-cycle.md);
  the M8↔M9/M10 direction by [ADR-0007](ADR-0007-m8-m9-m10-read-direction.md).
