# M36 Route Table and Read-Path Trace (Phase 0 audit items 2 and 3)

> Part of the [Messaging Hub plan](../README.md); companion to [`PHASE_0_AUDIT.md`](./PHASE_0_AUDIT.md). **Date:** 2026-10-11 · **Method:** read-only
> code inspection, no live suites run, nothing exploited. "unverified" means not confirmed from code. Paths are relative to the repo root.
>
> Abbreviations. **SVC** = `apps/backend/src/modules/36-messaging/messaging-route-service-db.ts`. **RT** = `.../36-messaging/routes/messaging-routes.ts`.
> **WC** = `.../36-messaging/messaging-write-core.ts`. **TB** = `.../routes/messaging-typebox.ts`.

## 0. Cross-cutting facts (apply to every row unless a cell says otherwise)

| Concern | Fact | Evidence |
|---|---|---|
| Rate limiting | Global `onRequest` hook only: 600/min authenticated, 30/min unauthenticated. The bucket key is `org:<orgId>` once org-bound, so **every user in a tenant shares one 600/min bucket**. No per-route or per-user limit on send, DM-directory search or alert inbox. Fails open if the store is down. | `apps/backend/src/bootstrap/plugins/security.ts:26-29,91-132` |
| Idempotency (server) | Global `applyIdempotency` hook (all non-GET/HEAD). It acts **only if an `Idempotency-Key` header is sent**; fingerprint = org + user + key + body. M36 declares no `requireIdempotencyKey` anywhere. | `apps/backend/src/bootstrap/plugins/idempotency.ts:45-75`, mounted `bootstrap/index.ts:321` |
| Idempotency (web) | The shared `@chartwarden/ui` client adds `Idempotency-Key: crypto.randomUUID()` to every POST/PUT/PATCH/DELETE, **a fresh key per call**. A user re-clicking Send after a failure gets a new key, so the guard cannot dedupe a logical retry. | `packages/ui/src/core/api/client.ts:48-70,124`; send call `apps/web/src/modules/36-messaging/conversation-thread.tsx:436` |
| Validation | Every body, query and params object goes through `parse(<TypeBox schema>)` (`TB:414`), which throws the 422 `VALIDATION_FAILED` envelope. One caveat: the `channel_visibility` ABAC predicate runs **before** `parse` and reads raw `params.id` (RT:92). | RT, TB |
| Write audit | DB-level M4 triggers `trg_audit_<table>` on `channel`, `channel_member`, `message`, `message_receipt`, `alert`, `alert_rule`, `tenant_alert_routing_override`, `user_notification_preferences` and others. `delivery_endpoint`, `presence` and similar tables carry **none by design**. | `packages/db/migrations/0017_messaging_m36_rls_audit_triggers.sql:198-531` |
| Outbox events | The only event M36 routes publish is `m36.message.mentioned` (SVC:1171). There is no `m36.message.sent`, `.edited`, `.deleted`, `.read`, `.member_added` or `.member_removed`. | SVC:1171, `events-by-m36.ts:54` |
| Read-audit gate | Every GET under `/api/v1/messaging`, `/api/v1/alerts` and `/api/v1/notifications` must declare `auditRead` (emission config or reasoned `none`). `/api/v1/alert-rules` is outside the gated prefixes. | `bootstrap/index.ts:255-259` |
| Test coverage shape | **All HTTP-level route tests run over the in-memory `MessagingRouteService`, not the Drizzle service.** The Drizzle service is exercised by live suites only by calling its methods directly (section 4). There is no HTTP-level live suite and no cross-tenant HTTP IDOR suite for M36. | `messaging-routes.test.ts` header; section 4 |

