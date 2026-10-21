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
8. **D8: where the grant is checked.** One place: a branch inside `channelVisibilityVerdict`, taken only after the normal verdict is "no", which skips only the membership and care-team-roster checks. The Part 2 gate and the category refusal still run. Expiry is evaluated at read time as `expires_at > now()` on the database clock with `revoked_at IS NULL`, so there is no sweeper and no lag window.
9. **D9: ADR-0085 stays separate.** ADR-0085 is a system-issued grant for an escalated assignee, still undecided (E5) and unwired. 5.8 is a self-requested grant with a review. They answer different questions, so this ADR does not reuse or change `message_thread_access_grant`. If compliance later wants one register, merging is a follow-up.
10. **D10: audit.** Every read under a grant writes an audit row that carries the grant id, so the review screen can list what was read (ids and times, never bodies). The audit write is not best-effort: if it fails, the read is refused. The justification is a reason code plus short free text (at least 20 and at most 280 characters), shown only to reviewers, never copied into outbox payloads, alerts, logs or search.
11. **D11: step-up and alert.** Creating a grant needs step-up (key `messaging.break_glass.invoke`). Creating one alerts compliance through the alert-emitter rule path. Revoking needs no step-up.

## Read paths

Honoured by the single check in D8: channel get, messages list, thread, attachment metadata and download (verify that attachment service does not bypass the channel check), per-channel search, and the ack, handoff and patient-context reads that call `canViewChannelFor`.
Not honoured: global search (membership only), realtime (rooms are fixed at connect and cannot be revoked per grant, so a grantee reads over REST only), export (WP 5.7: a grantee is never an export role), and all writes.

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
- **S1** migration and schema (`break_glass_grant`, `break_glass_review`, forced RLS, guard trigger, no delete), manifest, permissions.
- **S2** service and the D8 check, with a unit matrix (expired, revoked, other channel, other user, Part 2, excluded category).
- **S3** routes, events (`m36.break_glass.granted`, `.revoked`, `.reviewed`), step-up and alert.
- **S4** review queue, overdue alert and the live suite `test:m36:break-glass:live` with its CI job.
- **S5** web: request dialog, active banner with countdown, compliance review screen.
