-- `trg_tenant_step_up_tighten_only` — the at-rest half of M2 §4.3.2 / D9's tighten-only invariant.
--
-- THE OBJECT THIS CREATES HAS BEEN ASSERTED IN CODE SINCE M2-T05 AND NEVER EXISTED.
-- `apps/backend/src/modules/02-identity/policy/step-up-resolver.ts` said, of the app-layer
-- resolution: "the DB `trg_tenant_step_up_tighten_only` trigger is the at-rest guard; this is its
-- app-layer twin." It appeared in exactly that one comment and in none of the 210 migrations.
-- Migration 0006, which created the table, is where the deferral was recorded: "the spec further
-- restricts WRITES to compliance_officer/org_admin and adds a tighten-only trigger (§3.7, D9); those
-- are authorization concerns that wire in with Module 3". Module 3 landed; the trigger did not.
--
-- WHAT THE FLOOR IS. `STEP_UP_POLICY` (packages/types/src/policy/step-up-policy.ts) is the platform
-- floor: `qualifyingFactors = ['webauthn','totp']` and `defaultMaxAgeSec = 300`. SMS is deliberately
-- absent — it is the D2 accessibility fallback and its strength (no proof of possession, SIM-swap
-- exposed) is below what step-up requires. A tenant may make an operation HARDER than this. It may
-- not make one easier, and it may not quietly try: a loosening row is REFUSED here rather than
-- accepted-and-ignored, because a tenant that believes it configured a control and did not is worse
-- off than one that got an error.
--
-- DUPLICATION, DELIBERATELY. The floor now exists twice — once in TypeScript, once in this function.
-- That is the same trade migration 0110 made for M20's `SAFETY_POLICY_BOUNDS` band CHECKs, and the
-- reason is the same: a constraint that must hold against a direct SQL write cannot live in the app.
-- The drift is guarded by a live test that DERIVES its cases from `STEP_UP_POLICY` (raise the TS
-- floor to 600 and the "601 is refused" assertion fails against this function's 300), so the two
-- cannot part company silently.
--
-- WHY A TRIGGER AND NOT A CHECK. Both would enforce it. The trigger is what the code has been
-- promising by name, and it can say WHICH knob was loosened and what the floor is — a CHECK
-- violation names only the constraint, and this is a message an org administrator reads while
-- trying to configure a security control.
--
-- The UNIQUE index is a correctness fix the resolver needs, not decoration: nothing constrained
-- (organization_id, operation_key), so two rows for one operation were legal and "which policy
-- applies" was decided by whichever the planner returned first. For a security control that is not
-- an acceptable answer.
CREATE UNIQUE INDEX IF NOT EXISTS "tenant_step_up_override_org_operation_uq"
  ON "tenant_step_up_policy_override" ("organization_id", "operation_key");--> statement-breakpoint

CREATE OR REPLACE FUNCTION wardenx_tenant_step_up_tighten_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  -- The platform floor, mirroring STEP_UP_POLICY. Keep in step with @chartwarden/types.
  floor_factors  text[] := ARRAY['webauthn','totp'];
  floor_max_age  integer := 300;
  extra_factors  text[];
BEGIN
  -- A factor the floor does not carry cannot be added by a tenant (this is the SMS case).
  SELECT array_agg(f) INTO extra_factors
  FROM unnest(NEW.qualifying_factors::text[]) AS f
  WHERE f <> ALL (floor_factors);

  IF extra_factors IS NOT NULL THEN
    RAISE EXCEPTION
      'step-up policy override may only TIGHTEN the platform floor: factor(s) % are not in the floor set %',
      extra_factors, floor_factors
      USING ERRCODE = 'check_violation';
  END IF;

  -- An EMPTY qualifying set makes the operation unsatisfiable by any session. That is a lockout, not
  -- a tightening, and it is far more likely to be a mistake than an intent.
  IF array_length(NEW.qualifying_factors, 1) IS NULL THEN
    RAISE EXCEPTION
      'step-up policy override must qualify at least one factor from the platform floor %',
      floor_factors
      USING ERRCODE = 'check_violation';
  END IF;

  -- A LONGER freshness window is a loosening: it lets a staler step-up satisfy the ceremony.
  IF NEW.max_age_sec > floor_max_age THEN
    RAISE EXCEPTION
      'step-up policy override may only TIGHTEN the platform floor: max_age_sec % exceeds the floor of % seconds',
      NEW.max_age_sec, floor_max_age
      USING ERRCODE = 'check_violation';
  END IF;

  -- A non-positive window would expire every step-up the instant it was performed.
  IF NEW.max_age_sec <= 0 THEN
    RAISE EXCEPTION 'step-up policy override max_age_sec must be positive (got %)', NEW.max_age_sec
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER "trg_tenant_step_up_tighten_only"
  BEFORE INSERT OR UPDATE ON "tenant_step_up_policy_override"
  FOR EACH ROW EXECUTE FUNCTION wardenx_tenant_step_up_tighten_only();
