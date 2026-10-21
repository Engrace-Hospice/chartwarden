# ADR-0089 — Messaging export: a scoped, two-person-approved export to one encrypted, expiring artefact

- **Status:** **Proposed** (2026-10-21). Only slice S1 (tables, permissions, shared contract) is built. The four open questions below were not answered by the product owner; decisions D1 to D9 are the build team's defaults. Compliance and clinical-lead concurrence is not recorded.
- **Date:** 2026-10-21
- **Phase:** Messaging Hub Phase 5, WP 5.7 (capability SG-07).
- **Related:** [ADR-0087](ADR-0087-messaging-break-glass.md) (the grant, guard-trigger and step-up pattern reused here; a grantee is never an export role), [ADR-0086](ADR-0086-messaging-retention-and-legal-hold.md) (legal hold, which this export excludes), [ADR-0010](ADR-0010-tenancy-rls-invariants.md).

## Context

Messages are readable only inside the product, by channel membership. WP 5.7 asks for a restricted way to take messages out: "`export_job`: scoped, approver required, encrypted artefact, expiring link, audited; default role set cannot export. Acceptance: unapproved export blocked; artefact auto-expires." Typical needs are a records request, a legal or compliance inquiry, and a patient-level disclosure. An export is the largest single PHI egress the messaging module can produce, so it needs a second person, a short-lived artefact and a complete audit trail.

## Decision (proposed)

