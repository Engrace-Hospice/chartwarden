-- M26 (found while seeding scenario data, same session as 0189) — `POST /cap/periods` is unconditionally
-- broken too, for a different reason than the platform constant: `openPeriod` (`write-service-drizzle.ts`)
-- calls `create_cap_beneficiary_accrual_line_partition` / `create_cap_inpatient_day_line_partition` /
-- `create_cap_projection_snapshot_partition` LIVE, inside the request's own `withOrgContext` tx, as
-- `wardenx_app`. All three (migration 0087) are `CREATE OR REPLACE FUNCTION ... AS $$ ... $$` with no
-- `SECURITY DEFINER` — i.e. SECURITY INVOKER — and each body runs `CREATE TABLE IF NOT EXISTS ... PARTITION
-- OF ...`, which needs CREATE on schema `public`. `wardenx_app`'s schema ACL is `USAGE` only (`wardenx_app=U`
-- vs `wardenx_admin=UC`), confirmed live: `permission denied for schema public`.
--
-- This is the SAME class of gap 0189 just fixed, but a genuinely different mechanism worth separating out:
-- 0189 was a table-level GRANT revoked from wardenx_app; this is schema-level CREATE wardenx_app never had
-- in the first place, tripped only because M26 is the one module that creates a partition synchronously
-- inside a live user-facing write instead of ahead of time via an elevated migration/maintenance
-- connection (compare `create_clinical_assessment_partition`, migration 0033 — M9's per-month partitions
-- are pre-created by a maintenance job, never called from application TypeScript at all; M26's cap-period
-- partitions are the only ones a live request creates on demand, since a cap period opens once a year per
-- tenant on an unpredictable date, not a schedulable cadence).
--
-- Fix has THREE parts, each caught by re-testing live as wardenx_app after the previous fix (none of this
-- was guessable from reading alone):
--   1. SECURITY DEFINER, owned by `wardenx_admin` (already has CREATE on schema public per its `UC` ACL
--      entry). EXECUTE stays granted to PUBLIC (unchanged from 0087).
--   2. `search_path = public` — NOT `pg_catalog, public` (the 0186-0188 platform-writer precedent's
--      pattern, copied here at first and wrong for this case): each function body's `CREATE TABLE
--      IF NOT EXISTS <unqualified-name> PARTITION OF ...` resolves its UNQUALIFIED target schema from
--      the FIRST schema literally listed in search_path. `pg_catalog` is implicitly searched for name
--      LOOKUPS regardless of search_path, but explicitly listing it first also makes it the CREATE
--      target for an unqualified new object — and no role, not even a superuser, may CREATE inside
--      pg_catalog. Confirmed live: `permission denied for schema pg_catalog`, pointing at the CREATE
--      TABLE statement itself, immediately after fixing (1) alone.
--   3. The three partitioned PARENT tables (`cap_beneficiary_accrual_line` / `cap_inpatient_day_line` /
--      `cap_projection_snapshot`) are owned by `postgres` (the migration-runner). `CREATE TABLE ...
--      PARTITION OF parent` is an ALTER-TABLE-like operation on the PARENT and requires being the
--      parent's OWNER (or superuser) — a GRANT is not sufficient, unlike ordinary DML. Confirmed live:
--      `must be owner of table cap_beneficiary_accrual_line`, immediately after fixing (2) alone.
--      Transferring ownership to `wardenx_admin` (the same role the functions are now owned by) is a
--      DDL-privilege concern, not a tenant-data-write one — RLS/tenancy is unaffected, these three
--      tables are Postgres-partitioned parents, not rows a tenant ever reads/writes as their owner.

ALTER FUNCTION create_cap_beneficiary_accrual_line_partition(uuid) SECURITY DEFINER;--> statement-breakpoint
ALTER FUNCTION create_cap_beneficiary_accrual_line_partition(uuid) SET search_path = public;--> statement-breakpoint
ALTER FUNCTION create_cap_beneficiary_accrual_line_partition(uuid) OWNER TO wardenx_admin;--> statement-breakpoint

ALTER FUNCTION create_cap_inpatient_day_line_partition(uuid) SECURITY DEFINER;--> statement-breakpoint
ALTER FUNCTION create_cap_inpatient_day_line_partition(uuid) SET search_path = public;--> statement-breakpoint
ALTER FUNCTION create_cap_inpatient_day_line_partition(uuid) OWNER TO wardenx_admin;--> statement-breakpoint

ALTER FUNCTION create_cap_projection_snapshot_partition(uuid) SECURITY DEFINER;--> statement-breakpoint
ALTER FUNCTION create_cap_projection_snapshot_partition(uuid) SET search_path = public;--> statement-breakpoint
ALTER FUNCTION create_cap_projection_snapshot_partition(uuid) OWNER TO wardenx_admin;--> statement-breakpoint

ALTER TABLE cap_beneficiary_accrual_line OWNER TO wardenx_admin;--> statement-breakpoint
ALTER TABLE cap_inpatient_day_line OWNER TO wardenx_admin;--> statement-breakpoint
ALTER TABLE cap_projection_snapshot OWNER TO wardenx_admin;
