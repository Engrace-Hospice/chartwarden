# Brief: M19 (on-call) owner, 8 decisions that let after-hours routing be finished and tested

**Audience:** whoever owns M19 (on-call, tiers, triage calls). **Today that is the product owner, as interim owner (decision E1, 2026-10-19); backup and first-tenant date are not named.** · **Needs from you:** 8 answers · **Blocks:** slices L1 (fallback-role column), L2/L3 (ladder), S6 (live acceptance across a shift change and a clock change) of WP 4.13, the physician role, and turning the router on for a first tenant.

> **Status (2026-10-23):** this brief is the **follow-on** to [`../brief-m19-owner.md`](../brief-m19-owner.md) and [`../brief-wp-4-13-after-hours-triage.md`](../brief-wp-4-13-after-hours-triage.md). It does **not** repeat them. Still open there and not re-asked here: delivery date for tiers 2 and above (M19-owner brief decision 2), role-level lookup with no patient (decision 3), and whether `failed_unreachable` should feed the coverage-gap watchdog (decision 5). On the M19 side, S2 (the consumer of `m36.afterhours_triage.requested` and the outcome event, migrations 1133 and 1134) is built; M19's triage lifecycle, SLAs and escalation rungs are unchanged. With no router bound for a tenant the feature answers "roster not connected" and refuses, which is the intended safe behaviour. Index: [`README.md`](./README.md).

**How to answer:** tick one box per item. "Yes" accepts the recommended default exactly as worded; "Modify" accepts it with your change.

---

### M19-1. Backup owner, first test organisation and the date the real router is bound (ADR-0082 Q1 and "Still blocked or open"; decision-sheet row E1)

**Plain language.** The live acceptance test (S6) needs one test organisation listed in `ESCALATION_ROUTER_ORGS` (the list of organisations for which the real router answers) and a person who can fix problems in M19.

- **Recommended default:** name one backup person and one test organisation now; bind the router for that organisation only; a permanent owner takes over later.
- **Consequence:** S6 cannot run without it; until then every after-hours send refuses with "roster not connected".

**Stays blocked:** S6. **Unblocks:** S6 (live acceptance); first-tenant planning.

Answer: backup: ____________  test organisation: ____________  router bound by (date): ____________  [ ] later: ____  Name / date: ____________

### M19-2. New call source and channel values (ADR-0082 Q3, resolved in slice S2 as a build default)

**Plain language.** M19 needed names for a call opened by messaging. S2 added the source `m36_afterhours_request` and the channel `inbound_afterhours_request`, with the caller kind left as `system_inbound`. No existing channel value was truthful (the four human ones count people ringing in; the alert-failure one would fold requests into the delivery-failure count).

- **Recommended default:** confirm the two names and `system_inbound`.
- **Consequence:** a rename later is another enum migration (the ADR cites 1132/1133 inconsistently; the built values are in migration 1133).

Answer: [ ] confirm  [ ] rename to: ____________  Name / date: ____________

### M19-3. What "after hours" means (ADR-0082 Q6)

- **Recommended default:** an item is after hours when **any on-call shift is covering** at that moment, judged by M19 in the schedule's time zone. Messaging has no clock of its own.
- **Alternative:** use the safety-policy setting `isAfterHours` of M20.
- **Consequence of the default:** the answer follows the on-call schedule exactly; an organisation with no covering shift gets "no coverage". The alternative follows M20's setting instead and can disagree with the schedule.

Answer: [ ] on-call shift covering  [ ] M20 `isAfterHours`  [ ] modify: ____________  Name / date: ____________

### M19-4. The fallback-role column (ADR-0082 slice L1; decision 9; Q12)

**Plain language.** Step 2 of the ladder (a named role the agency chooses) needs one new nullable setting in M19: `tenant_oncall_policy.afterhours_fallback_role`, picked from a closed list, changeable through the existing on-call policy update (second factor required). Unset means the step is off. A role in that list only works if the router can map it to people.

- **Recommended default:** approve the column and the closed role list (`rn`, `physician` as in ADR-0081), unset by default.
- **Consequence:** a new M19 migration (number taken from `main` when built; no number is claimed in the ADR); L2 depends on it. RN works today; `physician` needs M19-6 first.

**Stays blocked:** L1, then L2 and L3 (and CL-1 for the sender-facing wording). **Unblocks:** L1.

Answer: [ ] approve  [ ] changes to list / name: ____________  Name / date: ____________

### M19-5. Using the built emergency number as ladder step 3 (ADR-0082 Q12; decision 9)

**Plain language.** `tenant_oncall_policy.emergency_contact_e164` already exists (migration 0107). Today it is used only for the degraded alert path. Step 3 would show this number to the sender, who dials it, and records the sender's confirmation as an audited event. The number is stored **per organisation and per provider entity**, not platform-wide; empty means the step is off.

- **Recommended default:** reuse the column as is; no migration.
- **Consequence:** one number per provider entity; a tenant with several entities needs the right one set for each. Changing it stays the existing policy update with second factor.

Answer: [ ] reuse  [ ] separate column for this purpose  [ ] modify: ____________  Name / date: ____________

### M19-6. The physician role mapping (decision-sheet row E2; ADR-0082 Q2)

- **Today:** the role list allows `rn` and `physician`, but the router maps only `rn`. A role send to a physician cannot resolve anyone.
- **Recommended default:** do not map `physician` until you define it (which schedule, which tier). Until then RN only.
- **Consequence:** physician routing waits for you; if you map it, say the schedule source and whether it is tier 1.

Answer: [ ] RN only for now  [ ] map physician: ____________  Name / date: ____________

### M19-7. Should messaging also show calls M19 opened itself? (ADR-0082 Q5; "What changes in M19" (d))

- **Recommended default:** no. Only calls opened from messaging are linked ("Path A"). Showing calls opened by M19's own phone or portal intake ("Path B") would require M36 to be a declared consumer of the triage-call events (`declaredConsumers` is empty today).
- **Consequence:** a call that started by phone never appears in the chat.

Answer: [ ] no  [ ] yes, declare M36 a consumer  Name / date: ____________

### M19-8. Who raises the alert when a leaver held an on-call seat (ADR-0084 "Open human decisions" 3; with the clinical lead)

- **Today:** messaging shows an advisory "check the roster"; it cannot read or edit M19's roster.
- **Recommended default:** **M19 owns it**: M19 reacts to the deactivation or membership-revoked event and raises a coverage-gap alert for any seat the leaver held; messaging only links to it from the offboarding page.
- **Consequence:** the item stays advisory in messaging until M19 ships the reaction; until then a vacated seat is invisible, exactly as today.

**Unblocks:** an M19 consumer (no migration expected; no slice number exists yet).

Answer: [ ] yes  [ ] no  [ ] modify: ____________  Name / date: ____________

---

*Not in this brief:* the three decisions listed in the status note (see [`../brief-m19-owner.md`](../brief-m19-owner.md)); whether the grant for off-team on-call staff is allowed (CO-1, SE-8, CL-5).
