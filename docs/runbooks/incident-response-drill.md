# Runbook: incident-response tabletop drill kit (CW-IR-01)

How the security officer proves, with the real responders, that the incident procedures in
[`CHARTWARDEN_DR_BCP_v0.1.md`](../architecture/CHARTWARDEN_DR_BCP_v0.1.md) and
[`CHARTWARDEN_OPS_RUNBOOK_v0.1.md`](../architecture/CHARTWARDEN_OPS_RUNBOOK_v0.1.md) work when people have to use them. This
file is the facilitator's guide: ground rules, roles, script, clocks and scoring. The three scenarios and their injects are in
[`incident-response-drill-scenarios.md`](./incident-response-drill-scenarios.md); the record you file afterwards is
[`audit/incident-drill/TEMPLATE-drill-record.md`](../../audit/incident-drill/TEMPLATE-drill-record.md).

> **Status: the kit exists; no drill has been run.** Compliance register row `CW-IR-01` stays `partial` until the security
> officer runs at least one scenario with the real responders and files a signed record under `audit/incident-drill/`. Nothing in
> this repository is, or substitutes for, that record. A filled-in template that nobody ran is a false record: don't create one.

## 1. Ground rules (read aloud at the start)

A tabletop is a discussion. It changes no system and tells no one outside the room anything.

- **Nothing outward-facing is done.** No status-page post, customer or covered-entity email, vendor ticket, regulator or
  law-enforcement contact, insurer call, or counsel call. Each one is *drafted* and the drafting time recorded; the facilitator
  plays the recipient. Prefix every draft `[DRILL]`.
- **Nothing is run against production.** Participants say which command, route or screen they would use and what they expect to
  see; the facilitator answers from the inject card. Do not read a real secret, a real audit row or a real backup to "check".
- **Synthetic data only.** Patients, tenants, operators and addresses in the injects are invented. Participants must not bring a
  real patient name, identifier or screenshot into the room, and must not substitute one. Addresses in the cards are RFC 5737
  documentation ranges; mail domains are `example.org`.
- **No contact details in the repo.** The roster (section 3) records roles and "reached / not reached"; the phone numbers and
  personal addresses stay in the responders' own tooling and wherever the owner keeps the contact list (OPS Appendix A.3 and DR/BCP
  section 9.4 plan one; neither exists yet), never in a record.
- **No blame, and no rescue.** The facilitator does not hint at the answer. If the group cannot name the document, command or
  person, that *is* the finding. Write it down and move on.
- **A real incident preempts the drill.** If a real SEV-1 or SEV-2 is open, stop and reschedule.

## 2. Roles

The roles are the ICS roles of DR/BCP section 2.1, plus three that only a drill has. Name a person for each (in the record: the
role, never a personal contact) and a stand-in. **DR/BCP section 2.1 records that one person currently holds IC, Technical Lead,
Communications Lead and Compliance Officer.** A drill run alone proves nothing about that arrangement: have at least a facilitator
and a scribe who are not the person playing IC, and record who the stand-in would be if the owner were unreachable (the second
operator the plan says is "TBD").

| Role | Does in the drill | Checklist (tick as it is observed, not as it is claimed) |
|---|---|---|
| **Facilitator** | Runs the script, reads injects, keeps time, answers from the cards, never hints | [ ] ground rules read; [ ] every inject read in order; [ ] clock stamps called out; [ ] hot wash run |
| **Scribe** | Writes the timeline and decisions into the record as they happen | [ ] every decision has a time, a role and the document it came from; [ ] gaps listed verbatim |
| **Incident Commander (IC)** | Declares, sets severity, owns every decision | [ ] severity named with the reason; [ ] reclassified when facts change; [ ] roles assigned out loud; [ ] approvals per DR/BCP section 2.4 asked for from the right role |
| **Technical Lead** | Names containment, evidence preservation and recovery steps | [ ] first containment lever named; [ ] evidence preserved before anything is destroyed or rotated; [ ] the exact document section or route cited |
| **Communications Lead** | Drafts status page, covered-entity and internal messages | [ ] drafts use the DR/BCP section 9.2 templates; [ ] no PHI, key material or exploit detail in any draft; [ ] next-update time stated |
| **Compliance Officer** | Runs the breach assessment and notification decisions | [ ] discovery time fixed; [ ] four-factor assessment started in writing; [ ] covered entity named per affected tenant; [ ] counsel and forensic-firm decisions routed to IC |
| **Counsel (played or real)** | Answers legal questions raised in the injects | [ ] engaged within the OPS section 14.4 target |
| **Customer liaison (played)** | A tenant's breach-notification contact and compliance officer | [ ] reached via the contact recorded at provisioning (OPS section 18.1), not an ad-hoc one |
| **Observer** *(optional)* | Watches, does not speak; confirms the facilitator did not hint | [ ] no hints observed |

