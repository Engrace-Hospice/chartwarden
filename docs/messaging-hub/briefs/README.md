# M36 messaging hub: owner decision briefs (wave 5)

**Status:** draft, 2026-10-23. **Nothing here is decided.** Every "recommended default" in these briefs is a build-team proposal taken from an ADR that is still **Proposed**. Each owner fills the answer blocks (yes / no / modify, with name, role and date); the answers are then written into the owning ADR and into [`../11-decision-sheet.md`](../11-decision-sheet.md) section G, and a "no" becomes a work item.

These briefs turn the open sign-offs of ADR-0082, 0083, 0084, 0085, 0089, 0091, 0092, 0094, 0095, 0096, 0097, 0098 and 0099 into one short document per owner, so the gated builds can start. They extend, and do not replace, the earlier briefs in [`../`](../README.md): [`brief-clinical-lead-signoff.md`](../brief-clinical-lead-signoff.md), [`brief-m19-owner.md`](../brief-m19-owner.md) and [`brief-wp-4-13-after-hours-triage.md`](../brief-wp-4-13-after-hours-triage.md), and the existing rows of the decision sheet (sections A to F).

## The briefs

| Owner | Brief | Open questions | What an answer unblocks |
|---|---|---|---|
| Compliance officer (HR joins CO-10 to CO-12) | [`brief-compliance-officer.md`](./brief-compliance-officer.md) | 19 (CO-1 to CO-19) | Thread-read slices G2 and G3 (ADR-0085); a Part 2 rule for after-hours triage in restricted channels (ADR-0082); export acceptance and flag `messaging.export` (ADR-0089, migration 1147 already built); response analytics flag and its follow-up change (ADR-0092, migration 1170 built); leaver-draft retention (ADR-0084); broadcast (ADR-0097, migrations 1200 and 1202 built), death board (ADR-0098, migration 1201 built) and partner share (ADR-0096, migration 1180 built) going live; the partner-reply decision (slice S8, migration 1203 reserved) |
| Clinical lead (bereavement coordinator joins CL-16 part, CL-17, CL-20) | [`brief-clinical-lead.md`](./brief-clinical-lead.md) | 20 (CL-1 to CL-20) | After-hours ladder L2 and L3 and the thread wording (ADR-0082); grant limits (ADR-0085); offboarding paging and the 72-hour rule (ADR-0084); inbox order (ADR-0091); AI risk class, wording and sequence (ADR-0095); voice-note typed-text rule (ADR-0094); what may be shared with partners (ADR-0096); broadcast (ADR-0097); death-board checklist and owner rule (ADR-0098); family messaging roles, bereavement thread and wording (ADR-0099, slices S1, S4, S6) |
| Privacy officer and counsel | [`brief-privacy-officer-counsel.md`](./brief-privacy-officer-counsel.md) | 13 (PV-1 to PV-13) | ADR-0099 acceptance and its slices S1 to S7 (family messaging, plus the SMS and email vendor and agreement); voice-note retention and any dictation vendor (ADR-0094); AI vendor, region, zero-retention and Part 2 rules (ADR-0095); partner agreement reference, invitation sender and Part 2 gap (ADR-0096) |
| Security architect | [`brief-security.md`](./brief-security.md) | 15 (SE-1 to SE-15) | Session policy and the "security officer" role (ADR-0083, ADR-0084); app lock (WP 5.5, not started); security concurrence on slice G2 (ADR-0085); partner authentication, token storage and headers for `/partner/*` (ADR-0096); family link code, pepper and limits (ADR-0099 S1, S2); microphone and media headers (ADR-0094); export two-account limit (ADR-0089) |
| M19 owner (the product owner, interim) | [`brief-m19-owner-followup.md`](./brief-m19-owner-followup.md) | 8 (M19-1 to M19-8), plus 3 still open in [`../brief-m19-owner.md`](../brief-m19-owner.md) | Live acceptance S6 (needs a bound router for a test organisation); slice L1 (new M19 column `afterhours_fallback_role`, migration number taken from `main` when built); the physician role; on-call vacancy alert (ADR-0084) |
| Product owner | [`brief-product-owner.md`](./brief-product-owner.md) | 12 (PO-1 to PO-12) | Which flags any tenant may switch on and in what order; family contact page (ADR-0099 S5); partner page hosting and replies priority (ADR-0096); broadcast follow-ups, inbox deep links, analytics follow-ups, AI limits, voice-note sequencing; operations questions routed to the product owner until an operations owner is named; death-board backfill |
| **Total** | | **87** | |

Each question appears in exactly one brief. Where another owner must also concur, the brief says which question carries it (for example the thread grant: principle CO-1, duration CO-2 and CO-3, mechanism SE-8, clinical limits CL-5).

## How to use

1. Give each owner their brief. They tick one box per item and add name, role and date.
2. Collect answers; do not edit a default in the ADR until its owner has signed.
3. Copy accepted answers into the owning ADR (status wording, "decided by" with role and date) and into the matching row of [`../11-decision-sheet.md`](../11-decision-sheet.md) section G. A "no" or "modify" becomes a work item.
4. Slice numbers named in the briefs (for example G2, L1, S6) are the ones in the ADRs. A migration number is named only where an ADR already names it; any new migration takes the next free ordinal from `main` at build time (`arch:migration-numbering`).

## Where the ADRs disagree or are out of date (found while writing the briefs; not resolved here)

1. **Broadcast oversight versus the work-package guardrail.** [`../04-phases-4-to-6.md`](../04-phases-4-to-6.md) WP 6.8 says "supervisor sees every non-reader"; ADR-0097 D5 limits that list to the broadcast's creator and states that nobody above the author can see it (open item 1). Carried in CO-15.
2. **Who the "officer" is differs between ADRs.** ADR-0083 and ADR-0084 give session and offboarding powers to the two full-catalog admin roles; ADR-0089 (export), ADR-0092 (analytics) and ADR-0096 (partner share) give theirs to `compliance_officer`, `administrator` and `org_admin`; ADR-0098 treats a "supervisor" as a `messaging.review` holder, while ADR-0097 gives supervisors nothing. ADR-0084 already asks for one officer definition (SE-1).
3. **Redaction strictness differs.** ADR-0095 excludes only approved redactions and deleted messages from the model; ADR-0096 D8 hides a message from a partner on ANY redaction row (requested, pending or rejected). Both are called "consistent" in the text. Raised in PV-7.
4. **Export of voice notes.** ADR-0094 section 4 leaves it "to be verified" whether the export includes audio; ADR-0089 D4 and D9 already say attachment files are never exported (metadata only). The ADR-0094 line is stale.
5. **Numbering notes.** ADR-0085's header says it was "renumbered to 0084" (the file is 0085 and 0084 is offboarding); ADR-0082's text cites migration 1132 for the call source and channel values in Q3 and 1133 in its status line (the built values are in 1133, per its status line; M19-2).
6. **Retention of the family thread.** ADR-0099 D13 uses 7 years (built value) and notes that the M36 spec says "6+ yr"; no ADR resolves the spec text.
7. **Unverified status.** ADR-0094, ADR-0095 and ADR-0099 each rely on the AI/BAA vendor agreement recorded "in progress" in the AI governance document (section 9.2) and none verifies it (PV-5, PV-6).
