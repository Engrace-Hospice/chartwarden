# ADR-0064 — IDG coordination is a care-team thread anchored on a read-through meeting link: M36 reads M14 and writes nothing, outcomes are ordinary tasks or a pending promotion request, and a message can never complete a meeting or change the plan of care

- **Status:** **Accepted** (2026-10-14; the decisions are closed in the WP 3.6 blueprint. No clinical-lead sign-off is recorded.)
- **Date:** 2026-10-14
- **Phase:** Messaging Hub Phase 3 (WP 3.6, IDG coordination).
- **Extends:** [ADR-0059](ADR-0059-messaging-clinical-links-read-through.md) (the `idg_meeting` clinical link and its read-through chip are the meeting header), [ADR-0060](ADR-0060-messaging-sbar-structured-messages.md) (per-tenant ops flag default off), [ADR-0061](ADR-0061-messaging-communication-tasks.md) (outcomes are ordinary tasks; decision 2, the reserved `idg_action_item` source, stays reserved), [ADR-0062](ADR-0062-messaging-clinical-handoffs.md) (the flag, route and web-gate pattern), [ADR-0010](ADR-0010-tenancy-rls-invariants.md), [ADR-0011](ADR-0011-ownership-inversion-rls-bypass.md) (no cross-module table access).
- **Related:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (M36 `dependsOn` lives in the manifest). ADR-0063 (WP 3.7, chart promotion) is built in a parallel worktree; this ADR refers to it by interface only (decision 6).
- **Amends the data model in** `docs/messaging-hub/02-architecture-and-domain.md` only by omission (see "Deviations and clarifications").

## Context

The hub plan (`03-phases-0-to-3.md`, WP 3.6) wants an IDG-linked patient discussion whose outcomes become a communication task or a promotion request. Its acceptance line is: a message can never mark an IDG meeting complete or change the plan of care. Workflow C (`05-clinical-workflows-and-safety.md`) and the compliance reading of 42 CFR 418.56 put the decision record, the meeting state and the plan of care in IDG (M14) and the care plan (M7), not in chat.

Facts that shape the design:

- Meeting state is M14's. M36 depends on modules 1 to 4 only (`architecture/module-manifest.ts`); M14 depends on M36, not the reverse. M36 reaches M14 only through `@wardenx/types` seams and the outbox.
- M14 exposes read-only seams (`IdgScheduleProvider`, `IdgDecisionProvider`, `IdgPacketProvider`). None answers "which patients are on meeting M". The only patient-side listing is the route `GET /api/v1/patients/:patientId/idg-history`, which returns the meetings the patient has a packet in.
- `idg.decision_recorded` is the command seam that M7, M11, M12, M15 and M16 consume to apply plan changes. M36 must never name it.
- WP 3.2 already provides the `idg_meeting` clinical link (write needs `idg.read` plus the meeting scope) and a resolve route that returns the live status and time of the meeting or "unavailable".
- WP 3.4 tasks exist, with the source kind `idg_action_item` reserved and unused (ADR-0061, decision 2).
- The web shell never passes feature flags to the app, so every `useFeatureFlag` gate in the M36 web code reads off (see "Known issue outside 3.6").

## Decision

