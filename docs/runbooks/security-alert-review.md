# Runbook: security alerts and the review of the audit trail (CW-MON-01)

Operator and security-officer runbook. The audit trail (M4) records what happened; since CW-MON-01 a scheduled job **reviews** it, raises
an alert for each finding, and writes down that it did. This is how it runs, what to configure, how to read the review log, and what to
do for each alert. Control: `compliance/controls.yaml` CW-MON-01 (HIPAA §164.308(a)(1)(ii)(D) information-system activity review,
§164.308(a)(5)(ii)(C) log-in monitoring; SOC 2 CC7.2, CC7.3). Code: `packages/audit/src/review/`,
`apps/backend/src/modules/04-audit/jobs/security-review-job.ts`.

## 1. What runs

- **Queue `audit.security_review`, every 15 minutes**, in the worker process (the M4 audit workers; an API-only replica does not
  run them). It needs the platform database login (`DATABASE_PLATFORM_URL`); without it the boot log says
  `M4 audit workers disabled` and **nothing is reviewed**. One run per scope at a time (a database advisory lock): a second replica
  or an overlapping tick skips that scope.
- **Two lanes per run.**
  - *Platform lane* (once): the sign-in events written before an organization is known (`m2.auth.login_failed`,
    `m2.auth.account_locked`, `m2.auth.login_succeeded`). They are org-less rows no tenant context can read, so they are read under an
    audited platform context (job id `m4.security_review`; every entry is a `platform.bypass_invoked` audit row).
  - *Org lane* (every active or suspended organization): that organization's own events, under its own tenant context. A closed
    organization is not reviewed, and neither is the tenant-offboarding shred event (written against an organization being closed).
- **Each run** reads what happened since the last clean review, evaluates the rules (`SECURITY_RULES`), raises every **new** finding
  once, and appends the review record. "Once" means: not the exact finding already raised (a fingerprint of rule + subject + trigger
  event), and, for a pattern rather than a single event, not the same rule and subject again within **one hour** of an alert for it.
  A sustained attack therefore alerts about once an hour per subject, not once per run.
- **Bounded, not prevented.** At most 10 individual alerts of one rule and 50 in all per run (so decoys minted for one rule cannot
  crowd out another); any further new findings are rolled into **one** `review.alert_flood` alert (counted in the run's
  `suppressed`), which itself pages at most about once an hour. This throttles rather than drops: a finding still inside the one-hour
  look-back is raised by a later run, and an older one survives only as the `suppressed` count and in the audit log. An attacker who
  can mint findings can still keep the destination busy at the cap; they cannot pin the cursor. Delivery is one alert at a time, most
  severe first, and stops at the first failed delivery or after 30 seconds. A destination that permanently rejects one alert (an HTTP
  4xx) therefore holds the alerts behind it until it is fixed: the job fails loudly each run meanwhile.
- **A run that could not deliver an alert** (a failed delivery, or the stop above) is recorded `delivery_failed`, does not move the
  cursor, and fails the BullMQ job. The next run tries the rest again; what was delivered is not repeated. The job failure raises the
  DLQ notice, **which uses the same webhook**: when the destination itself is down, what remains is the failed-job log and the audit
  record, so watch for failed jobs as well as for alerts. A worker that was down resumes where it stopped, up to one day back; a
  longer gap is recorded as `catchUpCapped` **and** raised as a `review.incomplete_scan` alert, not hidden.
- Delivery happens inside the run's database transaction (the scope's lock has to span it). If anything after a delivery fails, the
  transaction rolls back and the next run sends that alert again: delivery is **at least once**, and `correlationId` is the alert's
  fingerprint so a receiver can drop a repeat.
- **The first run of a scope reviews the previous 24 hours**, so enabling it can raise a burst of alerts for events already in the log.

## 2. Configuration

Nothing here is applied by the code change; an operator sets it.

