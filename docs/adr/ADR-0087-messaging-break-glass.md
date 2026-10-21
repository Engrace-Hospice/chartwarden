# ADR-0087 — Messaging break-glass: a self-requested, time-limited, read-only grant on one channel, always reviewed afterwards

- **Status:** **Proposed** (2026-10-20). Nothing is built. Decisions 1 to 5 were given by the product owner on 2026-10-20; compliance and clinical-lead concurrence is not recorded.
- **Date:** 2026-10-20
- **Phase:** Messaging Hub Phase 5, WP 5.8 (capability SG-08).
- **Resolves (once accepted):** the "eligible roles, durations and review SLA" open decision in `docs/messaging-hub/10-ui-spec-phases-4-to-6.md` and `11-decision-sheet.md`.
- **Related:** [ADR-0085](ADR-0085-messaging-audited-thread-read-for-escalated-assignee.md) (a different instrument, see decision 9), [ADR-0086](ADR-0086-messaging-retention-and-legal-hold.md) (the overlay, step-up and governance-screen pattern reused here), [ADR-0010](ADR-0010-tenancy-rls-invariants.md).

## Context

Messaging reads are decided by channel membership (`channelVisibilityVerdict`, with the Part 2 gate on care-team channels). Nobody outside a channel can read it, including in an emergency, and admins have no implicit PHI access (`05-clinical-workflows-and-safety.md`). WP 5.8 asks for justified, time-limited access with an automatic post-review for compliance, scoped to a channel or patient.

M3 already has break-glass (`break_glass_event`, `/api/v1/breakglass`), but it is keyed by patient, works through the ABAC deny path, and has no review queue. M36 channel reads do not go through that path, and every M36 write route opts out of it (`breakGlassBypassable:false`). So the M3 table cannot express a channel grant, and reusing it would not cover M36 reads.

## Decision (proposed)

1. **D1: self-approved, always reviewed.** The requester approves their own grant at request time (no cosigner). The grant is useless without a justification and step-up, and creating it always creates a pending review in the same transaction. A grant with no review row is a constraint failure.
2. **D2: duration.** Default 4 hours, hard maximum 24 hours, enforced by a CHECK constraint with the maximum as a named constant. Renewal is a new justified request, never an extension.
3. **D3: Part 2 stays denied.** A grant never bypasses the Part 2 (substance-use) gate. For a patient with an active `sud` flag the channel stays unreadable under a grant, with the same uniform refusal as today. Compliance must accept this.
4. **D4: who may invoke and who reviews.**
   - New permission `messaging.break_glass.invoke`: `administrator`, `org_admin` and the clinical roles (the exact role keys are listed at S1 from the role templates).
   - New permission `messaging.break_glass.review`: `compliance_officer`, `administrator`, `org_admin`.
   - The reviewer can never be the grantee (checked in the service and by constraint).
   - Aides, patient-family, external-auditor and platform-staff identities are refused as grantees (the member-category rule).
5. **D5: review deadline (default, not yet decided by the owner).** A review is due one business day after the grant ends; one still open after three days raises an alert to compliance. Both numbers are named constants.
6. **D6: scope is one channel.** The grant names a channel (composite FK with the organisation). A care-team channel exposes that channel only. It gives no patient chart access, no other channel, and no clinical-link or patient-context access: those stay on their own checks.
7. **D7: read-only.** A grant only passes the channel read checks. It never permits send, edit, delete, redact, release a hold or mark-read, and every write route keeps `breakGlassBypassable:false`.
8. **D8: where the grant is checked (as built in S2).** A separate READ-only resolver, `canReadChannel` = `canViewChannel` OR a live grant, behind a new ABAC predicate `channel_visibility_read`. It is not a branch inside `channelVisibilityVerdict`, as first proposed: that verdict also decides sends, edits, reactions, pins, task assignees and alert recipients, so a grant there would have made a grantee a writer and a valid assignee. `canViewChannel` is untouched. A grant skips only the membership and care-team-roster checks; the feature flag, an active user, the role-category refusal and the Part 2 gate still apply, and every failure to decide is a denial. Expiry is evaluated at read time as `expires_at > now()` on the database clock with `revoked_at IS NULL`, so there is no sweeper and no lag window. A static ratchet test pins the read predicate to the three read GETs.
9. **D9: ADR-0085 stays separate.** ADR-0085 is a system-issued grant for an escalated assignee, still undecided (E5) and unwired. 5.8 is a self-requested grant with a review. They answer different questions, so this ADR does not reuse or change `message_thread_access_grant`. If compliance later wants one register, merging is a follow-up.
10. **D10: audit.** Every read under a grant writes one row in a dedicated insert-only table, `message_break_glass_read` (grant id, read kind, optional resource id, item count, database-clock instant; ids and times, never bodies), so the review screen can list what was read without depending on the shape of the general audit log. The row is written in the same transaction as the read and the table's guard refuses it unless the grant is live now and belongs to the reader, so a read that cannot be recorded is refused (not best-effort). The table is also audited like every org-scoped table. The justification is a reason code plus short free text (at least 20 and at most 280 characters), shown only to reviewers, never copied into outbox payloads, alerts, logs or search.
11. **D11: step-up and alert.** Creating a grant needs step-up (key `messaging.break_glass.invoke`). Creating one alerts compliance through the alert-emitter rule path. Revoking needs no step-up.

