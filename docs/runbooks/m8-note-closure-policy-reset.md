# Runbook: undo a mistaken visit-note closure `block` policy (M8, ADR-0113)

Operator and administrator runbook. A tenant that sets the closure policy to `block` (or sets a short threshold) refuses every
non-allowlisted route to a clinician whose oldest open visit note is past its deadline. If that was a mistake, or it is locking out
people who must work, this is how to put the tenant back to `warn` or `off`, who can do it, and what to do when the people who can are
themselves locked out. Design: [ADR-0113](../adr/ADR-0113-visit-note-closure-clock.md) (D4, D6, D7).

The default is `warn` (banner and alerts, nothing refused), so this only matters for a tenant that chose `block`. A tenant in `off` or
`warn` is never refused anything, and a clinician with no overdue note is never refused.

## 1. The in-product reset (do this first)

**Who can.** A holder of `encounter.closure_policy_admin`: the director of nursing (`director_of_nursing`, `don`), the organization
administrators (`org_admin`, `administrator`) and platform `superadmin`. NOT `clinical_supervisor` or `clinical_lead`. The
**Note Closure Policy** screen (`/admin/closure-policy`, Admin group) appears for exactly those holders.

**How.**

1. Open **Note Closure Policy**. It shows the stored mode and the threshold in hours.
2. Set the mode to `warn` (the banner and alerts stay, nothing is refused) or `off` (the engine is disabled for the tenant), and
   save. Saving asks for a fresh step-up: re-authenticate when asked and the save completes.
3. The same change by API: `PUT /api/v1/encounters/closure-policy` with `{ "mode": "warn", "thresholdHours": 24 }`, a fresh step-up
   (an `Idempotency-Key` is optional on this route); an AI principal is refused. Leaving `block` clears `enforce_from`; moving to `block` again later starts a
   fresh grace window from that moment, so notes that are already overdue are not blocked by the switch itself.

**When it takes effect.** On the replica that served the PUT at once (its policy cache is invalidated); on every other replica within the
policy cache lifetime, 5 seconds. A clinician refused a moment ago is let through on their next request after that. The change is
audited: the route writes `m8.encounter.closure_policy_changed` (previous and new mode and threshold, severity warn), and the table's row
trigger records the row change.

**A policy admin who is blocked themselves cannot do this.** The closure policy routes are deliberately NOT on the gate's allowlist: a
blocked administrator must not be able to lift their own block by switching the policy off. An organization administrator who authors no
visit notes is never blocked, so the usual case is that an `org_admin` does the reset. If the only holders available are themselves
blocked (a director of nursing with overdue notes), see section 2.

## 2. Every policy admin is blocked

The policy routes stay refused (403 `NOTE_CLOSURE_REQUIRED`) for a blocked caller. There are two in-product ways out, then a database
fallback:

1. **Close the notes.** A blocked clinician can always finish their notes: the routes that select, finalize and sign a note, the
   read-only chart and the safety routes stay open. Once the oldest overdue note is signed (and any other past its deadline), the
   next request is no longer refused and the policy screen works. This is the cheapest fix and needs nobody else.
2. **Get released by a clear supervisor.** A supervisor (`clinical_supervisor`, `director_of_nursing`, `don`, `clinical_lead`) who has
   NOTHING of their own past its block instant, and who is not themselves under someone else's override (an override holder is not fit to
   release others, ADR-0113 D7), grants the blocked policy admin a time-boxed override (1 to 24 hours, with a reason) from the
   **Overdue Notes** board. A site-scoped supervisor can release only a clinician whose oldest open note is at their own sites or
   has no site; a supervisor whose scope is organization-wide can release anyone. The override lifts only the block, not the alerts or
   the deadline; the released policy admin can then change the policy. Releasing is itself audited (`m8.encounter.closure_override_granted`).
3. **Database fallback (platform operations only).** If neither of the above is possible (every supervisor is blocked too, nobody can
   close a note in time, and the tenant is stopped), a platform operator changes the stored policy directly. This is an audited privileged
   path: open a change ticket first and have a second person read the statement before it runs. Use the
   application role under the tenant's own context so row-level security and the audit trigger apply, never a superuser that bypasses
   them. The shape, with synthetic placeholders (never paste real ids into a ticket's public text):

   ```sql
   BEGIN;
   SELECT set_config('app.org_id',         '11111111-1111-4111-8111-111111111111', true); -- the tenant's organization id
   SELECT set_config('app.user_id',        '22222222-2222-4222-8222-222222222222', true); -- the operator's own user id
   SELECT set_config('app.correlation_id', 'closure-policy-reset-CHG-0000',        true); -- the change ticket
   UPDATE documentation_obligation_policy
      SET mode = 'warn',
          enforce_from = NULL,                          -- a mode that is not block never keeps a grace instant
          configured_by_user_id = '22222222-2222-4222-8222-222222222222',
          updated_at = now()
    WHERE organization_id = '11111111-1111-4111-8111-111111111111'
      AND obligation_kind = 'visit_note';
   -- expect: UPDATE 1 (a tenant that never wrote a policy has no row and is already warn / 24 hours: nothing to change)
   COMMIT;
   ```

   What it leaves behind: the `documentation_obligation_policy.update` audit row (the table's trigger, with the operator as actor and
   the correlation id) carrying the before and after rows. It does NOT write `m8.encounter.closure_policy_changed` (that event belongs to
   the route), so the ticket and the correlation id are the operator's own record of why. Replicas pick the change up within 5 seconds;
   there is no cache to flush by hand. Then ask the tenant's administrator to review the policy on the screen, so the stored row and
   the screen agree.

## 3. Check it worked

- As a previously refused clinician: any non-allowlisted request is no longer 403 `NOTE_CLOSURE_REQUIRED`, and the shell banner no
  longer shows the blocked state.
- `GET /api/v1/encounters/closure-policy` (a policy admin) shows the mode you set and `enforceFrom: null` for `warn` / `off`.
- The audit trail holds the change: `m8.encounter.closure_policy_changed` for the in-product path, `documentation_obligation_policy.update`
  for either.

## 4. What this does not do

- It does not close anyone's notes or clear an alert; the clock keeps running and the alerts (at risk, overdue, escalated) keep going in
  `warn`. Only `off` silences them.
- It does not touch an override already granted; an active override simply stops mattering when nothing blocks. Revoke one from the
  board if it should end sooner.
- It does not undo a deploy. Moving back to the previous release leaves the clock columns and the policy rows in place (they are
  harmless to it); see the notes on migration 1516 in ADR-0113 D5 for the alert rules.
