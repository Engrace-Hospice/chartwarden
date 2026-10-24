# Brief: privacy officer and counsel, 13 decisions on family messaging, voice, AI and outside partners

**Audience:** the privacy officer, and legal counsel for the items marked (counsel) · **Needs from you:** 13 short answers (yes / no / modify) · **Blocks:** ADR-0099 (family messaging, which cannot start any slice until Accepted), ADR-0094 (voice notes and dictation), ADR-0095 (AI summaries), ADR-0096 (partner share legal side); every vendor and business-associate agreement (BAA) these features would need.

> **Status (2026-10-23):** nothing here is a legal or privacy position; each default is a build-team proposal. **Nothing in ADR-0094, ADR-0095 or ADR-0099 is built** (no code, no migration, no flag). ADR-0096 is built flag-off. No SMS or email sending service exists in any environment (decision sheet row A2). The AI vendor agreement is recorded in the AI governance document (section 9.2) as "in progress"; its current status is **not verified** in the repository, so please state the real status. Index: [`README.md`](./README.md).

**How to answer:** tick one box per item. "Yes" accepts the recommended default exactly as worded; "Modify" accepts it with your change; "No" becomes a work item. Where the item says (counsel), please have counsel answer or confirm.

---

## A. Family and caregiver messaging without an app (ADR-0099; WP 6.7 gate "privacy officer + new ADR before build")

**In plain words.** A family member who will not make an account gets a one-time link from the care team; a code is given separately, by phone. They can then send text to a dedicated family inbox that staff answer. The link person is not a user of the system. No patient information goes in any text or email. Access ends the moment consent is withdrawn.

### PV-1. May a family member who is not a personal representative message the care team through a link at all? (ADR-0099, "Open questions" 1; D1, D2, D13)

- **Recommended default:** yes, for a person the patient (or representative) has consented to, who is a current caregiver on the record, when the care team creates the invitation after a phone call and confirms who they are. No consent, no link (the screen refuses with a reason code). The portal remains the preferred route (PO-3 asks the order).
- **Also asked:** the minimum identity proof for first activation (default: a live call from staff and the spoken code) and whether a family message belongs to the **designated record set**, reachable by access or amendment requests (default: yes, because it is kept as care-related communication for 7 years).
- **Consequence:** families who only text can reach the team; every message becomes part of what can be requested by the patient. If you answer no, WP 6.7 cannot proceed in this form.

**Stays blocked:** ADR-0099 acceptance; slices S1 to S7 (schema, routes, tests, screens, contact page, bereavement mode, automatic sending). **Unblocks:** S1 once also CL-18 and CL-20 are answered; the next free migration number is taken from `main` at slice time.

Answer: [ ] yes  [ ] no  [ ] modify (identity proof / record-set position): ____________  Name / role / date: ____________

### PV-2. Who counts as a personal representative, may staff reply to a permitted-but-not-representative contact, and Part 2 replies (counsel) (ADR-0099 Q2; D2, D10)

- **Recommended default for the build:** a contact marked as a legal representative with proof on file is treated as the patient for the scope of the consent; any other contact is a person the patient permitted under the "involvement in care" rule (45 CFR 164.510(b)), which allows sharing relevant information but is not a right of access. The module does not decide which relationships qualify in each state; the consent record does. A reply that confirms restricted (42 CFR Part 2) information to someone the restriction does not cover is refused by the same check used for care-team replies; a patient who is Part 2 restricted and not released to this person has no family thread at all.
- **Counsel to state:** which relationships qualify in each operating state; what staff may say to the non-representative contact; Part 2 consent mechanics for a reply; any state minor and guardian rules.
- **Consequence:** the product warns staff but cannot stop them saying too much to a permitted contact (ADR-0099 limit e).

Answer: [ ] default reading accepted  [ ] counsel list attached  [ ] modify: ____________  Name / role / date: ____________

### PV-3. SMS and email vendor, BAA and consumer-messaging law (counsel) (ADR-0099 Q3; D7, D17)

