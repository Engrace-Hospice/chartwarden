# Runbook: M36 escalation fallback ("when push fails, who calls whom") and quarterly drills

WP 4.11 of the messaging hub. This is what a person does when WardenX cannot get an acknowledgment request in front of a
clinician by itself, and how the agency proves, every quarter, that it can still do that. It is a **template**: every
name, number and rota below is a placeholder the agency fills in (section 4). It contains no patient information and must
never be filled in with any.

> **Messaging is not the emergency path.** A patient in crisis follows the agency's telephone / emergency procedure, not
> this runbook and not a message. This runbook covers the case where an *acknowledgment request* (ADR-0069) is still
> waiting and the system's own routes have not reached anyone.

> **Go-live precondition (OPEN, explicit):** a tenant must not turn on `messaging.ack_requests`, `messaging.urgent_clinical`
> or `messaging.escalation_timers`, and must not use the `important`, `urgent` or `critical_symptom` classes in production,
> until an **out-of-hours watcher** of the unacknowledged queue (and of the operations numbers) is named and signed off by
> the clinical lead. Nothing pages a supervisor's phone today (G-3), and requests sit unseen at night **even when the timers
> are off, which is the default** (the queue and gauges still show them but nobody is told). The creation flags are gated as
> well as the timers because a request that exists with no watcher is the hazard. (`critical_symptom` has no writer today,
> ADR-0069 decision 3 / ADR-0056 D7, so that class is latent until the clinical lead decides who may raise it.) **A further hazard:** a tenant that turns on `messaging.notification_policy` and the timers
> with no vendor transport configured (all environments today) gets every delivery to a verified endpoint failing
> (`transport_not_configured`), so its requests become `failed_unreachable` and the deadline timer stops watching them (G-5).
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
| Only the **assigned user**, signed in and still qualified, can acknowledge or resolve (explicit "Take responsibility" button). Opening or reading never acknowledges. **There is no supervisor override and no "acknowledged by phone" write.** | ADR-0069 decision 6 |
| Reassign: **only** the current assignee (any open state) or the requester **before the request is taken**; the route acts as the caller's own signed-in session and there is **no supervisor override** (`reassignDenied` in `apps/backend/src/modules/36-messaging/ack-requests/ack-service.ts`; ADR-0069 decision 6). Only when the **requester** is the one reassigning must they still hold `messaging.send` and `messaging.urgent.send`. The **new** assignee must be a care-team member who can see the channel, holding `messaging.urgent.receive`, passing the Part 2 gate, not the requester and not the current assignee. Refusals differ: `403 ACK_NOT_PARTY` (caller is neither sender nor assignee), `403 ACK_NOT_ASSIGNEE` (the request is already taken, so the sender can no longer reassign), `403` "You can no longer send response requests" (sender lost the send keys), `409 ACK_STATE_INVALID` (request closed), `404` (caller cannot see the channel), `422 ACK_ASSIGNEE_INVALID` (the new assignee is not acceptable; no reason is given, so only then try a differently qualified nurse, not the sender or an aide), and a rate limit of 5 per 5 minutes per (actor, colleague) pair (ADR-0069 decision 13). **Reassign has no screen:** it exists only as `POST /api/v1/messaging/escalations/:id/reassign`. The request card offers only "Take responsibility" and "Close this request" (ADR-0069 decision 14) and the queue screen never reassigns (`apps/web/src/modules/36-messaging/unacknowledged-queue.tsx`). **So today no request can be moved from a screen by anyone.** | ADR-0069 decisions 5-6, 13-14 |
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

The queue row carries the assignee's id (null on a restricted row) and display name (kept on a restricted row, `unacknowledged-service.ts`) but **no requester (sender) field** (`apps/backend/src/modules/36-messaging/routes/unacknowledged-typebox.ts`, `Item`). On a row the supervisor can open, the sender is the author of the message in the thread. On a `restricted` row (`id` null, no thread) the sender cannot be found at all.

