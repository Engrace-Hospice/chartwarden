# Brief: compliance officer, 19 decisions that move six messaging features out of "Proposed"

**Audience:** the compliance officer (HR joins CO-10 to CO-12) · **Needs from you:** 19 short answers (yes / no / modify) · **Blocks:** acceptance of ADR-0082 (restricted channels), ADR-0084 (drafts), ADR-0085, ADR-0089, ADR-0092, ADR-0096, ADR-0097, ADR-0098; the thread-read build (slices G2, G3); switching on export, response analytics, partner share, acknowledge-required broadcast and the death board for any real tenant.

> **Status (2026-10-23):** every item below is a **build-team default**, not a compliance position. Nothing here is decided. Most of these features are already built flag-off (see the "Unblocks" line of each item); the answer decides whether a tenant may switch them on and whether the ADR can move from Proposed to Accepted. A blank answer leaves the default in force and the flag off. Items already settled elsewhere (for example C1 to C3 and D4 in [`../11-decision-sheet.md`](../11-decision-sheet.md)) are not repeated here. Index of all briefs: [`README.md`](./README.md).

**How to answer:** for each item tick one box. "Yes" means you accept the recommended default exactly as worded. "Modify" means you accept the idea with your change. Your answers are copied into the owning ADR (with your role and date) and into the decision sheet; a "No" becomes a work item.

---

## A. Reading a patient thread you are not a member of (E5)

### CO-1. Is a system-issued, time-limited read grant acceptable at all? (ADR-0085, "Open questions" Q1 and Q7; decision-sheet row E5)

**Plain language.** When an urgent request escalates to an on-call nurse who is not on the patient's care team, today the system skips that nurse, so nobody may be able to acknowledge. The product owner chose (2026-10-19) to keep that skip as the default and also add a narrow exception: the system lets that one person read that one thread for a short time, and every read is recorded. The product owner's choice is recorded; **your concurrence is not**.

| Option | Consequence |
|---|---|
| **A (recommended default).** Accept the design in ADR-0085: the system issues the grant automatically on escalation, reassignment or an after-hours role send; one thread only, never the channel; read-only; the 42 CFR Part 2 check is repeated on every read. | The after-hours on-call can be alerted and can acknowledge. They see one thread for a limited time. |
| B. Use the existing emergency-access ("break-glass") record instead, issued by the system. | One register of access exceptions, but ADR-0085 warns it would flood the break-glass review queue with routine routing and blur its meaning. |
| C. Decline. Keep only the skip. | Nothing new to review. An off-team on-call nurse stays skipped, so their request cannot be acknowledged (the biggest practical gap in WP 4.13). |

For a restricted (Part 2) channel the grant is never created unless the Part 2 consent check says yes; this is not a choice you are asked to relax.

**Stays blocked until answered:** slices G2 (grant wiring) and G3 (grant web view) of ADR-0085; the "off-team on-call" half of WP 4.13 acceptance (S6). **Unblocks:** G2, G3 (G1, the table, migration 1135, is already built and unwired). Security concurrence is asked separately in SE-8, clinical concurrence in CL-5.

Answer: [ ] A, yes  [ ] B  [ ] C, no  [ ] modify: ____________  Name / role / date: ____________

### CO-2. How long does a grant last? (ADR-0085, Q2)

**Plain language.** The grant needs an end time. The build uses 4 hours as a placeholder because the emergency-access record also defaults to 4 hours. It is **not** a clinical or compliance position.

- **Recommended default:** 4 hours, settable per organisation between 1 and 168 hours (the built setting `thread_access_grant_hours`; the database refuses anything above 7 days).
- **Consequence:** shorter means an on-call nurse may lose the thread mid-shift (a new grant needs a new escalation); longer widens how long a non-team person can read. Expiry cuts the read; it does not recall what was already seen.

**Stays blocked:** the value stays a placeholder; G2 may not ship with it unsigned. **Unblocks:** the final default for G2.

Answer: [ ] yes, 4 hours, bounds 1 to 168  [ ] no  [ ] modify to ___ hours, bounds ___ to ___  Name / role / date: ____________

### CO-3. Attachments in a granted thread, and who reviews the access trail (ADR-0085, Q3 and Q6)

**Plain language.** (a) May the person with a grant also open the thread's attachments? (b) The system records the grant, each read and the expiry, with the request id and no message text. Who looks at those records, and how often?

- **Recommended default for (a):** no attachments (attachments are the highest-risk content). **For (b):** the compliance officer reviews grant events through the normal audit review; no new report is built until you say the cadence.
- **Consequence:** with no attachments an on-call nurse cannot open a photo or document inside the thread; with no named reviewer the trail exists but nobody is assigned to read it.