- **Recommended default:** **no automatic sending at all in the first slices.** The care team delivers the link by phone or copies it, as with partner invitations. Automatic sending (a later slice, S7) starts only after a BAA reference is recorded for the tenant, uses one fixed message with no arguments ("You have a new secure message from your care team. Open your link to read it."), a neutral sender name chosen by the agency, and never carries the code.
- **Counsel to decide:** vendor and BAA; consent for texting personal numbers (TCPA), STOP/HELP handling, carrier registration for a healthcare sender; whether a neutral sender name is enough (an agency name can reveal hospice care).
- **Consequence:** manual delivery is only as safe as the staff member delivering. Slice S7 cannot start without your answer; this also answers the partner-invitation sender question in PV-12.

**Stays blocked:** S7 and any automatic text or email. **Unblocks:** S7 planning.

Answer: [ ] manual delivery first, vendor later  [ ] vendor chosen: ____________ BAA ref: ________  [ ] modify: ____  Name / role / date: ____________

---

## B. Voice notes and dictation (ADR-0094; WP 6.3)

### PV-4. Is a voice recording acceptable as PHI in chat, and for how long? (ADR-0094 Q1; sections 1 and 4)

**Plain language.** A voice note is stored like any attachment (virus scan before delivery, same audit, same legal-hold rules). A recording also carries the speaker's voice, so it identifies more than the same words typed.

- **Recommended default:** allow voice notes as ordinary attachments (browser formats only, 5 minutes, 8 MB), keep them for the same period as the message (7 years for care-related), and do not add a shorter audio class now.
- **Consequence:** a shorter class would need a change to the retention rules (ADR-0086) and a migration; with the attachment-destruction setting off (its default), audio is never destroyed.

**Unblocks:** the voice-note slice together with CL-12, SE-14 and the operations answers in PO-11. No migration is needed for the default.

Answer: [ ] yes, 7 years like the message  [ ] no  [ ] modify (shorter class): ____________  Name / role / date: ____________

### PV-5. Which service, if any, may turn speech into text? (counsel) (ADR-0094 Q2 and Q7; section 2)

- **Recommended default:** **no dictation** until a server-side route inside a business-associate agreement exists. Browser speech recognition is rejected outright (audio goes to the browser maker). Typing and voice notes are the default. A future server-side route needs a signed agreement, zero data retention, no training on audio and a sub-processor list, and is switched on per tenant only after the agreement is confirmed to cover it.
- **Please state:** is the AI vendor's agreement (recorded "in progress") now signed, and does it cover audio, or is a separate speech vendor needed? Please also verify, not assume, that Chrome and Safari speech recognition cannot be covered by an agreement and that no supported browser has a dependable on-device mode.
- **Consequence:** until you answer, dictation (flag `messaging.dictation`) does not exist.

Answer: [ ] no dictation for now  [ ] route and vendor: ____________ BAA ref: ________  [ ] vendor facts verified (attach)  Name / role / date: ____________

---

## C. AI summaries and reply drafts (ADR-0095; WP 6.5; nothing built)

### PV-6. Vendor, region and zero-retention terms (counsel) (ADR-0095 open 7; decision 5)

- **Recommended default:** the feature stays unavailable ("AI unavailable") until an operator records, against a backend, a business-associate agreement reference that resolves to a non-expired agreement covering generative AI, and confirmed zero data retention. No fallback to any other vendor, ever. Local models only inside the same boundary.
- **Please state:** vendor, region, zero-retention terms, and whether some tenants require a local model.
- **Consequence:** this gate is what makes the feature safe to switch on; it is fail-closed by design.

**Stays blocked:** capability registration and all of WP 6.5. **Unblocks:** the M32 capabilities `messaging_summarize` and `messaging_draft_reply` (names are proposals).

Answer: [ ] default  [ ] vendor / region / terms: ____________ BAA ref: ________  Name / role / date: ____________

### PV-7. Messages under legal hold or pending redaction (counsel) (ADR-0095 open 2; decision 1.3)

