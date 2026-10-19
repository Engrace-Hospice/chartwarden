# Brief: clinical-lead sign-off on acknowledgment deadlines and the Critical class (ADR-0056, D4 / D7)

**Audience:** the clinical lead · **Needs from you:** approve or edit a table, name eligible roles · **Blocks:** acceptance of ADR-0056; Phase 4 builds against the defaults meanwhile and values can change later.

## What is already decided (product owner, 2026-10-11)

- A message that needs a clinical acknowledgment has its own deadline clock, separate from read receipts.
- A tenant may **shorten** any deadline, never exceed the platform maximum, and never disable Critical.
- Where a message also escalates through on-call (M19), the **stricter deadline wins**; triage SLAs are unchanged (D6).
- The **Critical symptom** class ships. Everywhere it can be chosen or shown, the UI carries a permanent
  **"not the emergency path"** notice that no tenant can dismiss (D7).
- An urgent or acknowledgment-bound message **cannot be edited** once sent.

## 1. Approve or edit the deadlines

| Class | Initial ack deadline | Platform max (tenant may not exceed) | Next tiers | First delivery |
|---|---|---|---|---|
| Important | 60 min | 120 min | half the previous window (30, 15 ...), floor 5 min | in-app + push |
| Urgent | 15 min | 30 min | 7 -> 5 -> 5 min | in-app + push; SMS (no PHI) after 5 min unopened |
| Critical symptom | 5 min | 10 min | 3 -> 2 -> 2 min | all configured channels at once; voice allowed; supervisor copied at tier 2 |

Rules to confirm: quiet hours never delay Urgent or Critical; a reassign restarts the window for the new assignee while the
original request time is kept for reporting.

**Your answer per row:** approve / change to ____ (default and max). Also approve or change the "half the previous window,
floor 5 min" rule for Important.

## 2. Who may raise and acknowledge Critical?

| `required_role` | May raise Critical? | May acknowledge Critical? |
|---|---|---|
| RN | | |
| Physician (MD/DO) | | |
| On-call physician | | |
| NP / PA | | |
| Social worker, chaplain, aide, other | | |

Please give the role-to-qualification map you want enforced (RN only? RN or MD? on-call physician?).

## 3. Reassign and offboarding

- How many times may a request be reassigned, and by whom?
- If the assignee is offboarded or deactivated while a request is open, who inherits it? (The system rule is that a request
  never ends with no open owner.)

## 4. Urgent clinical messages (WP 4.1, ADR-0068) - provisional wording and role maps to approve

WP 4.1 is built behind the flag `messaging.urgent_clinical` (default off) with **provisional** wording and defaults. Please approve or change:

- **The notice** shown permanently in the "Urgent clinical" dialog: "This is not the emergency path. For critical symptoms follow the agency telephone/emergency procedure; do not rely on this message alone." and "Sending does not page or escalate anyone. Your colleague is told in the app only. If you need an answer now, call them." **Open item (deferred by the product owner):** an agency-specific phone number or procedure name beside it; it needs a tenant setting that cannot be left blank.
- **Who may be named as the recipient** (`messaging.urgent.receive`): proposed RN, RN case manager, director of nursing, physicians and prescribers (MD, hospice physician, medical director, attending, NP, PA), clinical supervisor and clinical lead. **Not** LPN, social worker, chaplain, aide, volunteer, org admin or compliance. Is LPN in or out?
- **Who may raise one** (`messaging.urgent.send`): the clinical roles above plus LPN, social worker, chaplain and the aide roles (the authorization matrix says aides may initiate); **not** org admin (matrix: "conditional") or compliance. Should an org admin who is also clinically authorized be able to?
- **Recipient must be on the patient's care team** and a member of the conversation. A named person only; a role or the on-call clinician arrives with the routing work (WP 4.3). Acceptable for the first release?
- **Sent-status text:** "Urgent message sent. Your colleague has been told in the app. This is not a page." and the in-app alert text "You have an urgent clinical message".
- **Rate limits (provisional):** 10 urgent messages per minute per sender, 100 per minute per organisation, 5 per 5 minutes from one sender to one recipient. Too low or too high for a busy shift?
- **Not before 4.2 to 4.4 (decided: the flag stays off for every tenant until then):** the feature records and shows an urgent message but nobody tracks whether the recipient acted. We recommend it is not switched on for any tenant as a safety net until the acknowledgment request, escalation and timers ship. Please confirm.