| Setting | What it does |
|---|---|
| `OPS_ALERT_WEBHOOK_URL` | The destination, **the same variable the DLQ and platform-ops notices use**. It must be **https** (plain http only to the loopback): anything else is a loud *failed* delivery that sends nothing. Each alert is one `POST` of `{ kind: "security_alert", summary, details, correlationId, occurredAt }`. A `2xx` is *delivered*; any other status (a redirect included: redirects are refused), or a 5 s timeout, is *failed* and retried by the next run. |
| *(unset)* | The alert is still logged (`🔒 security alert [...]`) and recorded with `delivery: no_destination`, the run is `ok`, and the boot log warns once. **That is not monitoring**: no human is told, and those alerts are never re-sent once a webhook is set. Production must set the webhook. |
| `DATABASE_PLATFORM_URL` | Required (see above). The platform login holds **no SELECT on `audit_event`** (migration 1566 removed the column grant of 1561; migration 1582 took the audit.archive functions, which return closed months in full and can detach one, off the platform login too: section 7): the org-less lane reads the sign-in events through three SECURITY DEFINER readers, `m4_review_platform_signals`, `m4_review_platform_cursor` and `m4_review_platform_raised_alerts`, and the platform carrier needs EXECUTE on them (the migration grants it where the carrier exists, and `bun run db:provision-roles` grants it on every run). Check: `SELECT has_function_privilege('chartwarden_platform', 'public.m4_review_platform_cursor()', 'EXECUTE');` is true and `SELECT has_any_column_privilege('chartwarden_platform', 'audit_event', 'SELECT');` is false. **What the readers return:** the org-less `m2.auth.login_failed`, `.account_locked` and `.login_succeeded` rows as an id, an instant, the event type, an actor id and three context keys (`userId`, `ipPrefix`, `emailHash`), plus the cursor and five alert keys of the review's own org-less records: never a tenant's row, never free text. **Bounds:** a window of at most 25 hours, no older than 48 hours and at most 20 001 rows (the alert memory: 48 hours, 10 000 rows); a call outside them is refused with SQLSTATE 22023, so the platform lane fails loudly rather than reading less than it thinks. The readers' owner, `chartwarden_audit_reviewer`, is NOLOGIN and row security admits it org-less rows only. **If the platform lane fails with 42501** either the EXECUTE grant is missing (run `bun run db:provision-roles`) or an older release is running against a database that already has migration 1566 (it still selects `audit_event` directly: roll the release forward). **With 22023** one of the bounds above was exceeded: a review constant (`MAX_CATCH_UP_MS`, `MAX_SIGNAL_ROWS`) or a platform rule's window was raised past it (the alert memory reaches back `MAX_CATCH_UP_MS` + the widest rule window + the one-hour alert cooldown, which must stay within 48 hours), a platform rule was added on an event type other than the three sign-in events, or the app host's clock is more than ten minutes ahead of the database's. Raise the bound in a new migration, or fix the clock; the unit test `security-review-reader.test.ts` fails first when the constants and the migration drift. |

`details` is the alert and nothing else: rule id, severity, counts, ISO window, event ids, a subject *reference* (a user id, a /24
network prefix, or the first 12 characters of a credential hash), the organization id, and the runbook anchor. No name, note, patient or
free text. Open the sample event ids in the audit log for the rest. (The 12 characters of a credential hash are the start of an
unsalted SHA-256 of the email address: they let a reader correlate with the trail, but a reader who can guess the address can confirm
it. Treat the destination as workforce-confidential, like the audit log.)

**Open decisions (owner: security officer; not made by the code):**

1. **Which production destination reaches a human** (an on-call paging channel, not a log or an unwatched channel), and a test alert sent
   to it once it exists. **Set and test it before the change that enables this deploys**: alerts raised while it is unset are recorded
   `no_destination` and never re-sent, and the first run reviews the previous 24 hours. Record the receiver in the BAA register
   (CW-BA-01): its vendor and whether a BAA or a "PHI-free metadata only" decision covers it (an alert carries organization and user
   ids, a /24 prefix and a short credential-hash reference, no PHI).
2. **Who reviews, and who covers them.** Name the reviewer(s) and the backup, and the response time per severity (suggested:
   `critical` within the hour, `warn` the same business day).
3. **Whether security alerts get their own channel** apart from ops notices (today they share `OPS_ALERT_WEBHOOK_URL`).
4. **Where a disposition is recorded** (the ticket id of each alert, keyed by `fingerprint`) so the weekly review below has an outcome
   to read.

## 3. Reading the review log

Two audit event types (retained 7 years). An organization's rows are sealed by the audit hash chain when it is enabled for that
organization; the **org-less platform-lane rows are in no seal** (the chain is per organization), so that lane's evidence is the
append-only table and the database's own controls, not a tamper-evident chain:

- `m4.security_review.completed`: one per scope per run. `context`: `status` (`ok` / `delivery_failed`), `lane`, `windowFrom`,
  `windowTo`, `eventsScanned`, `findings`, `newAlerts`, `delivered`, `failed`, `noDestination`, `deferred`, `suppressed`,
  `scanTruncated`, `overlapTruncated`, `bulkTruncated`, `catchUpCapped`, `rulesVersion`. Its `windowTo` is the next run's cursor.
