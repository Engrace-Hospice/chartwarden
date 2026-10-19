# Runbook: M36 escalation fallback ("when push fails, who calls whom") and quarterly drills

WP 4.11 of the messaging hub. This is what a person does when WardenX cannot get an acknowledgment request in front of a
clinician by itself, and how the agency proves, every quarter, that it can still do that. It is a **template**: every
name, number and rota below is a placeholder the agency fills in (section 4). It contains no patient information and must
never be filled in with any.

> **Messaging is not the emergency path.** A patient in crisis follows the agency's telephone / emergency procedure, not
> this runbook and not a message. This runbook covers the case where an *acknowledgment request* (ADR-0069) is still
> waiting and the system's own routes have not reached anyone.

Decisions in this document marked **OPEN** are provisional and listed for the clinical lead and operations in
[`brief-clinical-lead-signoff.md` section 13](../messaging-hub/brief-clinical-lead-signoff.md#13-fallback-runbook-and-drills-wp-411---provisional-readings-to-approve-all-open).
Nothing here has been signed off.

## 1. What the product does today (read from the code)

| Fact | Where |
|---|---|
| A request has a class (`important`, `urgent`, `critical_symptom`) with a deadline (provisional 60 / 15 / 5 minutes). States: `pending`, `acknowledged`, `escalated`, `failed_unreachable`, `resolved`, `cancelled`. | ADR-0069; `packages/messaging/src/ack-requests/ack-rules.ts` |
| Only the **assigned user**, signed in and still qualified, can acknowledge or resolve (explicit "Take responsibility" button). Opening or reading never acknowledges. **There is no supervisor override and no "acknowledged by phone" write.** | ADR-0069 decision 6 |
| Reassign: the current assignee (any open state) or the requester (until the request is taken). | ADR-0069 decision 6 |
| The escalation action (next tier at the deadline, early escalation on delivery failure) runs only where the ops flag `messaging.escalation_timers` is on for the tenant (default off). Flag off means requests are left exactly as they are. | ADR-0070, ADR-0071 decision 8 |
| At the deadline the system asks the EscalationRouter (M19 on-call) for the next tier. No tier / no router: the request stays open with its assignee and a `route_unavailable` or `ladder_exhausted` history row; the router is asked again on a backoff (1 h up to 24 h). Production's router is a deny-stub until M19 binds one (ADR-0057 is still Proposed). | `ack-escalation/escalation-service.ts` header |
| When every out-of-band delivery of the request alerts to the assignee has terminally failed, the request escalates now, or becomes `failed_unreachable` (written by the system only). `failed_unreachable` is open, not closed, and the deadline timer **stops watching it**. | ADR-0071 decisions 2-6 |
| Alerts are fixed generic text (no name, patient or message text). `route_unavailable` / `ladder_exhausted` tell the sender and the assignee in-app; `ladder_exhausted` and `failed_unreachable` also reach the supervisor audience (roles `clinical_supervisor`, `don`; tenants can re-aim in the alert-rule admin) **in-app only**. | `outbox-consumers/ack-escalation-notifications.ts`, `ack-unreachable-notifications.ts` |
| Out-of-band copies (push, SMS, email) go only to verified endpoints; a channel with no configured transport fails closed (`transport_not_configured`). Quiet hours never suppress designated safety-critical routes. | ADR-0073, ADR-0071 |

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
| Unacknowledged queue | Supervisor (`messaging.read` + `messaging.review`: clinical supervisor, director of nursing, clinical lead) | Screen `/messaging/unacknowledged`; API `GET /api/v1/messaging/escalations/unacknowledged` (filters `status`, `overdue` only narrow; the page states the unfiltered total). Polls every 15 s. | Every `pending`, `escalated` and `failed_unreachable` request of the organisation, oldest deadline first, with `route_unavailable` / `ladder_exhausted` notes, `delivery_failed`, overdue seconds, tier and assignee. A `restricted` row (a request the supervisor cannot open) is listed and counted without patient or message. |
| In-app alert "could not be delivered" | Supervisor audience, sender, assignee | Alert inbox (rule `m36.ack.failed_unreachable`) | No delivery route reached the assignee; nobody is known to have received it. |
| In-app alert "no one further" | Sender, assignee, supervisor audience | Alert inbox (rule `m36.ack.ladder_exhausted`; `m36.ack.route_unavailable` omits the supervisors) | The deadline passed and no next tier exists or could be named. |
| Gauge `wardenx_m36_ack_overdue_total` | Operations | `/metrics` on the internal backend port (404 at the production nginx) | Waiting requests past their deadline, all organisations. `-1` means not measured, never zero. |
| Gauge `wardenx_m36_ack_failed_unreachable_total` | Operations | `/metrics` | Open requests no route could reach. |
| Gauge `wardenx_m36_ack_oldest_overdue_seconds` | Operations | `/metrics` | Longest-overdue waiting request, any organisation. |
| Gauges `wardenx_m36_ack_latency_seconds{stat="mean"\|"max"}` and `wardenx_m36_ack_latency_samples` | Operations | `/metrics` | Time to take responsibility over the trailing 24 h. |
| Ops notice `m36.ack.queue_overdue` | Operations | Log line `platform-ops notice [...]` plus the `OPS_ALERT_WEBHOOK_URL` webhook, from the per-minute `messaging.ack_escalation_sweep` | A request is 15 minutes or more past its deadline (per organisation; repeats at most hourly while it lasts; per process). |
| Ops notice `m36.ack.latency_high` | Operations | Same sink | Mean time to take responsibility is 15 minutes or more (at least 5 samples). |
| Ops notice `m36.ack.failed_unreachable` | Operations | Same sink | A request became `failed_unreachable` (ids and class only). Needs `messaging.escalation_timers` on. |

What does **not** exist: Alertmanager rules in the repo (the operator scrapes the gauges and writes their own, see
[`WARDENX_OPS_RUNBOOK_v0.1.md` section 16.8](../architecture/WARDENX_OPS_RUNBOOK_v0.1.md)), percentiles, an ops notice for
`ladder_exhausted` or `route_unavailable` on their own (only the overdue notice and gauge catch them), an automatic page
to a supervisor's phone, a supervisor action to reassign or acknowledge from the queue, and a supervisor way into a
conversation they are not a member of. The window between a request going quiet and a human noticing is therefore the
supervisor looking at the queue or the operator watching the gauges. **OPEN:** who watches either outside office hours.

## 4. The telephone tree (template)

Fill in a private copy kept by the agency (not in this repository, not in a message). The roles are the ones the product
already addresses; the order is **OPEN** (brief section 13).

| Step | Role (placeholder) | Name | Primary number | Backup number | Calls whom next if no answer in `<N>` minutes |
|---|---|---|---|---|---|
| 0 | Sender of the request | `<on file>` | `<on file>` | | Supervisor on duty |
| 1 | The assignee (the clinician the request is on) | `<from the queue row>` | `<on-call roster, M19>` | `<on file>` | Step 2 |
| 2 | Next tier on call for the role (the person the system would have escalated to) | `<from the on-call roster>` | `<on file>` | `<on file>` | Step 3 |
| 3 | Clinical supervisor on duty | `<name>` | `<on file>` | `<on file>` | Step 4 |
| 4 | Director of nursing | `<name>` | `<on file>` | `<on file>` | Step 5 |
| 5 | Clinical lead / medical director | `<name>` | `<on file>` | `<on file>` | Step 6 |
| 6 | Operations on call (platform) | `<name>` | `<on file>` | `<on file>` | Escalate per the DR/BCP contact list |

Rules for the tree:

- The caller states only: "WardenX shows a response request waiting for you; please sign in and open Messages." Never
  read out a patient name, a diagnosis or message content on the phone line to confirm identity beyond the agency's
  normal verification. Never put them in a text or voicemail.
- Call from the agency's own phone system or the numbers on file; never use a number taken from a message.
- Each unanswered step waits `<N>` minutes (**OPEN**, provisional 5 for `critical_symptom` and `urgent`, 10 for `important`)
  and the caller writes the time of each attempt on the incident log (section 8).
- If a step reaches voicemail, leave the generic line above and move on; do not wait for a call back.
- A patient who may be in crisis is **not** handled by this tree: the caller follows the agency emergency procedure first.

## 5. Procedure

### 5.1 Supervisor (first 10 minutes)

1. Open `/messaging/unacknowledged`. Note the total, the oldest overdue, and which rows are `failed_unreachable`,
   `ladder_exhausted` or `route_unavailable`. Clear any filter first (filters only narrow).
2. Start the incident log (section 8): time noticed, how, your role.
3. For each affected row, read the assignee, tier and class. A `restricted` row has no link or patient by design; you can
   still see who it is assigned to and how late it is. Call the assignee (tree step 1).
4. If you cannot tell whether push/SMS/email is down for everyone or just one person, ask operations (5.2) while you
   continue calling; do not wait for the answer.
5. Work the list oldest first, `critical_symptom` before `urgent` before `important`.

### 5.2 Operations

1. Check `wardenx_m36_ack_overdue_total`, `..._failed_unreachable_total`, `..._oldest_overdue_seconds` on the internal
   `/metrics` port. A `-1` is "not measured" (no `DATABASE_PLATFORM_URL`, or an organisation could not be counted): treat as
   unknown, not as healthy.
2. Check the provider status pages for the push/SMS/email vendors and the `notification_delivery` failures in the logs; a
   channel with no configured transport fails closed by design.
3. Tell the supervisor in one line whether the outage is channel-wide. Do not change flags in the middle of the incident
   unless the clinical lead asks (see 6).

### 5.3 Reaching a human and recording that they have it

This is the honest part. **WardenX has no write path for "acknowledged by phone".** Only the assigned clinician can mark a
request acknowledged, and only by signing in and pressing "Take responsibility". The supervisor cannot do it for them.

So the sequence is:

1. Reach the assignee by phone. Ask them to sign in and open Messages. If they can, they open the request and press
   **Take responsibility**; the request becomes `acknowledged` and drops out of the queue. That is the system of record.
2. If the assignee cannot sign in but can act (no signal for the app, device lost): the requester can **reassign** (until
   the request is taken) to a clinician who can, or the assignee can reassign it; the new assignee signs in and takes
   responsibility. Reassigning restarts the window and re-arms the timer.
3. If a human has verbally taken responsibility and no one can do either: the **incident log is the only record** until
   someone with access signs in. Write the time, who, by what means, and what they agreed to do. Do not close or hide the
   request. It stays in the queue as overdue, which is the truth.
4. Never ask anyone to sign in as someone else or to share a session. Never acknowledge on behalf of another person.

**OPEN gap (G-1):** an audited "acknowledged out-of-band by `<person>` on behalf of `<assignee>`" action for a supervisor.
It is not built; it needs a clinical-lead decision first (it weakens the explicit-action rule of ADR-0056) and a new
transition and permission. Recorded in the brief, section 13.

### 5.4 Degraded-mode behaviour you will see

- Flag `messaging.escalation_timers` off: nothing escalates by itself; the queue and the gauges still show the overdue
  requests. Call from the tree.
- Router is the deny-stub: requests show `route_unavailable`; supervisors are not alerted for that note alone. Watch the
  queue notes.
- `failed_unreachable`: the deadline timer no longer watches the request (ADR-0071 decision 6). A reassign re-arms it.
- Gauges `-1`: the measurement failed; open the queue directly.
- Outbox or worker stopped: no new alerts or escalations are produced even though requests exist. The queue screen reads
  the database directly, so it remains the source of truth. **OPEN:** the operator's check for a stalled escalation worker
  (queue `messaging.ack_escalation_timer`, sweep `messaging.ack_escalation_sweep`) beyond the existing DLQ alerting.

### 5.5 Stand-down

Stand down when **all** are true: the queue has no row that is overdue for the incident's cause; every affected request
is `acknowledged`, `resolved` or `cancelled`, or has a named human who took responsibility; the channel outage is over or
a workaround is communicated; and the gauges read zero or a known, explained number. **OPEN:** who may declare stand-down
(provisional: the supervisor on duty for clinical matters, operations for the technical cause, both recorded).

Record the stand-down time on the incident log, tell the people called that the incident is closed, and start the review.

### 5.6 Rollback

There is nothing to roll back in the product: this runbook changes no flag or data. If the incident was triggered by a
recent change (a flag turned on, a transport configured, a deploy), revert that change through its own runbook. The
messaging flags are all off for every tenant by default; do not turn one on or off during an incident to "see what happens".

## 6. Post-incident review checklist

Within `<N>` working days (**OPEN**, provisional 5):

- [ ] Timeline from the incident log: first failure, detection, first human contact, acknowledgment, stand-down.
- [ ] Which signal detected it first (queue, in-app alert, gauge, ops notice, a person's report). If a person's report,
      what was silent?
- [ ] Time to detect, to first human contact and to acknowledgment against the targets (section 7.1).
- [ ] Was any patient affected or any care delayed? If yes, route to the agency's clinical incident process.
- [ ] Were the tree's numbers right and the people reachable? Update the private copy.
- [ ] Was the `OPS_ALERT_WEBHOOK_URL` configured and received? Were the gauges scraped and alerting?
- [ ] Did any step need a capability the product lacks (acknowledge by phone, supervisor reassign, a way into a
      conversation)? Add it to the open gaps.
- [ ] Which runbook text was wrong or unclear? Change it in a reviewed commit.
- [ ] Sign-off by the clinical lead and operations; file the record (section 7.4).

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
- [ ] Supervisors and operations confirm they can open `/messaging/unacknowledged` and `/metrics` (respectively).
- [ ] `OPS_ALERT_WEBHOOK_URL` destination confirmed to receive a test post, or its absence recorded.
- [ ] Tabletop done (7.3) and live drill done (7.4), in that order, in the same quarter.
- [ ] Evidence record completed and filed (7.5) within `<N>` working days.
- [ ] Findings turned into actions with owners and dates; last quarter's actions checked.
- [ ] Runbook changes committed.

### 7.3 Tabletop script (about 45 minutes, no system changes)

Participants by role: facilitator, recorder, clinical supervisor, a nurse on call, director of nursing or delegate,
operations. Facilitator reads each inject; the group says out loud what it would do and which screen or number it uses.

1. **Inject 1.** "It is 02:10. An urgent response request was sent to the on-call nurse 20 minutes ago. The queue shows it
   overdue. The push provider is reported down." Who sees this and how? Walk section 5.1.
2. **Inject 2.** "The row reads Could not be delivered. The nurse's phone does not answer." Walk the tree steps 1-3.
3. **Inject 3.** "The nurse answers by phone, is in a car, and cannot sign in." What is the record? Walk 5.3 and state the
   gap out loud.
4. **Inject 4.** "The router is the deny-stub; the request says ladder exhausted. The clinical lead is unreachable." Who may
   decide, who stands down?
5. **Inject 5.** "A restricted row appears that you cannot open." What do you do and not do?
6. **Debrief.** Time to detect and to contact as the group estimates them; gaps; actions.

### 7.4 Live drill script (about 60 minutes, test organisation or synthetic data only)

Pre-conditions: a test organisation with the messaging flags the drill needs turned on **by its owner in the test
environment**, never on a production tenant without the clinical lead's written approval; a synthetic patient channel;
two test accounts; the tree in place.

1. Recorder starts the clock. Facilitator raises an `important` or `urgent` request to a test assignee who has agreed to
   stay silent for the drill, note the time of request.
2. Facilitator disables the assignee's push/SMS/email endpoints in the test organisation (or uses an assignee with no
   verified endpoint), so the out-of-band routes fail as in an outage. Do not touch any shared vendor or production
   configuration.
3. Supervisor, who has not been told which request, finds it from `/messaging/unacknowledged`. Recorder notes the time.
4. Operations reads the gauges (or confirms they read `-1`/zero as expected) and any ops notice. Record what fired.
5. Supervisor works the tree from step 1 with a real phone call to the test assignee. Record each attempt and time.
6. Assignee signs in and presses **Take responsibility**. Recorder notes the acknowledgment time and that the request left
   the queue.
7. Repeat once with the assignee unable to sign in: requester reassigns to the second test account who takes
   responsibility. Record that no acknowledgment-on-behalf was available.
8. Restore the test endpoints. Stand down and record the time.

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
  Acknowledged ("Take responsibility"): <hh:mm>             -> time to acknowledgment: <mm>
  Stand-down:                      <hh:mm>
Targets met (detect / contact / acknowledge): <y/n> / <y/n> / <y/n>

Signals observed: queue <y/n>, in-app alert <y/n>, gauges <values or -1>, ops notice <kind or none>, webhook received <y/n>
Tree check: numbers tested <n of n>, wrong or stale <list by step, no numbers>
Findings:                          <numbered>
Actions:                           <action> | <owner role> | <due date>
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

Each line: time, who, action, outcome. Roles, not patient details. Example fields: noticed / queue checked / called
step n / answered / voicemail / assignee signed in / acknowledged / reassigned to role / stood down.

## 9. Open decisions and gaps

- Drill cadence and the targets of 7.1; tree order and the per-step wait; who watches the queue and gauges out of hours;
  who may stand down; evidence owner, place and retention. All **OPEN** (brief section 13).
- **G-1:** no audited acknowledge-by-phone / supervisor action (section 5.3).
- **G-2:** no supervisor reassign or way into a conversation they are not a member of (ADR-0076).
- **G-3:** no automatic page of a supervisor's phone; supervisor alerts are in-app only; no ops notice for
  `ladder_exhausted` / `route_unavailable` alone.
- **G-4:** no alert rules or stalled-worker check in the repo; per-process, hourly-repeat ops notices.
- **G-5:** a request that became `failed_unreachable` is not watched by the deadline timer; only a reassign re-arms it.