**Stays blocked:** G2/G3 scope. **Unblocks:** G2/G3 final scope.

Answer (a): [ ] no attachments  [ ] allow  [ ] modify: ____  Answer (b) reviewer and cadence: ____________  Name / role / date: ____________

---

## B. Restricted (Part 2) channels and after-hours triage

### CO-4. When the patient's channel is Part 2 restricted, what may the after-hours request do? (ADR-0082, "Implementation notes", restricted channels, and Q8)

**Plain language.** For a restricted channel the build is fail-closed: the urgent message and its acknowledgment request still go, but **no triage-call request is sent** (the request names the patient) and **no result line shows**. The sender gets the plain send result with no refusal and no extra message. Two things are open: (1) may a restricted patient's id ever travel to the on-call module, and (2) must the sender be told that no triage call was requested? Also (3): a withheld line in a restricted channel still shows that a row exists; is even that acceptable?

| Option | Consequence |
|---|---|
| **A (recommended default).** Keep fail-closed: no event, no line, no message to the sender. | Safest for disclosure. A sender in a restricted channel may believe a triage call was opened when none was. |
| B. Keep no event, but tell the sender "no triage call was requested for this patient". | The sender knows to phone. The message itself reveals that the patient is restricted. |
| C. Allow the id to travel to the on-call module under the Part 2 consent check. | After-hours routing works for restricted patients. Needs your written Part 2 reading. |

**Stays blocked:** removing the "OPEN COMPLIANCE QUESTION" flag from ADR-0082; S6 acceptance for restricted patients. **Unblocks:** a final rule for slice S3/S4 behaviour.

Answer: [ ] A  [ ] B  [ ] C  [ ] modify: ____________  Name / role / date: ____________

---

## C. Export (ADR-0089). Built (migration 1147, slices S1 to S5), flag `messaging.export` off. Five open items, none answered.

### CO-5. Who may request and approve an export? (ADR-0089, "Open human items" 1; D2)

- **Recommended default:** `compliance_officer`, `administrator`, `org_admin`, and nobody else. Requester and approver must be different people (database-enforced). Clinical roles hold none.
- **Consequence:** a clinician cannot export; if your agency has no separate administrator account, a second person must be created before any export can be approved. One human with two accounts could still approve their own request (ADR-0089 limit h; see SE-15).

Answer: [ ] yes  [ ] no  [ ] modify roles: ____________  Name / role / date: ____________

### CO-6. Messages under a legal hold (ADR-0089, item 2; D3)

- **Recommended default:** exclude them and count them in the manifest (`heldExcluded`). A disclosure that needs held messages is a manual compliance process.
- **Alternatives:** include them; or include only with the legal-hold owner's approval.
- **Consequence of the default:** an export for a legal inquiry is incomplete by design and says how many were left out.

Answer: [ ] exclude and count  [ ] include  [ ] include with hold-owner approval  [ ] modify: ____  Name / role / date: ____________

### CO-7. Part 2 content in an export (ADR-0089, item 3; D3)

- **Recommended default:** exclude and count (`part2Excluded`). If the Part 2 status cannot be read, the export fails rather than guess. Free-text mentions of a patient with no structured link are **not** detected (ADR-0089 D3).
- **Alternative:** a separate Part 2 consent path.
- **Consequence:** a records request that needs substance-use-related messages cannot be met by this tool.

Answer: [ ] exclude and count  [ ] separate consent path (describe): ____  [ ] modify: ____  Name / role / date: ____________

### CO-8. Format, link life and size (ADR-0089, item 4; D4)

- **Recommended default:** one JSON file, attachment details only (no attachment files), link valid 24 hours after the file is ready, at most 50 000 messages or 200 MB per job, 3 live jobs per requester and 10 per day.
- **Consequence:** not human-readable (a PDF is a later slice, not scheduled); too-large requests fail after approval with `EXPORT_TOO_LARGE`; the 24 hours and 50 000 are defaults, not agreed values.

Answer: [ ] yes  [ ] no  [ ] modify (format / hours / size): ____________  Name / role / date: ____________

### CO-9. Concurrence on decisions D1 to D9 as a whole (ADR-0089, item 5)

Do you concur with the nine decisions (two people, who, left-out content, format, scope, artefact encryption, flag and refusals, events and audit, what is never exported)? **Unblocks:** moving ADR-0089 to Accepted and switching `messaging.export` on for a tenant. Clinical-lead concurrence is also listed in the ADR but is not asked in this brief (export is a compliance process).

