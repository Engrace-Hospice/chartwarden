# Runbook: M36 escalation fallback ("when push fails, who calls whom") and quarterly drills

WP 4.11 of the messaging hub. This is what a person does when ChartWarden cannot get an acknowledgment request in front of a
clinician by itself, and how the agency proves, every quarter, that it can still do that. It is a **template**: every
name, number and rota below is a placeholder the agency fills in (section 4). It contains no patient information and must
never be filled in with any.

> **Messaging is not the emergency path.** A patient in crisis follows the agency's telephone / emergency procedure, not
> this runbook and not a message. This runbook covers the case where an *acknowledgment request* (ADR-0069) is still
> waiting and the system's own routes have not reached anyone.

> **Go-live precondition (OPEN, explicit):** a tenant must not turn on `messaging.ack_requests`, `messaging.urgent_clinical`
> or `messaging.escalation_timers`, and must not use the `important`, `urgent` or `critical_symptom` classes in production,
> until an **out-of-hours watcher** of the unacknowledged queue (and of the operations numbers) is named and signed off by
> the clinical lead. Nothing pages a supervisor's phone today (G-3: the platform side is built, ADR-0079, but no transport exists), and requests sit unseen at night **even when the timers
> are off, which is the default** (the queue and gauges still show them but nobody is told). The creation flags are gated as
> well as the timers because a request that exists with no watcher is the hazard. (`critical_symptom` has no writer today,
> ADR-0069 decision 3 / ADR-0056 D7, so that class is latent until the clinical lead decides who may raise it.) **A further hazard:** a tenant that turns on `messaging.notification_policy` and the timers
> with no vendor transport configured (all environments today) gets every delivery to a verified endpoint failing
> (`transport_not_configured`), so its requests become `failed_unreachable`; the deadline timer does not watch those, but the unreachable watch keeps raising them to the supervisors on a bounded schedule (G-5, ADR-0079), which is a reminder, not a watcher.
> **Drill exception:** a live drill in a test organisation (section 7.4) may switch these flags on for that organisation
> only, with the drill participants acting as the watchers, and the flags are switched off again after the drill; otherwise
> use a separate environment. Who can set these flags per tenant (the tenant, or the platform owner) is not verified here
> and is **OPEN**: confirm before the drill rather than assuming. The clinical lead decides who watches; this is not decided.