Test keys used below:
- **R** = `apps/backend/__tests__/messaging-routes.test.ts` (non-live, in-memory service, via `inject`)
- **MNT** = `messaging-routes-mount.test.ts` (non-live, wiring only)
- **W** = `apps/web/src/modules/36-messaging/staff-messaging.dom.test.tsx` (non-live, mocked client)
- **N** = `apps/web/src/modules/36-messaging/notifications-inbox.dom.test.tsx` (non-live)
- **G64** = `gap064-messaging-read-audit.test.ts` (non-live)
- **G65** = `gap065-m36-part2-channel-gate.test.ts` (non-live, unit over ports)
- **MA** = `messaging-member-admin.test.ts` (non-live, DB service with injected deps)
- **L-MEM** = `m36-channel-membership-lifecycle.live.test.ts` (live, service methods directly, `chartwarden_app`)
- **L-ALR** = `m36-alert-outcome.live.test.ts` (live)
- **L-LOCK** = `m36-locked-alert-rule.live.test.ts` (live)
- **L-DEL** = `gap-101-m36-out-of-band-delivery.live.test.ts` (live)
- **L-RLS** = `packages/db/migrations/__tests__/m36-rls-isolation.live.test.ts` (live, table-level RLS only)

## 1. Route table (27 routes: 23 in `messaging-routes.ts`, 1 admin, 3 webhooks)

### 1a. Channels and messages

| # | Method and path | RBAC (`requirePermission`) | ABAC (`requireAbac`) | Read-audit (`auditRead`) | Write-audit / outbox | Idempotency-Key: server honours / web sends | TypeBox | Tests | Ref |
|---|---|---|---|---|---|---|---|---|---|
| 1 | GET `/api/v1/messaging/channels` | `messaging.read` | none; scoped by membership join in SVC | yes, `list:true`, kind `messaging_channel`; **no resourceIdParam** (list) | n/a | n/a (GET) | no input | R, MNT, W, L-MEM (service) | RT:156-167, SVC:665 |
| 2 | GET `/api/v1/messaging/channels/:id` | `messaging.read` | `channel_visibility` | yes, `resourceIdParam:"id"`, `patientIdPayloadPath:"patientId"` | n/a | n/a | params | R, G64; **no live test of `getChannel`** | RT:170-188, SVC:872 |
| 3 | GET `/api/v1/messaging/channels/:id/messages` | `messaging.read` | `channel_visibility` | yes, aggregate `list:true`, kind `message`, patient from payload; no per-message id | n/a | n/a | params + query | R, G64, W, L-MEM (`listMessages`) | RT:191-214, SVC:952 |
| 4 | GET `/api/v1/messaging/channels/:id/mention-candidates` | `messaging.read` | `channel_visibility` | yes, `resourceIdParam:"id"`, kind `message_mention_candidate` | n/a | n/a | params + query | R, W; no live test | RT:219-244, SVC:541-662 |
| 5 | POST `/api/v1/messaging/channels/:id/messages` | `messaging.send` | `channel_visibility` (same predicate as read) | n/a | `trg_audit_message`, `trg_audit_message_receipt`; outbox `m36.message.mentioned` per mentioned staff | yes / yes (fresh key per click) | params + body (`SendMessageBodySchema`, TB:87) | R, W, L-MEM (`sendMessage`); no attachment, parent or quoted tests | RT:247-267, SVC:1115 |
| 6 | PATCH `/api/v1/messaging/messages/:id` | `messaging.send` | **none** (author check in SVC only) | n/a | `trg_audit_message`; no outbox; no revision row | yes / yes | params + body | R only; **no live test** | RT:270-280, SVC:1192 |
| 7 | DELETE `/api/v1/messaging/messages/:id` | `messaging.send` | **none** (author check only) | n/a | `trg_audit_message` (soft delete, cipher retained); no outbox | yes / yes | params | R only; **no live test** | RT:283-288, SVC:1272 |
| 8 | POST `/api/v1/messaging/messages/:id/read` | `messaging.read` | **none** | no (POST; no `auditRead`) | `trg_audit_message_receipt`, `trg_audit_channel_member` (read pointer) | yes / yes | params + body | R, L-MEM (`markRead`, 1 call) | RT:291-301, WC `markMessagesRead` |

### 1b. DMs, care-team conversations, members, announcements

