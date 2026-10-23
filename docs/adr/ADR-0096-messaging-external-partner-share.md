# ADR-0096 — Messaging external partner share: one conversation, explicit, expiring, instantly revocable, read-only

- **Status:** **Proposed** (2026-10-23). Backend and the staff admin screen are built (see Implementation status), flag-off by default. Legal (BAA) review, clinical-lead sign-off on what may be shared, and compliance concurrence are NOT recorded; decisions D1 to D12 are the build team's defaults.
- **Date:** 2026-10-23
- **Phase:** Messaging Hub Phase 6, WP 6.6 (capability AW-10 "approved external partners").
- **Related:** [ADR-0087](ADR-0087-messaging-break-glass.md) and [ADR-0089](ADR-0089-messaging-export.md) (the grant, guard-trigger, step-up and flag patterns reused here), [ADR-0086](ADR-0086-messaging-retention-and-legal-hold.md), [ADR-0010](ADR-0010-tenancy-rls-invariants.md), the M2 auditor two-stage session (`apps/backend/src/modules/02-identity/auditor-enrolment.ts`, M2 spec 7.7), M31 portal engagement scope.

## Context

WP 6.6: "`external_share`: explicit, expiring, single-conversation scope for e.g. pharmacy/DME; partner identity via M31/M29 patterns; no PHI over out-of-band channels. Partner sees only shared conversations/resources; revocable instantly." Every other M36 reader is a workforce member (ADR-0010 tenancy plus channel membership). A partner is not a workforce member, has no `user` row, and must never gain one as a side effect (a user row would carry roles, a default organisation and the whole `messaging.read` surface). This is the largest new trust boundary in the module, so the default is as small as it can be: read one conversation, for a short time, through a surface that can only ever answer for that one share.

## Decision (proposed)