## 3. Roster check (do this before the drill, record the result, never the numbers)

For every role above, fill one row in the record's roster table: role, primary and stand-in *by role title*, how they are paged
(channel only), whether the page was **actually tested this month** and how long they took to answer. Untested counts as
"unknown", and the record says so. Also confirm, by looking and not by remembering, that each responder can reach what the injects
will ask for: the status-page admin, the incident channel, the alert webhook (`OPS_ALERT_WEBHOOK_URL`, DR/BCP section 4.8.4),
the sealed envelope's location (OPS section 8.5) and the escrow location of the backup keys (DR/BCP section 4.8.5). Check that each
exists and who can reach it; **never open the envelope, print the webhook URL or read a key** to prove it.

## 4. Before the drill (T minus 14 days to T minus 1 day)

- [ ] Date, place and a 3-hour block per scenario fixed (90 minutes of play for scenario 1, 120 for scenarios 2 and 3, 30 of hot
      wash, slack). Run one scenario per sitting.
- [ ] Facilitator, scribe and the role-holders named; each told the ground rules in writing. The facilitator is not the IC.
- [ ] No release, migration or maintenance window (OPS section 2.3) overlaps; no real incident open.
- [ ] Pre-read sent: DR/BCP sections 2, 9, 10.4 and 4.8.5; OPS sections 8.2.4, 14 and 18.3. The scenario sheet is **not** sent.
- [ ] Printed or open on a second screen: the section 9.2 status templates, the section 9.3 breach rule, the OPS secret
      inventory (8.1), the DR/BCP forensic queries (14A.3). Participants use the documents, not memory.
- [ ] A copy of the record template made under `audit/incident-drill/` with the header filled in.
- [ ] A timer visible to the room. Clock fields (section 6) are read off it.

## 5. Facilitator script (one scenario; times are from the start of the sitting)