| # | Method and path | RBAC | ABAC | Read-audit | Write-audit / outbox | Idempotency (server / web) | TypeBox | Tests | Ref |
|---|---|---|---|---|---|---|---|---|---|
| 9 | POST `/api/v1/messaging/dm` | `messaging.dm` | none; both users checked active in SVC | no | channel and channel_member triggers; no outbox | yes / yes; also naturally idempotent via `dm_participant_key` + `onConflictDoNothing` | body | R, L-MEM (`openDm` x8) | RT:304-309, SVC:1367 |
| 10 | GET `/api/v1/messaging/dm/staff` | `messaging.dm` | none | **`none` waiver** ("name/role, no patient data") | n/a | n/a | query | R, W; no live test | RT:313-330, SVC:1307 |
| 11 | POST `/api/v1/messaging/patients/:patientId/care-team-channel` | `messaging.read` | none; roster or manual grant checked in SVC; uniform 404 conceal | yes, `resourceIdParam:"patientId"`, `patientIdParam:"patientId"` | channel and channel_member triggers via the M36 provider; no outbox | yes / yes (find-or-create) | params | R, W, care-team-assign.dom.test.tsx, L-MEM (`openCareTeamChannel` x6) | RT:335-353, SVC:1408 |
| 12 | POST `/api/v1/messaging/channels/:id/members` | `messaging.manage_members` | `channel_member_admin` (`breakGlassBypassable:false`) | n/a | `trg_audit_channel_member` with the real actor (GAP-103); no outbox | yes / yes; service is idempotent | params + body | R, MA | RT:356-371, SVC:1512 |
| 13 | DELETE `/api/v1/messaging/channels/:id/members/:userId` | `messaging.manage_members` | `channel_member_admin` | n/a | `trg_audit_channel_member`; no outbox | yes / yes | params | R, MA | RT:374-387, SVC:1540 |
| 14 | POST `/api/v1/messaging/announce` | `messaging.announce` (org_admin) | none | n/a | channel and message triggers; no outbox; **adds no members, so no receipts** | yes / yes | body | R only; no live test | RT:390-398, SVC:1560 |

### 1c. Notification preferences and endpoints (self-only)

| # | Method and path | RBAC | ABAC | Read-audit | Write-audit / outbox | Idempotency (server / web) | TypeBox | Tests | Ref |
|---|---|---|---|---|---|---|---|---|---|
| 15 | GET `/api/v1/notifications/preferences` | `notifications.preferences.manage` | none (user id from context) | **`none` waiver** | n/a | n/a | no input | R; no live test of `getPreferences` | RT:403-417, SVC:1596 |
| 16 | PUT `/api/v1/notifications/preferences` | same | none | n/a | `trg_audit_user_notification_preferences` | yes / yes | body | R, L-MEM (`putPreferences` x1) | RT:420-429, SVC:1629 |
| 17 | POST `/api/v1/notifications/endpoints` | `notifications.endpoint.manage` | none | n/a | `delivery_endpoint` has **no audit trigger by design**; no outbox | yes / yes | body | R, L-DEL (`registerEndpoint`), gap062-063-transport-binding.test.ts | RT:432-444, SVC:1705 |
| 18 | POST `/api/v1/notifications/endpoints/:id/verify` | same | none | n/a | same | yes / yes | params + body | R, L-DEL (`verifyEndpoint`), m36-endpoint-verification.test.ts | RT:447-456, SVC:1763 |
| 19 | DELETE `/api/v1/notifications/endpoints/:id` | same | none | n/a | same | yes / yes | params | R only; no live test of `removeEndpoint` | RT:459-468, SVC:1823 |

### 1d. Alerts and alert rules