1. **D1: scope is exactly one conversation.** One `message_external_share` row names one `channel_id` (composite FK to `channel`). There is no multi-channel share, no patient scope, no "all my threads". Only `dm`, `discipline`, `location` and `on_call` channels may be shared. `care_team` and `bereavement` (a patient subject, 42 CFR Part 2 exposure) and `announcement` (a tenant-wide broadcast) are refused with the same neutral 404 as an unknown channel. The check is in the service and, for the channel kind, repeated at every partner read (a channel cannot change kind, but the read is self-contained).
2. **D2: live, but only what was posted after the share, minus clinical content.** The partner sees messages in that channel with `created_at >= shared_from` (the database clock at creation, frozen by a guard trigger) that are: not deleted, not redacted (an approved redaction, ADR-0055), `body_kind` plain/markdown/rich (never `system`), and carry NO attachment, NO clinical link, NO structured entity reference (a patient or staff mention) and no chart-promotion request. The history before the share is never visible. *Why live and not a snapshot:* a snapshot freezes the first PHI-bearing answer and forces a second copy of message bodies outside the cipher; live-from-now keeps one encrypted store, one redaction path, one retention path, and makes revoke and expiry true cut-offs. *Why "after the share":* the people who wrote earlier messages did not know a partner would read them. *Why the exclusions:* attachments and clinical links are the highest-PHI content and the least reviewable, and a patient mention is how a message becomes patient-specific. "Explicitly marked shareable" content (a per-message opt-in) is deferred: nothing in this slice lets an attachment or clinical content reach a partner (open item 3). The exclusions are by structure, never by reading text, so a patient named in free text is NOT detected (known limit a).
3. **D3: expiry.** The share carries `expires_at`, default 7 days, at most 30 (`CHECK expires_at <= shared_from + 30 days` and `> shared_from`). A share cannot be extended: expiry is frozen; to continue, create a new share (a new `shared_from`, so the partner does not see the gap as continuous history either). A partner session never outlives its share.
4. **D4: revocation is instant because nothing is cached.** Every partner request resolves the session and the share in ONE SQL statement on the database clock: `share.revoked_at IS NULL AND share.expires_at > now() AND session.expires_at > now()`. No in-process or Valkey grant cache, no JWT, no "check at login". Revoking sets `revoked_at` (guard: once, by the acting user, forward only); the next partner request returns the uniform 404. Revoke never depends on the tenant flag and needs only the manage permission plus a fresh step-up.
5. **D5: partner identity (M31/M29-style, no user account).** A *partner access principal*, deliberately not a Better Auth session and not a `user`:
   - **Invitation (stage 0).** Creating a share returns, once, a 256-bit one-time invite token (`base64url`, 43 chars) and an 8-digit verification code. Only `sha256(token)` and an scrypt hash of the code are stored. The token is bound to its organisation in the redeem body (`organizationId` + `token`, the auditor-redeem shape) so the lookup runs under that tenant's RLS: a token presented against another tenant matches nothing.
   - **Enrolment stage.** Redeeming the token (single use, atomic `invite_redeemed_at` update) mints a partner session token (256-bit, stored as `sha256`, bearer in the `Authorization` header, so it is not ambient and needs no CSRF defence) in stage `enrolment`. That session reaches only `POST /partner/verify` and `GET /partner/shares/:id` (state). Everything else answers the uniform 404.
   - **Second factor, then active.** `POST /partner/verify` takes the 8-digit code, which the staff member who created the share must give the partner through a DIFFERENT channel than the link (a phone call). Five wrong attempts lock the share (`code_attempts`, a CHECK, and it never resets): the administrator revokes and issues a new one. On success the session moves to `active` (guard: forward only) and only then can read.
   - *Departure from the auditor pattern, stated plainly:* auditors prove TOTP because they are `user` rows with an authenticator; a partner has none, so the second factor is the out-of-band code. It is weaker than TOTP (a code spoken once, valid for the share's life). TOTP/passkey for partners is an open item (4).
6. **D6: what a partner can post — nothing in this slice.** `access` is a column fixed to `'read'` by CHECK. A reply would need a message author kind other than `user`/`system`, a send path that bypasses channel membership, and clinical-lead review of what a pharmacy may write into the record; it is deferred (open item 2). A read-only partner also cannot mark anything read, react, or learn who else is a member.
7. **D7: every partner read is audited, fail closed.** Each successful read inserts one `message_external_share_read` row (share, session, count of messages returned) in the same transaction, before any byte is returned; if the insert fails the caller gets no messages. Both tables, plus the share, carry the 1107-style PHI audit triggers (the share audit row omits the invite and code hashes and the partner free text). Share creation and revocation also publish trail-only outbox events (`m36.external_share.created|revoked`, ids and instants only).
8. **D8: legal hold, redaction, retention.** A legal hold changes nothing for a partner (the share is read-only and does not alter retention); the message under hold stays visible only if it was visible before. An approved redaction hides the message from the partner on the next request (the same `message_redaction` mask staff reads use). Retention destruction of a message removes it from the partner view; the destruction role may delete share rows (tenant offboarding), but `audit_event` rows survive.
9. **D9: no PHI out of band.** M36 sends the partner nothing. The invitation link and the code are shown once to the creator, who delivers them; the admin screen says link and code must travel separately. `partnerNotificationText()` is the single fixed string any future sender may use ("You have a new secure message. Sign in with your link to read it.") and takes no argument, so it cannot carry a name, a channel, a patient or a body. No email or SMS binding is built or wired (open item 5).
10. **D10: limits.** Redeem and verify are budgeted per client address and per organisation before any database work (the auditor limiters). Reads are limited per share (60 per minute) and capped at 50 messages per page. The code has 5 attempts per share. A tenant may hold at most 10 live shares at once, and a creator at most 3 per rolling day (anti-sprawl).
11. **D11: flag and permission.** Tenant flag `messaging.external_partners` (absent = off). Off: creating a share is the uniform 404 and EVERY partner route is the uniform 404, so turning the flag off cuts all partner access at once, without touching rows. Listing and revoking shares need only the permission, never the flag (a share that exists stays revocable). New permission `messaging.share.manage`, granted by the migration to `compliance_officer`, `administrator`, `org_admin` only (existing tenants) and by the compliance_officer template (new tenants); no clinical, aide or other role holds it. A fresh step-up is required to create and to revoke (step-up key = permission key). Creation also requires a BAA reference (1 to 120 characters, a contract id or the like) the creator attests exists; the platform cannot verify it (open item 1).
12. **D12: uniform refusals.** Unknown share, other tenant, other conversation, expired, revoked, flag off, wrong stage, bad token: the same 404 body. Distinguishing "expired" from "unknown" would be an oracle for share ids and a hint to the attacker; the partner view learns "access ended" from the 404 on the state route alone.

## Threat model

| Threat | Control |
|---|---|
| IDOR across shares (guess another share id) | Partner routes take the share id in the URL only to compare it with the session's own share; mismatch is the uniform 404. There is no list-shares route for a partner. |
| IDOR across tenants | The org comes from the redeem body for the invite and from the token prefix for the session; every query is under `withOrgContext` (FORCE RLS); the composite FKs make a cross-tenant link unrepresentable. |
| Enumeration of share ids / tokens | Ids and tokens are random (122 and 256 bits); refusals are uniform; redeem/verify are rate limited per IP and org; code attempts are capped per share. |
| Privilege creep into other conversations | The reader's only channel is `share.channel_id` read from the row in the same statement as the session; no channel id ever comes from a request; no `user` row exists, so no staff permission or ABAC predicate can match. |
| Expiry bypass | Expiry is judged by the database clock in the same statement as the read; no cache; sessions are bounded by the share. |
| Stolen session token | 256-bit bearer, hashed at rest, bound to a stage and a share; dies with the share; revocation is instant. A stolen token before the code step reaches nothing. Not device-bound (known limit c). |
| Brute-forcing the 8-digit code | 5 attempts per share in a CHECK-bounded counter, never reset; scrypt-hashed. |
| Replay of the invitation | Single use (atomic update); the token is useless after redemption. |
| Content in notifications | M36 sends none; the fixed text takes no input; events carry ids only. |
| Staff unaware a partner reads their channel | Share creation is audited and announced on a trail event; an in-channel banner for members is NOT built (open item 6). |
| A compromised administrator shares widely | Permission limited to three roles, step-up, caps (10 live per tenant, 3 per creator-day), BAA reference, audit on every create, revoke and read. |

## Implementation status

Migration 1180: `message_external_share`, `message_external_session`, `message_external_share_read`, the permission and its role grants. Backend: `modules/36-messaging/external-share/` (store, service, partner reader, events, notification text), routes `routes/external-share-routes.ts` (staff: create/list/revoke) and `routes/partner-routes.ts` (partner: redeem, verify, state, messages), the tenant flag, the composition-root limiter binding, the live suite `test:m36:external-share:live` with its CI job. Web: `/messaging/partners` (list, create, revoke) on the shared kit. **Not built:** the partner-facing web view (the link currently lands on the API only), partner replies, partner notification delivery, shareable marking of attachments/clinical content, TOTP/passkey for partners, an in-channel banner for members, a partner directory.

## Known limits

- (a) Patient names in free text are not detected; the exclusions are structural. Content the sender types about a patient is visible to the partner. The share is for non-clinical coordination conversations; the admin screen says so, and clinical-lead review is open.
- (b) The second factor is a spoken code, not a device-bound authenticator.
- (c) Session tokens are not device- or IP-bound.
- (d) A partner sees author display names of staff who posted after the share.
- (e) Edits after the share are visible as edited text; the pre-edit revision is never shown (revisions are not read).
- (f) The 7/30-day expiry, the 10/3 caps and the 60-per-minute read limit are defaults, not agreed values.
- (g) The BAA reference is an attestation, not a verified link to a contract record.

## Open human items

1. **Legal/BAA:** is a free-text reference enough, or must a partner directory with a stored BAA exist first? Which partner kinds (pharmacy, DME, other) may be shared at all?
2. **Replies:** may a partner post? If so, as what author kind, into what, and with whose review?
3. **Shareable marking:** may attachments or clinical links ever be shared, and who marks them?
4. **Partner authentication strength:** is the out-of-band code acceptable, or must partners enrol TOTP/passkey?
5. **Notification delivery:** who sends the invitation and the "you have a message" text, and through which vendor under which BAA?
6. **Member awareness:** must channel members see a banner that a partner has access?
7. Compliance and clinical-lead concurrence on D1 to D12.

## Slices

- **S0** this ADR and its index row.
- **S1** (built, migration 1180) three tables, guards, audit, RLS, permission and role grants, mirrors.
- **S2** (built) service, routes, events, flag.
- **S3** (built) live suite, CI job, unit tests.
- **S4** (built) staff admin screen. The partner view is not built.