1. **D1. No new table and no new channel kind.** An IDG discussion is a `care_team` channel root message (no parent, not deleted) that carries at least one `clinical_link` of kind `idg_meeting`. The replies in its thread are the discussion. The meeting header is the existing WP 3.2 chip over the resolve route, so the live status and the "as of" time come from M14 each time and nothing is copied.
2. **D2. Visibility is the care-team channel rule.** Whoever can view the channel (active user, live membership, the Part 2 gate) can view the discussion. IDG members who are not on the care team do not see it; they are added through member management. There is no new visibility rule.
3. **D3. Starting needs a valid meeting link, and replying needs nothing new.** The server already refuses an `idg_meeting` link unless the caller holds `idg.read` and the meeting scope and the meeting exists in the organisation (generic `422`). Any care-team member who can post can reply. A replier without `idg.read` sees the chip as "unavailable". There is no new permission.
4. **D4. The meeting header is read-through only.** Nothing locks the thread when the meeting is adjourned or cancelled, and M36 does not consume the meeting lifecycle events (that would need an edit of the M14 catalog, a foreign module). A rescheduled meeting has no forward pointer.
5. **D5. Task outcomes are ordinary WP 3.4 tasks, unchanged.** No `source_kind`, no migration. An "IDG-sourced" task can be derived (task to message to thread root to its idg link). ADR-0061 decision 2 stays reserved: 3.6 never creates, reads or closes an M14 `idg_action_item`.
6. **D6. Promotion outcomes belong to WP 3.7, by interface only.** In an IDG discussion a message action "Propose for IDG" opens the 3.7 promotion dialog with the M14 target preselected and the meeting id taken from the root's link. 3.7 creates a pending request and never writes the target; M14 reviews it in M14. **This action is conditional on WP 3.7 exposing an M14 target (ADR-0063, being built in parallel).** If 3.7 ships without one, the action is dropped from 3.6 and recorded as a follow-up.
7. **D7. Flag `messaging.idg`, default off per tenant.** The feature is enabled when `messaging.idg` and `messaging.clinical_links` are both on, read through the 5-second flag cache like the presence binding. With the flag off the list route answers `200 {enabled:false, discussions:[], patientId:null}`. The web reads that `enabled` field and never the shell flag hook.
8. **D8. The patient and meeting pairing is not proven on the server.** No M14 seam answers it. The 3.6 web has no start action (the picker hides `idg_meeting` until a patient-scoped IDG list route exists), so a link is made through the API, which checks only that the caller may read the meeting. A hand-crafted request can link any meeting the caller may read; this is the same exposure WP 3.2 accepted, and the chip shows status and time only. Follow-up: an M14 `IdgScheduleProvider.meetingReviewsPatient(orgId, meetingId, patientId)` seam.
9. **D9. Nothing in 3.6 writes.** No table, no event, no alert, no audit write other than the read audit on the new list route (the same configuration as the pins list).
10. **D10. No new offboarding or lifecycle handling.** Revocation is WP 1.4, care-team sync is 3.9, task reassignment is 3.4, the promotion rule is 3.7 and patient lifecycle is 3.8.

## Deviations and clarifications

`02-architecture-and-domain.md` lists no IDG-specific entity, and no `idg` channel kind exists. So nothing in the architecture note is contradicted. This ADR records that the absence is deliberate: an IDG channel kind or a discussion table would be a second place to hold a state that M14 owns, and "link, don't copy" (doc 01, row 16) applies.

## Data model

None. No migration (migrations still end at `1101`; WP 3.7 claims `1102`). Existing indexes serve the list query: `clinical_link_unique_target` (organisation, message, link kind, source) for the `EXISTS` test and `message_org_channel_idx` (organisation, channel). Care-team channels are small; add a partial index only if a plan shows the need.

## Routes

One new read route under `/api/v1/messaging`:

| Route | Guard | Behaviour |
|---|---|---|
| `GET /channels/:id/idg-discussions?limit=` | `messaging.read` plus the channel-view guard (identical to the pins list) | Roots only (no parent, not deleted) with an `idg_meeting` link, newest first, default limit 50, max 100, no cursor. Response `{enabled, discussions, patientId}`. Flag off, or a channel that is not `care_team`, answers `200` with an empty list. Non-member, other tenant and Part 2 refusals are the same uniform answer as the pins list. Read-audited per patient. |

Errors are typed (`arch:error-envelope`) and no request header is read.

## Alternatives considered