| # | Method and path | RBAC | ABAC | Read-audit | Write-audit / outbox | Idempotency (server / web) | TypeBox | Tests | Ref |
|---|---|---|---|---|---|---|---|---|---|
| 20 | GET `/api/v1/alerts/inbox` | `messaging.read` | none; `recipient_user_id = actor` | yes, `list:true`, kind `alert`. **This GET writes** `notification_delivery` and `alert.outcome` (`trg_audit_alert`). | writes from a GET; no outbox | n/a (GET) | no input | R, MNT, G64, N, L-ALR (`alertInbox` x9) | RT:473-484, SVC:1834-1970 |
| 21 | POST `/api/v1/alerts/:id/read` | `messaging.read` | none; requires a delivery row for the actor | no | `alert_read_receipt` (audit trigger: unverified) | yes / yes; `onConflictDoNothing` | params | R, L-ALR (`markAlertRead` x1) | RT:487-494, SVC:1972 |
| 22 | GET `/api/v1/alert-rules` | `alert.rules.read` | none | not required (outside gated prefixes) | n/a | n/a | no input | R, m34-alert-rule-seed.test.ts | RT:497-500, SVC:2005 |
| 23 | PATCH `/api/v1/alert-rules/:id` | `alert.rules.manage` | none | n/a | `trg_audit_alert_rule`, `trg_audit_tenant_alert_routing_override` | yes / yes | params + body | R, messaging-patch-alert-rule-locked.test.ts, L-LOCK (`patchAlertRule` x6) | RT:503-508, SVC:2023 |

### 1e. Admin and webhooks (different auth model)

| # | Method and path | Auth | Read/write audit | Idempotency | TypeBox | Tests | Ref |
|---|---|---|---|---|---|---|---|
| 24 | GET `/api/v1/admin/messaging/alert-deliveries` | `requireAbac("messaging.admin.read", "messaging_admin_platform_ops")`; cross-tenant, platform-ops | audit written **before** the response is released; a failed audit fails the request | n/a | query + manual ISO check | m36-admin-alert-deliveries.test.ts (non-live) | `routes/admin-alert-deliveries-routes.ts:156-178` |
| 25 | POST `/webhooks/twilio/sms-status` | none (unauthenticated); replay window then HMAC-SHA1 | `notification_delivery` reconcile | not applicable (skipped, no org) | no TypeBox; defensive `bodyMap` | messaging-webhooks.test.ts, m36-delivery-sweep-and-webhooks.test.ts (non-live), L-DEL | `routes/webhook-routes.ts:81` |
| 26 | POST `/webhooks/twilio/voice-status` | same | same | same | same | same | `webhook-routes.ts:100` |
| 27 | POST `/webhooks/postmark/event` | replay window (Date header), IP allowlist + bearer token | same | same | same | same | `webhook-routes.ts:119` |

### 1f. Counts

- Routes: **27** (23 tenant-user, 1 admin, 3 webhook).
- Rows 1-23 missing a **declared read-audit where one would be expected**: row 8 (`markRead`, benign) and row 21 (alert read, benign). No GET is missing the gate (the gate enforces it).
- Routes that **do not require** an `Idempotency-Key` (all of them): **23/23 tenant routes** (server honours but never requires). Web sends a fresh key on all mutating ones, which does not give logical-retry idempotency.
- Routes where idempotency matters and the only protection is incidental: row 5 (send), row 14 (announce), row 6/7.
- Routes with **no live test of the Drizzle service method**: rows 2, 4, 6, 7, 10, 14, 15, 19, 22 (9 routes). Rows 12 and 13 have only the non-live `MA` suite.
- Routes with **no HTTP-level live test at all**: **all 27**.
- Routes with **no ABAC** and a resource-bound action that should have one: rows 6, 7, 8 (see findings H1, L2).

## 2. Non-membership read paths: how rows are restricted

The shared channel gate is `canViewChannel` (SVC:1074-1112): active `membership` AND active `user` (`isActiveMessagingUser`, SVC:251-269), then a live `channel_member` row (`removed_at IS NULL`), then `effectivelyVisibleChannels` (SVC:151-208), which for `care_team` channels re-asks the Part 2 gate (`allowedUserIds`) and, for `source = 'auto'` members, the `CareTeamProvider` roster. Any seam error is a denial.