| Time | Facilitator does | Says (adapt, don't improvise facts) |
|---|---|---|
| 0:00 | Read the ground rules (section 1) | "This is a drill. We will not touch production or contact anyone outside this room. Everything we send, we draft." |
| 0:05 | Assign roles; scribe starts the record; timer starts at **T0** | "Roles: ... At T0 I read the first card. Say what you do, which document or route you use, and who does it." |
| 0:10 | Read inject 0 (the scenario card's first row) | Read it verbatim. Stamp T0. Then stay silent for the first 60 seconds: the *first* response is the detection finding. |
| 0:10 to end of play (1:40 for scenario 1, 2:10 for scenarios 2 and 3) | For each inject: read it, ask **"Who does what, using which document or command, by when?"**, let the group answer, ask the probes on the card, stamp the clock fields as events happen, then reveal the outcome and the next inject | Use only the facts on the card. A fact not on the card is "unknown, and it would take you <time> to find out": make the group say how. |
| Every 15 min | Re-read the elapsed time and the next-update commitment the Communications Lead made | "It is T plus 45. Your status update was promised at T plus 30. Is it out?" |
| End of play | Declare **stand-down**: ask who stands down the incident, what the exit criteria are, and when the post-incident review is due (DR/BCP section 9.2.3: 7 days) | |
| End of play + 5 min | **Hot wash** (30 min): what went well; what you could not find; what you did from memory instead of the document; what the runbook said that is wrong; who was missing | The scribe lists every item as a finding with an owner and a date before the room breaks up. |
| End of play + 35 min | Close: read the findings back; confirm who files the record and by when (section 8) | |

**Handling a stuck room.** If nothing happens for two minutes, ask "What does the runbook say the first step is?" If the group
cannot find it, mark the inject **not found**, tell them the section, and continue; do not skip the inject.

**Handling a runbook that is wrong.** If a participant follows the document and the document is wrong (a command that does not
exist, a host the single-host stack does not have, a missing step), do not correct them mid-inject. Record it as a runbook
defect with the section, finish the inject on the right answer, and fix it in the follow-up (section 8).

## 6. Clock fields

The scribe stamps each field as minutes and seconds after **T0** (the moment inject 0 is read). A field with no event is
written "not reached", never left blank. The targets are the plan's own where it has one; the rest are provisional and **OPEN**
(the owner sets them at the first drill).

| Field | Meaning | Target | Source of the target |
|---|---|---|---|
| `t_first_action` | first response to inject 0 | 5 min | OPS section 14.2 (acknowledge a SEV-1 within 5 minutes) |
| `t_declared` | an incident is declared, with a severity | provisional 15 min from T0 | OPEN |
| `t_ic` | an IC is named and has accepted | 5 min after declaring SEV-1 | DR/BCP section 2.3 (no start event is defined there; the kit reads it from the declaration, and the owner confirms) |
| `t_tech_lead` | a Technical Lead is engaged | 15 min after declaring SEV-1 | DR/BCP section 2.3 (same reading) |
| `t_containment_decided` | the first containment lever is chosen and its approver named | provisional 30 min from T0 | OPEN |
| `t_evidence_preserved` | the log, audit and system state to keep is named *before* anything is rotated or destroyed | before the first irreversible step | DR/BCP sections 10.4.1 and 10.4.2 |
| `t_counsel_compliance` | Compliance Officer and counsel engaged on a suspected breach | 60 min from T0 | OPS section 14.4 |
| `t_first_status_draft` | first status-page or customer message drafted | 15 min after declaring SEV-1 | DR/BCP section 2.3 |
| `t_scope_known` | the group can state what was exposed, to whom, and for how long, or says it cannot and how it will find out | provisional 90 min from T0 | OPEN |
| `t_assessment_drafted` | written four-factor assessment, with a recorded owner for the conclusion | provisional 120 min from T0 | OPEN; the legal limit is 60 days from discovery (DR/BCP section 9.3) |
| `t_ce_notice_drafted` | draft notice to each affected covered entity | within the BAA's deadline; never later than 60 calendar days from discovery | DR/BCP section 9.3 |
| `t_stand_down` | the IC stands the incident down, with exit criteria | n/a | n/a |
| `t_pir_due` | post-incident review date set | 7 days after resolution | DR/BCP section 9.2.3 |

## 7. Scoring

Per inject, the scribe marks each **expected action** on its card: **done** (named, with the right document or route, by the
right role), **partial** (named but wrong role, wrong document, or after a prompt) or **not found** (the facilitator had to give
it). Then:

- The drill is **complete** when every inject was read and every clock field is either stamped or "not reached" with a reason.
- A drill with findings is a valid record. A drill with no findings is suspicious: re-read the scribe's gap list.
- A finding is **blocking** if the responders could not have contained the incident or met a legal deadline with the procedures as
  written (for example, a key they must rotate has no rotation procedure), and **non-blocking** otherwise. Every finding gets an
  owner role and a due date in the record before it is filed. Blocking findings need a runbook or product change tracked in an
  issue, not a note.

## 8. After the drill

1. **File the record** in `audit/incident-drill/<YYYY-MM-DD>-<scenario>.md` within `<N>` working days (OPEN: the owner sets N),
   signed by the security officer and the facilitator. No PHI, no key material, no contact numbers, no real names beyond role
   titles. Retain it 6 years with the other contingency-plan evidence (45 CFR 164.316(b)(2)(i); DR/BCP section 9.3).
2. **Turn findings into actions**: runbook defects are fixed in `docs/architecture/` or `docs/runbooks/` in a follow-up PR
   that cites the record; product or infrastructure gaps are filed as issues.
3. **Tell the register.** The security officer decides whether the control's status changes (`compliance/controls.yaml`, row
   `CW-IR-01`): one scenario run is evidence of an exercise, not of the whole plan, and the row's gap text should say which
   scenarios have and have not been run. An edit to the register asks for human approval.
4. **Re-run** the scenarios whose findings were blocking once the fix is in.

**Cadence (provisional, OPEN, the owner decides).** All three scenarios before the first real patient data; then each scenario at
least annually (one per quarter is the lightest way to do that), and one within 30 days after any SEV-1 using that incident as
the scenario. This sits beside the restore and failover drills of DR/BCP section 8.

## 9. What this kit does not do

- It does not test the *tools*: paging, the status page, the alert webhook and the backup restore are tested by their own drills
  (DR/BCP sections 8.2 and 8.3; `bun run backup:coordinated-drill`). The roster check in section 3 only asks whether they were
  tested.
- It is not a legal opinion. The breach-notification text in DR/BCP section 9.3 is engineering's reading of 45 CFR 164.400 to
  164.414; counsel confirms it, and the drill is the place to find out whether counsel is reachable.
- It does not replace a live exercise of the messaging escalation fallback, which has its own drill
  ([`messaging-escalation-fallback.md`](./messaging-escalation-fallback.md), section 7).