What does **not** exist: Alertmanager rules in the repo (the operator scrapes the gauges and writes their own, see
[`WARDENX_OPS_RUNBOOK_v0.1.md` section 16.8](../architecture/WARDENX_OPS_RUNBOOK_v0.1.md)), percentiles, an ops notice for
`ladder_exhausted` or `route_unavailable` on their own (only the overdue notice and gauge catch them), an automatic page
to a supervisor's phone, a supervisor action to reassign or acknowledge from the queue, and a supervisor way into a
conversation they are not a member of. The window between a request going quiet and a human noticing is therefore the
supervisor looking at the queue or the operator watching the gauges. **OPEN:** who watches either outside office hours.

## 4. The telephone tree (template)

Fill in a private copy kept by the agency (not in this repository, not in a message). The roles are the ones the product
already addresses; the order is **OPEN** (brief section 13).

**Roles**

| Role | Name | Primary number | Backup number |
|---|---|---|---|
| A. Assignee (the clinician the request is on; from the queue row) | `<from the queue row>` | `<on-call roster, M19>` | `<on file>` |
| S. Sender (who raised it; see "Finding the sender" below) | `<thread author>` | `<on file>` | `<on file>` |
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

**Finding the sender.** The queue row has no requester field. On a row the supervisor can open, the sender is the author
of the message in the thread. On a `restricted` row there is no thread and the sender cannot be found; the supervisor then
has only the assignee, the class, the tier and the times (gap G-7).

Rules for the tree:

- Script for A (the assignee): "WardenX shows a response request waiting for you; please sign in and open Messages."
- Script for S (the sender): "Your WardenX request is still unanswered. Can you reach the assignee, or tell me who else
  should be told?" Do not ask the sender to reassign during the call: there is no screen for it, and the only route is the sender's own signed-in API call while the request is not yet taken (section 5.3 step 3, G-6).
- Script for T, C, D, L: these people are **not** the assignee and cannot see or act on the request. Say: "You may be asked
  to take over a WardenX request. Please stand by." Never tell them a request is waiting for them unless it has been
  reassigned to them.
- Verify the person by the agency's normal verification procedure.
- Never say a patient name, a diagnosis or message content on the call, and never put them in a text or voicemail.
  **Emergency carve-out (OPEN):** what may be said to summon emergency help (for example giving an address to the
  emergency number) is decided by the sender or the clinical supervisor under the agency's emergency procedure, not by this
  runbook. A restricted row where the sender and assignee are both unreachable gives no patient identity at all, so the
  supervisor cannot summon help from WardenX data; the agency's own records and procedure must. **OPEN (brief section 13):**
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
   still see who it is assigned to and how late it is. Start the tree for the class (section 4: assignee first for non-critical, sender first for `critical_symptom`).
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
**Nobody can move a request to another person from a screen either (G-6).**

1. Follow the tree for the class (section 4). Reach the **assignee** and ask them to sign in, open Messages and press
   **Take responsibility**. The request becomes `acknowledged` and leaves the queue. That is the system of record.
2. If the assignee cannot be reached, call the **sender** (unless unknown, which counts as unreachable) to find a way to
   reach the assignee, or to learn the content. The sender cannot move the request.
3. **If the assignee cannot sign in, nobody can move the request from a screen.** The assignee can still act whenever
   they sign in. The **only** escape is the **sender, signed in as themselves**, calling the reassign API
   (`POST /api/v1/messaging/escalations/:id/reassign`) with engineering help to **construct** the call (not their
   credentials), and only while the request is **not yet taken** and only if the sender still holds `messaging.send` and
   `messaging.urgent.send`. The new assignee must meet the preconditions in section 1; a `422 ACK_ASSIGNEE_INVALID` means try
   a differently qualified nurse. **Forbidden, always:** direct database writes (including system-actor writes) and handling
   any person's session, token or password. There is no other hatch, and the clinical lead must not be told otherwise.
   Whether even this is acceptable in an incident is **OPEN** (G-6). Record "reassign not executable from a screen" as a
   finding every time it is needed.
