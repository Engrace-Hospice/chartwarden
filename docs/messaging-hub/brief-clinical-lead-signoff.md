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

## What happens with the answers

ADR-0056 is updated with the signed numbers and role map, then accepted by the product owner. Numbers live as platform
defaults enforced by a database trigger (same mechanism as migration 0334) and every tenant change is audited.

References: `docs/adr/ADR-0056-clinical-acknowledgment-vs-read-receipts.md` (items 6, 7, Open questions), `docs/messaging-hub/05-clinical-workflows-and-safety.md`.
