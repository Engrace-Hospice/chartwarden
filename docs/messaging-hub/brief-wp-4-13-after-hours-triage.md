# Brief: WP 4.13 after-hours triage routing, four answers that unblock planning (E1, E2, E4, E5)

**Audience:** the product owner (E1) and the clinical lead (E2, E4, E5), with the M19 owner once named and compliance for E5 · **Needs from you:** one name and a date, three short answers · **Blocks:** planning of WP 4.13 (nothing is built, so nothing in production waits); and, through E1, any real after-hours routing for a tenant.

> **Status (2026-10-19):** WP 4.13 is a proposed row, not built. A draft decision record, [ADR-0082](../adr/ADR-0082-messaging-after-hours-triage-routing.md) (**Proposed**), says how it could work. **The product owner answered E1, E2, E4 and E5 on 2026-10-19** (see the Decision column of `11-decision-sheet.md` section E and the "Decisions recorded" section of ADR-0082): E1, the product owner is the interim M19 owner (backup and first-tenant date not named; handover to a permanent owner open). E2, the ADR-0080 and ADR-0081 defaults are accepted, RN in practice, family never addresses a role. E4, a fallback is wanted as an explicit ordered ladder (confirmed on-call, a per-tenant named role, a per-tenant emergency number), each step visible to and confirmed by the sender, never silent. E5, keep the built interim skip as the default and add audited, time-limited read access to that one thread (duration, trigger, who grants it and the audit shape are open). **Not recorded: clinical-lead concurrence on E4, and compliance and security concurrence on E5.** Nothing of 4.13, the ladder or the thread read is built, and ADR-0082 is still Proposed. Where "Proposed default" appears below it is the earlier engineering placeholder; the decisions above supersede it. It depends on WP 4.12, whose role-send half is built flag-off ([ADR-0081](../adr/ADR-0081-messaging-role-send.md), Accepted by the product owner 2026-10-19; the flags are still off and the M19 router is still unbound).

## What 4.13 is, in plain words

When a family member or a staff member needs the agency after hours, the call or item should reach the on-call clinician, be recorded as an after-hours triage call in the on-call module (M19), show a short result in the patient's care-team thread, and be acknowledged by the on-call clinician the same way every other urgent request is (the 4.2 acknowledgment request). The 4.13 acceptance test is: an after-hours item reaches the on-call clinician and is acknowledged through that request.

## What is built and what is not

| Built (on `main`) | Not built |
|---|---|
| M19 triage calls, with their own lifecycle, deadlines and escalation rungs (M19 owns these and they do not change). | Any path from a message to a triage call. Nothing in M36 opens one for a person-originated item. |
| The 4.2 acknowledgment request; one explicit acknowledgment by the assigned, qualified person. | A link between a message and a triage call; a result line in the thread. |
| A tier-1 on-call router in M19, **off unless an organization is listed**, and a read-only "who is covering now" directory (ADR-0080, flag off). | The role-based send that 4.13 builds on (ADR-0081 is Proposed). Tier 2 and above. Any role except RN (the physician role has no mapping today). |
| Coverage-gap alert to administrators and clinical supervisors when no one covers a shift. | Any fallback person when the on-call lookup fails. |
| Staff can open a triage call by hand in M19 if they are eligible. | Any family or caregiver message into the chat (that is WP 6.7, also unbuilt). Family calls reach M19 only through its own phone or portal intake. |

Also not defined anywhere we found: how the system decides an item is "after hours". The proposal uses the on-call schedule itself, not a clock in messaging.

## Decisions requested

Each row is one decision on the sheet ([`11-decision-sheet.md`](./11-decision-sheet.md) section E). Write your answer there, not here.

### E1 (product owner): name the M19 owner and a date

- **Proposed default:** one named person plus a backup, and a date for turning the router on for a first tenant.
- **If you accept:** the M19 part of 4.13 can be planned: a safe way for messaging to ask M19 to open a call, and a decision on what to call such a call. Without a name, only the messaging side can be prepared, and it stays switched off.
- **If you decline or wait:** 4.13 stays unscheduled. Messaging keeps answering "roster not connected" and refusing, which is the safe behaviour.

### E2 (clinical lead): who may be addressed by role, and who may address a role

- **Proposed default:** only the on-call RN for now (the only role the router can answer); only clinicians who have been given the on-call send permission, which no role holds by default; a family member never addresses a role through messaging.
- **If you accept:** after-hours items from staff go to the confirmed on-call RN and open one triage call. Physician or social worker routing waits until M19 maps those roles.
- **If you widen it** (for example aides, coordinators, the physician role): more people can page the on-call, and M19 must add the role first. Say which roles and who.

### E4 (M19 owner and clinical lead): fallback recipient when the on-call lookup fails

- **Proposed default:** no automatic fallback. If no one is confirmed on call, or the lookup fails, the sender is told to use the agency telephone procedure, nothing is sent and no triage call is opened. Administrators and clinical supervisors are alerted through the existing coverage-gap alert, which is an alert and not an assignment.
- **If you accept:** a gap is always visible to the sender, never silent, and nobody is paged who was not confirmed. The cost is that during a gap the software does not route; the telephone procedure does.
- **If you want a fallback:** name who (a role or a number) and whether it is fixed or set per tenant. M19 already has a per-tenant emergency number column (`emergency_contact_e164`, built, per provider entity, used today only for the degraded-alert path); the ladder step that shows it to the sender is not built. It must be a step the sender sees and confirms, not a silent widening.

### E5 (clinical lead, compliance, security): an escalated assignee who is not in the channel

- **Proposed default:** keep the safe behaviour already built (the escalation skips people who cannot view the thread). The on-call clinician works the triage call in M19, and the thread shows only a short fixed-text result.
- **If you accept:** nobody gains access to a patient thread by being on call, but an off-team on-call clinician cannot acknowledge the message request itself until this is decided, so acknowledgment through the 4.2 request for an off-team clinician stays blocked. This is the biggest practical gap in 4.13, because after-hours on-call staff are often not on the patient's care team.
- **Alternative:** audited, time-limited read access to that one thread for the escalated person. This changes who sees patient information and needs compliance and security.

## What stays the same

M19's triage deadlines, escalation rungs and rules do not change. Where a messaging deadline and a triage deadline both apply, the stricter one wins (decision D6, [`brief-m19-owner.md`](./brief-m19-owner.md)). Acknowledging the message does not close the triage call, and closing the call does not acknowledge the message. The thread never holds clinical detail from the call. The permanent "not the emergency path" notice stays.

## What happens with the answers

Accepted answers are recorded as decided, with the decider's role and date, in ADR-0082 (status moves from Proposed once accepted), the decision sheet and [`brief-m19-owner.md`](./brief-m19-owner.md). A rejected default becomes a work item. After that the build is a set of small slices (S1 to S6, the ladder L1 to L3, the thread read G1 to G3), all switched off by default (listed in ADR-0082 and ADR-0085). Related sign-offs: [`brief-clinical-lead-signoff.md`](./brief-clinical-lead-signoff.md) (acknowledgment deadlines, D4 and D7).

References: [`04-phases-4-to-6.md`](./04-phases-4-to-6.md) (row 4.13), [`10-ui-spec-phases-4-to-6.md`](./10-ui-spec-phases-4-to-6.md) §5 (4.12) and §9, [ADR-0057](../adr/ADR-0057-escalation-ownership-m19-m36.md), [ADR-0070](../adr/ADR-0070-messaging-escalation-timers.md), [ADR-0081](../adr/ADR-0081-messaging-role-send.md).