- `m4.security_review.alert_raised`: one per alert. `context`: `ruleId`, `subject`, `count`, `windowFrom`, `windowTo`,
  `sampleEventIds`, `fingerprint`, `delivery` (`delivered` / `failed` / `no_destination`).

In product: the audit log search (`GET /api/v1/audit/events?eventType=m4.security_review.alert_raised`) shows an organization's rows to
its `audit.read` holders. The org-less (platform) rows are visible to platform operators with database access:

```sql
-- the weekly review: did every scope get reviewed, and did every alert go out? Per organization, so one scope going dark is
-- not hidden among the others (organization_id is NULL for the platform lane).
SELECT date_trunc('day', created_at) AS day, organization_id, context->>'lane' AS lane,
       count(*) FILTER (WHERE context->>'status' = 'ok')              AS ok_runs,
       count(*) FILTER (WHERE context->>'status' <> 'ok')             AS failed_runs,
       count(*) FILTER (WHERE (context->>'catchUpCapped')::boolean)   AS catch_up_capped,
       count(*) FILTER (WHERE (context->>'scanTruncated')::boolean
                           OR (context->>'overlapTruncated')::boolean
                           OR (context->>'bulkTruncated')::boolean)   AS read_cap_hit,
       sum((context->>'newAlerts')::int)                              AS alerts,
       sum((context->>'noDestination')::int)                          AS no_destination,
       sum((context->>'suppressed')::int)                             AS suppressed
  FROM audit_event
 WHERE event_type = 'm4.security_review.completed' AND created_at > now() - interval '7 days'
 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3;
```

**Weekly review (the HIPAA "regular review" evidence).** Once a week the named reviewer: (a) confirms each lane shows about 96 `ok` runs
a day **per organization** (a scope with none is the signal) and explains any `failed_runs`, `catch_up_capped` or `read_cap_hit`; (b) checks `no_destination` is zero in production (anything
else means alerts went nowhere) and looks at `suppressed`; (c) opens every `alert_raised` of the week and confirms a disposition
exists; (d) records that they did it. Step (d) is a human record: the code does not hold it.

## 4. Responding by rule

Open the `sampleEventIds` in the audit log first. A rule fires on a pattern, so a fire is a question to ask, not proof of an attack.

<a id="auth.brute_force_by_network"></a>
### auth.brute_force_by_network (warn)
15 failed sign-ins or lockouts from one /24 in 10 minutes (the throttle refuses at 30 per address). Check whether the prefix is the
organization's own office or a VPN (a shared network, many users). If not, block the prefix at the edge and look for
`auth.brute_force_by_account` or `auth.distributed_attack_on_account` against the same accounts.

<a id="auth.brute_force_by_account"></a>
### auth.brute_force_by_account (warn)
10 failures plus lockouts against one credential in 10 minutes: the attacker kept going after the account's 5-failure budget was
spent. The subject is the first 12 characters of the credential hash; match it to `emailHash` in the sample events. Contact the user
out of band; reset the password if the account may be exposed.

<a id="auth.distributed_attack_on_account"></a>
### auth.distributed_attack_on_account (critical)
One credential failed from 3 or more networks in 10 minutes: credential stuffing. Treat as an attack on that account: force a password
reset and a second-factor check, review its recent sign-ins (`auth.rapid_origin_change`) and its session activity.

<a id="auth.rapid_origin_change"></a>
### auth.rapid_origin_change (warn)
One user signed in from 3 or more networks within an hour. **This is a proxy for impossible travel, not a distance check**: the trail
holds /24 prefixes, not places, so a phone moving between Wi-Fi and mobile data can fire it. Ask the user; if they cannot account for
it, revoke their sessions and reset the credential.

<a id="access.break_glass_invoked"></a>
### access.break_glass_invoked (critical)
Emergency access was invoked in the organization. Break-glass must be co-signed after the fact: confirm the co-signature happens
(`m3.breakglass.cosigned`) and that the clinical reason fits. The tenant's compliance officer is also paged in-app by the M36 consumer
(GAP-010); this alert is the second line.

<a id="access.privilege_escalation_blocked"></a>
### access.privilege_escalation_blocked (critical)
Someone tried to grant a role beyond their own and was refused. Find the actor in the sample event, ask why, and review what else they
touched in that window.