## 5. Acknowledgment requests (WP 4.2, ADR-0069) - provisional values and readings to approve

WP 4.2 is built behind the flag `messaging.ack_requests` (default off) with **provisional** values. It stores a request, lets the named clinician take responsibility by one explicit action, and keeps a history; it has no timers, tiers or paging yet (WP 4.3 - 4.5). Please approve or change:

- **Deadlines** (platform default / hard maximum, in minutes): important 60 / 120, urgent 15 / 30, Critical 5 / 10. They are stored and shown; nothing acts on a missed deadline until WP 4.4. A tenant may not exceed the maximum (a database rule). Tenant tightening is **not built yet**: do you want it, and who in an agency would set it?
- **Who may take responsibility (acknowledge):** the proposed stricter reading is the **named assignee only**, who must hold the same role key that qualifies a recipient of an urgent message (RN, RN case manager, director of nursing, physicians and prescribers, clinical supervisor, clinical lead; **not** LPN, social worker, chaplain, aide, volunteer, org admin or compliance). An aide can raise a request but never take it. Is LPN in or out? Should a team lead or supervisor be able to acknowledge **on behalf of** the assignee (we recommend not: they reassign to themselves if qualified)?
- **Who may reassign:** the proposed rule is the sender or the current assignee, to another qualified care-team colleague; the window restarts for the new assignee and the original request time is kept for reporting. Is there a limit on how many times, and is it right that a supervisor with `messaging.review` may reassign a waiting request without being either party (built provisionally, ADR-0078; see section 13)?
- **Who may resolve (close):** the assignee, after acknowledging. Should the sender be able to close, and is a reason code needed?
- **Who may ask for a response on an existing message:** its author, naming one qualified care-team colleague (the class is important unless the message was sent as an urgent clinical message). Is "important" an acceptable name, and should its composer control come with this release?
- **Critical (symptom) class:** exists as a value but nothing can create it until you say which roles may raise and take it.
- **What happens to an open request** when its assignee is offboarded, the patient is discharged or dies, or the care team changes? Today it stays open and visible; the plan's rule is that a request never ends with no open owner.
- **Wording:** the card notice ("Taking responsibility is an explicit action. Opening or reading this message does not do it. This does not page anyone and is not the emergency path."), the two in-app alert texts ("You have an important clinical message that needs your response", "A clinical message was reassigned to you") and the button labels ("Take responsibility", "Close this request").
- **Rate limits (provisional):** create and reassign 20 per minute per user, 200 per minute per organisation, 5 per 5 minutes from one person to one colleague.
- **Not before 4.3 - 4.4:** both flags (`messaging.urgent_clinical`, `messaging.ack_requests`) stay off for every tenant until timers and backup routing ship; a request nobody is chasing is not a safety net.

## 6. Escalation timers (WP 4.4, ADR-0070) - provisional values to approve

WP 4.4 is built behind the flag `messaging.escalation_timers` (default off; it acts only on requests created under `messaging.ack_requests`). When a request's deadline passes with nobody having taken responsibility it hands the request to the next tier's clinician, who can then take responsibility; **until the on-call owner (M19) binds a real roster nothing can be routed**: the request stays open with its assignee, the sender and the assignee are told once an hour, and the card says plainly that it is still open. Please approve or change:

