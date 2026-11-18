-- compat: contract
-- M23 SIA revisions (slice 1). `sia_calculation` was 0..1 per claim (UNIQUE (claim_id), 0075). The units model re-derives the add-on
-- whenever a visit fact changes (a clinician confirms a visit's delivery mode, a start/stop is recorded, the CHC rate is re-keyed)
-- while the claim is still DRAFT / VALIDATING / READY. The table is append-only (trg_append_only_sia_calculation: UPDATE always
-- refused, DELETE only for a deletable DRAFT claim's own rows, 1061), so a change is a NEW ROW: revision = latest + 1, and
-- the newest revision is the one the claim shows. UNIQUE (claim_id) therefore becomes UNIQUE (claim_id, revision); the
-- composite index still serves every `WHERE claim_id = ?` read through its left prefix. The append-only trigger fires BEFORE UPDATE
-- OR DELETE only, so on its own it would leave a second INSERT open on ANY claim, and `findLatestSiaByClaim` would then publish
-- that row as the claim's add-on even after the claim was submitted or paid. `trg_sia_calculation_insert_guard` (below) closes it
-- in the database: a row is accepted only while the claim is DRAFT / VALIDATING / READY (the states in which re-validation may
-- run) and only as the next revision (latest + 1, so no gaps and no caller-chosen number). UPDATE and DELETE rules are unchanged.
-- `contract`: the previous release inserts with ON CONFLICT (claim_id), which needs that unique index, so it cannot run on this
-- schema (a death-claim assembly by an old container during the rollout fails with 42P10, and its `findByClaim` reads an
-- arbitrary revision once a claim has more than one). ROLLBACK IS A ONE-WAY DOOR once any claim holds revision >= 2: the table is
-- append-only (UPDATE refused, DELETE only for a draft claim's own rows), so UNIQUE (claim_id) cannot be restored by any application
-- or admin DELETE: the append-only trigger has no role exemption, so it would take a deliberate, recorded disable of that trigger
-- by the table owner, which rewrites the add-on of billed claims. Ship this with the code that reads the newest revision, drain
-- old containers first. Whether a deploy lets that happen depends on `deploy.sh`: where its migrate step passes `--hold-contract`, a pending
-- `contract` migration is held (exit 75, before any DDL) until an operator applies it by hand after the drain; where it does not
-- (check the file), a merge to `main` applies this while the old api and worker still run. Either way the drain is a precondition,
-- see docs/runbooks/m23-sia-revisions-deployment.md. The CHECKs pin what 1511's defaults promise: a known basis, a positive revision, and a `units_v2` row that carries
-- the whole units snapshot (a legacy `minutes_v1` row has none of it and is exempt). The CHC rate may be NULL only when nothing is
-- payable (`paid_units = 0`): such a row exists to show billing WHY no add-on is payable, and no rate is resolved for it, so a
-- claim with nothing to pay can never fail on a missing rate or wage index. NULL means "not priced", never a fabricated 0.
ALTER TABLE "sia_calculation" DROP CONSTRAINT IF EXISTS "sia_calculation_claim_uq";--> statement-breakpoint
ALTER TABLE "sia_calculation" DROP CONSTRAINT IF EXISTS "sia_calculation_claim_revision_uq";--> statement-breakpoint
ALTER TABLE "sia_calculation" ADD CONSTRAINT "sia_calculation_claim_revision_uq" UNIQUE ("claim_id", "revision");--> statement-breakpoint
ALTER TABLE "sia_calculation" DROP CONSTRAINT IF EXISTS "sia_calculation_basis_chk";--> statement-breakpoint
ALTER TABLE "sia_calculation" ADD CONSTRAINT "sia_calculation_basis_chk" CHECK ("basis" IN ('minutes_v1', 'units_v2'));--> statement-breakpoint
ALTER TABLE "sia_calculation" DROP CONSTRAINT IF EXISTS "sia_calculation_revision_chk";--> statement-breakpoint
ALTER TABLE "sia_calculation" ADD CONSTRAINT "sia_calculation_revision_chk" CHECK ("revision" >= 1);--> statement-breakpoint
ALTER TABLE "sia_calculation" DROP CONSTRAINT IF EXISTS "sia_calculation_units_v2_shape_chk";--> statement-breakpoint
ALTER TABLE "sia_calculation" ADD CONSTRAINT "sia_calculation_units_v2_shape_chk" CHECK (
  "basis" = 'minutes_v1'
  OR (
    "paid_units" IS NOT NULL AND "eligible_units" IS NOT NULL AND "truncated_units" IS NOT NULL
    AND ("chc_hourly_rate_cents" IS NOT NULL OR "paid_units" = 0)
    AND "policy" IS NOT NULL AND "visit_outcomes" IS NOT NULL
    AND "paid_units" >= 0 AND "truncated_units" >= 0 AND "eligible_units" >= "paid_units"
    AND jsonb_typeof("visit_outcomes") = 'array'
  )
);--> statement-breakpoint

-- The INSERT guard. SECURITY INVOKER with a pinned search_path and schema-qualified tables (the 1061 convention). `FOR SHARE` on the
-- claim row makes it wait for a concurrent state change and re-read the committed state (READ COMMITTED), exactly like
-- m23_claim_is_deletable(), so a claim cannot be submitted between the check and the insert. The revision must be latest + 1:
-- `appendSiaRevision` computes it in the same statement, and a first row on a claim with none is revision 1.
CREATE OR REPLACE FUNCTION m23_sia_calculation_insert_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_state text;
  v_latest integer;
BEGIN
  SELECT c.state::text INTO v_state FROM public.claim c
   WHERE c.id = NEW.claim_id AND c.organization_id = NEW.organization_id
     FOR SHARE;
  IF v_state IS NULL OR v_state NOT IN ('DRAFT', 'VALIDATING', 'READY') THEN
    RAISE EXCEPTION 'M23_SIA_CLAIM_NOT_MUTABLE: a SIA revision can be added only while the claim is DRAFT, VALIDATING or READY (claim state: %)', COALESCE(v_state, 'not found')
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT COALESCE(MAX(s.revision), 0) INTO v_latest FROM public.sia_calculation s WHERE s.claim_id = NEW.claim_id;
  IF NEW.revision <> v_latest + 1 THEN
    RAISE EXCEPTION 'M23_SIA_REVISION_OUT_OF_ORDER: the next SIA revision of this claim must be % (got %)', v_latest + 1, NEW.revision
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_sia_calculation_insert_guard" ON "sia_calculation";--> statement-breakpoint
CREATE TRIGGER "trg_sia_calculation_insert_guard" BEFORE INSERT ON "sia_calculation"
  FOR EACH ROW EXECUTE FUNCTION m23_sia_calculation_insert_guard();
