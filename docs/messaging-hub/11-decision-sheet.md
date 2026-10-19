# M36 messaging hub: decision sheet (open sign-offs)

**Status:** draft, 2026-10-19. **Nothing here is decided, except B7**, which records a decision already taken (see the row). Every "Default" below is an engineering placeholder that the built code
or the runbook already uses; it is not a clinical, compliance or legal position. Fill the last column, then the answers are written
into the ADRs and the brief as decided (the brief keeps the full wording of each question: section numbers in the Source column).

**How to use:** one row per decision. Write the answer in *Decision* (accept the default, edit it, or reject it), add your name,
role and date. A blank row stays OPEN and the default stays provisional. Row A1 is the stated go-live precondition (A2 to A4 support it). Rows in section E gate work that has not started.

Owners: **CL** clinical lead / medical director, **COMP** compliance or Part 2 review, **OPS** operations, **M19** the (not yet named)
owner of on-call and the `EscalationRouter` seam, **SEC** security architect, **PO** product owner.

**This sheet is a subset.** It lists the main decisions only. The full set of open questions, with their exact wording, stays in
`brief-clinical-lead-signoff.md` (§3, §7, §8, §11, §13) and `brief-m19-owner.md`; items not listed here (for example the emergency
carve-out, the incident-log location, the flag-off rule, the offboarding inheritor, vacation forwarding, urgent-class SMS timing and
the M19 role-level lookup) are still OPEN there.

## A. Before any tenant turns the flags on (go-live)

| # | Decision | Owner | Default (provisional) | What the default means | Source | Decision |
|---|---|---|---|---|---|---|
| A1 | Who watches the unacknowledged queue and the operations numbers at night and at weekends | CL + OPS | none named | Nothing pages a phone today. Until a named watcher exists, no tenant should enable `messaging.ack_requests`, `messaging.urgent_clinical` or `messaging.escalation_timers`, or use the important, urgent and critical-symptom classes in production | brief §13; runbook top | |
| A2 | A real sending service (SMS / push vendor) for supervisor pages and out-of-band alerts | OPS + PO | none exists in any environment | The platform side is built (ADR-0079). A planned page fails with `transport_not_configured`. An operations notice is not a watcher | ADR-0079; brief §13 | |
| A3 | Who can set the messaging flags per tenant (the tenant, or the platform owner) | OPS | unconfirmed | Needed before the drill and before go-live | brief §13 | |
| A4 | Is "no watcher, no flags" the right go-live condition | CL | yes | See A1 | brief §13 | |

## B. Escalation and paging (built; values need signing)

| # | Decision | Owner | Default | What the default means | Source | Decision |
|---|---|---|---|---|---|---|
| B1 | Who is paged about a request nobody can reach | CL | roles `clinical_supervisor` and `don` | In-app alert now; push (and SMS for critical) to their verified endpoints once a transport exists. A tenant can re-aim the rule; the "unpaged" notice does not detect re-aiming | ADR-0079; brief §13 | |
| B2 | Reminder schedule for an undeliverable request nobody reassigns | CL | 8 reminders measured from the later of the deadline and the moment it became undeliverable (if it failed after its deadline, the first reminder is skipped and the next comes an hour later): at the deadline, then +1, +3, +7, +15, +31, +55, +79 h; then only the queue shows it | About 103 hours of reminders, then silence except the queue and gauges | ADR-0079 | |
| B3 | May an undeliverable request ever escalate by itself | CL | never | The database guard forbids `failed_unreachable` to `escalated`; a person must reassign | ADR-0079 | |
| B4 | Thresholds for the operations notices | OPS | stalled worker: 5 minutes past deadline; queue overdue: a request more than 15 minutes past its deadline; slow response: average time to take responsibility over 24 h above 15 minutes | Notices to operations only; clinicians are not alerted | ADR-0079; brief §11 | |
| B5 | Supervisor reassign: audience, reason codes, cap | CL | `messaging.review` holders; six fixed non-clinical reason codes; 5 reassigns per request per rolling 24 h (409 after) | A supervisor can move a waiting request without reading the conversation. One supervisor can use the cap, so the 409 names the clinical lead | ADR-0078; brief §13 | |
| B6 | Supervisor override and take-over (the reassign limit itself is B5) | CL | no supervisor acknowledge, resolve or cancel | Only the assigned person takes responsibility | brief §3, §13 | |
| B7 | G-1: an audited "acknowledged by phone on behalf of" action | CL (may reopen) | **closed by product decision, rejected** (ADR-0078 decision 8) | Would weaken the explicit-acknowledgment rule (ADR-0056, ADR-0069 decision 6). The supported path is B5 | brief §13 | |
| B8 | Safety-floor list and locked quiet-hours rows | CL | per ADR-0073 platform floor | What can never be silenced | brief §8; UI spec §9 | |