- **Recommended default:** such messages are **not** sent to the model (a placeholder "message withheld" keeps the order truthful, and the screen says how many were left out). Sending a held message to a vendor is a new disclosure that is not needed.
- **Alternative:** include them under a hold-aware policy.
- **Consequence of the default:** a summary of a held thread is incomplete by design. (The partner-share rule is stricter still: any redaction row hides a message; see ADR-0096 D8.)

Answer: [ ] exclude  [ ] include with policy: ____________  Name / role / date: ____________

### PV-8. Part 2 channels (ADR-0095 open 4; decision 1.3)

- **Recommended default:** refuse every channel whose patient is substance-use flagged, in the first version.
- **Alternative:** allow only when a release explicitly covers AI processing.
- **Consequence:** no AI summary for those patients; no consent mechanism to build.

Answer: [ ] refuse all  [ ] allow with consent covering AI: ____________  Name / role / date: ____________

### PV-9. Pseudonymising what the model sees (ADR-0095 open 3; decision 1.4)

- **Recommended default:** senders become role tokens ("[RN]", "[SW]", "Sender A"), the patient is "[PATIENT]", and times become relative ("2 hours before the last message"). This is done by code, not by asking the model.
- **Consequence:** less identity leaves the system; summary quality may drop. Reversing it later is an ADR change.

Answer: [ ] yes  [ ] no, send real names  [ ] modify: ____________  Name / role / date: ____________

### PV-10. Keeping the encrypted AI call record for 7 years (ADR-0095 open 6; decision 7)

- **Recommended default:** the only server copy of a summary is the encrypted call record in the AI ledger (kept 7 years, which also answers disclosure accounting); the messaging module stores nothing. A summary of a held thread is therefore itself retained.
- **Alternative:** a shorter class for messaging prompts.
- **Consequence:** prompts that contain message text live 7 years; the erasure path for a patient request was not re-checked here.

Answer: [ ] 7 years  [ ] shorter class of ___ years  Name / role / date: ____________

---

## D. External partner share (ADR-0096; built flag-off)

### PV-11. Is a typed BAA reference enough, and which partners? (counsel) (ADR-0096 open 1; limit g)

- **Recommended default:** a free-text reference (1 to 120 characters) that the creator attests exists; the platform cannot verify it. Partner kinds are pharmacy, equipment and others the agency chooses; it is a small allowed list only if you say so.
- **Alternative:** require a partner directory with a stored agreement before any share.
- **Consequence of the default:** a share can be created against a contract that does not exist; the audit trail records who attested. A directory is a new build (no slice or migration number exists).

Answer: [ ] free-text reference  [ ] require partner directory first  [ ] allowed partner kinds: ____________  Name / role / date: ____________

### PV-12. Who sends the invitation and the "new message" text to a partner, and under which agreement? (ADR-0096 open 5 and 12; D9)

- **Recommended default:** the platform sends nothing. The staff member hands over the link and, by a different route (a phone call), the 8-digit code; the screen says so. If a sender is ever built it may send one fixed sentence with no arguments.
- **Consequence:** safe but manual. Same vendor question as PV-3.

Answer: [ ] manual only  [ ] vendor (same as PV-3)  [ ] other: ____________  Name / role / date: ____________

### PV-13. Part 2 in ordinary channels that can be shared (ADR-0096 limit m)

- **Today:** only care-team and bereavement channels are excluded. A discipline, location or on-call channel is **not** Part 2 gated and names in free text are not detected, so a restricted discussion in an ordinary channel could reach a partner.
- **Recommended default:** accept for now, because the share is documented as for non-clinical coordination and the creator confirms "minimum necessary"; revisit if any tenant shares clinical channels.
- **Alternative:** add a block for any channel that has referenced a restricted patient (a new build, no slice yet).

Answer: [ ] accept  [ ] add the block  [ ] modify: ____________  Name / role / date: ____________

---

*Not in this brief:* compliance rules for export, analytics and retention (CO), security controls (SE), clinical wording (CL), flags and priorities (PO). See [`README.md`](./README.md).