## Read paths

Honoured (S2, behind `channel_visibility_read`; each read leaves a trail row in its own transaction, and a read nobody may do fails closed): channel detail, message list, thread.
Not honoured, so a grantee gets the same refusal as a stranger: per-channel search, pins list, attachment download, the ack, handoff, task, clinical-link and patient-context reads (they take `canViewChannel`, which stays membership-only on purpose), the channel list (the grantee reaches the channel by id, from the request screen), global search, realtime (rooms are fixed at connect and cannot be revoked per grant, so a grantee reads over REST only), export (WP 5.7: a grantee is never an export role), and every write (send, edit, delete, react, pin, mark-read). Widening the read set later is one route at a time, each with its own trail kind.

## Not built

Everything. The slices are below. The UI banner, the review screen and the compliance nav badge from the UI spec are slice S5.

## Known limits

- (a) Self-approval means a person can open a channel on their own say-so. The controls are the justification, step-up, the compliance alert and the mandatory review. A cosign would be stronger and slower in an emergency; the product owner chose self-approval.
- (b) A grant can be read by a user who is not on the care team, in a channel about a patient they do not treat. Review is after the fact.
- (c) Realtime is not extended, so a grantee does not see new messages live.
- (d) The review shows which messages were read, from the audit log. It is only as complete as the read audit (D10).
- (e) Concurrence from compliance and the clinical lead is not recorded for D1 to D5.

## Open human items

Compliance concurrence on D1 (self-approval) and D3 (Part 2 denied); clinical-lead confirmation of the invoking clinical roles in D4; confirmation of the review deadline in D5.

## Slices

- **S0** this ADR and its index row.
- **S1** (built, migration 1140) `message_break_glass_grant`, `message_break_glass_review`, `message_break_glass_read`: forced RLS, guard triggers, a grant cannot commit without its review (deferred constraint trigger), reviewer never the grantee, no app DELETE; manifest, permissions (`messaging.break_glass.invoke` to administrator, org_admin and the qualified clinical roles of migration 1105's `urgent.receive` list; `messaging.break_glass.review` to compliance_officer, administrator, org_admin), the tenant flag `messaging.break_glass` (absent = off, added to the decisions as a safe default), reason codes `patient_safety | covering_colleague | record_correction | other`. The D5 deadline is not stored: it derives from the grant end and the named constants in `@chartwarden/types`. Live suite `test:m36:break-glass:live` and its CI job exist from this slice and grow with S2 to S4.
- **S2** (built) the read resolver, the `channel_visibility_read` predicate on the three read GETs, the in-transaction trail, the unit decision matrix and the live suite (service and HTTP: expired, revoked, other channel, other user, Part 2, excluded category, inactive user, flag off, no writes).
- **S3** (built) six routes under `/api/v1/messaging/break-glass`: open (invoke key, a fresh step-up, the tenant flag; every refusal is the same 404 so a refusal never discloses an existence, a category or a Part 2 status; 409 `BREAK_GLASS_NOT_NEEDED` and `BREAK_GLASS_ALREADY_ACTIVE` only where they disclose nothing), mine, end (the holder or a reviewer, no step-up), the review queue, a review with its audited reads, and complete (never the grantee's own, only after the grant ended, once; a concern needs a note). The grant and its review are written in one transaction with the PHI-free events `m36.break_glass.granted`, `.revoked`, `.reviewed`; a bound consumer raises one fixed-text warn alert through a new `system_locked` rule (`m36.break_glass.granted`, the holders of `messaging.break_glass.review`, the tenant administrators when nobody holds it). Reviews and ending never depend on the flag, so a grant that exists stays accountable when the feature is switched off.
- **S4** (built) the overdue escalation: an hourly sweep (`messaging.break_glass_review_sweep`, flag-independent) raises one `system_locked` alert (`m36.break_glass.review_overdue`) for each review still open three calendar days after its grant ended; idempotent on the review id with no marker column. The due time (one business day after the end, UTC, Monday to Friday) is derived, never stored. The live suite `test:m36:break-glass:live` (29 tests) and its CI job cover the tables, the read path, the routes and the sweep.
- **S5** web: request dialog, active banner with countdown, compliance review screen.
