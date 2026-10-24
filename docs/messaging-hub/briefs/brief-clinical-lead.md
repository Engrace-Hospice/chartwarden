# Brief: clinical lead (with the bereavement coordinator), 20 decisions on wording, checklists and clinical limits

**Audience:** the clinical lead; the **bereavement coordinator** answers CL-16 (part), CL-17 and CL-20 · **Needs from you:** 20 short answers (yes / no / modify) · **Blocks:** acceptance of ADR-0082, ADR-0084, ADR-0085, ADR-0091, ADR-0094, ADR-0095, ADR-0096, ADR-0097, ADR-0098, ADR-0099 on the clinical side; switching on the smart inbox, acknowledge-required broadcast and death board for any real tenant; the thread-read build and the AI, voice, partner-reply and family-messaging builds.

> **Status (2026-10-23):** every item is a **build-team default**, not a clinical position. Most features named here are built flag-off; your answer decides the wording and limits a tenant sees and whether the flag may be turned on. The earlier clinical-lead sign-offs (acknowledgment deadlines, Critical class, urgent recipients) stay in [`../brief-clinical-lead-signoff.md`](../brief-clinical-lead-signoff.md); the open rows of [`../11-decision-sheet.md`](../11-decision-sheet.md) sections A, B and D are not repeated here. The one unresolved prerequisite for all flags, a named watcher for the unacknowledged queue (sheet row A1), still applies. Index: [`README.md`](./README.md).

**How to answer:** tick one box per item. "Yes" accepts the recommended default exactly as worded; "Modify" accepts it with your change; "No" becomes a work item.

---

## A. After-hours triage and the on-call ladder (ADR-0082)

The product owner answered E1, E2, E4 and E5 on 2026-10-19. **Clinical-lead concurrence on E4 and E2 is not recorded.**

### CL-1. The three-step fallback ladder (ADR-0082, "Decisions recorded" E4, decision 9)

**Plain language.** When no on-call nurse can be found for an after-hours item, the product owner wants an ordered ladder, each step shown to and confirmed by the sender, never silent: (1) the confirmed on-call; (2) a named role the agency chooses (off until set); (3) the agency's fixed emergency number (a number shown to the sender, who dials it).

- **Recommended default:** concur as recorded.
- **Consequence:** during a gap the sender sees the next step and must confirm it; nobody is paged who was not confirmed. If you decline, the earlier rule stands: no fallback, the sender is told to use the agency telephone procedure.

**Stays blocked:** slices L2 (ladder logic) and L3 (ladder screens); L1 also needs the M19 owner (M19-4). **Unblocks:** L2, L3.

Answer: [ ] concur  [ ] concur with changes: ____________  [ ] decline (keep "no fallback")  Name / date: ____________

### CL-2. Who may be addressed by role (ADR-0082, E2; ADR-0081)

Recorded: the roles are `rn` and `physician`, but only RN works today (the on-call router maps only RN); only holders of the on-call send permission may address a role, and no role holds it until you decide; a family member never addresses a role.

- **Recommended default:** concur, and say which clinical roles should hold the on-call send permission (for example supervisor, case manager).
- **Consequence:** nobody can page the on-call by role until you name the holders.

Answer: [ ] concur  [ ] holders of the permission: ____________  [ ] modify: ____  Name / date: ____________

### CL-3. Provisional wording of the after-hours indicator and thread lines (ADR-0082, "Implementation notes", Web; thread line)

**Plain language.** The composer says the send "will also request an after-hours triage call". The care-team thread shows one fixed line from a closed list (for example "Triage call not confirmed"), and nothing from the call itself. All wording is provisional.

- **Recommended default:** approve the wording as built, or send edits. Fixed text only; no clinical detail ever appears in the thread.
- **Consequence:** unapproved wording cannot be used with a real tenant.

Answer: [ ] approve as built  [ ] edits: ____________  Name / date: ____________

### CL-4. Should later stages of the call appear in the thread? (ADR-0082, "Still blocked or open", last bullet; Q5, Q8)

- **Recommended default:** no. Only the first result line shows (call requested / not confirmed). Disposition and closure stay in the on-call module.
- **Consequence:** the thread never shows how the call ended; a nurse must open the on-call module. Showing disposition would add a Part 2 question (withheld in restricted channels).

Answer: [ ] no  [ ] yes, show: ____________  Name / date: ____________

---

## B. A non-team nurse reading one thread (ADR-0085; sheet row E5)

### CL-5. Limits on the read grant, and your concurrence (ADR-0085, Q4, Q5, Q7)

**Plain language.** The grant lets an escalated on-call nurse who is not on the care team read one thread for a short time. Compliance (CO-1 to CO-3) and security (SE-8) are asked separately about the principle, duration and safety.

- **Recommended default:** the **system** issues grants only (on escalation, reassignment, after-hours role send); no supervisor or sender grants ad hoc; the grantee can read, acknowledge and resolve but **cannot write** in the thread; the first after-hours send to an off-team on-call uses the same mechanism as an escalation.
- **Consequence:** an on-call nurse cannot add context to the thread; they must use the request or the phone.

