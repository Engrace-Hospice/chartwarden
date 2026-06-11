# ADR-0022 — PostgreSQL DDL legality + per-spec reconciliation (X9)

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 6 (per-spec reconciliation)
- **Resolves:** X9; Build-Blocking #5; the partition-key/unique-index and CHECK-subquery
  impossibilities in M14/M15/M16/M20/M22/M24; the duplicate-enum and two-schema incoherences in
  M21/M22/M17/M06/M16/M25/M26/M29/M30/M36
- **Changes:** `scripts/check-ddl-legality.ts`; `ARCHITECTURE_25_15_FITNESS.md`; the X9 specs (CI-gated)

## Context

Several "Locked" specs contain DDL that **cannot be created in PostgreSQL** — the build fails at
migration time, not review time — plus pairs of contradictory state machines / enum sets / schemas
that a "consolidation" pass never reconciled.

## Decision

### D1 — PostgreSQL DDL legality rules (CI-enforced)

1. **Partition key must be in every UNIQUE index / PRIMARY KEY of a partitioned table.** PostgreSQL
   requires the partition column to be part of any unique constraint on a partitioned table. A
   `UNIQUE(natural_key)` on a table partitioned by `organization_id`/`time` is **illegal**; it must
   be `UNIQUE(partition_key, natural_key)`. (M14, M15, M16, M20, M24.)
2. **No subqueries in CHECK constraints.** PostgreSQL forbids `SELECT` inside a `CHECK`. Cross-row /
   cross-table invariants move to a `BEFORE` trigger (reading only the owning module's tables —
   ADR-0011) or a partial unique index / exclusion constraint. (M16, M22, M24.)
3. **No duplicate enum-type definitions.** A Postgres `CREATE TYPE … AS ENUM` (or Drizzle `pgEnum`)
   may be defined **once**; a second definition of the same type name fails the migration. (M36's
   duplicate alert-enum type.)

### D2 — One reconciliation pass per incoherent spec (X9)

Each "Locked" spec that carries two contradictory artifacts is reconciled in a single pass that
unifies **schema ⇄ workflow ⇄ event-catalog ⇄ permissions** to one truth before re-lock:

| Spec | Incoherence to reconcile |
|---|---|
| **M21** | SQL migration vs Drizzle schema describe **two different databases** — unify to one |
| **M22** | 16 majors, mostly schema-vs-workflow drift |
| **M17** | **two** 8-state scheduling machines; front-half/back-half describe different modules |
| **M06** | broken migration `0036`; dead cancel-admit state path |
| **M16** | partition-key/unique-index impossibility + CHECK subquery |
| **M25** | contradictory denial/appeal enums |
| **M26** | cap-period vs accrual enum drift |
| **M29** | schema-vs-implementation drift that defeats the audit denylist + breaks boot |
| **M30** | death-source / measure enum drift |
| **M36** | **two** alert subsystems + a duplicate Postgres enum-type that fails migration |

### D3 — Re-lock discipline

A spec is not "Locked" until it passes `check-ddl-legality` and has a single coherent
schema/workflow/event/permission story. The CI check (`arch:ddl`) is added to `arch:fitness`.

## Consequences

- `scripts/check-ddl-legality.ts` flags partition-key-not-in-unique-index, CHECK subqueries, and
  duplicate enum definitions; wired into `arch:fitness` (fitness check #12).
- Each X9 spec's reconciliation is per-module work, now **gated** — the build stays red until the
  illegal DDL is fixed and the contradictory artifacts are unified.