## C. What a restricted row may show (compliance)

| # | Decision | Owner | Default | What the default means | Source | Decision |
|---|---|---|---|---|---|---|
| C1 | On rows a supervisor cannot open (not on the care team, or 42 CFR Part 2 and not released): requester name, request reference, assignee name and class | COMP | shown | People, not patients; nothing opens. Alternative: collapse to "restricted, overdue by N" | ADR-0076, ADR-0078; brief §11, §13 | |
| C2 | Candidate names in the reassign pickers for Part 2 or restricted patients | COMP | a walled-off supervisor gets an empty list and a uniform refusal; others see names | Names colleagues, not patients | ADR-0078 | |
| C3 | Existence disclosure: a supervisor without channel access still gets "a clinical message needs a supervisor" with a request id and class | COMP | accepted | No patient, channel or message data; the queue link enforces access | ADR-0079 | |

## D. Fallback runbook and drills

| # | Decision | Owner | Default | What the default means | Source | Decision |
|---|---|---|---|---|---|---|
| D1 | Telephone-tree order and wait per step | CL | assignee, sender, next on-call tier, supervisor, director of nursing, clinical lead, operations (critical symptom: sender first, then assignee; a sender the row does not identify counts as unreachable); 5 min for urgent and critical, 10 for important | Used by the runbook and drills only | brief §13 | |
| D2 | Drill cadence; must a new organisation drill before going live | CL | quarterly, one tabletop and one live; yes before go-live | No drill has been run, so acceptance evidence does not exist | brief §13 | |
| D3 | Drill targets | CL | 10 min to notice, 10 more to reach a person, acknowledged within the deadline plus 15 min | | brief §13 | |
| D4 | Evidence owner, store and retention | CL + COMP | clinical lead; the agency's compliance store (never this repository); the agency's policy period (six years is the usual documentation period) | | brief §13 | |
| D5 | Who may stand down an incident; cancelled-request rule | CL + OPS | supervisor on duty (clinical) and operations (technical), both recorded; a cancellation needs the clinical lead's recorded decision first | | brief §13 | |
| D6 | Follow-up limit before handing an unanswered request up | CL | to be set (important and urgent separately) | | brief §13 | |
| D7 | A verbal "I've got it" and verbal handoff of content | CL | does not close a request; no content on the call | | brief §13 | |
| D8 | Who owns the 911 decision while a critical-symptom request is unanswered | CL | clinical supervisor on duty | `critical_symptom` has no writer today | brief §13 | |
| D9 | Live drill hygiene: test org supervisor audience holds only participants | OPS | required | The test org lives in production; gauges and the ops webhook are shared | brief §13 | |

## E. Gates work that has not started

