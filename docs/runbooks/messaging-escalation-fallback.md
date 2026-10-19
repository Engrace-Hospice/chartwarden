# Runbook: M36 escalation fallback ("when push fails, who calls whom") and quarterly drills

WP 4.11 of the messaging hub. This is what a person does when WardenX cannot get an acknowledgment request in front of a
clinician by itself, and how the agency proves, every quarter, that it can still do that. It is a **template**: every
name, number and rota below is a placeholder the agency fills in (section 4). It contains no patient information and must
never be filled in with any.

> **Messaging is not the emergency path.** A patient in crisis follows the agency's telephone / emergency procedure, not
> this runbook and not a message. This runbook covers the case where an *acknowledgment request* (ADR-0069) is still
> waiting and the system's own routes have not reached anyone.

> **Go-live precondition (OPEN, explicit):** a tenant must not turn on `messaging.escalation_timers`, and must not use the
> `urgent` or `critical_symptom` classes in production, until an **out-of-hours watcher** of the unacknowledged queue (and of
> the operations numbers) is named and signed off by the clinical lead. Nothing pages a supervisor's phone today (G-3), so
> without a named watcher an overdue request can sit unseen at night. The clinical lead decides who; this is not decided.

Decisions in this document marked **OPEN** are provisional and listed for the clinical lead and operations in
[`brief-clinical-lead-signoff.md` section 13](../messaging-hub/brief-clinical-lead-signoff.md#13-fallback-runbook-and-drills-wp-411---provisional-readings-to-approve-all-open).
Nothing here has been signed off.

## 1. What the product does today (read from the code)

| Fact | Where |
|---|---|
| A request has a class (`important`, `urgent`, `critical_symptom`) with a deadline (provisional 60 / 15 / 5 minutes). States: `pending`, `acknowledged`, `escalated`, `failed_unreachable`, `resolved`, `cancelled`. | ADR-0069; `packages/messaging/src/ack-requests/ack-rules.ts` |
| Only the **assigned user**, signed in and still qualified, can acknowledge or resolve (explicit "Take responsibility" button). Opening or reading never acknowledges. **There is no supervisor override and no "acknowledged by phone" write.** | ADR-0069 decision 6 |
| Reassign: the current assignee (any open state) or the requester (until the request is taken). Preconditions: the requester must still hold `messaging.send` and `messaging.urgent.send`; the new assignee must be a care-team member who can see the channel and differ from the current assignee and the requester; there is **no qualification check** on the assignee handing it on. **Reassign has no screen today:** it exists only as `POST /api/v1/messaging/escalations/:id/reassign`. The request card offers only "Take responsibility" and "Close this request" (ADR-0069 decision 14) and the queue screen never reassigns (`apps/web/src/modules/36-messaging/unacknowledged-queue.tsx`). | ADR-0069 decisions 5-6, 14 |
| The escalation action (next tier at the deadline, early escalation on delivery failure) runs only where the ops flag `messaging.escalation_timers` is on for the tenant (default off). Flag off means requests are left exactly as they are. | ADR-0070, ADR-0071 decision 8 |
| At the deadline the system asks the EscalationRouter (M19 on-call) for the next tier. No tier / no router: the request stays open with its assignee and a `route_unavailable` or `ladder_exhausted` history row; the router is asked again on a backoff (1 h up to 24 h). Production's router is a deny-stub until M19 binds one (ADR-0057 is still Proposed). | `apps/backend/src/modules/36-messaging/ack-escalation/escalation-service.ts` (header) |
| When every out-of-band delivery of the request alerts to the assignee has terminally failed, the request escalates now, or becomes `failed_unreachable` (written by the system only). `failed_unreachable` is open, not closed, and the deadline timer **stops watching it**. | ADR-0071 decisions 2-6 |
| Alerts are fixed generic text (no name, patient or message text). `route_unavailable` / `ladder_exhausted` tell the sender and the assignee in-app; `ladder_exhausted` and `failed_unreachable` also reach the supervisor audience (roles `clinical_supervisor`, `don`; tenants can re-aim in the alert-rule admin) **in-app only**. | `apps/backend/src/modules/36-messaging/outbox-consumers/ack-escalation-notifications.ts`, `.../ack-unreachable-notifications.ts` |
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
| 0 | Sender of the request (from the queue row; for `critical_symptom` call this person FIRST) | `<on file>` | `<on file>` | | Step 1 if not yet called, otherwise step 3 |
| 1 | The assignee (the clinician the request is on) | `<from the queue row>` | `<on-call roster, M19>` | `<on file>` | Step 0 (sender) if not yet called, otherwise step 2 |
| 2 | Next tier on call for the role (the person the system would have escalated to) | `<from the on-call roster>` | `<on file>` | `<on file>` | Step 3 |
| 3 | Clinical supervisor on duty | `<name>` | `<on file>` | `<on file>` | Step 4 |
| 4 | Director of nursing | `<name>` | `<on file>` | `<on file>` | Step 5 |
| 5 | Clinical lead / medical director | `<name>` | `<on file>` | `<on file>` | Step 6 |
| 6 | Operations on call (platform) | `<name>` | `<on file>` | `<on file>` | Escalate per the DR/BCP contact list |

Rules for the tree:

- Script for step 1 (the assignee): "WardenX shows a response request waiting for you; please sign in and open Messages."
- Script for step 0 (the sender): "Your WardenX request is still unanswered. Please tell me who you want to hand it to, and
  hand it on."
- Script for steps 2 and onward: these people are **not** the assignee and cannot see or act on the request. Say: "You may
  be asked to take over a WardenX request. Please stand by and sign in to Messages if it is handed to you." Never tell them
  a request is waiting for them unless it has been reassigned to them.
- Verify the person by the agency's normal verification procedure.
- Never say a patient name, a diagnosis or message content on the call, and never put them in a text or voicemail.
  **OPEN (brief section 13):** whether a clinician-to-clinician verbal handoff of the content is permitted when the new
  holder cannot yet see it.
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
2. If the tenant has a configured transport, check the vendor status pages and the `notification_delivery` failures in the
   logs; a channel with no configured transport fails closed by design (`transport_not_configured`).
3. Tell the supervisor in one line whether any out-of-band channel is configured for the tenant at all (today usually none,
   so the in-app inbox is the only route) and, if one is, whether its vendor is down. Flag rule: **never turn
   `messaging.escalation_timers` off while requests are open without the clinical lead's recorded decision**, and do not
   change any other flag mid-incident unless the clinical lead asks (see 5.6).

### 5.3 Reaching a human and recording that they have it

This is the honest part. **WardenX has no write path for "acknowledged by phone".** Only the assigned clinician can mark a
request acknowledged, and only by signing in and pressing "Take responsibility". The supervisor cannot do it for them.
**Moving a request to another person is also not available on any screen today (G-6).**

Who can move a request: only the **sender (requester, until the request is taken) or the assignee**. Nobody else, including
a supervisor, can. The sequence is therefore:

1. Reach the **assignee** by phone (tree step 1). Ask them to sign in and open Messages. If they can, they open the request
   and press **Take responsibility**; it becomes `acknowledged` and drops out of the queue. That is the system of record.
2. If the assignee cannot be reached or cannot sign in, **reach the SENDER next. This is a required action, not an option.**
   The sender knows the content and is the person who can hand the request on. Ask the sender to name the human they want to
   hold it (a colleague who is a care-team member for that channel). Then:
   - the new person is told to stand by and to sign in once the request is reassigned to them (they are **not** the assignee
     until then, see the script in section 4);
   - the reassign itself is an **API call** (`POST /api/v1/messaging/escalations/:id/reassign`, needs the sender's or
     assignee's own session; the sender must still hold `messaging.send` and `messaging.urgent.send`, the new assignee must
     be a care-team member who can see the channel). It is **not executable from the UI**, and an engineer must not use
     another person's session, so today it is **not executable by a clinician**. Whether a sender or assignee with API
     access, or a purpose-built path, is acceptable is **OPEN** (G-6). Until then, record "reassign not executable" as a
     finding every time it is needed, and use step 3's follow-up;
   - the new assignee signs in and presses **Take responsibility**.
3. **If BOTH the sender and the assignee are unreachable, the request cannot be moved at all today.** No supervisor
   override exists. For an `important` request the supervisor keeps following up (step 5 below). For `critical_symptom`
   this is a **blocking gap** for the clinical lead (brief section 13): the agency's emergency procedure, not WardenX, must
   cover the patient; the supervisor escalates the clinical question by phone through the tree and records it.
4. For a `critical_symptom` request, **call the sender first** (they know the content), and state in the log who owns the
   decision to call 911 / the agency emergency procedure (**OPEN**, provisional: the clinical supervisor on duty, who
   decides on the sender's verbal account and does not wait for WardenX).
5. A verbal "I've got it" from someone who has **not seen the content in WardenX does not close anything**. The request is
   closed only when it is `acknowledged` in the system (by the assignee, or after a reassign by the new assignee). Until
   then a named supervisor keeps following up every `<N>` minutes (**OPEN**) and the log records each follow-up.
6. Never ask anyone to sign in as someone else or to share a session. Never acknowledge on behalf of another person.

**OPEN gap (G-1):** an audited "acknowledged out-of-band by `<person>` on behalf of `<assignee>`" action for a supervisor.
It is not built; it needs a clinical-lead decision first (it weakens the explicit-action rule of ADR-0056). Recorded in the
brief, section 13.

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

Stand down when **all** are true: every affected request is actually `acknowledged` in the system (by the assignee, or
reassigned and then acknowledged), `resolved` or `cancelled`, and the queue has no row overdue for the incident's cause; the
channel outage is over or a workaround is communicated; and the gauges read zero or a known, explained number.
**A verbal "I've got it" does not satisfy stand-down.** The alternative to stand-down is a named supervisor who keeps
following up every `<N>` minutes (**OPEN**) until each request is acknowledged, each follow-up recorded in the log. **OPEN:**
who may declare stand-down (provisional: the supervisor on duty for clinical matters, operations for the technical cause,
both recorded).

Record the stand-down time on the incident log, tell the people called that the incident is closed, and start the review.

### 5.6 Rollback

This runbook changes no product code. Its actions do change data (a reassign, and in a drill disabling test endpoints), and each is recorded in the log. If the incident was triggered by a
recent change (a flag turned on, a transport configured, a deploy), revert that change through its own runbook. The
messaging flags are all off for every tenant by default; do not turn one on or off during an incident to "see what happens", and never turn `messaging.escalation_timers` off while requests are open without the clinical lead's recorded decision.

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
   overdue. The tenant has no out-of-band transport configured, so the nurse's only alert was in the app inbox." (A second
   variant: a transport is configured and its vendor is reported down.) Who sees this and how? Walk section 5.1.
2. **Inject 2.** "The row reads Could not be delivered. The nurse's phone does not answer." Walk the tree: the sender is
   called next (5.3 step 2), then steps 2-3 with the stand-by script.
3. **Inject 3.** "The nurse answers by phone, is in a car, and cannot sign in." What is the record? Walk 5.3 and state the
   gaps out loud: no acknowledge-by-phone (G-1) and no reassign screen (G-6).
4. **Inject 3b.** "The sender and the nurse are both unreachable and the class is critical symptom." Who owns the 911
   decision? What does the supervisor do when the request cannot be moved?
5. **Inject 4.** "The router is the deny-stub; the request says ladder exhausted. The clinical lead is unreachable." Who may
   decide, who stands down?
6. **Inject 5.** "A restricted row appears that you cannot open." What do you do and not do?
7. **Debrief.** Time to detect and to contact as the group estimates them; gaps; actions.

### 7.4 Live drill script (about 60 minutes, test organisation or synthetic data only)

**Test organisation only. A live drill is never run on a production tenant, and never with production patient data.**
Pre-conditions:

- A test organisation, a synthetic patient channel, two test accounts, and the tree in place.
- Flags turned on in the test environment by its owner: `messaging.ack_requests` (to create a request),
  `messaging.escalation_timers` (needed for `failed_unreachable`, early escalation and its ops notice),
  `messaging.notification_policy` (with `messaging.urgent_clinical` for an urgent send) **plus a configured transport** for
  push or SMS to exist and fail at all.
- **Without a configured transport the drill does not exercise delivery failure.** It exercises only the queue, the overdue
  gauge and the phone tree; record that in the evidence record as a limit of the drill.
- Operations are warned beforehand: the gauges (`wardenx_m36_ack_*`) count **all organisations**, and ops notices go to the
  production `OPS_ALERT_WEBHOOK_URL`, so a drill request can look like a real overdue request. Operations tag or exclude the
  drill organisation in their alerting (how: **OPEN**, no organisation label exists on the gauges).

1. Facilitator first makes the assignee's out-of-band routes fail: disable the assignee's push/SMS/email endpoints in the
   test organisation, or use an assignee with no verified endpoint. Do not touch any shared vendor or production
   configuration.
2. Recorder starts the clock. Facilitator raises an `important` or `urgent` request to that test assignee, who has agreed
   to stay silent for the drill. Note the time of request.
3. Supervisor, who has not been told which request, finds it from `/messaging/unacknowledged`. Recorder notes the time.
4. Operations reads the gauges (or confirms they read `-1`/zero as expected) and any ops notice. Record what fired.
5. Supervisor works the tree from step 1 with a real phone call to the test assignee. Record each attempt and time.
6. Assignee signs in and presses **Take responsibility**. Recorder notes the acknowledgment time and that the request left
   the queue.
7. Repeat once with the assignee unable to sign in. The supervisor calls the sender (5.3 step 2), who names the second
   test account. **Reassign has no screen and is not executable by a clinician today (G-6):** record "not executable" as a
   finding. If the test environment's owner can make the API call with the sender's test session, do so and record it as
   an engineering action, not as a clinician capability; the second account then takes responsibility.
8. Restore the test endpoints. Stand down only when the request is acknowledged in the system; record the time.

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

Each line: time, who (role), action, outcome, and the **request id (the id only, never a patient or message detail)**. The
outcome is chosen from a fixed, non-clinical set: `answered`, `voicemail`, `no answer`, `will sign in by <time>`, `signed in`,
`acknowledged in system`, `passed to <role>`, `reassigned to <role> (not executable: recorded)`, `follow-up due <time>`,
`stood down`. Free text about what the patient needs or what was agreed clinically does not go in the log.

**Where the log is kept: OPEN** (an approved store chosen by the clinical lead and operations; never a ticket system or a
chat channel, which are not approved for this).

## 9. Open decisions and gaps

- **Go-live precondition:** a named, signed-off out-of-hours watcher before `messaging.escalation_timers` or the urgent / critical classes are used in production.
- Drill cadence and the targets of 7.1; tree order and the per-step wait; who watches the queue and gauges out of hours;
  who may stand down; evidence owner, place and retention. All **OPEN** (brief section 13).
- **G-1:** no audited acknowledge-by-phone / supervisor action (section 5.3).
- **G-2:** no supervisor reassign or way into a conversation they are not a member of (ADR-0076).
- **G-3:** no automatic page of a supervisor's phone; supervisor alerts are in-app only; no ops notice for
  `ladder_exhausted` / `route_unavailable` alone.
- **G-4:** no alert rules or stalled-worker check in the repo; per-process, hourly-repeat ops notices.
- **G-6:** reassign has no screen: it is API-only, so a clinician cannot move a request to another person today (section 5.3). If both the sender and the assignee are unreachable the request cannot be moved at all (blocking for `critical_symptom`).
- **G-5:** a request that became `failed_unreachable` is not watched by the deadline timer; only a reassign re-arms it.