- **Time each next tier gets** (minutes): important 30, then 15, 7, 5 (half the previous, never under 5); urgent 7 then 5; Critical 3 then 2 (Critical has no writer yet). These are the table already in the plan's deadline policy; the first tier after the named person is "tier 1".
- **Who is told at each tier:** the proposal is **one** clinician per tier (the first available who is qualified and is not the sender): that person is asked to take responsibility and is the only one alerted. Should every on-call person of the tier be alerted, with the first to act taking it?
- **Which on-call ladder:** the request does not store a role, so every request asks the same ladder (the placeholder role key `rn`). Which ladder should an urgent request use, and should it differ by class?
- **When nobody can be reached:** the escalation timer alone does not mark a request "nobody could be reached" (that is the delivery-failure rule in section 7); it stays open, and the sender and the assignee get a generic in-app note on a growing schedule (1 h, 2 h, 4 h ... up to once a day, at most 8 times), and the supervisor audience is told once when the ladder is exhausted. When the ladder has no further tier the supervisor audience is told too. Is that schedule right, and should an exhausted ladder also page operations?
- **Wording:** the three in-app texts ("A clinical message was escalated to you because it was not acknowledged in time", "...was not acknowledged in time and could not be escalated; it is still open", "...and there is no further escalation tier; it is still open") and the card lines ("Escalated to you because it was not taken in time", "Nobody has taken responsibility and the deadline has passed. It could not be passed to the next person, so it is still open.").
- **Not yet:** all three flags (`messaging.urgent_clinical`, `messaging.ack_requests`, `messaging.escalation_timers`) stay off for every tenant. Switching the third on escalates every request that is already overdue at the next minute, so settle old open requests first.

## 7. Delivery failure (WP 4.5, ADR-0071) - provisional readings to approve

Nothing here fires until out-of-band delivery exists (WP 4.6): today every acknowledgment alert is in-app only, so no route can fail. These are the rules the system will follow once it can.

- **When a person counts as "not reached":** when **every** push, text or email route of the alert that told them has failed for good (the in-app inbox entry does not count, because an inbox entry is not proof anyone saw it). One failed route beside a working one waits. Should one failed route to an urgent request already count?
- **What happens at once:** the request does not wait for its deadline. It goes to the next on-call tier immediately; if no tier can be reached (today none can) it is marked "could not be delivered" (`failed_unreachable`). It stays open: the person can still take responsibility in the app, and the sender or the person can still reassign it.
- **Who is told:** the supervisor audience (roles `clinical_supervisor` and `don`, the same placeholder as for an exhausted ladder), the sender and the person it was sent to, in the app only, and operations through the platform notice (log line and the optional ops webhook). Is that audience right, and should supervisors be told at once or after a delay?
- **Wording** (never says anyone was reached): alert "A clinical message could not be delivered to anyone and nobody is known to have received it; it is still open"; card "Could not be delivered. It could not be delivered to the person it was sent to by any route outside the app, and no one else could be asked. Nobody is known to have received it and nobody has taken responsibility. It is still open."
- **Known limit to accept:** a request marked "could not be delivered" is no longer watched by the deadline timer, so if that came from a short outage nothing retries it by itself; supervisors and operations are told at once, and reassigning it (or someone taking responsibility) is the way forward. Is that acceptable, or should it be retried on a schedule?
- **Not decided here:** a named fallback recipient when the on-call lookup itself fails (ADR-0057 item 5). It needs the M19 owner; today the supervisors are told by alert, which is not an assignment.
- **Not yet:** the flag `messaging.escalation_timers` also gates this, and stays off for every tenant.

## 8. Notification policy (WP 4.6, ADR-0073) - provisional readings to approve

Nothing here reaches a phone until a tenant's flags are on AND a push or SMS transport exists (none does today). These are the rules the system will follow.

