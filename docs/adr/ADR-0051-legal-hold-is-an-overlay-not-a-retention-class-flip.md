# ADR-0051 — A legal hold on the append-only audit trail is an overlay, not a `retention_class` flip

- **Status:** **Accepted** — decided by the product owner for GAP-008 (2026-10-08).
- **Date:** 2026-10-08
- **Phase:** M4 compliance (legal-hold supremacy).
- **Amends:** Architecture §24.3 ("Any data class can be moved to `legal_hold` retention … all matching records' retention
  class flipped to `legal_hold`") and M4 spec §2.6 / §10.6, for the **`audit_event`** table only. Every other data class keeps
  its own mechanism (see "Not decided here").
- **Related:** [ADR-0010](ADR-0010-tenancy-rls-invariants.md) (RLS keyed only on `app.org_id`), M4 spec §10.4 (the sealed hash
  chain), migration 0001 (the append-only grant model), migration 0157 (`wardenx_destruction`), migration 1053 (this change).

## Context

Architecture §24.3 and the M4 spec say a legal hold flips the matching records to `retention_class = 'legal_hold'` and that
retention jobs skip them. The first GAP-008 fix left the flip unbuilt because `wardenx_app` holds no `UPDATE` on `audit_event`
(migration 0001). Granting `UPDATE` is not the answer, for a stronger reason:

- **`retention_class` is part of the integrity hash.** `db-chain-reader.ts` selects `retention_class::text` and feeds it to
  `hashAuditRow`; the monthly seal (`audit_seal`) chains that hash. Writing the column on apply and again on release would break
  chain verification for every sealed month it touched, and turn the tamper-detection job (§10.4) into a generator of false
  positives — destroying its value as evidence. "Release returns the row to its prior class" would also need the prior class
  stored somewhere.

What the architecture needs is not the column write; it is that **retention and erasure skip held records and reporting shows them
as held**. Those are achievable without mutating any audit row.

## Decision

A hold is recorded as rows in an append-only **overlay**, `legal_hold_audit_event` (M4-owned, migration 1053), and enforced at
the database, not just in application code.

1. **Overlay.** One row per (hold, audit row): `(organization_id, legal_hold_id, audit_event_id, audit_event_created_at)`. There
   is **no `released_at`**: a row is *held* while `legal_hold.status = 'active'`, so releasing a hold is the single existing
   `UPDATE` and takes effect for every row at once. Overlay rows stay as history. `wardenx_app` has `SELECT, INSERT` only and
   cannot un-hold; RLS is keyed on `app.org_id`. No foreign key to the partitioned `audit_event`; `(id, created_at)` is the row's
   identity across the partition key. (The table is deliberately not named `audit_event_*`: `wardenx_audit_trigger()` skips every
   table with that prefix.)
2. **Materialisation.** A sweep (`audit.legal_hold_materialise`, every 5 minutes, always constructed) turns each active hold's
   `criteria` into a predicate over `audit_event` and writes the overlay in day windows — bounded, idempotent
   (`ON CONFLICT DO NOTHING`), resumable from `legal_hold.materialised_through` (with a 10 minute re-scan overlap for late
   commits). Pre-existing active holds default to `materialisation_status = 'pending'` and are backfilled on the first tick. The
   SQL meaning of a hold equals `holdCoversGroup` row by row (a live parity test pins it): `patientIds` = `context.patientId` or
   `resource_id` listed; `resourceKinds` = `resource_kind` listed; `dateRange` = `created_at` in range; all named selectors AND-ed.
3. **Enforcement at the only DELETE path.** `createDbAuditEraseExecutor` adds `NOT EXISTS (an overlay row of an ACTIVE hold)` to its
   `DELETE`, so the count it returns is rows actually destroyed. The group-level structural check (`legalHoldFor` →
   `holdCoversGroup`) stays as the first gate and as cover for rows the overlay has not reached yet, so supremacy never depends on
   the job being current.
4. **Database backstop.** A `BEFORE DELETE` row trigger on `audit_event` (cloned to every monthly leaf) refuses a held row with
   `ERRCODE 23001`, whoever deletes it, with no dependence on the deleter's RLS context (SECURITY DEFINER, owned by `wardenx_admin`,
   pinned `search_path`, a dedicated admin policy on the overlay and on `legal_hold`). It only fires on a bug or an out-of-band
   delete — that is its purpose. `audit_event_audit` is an `AFTER` trigger that is a no-op for audit tables, so there is no
   recursion or ordering hazard and the raised exception writes no audit row.
5. **Reporting.** `audit_event_effective` (`security_invoker`) exposes `effective_retention_class = 'legal_hold'` for held rows; the
   query adapter returns `legalHold` on each record and the compliance export has a `legalHold` column; the retention scan reports a
   held row as the `legal_hold` class (explicit skip reason) and a destruction certificate that left held rows behind lands
   `partial_refused` (`held` when nothing could be touched), with held rows excluded from its `recordCount`. The hashed base column
   is never read through the overlay.
6. **Partition detach.** `audit_archive_detach` now takes `p_manifest_verified` and refuses (`23001`) a partition that contains
   actively-held rows unless the caller attests that the archive manifest was written and read back verified (the archive job passes
   `true` only after `putAndVerify` of the manifest). The old two-argument function is dropped so it cannot be used to skip the check.
   Detach is not destruction — the partition is kept, never dropped.

## Consequences

- No audit row is ever rewritten by a hold; `digestMonth` is identical before and after a hold is applied (asserted live).
- **Residual, stated plainly.** `DROP` / `TRUNCATE` of a partition, or `session_replication_role = replica`, by a superuser bypasses
  the trigger: a procedural control (M1 never drops partitions). The destruction credential in production (`destructionDb`) is still
  a deployment concern; this change makes its use safe but does not provision it. Un-materialised rows rely on the group-level
  structural check for up to one sweep interval.
- **Open decision — the "adjusted clock" on release.** M4 §10.6 says a released hold returns rows "to their prior class with an
  adjusted clock" but defines no rule, and the architecture text has none. Retention here is anchored on `created_at` and this ADR
  does **not** invent an extension: a row whose natural due date passed while it was held becomes destruction-eligible as soon as the
  hold is released (the plain reading of "returns to its prior class"). Whether release should restart or extend the clock is a new
  retention semantic that needs a product decision before anyone builds it.

## Not decided here (phase 2)

Owning-module coverage: a `LegalHoldReader` port for M10 / M34 / M39 (M10 ignores `dateRange` / `resourceKinds` and conservatively
blocks the org; M39 substring-matches the criteria JSON, the bug class GAP-008 fixed for audit), an M22 `HoldApplier` that writes
`document_legal_hold` from an M4 hold, and an `arch:hold-coverage` ratchet over every `registerEraser(...)` site. They are separate
work with their own seams and are not part of this change.