Answer: Q4 [ ] system only [ ] allow supervisor/sender grants  ·  Q5 [ ] no writing [ ] allow replies  ·  Q7 [ ] same mechanism [ ] split  ·  Clinical concurrence on E5: [ ] yes [ ] no  Name / date: ____________

---

## C. Offboarding (ADR-0084; built, always on)

### CL-6. Second approver, and who is paged when nobody can take a leaver's urgent request (ADR-0084 "Open human decisions" 1; security officer SE-2 joins)

- **Today:** one officer runs offboarding (fresh second factor); the first eligible colleague takes a waiting urgent request; if nobody can, it stays assigned and a supervisor alert is raised.
- **Recommended default:** no second approver for the move; when nobody is eligible, **page a named clinical lead** (the alert recipients of ADR-0079) instead of only listing it.
- **Consequence:** faster hand-over; a mistaken reassign is corrected by the same supervisor reassign. A clinician's whole workload cannot have a second approver. The clinical lead must hold the supervisor attention keys.

Answer: [ ] yes  [ ] no, require a second approver  [ ] modify: ____________  Name / date: ____________

### CL-7. Urgent messages sent to someone who has left, with no request (ADR-0084, 7)

- **Today:** within 72 hours they are counted on the officer's page only; no alert; no refusal at send time.
- **Recommended default:** keep 72 hours, do not refuse at send time, and **raise a supervisor alert** for such a message (a small change, keyed on the message id).
- **Consequence:** more alerts for a busy clinician; the 72 hours is fixed, not per tenant.

Answer: [ ] yes  [ ] no  [ ] modify hours / alert: ____________  Name / date: ____________

---

## D. Smart work inbox (ADR-0091; built flag-off, no migration, flag `messaging.smart_inbox`)

### CL-8. Order of the inbox and the handoff threshold (ADR-0091 D3; "Not decided")

**Plain language.** The inbox is one list of your own work, in a fixed order: unacknowledged urgent requests; handoffs awaiting you; assigned tasks; mentions; unread care-team conversations. A handoff counts as "expiring soon" within 60 minutes. Inside urgent: unreachable first, then overdue, then by deadline. Urgent is never cut off or buried.

- **Recommended default:** approve the order and 60 minutes.
- **Consequence:** the order is fixed and explainable (each row says why); changing it is a small change, not a rebuild.

Answer: [ ] yes  [ ] no  [ ] modify order / minutes: ____________  Name / date: ____________

### CL-9. Which conversations count as unread work (ADR-0091, "Consequences")

- **Recommended default:** only care-team conversations; direct messages, announcements and department channels do not.
- **Consequence:** an unread direct message never reaches the inbox.

Answer: [ ] care-team only  [ ] also: ____________  Name / date: ____________

---

## E. Voice notes and AI (ADR-0094, ADR-0095; nothing built)

### CL-10. AI summaries: risk class, where first, and drafts (ADR-0095, "Open decisions" 1 and 9; hazard H-08)

- **Recommended default:** classify as **High** risk (a wrong summary can hide an urgent message); offer summaries first on administrative channels, then clinical care-team channels only after the evaluation passes; **summaries only at first, drafts later** (drafts add authorship questions).
- **Consequence:** no AI feature serves anyone until the evaluation stages pass and a vendor agreement exists (PV-6). A summary can never stand in for reading an urgent message.

**Stays blocked:** the whole of WP 6.5 (no capability, route or migration exists). **Unblocks:** planning of the M32 capability and the first slice.

Answer: [ ] yes  [ ] no  [ ] modify risk class / channels / drafts: ____________  Name / date: ____________

### CL-11. Required wording of the AI panel (ADR-0095, open 5; section 2)

- **Recommended default:** panel header "AI summary - draft - not verified"; every point shows its confidence; "Too little to summarise" under 3 included messages; a summary must **never** satisfy or replace an acknowledgment request.
- **Consequence:** unapproved wording cannot ship.

Answer: [ ] approve  [ ] edits: ____________  Name / date: ____________

### CL-12. A voice note must carry typed text; length (ADR-0094, Q4; section 5)

- **Recommended default:** a message with a voice note must also have a typed text body (so deaf or hard-of-hearing colleagues, or someone in a noisy place, can read it); each note is at most 5 minutes (8 MB).
- **Consequence:** a nurse in a car cannot send audio alone; 5 minutes is not measured on real phones.

**Unblocks (with SE-14, PO-10, and the operations items in PO-11):** the first voice-note slice (allowlist plus recorder).

Answer: [ ] yes  [ ] no  [ ] modify: ____________  Name / date: ____________

---

## F. External partners (ADR-0096; built flag-off, replies not built)

### CL-13. What may be shared with a pharmacy or equipment vendor (ADR-0096, limit a, "Open human items" 3)

- **Recommended default:** only non-clinical coordination conversations in discipline, location and on-call channels; no attachments, no clinical links, no patient mentions (excluded by structure). Attachments or clinical content are **never** shareable until you say who marks them.
- **Consequence:** a patient name typed in free text **is not detected** (a partial filter withholds numbers, dates, phones, emails and addresses, not names). The staff screen says so.