- **Quiet hours never hold back a request alert.** The four alerts that tell the assigned person about an urgent or acknowledgment-bound message are delivered at once on every channel in the table below that the person has verified, whatever their quiet hours, notification settings, vacation setting or shift. Their settings can add channels, never remove one. Everything else (routine alerts) still respects the person's own quiet hours and channel choices.
- **Channels at once, by class (provisional):** Important = push; Urgent = push; Critical = push and text message. Voice stays reserved for the field-safety SOS. Note: the first alert of an urgent message is always the Urgent class (push only); no Critical request can be raised yet, so the text message for Critical is not reachable until the Critical writer exists. Is push alone right for Urgent? The earlier table said "text message after 5 minutes unopened": that step needs a timer and is not built; say whether you want it, and after how long.
- **Only to verified phones and numbers.** A person with no verified push or text endpoint gets the in-app alert only; the system records why ("no verified endpoint") so the gap is visible. Should a person with no endpoint be flagged to a supervisor at assignment time?
- **No vacation forwarding for these alerts.** The named person is the only target; if they are away, the escalation timer moves the request on. Confirm.
- **Wording unchanged:** the out-of-band text is the content-free text of the existing sanitiser ("you have a notification"), never patient or message content (WP 4.7 owns the templates; see section 9).
- **Shift:** "off shift" will be treated like quiet hours for routine alerts only once on-shift data is available from scheduling; until then nobody is treated as off shift. Which system owns on-shift state (M17 scheduling or M19 on-call)?
- **Not yet:** the flag `messaging.notification_policy` stays off for every tenant; the three earlier flags too.

## 9. Out-of-band wording (WP 4.7, ADR-0074) - provisional wording to approve

What a phone shows on the lock screen, in a text message or in an email. Nothing here includes a patient, a name, a record number, a diagnosis, the message text, the sender's words or a channel name; the same text goes to everyone.

- **Urgent request:** "You have a new urgent request in WardenX. Sign in to view." Message: "You have a new message in WardenX. Sign in to view." Field safety: "WardenX safety alert. Sign in to view." Everything else: "You have a new notification in WardenX. Sign in to view." Email subject is always "WardenX notification"; the push title is always "WardenX".
- **Does the text say "urgent"?** It does for an urgent request, because a recipient who ignores a plain "notification" is a patient-safety risk. It reveals no one's identity. Say if you would rather it never name the level. Should it also say who is asking (a role such as "a nurse")? Provisional answer: no, because any role or sender detail can identify a person or a patient.
- **The link** opens WardenX and only works after sign-in. It contains one opaque code; no patient, message or channel reference. A text message is limited to one segment: if the link does not fit, the words are kept and the link is dropped.
- **If the system cannot be sure the text is safe**, it sends the plain "You have a new notification in WardenX. Sign in to view." instead of anything richer, and never skips the alert.
- **The link's landing page** is described in section 10 (WP 4.8).

## 10. Opening an alert link (WP 4.8, ADR-0075) - provisional wording to approve

What happens when someone taps the link in a push, text or email.

- **Signed out:** the person is taken to sign-in and, after signing in and choosing an organisation, to the conversation. Nothing about the alert is shown before sign-in.
- **Signed in as the person it was meant for, and still allowed to see the conversation:** WardenX opens that conversation at the message. If the message has an acknowledgment request, the request's card is focused so a screen reader and the keyboard land on it. **Opening the link never acknowledges anything**; the clinician still presses the button.
- **Anyone else, or an alert that no longer applies** (removed message, lost access, wrong person, forwarded link): one plain page, the same for every case: "This notification is no longer available. It may have been removed, or you may no longer have access. Your messages are still in WardenX." with a link to the messages. It deliberately does not say which case it was.
- **Please approve or edit** that wording, and confirm that a clinician who lost access to a conversation should get this plain page rather than an "access removed" explanation (provisional answer: the plain page, because telling them more would confirm the conversation exists).

## 11. The supervisor's unacknowledged queue (WP 4.9, ADR-0076) - provisional readings to approve

A list for supervisors of every request still waiting for someone to take responsibility. It only reads: it never takes responsibility, reassigns or closes anything, and it does not page anyone.