<a id="access.authorization_denial_burst"></a>
### access.authorization_denial_burst (warn)
One user was refused 10 times in 15 minutes. Denials are **sampled**, so the real count is higher. Usually a mis-scoped role or a
broken integration; a person walking the application for access looks the same, so check what they were refused.

<a id="access.bulk_record_access"></a>
### access.bulk_record_access (warn)
One user read or had disclosed 100 or more distinct records in a 15-minute bucket (fixed buckets: a burst split across a bucket edge
counts half in each, so the real number can be higher). A census-style task (an audit, a report) is the benign cause. Otherwise treat
as possible exfiltration: confirm the user's role needs that reach, and review their other activity.

<a id="access.auditor_session_activated"></a>
### access.auditor_session_activated (warn)
An external auditor completed enrolment and holds a read-only session. Confirm an engagement is live and the auditor is expected.

<a id="access.second_factor_disabled"></a>
### access.second_factor_disabled (warn)
A user turned off their authenticator. Confirm with the user; an attacker with a stolen session removes the second factor first.

<a id="export.request_burst"></a>
### export.request_burst (warn)
Three or more audit exports requested by one user within an hour. Only exports that leave an audit event are visible (today the audit
export); a module that audits its own export adds its event type to this rule.

<a id="privileged.role_grant_burst"></a>
### privileged.role_grant_burst (warn)
One user assigned 10 or more roles in 15 minutes. Bulk onboarding is the benign cause; otherwise review who received which role.

<a id="privileged.mass_deactivation"></a>
### privileged.mass_deactivation (critical)
One user deactivated 5 or more accounts in 15 minutes. Offboarding a team is the benign cause; otherwise treat as sabotage and
reinstate (`m2.membership.reinstated`) while you investigate.

<a id="destructive.data_destruction_approved"></a>
### destructive.data_destruction_approved (critical)
A destruction certificate was approved. Destruction is irreversible: confirm the retention class and that no legal hold
applies (CW-DS-01) before the executor runs, while there is still time to hold the certificate. (The tenant-offboarding shred is not
reviewed here: it is recorded against an organization that is being closed.)

<a id="integrity.audit_chain_mismatch"></a>
### integrity.audit_chain_mismatch (critical)
The sealed audit hash chain no longer verifies: the log was altered out of band. This is a security incident (CW-IR-01). Preserve the
database and open the integrity run (`audit_integrity_run`) named in the M36 alert.

### Alerts about the review itself

<a id="review.alert_flood"></a>
#### review.alert_flood (critical)
More new findings than one run raises (10 of one rule, 50 in all): the first were raised one by one, and this alert stands for the rest
(`count`). Something is producing findings in volume, most likely an attack on the sign-in endpoint (many accounts or networks failing
at once) or a mass change by one administrator. Findings still inside the one-hour look-back are raised by the next runs; any older
one survives only as the run's `suppressed` count and in the audit log. Open the window in the audit log, triage by event type and
subject, and consider blocking at the edge. This alert itself repeats at most about once an hour.

<a id="review.incomplete_scan"></a>
#### review.incomplete_scan (warn)
The review could not read everything it should have. `subject.ref` lists why: `forward_truncated` (the new-events read hit its row cap:
nothing is skipped yet, the next run continues from the last row read, but the review is **falling behind real time**, and a day
behind it starts dropping events, see `catch_up_capped`), `overlap_truncated` (the look-back read hit its row cap, so the oldest
look-back rows were dropped and a burst that began long before the previous run may have been missed), `bulk_truncated` (more
bulk-access buckets crossed the threshold than the aggregate returns), `catch_up_capped` (the worker was down more than a day, and the older part of the gap was not reviewed),
`cursor_stepped` (the read cap was filled by rows stamped in one millisecond, so the cursor stepped past the rest of them). Review the
window in the audit log by hand for what the rule would have caught.

## 5. Adding a detection (how other controls reuse this)

A control that needs "alert when this audit event happens" adds **one entry** to `SECURITY_RULES`
(`packages/audit/src/review/rules.ts`) and one section above; no job, queue, sink or wiring change:

- **`always`**: any event of these types is an alert (a policy changed, a certificate approved).
- **`burst`**: N events for one subject (actor, network, account) within a window (chained overrides, repeated grants).
- **`distinct`**: N distinct values for one subject within a window.
- Set `lane: "org"` for tenant events. List the register control in `controls`.