Answer: [ ] yes  [ ] no  [ ] modify (allow marking, by whom): ____________  Name / date: ____________

### CL-14. If partners could reply: what may a pharmacy write into a patient record? (ADR-0096 D25; "Open human items" 2)

- **Recommended default:** do not build replies yet; if built, plain text only, 2 000 characters, shown to staff with an "External" badge, never in orders or the chart without an explicit staff step.
- **Consequence:** an outside party could place text that staff act on ("call this number"). Residual risks are listed in D25.

Answer: [ ] do not build  [ ] build with: ____________  Name / date: ____________

---

## G. Acknowledge-required broadcast (ADR-0097)

### CL-15. Clinical-operations concurrence (ADR-0097, "Not done / open" 5; D3 to D5)

The audience is all active staff except the author; a later joiner is not asked; only the author sees who has not acknowledged. See CO-15 for the compliance question.

- **Recommended default:** concur; no reminders are sent (nothing pushes anyone), so an author must look at the list.
- **Consequence:** a deadline shows a "Past deadline" marker but chases no one.

Answer: [ ] concur  [ ] changes: ____________  Name / date: ____________

---

## H. Death-event board (ADR-0098; built flag-off)

### CL-16. The six items, wording, due times and who owns them first (ADR-0098, "Open sign-offs" 1; **bereavement coordinator joins**, sign-off 2)

**Plain language.** After a death the board opens six items: pronouncement recorded (due 2 hours); family or representative notified (4 hours); medical equipment pickup arranged (3 days); medication disposal completed and witnessed (24 hours); clinical record follow-up tasks completed (3 days); required documents filed (3 days). At the start **all six go to one person**, the patient's primary RN (else the care team); the owner or a supervisor spreads them. A tenant cannot change the list or the wording. Due times are display only; nothing reminds or escalates.

- **Recommended default:** approve the six items, wording and offsets; keep the primary-RN-first rule. Say whether "pronouncement" belongs on a list at all or is already an act in the patient record.
- **Consequence:** a wrong default owner costs one visible reassignment. A ticked item proves nothing about the chart. A death while the flag is off gets no board and no backfill (see PO-12).

Answer: [ ] approve all  [ ] edits (items / wording / hours / owner rule): ____________  Name / date: ____________

### CL-17. Bereavement coordinator: hand-off to the bereavement plan and the family item (ADR-0098 sign-off 2)

- **Recommended default:** no connection to the bereavement plan (none is built); the family-notification wording stays as in CL-16; the bereavement coordinator is **not** a default owner of the family item.
- **Consequence:** the board never starts or updates a bereavement plan; staff must do that where it lives today.

Answer: [ ] yes  [ ] change: coordinator is default owner of the family item  [ ] other: ____________  Bereavement coordinator name / date: ____________

---

## I. Family and caregiver messaging without an app (ADR-0099; nothing built, privacy answers PV-1 to PV-3 come first)

### CL-18. What staff may say, and who may manage or reply (ADR-0099 D9; Q4)

- **Recommended default:** a persistent line in the reply box says the contact can read it; two new permissions: **manage** (create / reissue / revoke / close / block) for clinical supervisor, social work, bereavement coordinator and compliance officer; **respond** for care-team disciplines. Role names to be checked against the role catalogue. You provide the "what may be said" guidance, including to a contact who is permitted but not a legal representative.
- **Consequence:** until roles are named, nobody can invite a contact.

**Stays blocked:** slice S1 (schema and permissions). **Unblocks:** S1 and S4.

Answer: [ ] roles as proposed  [ ] roles: ____________  Guidance text attached: [ ] yes  Name / date: ____________

### CL-19. After discharge for another reason, and unanswered family messages (ADR-0099 D12, D9, D14)

- **Recommended default:** access ends at discharge (zero grace days) for any reason other than death; an unanswered family message never pages or escalates anyone (a family text is not an emergency path; every screen says to call the agency's 24-hour number or 911).
- **Consequence:** no safety net exists for a family message sent at 2 a.m.; the auto-reply gives the on-call number.

Answer: [ ] yes  [ ] grace of ___ days  [ ] allow escalation after ___ minutes  Name / date: ____________

### CL-20. Bereavement: thread or channel, wording, and after 13 months (ADR-0099 D6, D15; Q5; **bereavement coordinator answers**)

- **Recommended default:** a bereaved contact keeps a **separate family thread** with the bereavement counsellor (the staff bereavement channel is not opened to them); the thread stays readable for the plan's 13-month window, then access ends and the thread is archived read-only; the bereavement-appropriate neutral message wording is written by you, not engineering; contacts not named in the plan lose access at death.
- **Consequence:** simpler and safer than adding a family member to the staff channel; a missing bereavement plan means access ends at death.

Answer: [ ] yes  [ ] join the bereavement channel instead  [ ] continue after 13 months on request  [ ] wording attached  Bereavement coordinator name / date: ____________

---

*Not in this brief:* privacy and vendor questions (PV), session and header questions (SE), router questions (M19), flags and priorities (PO), compliance positions (CO).