- **A new `idg` channel kind or a discussion table.** A second home for meeting state that M14 owns. Rejected (D1).
- **Lock the thread when the meeting ends.** Needs a consumer of M14 lifecycle events and a foreign catalog edit. Rejected for now (D4).
- **Use `source_kind = 'idg_action_item'` for tasks.** Needs an M14 write seam and reopens ADR-0061 decision 2. Rejected (D5).
- **Write outcomes straight into M14 or M7.** A message would then change the plan of care, which the acceptance line forbids. Rejected (D5, D6, D9).
- **Verify the pairing on the server by joining M14 tables.** A cross-module table read (ADR-0011). Rejected until M14 offers a seam (D8).
- **Gate the web with the shell flag hook.** Dead in the real app. Rejected (D7).

## Consequences

- **New flag `messaging.idg`, default off.** Rollback is safe: the flag hides the section and the route answers empty; no schema or body node was added.
- **Non-goals.** Any M14 or M7 write; reacting to or locking on meeting lifecycle; an IDG channel kind; cross-patient per-meeting views; deep links from the M14 screen; outcome counts; an IDG alert-to-task path (ADR-0061, decision 2); a "last IDG" context tile; fixing the dead web flag gates.
- **Known limits (accepted).**
  - The pairing of patient and meeting is not verified on the server (D8). A wrong pairing shows a meeting header in a thread about another patient; the header carries status and time only.
  - Nothing locks the thread after the meeting is adjourned or cancelled (D4).
  - Visibility is care-team only (D2).
  - Only meetings with a built packet for the patient can be picked in the web.
  - A rescheduled meeting has no forward pointer.
  - The list has a maximum of 100 and no cursor.
  - All wording, including the notice that a discussion does not change the meeting or the plan of care, is provisional pending clinical-lead sign-off.
- **Known issue outside 3.6: dead web flag gate.** The web app renders the shell without feature flags, so the existing `useFeatureFlag` gates in the M36 web code (`clinical-link-picker.tsx`, `use-sbar-policy.ts`, `use-presence.ts`) read off in the real app. 3.6 avoids the defect by gating on the route's `enabled` field. It is not fixed here; a separate small change should fix it.

## Verification

The acceptance line is proved two ways:

- **Static test** (`m36-idg-no-foreign-writes.test.ts`): code under the IDG directory, the IDG route and the IDG web files import no other module (not `14-idg`, `@wardenx/idg` or M7), contain no insert, update or delete, call no `getSeam`, and use only `client.GET` on the web; no file under the M36 module or the messaging package contains the literal `idg.decision_recorded`, and no publish call names an `m14.`, `m7.` or `idg.` event; the manifest entry for module 36 lists neither 7 nor 14 in `dependsOn`.
- **Live acceptance** (`m36-idg-coordination.live.test.ts`, the real `wardenx_app` role, the real catalog-validating publisher, a private container): Workflow C end to end (a live meeting with a packet, a root linking it, a reply from another care-team member, the reply converted to a task and completed, and, if 3.7 provides the M14 target, a promotion request). Before and after: the meeting row is byte-identical, the decision, action-item and agenda counts are unchanged, the care-plan rows are unchanged, and no new outbox row has an `m14.`, `idg.` or `m7.` event type. It also proves that the list returns roots only, the read audit lands, a non-member and a Part 2 refusal get the pins answer, and flag off gives `enabled:false`.
- Route unit tests with a fake store: flag combinations, a non-care-team channel, limit bounds, guard order, the audit configuration, and no header read.
- Fitness: `arch:adr-docs`, `arch:architecture-docs`, `arch:module-docs`, `arch:route-reachability`, `arch:error-envelope`, `arch:openapi-coverage`, `arch:live-suites`, `arch:fitness`.

## Open questions

None gating. To confirm with the clinical lead: the provisional wording; whether care-team-only visibility is enough for IDG members; and the M14 `meetingReviewsPatient` seam. Whether "Propose for IDG" ships in 3.6 depends on 3.7 (D6).