Decisions in this document marked **OPEN** are provisional and listed for the clinical lead and operations in
[`brief-clinical-lead-signoff.md` section 13](../messaging-hub/brief-clinical-lead-signoff.md#13-fallback-runbook-and-drills-wp-411---provisional-readings-to-approve-all-open).
Nothing here has been signed off.

## 1. What the product does today (read from the code)

| Fact | Where |
|---|---|
| A request has a class (`important`, `urgent`, `critical_symptom`) with a deadline (provisional 60 / 15 / 5 minutes). States: `pending`, `acknowledged`, `escalated`, `failed_unreachable`, `resolved`, `cancelled`. | ADR-0069; `packages/messaging/src/ack-requests/ack-rules.ts` |
| Only the **assigned user**, signed in and still qualified, can acknowledge or resolve (explicit "Take responsibility" button). Opening or reading never acknowledges. **A supervisor cannot acknowledge or resolve, and there is no "acknowledged by phone" write** (rejected by decision, G-1; ADR-0078 decision 8). | ADR-0069 decision 6, ADR-0078 |
| Reassign by the parties: the current assignee (any open state) or the requester **before the request is taken** (`reassignDenied` in `apps/backend/src/modules/36-messaging/ack-requests/ack-service.ts`). The request card now has a **Reassign** control for exactly those people (`viewer_actions.can_reassign`): a dialog with a colleague picker fed by `GET /api/v1/messaging/escalations/:id/reassign-candidates` (eligible colleagues only, at most 50), calling `POST /api/v1/messaging/escalations/:id/reassign`. Only when the **requester** reassigns must they still hold `messaging.send` and `messaging.urgent.send`. The **new** assignee must be a care-team member who can see the channel, holding `messaging.urgent.receive`, passing the Part 2 gate, not the requester and not the current assignee. Refusals differ: `403 ACK_NOT_PARTY` (caller is neither sender nor assignee), `403 ACK_NOT_ASSIGNEE` (the request is already taken, so the sender can no longer reassign), `403` "You can no longer send response requests" (sender lost the send keys), `403` (caller lacks `messaging.read`), `409 ACK_STATE_INVALID` (request closed, or taken or handed on between read and lock), `404` (caller cannot see the channel), `422 ACK_ASSIGNEE_INVALID` (the new assignee is not acceptable; no reason is given, so try a differently qualified nurse, not the sender or an aide), and a `429` rate-limit refusal (5 per 5 minutes per (actor, colleague) pair, ADR-0069 decision 13). | ADR-0069 decisions 5-6, 13-14; ADR-0078 decision 1 |
| **Supervisor reassign** (ADR-0078): a holder of `messaging.read` and `messaging.review` (the queue's audience) can move a request in status `pending`, `escalated` or `failed_unreachable` to an eligible colleague from the queue (a Reassign button per row; candidates from `GET .../supervisor-reassign-candidates`, then `POST /api/v1/messaging/escalations/:id/supervisor-reassign`). A **reason code is required**, from a fixed non-clinical set (`assignee_unreachable`, `assignee_unable_to_sign_in`, `assignee_off_shift`, `coverage_change`, `workload`, `other_operational`); no free text. It works on restricted rows. The new assignee passes the same checks as above (one uniform `422 ACK_ASSIGNEE_INVALID`); an `acknowledged`, `resolved` or `cancelled` request is `409 ACK_STATE_INVALID` (unless the Part 2 wall below applies first, which always answers with the uniform `422` or an empty list, whatever the state); the reassign uses the same rate limit as other ack writes, and the two candidate lists have their own separate limit; at most **5 supervisor reassigns of one request in 24 hours** (provisional, OPEN), then `409 ACK_SUPERVISOR_REASSIGN_LIMIT`: ask the clinical lead. You cannot name yourself as the new assignee. If the **Part 2 gate walls you off from the patient**, the candidate list is empty and the reassign is refused with the same `422`: ask a person who is admitted, or the clinical lead (OPEN, compliance / Part 2 review). It **only moves** the request: it returns it to `pending`, new window, tier 0, so the timer watches it again, and the history row names the supervisor and the reason code. The new assignee gets the usual reassign alert; the previous assignee and the sender get a generic in-app notice; the supervisor does not. **It does not acknowledge anything:** only the new assignee, signed in as themselves, can take responsibility. It reads no conversation and grants no access to one. | ADR-0078 || The escalation action (next tier at the deadline, early escalation on delivery failure) runs only where the ops flag `messaging.escalation_timers` is on for the tenant (default off). Flag off means requests are left exactly as they are. | ADR-0070, ADR-0071 decision 8 |
| At the deadline the system asks the EscalationRouter (M19 on-call) for the next tier. No tier / no router: the request stays open with its assignee and a `route_unavailable` or `ladder_exhausted` history row; the router is asked again on a backoff (1 h up to 24 h). Production's router is the deny-stub for every organization unless it is listed in `ESCALATION_ROUTER_ORGS`; for a listed organization M19's tier-1 router answers (the on-call RN of the patient's provider entity), and any tier above 1 is `ladder_exhausted` (ADR-0057 item 12; the ADR is still Proposed and the M19 owner is not named). | `apps/backend/src/modules/36-messaging/ack-escalation/escalation-service.ts` (header) |
| When every out-of-band delivery of the request alerts to the assignee has terminally failed, the request escalates now, or becomes `failed_unreachable` (written by the system only). `failed_unreachable` is open, not closed, and the deadline timer **does not watch it** (nothing can escalate it). Instead the per-minute sweep's **unreachable watch** raises it to the supervisors again once its deadline has passed, at most eight times over about 103 hours (four days and a bit) (at the deadline, +1 h, +3 h, +7 h, +15 h, +31 h, +55 h, +79 h; provisional, OPEN), with an ops notice each time, and never writes to the request or sends to the failing transport. Only with `messaging.escalation_timers` on. | ADR-0071 decisions 2-6, ADR-0079 decision 1 |
| Alerts are fixed generic text (no name, patient or message text). `route_unavailable` / `ladder_exhausted` tell the sender and the assignee in-app. The supervisor audience (roles `clinical_supervisor`, `don`; tenants can re-aim the rule `m36.ack.supervisor_attention` in the alert-rule admin) gets ONE in-app **supervisor attention** alert on the first `route_unavailable`, the first `ladder_exhausted`, a `failed_unreachable`, and each unwatched reminder (fixed text, a link to the queue). With `messaging.notification_policy` and `messaging.ack_requests` on and a **verified** endpoint, the request class's platform floor also plans a page to that supervisor; with no vendor transport it fails (`supervisor_page_failed` ops notice). | `apps/backend/src/modules/36-messaging/outbox-consumers/ack-escalation-notifications.ts`, `.../ack-unreachable-notifications.ts`, `.../ack-escalation/supervisor-attention.ts`, `.../ack-escalation/unreachable-watch.ts` |
| Out-of-band copies (push, SMS, email) go only to verified endpoints; a channel with no configured transport fails closed (`transport_not_configured`). Quiet hours never suppress designated safety-critical routes. **Out-of-band delivery is off by default and no vendor transport is configured anywhere today:** the seeded `m36.ack.*` rules are `in_app` only, and a designated out-of-band route needs the flag `messaging.notification_policy` plus the flag of the event's own family (`messaging.ack_requests`, `messaging.urgent_clinical`). So today the in-app inbox and the unacknowledged queue are the only signals; "push has failed" is a scenario for a tenant that has configured a transport. | ADR-0073, ADR-0071 |

## 2. When to invoke this runbook

Invoke when **any** of these is true. Do not wait for several.

1. A push, SMS or email provider is down or degraded (vendor status page, or clinicians report no alerts).
2. A request shows **Could not be delivered** (`failed_unreachable`) in the unacknowledged queue.
3. A request shows the note `ladder_exhausted` (no tier left) or `route_unavailable` (the router could not name anyone).
4. An ops notice fires (section 3), or the overdue gauge is above zero for longer than the response target.
5. A clinician reports a request they were never told about, or a sender reports no one answered.
6. A drill (section 7) is being run.

## 3. Detection signals that exist today

Nothing here pages a clinician. These are signals for a **supervisor** and for **operations**.

| Signal | Audience | Where it is | What it means |
|---|---|---|---|
| Unacknowledged queue | Supervisor (`messaging.read` + `messaging.review`: clinical supervisor, director of nursing, clinical lead) | Screen `/messaging/unacknowledged`; API `GET /api/v1/messaging/escalations/unacknowledged` (filters `status`, `overdue` only narrow; the page states the unfiltered total). Polls every 15 s. | Every `pending`, `escalated` and `failed_unreachable` request of the organisation, oldest deadline first, with `route_unavailable` / `ladder_exhausted` notes, `delivery_failed`, overdue seconds, tier, assignee and the sender's display name ("Sent by"), and a Reassign button per row (supervisor reassign, section 5.3). A `restricted` row (a request the supervisor cannot open) is listed and counted without patient or message. |
| In-app alert "could not be delivered" | Sender, assignee | Alert inbox (rule `m36.ack.failed_unreachable`) | No delivery route reached the assignee; nobody is known to have received it. |
| In-app **supervisor attention** alert | Supervisor audience (`clinical_supervisor`, `don`) | Alert inbox (rule `m36.ack.supervisor_attention`; payload `reason` is `ladder_exhausted`, `route_unavailable`, `failed_unreachable` or `unwatched`) | A request has no human known to be handling it. Raised once per event, and for an unreachable request again on the bounded schedule above. Links to the queue. |
| In-app alert "no one further" | Sender, assignee | Alert inbox (rules `m36.ack.ladder_exhausted`, `m36.ack.route_unavailable`; the supervisors are told by the attention alert) | The deadline passed and no next tier exists or could be named. |
| Gauge `chartwarden_m36_ack_overdue_total` | Operations | `/metrics` on the internal backend port (404 at the production nginx) | Waiting requests past their deadline, all organisations. `-1` means not measured, never zero. |
| Gauge `chartwarden_m36_ack_failed_unreachable_total` | Operations | `/metrics` | Open requests no route could reach. |
| Gauge `chartwarden_m36_ack_oldest_overdue_seconds` | Operations | `/metrics` | Longest-overdue waiting request, any organisation. |
| Gauges `chartwarden_m36_ack_latency_seconds{stat="mean"\|"max"}` and `chartwarden_m36_ack_latency_samples` | Operations | `/metrics` | Time to take responsibility over the trailing 24 h. |
| Gauge `chartwarden_m36_ack_escalation_stalled_seconds` | Operations | `/metrics` | Age past its deadline of the oldest request the escalation sweep should already have handled (overdue, not in its unroutable backoff, tenant flag `messaging.escalation_timers` on). **Above ~300 for a minute or two means the timer and the sweep are not working** (`messaging.ack_escalation_timer`, `messaging.ack_escalation_sweep`), as opposed to nobody answering. `-1` is not measured. |
| Ops notice `m36.ack.queue_overdue` | Operations | Log line `platform-ops notice [...]` plus the `OPS_ALERT_WEBHOOK_URL` webhook, from the per-minute `messaging.ack_escalation_sweep` | A request is 15 minutes or more past its deadline (per organisation; once, then hourly while it lasts, **once across the fleet** when Valkey is reachable, otherwise per process). |
| Ops notice `m36.ack.latency_high` | Operations | Same sink | Mean time to take responsibility is 15 minutes or more (at least 5 samples). |
| Ops notice `m36.ack.failed_unreachable` | Operations | Same sink | A request became `failed_unreachable` (ids and class only). Needs `messaging.escalation_timers` on. |
| Ops notices `m36.ack.route_unavailable`, `m36.ack.ladder_exhausted` | Operations | Same sink | The first such record of a request (ids and class). Needs `messaging.escalation_timers` on. |
| Ops notice `m36.ack.failed_unreachable_unwatched` | Operations | Same sink | An unreachable request is still open past its deadline (one per reminder stage, up to eight). |
| Ops notice `m36.ack.supervisor_unpaged` | Operations | Same sink | A supervisor attention alert planned **no** out-of-band route (flags off, no verified supervisor endpoint, or no supervisor resolved): supervisors were told in-app only. Expected everywhere today. |
| Ops notice `m36.ack.supervisor_page_failed` | Operations | Same sink | A page planned for a supervisor failed on its channel (every environment today: no transport). Delivery id and channel only. |
| Ops notice `m36.ack.escalation_stall_unmeasured` | Operations | Same sink | The stall check could not measure for 3 minutes in a row (platform pool or database unreachable, or an organisation could not be counted): a stalled worker would go unreported meanwhile. |
| Ops notice `m36.ack.escalation_stalled` | Operations | Same sink, from a timer in every backend process (not the sweep) | The stalled gauge has been 5 minutes or more. Once across the fleet, at most hourly. First check the two workers, Valkey and the database (5.2). |

The queue row carries the assignee's id (null on a restricted row) and display name (kept on a restricted row), the **requester's display name** (`requester_display_name`, also kept on a restricted row) and `request_ref`, the request's own id, present on **every** row including restricted ones (`apps/backend/src/modules/36-messaging/routes/unacknowledged-typebox.ts`, `Item`). `request_ref` is the handle the supervisor reassign uses; it opens nothing, and every route that reads a request, a thread or a patient still answers 404 without channel visibility. No requester id and no role class is returned. Showing the requester name and `request_ref` on restricted rows is **OPEN** for compliance / Part 2 review (ADR-0078).

What does **not** exist: Alertmanager rules in the repo (the operator scrapes the gauges and writes their own, see
[`CHARTWARDEN_OPS_RUNBOOK_v0.1.md` section 16.8](../architecture/CHARTWARDEN_OPS_RUNBOOK_v0.1.md)), percentiles, a phone page to a supervisor that can actually be delivered (the platform plans it for a verified endpoint, but **no vendor transport exists**; see G-3 in section 9), a supervisor action to acknowledge or resolve from the queue, and a supervisor way into a
conversation they are not a member of (a supervisor who needs the content asks a channel member or the sender). The window between a request going quiet and a human noticing is therefore the
supervisor looking at the queue or the operator watching the gauges. **OPEN:** who watches either outside office hours.

## 4. The telephone tree (template)

Fill in a private copy kept by the agency (not in this repository, not in a message). The roles are the ones the product
already addresses; the order is **OPEN** (brief section 13).

**Roles**

| Role | Name | Primary number | Backup number |
|---|---|---|---|
| A. Assignee (the clinician the request is on; from the queue row) | `<from the queue row>` | `<on-call roster, M19>` | `<on file>` |
| S. Sender (who raised it; see "Finding the sender" below) | `<from the row's "Sent by">` | `<on file>` | `<on file>` |
| T. Next tier on call for the role (who the system would have escalated to) | `<from the on-call roster>` | `<on file>` | `<on file>` |
| C. Clinical supervisor on duty | `<name>` | `<on file>` | `<on file>` |
| D. Director of nursing | `<name>` | `<on file>` | `<on file>` |
| L. Clinical lead / medical director | `<name>` | `<on file>` | `<on file>` |
| O. Operations on call (platform) | `<name>` | `<on file>` | `<on file>` |

**Sequence by start point.** Wait `<N>` minutes between steps (**OPEN**, provisional 5 for `urgent` and `critical_symptom`, 10 for `important`).

| Start | Order of calls |
|---|---|
| Non-critical classes (`important`, `urgent`): assignee first | A, then S, then T, then C, then D, then L, then O |
| `critical_symptom` (latent today): sender first | S, then A, then T, then C, then D, then L, then O |

Each person is called once; if a person was already reached, skip to the next. **"Sender unknown" is treated exactly like
"sender unreachable"**: skip S and go on.

**Finding the sender.** Read the name from "Sent by" on the queue row; this works on restricted rows too (the name only, never the patient). Then look the person up in the agency's own directory. If the name does not identify a reachable person, treat the sender as unknown.

Rules for the tree:

- Script for A (the assignee): "ChartWarden shows a response request waiting for you; please sign in and open Messages."
- Script for S (the sender): "Your ChartWarden request is still unanswered. Can you reach the assignee, or tell me who else
  should be told?" The supervisor, not the sender, moves the request (section 5.3 step 3); the sender may also reassign it themselves from the card while it is not yet taken.
- Script for T, C, D, L: these people are **not** the assignee and cannot acknowledge the request. Say: "You may be asked
  to take over a ChartWarden request. Please stand by." Never tell them a request is waiting for them unless it has been
  reassigned to them.
- Verify the person by the agency's normal verification procedure.
- Never say a patient name, a diagnosis or message content on the call, and never put them in a text or voicemail.
  **Emergency carve-out (OPEN):** what may be said to summon emergency help (for example giving an address to the
  emergency number) is decided by the sender or the clinical supervisor under the agency's emergency procedure, not by this
  runbook. A restricted row where the sender and assignee are both unreachable gives no patient identity at all, so the
  supervisor cannot summon help from ChartWarden data; the agency's own records and procedure must. **OPEN (brief section 13):**
  also whether a clinician-to-clinician verbal handoff of the content is permitted.
- Call from the agency's own phone system or the numbers on file; never use a number taken from a message.
- If a step reaches voicemail, leave the generic line above and move on; do not wait for a call back. Record each attempt
  on the incident log (section 8).
- A patient who may be in crisis is **not** handled by this tree: the caller follows the agency emergency procedure first.

## 5. Procedure

### 5.1 Supervisor (first 10 minutes)

1. Open `/messaging/unacknowledged`. Note the total, the oldest overdue, and which rows are `failed_unreachable`,
   `ladder_exhausted` or `route_unavailable`. Clear any filter first (filters only narrow).
2. Start the incident log (section 8): time noticed, how, your role.
3. For each affected row, read the assignee, tier and class. A `restricted` row has no link or patient by design; you can
   still see who it is assigned to, who sent it and how late it is. Start the tree for the class (section 4: assignee first for non-critical, sender first for `critical_symptom`).
4. If you cannot tell whether push/SMS/email is down for everyone or just one person, ask operations (5.2) while you
   continue calling; do not wait for the answer.
5. Work the list oldest first, `critical_symptom` before `urgent` before `important`.

### 5.2 Operations

1. Check `chartwarden_m36_ack_overdue_total`, `..._failed_unreachable_total`, `..._oldest_overdue_seconds` and
   `..._escalation_stalled_seconds` on the internal `/metrics` port. If the stalled gauge is above ~300, nothing is
   escalating: check that the backend worker role is running with `DATABASE_PLATFORM_URL`, that Valkey is up, that the
   queues `messaging.ack_escalation_timer` and `messaging.ack_escalation_sweep` (and the DLQ) are moving, and the logs for
   `M36 ack escalation error`; the supervisor then works the queue by hand (5.1) until it clears. A `-1` is "not measured" (no `DATABASE_PLATFORM_URL`, or an organisation could not be counted): treat as
   unknown, not as healthy.
2. If the tenant has a configured transport, check the vendor status pages and the `notification_delivery` failures in the
   logs; a channel with no configured transport fails closed by design (`transport_not_configured`).
3. Tell the supervisor in one line whether any out-of-band channel is configured for the tenant at all (today usually none,
   so the in-app inbox is the only route) and, if one is, whether its vendor is down. Flag rule: **never turn
   `messaging.escalation_timers` off while requests are waiting (`pending`, `escalated` or `failed_unreachable`) without the clinical lead's recorded decision**, and do not
   change any other flag mid-incident unless the clinical lead asks (see 5.6).

### 5.3 Reaching a human and recording that they have it

This is the honest part. **ChartWarden has no write path for "acknowledged by phone".** Only the assigned clinician can mark a
request acknowledged, and only by signing in and pressing "Take responsibility". The supervisor cannot do it for them.
What a supervisor **can** do is move a waiting request to a reachable, qualified clinician, who then takes responsibility in
their own session (supervisor reassign, ADR-0078).

1. Follow the tree for the class (section 4). Reach the **assignee** and ask them to sign in, open Messages and press
   **Take responsibility**. The request becomes `acknowledged` and leaves the queue. That is the system of record.
2. If the assignee cannot be reached, call the **sender** (name from "Sent by"; unknown counts as unreachable) to find a way to
   reach the assignee, or to learn who else is qualified. The sender may reassign from the card themselves while the request is not yet taken.
3. **If the assignee cannot be reached or cannot sign in, the supervisor reassigns.** From the queue row press **Reassign**,
   choose a reachable, qualified colleague from the list (it shows eligible people only), choose the **reason code** that fits
   (`assignee_unreachable`, `assignee_unable_to_sign_in`, `assignee_off_shift`, `coverage_change`, `workload`, `other_operational` or
   `assignee_left_organisation`) and confirm. Then **call the new assignee**: "ChartWarden shows a response request waiting for you; please
   sign in and open Messages." They take responsibility **in their own session**. Notes: it works on a restricted row and on a
   `failed_unreachable` row (the timer watches it again); it is refused for an `acknowledged`, `resolved` or `cancelled`
   request (`409`); a `422` means pick a differently qualified colleague (no reason is given; an empty list or a `422` for every colleague can mean you are walled off from the patient, so ask a person who is admitted, or the clinical lead); a `409` that mentions the clinical lead means this request has been moved by supervisors five times in 24 hours: ask the clinical lead; a `429` means wait and try
   again. Record the reassign in the log (section 8). **The reassign moves the request; it does not close it and does not
   make the supervisor responsible for the patient.** The request stays open until the new assignee takes responsibility.
4. For `important` requests, the supervisor keeps following up every `<N>` minutes (**OPEN**) and **hands up to the
   clinical lead after `<M>` minutes** (**OPEN**) rather than following up without end.
5. For `urgent` requests, the supervisor follows up the same way, **hands up to the clinical lead after `<M2>` minutes**
   (**OPEN**). If the supervisor needs the content, they ask a channel member or the sender (with Part 2 access where it applies); a supervisor who is not a member cannot read the conversation.
6. For `critical_symptom` (latent: no writer today), call the sender first (section 4) and state in the log who owns the
   decision to call 911 / the agency emergency procedure (**OPEN**, provisional: the clinical supervisor on duty, acting on
   the sender's verbal account; they do not wait for ChartWarden). If both the sender and the assignee are unreachable or
   unknown, the supervisor can still reassign to a reachable qualified colleague, but a patient who may be in crisis is the agency emergency procedure's, not ChartWarden's. Whether this is enough for the clinical lead is **OPEN** (brief section 13).
7. A verbal "I've got it" from someone who has **not seen the content in ChartWarden does not close anything**. The request is
   closed only when it is `acknowledged` in the system.
8. Never ask anyone to sign in as someone else or to share a session. Never acknowledge on behalf of another person. No direct database writes, ever.

**G-1, closed by decision (OPEN for the clinical lead to revisit):** an "acknowledged out-of-band on behalf of" action is
rejected because it would weaken the explicit-acknowledgment rule (ADR-0056, ADR-0069 decision 6). The supported path is the
supervisor reassign above. Nothing writes "acknowledged out-of-band" anywhere. Recorded in the brief, section 13.

### 5.4 Degraded-mode behaviour you will see

- Flag `messaging.escalation_timers` off: nothing escalates by itself; the queue and the gauges still show the overdue
  requests. Call from the tree.
- Router is the deny-stub: requests show `route_unavailable`; supervisors are not alerted for that note alone. Watch the
  queue notes.
- `failed_unreachable`: the deadline timer no longer watches the request (ADR-0071 decision 6). A reassign (by the assignee, the sender or a supervisor) re-arms it. A `failed_unreachable` request that nobody reassigns stays unwatched (G-5, open).
- Gauges `-1`: the measurement failed; open the queue directly.
- Outbox or worker stopped: no new alerts or escalations are produced even though requests exist. The queue screen reads
  the database directly, so it remains the source of truth. **OPEN:** the operator's check for a stalled escalation worker
  (queue `messaging.ack_escalation_timer`, sweep `messaging.ack_escalation_sweep`) beyond the existing DLQ alerting.

### 5.5 Stand-down

Stand down when **all** are true: every affected request is actually `acknowledged` in the system (by the assignee, or
after a reassign by the new assignee) or `resolved`, and the queue has no row overdue for the incident's cause; the channel
outage is over or a workaround is communicated; and the gauges read zero or a known, explained number.
**A verbal "I've got it" does not satisfy stand-down.** A request that became `cancelled` (the sender deleted the message,
ADR-0069 decision 10) is **not** accepted silently: stand-down needs the clinical lead's recorded decision that the
cancellation is clinically fine. The alternative to stand-down is a named supervisor who keeps following up (section 5.3
steps 4 and 5, with their hand-up limits) until each request is acknowledged, each follow-up recorded. **OPEN:** who may declare
stand-down (provisional: the supervisor on duty for clinical matters, operations for the technical cause, both recorded).

Record the stand-down time on the incident log, tell the people called that the incident is closed, and start the review.

### 5.6 Rollback

This runbook changes no product code. Its actions do change data (a reassign, which is audited with the supervisor as actor, and in a drill disabling test endpoints), and each is recorded in the log. If the incident was triggered by a
recent change (a flag turned on, a transport configured, a deploy), revert that change through its own runbook. The
messaging flags are all off for every tenant by default; do not turn one on or off during an incident to "see what happens", and never turn `messaging.escalation_timers` off while requests are waiting without the clinical lead's recorded decision.

## 6. Post-incident review checklist

Within `<N>` working days (**OPEN**, provisional 5):

- [ ] Timeline from the incident log: first failure, detection, first human contact, acknowledgment, stand-down.
- [ ] Which signal detected it first (queue, in-app alert, gauge, ops notice, a person's report). If a person's report,
      what was silent?
- [ ] Time to detect, to first human contact and to acknowledgment against the targets (section 7.1).
- [ ] Was any patient affected or any care delayed? If yes, route to the agency's clinical incident process.
- [ ] Were the tree's numbers right and the people reachable? Update the private copy.
- [ ] Was the `OPS_ALERT_WEBHOOK_URL` configured and received? Were the gauges scraped and alerting?
- [ ] Did any step need a capability the product lacks (an automatic page to a supervisor's phone, a way into a
      conversation, acknowledge by phone)? Add it to the open gaps. Was a supervisor reassign used, with which reason code, and did the new assignee take responsibility?
- [ ] Which runbook text was wrong or unclear? Change it in a reviewed commit.
- [ ] Sign-off by the clinical lead and operations; file the record (section 7.5).

## 7. Quarterly drills

A drill is performed **every quarter** (**OPEN**, provisional) as two parts, both recorded. Never use real patient
information; use a synthetic patient and a test channel, or a test organisation.

### 7.1 Targets being measured (all provisional, **OPEN**)

| Measure | Provisional target |
|---|---|
| Time to detect (request stops moving to a human noticing) | 10 minutes |
| Time to first human contact (noticing to someone answering a call) | 10 minutes after detection |
| Time to acknowledgment (request raised to "Take responsibility") | within the request class's deadline plus 15 minutes |

### 7.2 Checklist (each quarter)

- [ ] Date, facilitator and recorder fixed; participants listed by role.
- [ ] Telephone tree reviewed: every number tested by a real call or marked untested; joiners and leavers applied.
- [ ] Supervisors and operations confirm they can open `/messaging/unacknowledged` and `/metrics` (respectively), and that the supervisor sees the Reassign button (needs `messaging.review`).
- [ ] `OPS_ALERT_WEBHOOK_URL` destination confirmed to receive a test post, or its absence recorded.
- [ ] Tabletop done (7.3) and live drill done (7.4), in that order, in the same quarter.
- [ ] Evidence record completed and filed (7.5) within `<N>` working days.
- [ ] Findings turned into actions with owners and dates; last quarter's actions checked.
- [ ] Runbook changes committed.

### 7.3 Tabletop script (about 45 minutes, no system changes)

Participants by role: facilitator, recorder, clinical supervisor, a nurse on call, director of nursing or delegate,
operations. Facilitator reads each inject; the group says out loud what it would do and which screen or number it uses.

1. **Inject 1.** "It is 02:10. An urgent response request was sent to the on-call nurse 20 minutes ago. The queue shows it
   overdue. The tenant has no out-of-band transport configured, so the nurse's only alert was in the app inbox." (A second
   variant: a transport is configured and its vendor is reported down.) Who sees this and how? Walk section 5.1.
2. **Inject 2.** "The row reads Could not be delivered. The nurse's phone does not answer." Walk the non-critical sequence
   (A, then S, then T, C, D, L, O) with the stand-by script for T onward. Find the sender from "Sent by" on the row (also on a
   restricted row); try the case where the name does not identify a reachable person.
3. **Inject 3.** "The nurse answers by phone, is in a car, and cannot sign in." What is the record? Walk 5.3: the supervisor
   reassigns from the queue to a reachable qualified colleague with a reason code and calls them, and the new assignee takes
   responsibility in their own session. State out loud what is not available: acknowledge-by-phone (G-1, rejected by decision)
   and a supervisor's way into the conversation.
4. **Inject 3b.** "The sender and the nurse are both unreachable (or the row is restricted) and the class is critical
   symptom." Who owns the 911 decision? What can be said to summon help? What does the supervisor do when the request cannot
   be moved?
5. **Inject 4.** "The router is the deny-stub; the request says ladder exhausted. The clinical lead is unreachable." Who may
   decide, who stands down?
6. **Inject 5.** "A restricted row appears that you cannot open." What do you do and not do?
7. **Debrief.** Time to detect and to contact as the group estimates them; gaps; actions.

### 7.4 Live drill script (about 60 minutes, test organisation or synthetic data only)

**Test organisation only. A live drill is never run on a production tenant, and never with production patient data.**
Pre-conditions:

- A **test organisation** with a synthetic patient channel and **at least four accounts**: a sender, an assignee, a
  distinct reassign target (a care-team nurse with `messaging.urgent.receive`) and a supervisor with `messaging.read` and `messaging.review`; and
  the tree in place. Note that the test organisation lives **in the production deployment** unless a separate environment is
  used, so the gauges and the webhook below are shared.
- Flags turned on for the test organisation only: `messaging.ack_requests` (to create a request),
  `messaging.urgent_clinical` (for an urgent send), `messaging.escalation_timers` (needed for `failed_unreachable`, early
  escalation and its ops notice) and `messaging.notification_policy`. Who may set them per tenant is **OPEN** (the go-live note at the top); drill participants act as the watchers, and the flags are switched **off again** after the drill.
- **Do not configure or change any transport or vendor credential (Twilio, VAPID, Postmark) for a drill in the production
  deployment.** Transports are deployment-wide, not per organisation. You do not need one: per ADR-0073 a verified endpoint
  with no transport settles `failed` / `transport_not_configured`, and with the timers on the request becomes escalated or
  `failed_unreachable`. That is the failure path under test.
- If a transport happens to be configured already, real SMS or push reaches participants' real phones, so the test
  organisation's supervisor audience (roles `clinical_supervisor`, `don`) must contain only drill participants.

- Operations are warned beforehand: the gauges (`chartwarden_m36_ack_*`) count **all organisations**, and ops notices go to the
  production `OPS_ALERT_WEBHOOK_URL`, so a drill request can look like a real overdue request. Operations tag or exclude the
  drill organisation in their alerting (how: **OPEN**, no organisation label exists on the gauges).

1. First make the assignee's out-of-band route fail. Without a transport only a **push** endpoint can be verified
   (`registerEndpoint` in `apps/backend/src/modules/36-messaging/messaging-route-service-db.ts` marks push verified at
   insert and refuses SMS and email with a 503); SMS and email cannot be verified and nobody may configure a transport to
   change that. Endpoints are self-only (`notifications.endpoint.manage`), so the **test assignee registers a push endpoint
   (any target) in their own session** through the admin screen, not the facilitator. That verified endpoint then fails with
   `transport_not_configured`. Note the endpoint id (id only) at registration: the screen has no list route, so the
   endpoint can be removed only from the session that created it. An assignee with **no** verified endpoint gets no
   out-of-band row at all, which is not a failure and does **not** produce `failed_unreachable` (ADR-0073 decision 4,
   ADR-0071 decision 2). Do not touch any shared vendor or production configuration.
2. Recorder starts the clock. Facilitator raises an `urgent` request (the urgent composer; `important` can only be raised through the API) to that test assignee, who has agreed
   to stay silent for the drill. Note the time of request.
3. Supervisor, who has not been told which request, finds it from `/messaging/unacknowledged`. Recorder notes the time.
4. Operations reads the gauges (or confirms they read `-1`/zero as expected) and any ops notice. Record what fired.
5. Supervisor works the tree from step 1 with a real phone call to the test assignee. Record each attempt and time.
6. Assignee signs in and presses **Take responsibility**. Recorder notes the acknowledgment time and that the request left
   the queue.
7. Repeat once with the assignee unable to sign in. The supervisor calls the assignee and the sender (5.3 steps 1-2), then
   **reassigns from the queue row** to the distinct target account with the reason code `assignee_unable_to_sign_in`, and
   calls the target, who **takes responsibility in their own session**. Record the time of the reassign and of the
   acknowledgment, that the history names the supervisor and the reason code, and that the previous assignee and the sender
   received the generic notice. Nobody may use a borrowed session or write to the database.
8. Close every drill request ("Close this request" / resolve, so none remains `acknowledged`-open) before switching the flags off, and have the test assignee delete their push endpoint from their own session using the noted id. Stand down only when the request is acknowledged in the system; record the time.

### 7.5 Evidence record template

One record per drill, per quarter. Copy this block.

```
Drill evidence record
Quarter / date:                    <YYYY-Qn> / <YYYY-MM-DD>
Type:                              tabletop | live | both
Environment:                       <test organisation | other>   (no production patient data)
Facilitator / recorder (roles):    <role> / <role>
Participants (roles only):         <role>, <role>, ...
Scenario run:                      <inject set / which channels failed>

Timings
  Request raised:                  <hh:mm>
  Detected by:                     <signal> at <hh:mm>      -> time to detect: <mm>
  First human contact:             <hh:mm> (tree step <n>)  -> time to first contact: <mm>
  Reassigned by supervisor:        <hh:mm> reason code <code> (or none needed)
  Acknowledged ("Take responsibility"): <hh:mm>             -> time to acknowledgment: <mm>
  Stand-down:                      <hh:mm>
Targets met (detect / contact / acknowledge): <y/n> / <y/n> / <y/n>

Reassign check:  new assignee took responsibility in own session <y/n>; history names supervisor and reason <y/n>; previous assignee and sender notified <y/n>
Signals observed: queue <y/n>, in-app alert <y/n>, gauges <values or -1>, ops notice <kind or none>, webhook received <y/n>
Tree check: numbers tested <n of n>, wrong or stale <list by step, no numbers>
Findings:                          <numbered>      (no patient data, no phone numbers, no names)
Actions:                           <action> | <owner role> | <due date>   (same rule)
Last quarter's actions closed:     <n of n>
Sign-off:                          clinical lead <role/name> <date>   operations <role/name> <date>
```

**Where it is stored and who owns it: OPEN.** Provisional: the clinical lead owns the record, operations files it in
the agency's compliance evidence store (the contingency-plan evidence of
[`05-clinical-workflows-and-safety.md`](../messaging-hub/05-clinical-workflows-and-safety.md), HIPAA 164.308(a)(7)),
retained for the agency's policy period (six years is the usual HIPAA documentation period; the agency confirms). Not in
this repository: it names roles and dates and must never contain patient information or real phone numbers. The drill
runbook's evidence is what the WP 4.11 acceptance ("tabletop plus live drill recorded as evidence") refers to; **no drill
has been run yet**, so no evidence exists today.

## 8. Incident log (minimal)

Each line: time, who (role), action, outcome, and the **request id (the id only, never a patient or message detail; on a restricted row, which shows no id, use the assignee's role and the requested time)**. The
outcome is chosen from a fixed, non-clinical set: `answered`, `voicemail`, `no answer`, `will sign in by <time>`, `signed in`,
`acknowledged in system`, `passed to <role>`, `reassigned to <role> by supervisor`, `reassigned to <role> by sender`, `follow-up due <time>`,
`stood down`. Free text about what the patient needs or what was agreed clinically does not go in the log.

**Where the log is kept: OPEN** (an approved store chosen by the clinical lead and operations; never a ticket system or a
chat channel, which are not approved for this).

## 9. Open decisions and gaps

- **Go-live precondition:** a named, signed-off out-of-hours watcher before `messaging.ack_requests`, `messaging.urgent_clinical` or `messaging.escalation_timers` is turned on, or the important / urgent / critical classes are used, in production.
- Drill cadence and the targets of 7.1; tree order and the per-step wait; who watches the queue and gauges out of hours;
  who may stand down; evidence owner, place and retention. All **OPEN** (brief section 13).
- **G-1: closed by decision, OPEN for the clinical lead to revisit.** "Acknowledged by phone on behalf of" is rejected: it would weaken the explicit-acknowledgment rule (ADR-0056, ADR-0069 decision 6). The supported path is supervisor reassign (section 5.3). Nothing writes "acknowledged out-of-band".
- **G-2: closed (supervisor reassign built, ADR-0078).** A `messaging.review` holder can reassign a waiting request with a fixed reason code. A supervisor still cannot read a conversation they are not a member of; that stays out of scope (ADR-0076).
- **G-3: platform side built (ADR-0079), the transport is OPEN.** One supervisor attention alert (rule `m36.ack.supervisor_attention`) is raised in-app for the first `route_unavailable`, the first `ladder_exhausted`, a `failed_unreachable` and each unwatched reminder; with `messaging.notification_policy` and `messaging.ack_requests` on it also plans the request class's platform floor (push; push + SMS for critical) to each supervisor's **verified** endpoint. **Nothing rings today:** no vendor transport is configured in any environment, so a planned page fails and raises `supervisor_page_failed`; with no page planned, `supervisor_unpaged` says supervisors were told in-app only. Ops notices now exist for `route_unavailable` and `ladder_exhausted` too. **OPEN (clinical lead):** who is paged (role set `clinical_supervisor` + `don`, re-aimable by the tenant), whether an on-call supervisor or a second level is wanted. **OPEN (operations):** choose and configure a transport; verify supervisors' endpoints; route `OPS_ALERT_WEBHOOK_URL` to a person. A tenant that re-aimed the old `ladder_exhausted` / `failed_unreachable` rules keeps that row, so it may now receive **two** alerts for one event, and must re-aim `m36.ack.supervisor_attention` too; nothing detects a tenant row that re-aims or disables the attention rule (`supervisor_unpaged` only says no page was planned), so audit the tenant alert-rule admin at go-live. Supervisors are told on the first record of each unroutable type only; later `route_unavailable` / `ladder_exhausted` records go to the sender and the assignee alone.
- **G-4: built (ADR-0079), thresholds OPEN.** Seeded rule `m36.ack.supervisor_attention`; the gauge `chartwarden_m36_ack_escalation_stalled_seconds` and the `escalation_stalled` ops notice (a timer in every backend process, not the sweep, so a dead sweep is reported; threshold 5 minutes, provisional); the ops notices are claimed once across the fleet through Valkey (per process when Valkey is unreachable). Still open: Alertmanager rules in the repo (the operator writes them), who receives the ops webhook, and the threshold. The stalled gauge cannot say which of the two queues is dead. **Enabling `messaging.escalation_timers` on an organisation with an old overdue backlog raises a stalled notice until the sweep has worked through it** (expected; the sweep takes at most 500 requests per minute per organisation). The watchdog can itself be blind: three consecutive unmeasured minutes raise `m36.ack.escalation_stall_unmeasured`, and a gauge of `-1` means the same.
- **G-5: closed by a bounded watch (ADR-0079), the schedule is OPEN.** A request moved by a reassign (including a supervisor's) is watched by the deadline timer again. A `failed_unreachable` request that nobody reassigns is raised to the supervisors by the unreachable watch at its deadline and then at +1 h, +3 h, +7 h, +15 h, +31 h, +55 h and +79 h (eight in all, then only the queue and the gauges show it). It is never escalated automatically (the database forbids it and it is a clinical decision) and nothing is sent to the failing transport. **OPEN (clinical lead):** the cadence and cap, and whether such a request should ever escalate by itself.
- **G-6: closed.** The request card has a Reassign control for the assignee (any open state) and the sender (until taken), fed by the reassign-candidates read (ADR-0078).
- **G-7: closed.** The queue row carries the requester's display name (also on restricted rows) and `request_ref`; no role class (judged not cheap, not built). **OPEN (compliance / Part 2 review):** the requester name, `request_ref` and the candidate lists' colleague names are disclosed on rows the supervisor cannot open.
