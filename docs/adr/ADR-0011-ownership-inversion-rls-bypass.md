# ADR-0011 — Ownership inversion & RLS-bypass discipline (corpus-wide)

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 2 (platform invariants, corpus-wide sweep)
- **Resolves:** X6, S8; M40-F01 (raw-SQL nppes read), M11-F03 (cross-tenant PHI sweep), M30-F01
  (PL/pgSQL trigger reading M5/M11/M22), M38-F01 (deprecation scan of consumer tables), M26-F02 /
  M10-F01 (schema imports), M16/M39 migration inserts; builds on Phase-1 M02-F01/M04-F01
- **Depends on:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md)
- **Changes:** `scripts/check-table-ownership.ts` (extended); `ARCHITECTURE_25_15_FITNESS.md`; per-module seam inversions (CI-gated)

## Context

Several modules reach into another module's tables, evading the import-level ownership checker by
not importing the Drizzle schema:

- **M40** reads M29's `nppes_provider` via **raw SQL** to dodge the import check.
- **M11** runs a **daily cross-tenant PHI sweep** under `withPlatformContext` with **no `org_id`
  predicate** (S8).
- **M30** uses a **PL/pgSQL trigger** that `SELECT`s M5/M11/M22 tables.
- **M38** 's deprecation scan reads consumer tables directly.
- **M26 / M10** import another module's Drizzle schema; **M16 / M39** migrations `INSERT` into
  M1/M4 helper tables directly.

The ownership rule (fitness check #6) and the no-circular rule exist, but the static checker only
catches Drizzle-schema *imports* — raw SQL, PL/pgSQL triggers, and unscoped platform-context sweeps
slip through.

## Decision

### D1 — No direct cross-module table access, by any mechanism

A module touches only its own `ownedTables`. Cross-module reads go through the **owner's exported
reader/repository** or a **boot-registered seam** (ADR-0005 D1) — never the other module's Drizzle
schema, **raw SQL string, or a PL/pgSQL trigger that names another module's table**. Specifically:

- **M40 → M29 NPPES:** consume an `NppesProviderReader` seam published by M29 (or M29 pushes via
  outbox into an M40-owned projection). No raw SQL against `nppes_provider`.
- **M30 → M5/M11/M22:** replace the cross-table PL/pgSQL trigger with **outbox-event consumption**
  (owners push the facts M30 needs) or owner-published reader seams. Triggers may read only the
  owning module's own tables.
- **M38 deprecation scan:** owners publish usage counts via a reader seam / outbox; M38 does not
  scan consumer tables.
- **M26 / M10 schema imports:** drop the import; resolve via the owner's reader/seam (M10 keeps
  `patient_id`/`admission_id` as plain uuids, FKs in raw migration SQL — M10-F01).
- **M16 / M39 migrations:** never `INSERT` into M1/M4 helper tables; contribute via the owner's
  registration API (audit action catalog, etc.) at boot.

### D2 — `withPlatformContext` may not read PHI without an explicit org predicate

The RLS-bypass helper (ADR-fixed in M01-F05 to a separately-pooled, allowlisted credential) is for
**genuinely cross-tenant platform jobs**. Any query it runs against a PHI table **must** carry an
explicit `organization_id = $1` (or an explicit, audited, justified cross-tenant scope at
`severity=critical`). A **daily cross-tenant PHI sweep with no org predicate is banned** (M11-F03):
re-scope it per-organization (iterate tenants under `withOrgContext`) or run it as an org-scoped
job. DSAR/export workers run under the requesting tenant's `withOrgContext`, not platform bypass
(M34-F09).

### D3 — Enforcement

`scripts/check-table-ownership.ts` is extended to also flag, as `error`:

1. A **raw SQL string** (`sql\`… <table> …\`` / `db.execute(...)`) naming another module's
   `ownedTables` table outside the owner's codePaths.
2. A **PL/pgSQL `CREATE FUNCTION`/trigger body** that `SELECT`s/`INSERT`s another module's table.
3. A `withPlatformContext(...)` block whose body references a PHI table **without** an
   `app.org_id` / `organization_id =` predicate (heuristic: flag for review).
4. A migration `INSERT INTO`/`UPDATE` against a `HELPER_ONLY_TABLES` table outside the helper paths.

These are heuristic static checks (like the existing import check) — they catch the common,
dangerous cases and route the rest to review.

## Consequences

- The named modules invert their cross-module reads to seams/readers/outbox during their
  reconciliation; the extended checker keeps the build red until they do.
- Combined with ADR-0005 (seam = no edge) and ADR-0010 (tenancy columns + generated RLS), this
  closes the "same-tenant cross-module access" and "RLS-bypass on PHI" gaps the audit flagged.