1. **D1: two people.** The requester and the approver are different users. A CHECK on `message_export_job` (`decided_by <> requested_by`) and the service both enforce it. There is no self-approval, unlike break-glass.
2. **D2: who.** New permissions `messaging.export.request`, `messaging.export.approve` and `messaging.export.download`, granted by migration 1147 to `compliance_officer`, `administrator` and `org_admin` only (existing tenants by backfill, new tenants through the role template and the administrator catalog). Default clinical, aide and other roles hold none. Download is for the requester only, checked in the service and by the download guard. A fresh step-up is required on request, approve, reject and download (step-up keys equal the permission keys).
3. **D3: what is left out.** Messages under a legal hold (WP 5.6) are excluded and counted in the manifest as `heldExcluded`. Part 2 content is excluded and counted as `part2Excluded` at two levels: a care_team or bereavement channel whose subject patient carries the `sud` privacy flag (no other channel kind is asked, since its subject column is not a patient id), and any message in any channel that references a flagged patient (`message_entity_reference`, kind patient), so a dm, group or team channel cannot hand out a substance-use discussion. The flag is read in one call for every subject and referenced patient; an unreadable reader, an absent patient or a snapshot M5 has marked invalidated (it reports no flags while stale) fails the build closed with `EXPORT_PART2_UNKNOWN`, never "not SUD". At claim the requester must still be eligible (`EXPORT_REQUESTER_INELIGIBLE` otherwise). Channel membership is not required (this is a compliance export) but the scope is audited per job.
4. **D4: format and limits.** One JSON artefact: a manifest plus the messages, decrypted body text, attachment metadata only, no attachment bytes. PDF is a later slice. The link lives 24 hours after the artefact is ready (`EXPORT_LINK_TTL_HOURS`, set on the database clock and pinned by a CHECK). At most 3 live jobs (pending, approved, building, ready) per requester, 10 per rolling day, and 50 000 messages or 200 MB of plaintext JSON per job (`EXPORT_MAX_MESSAGES`, `EXPORT_MAX_ARTEFACT_BYTES`, the latter below the 256 MB whole-object read cap so a built artefact is always downloadable). The size is only known by reading, so the over-cap case fails at BUILD, after approval, with the failure code `EXPORT_TOO_LARGE` on the job (not a 409 at request); nothing is truncated silently. The snapshot edge of a build is the database clock, and the keyset cursor is the database text timestamp (microseconds survive).
5. **D5: scope.** Exactly one of a channel id or a patient id (that patient's care-team and clinical-linked channels), plus an optional date range of at most 366 days (both ends or neither). The scope is fixed at request by a guard trigger. The approver sees the scope and the justification (20 to 280 characters), not content.
6. **D6: artefact.** Built by a worker after approval. Encrypted at rest with a per-job random 256-bit data key wrapped by the tenant key (existing body-crypto helpers; no new crypto); the wrapped key sits in `wrapped_dek` and is dropped at expiry; the sha256 of the plaintext is recorded. Stored through the existing M36 attachment storage port. Download is an authenticated route that streams the decrypted JSON (no presigned URL), only to the requester, only while the job is `ready` and `expires_at > now()` on the database clock; each download writes one `message_export_download` row (guarded) and increments `download_count`. An hourly flag-independent sweep deletes expired objects and moves the job to `expired`.
7. **D7: flag and refusals.** Tenant flag `messaging.export` (absent = off) gates request only; approve, reject, cancel, download and the sweep never depend on it. Every refusal to open a job is the same neutral 404 (no existence, category or Part 2 oracle); state conflicts are 409 (`EXPORT_ALREADY_DECIDED`, `EXPORT_NOT_READY`, `EXPORT_EXPIRED`); the caps are 429 `EXPORT_LIMIT`, answered before the scope is looked at so a full quota is the same 429 for a real and an unknown scope; `EXPORT_TOO_LARGE` is a build failure code (D4).
8. **D8: events and audit.** PHI-free outbox events `m36.export.requested|approved|rejected|ready|downloaded|expired` carry the job id only. A consumer alerts the approvers on `requested` through a `system_locked` alert rule (`m36.export.requested`, holders of the approve permission, tenant administrators as the backstop). Both tables carry audit triggers (job severity warn, download info); the audit row omits the justification, decision note and wrapped key.
9. **D9: never.** Attachment bytes, edit or redaction, messages retention has already destroyed, author-deleted messages (the tombstone keeps its cipher, but the normal read path blanks it, so the export neither lists nor counts it), cross-tenant data, platform staff, external auditors, family or caregiver identities.

## What S1 builds (migration 1147)

`message_export_job` and `message_export_download`: FORCEd RLS on `app.org_id`, no app DELETE (only `chartwarden_destruction`), audit triggers, a job guard (insert forces status and instants and nulls the artefact fields; update is forward-only: pending_approval to approved|rejected|cancelled, approved to building, building to ready|failed, ready to expired; scope, requester, justification and request instant are frozen; instants come from the database clock; `expires_at` = `ready_at` + 24 h only on building to ready; expiry needs `expires_at <= now()` and drops the wrapped key), and a download guard (SECURITY INVOKER; the actor from `app.user_id` must be the requester and the job ready and unexpired now; allow-listed in `check-tenancy` like the break-glass read guard). Permissions with role grants, role-template and permission mirrors, manifest ownership, Drizzle schema, and the shared contract `packages/types/src/messaging-export.ts`. A migration pin test covers the text.

## Not built

The request, approve, reject, cancel, list, detail and download routes; the outbox events and the approver alert; the artefact builder and worker; the expiry sweep; the web screens; the tenant flag registration; the live suite. Slices follow in the WP 5.7 work package.

## Known limits

- (a) The artefact is decrypted plaintext JSON once downloaded; the control is who, how long and the trail, not what the recipient does with the file.
- (b) The approver decides from scope and justification only and cannot preview content.
- (c) A requester and an approver can still collude; both are named in the audit trail and the approver alert goes to every approver.
- (d) Part 2 and held messages are excluded, not disclosed under a separate authorization; a disclosure that needs them is a manual compliance process.
- (e) 24 hours and 50 000 messages are defaults, not agreed values.
- (f) JSON only; a human-readable PDF is later.
- (g) `patient_id` on the job is FK-less, like `channel.subject_id`.
- (h) The two-person rule is per account: one human holding two administrator accounts can still request with one and approve with the other. The database now binds the request to `app.user_id` (`requested_by`) and the decision to it (`decided_by`), so a caller cannot name someone else, but it cannot know two accounts are one person.
- (i) An approved job cannot be revoked (only a pending one is cancelled), a pending job does not expire, and a hold or a Part 2 flag that changes after the build is not reflected at download (the artefact is fixed at build time; it lives 24 hours).
- (j) `message_export_job.channel_id` cascades with the channel, so deleting a channel removes its export trail rows; `audit_event` survives.
- (k) The requester sees the `part2Excluded` and `heldExcluded` counts, and anyone holding a permission can infer flag state from them. Accepted.
- (l) A lost build enqueue is repaired by the hourly sweep, which enqueues again any job still `approved` after 15 minutes (the queue job id is the export job id). A hold released between the count and the pages lists the extra rows; the manifest counts what is listed.

## Open human items

1. **Approver role set:** are `compliance_officer`, `administrator` and `org_admin` the right approvers (and requesters)?
2. **Held messages:** exclude and count (D3), include, or require a legal-hold-owner approval?
3. **Part 2 content:** exclude and count (D3), or a separate Part 2 consent path?
4. **Format and expiry:** JSON only and 24 hours (D4), or PDF, a different expiry, or a different size cap?
5. Compliance and clinical-lead concurrence on D1 to D9.

## Slices

- **S0** this ADR and its index row.
- **S1** (built, migration 1147) the two tables, guards, audit, permissions and role grants, manifest and tenancy mirrors, Drizzle schema, shared contract, migration pin test.
- **S2** backend service, routes, events and approver alert.
- **S3** artefact builder, worker and expiry sweep.
- **S4** web request, approve and download screens.
- **S5** live suite and CI job.
