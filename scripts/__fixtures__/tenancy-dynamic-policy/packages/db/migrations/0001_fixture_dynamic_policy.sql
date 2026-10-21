-- FIXTURE — intentional violation. A policy built through DYNAMIC SQL inside a `DO` block is one
-- opaque statement to the net-effect pass (`survivingPolicies()`), so Rule 2a cannot follow it —
-- that is the gate's documented known limit, and five real migrations build policies this way.
--
-- The limit must stay a limit on TRACKING and never become a hiding place: this block also carries
-- an `INSERT INTO audit_event`, which is the trigger for Rule 2's audit exemption. If the exemption
-- were reachable here, the `app.user_id` predicate in the policy string below would be exempted by
-- the audit INSERT above it — the file-scoped hole (#22) reproduced one nesting level down.
--
-- So: no statement that BUILDS a policy is exempt. That is blunt — the audit INSERT's own,
-- legitimate attribution GUC is reported too — and it is the safe direction. A migration that needs
-- both should split them into two statements, which is how every real one is already written.
DO $$
BEGIN
  INSERT INTO audit_event (actor_user_id)
  VALUES (NULLIF(current_setting('app.user_id', true), '')::uuid);

  EXECUTE format(
    'CREATE POLICY %I ON fixture_dyn FOR ALL TO chartwarden_app '
    'USING (user_id = NULLIF(current_setting(''app.user_id'', true), '''')::uuid)',
    'fixture_dyn_self'
  );
END $$;
