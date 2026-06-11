# ADR-0010 — Tenancy & RLS invariants (corpus-wide)

- **Status:** Accepted
- **Date:** 2026-06-11
- **Phase:** 2 (platform invariants, corpus-wide sweep)
- **Resolves:** X3, X4, S1, S5; M34-F02, M33 (RLS var), M21 (RLS var), M24 (permissive-OR), and the
  RLS-variable/tenancy-column findings across M05/M07/M08/M09/M10/M11/M14/M15/M16/M17/M19/M22/M31/M36
- **Changes:** new `scripts/check-tenancy.ts`; `ARCHITECTURE_25_15_FITNESS.md`; per-module schema sweeps (CI-gated)

## Context

The audit's #2 systemic cluster is broken tenant isolation: PHI tables missing tenancy columns
(X3), and a zoo of wrong RLS session variables (X4) — `app.organization_id`, `app.tenant_id`,
`app.current_org_id`, `wardenx.org_id`, `app.current_organization_id`. Most fail **closed** (deny
all — broken, not leaky), but two patterns are actively dangerous: `OR organization_id IS NULL`
(M01, fixed in Phase 1) and permissive-`OR` `FOR ALL` policies (M24) that *weaken* isolation.
Worst of all, **M34 — the module that defines the invariant — violates it** (most tenant tables
have no `organization_id`; it scopes via FK-join subqueries). These were enforced by prose, not by
a check, so they drifted.

## Decision

### D1 — Every PHI table carries the three tenancy columns (ARCH-011)

Every PHI-bearing table has `organization_id` **NOT NULL** (FK → `organization`), plus
`provider_entity_id` and `location_id` (nullable **only** on org-level entities). Scoping a table by
a **FK-join subquery to a parent's `organization_id` is forbidden** where the column can exist (it
almost always can). The SD-028 composite index `(organization_id, <natural_key>)` is required, and
`*_event`/partitioned tables co-partition `LIST organization_id → RANGE <time>` (SD-027).

### D2 — One canonical RLS session variable: `app.org_id`

The session variable is **`app.org_id`**, set by `withOrgContext()` via `SET LOCAL` (M1/`packages/tenancy`).
No spec may use `app.organization_id`, `app.tenant_id`, `app.current_org_id`, `wardenx.org_id`,
`app.current_organization_id`, or any other spelling. The context helper is `withOrgContext()`
(not `withTenantContext`).

### D3 — RLS policies are generated, never hand-written

Every PHI table's RLS policy is emitted by the **M1/M2 RLS policy generator** (`packages/tenancy`
`generateRlsPolicy()`), which produces the canonical
`USING/WITH CHECK (organization_id = current_setting('app.org_id', true)::uuid)` form (with a
separate read policy where global/template rows are legitimately shared — e.g. feature flags,
role templates — and a WITH CHECK that **excludes** any NULL branch). The following are **banned**:

- `... OR organization_id IS NULL` in a tenant-writable policy (lets a tenant write global rows).
- Two **permissive** `FOR ALL` policies that `OR` together (a stale session var can grant
  cross-tenant rows — M24).
- Any hand-written policy that diverges from the generator output without an ADR.

A table that genuinely cannot use the generator (a bespoke template-sharing pattern) declares the
exemption explicitly and ships a hand-reviewed policy (e.g. M03 `role_permission`, ADR-text in M03).

### D4 — Mixed-session-variable RLS test

The RLS isolation suite adds a **mixed-session-variable test**: set every non-canonical variable
(`app.organization_id`, `app.tenant_id`, …) and assert the row set is **empty** (the policy keys
only on `app.org_id`). This catches a spec that "works" against the wrong variable in dev.

## Consequences

- New CI check `scripts/check-tenancy.ts` (wired into `arch:fitness`) fails any PHI table missing
  the three columns or any RLS policy/`current_setting()` using a non-`app.org_id` variable or a
  banned shape. This makes the per-module column additions a **CI-gated sweep**: each module adds
  the columns during its reconciliation, and the build stays red until it does.
- **M34 is fixed to be the reference implementation** (ADR-text in M34; M34-F02).
- Phase-1 already fixed M01's `OR IS NULL` and M02/M03's variable; this ADR generalizes the rule
  and makes it enforced.