Answer: [ ] concur  [ ] concur with changes: ____________  [ ] do not concur  Name / role / date: ____________

---

## D. Response analytics (ADR-0092). Built (migration 1170), flag `messaging.response_analytics` off. HR joins CO-10 to CO-12.

### CO-10. The smallest group a figure may describe (ADR-0092 D6)

**Plain language.** A response-time figure is only shown when at least 5 different people and at least 20 requests stand behind it, and no one person accounts for more than 80 percent. Otherwise it is hidden. These numbers follow common practice; they are **not** a compliance decision.

- **Recommended default:** 5 people, 20 requests, 80 percent. Raising the numbers needs no sign-off; lowering them does.
- **Consequence:** small agencies (fewer than five clinicians answering) will see "insufficient data" for most figures. That is the intended privacy behaviour.

Answer: [ ] yes  [ ] no  [ ] modify to ___ people / ___ requests / ___ percent  Name / role / date: ____________

### CO-11. Closing the "difference two windows" gap (ADR-0092 D6, "Remaining residue")

**Plain language.** A person allowed to query repeatedly can ask for the last 30 days and the last 31 days and subtract: that leaves one day, and on a quiet day it can approach one person's record. The code does not stop this.

| Option | Consequence |
|---|---|
| **A (recommended default for you to confirm or replace).** Keep as is, limit the permission to the three roles (compliance officer, administrator, org admin) and rely on the on-screen note. | Cheapest. The exposure remains and rests on trust in three roles. |
| B. Minimum window of 7 days, week-aligned windows. | Closes day-by-day differencing; needs a small follow-up change. |
| C. A distinct-people floor on the increment between windows. | Stronger, more complex change. |
| D. A per-user query budget. | Slows probing; does not remove it. |

**Unblocks:** the follow-up change named in ADR-0092 "Not done / open" (no migration expected; windows are computed in the reader).

Answer: [ ] A  [ ] B  [ ] C  [ ] D  [ ] modify: ____________  Name / role / date: ____________

### CO-12. Who holds the analytics permission, and HR review (ADR-0092 D7, "Not done / open")

- **Recommended default:** `messaging.analytics.read` held by compliance officer, administrator and org admin only; tenants may grant it wider. HR/compliance reviewed once, before any tenant switches the flag on, that a per-discipline median over 5 people is acceptable to staff representatives.
- **Consequence:** supervisors cannot see the numbers unless a tenant grants the key. Individual views, rankings and use in performance management are forbidden by the ADR (D10) regardless of your answer.

Answer: [ ] yes  [ ] no  [ ] modify holders: ____________  HR / compliance review done on (date): ________  Name / role / date: ____________

---

## E. Retention and audit

### CO-13. What happens to the unsent drafts of someone who has left (ADR-0084, "Open human decisions" 2; co-owner: privacy officer)

- **Recommended default:** keep them unreadable for the organisation's messaging retention period, then delete through the retention job (ADR-0086); never hand them to a supervisor. Today they are kept, never shown, only counted.
- **Consequence:** a supervisor cannot recover useful clinical text from a leaver's draft. The retention job must first learn the draft table (a follow-up change); until then drafts simply stay.

**Unblocks:** that follow-up change (no migration number assigned; take the next free one from `main` at build time).

Answer: [ ] yes  [ ] no  [ ] modify: ____________  Name / role / date: ____________

### CO-14. Retention of session revoke records (ADR-0083, "Open questions" 5)

- **Recommended default:** the audit rows `m36.session.revoked` and `m36.session.admin_listed` are kept 7 years, like the other `m2.*` session events. Please confirm.

**Unblocks:** removing this item from ADR-0083's open list (no code change).

Answer: [ ] yes, 7 years  [ ] no  [ ] modify: ____  Name / role / date: ____________

---

## F. Acknowledge-required broadcast (ADR-0097). Built flag-off (migrations 1200, 1202), flag `messaging.ack_broadcast`.

### CO-15. Audience, late joiners and who can see the non-acknowledgers (ADR-0097 D3 to D5; "Not done / open" 1 and 5)

**Plain language.** (1) The audience is every active member of the organisation except the author, frozen when the author asks for acknowledgment. (2) Someone who joins later is not asked (but is counted on the supervisor view). (3) Only the **author** can see who has not acknowledged; nobody above the author can, so a manager cannot take over when the author leaves.