4. For `important` requests, the supervisor keeps following up every `<N>` minutes (**OPEN**) and **hands up to the
   clinical lead after `<M>` minutes** (**OPEN**) rather than following up without end.
5. For `urgent` requests, the supervisor follows up the same way, **hands up to the clinical lead after `<M2>` minutes**
   (**OPEN**) and asks someone with Part 2 access to the channel to open the row and identify the sender, when the row is
   restricted.
6. For `critical_symptom` (latent: no writer today), call the sender first (section 4) and state in the log who owns the
   decision to call 911 / the agency emergency procedure (**OPEN**, provisional: the clinical supervisor on duty, acting on
   the sender's verbal account; they do not wait for WardenX). If both the sender and the assignee are unreachable or
   unknown, the request cannot be moved at all, and the patient is the agency emergency procedure's, not WardenX's. This is a
   **blocking gap for the clinical lead** (brief section 13).
7. A verbal "I've got it" from someone who has **not seen the content in WardenX does not close anything**. The request is
   closed only when it is `acknowledged` in the system.
8. Never ask anyone to sign in as someone else or to share a session. Never acknowledge on behalf of another person.

**OPEN gap (G-1):** an audited "acknowledged out-of-band by `<person>` on behalf of `<assignee>`" action for a supervisor.
It is not built; it needs a clinical-lead decision first (it weakens the explicit-action rule of ADR-0056). Recorded in the
brief, section 13.

### 5.4 Degraded-mode behaviour you will see

- Flag `messaging.escalation_timers` off: nothing escalates by itself; the queue and the gauges still show the overdue
  requests. Call from the tree.
- Router is the deny-stub: requests show `route_unavailable`; supervisors are not alerted for that note alone. Watch the
  queue notes.
- `failed_unreachable`: the deadline timer no longer watches the request (ADR-0071 decision 6). A reassign would re-arm it, but reassign is rarely possible today (G-6).
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
step 4, with its hand-up limit) until each request is acknowledged, each follow-up recorded. **OPEN:** who may declare
stand-down (provisional: the supervisor on duty for clinical matters, operations for the technical cause, both recorded).

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
2. **Inject 2.** "The row reads Could not be delivered. The nurse's phone does not answer." Walk the non-critical sequence
   (A, then S, then T, C, D, L, O) with the stand-by script for T onward. Find the sender from the thread; try the case where
   the row is restricted and the sender is unknown.
3. **Inject 3.** "The nurse answers by phone, is in a car, and cannot sign in." What is the record? Walk 5.3 and state the
   gaps out loud: no acknowledge-by-phone (G-1) and no way for a clinician to reassign (G-6).
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
  distinct reassign target (a care-team nurse with `messaging.urgent.receive`) and a supervisor with `messaging.review`; and
  the tree in place. Note that the test organisation lives **in the production deployment** unless a separate environment is
  used, so the gauges and the webhook below are shared.
- Flags turned on for the test organisation only: `messaging.ack_requests` (to create a request),
  `messaging.urgent_clinical` (for an urgent send), `messaging.escalation_timers` (needed for `failed_unreachable`, early
  escalation and its ops notice) and `messaging.notification_policy`. Who may set them per tenant is **OPEN** (section 2
  exception note); drill participants act as the watchers, and the flags are switched **off again** after the drill.
- **Do not configure or change any transport or vendor credential (Twilio, VAPID, Postmark) for a drill in the production
  deployment.** Transports are deployment-wide, not per organisation. You do not need one: per ADR-0073 a verified endpoint
  with no transport settles `failed` / `transport_not_configured`, and with the timers on the request becomes escalated or
  `failed_unreachable`. That is the failure path under test.
- If a transport happens to be configured already, real SMS or push reaches participants' real phones, so the test
  organisation's supervisor audience (roles `clinical_supervisor`, `don`) must contain only drill participants.