| # | Decision | Owner | Default | What it unblocks | Source | Decision |
|---|---|---|---|---|---|---|
| E1 | Name the M19 owner and a date | PO | none named | 4.12 (on-call directory and role-based send) and 4.13 (after-hours triage routing); also a real router, so `ladder_exhausted` and role routing work at all | `brief-m19-owner.md`; UI spec §5 4.12; `brief-wp-4-13-after-hours-triage.md` (4.13); ADR-0082 |  **Decided by the product owner, 2026-10-19:** the product owner is the INTERIM M19 owner. Backup: not named. First-tenant date: not named. Handover to a permanent owner is open. |
| E2 | Who may be addressed by role ("on-call RN") and who may address a role | CL | not decided | 4.12; changes who is paged. Needs a new ADR | UI spec §9; `brief-wp-4-13-after-hours-triage.md` (4.13); ADR-0081, ADR-0082 |  **Settled 2026-10-19 by the product owner's acceptance of the ADR-0080 and ADR-0081 proposed defaults:** the closed role list is `rn` and `physician`; only holders of `messaging.oncall.send` may address a role; family never addresses a role. In practice RN only: the M19 router maps only `rn`, so `physician` needs an M19 mapping first. Clinical-lead concurrence is not separately recorded. |
| E3 | Accept the new-ADR route for role recipients (drafted after E1 and E2) | PO | yes | The ADR is written after the answers | UI spec §9 | |
| E4 | Fallback recipient when the on-call lookup fails | M19 + CL | none; supervisors are alerted, which is not an assignment | Needs the M19 owner | brief §7; `brief-wp-4-13-after-hours-triage.md` (4.13); ADR-0082 |  **Decided by the product owner as interim M19 owner, 2026-10-19:** a fallback is wanted, in both forms, as an explicit ordered ladder; each step is visible to and confirmed by the sender, never silent. (1) The confirmed on-call. (2) A named role, configured per tenant (the role key is chosen by the tenant admin; unset means this step is off, fail-closed). (3) A fixed per-tenant emergency number (the M19 draft idea `emergency_contact_e164` in `brief-m19-owner.md`, not built). This is the one recorded exception to the ADR-0081 default of no fallback on a gap. Clinical-lead concurrence is NOT separately recorded. Nothing of this ladder is built. |
| E5 | An escalated assignee who is not in the channel: may they open that one thread? | CL + COMP + SEC | not decided. **Interim built (engineering proposal, fail-safe):** the walk skips next-tier users who cannot view the channel; the original assignee keeps the request and the supervisors are alerted at the end of the ladder (`ladder_exhausted`, or `failed_unreachable` from delivery failure). **Still open:** an after-hours on-call who is off-team is skipped until this is decided. (Before the interim the walk could pick them: no alert, 404 on every escalation route, the previous assignee replaced and unable to act) | Changes who sees PHI. Options: audited, time-limited read access to that thread for the escalated assignee; or keep skipping next-tier users who cannot view the channel (the built interim). Requiring care-team membership would skip the after-hours on-call. Related to E2 and break-glass (5.8) | ADR-0070 limit (i); ADR-0068 decision 6; `brief-wp-4-13-after-hours-triage.md` (4.13); ADR-0082 |  **Decided by the product owner, 2026-10-19:** both. Keep the built interim (the walk skips next-tier users who cannot view the channel) as the default, AND add audited, time-limited read access to that one thread for an escalated assignee as an additional mechanism. Open design questions, not decided: the duration, the trigger, who grants it, and the audit shape. Compliance and security concurrence (E5 owners CL + COMP + SEC) is NOT recorded. The additional mechanism is not built. |

## F. Later phases (not blocking anything now)

Listed for completeness, with owners from the UI spec §9: retention classes and legal hold (5.6, compliance, new ADR), export format and
approval roles (5.7, compliance, new ADR), break-glass eligibility and review SLA (5.8, compliance + clinical lead), app-lock and device
policy (5.5, SEC), dictation PHI boundary (6.3, new ADR + compliance), machine translation of clinical content (6.4, clinical lead, off
by default), AI summaries (6.5, clinical lead + compliance + new ADR, hazard H-08), external partner share (6.6, legal BAA + clinical
lead + new ADR), family messaging without an app (6.7, privacy officer + new ADR), individual-level analytics (6.2, HR/compliance,
forbidden by default), the self-destruct
question (UI spec §8; recommended to decline for clinical content), and reconciling native push with ADR-0072 (5.11).

## What happens with the answers

Accepted defaults and edits are written into the owning ADRs (0056, 0069, 0071, 0073, 0076, 0078, 0079) and the brief as decided,
with the decider's role and date, and the runbook placeholders are replaced. A rejected default becomes a work item. E1 to E3 start
the 4.12 and 4.13 planning.

E1, E2, E4 and E5 were answered by the product owner on 2026-10-19 (see the Decision column of section E); ADR-0080 and ADR-0081 are Accepted by the product owner on the same date, and ADR-0082 stays Proposed.