- **Recommended default:** keep (1) and (2); for (3), do not add an override yet, and accept that a leaver's broadcast cannot be chased by anyone else until you name a role (for example the compliance officer).
- **Consequence of the default:** simplest and least exposing; the cost is the orphaned-broadcast case. If you name an override role, it needs a new permission and a small change (no migration number assigned yet).
- **Note on a stated guardrail:** the phase plan (WP 6.8) says "supervisor sees every non-reader". ADR-0097 D5 deliberately does **not** do that. Please say whether the ADR's narrower rule is acceptable or the plan's wording must be met.

Answer: [ ] accept D3 to D5 as built  [ ] add override role: ____  [ ] modify: ____  Name / role / date: ____________

### CO-16. Is "acknowledged" a compliance attestation? (ADR-0097 "Not done / open" 4; D8; D10)

- **Recommended default:** no. The screen says acknowledged means the person pressed the button, not that they understood or were trained. No step-up, no export, no retention class for these rows.
- **Consequence if you answer yes:** the feature needs a second-factor step on acknowledging, an export, a retention class for the rows, and wording that matches your policy; each is a new decision and build.

Answer: [ ] no, not an attestation  [ ] yes, used as attestation (list requirements): ____  Name / role / date: ____________

---

## G. Death-event board (ADR-0098). Built flag-off (migration 1201), flag `messaging.death_board`.

### CO-17. Who can see a board, and the coordination-only position (ADR-0098, "Open sign-offs" 3)

**Plain language.** A board is visible only to people the Part 2 check admits **and** who are a supervisor (`messaging.review` holders), the current owner of an item, or on the patient's care team; everyone else gets "not found". Reads are audited. Completing an item records that a person says the work is done; it does **not** write to the chart.

- **Recommended default:** accept the visibility rule (D7), reuse of the existing supervisor key `messaging.review` (no new permission), the audit scrub list (the patient column is blanked in the audit row), and the statement that the board is coordination only and must not be cited as proof that any chart task was done.
- **Consequence:** supervisors are exactly the `messaging.review` holders; if you want a narrower group, a new permission is needed.

Answer: [ ] accept all four  [ ] accept with changes: ____________  [ ] no  Name / role / date: ____________

---

## H. External partner share (ADR-0096). Built flag-off (migration 1180), flag `messaging.external_partners`.

### CO-18. Concurrence on D1 to D12, and telling staff a partner can read (ADR-0096, "Open human items" 7 and 6)

- **Recommended default:** concur with D1 to D12 (one conversation, only messages posted after the share, clinical content structurally excluded, 7-day default and 30-day maximum expiry, instant revoke, partner has no user account, every read audited, legal-hold and redaction rules, no PHI out of band, limits, flag and permission, uniform refusals). The live banner on the channel (D18) is enough to tell staff; no system message is written into the channel.
- **Consequence:** until you concur, no tenant should switch the flag on. Free-text patient names are **not** detected (only a partial identifier filter, D16); the creator confirms a "minimum necessary" statement.

Answer: [ ] concur  [ ] concur with changes: ____  [ ] banner is enough  [ ] also write a system message  Name / role / date: ____________

### CO-19. If partners could reply: your positions (ADR-0096 D25 R5 to R7; "Open human items" 2)

Partner replies are a **design only**, not built (migration 1203 is reserved and unused). Before anyone builds it, your answers on:

- **R5 reject or withhold:** recommended default is to **reject** a reply that looks like it contains a personal number (the partner is told it was not sent), not to store it and hide it from staff. Consequence: the partner can probe what the filter catches; the alternative silently drops a safety message.
- **Storing partner-typed text in the record** (up to 2 000 characters, plain text, staff-visible with an "External" badge): acceptable?
- **R6 exclusion:** external replies are kept out of search and out of any AI prompt. Confirm.
- **R7 notification:** recommended default is at most one fixed generic notice ("New message in a shared conversation") per channel per 15 minutes to members who have the channel unmuted. Or none?

**Stays blocked:** slice S8 (partner replies, flag `messaging.external_partner_replies`, migration 1203 plus an enum split). **Unblocks (with CL-14):** the decision whether S8 is built at all.

Answer: R5 [ ] reject  [ ] withhold  [ ] modify  ·  storing [ ] yes [ ] no  ·  R6 [ ] confirm [ ] modify  ·  R7 [ ] fixed notice [ ] none [ ] modify  ·  Name / role / date: ____________

---

*Questions that belong to others and are NOT in this brief:* BAA and vendors (privacy officer and counsel, [`brief-privacy-officer-counsel.md`](./brief-privacy-officer-counsel.md)); session policy, bearer and headers (security, [`brief-security.md`](./brief-security.md)); clinical wording and checklists (clinical lead, [`brief-clinical-lead.md`](./brief-clinical-lead.md)).
