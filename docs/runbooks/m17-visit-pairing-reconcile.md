# M17 older-visit pairing reconciliation (CW-PI-04)

Operator runbook for `bun run m17:reconcile-visit-pairings`. Nothing here is run by a coding session or CI against
production: the dry-run report and the apply are the operator's steps.

## What it finds

A visit stores the discipline its clinician was scheduled under (`visit.assigned_discipline_at_assignment`). Today's
rules accept a (visit purpose, discipline) pair only when the purpose's discipline gate lists it AND M8 has a legal
encounter pair for it (`isLegalVisitPairing` in `packages/scheduling/src/pairing.ts`). Visits created before those
rules can carry a pair that fails (an NP or MD on a `recert`, `loc_change`, `pronouncement`, `huv1`, `huv2` or `sfv`
visit, a legacy discipline value, and so on). No database CHECK stops them, so detection is a query over `visit`.

Every visit that fails is put in exactly one bucket:

| Bucket | Which visits | What the tool does |
| --- | --- | --- |
| `restamp` | open (`proposed` or `published`), the assignee is an active member, holds, as a live role, and is credentialed on the service date for **exactly one** discipline legal for the purpose (holding other legal disciplines without a credential does not make it ambiguous) | `--apply` corrects only `assigned_discipline_at_assignment` to that discipline |
| `review` | `ASSIGNEE_NOT_ACTIVE` (membership suspended or revoked), `NO_LEGAL_DISCIPLINE_HELD`, `LEGAL_DISCIPLINE_NOT_CREDENTIALED`, `AMBIGUOUS_LEGAL_DISCIPLINES` (two or more legal disciplines both held and credentialed; the policy order is not a tiebreak), `VISIT_IN_PROGRESS` (`en_route`, `in_visit`) | nothing. This is the operator-visible queue: a person reassigns the visit, changes its purpose, fixes the clinician's role or credential, or cancels it through the normal scheduling screens |
| `historical` | `completed`, `cancelled`, `no_show`, `rescheduled` | nothing. The record of what happened is not rewritten |

It never deletes a visit, never moves a visit to another clinician, never changes the purpose or the time, and emits
no outbox event (the assignee did not change). Re-running finds nothing left to restamp; the `review` list is
reported again until a person resolves each item.

Not covered (still open in the register row): recurring policies (the nightly cron already alerts on them), the M8
draft a first publish created, and an `m17.visit.published` event already queued or parked.

## 1. Dry-run report (read only)

```sh
REPORT_DIR=<a directory outside any git checkout, with restricted access>
DATABASE_URL=<chartwarden_app connection string> \
DATABASE_ADMIN_URL=<only to list tenant ids> \
  bun run m17:reconcile-visit-pairings > "$REPORT_DIR/pairing-report.json"
```

The reports hold only ids and codes, but they map visit ids to a finding, so keep them out of the repository and
under the same access as the audit trail. Use a TLS connection string (`sslmode=verify-full` or at least `require`) for any
non-local host. Add `--org <uuid>` (repeatable) to limit to tenants (and no `DATABASE_ADMIN_URL` is needed then). Without `--org` only `active` tenants run; a suspended or closed tenant is
only touched when named. The tool refuses a superuser or BYPASSRLS `DATABASE_URL`: every read runs per tenant
inside `withOrgContext`.

The JSON on stdout has ids and codes only (no names, no clinical text): per tenant `counts`, `restamp` (visit id,
purpose, stamped discipline, discipline it would be set to, visit status), `review` (visit id, reason code) and
`historical`. A stamped value that is not a plain lowercase code (a legacy free-text value) is shown as
`unrecognised`, never echoed.
Top level: `plannedRestamps`, `reviewQueue`, and `exceedsCap` (true when `--apply` would be refused under the cap).
Exit 0.

## 2. Apply checklist

1. Run the dry run (step 1) and read `restamp` and `review`. The default report covers every tenant: before handing
   any `review` ids to a tenant's scheduling lead, re-run with `--org <that tenant's uuid>` (or cut the report to its
   `organizationId`) so nobody receives another tenant's visit ids. Roles, membership status and credentials are read
   when the plan is made; re-run the dry run right before the apply, and keep the apply to one or a few tenants, so
   the plan is not minutes old.
2. Confirm every `restamp` row is one you accept: the clinician keeps the visit; only the stamped discipline changes.
   For each `published` row also check whether an M8 draft or a parked `m17.visit.published` event already exists
   for the visit: the tool does not touch either (see "Not covered"), and once the visit reads legal nothing else
   flags it.
3. Take a restore point (the usual pre-change backup) and confirm no deploy is in flight.
4. Choose the cap. The default is `--max-rows 25`; a plan above the cap is refused whole (nothing written, exit 3).
   Raise it deliberately to at least `plannedRestamps` (ceiling 1000).
5. Apply with your own handle as the operator label (it is self-asserted: the audit actor is the system, so who held
   `DATABASE_URL` is the real attribution; run it from your own logged session):

   ```sh
   bun run m17:reconcile-visit-pairings --apply --operator <label> --max-rows <N> > "$REPORT_DIR/apply-report.json"
   ```

   `--apply` plans again from the live data, it does not replay the dry-run file: compare `applied[].changed` with
   the `restamp` ids you reviewed, and keep `--max-rows` close to the reviewed count. One transaction per tenant; one `m17.visit.pairing_reconciled` audit event per changed visit (control, reason code,
   purpose, run id, operator, before and after discipline code). A visit that changed after the plan was read is
   skipped (`skippedStale`), not overwritten. Exit 1 means a tenant failed: earlier tenants stay committed and
   re-running is safe.
6. Re-run the dry run: `restamp` is empty. Search the audit trail for `m17.visit.pairing_reconciled` with the run id
   (the `correlation_id`) and match its count to `applied[].changed`.
7. Rollback is per visit: the audit event carries the previous discipline code (a legacy free-text value is recorded
   as `unrecognised`; the original is then only in the table's own row-level `visit` update audit event, which has
   the shorter operational retention, so export it first if you may need to undo). A rollback is a manual one-row
   update by an operator with a named approver (the scheduling edit path refuses an illegal pair, so it cannot put
   the old value back); it is covered only by the table's own row-level audit event, not by this tool's cap or
   event. There is no bulk undo.

## Register

CW-PI-04 in `compliance/controls.yaml` stays `partial`: this tool narrows the gap for stored visits; the items under
"Not covered" remain.