| Read path | How rows are restricted | Can a non-member read a message or channel? | Suspended / revoked / deactivated user | Part 2 (gap065) |
|---|---|---|---|---|
| GET `/channels` (SVC:665) | SQL: `channel_member` join on actor, `removed_at IS NULL`; `isActiveMessagingUser` first; then `effectivelyVisibleChannels`; unread, mention and latest-message queries scoped with `inArray(channelId, authorized ids)` | No | Returns `[]` (proved live: `L-MEM:231`) | Filtered per patient; titles and previews resolved only after the filter |
| GET `/channels/:id` (SVC:872) | **ABAC predicate only.** The handler itself has no membership or active-user check; it selects the channel by `(org, id)` and returns members and counts | Only if the predicate passes. Defence in depth is missing: any other in-process caller of `getChannel` skips the check | Denied by predicate (active-user check inside `canViewChannel`) | Via predicate |
| GET `/channels/:id/messages` (SVC:952) | **ABAC predicate only**; handler filters on `(org, channelId)` and decrypts every row | Same as above | Denied by predicate | Via predicate; a consent revocation closes the whole channel at once |
| GET `/channels/:id/mention-candidates` (SVC:541) | Own membership + `effectivelyVisibleChannels` for the actor, then each candidate staff is re-checked through `effectivelyVisibleChannels`; patient candidate only on a `care_team` channel for its own subject | No. For an `announcement` channel the candidate check passes without a member row (see H2) | `assertActiveMessagingUser` gives 404 | Each staff candidate re-gated |
| GET `/alerts/inbox` (SVC:1834) | SQL: `notification_delivery.recipient_user_id = actor` joined to `alert.organization_id = org`; RLS parent-join is the backstop | Only the actor's own deliveries; **no cross-user read** | **No active-user check.** A suspended user whose session still resolves reads their own historical alerts | **No Part 2 or patient-access re-check**: alerts delivered earlier stay readable after the user lost access to the patient or consent was revoked. The free-text `payload.message` is surfaced as `summary` (`alert-inbox-presentation.ts:38-45`); what it contains depends on each emitter (unverified) |
| POST `/alerts/:id/read` | Requires a delivery row for the actor | Only own alerts; foreign id gives 404 | No active check | n/a |
| GET `/dm/staff` (SVC:1307) | Org-wide directory of active members, minus self, ILIKE on **name or email**, 25 rows, with roles | Not message data; but every `messaging.dm` holder can enumerate all active staff names and roles in the tenant, and probe email substrings | Actor must be active; suspended or revoked peers excluded | n/a |
| POST `/patients/:patientId/care-team-channel` (SVC:1408) | `PatientReader` ownership, roster or manual membership, post-sync revalidation, uniform 404 | No (no existence oracle by design) | Actor active check first | Sync applies the Part 2 gate; final row needs a live member row |
| Announcements | `canViewChannel` returns true for any active user with no member row (SVC:1087-1093) | **Yes by design (org-wide)**, but see H2 | Active check applies | n/a |
| Bereavement | No dedicated route. Same `channel_member` rule; the spec's bereavement-membership refinement is not implemented (comment SVC:1085-1086) | Only members | Active check applies | n/a |
| Unread and mention counts | Computed from the actor's own `message_receipt` rows, restricted to authorized channel ids (list) or one channel (detail) | Cannot leak other users' counts | n/a | Counts are not computed for filtered channels in the list; `getChannel` counts are behind the predicate |
| Search-like | There is no message search endpoint. `mention-candidates` and `dm/staff` are the only typeahead surfaces | n/a | n/a | n/a |

### 2.1 Where F3 stands (correction to the audit)

The audit says M36 does not consume `m2.membership.revoked/suspended` or `m2.user.deactivated`, which is true. But **the read and send paths do not depend on the consumer**: every channel-scoped route re-checks `membership.status = 'active'` and `user.status = 'active'` at request time (`isActiveMessagingUser`), and receipt fan-out also filters on active membership (`WC activeMemberIds`). Proved live for `suspended` (`L-MEM:215-250`); `revoked` and `deactivated` fall in the same `status <> 'active'` branch but have no dedicated assertion. What the missing consumer still leaves open:

1. **Write paths with no active-user or membership check:** edit, delete, mark-read (H1, L2).
2. **Alert paths with no active-user check:** inbox, alert read (M4).
3. **`channel_member` rows are never soft-removed** on offboarding, so drift persists until something else removes them. Matters for admin views (`getChannel.members`) and for the future socket rooms.
4. **Sockets (WP 1.1)** will need the push half (`disconnectSockets`), which has no pull-time equivalent.

## 3. Findings

### 3.1 Security and integrity (ranked)

**H1 (High). Edit, delete and mark-read have no channel, active-user, archive or Part 2 check; edit has no time window and no revision.**
- `PATCH`/`DELETE /messaging/messages/:id` are guarded by `messaging.send` only (RT:270,283). The service checks `authorUserId === actor` and nothing else (SVC:1204-1253 edit, 1272-1292 delete).
- Reproduction shape: user A authors a message in a care-team channel, is then taken off the caseload (or suspended, or Part 2 consent revoked). `PATCH /api/v1/messaging/messages/<A's message id>` with `{"body":"..."}` using A's still-valid session returns 200 and **overwrites `body_cipher`/`body_sha256`** (SVC:1230-1234); `DELETE` returns 204 and tombstones it for every reader. Expected: 403/404 once A cannot view the channel. Archived (discharged) channels are also editable, although send returns 410.
- The route comment says "within the edit window" (RT:269, `route-service.ts:212`) but no window is enforced in the route, service or schema (grep of M36 and 0016/0017 finds none).
- The edit leaves no prior version (the audit trigger records the row change, but there is no `message_revision`); the hash chain is rewritten.
- Owner: **WP 1.4** (membership safety on every write) + **WP 1.3** (revisions, edit window, redaction).

**H2 (Medium-High). Announcement channel: send bypasses `messaging.announce`; announcements reach nobody.**
- `canViewChannel` returns visible for kind `announcement` to any active user (SVC:1087-1093), and the send route gates on `channel_visibility` plus `messaging.send` (RT:247-249). `sendMessage` never checks the channel kind (SVC:1115-1190).
- Reproduction shape: a non-admin with `messaging.send`/`messaging.read`, knowing the announcement channel UUID, sends `POST /api/v1/messaging/channels/<announcement id>/messages {"body":"x"}`; expected 403, possible 201 with a message authored by a non-admin in the org-wide channel. Precondition: the id. It is not returned by `GET /channels` (membership join) and `announce` returns it only to the org_admin (SVC:1560-1594), so discovery is by other means (audit logs, deep links, an admin sharing it). Exposure is lower than the shape suggests, but the control is absent.
- Separate defect: `announce` creates the channel and message but **inserts no `channel_member` rows** (SVC:1560-1594; the provider adds only the creator, `messaging-provider-db.ts:~135`). `activeMemberIds` is therefore empty, so no `message_receipt` rows, no unread, and the channel never appears in `GET /channels`. Whether the web shows announcements by another path is unverified.
- Owner: **WP 2.9** (announcements) for the model; the send-path kind check belongs in **WP 1.7**.

**M3 (Medium). `parentMessageId` and `quotedMessageId` are unvalidated (confirms F5, sharper than stated).**
- Route passes them through (RT:259-260); `insertEncryptedMessage` inserts them verbatim (WC:128-129). The only constraint is a plain FK on `message(id)` (`0016_messaging_m36_tables.sql:232-233`), with `ON DELETE no action`. There is no `organization_id` or `channel_id` in the FK and no trigger (grep of migrations).
- Consequences: (a) a parent in **another channel** of the same tenant is accepted; (b) a parent in **another tenant** is accepted, because FK checks do not apply RLS, and a nonexistent id raises a DB FK error instead of a typed 404/422, which is an existence oracle between 201 and the error; (c) the cross-tenant pointer plus `no action` can **block hard-delete/erasure of the victim tenant's message**; (d) `listMessages` returns `parentMessageId` (SVC:1009,1052) but not parent content, so there is no content leak today, but WP 2.2's thread panel would turn this into one.
- Reproduction shape: `POST /api/v1/messaging/channels/<mine>/messages {"body":"x","parentMessageId":"<uuid of a message in channel the caller cannot view>"}`; expected 422; possible 201, and the response of a later `GET .../messages` echoes the foreign id.
- The web never sends either field (`conversation-thread.tsx:436-445`; the `parentMessageId: null` seen at :464 is only the optimistic row).
- Owner: **WP 1.9** already lists the same-channel check; recommend a composite FK or trigger (org + channel) in **WP 1.8**, and validation in the service.