Tests enforce the rest: every rule's event types are in the action catalog, each rule gets a positive and a negative fixture generated
from its own definition, and every rule id needs an anchor in this file. The control's row in `compliance/controls.yaml` then drops
"no alert (CW-MON-01 is a gap)" and cites the rule id. Examples ready to add once those controls name the event:
`m8.encounter.closure_policy_changed` (CW-AC-48, `always`, org), `m8.encounter.closure_override_granted` (CW-AC-48 chained grants,
`burst` per actor), `m8.encounter.draft_policy_changed` (CW-AC-49, `always`, org).

## 6. Stated limits

- **The review's own state is audit rows.** Its cursor (`m4.security_review.completed`) and its memory of what it already raised
  (`alert_raised`) are rows in the audit trail, so a writer of the trail (code running in the app pool, or someone with database write
  access) can forge them: a forged `alert_raised` suppresses that alert, and a forged `completed` row stamped "reviewed up to just
  now" skips the gap before it. The cursor is clamped (a row stamped in the future is ignored, and `windowTo` is held to a few minutes
  past the row's own time, so a "reviewed up to next week" row cannot blind the review) but a forgery that looks like a real run
  cannot be told from one. That needs compromise first; the weekly review (per-organization run counts) is how a silent scope shows.
  The advisory lock is likewise takeable by any database role: a held lock makes a scope skip (the job logs each skip but stays green).
- A second-factor removal (`m2.auth.2fa_disabled`) by a session with no bound organization is written org-less, which neither lane
  reads for that event type; only one made inside an organization session alerts.

- Impossible travel is a network-change proxy (section 4), not geolocation; a true check needs a geo source.
- Cross-tenant access attempts return 404 by design and leave no audit event, so there is nothing to alert on.
- Only exports that write an audit event are seen by `export.request_burst`; bulk reads are covered by `access.bulk_record_access`.
- Review runs every 15 minutes: an alert reaches the destination within one run of the event, not instantly.
- The sign-in rules count the network prefix the auth bridge records (a /24 or /48). An address it cannot parse is recorded as
  `unknown` and is ignored by the rules; an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is recorded as one shared prefix, which would
  pool every such client, so the backend is expected to see plain IPv4 addresses (it listens on `0.0.0.0`). Fixing `ipPrefixOf` for
  mapped addresses is a one-line follow-up in the auth package.
- Reads are row-capped (20,000 new rows and 5,000 look-back rows per scope per run, and one shared cap across the rule event types),
  so a flood of one event type can crowd out another within a run. The caps are recorded and raised (`review.incomplete_scan`), not silent.
- Suspended organizations are reviewed; closed ones, and the tenant-offboarding shred event, are not.
- Dispositions and the weekly review are human records outside the code (section 2, decision 4).

## 7. Applying the held contract migrations (1566 and 1582)

Two migrations of this control are **contract** migrations, so `deploy.sh` holds them for an operator (exit 75, before any schema change, previous release
untouched). They apply together, in one run, in filename order:

- **1566** removes the platform login's `audit_event` column grant and adds the three bounded readers (the platform lane of the review, section 2).
- **1582** gives the audit.archive functions (`audit_archive_candidates`, `audit_archive_read_batch`, `audit_archive_detach`: a closed audit month read whole,
  and detached) a duty role of their own, `chartwarden_audit_archiver`, and removes EXECUTE on them from every other role (the platform carrier and login, the
  tenant pool, PUBLIC). The monthly job runs on its own login, `chartwarden_audit_archive_login`, through `DATABASE_AUDIT_ARCHIVE_URL` on the worker.

Nothing needs draining; the order matters:

0. **Only where the archive is on** (`AUDIT_ARCHIVE_BUCKET` is set in `.env.production`): add `CHARTWARDEN_AUDIT_ARCHIVE_PASSWORD` (a secret, at least 16 characters, URL-safe:
   letters, digits and `. _ ~ -`, the provisioner refuses anything else; `openssl rand -hex 24` does) to `.env.production` before the re-run in step 2. The compose file hands it to the `provision` step, which creates the login, and builds the worker's
   `DATABASE_AUDIT_ARCHIVE_URL` from it. Where the archive is off, leave it unset: nothing is provisioned and the job stays a skip. Set the bucket without it and the
   job **fails** (`AUDIT_ARCHIVE_CREDENTIAL_MISSING`: the queue retries and the DLQ alert fires); it never skips quietly and never borrows the platform pool.