- Operations are warned beforehand: the gauges (`wardenx_m36_ack_*`) count **all organisations**, and ops notices go to the
  production `OPS_ALERT_WEBHOOK_URL`, so a drill request can look like a real overdue request. Operations tag or exclude the
  drill organisation in their alerting (how: **OPEN**, no organisation label exists on the gauges).

1. Facilitator first makes the assignee's out-of-band route fail: the assignee needs a **verified** endpoint (in the test
   organisation) whose delivery then fails, which it does when no transport is configured (`transport_not_configured`). An assignee
   with **no** verified endpoint gets no out-of-band row at all, which is not a failure and does **not** produce
   `failed_unreachable` (ADR-0073 decision 4, ADR-0071 decision 2). Do not touch any shared vendor or production
   configuration.
2. Recorder starts the clock. Facilitator raises an `urgent` request (the urgent composer; `important` can only be raised through the API) to that test assignee, who has agreed
   to stay silent for the drill. Note the time of request.
3. Supervisor, who has not been told which request, finds it from `/messaging/unacknowledged`. Recorder notes the time.
4. Operations reads the gauges (or confirms they read `-1`/zero as expected) and any ops notice. Record what fired.
5. Supervisor works the tree from step 1 with a real phone call to the test assignee. Record each attempt and time.
6. Assignee signs in and presses **Take responsibility**. Recorder notes the acknowledgment time and that the request left
   the queue.
7. Repeat once with the assignee unable to sign in, and the request not yet taken. The supervisor calls the sender
   (5.3 step 2). The **test sender** then runs the reassign call **themselves, in their own session** (with engineering help
   building the call, never using their credentials), to the distinct target account, which takes responsibility. Record
   that no screen exists (G-6), that no supervisor action exists, and how long it took. Nobody may use a borrowed session or
   write to the database.
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

Each line: time, who (role), action, outcome, and the **request id (the id only, never a patient or message detail; on a restricted row, which shows no id, use the assignee's role and the requested time)**. The
outcome is chosen from a fixed, non-clinical set: `answered`, `voicemail`, `no answer`, `will sign in by <time>`, `signed in`,
`acknowledged in system`, `passed to <role>`, `reassigned to <role> (not executable: recorded)`, `follow-up due <time>`,
`stood down`. Free text about what the patient needs or what was agreed clinically does not go in the log.

**Where the log is kept: OPEN** (an approved store chosen by the clinical lead and operations; never a ticket system or a
chat channel, which are not approved for this).

## 9. Open decisions and gaps

- **Go-live precondition:** a named, signed-off out-of-hours watcher before `messaging.ack_requests`, `messaging.urgent_clinical` or `messaging.escalation_timers` is turned on, or the important / urgent / critical classes are used, in production.
- Drill cadence and the targets of 7.1; tree order and the per-step wait; who watches the queue and gauges out of hours;
  who may stand down; evidence owner, place and retention. All **OPEN** (brief section 13).
- **G-1:** no audited acknowledge-by-phone / supervisor action (section 5.3).
- **G-2:** no supervisor reassign or way into a conversation they are not a member of (ADR-0076).
- **G-3:** no automatic page of a supervisor's phone; supervisor alerts are in-app only; no ops notice for
  `ladder_exhausted` / `route_unavailable` alone.
- **G-4:** no alert rules or stalled-worker check in the repo; per-process, hourly-repeat ops notices.
- **G-5:** a request that became `failed_unreachable` is not watched by the deadline timer; only a reassign re-arms it, and reassign is rarely possible today.
- **G-6:** today no request can be moved from a screen by anyone: reassign is API-only and acts as the caller's own session (only the sender before it is taken, or the assignee; no supervisor override). If the assignee cannot sign in, the request stays stuck until the assignee signs in or the sender, signed in as themselves, makes the API call; direct database writes and borrowed sessions are forbidden. If both are unreachable it cannot be moved at all (blocking for `critical_symptom`, which is latent).
- **G-7:** the queue does not show the requester (sender); on a restricted row the sender cannot be found. A small product change (add the requester's display name to the row) would fix it.