**M4 (Medium). Alert inbox is a GET that writes, and has no active-user or access re-check.**
- SVC:1834-1900 updates `notification_delivery.status` and `alert.outcome` on every poll (F-109 rationale in-code). It is audited as a read (`list:true`) but the writes also fire `trg_audit_alert`. Two concurrent tabs race on the roll-up.
- No `isActiveMessagingUser`, no Part 2 or patient-access re-check on historical alerts (section 2).
- Owner: **WP 1.4** (add active-user check) and **new** (alert-inbox read model: split the read from the in-app "delivered" settlement; filter on current patient access).

**M5 (Medium). `attachments[]` is accepted and silently dropped (confirms F4, answers item 6).**
- `AttachmentSchema` (TB:80-85) accepts `{storageKey, fileName, contentType, byteSize<=25MB}` x10; the route forwards it (RT:261). `createDbMessagingRouteService.sendMessage` never reads `input.attachments` (grep for "attachment" in SVC: no hit). The `message_attachment` table exists (0016:79, RLS in 0017) and is written by nothing (only the eraser reads it, `erasers/messaging-eraser.ts:85`).
- Result: the client gets **201 with no error and no attachment**. `storageKey` is not validated against any tenant or object store. The in-memory service used by the tests does not store them either, and no test sends one.
- The web client never sends `attachments`.
- Owner: **WP 1.5**. Until then, reject a non-empty `attachments` with 422 rather than dropping it (one-line change; **new** hotfix item in WP 1.5 or WP 0.7).

**M6 (Medium). Idempotency is optional and the web mints a new key per click (confirms F6/F13 with an addition).**
- Section 0. A send that times out ambiguously and is retried by the user is a duplicate message, and a duplicate clinical message fans out duplicate receipts and mention alerts.
- Owner: **WP 1.2** (require the key on send, announce, escalation; derive the key from a client-generated `clientMessageId` that persists across retries, which the current client does not do).

**M7 (Medium). Authorization lives only in the route predicate for the read handlers.**
- `getChannel` and `listMessages` do not re-check visibility, and `sendMessage` re-checks nothing (it relies on the earlier predicate call, a check-then-act gap measured in milliseconds). Other in-process callers (`message-mentions` consumer, portal provider) bypass the predicate by construction.
- Owner: **WP 1.7**.

**L1 (Low). `dm/staff` enumerates the tenant directory and probes email.** ILIKE on `user.email` (SVC:1322-1325) lets any `messaging.dm` holder test whether an email fragment exists among active staff (results show names only). Waived from read-audit by an explicit `none`. Owner: **new** (WP 5.x privacy review; consider restricting to name and adding a rate limit).

**L2 (Low). `markRead` is an in-tenant message-existence oracle and ignores membership.** 404 vs 204 distinguishes a real message id in the org from a random one (WC:156-166); it only flips the caller's own receipts and advances the pointer for an active member, so no data changes. Owner: **WP 1.7**.

**L3 (Low). Non-UUID `:id` reaches the ABAC predicate before `parse`.** `canViewChannel` passes the raw string into a uuid-typed `eq` (SVC:1081-1084); Postgres would raise `22P02`, which is not caught there, so the likely result is a 500 instead of a 404 (unverified, not exercised). Owner: **WP 1.7**.

**L4 (Low). Rate limiting is tenant-wide only (section 0).** One user or integration can exhaust the org bucket; there is no send-rate or typeahead limit. Owner: **new** (WP 1.1 handles socket rate limits; HTTP per-user limit is unowned).