1. Merge and let the deploy run: it stops at the hold and the previous release keeps serving, its platform lane and archive job still working (the grants are still there).
2. Apply the migrations by hand with the **new** release's image, without `--hold-contract` (the command is in the hold message), and **re-run the deploy straight away**.
   Until the new release is serving: the previous release's platform lane fails each tick (42501), loudly and with nothing recorded (the cursor holds and the next run
   resumes from it; the org lanes are not affected), and its audit.archive job, if it runs (monthly, `30 3 2 * *`, and only with a bucket set), fails with 42501 before it
   reads or detaches anything and is retried. Avoid applying across 03:30 UTC on the 2nd. Every provision run cuts the archive login's open sessions (a deploy, not only a
   rotation), so the same applies to any deploy at that hour: the job's detach is one transaction, so it rolls back and the retry resumes, loudly.
3. The re-run's provision step grants EXECUTE on the 1566 readers and revokes the old column grant again, revokes the archive functions from the platform carrier and
   login again, creates (or rotates) the archive login when `CHARTWARDEN_AUDIT_ARCHIVE_PASSWORD` is set (a rotation cuts that login's open sessions), and **refuses to
   finish** if the platform login can still execute one of the three archive functions (a PUBLIC grant or a membership it does not know of). Check as a superuser:
   `SELECT has_function_privilege('chartwarden_platform_login', 'public.audit_archive_read_batch(text, uuid, integer)', 'EXECUTE');` is false for each of the three
   functions, and `SELECT pg_has_role('chartwarden_platform_login', 'chartwarden_audit_archiver', 'MEMBER');` is false; `chartwarden_audit_archive_login` is the role's only member
   (section 2's two queries cover the 1566 side).
4. Do not roll back to the previous release after the migrations (its platform lane reads `audit_event` directly and its archive job runs on the platform pool; both would
   fail): roll forward. If the re-run fails after the migrations were applied by hand, `deploy.sh` may restore the previous release itself (the schema change it can see is
   empty, so it counts as safe to restore); that release's platform lane and archive job then fail until a re-run succeeds, so re-run until it does.
5. To rotate the archive credential, re-run the provisioner with a new `CHARTWARDEN_AUDIT_ARCHIVE_PASSWORD` and update the worker's env (compose does both from the one
   variable). To disable the login, run it with `CHARTWARDEN_AUDIT_ARCHIVE_REVOKE=true`: removing the password from `.env.production` only stops this deploy creating or rotating it, an
   already provisioned login keeps working with its old password. With the archive on, the worker warns at boot when the URL is missing, and the job fails at its next run.

**If the archive job fails:** `AUDIT_ARCHIVE_CREDENTIAL_MISSING` means the worker has no `DATABASE_AUDIT_ARCHIVE_URL` (step 0). 42501 from the archive login means the login is
not a member of `chartwarden_audit_archiver` (re-run the provisioner with the password) or an older release is running against a migrated database (roll forward).

**Stated limits.** The archive functions are still owned by the account that ran the migrations (the `postgres` superuser in production): detaching a partition needs
ownership of `audit_event`, and reading every tenant's closed month needs BYPASSRLS, so a non-login owner would first have to own the audit trail; that is not done here.
The separation is at the database login, not the process or the container: `.env.production` is loaded (`env_file`) into every service that reads it (api, worker,
hl7-listener, migrate, provision, tenant-buckets, seed-runner), so a password put there is in the environment of each of them, the tenant-facing `api` included, exactly as
`CHARTWARDEN_PLATFORM_PASSWORD` already is. Code that can read the environment of one of those containers can build the archive login's URL and call the functions; what is
removed is the path through the platform login and the platform pool, not the path through a leaked environment. Delivering the password only to `provision` and the worker
(a secret file read through `CHARTWARDEN_AUDIT_ARCHIVE_PASSWORD_FILE` and a matching `_FILE` for the URL) would narrow that and is not built. A database superuser, or whoever
holds the migration credential, can still call the functions.
The job still detaches only with `AUDIT_ARCHIVE_DETACH=true`. None of the functions writes an audit row of its own (`audit_archive_detach`, `audit_archive_read_batch`,
`audit_archive_candidates`): the job's `platform.bypass_invoked` row (critical, org-less, a job id and a fixed reason, no partition or row count) is the only record of a run,
and a call made straight through the archive login leaves none. "Fails loudly" means the queue retries and the DLQ alert fires; that alert reaches a person only where
`OPS_ALERT_WEBHOOK_URL` is set (section 2), and the first signal of a missing credential is the boot warning, then the run on the 2nd of the month.
