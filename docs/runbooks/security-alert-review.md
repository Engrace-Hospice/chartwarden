# Runbook: security alerts and the review of the audit trail (CW-MON-01)

Operator and security-officer runbook. The audit trail (M4) records what happened; since CW-MON-01 a scheduled job **reviews** it, raises
an alert for each finding, and writes down that it did. This is how it runs, what to configure, how to read the review log, and what to
do for each alert. Control: `compliance/controls.yaml` CW-MON-01 (HIPAA §164.308(a)(1)(ii)(D) information-system activity review,
§164.308(a)(5)(ii)(C) log-in monitoring; SOC 2 CC7.2, CC7.3). Code: `packages/audit/src/review/`,
`apps/backend/src/modules/04-audit/jobs/security-review-job.ts`.

## 1. What runs

- **Queue `audit.security_review`, every 15 minutes**, in the API worker set (the M4 audit workers). It needs the platform database
  login (`DATABASE_PLATFORM_URL`); without it the boot log says `M4 audit workers disabled` and **nothing is reviewed**.
- **Two lanes per run.**
  - *Platform lane* (once): the sign-in events written before an organization is known (`m2.auth.login_failed`,
    `m2.auth.account_locked`, `m2.auth.login_succeeded`). They are org-less rows no tenant context can read, so they are read under an
    audited platform context (job id `m4.security_review`; every entry is a `platform.bypass_invoked` audit row).
  - *Org lane* (every active organization): that organization's own events, under its own tenant context.
- **Each run** reads what happened since the last clean review, evaluates the rules (`SECURITY_RULES`), raises every **new** finding
  once (a fingerprint of rule + subject + trigger event stops a repeat), and appends the review record.
- **A run that could not deliver an alert** is recorded `delivery_failed`, does not move the cursor, and fails the BullMQ job (so the
  DLQ alert fires too). The next run tries the same alerts again. A worker that was down resumes where it stopped, up to one day back
  (the cap is recorded as `catchUpCapped`, not hidden).

## 2. Configuration

Nothing here is applied by the code change; an operator sets it.

| Setting | What it does |
|---|---|
| `OPS_ALERT_WEBHOOK_URL` | The destination, **the same variable the DLQ and platform-ops notices use** (https). Each alert is one `POST` of `{ kind: "security_alert", summary, details, correlationId, occurredAt }`. A `2xx` is *delivered*; any other status or a 5 s timeout is *failed* and retried by the next run. |
| *(unset)* | The alert is still logged (`🔒 security alert [...]`) and recorded with `delivery: no_destination`, the run is `ok`. **That is not monitoring**: no human is told. Production must set the webhook. |
| `DATABASE_PLATFORM_URL` | Required (see above). The platform carrier needs `SELECT` on six `audit_event` columns (`id, created_at, organization_id, actor_user_id, event_type, context`): migration 1558 grants it where the carrier exists, and `bun run db:provision-roles` re-grants it. Check: `SELECT has_column_privilege('chartwarden_platform', 'audit_event', 'event_type', 'SELECT');` |

`details` is the alert and nothing else: rule id, severity, counts, ISO window, event ids, a subject *reference* (a user id, a /24
network prefix, or the first 12 characters of a credential hash), the organization id, and the runbook anchor. No name, note, patient or
free text. Open the sample event ids in the audit log for the rest.

**Open decisions (owner: security officer; not made by the code):**

1. **Which production destination reaches a human** (an on-call paging channel, not a log or an unwatched channel), and a test alert sent
   to it once it exists.
2. **Who reviews, and who covers them.** Name the reviewer(s) and the backup, and the response time per severity (suggested:
   `critical` within the hour, `warn` the same business day).
3. **Whether security alerts get their own channel** apart from ops notices (today they share `OPS_ALERT_WEBHOOK_URL`).
4. **Where a disposition is recorded** (the ticket id of each alert, keyed by `fingerprint`) so the weekly review below has an outcome
   to read.

## 3. Reading the review log

Two audit event types (retained 7 years, sealed by the hash chain with everything else):

- `m4.security_review.completed`: one per scope per run. `context`: `status` (`ok` / `delivery_failed`), `lane`, `windowFrom`,
  `windowTo`, `eventsScanned`, `findings`, `newAlerts`, `delivered`, `failed`, `noDestination`, `deferred`, `scanTruncated`,
  `catchUpCapped`, `rulesVersion`. Its `windowTo` is the next run's cursor.
- `m4.security_review.alert_raised`: one per alert. `context`: `ruleId`, `subject`, `count`, `windowFrom`, `windowTo`,
  `sampleEventIds`, `fingerprint`, `delivery` (`delivered` / `failed` / `no_destination`).

In product: the audit log search (`GET /api/v1/audit/events?eventType=m4.security_review.alert_raised`) shows an organization's rows to
its `audit.read` holders. The org-less (platform) rows are visible to platform operators with database access:

```sql
-- the weekly review: did every scope get reviewed, and did every alert go out?
SELECT date_trunc('day', created_at) AS day, context->>'lane' AS lane,
       count(*) FILTER (WHERE context->>'status' = 'ok')              AS ok_runs,
       count(*) FILTER (WHERE context->>'status' <> 'ok')             AS failed_runs,
       count(*) FILTER (WHERE (context->>'catchUpCapped')::boolean)   AS catch_up_capped,
       count(*) FILTER (WHERE (context->>'scanTruncated')::boolean)   AS truncated,
       sum((context->>'newAlerts')::int)                              AS alerts
  FROM audit_event
 WHERE event_type = 'm4.security_review.completed' AND created_at > now() - interval '7 days'
 GROUP BY 1, 2 ORDER BY 1, 2;
```

**Weekly review (the HIPAA "regular review" evidence).** Once a week the named reviewer: (a) confirms each lane shows about 96 `ok` runs
a day and explains any `failed_runs`, `catch_up_capped` or `truncated`; (b) opens every `alert_raised` of the week and confirms a
disposition exists; (c) records that they did it. Step (c) is a human record: the code does not hold it.

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
A destruction certificate was approved or certified. Destruction is irreversible: confirm the retention class and that no legal hold
applies (CW-DS-01) before the executor runs, while there is still time to hold the certificate.

<a id="integrity.audit_chain_mismatch"></a>
### integrity.audit_chain_mismatch (critical)
The sealed audit hash chain no longer verifies: the log was altered out of band. This is a security incident (CW-IR-01). Preserve the
database and open the integrity run (`audit_integrity_run`) named in the M36 alert.

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

- Impossible travel is a network-change proxy (section 4), not geolocation; a true check needs a geo source.
- Cross-tenant access attempts return 404 by design and leave no audit event, so there is nothing to alert on.
- Only exports that write an audit event are seen by `export.request_burst`; bulk reads are covered by `access.bulk_record_access`.
- Review runs every 15 minutes: an alert reaches the destination within one run of the event, not instantly.
- Dispositions and the weekly review are human records outside the code (section 2, decision 4).