### 3.2 Test-coverage gaps

- No HTTP-level live test for any route; the route tests (R) never touch SQL, so UUID handling, the `withOrgContext` path and the Part 2 gate in the real service are not exercised through HTTP. Owner: **WP 1.7**.
- Live service tests cover: `listChannels`, `canViewChannel`, `listMessages`, `sendMessage`, `markRead`, `openDm`, `openCareTeamChannel`, `putPreferences`, `alertInbox`, `markAlertRead`, `patchAlertRule`, `registerEndpoint`, `verifyEndpoint`. Not covered live: `getChannel`, `editMessage`, `deleteMessage`, `searchMentionCandidates`, `searchDmEligibleStaff`, `announce`, `getPreferences`, `removeEndpoint`, `listAlertRules`; `addMember`/`removeMember` only non-live (`MA`).
- No test sends `parentMessageId`, `quotedMessageId` or `attachments`; none asserts "revoked or suspended author cannot edit/delete".
- `test:rls:live:m36` (L-RLS) proves table RLS as `chartwarden_app`, not route-level IDOR.

## 4. Answers to the specific audit items

**Item 6 (`attachments[]`):** accepted by TypeBox (max 10), forwarded by the route, ignored by the Drizzle service; 201 is returned with no attachment stored and no validation of `storageKey` (M5). Confirms F4 and adds the silent-drop behaviour.

**F5 (threads):** confirmed and strengthened (M3): no same-channel or same-tenant validation, plain FK, cross-tenant pointer and delete-blocking possible. The web never sends the fields.

**F6/F13 (idempotency):** confirmed. Addition: the web does send a header on every mutation (`packages/ui/src/core/api/client.ts:62-70`) but a fresh one per call, so the audit's "unconfirmed" is now confirmed, and it does not protect against user retry (M6).

**F9 (read auditing):** confirmed, with specifics: resource-id params on channel detail, mention-candidates and care-team-channel; aggregate list audit with `patientIdPayloadPath` on message history; list audit without ids on channel list and alert inbox; two reasoned waivers (`dm/staff`, preferences GET). `resourceIdParam` is correctly absent only on list reads.

**F3 (offboarding):** partially contradicted for reads (section 2.1).

## 5. Summary: gaps ranked by severity and owning work package

| Rank | Gap | Severity | Owner (03-phases-0-to-3.md) |
|---|---|---|---|
| 1 | H1: edit/delete/mark-read lack membership, active-user, archive and Part 2 checks; no edit window; edit overwrites with no revision | High | WP 1.4, WP 1.3 |
| 2 | H2: announcement send bypasses `messaging.announce`; announcements have no members, no receipts | Medium-High | WP 2.9 (+ WP 1.7 for the kind check) |
| 3 | M3: unvalidated `parentMessageId`/`quotedMessageId` (cross-channel, cross-tenant, FK oracle, delete-blocking) | Medium | WP 1.9 (+ WP 1.8 for composite FK) |
| 4 | M5: `attachments[]` silently dropped with 201 | Medium | WP 1.5 (interim 422: new) |
| 5 | M6: idempotency optional; web key per click | Medium | WP 1.2 |
| 6 | M4: alert inbox GET writes; no active/Part 2/patient re-check | Medium | WP 1.4 + new (alert-inbox read model) |
| 7 | M7: service handlers rely on route predicate only | Medium | WP 1.7 |
| 8 | No HTTP-level live suite; 9 service methods without live coverage | Medium | WP 1.7 |
| 9 | `channel_member` rows not soft-removed on offboarding; no `m2.*` consumer | Medium | WP 1.4 |
| 10 | L1: `dm/staff` directory and email probe | Low | new (privacy review) |
| 11 | L2/L3: markRead oracle; non-UUID reaches predicate | Low | WP 1.7 |
| 12 | L4: tenant-wide-only rate limit | Low | new |
| 13 | No message-lifecycle outbox events (`sent/edited/deleted/member_*`) | Info (blocks WP 1.1 realtime hints) | WP 1.1 |
