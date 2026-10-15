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
- **Who may reassign:** the proposed rule is the sender or the current assignee, to another qualified care-team colleague; the window restarts for the new assignee and the original request time is kept for reporting. Is there a limit on how many times, and may a supervisor reassign without being either party (not built; the supervisor queue is WP 4.9)?
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
- **When nobody can be reached:** today the request is not marked "nobody could be reached" (that is WP 4.5's delivery-failure rule); it stays open, and the sender and the assignee get a generic in-app note on a growing schedule (1 h, 2 h, 4 h ... up to once a day, at most 8 times), and the supervisor audience is told once when the ladder is exhausted. When the ladder has no further tier the supervisor audience is told too. Is that schedule right, and should an exhausted ladder also page operations?
- **Wording:** the three in-app texts ("A clinical message was escalated to you because it was not acknowledged in time", "...was not acknowledged in time and could not be escalated; it is still open", "...and there is no further escalation tier; it is still open") and the card lines ("Escalated to you because it was not taken in time", "Nobody has taken responsibility and the deadline has passed. It could not be passed to the next person, so it is still open.").
- **Not yet:** all three flags (`messaging.urgent_clinical`, `messaging.ack_requests`, `messaging.escalation_timers`) stay off for every tenant. Switching the third on escalates every request that is already overdue at the next minute, so settle old open requests first.

## What happens with the answers

ADR-0056 is updated with the signed numbers and role map, then accepted by the product owner. Numbers live as platform
defaults enforced by a database trigger (same mechanism as migration 0334) and every tenant change is audited.

References: `docs/adr/ADR-0056-clinical-acknowledgment-vs-read-receipts.md` (items 6, 7, Open questions), `docs/messaging-hub/05-clinical-workflows-and-safety.md`.