- **Who counts as a supervisor:** whoever holds the existing "review" permission, which today is clinical supervisor, director of nursing and clinical lead, the same people the "could not be delivered" and "no one further to pass it to" alerts already reach. Administrators do not have it by default. Confirm, and say whether the medical director or on-call lead should see it too.
- **What is listed:** waiting, escalated and could-not-be-delivered requests, the late and the not yet late, oldest deadline first. Not listed: a request someone has taken responsibility for, a closed one, a withdrawn one (message deleted). Confirm the order (alternative: could-not-be-delivered first, or urgent before important).
- **Nothing is hidden by a filter:** the two filters (state, overdue only) only narrow, and the page always says how many are waiting in all.
- **A request the supervisor cannot open** (they are not on that patient's care team, or the patient is under the substance-use-disorder confidentiality rules and they are not released): it is still listed, without a link and without the patient or the message. It shows who it is assigned to, how late it is and its class, so the supervisor can phone that person. **Please decide** whether the assignee's name and the class are acceptable on those rows (provisional: yes, no patient is named) or whether those rows should show only "a request is overdue". Separately, whether supervisors should get a way into the conversation to act (today they cannot; that is a larger decision).
- **OPEN compliance question (not decided; behaviour unchanged):** a row the supervisor cannot open still shows the assignee's name, the class, the tier, the note and the times, and the totals count rows they cannot open. For conversations under the substance-use-disorder confidentiality rules, compliance may require collapsing such a row to "restricted, overdue by N minutes" with no name and no class, and counting it without a breakdown. Please decide.
- **Wording** of the page, the note that it does not page anyone and is not the emergency path, and "Could not be delivered". Approve or edit.
- **Alert to operations (not clinicians):** a notice goes to the platform operations channel when a request is more than **15 minutes** past its deadline, and when the average time to take responsibility over the last 24 hours is more than **15 minutes** (at least five requests). Confirm or change both numbers; they are not clinical decisions about a patient, but they say when the agency's loop is too slow.
- **Not yet:** percentiles, a dashboard with history, a supervisor action to acknowledge or resolve from the list (a supervisor reassign was added later, ADR-0078, see section 13).

## 12. Snooze and reminders (WP 4.10, ADR-0077) - provisional values and readings to approve (all OPEN)

Two small personal tools. **Snooze** pauses the phone / text / email copies of ordinary notices from one conversation; nothing disappears from the app and urgent items always get through. A **reminder** brings one ordinary message back to its owner at a time they pick. Both are behind the same switch as the notification rules (`messaging.notification_policy`), off for every organisation.

- **Longest snooze:** provisional **24 hours** (a day's work); the shortest is 5 minutes; the screen offers 1, 4, 8 and 24 hours. Is a day too long for a clinician to silence a conversation? Should it end at the end of the person's shift instead (needs shift data, which does not exist yet)?
- **Which conversations can be snoozed:** every conversation the person belongs to, **except** one in which they sent, or are assigned, a request that someone must still respond to (any class, including "important"). They get a plain explanation and no snooze button. Provisional reading: that exclusion applies to the **sender** as well as the assignee, because the sender is waiting for an answer and gets the "no one could be reached" notices. Confirm, or limit it to the assignee.
- **What a snooze quiets:** provisional answer: **only** the "someone mentioned you in a conversation" notice's phone / text / email copy. It does not quiet tasks, handoffs, reminders, anything about an urgent or response-required item, or anything to supervisors. Please confirm that is the right short list, and say whether any other ordinary notice should be quietable. (Today the standard rule sends mentions in-app only, so a snooze has an effect only for an organisation or person who has chosen phone / email copies.)
- **Urgent-adjacent classes:** an item with a response request of any class, an "urgent clinical" message, and the notices about them (asked, passed on, could not be delivered, no one further) are **never** snoozable and **never** quieted, whatever the snooze says. A response request that opens after someone snoozed cancels the snooze's effect for as long as it is open. Confirm there is no class (for example "important") that should be snoozable.
- **Reminders:** at most **25** waiting per person; a time between 1 minute and **30 days** ahead; one per message; not on an urgent or response-required message. The reminder says only "You asked to be reminded about a message in a conversation" with a link; it never repeats the message, the patient or the sender. A reminder more than 7 days late is dropped silently. Confirm the numbers and the wording.
- **Unread digest (P2, not built):** a once-a-day or once-a-shift email of unread **counts** (no content) needs a new schedule per person and a decision on cadence and channel, and there is no place in the platform to hang it today. Deferred. When it is built: how often (per shift, daily, weekly), which channel (email only?), and whether a person with only urgent items unread should get one at all.

## 13. Fallback runbook and drills (WP 4.11) - provisional readings to approve (all OPEN)

`docs/runbooks/messaging-escalation-fallback.md` says what a supervisor and operations do when a response request is still waiting and the system has not reached anyone, and how the agency rehearses it. It is a template; none of the numbers below is signed off.

- **Drill cadence:** provisional every quarter, one tabletop and one live drill in the same quarter. Right frequency? Should a new organisation drill before going live?
- **Telephone-tree order:** provisional, by start point. Non-critical classes: assignee, sender, next on-call tier, clinical supervisor, director of nursing, clinical lead / medical director, operations on call. Critical symptom (latent, no writer today): sender first, then the assignee, then next on-call tier, supervisor, director of nursing, clinical lead, operations. A sender the row's name does not identify counts as unreachable. Confirm the order and the roles.
- **Wait per step:** provisional 5 minutes for urgent and critical, 10 for important, before calling the next step.
- **Response-time targets (drills):** provisional 10 minutes to notice, 10 more to reach a person, and acknowledgment within the request's deadline plus 15 minutes.
- **Out of hours:** who watches the unacknowledged queue and the operations numbers at night and at weekends? Today nothing pages a supervisor's phone.
- **Evidence:** who owns the drill record (provisional: the clinical lead), where it is kept (provisional: the agency's compliance evidence store, never this repository) and for how long (agency policy period; six years is the usual documentation period).
- **Who may stand down:** provisional the supervisor on duty for the clinical side and operations for the technical cause, both recorded.
- **G-1, closed by decision, please revisit if you disagree:** an audited supervisor "acknowledged by phone on behalf of" action is **rejected**, because it would weaken the explicit-acknowledgment rule (only a person who signs in and takes responsibility; ADR-0056, ADR-0069 decision 6). The supported path is the supervisor reassign below: the supervisor moves the request to a reachable qualified clinician, who takes responsibility in their own session. Nothing records "acknowledged out-of-band". Confirm, or ask for the action (ADR-0078).
- **Product gaps still open:** a phone page to supervisors and an operations notice for "no one further" alone (G-3); alert rules and a stalled-worker check (G-4); a supervisor way into a conversation they are not a member of (not built; the supervisor asks a channel member or the sender).
- **Supervisor reassign (ADR-0078, provisional, all OPEN):** a holder of `messaging.review` (clinical supervisor, director of nursing, clinical lead) may move a waiting request (pending, escalated or could-not-be-delivered) to an eligible colleague, including a request whose conversation they cannot open. It never acknowledges, resolves or reads anything. Confirm: (a) that `messaging.review` is the right audience (a dedicated permission is deferred); (b) the fixed reason-code set (assignee unreachable, assignee unable to sign in, assignee off shift, coverage change, workload, other operational; no free text); (c) that the previous assignee and the sender get a generic in-app notice and the supervisor does not; (d) that this amends the "no supervisor override" reading of ADR-0069 for reassign only; (e) the per-request cap of 5 supervisor reassigns in 24 hours, after which the supervisor is told to ask you (provisional number); (f) that a supervisor walled off from the patient by the Part 2 gate gets an empty candidate list and a refusal, and must ask a person who is admitted, or you. A supervisor can never name themselves as the new assignee.
- **Reassign control on the card (provisional, OPEN):** the assignee (any open state) and the sender (until the request is taken) now have a Reassign button with a colleague picker. Confirm the wording is acceptable (the refusal never says why a colleague is ineligible).
- **Requester name, request reference and candidate names on rows the supervisor cannot open (OPEN, compliance / Part 2 review):** the queue row now shows "Sent by <name>" and a request reference, also for a restricted row, and the colleague pickers list eligible colleagues' display names. They name people, not patients, and open nothing. Do you accept this, or should restricted rows collapse to "restricted, overdue by N"? No role class is shown (not built).
- **Go-live precondition (needs a decision):** a tenant should not turn on `messaging.ack_requests`, `messaging.urgent_clinical` or the escalation timers, or use the important, urgent and critical-symptom classes in production, until an out-of-hours watcher of the unacknowledged queue is named and signed off. Requests sit unseen at night even with the timers off (the default). Who, and is this the right condition?
- **Product gap G-6, closed (screen) and G-2 closed (supervisor):** a request can now be moved from a screen by the assignee, the sender (until taken) and a supervisor. If the assignee cannot sign in, the supervisor reassigns; direct database writes and borrowed sessions remain forbidden. If the assignee, the sender and every qualified colleague are unreachable the request still cannot be taken, and the agency's emergency procedure must cover the patient (blocking for `critical_symptom`, which is latent). Is that acceptable?
- **Product gap G-7, closed:** the queue shows the requester's display name (see the disclosure item above).
- **Product gap G-5, partly closed:** a request that became "could not be delivered" is watched again when anyone reassigns it, a supervisor included. One that nobody reassigns is still not watched by the deadline timer. Accepted in ADR-0071; confirm.
- **Emergency carve-out:** the runbook says no patient name, diagnosis or message content on calls. What may be said to summon emergency help is decided by the sender or clinical supervisor under the agency's emergency procedure. A restricted row with both sender and assignee unreachable gives no patient identity at all. Confirm the carve-out.
- **Cancellation during an incident:** a request cancelled because the sender deleted the message must not close an incident silently; provisional: it needs your recorded decision before stand-down.
- **Follow-up limit:** after how many minutes does the supervisor hand an unanswered `important` (and, separately, `urgent`) request up to you instead of following up without end? For a restricted row, who with Part 2 access identifies the sender?
- **Hazard to note at go-live:** a tenant that turns on the notification policy and the timers with no vendor transport configured gets every delivery to a verified endpoint failing, so its requests become "could not be delivered" and the deadline timer stops watching them. The drill exception: the flags may be on for a test organisation only, with drill participants as watchers, and off again after. Who can set the flags per tenant is unconfirmed.
- **A verbal "I've got it" does not close a request.** Provisional: stand-down needs the request acknowledged in the system; otherwise a named supervisor follows up at a set interval. Confirm, and set the interval.
- **Who owns the 911 / emergency decision** while a critical-symptom request is unanswered (provisional: the clinical supervisor on duty, acting on the sender's verbal account).
- **Verbal handoff of content:** may a clinician tell another clinician the content by phone when the new holder cannot yet see the request? (Provisional: no content on the call; the person is told to stand by for a reassignment.)
- **Incident log:** where it is kept (an approved store; not a ticket system or chat channel) and the fixed set of non-clinical outcomes.
- **Drill hygiene:** live drills in a test organisation only, with at least four accounts (sender, assignee, a distinct reassign target, a supervisor with `messaging.review` who performs the reassign), and the test organisation lives in the production deployment, so the gauges and the ops webhook are shared; real SMS or push would reach participants' real phones if a transport is configured, so the test organisation's supervisor audience must contain only drill participants. How operations tag or exclude it is open (the gauges have no organisation label).
- **Flag rule:** never turn the escalation timers off while requests are waiting (not yet taken) without your recorded decision. Confirm.
- **Not yet done:** no tabletop or live drill has been run, so the acceptance evidence does not exist.

## What happens with the answers

ADR-0056 is updated with the signed numbers and role map, then accepted by the product owner. Numbers live as platform
defaults enforced by a database trigger (same mechanism as migration 0334) and every tenant change is audited.

References: `docs/adr/ADR-0056-clinical-acknowledgment-vs-read-receipts.md` (items 6, 7, Open questions), `docs/messaging-hub/05-clinical-workflows-and-safety.md`.
