# Phase 0 Audit — M36 Messaging (repository-grounded)

> Part of the [Messaging Hub plan](../README.md). **Date:** 2026-10-11 · **Branch:** `main` · **Method:** read-only inspection (grep/read of
> routes, services, web, migrations, ADRs, neighbouring modules) plus `arch:tenancy`. **Not yet done:** running live suites, row counts
> on the demo/prod database, and a full read of the 2,132-line `messaging-route-service-db.ts`. Items marked *unconfirmed* need that follow-up.

## 1. Headline findings

| # | Finding | Impact on plan |
|---|---|---|
| F1 | **No realtime exists, by decision.** ADR-0036 (Accepted) records no socket server; `socket.io` is installed nowhere; the only realtime artefact is the pure contract in `packages/messaging/src/realtime`. Web polls (thread 15 s, backoff to 60 s). ADR-0036 names *Socket.IO + Valkey adapter* the leading candidate and says a realtime build **needs its own ADR** | D1 stands. New ADR must **supersede ADR-0036 §2–3**. Polling at 15 s cannot meet the p95 < 2 s target |
| F2 | **M14 `idg_action_item.idg_meeting_id` is NOT NULL** (cascade-deletes with the meeting) | **D2 confirmed**: chat tasks cannot live there. Closes open item 2 |
| F3 | **M36 does not consume `m2.membership.revoked`, `m2.membership.suspended` or `m2.user.deactivated`** (they exist in `events-by-m2.ts`). Channel-membership sync consumes only `m5.patient.assignment_created/ended`, `m5.patient.deceased`, `m6.admission.discharged` | Offboarding gap is real → WP 1.4 must add the consumer + prove it is wired (bound ≠ computing) |
| F4 | **No attachments anywhere**: none in `messaging-route-service-db.ts` / `messaging-write-core.ts`, none in the web module, though the TypeBox body schema allows `attachments[]` (≤ 10) | WP 1.5 is a build, not a fix. Check what the server does with that field today (unconfirmed) |
| F5 | **Threads are schema-only.** Server persists `parentMessageId`/`quotedMessageId`; **no same-channel validation found**; web sends `parentMessageId: null` and has no reply UI | Add a same-channel check in WP 2.2 (consider pulling it into Phase 1: it is a data-integrity hole) **Resolved (WP 1.7 / 1.9):** `PARENT_MESSAGE_NOT_IN_CHANNEL` / `QUOTED_MESSAGE_NOT_IN_CHANNEL` (422) in the one insert helper, live-proven; the DB-level FK stays WP 2.2 |
| F6 | **No message-level idempotency key**, but a generic HTTP `Idempotency-Key` middleware exists (`bootstrap/plugins/idempotency.ts`: org + key + body hash, 409 on conflict) | **Consolidate**: WP 1.2 reuses the middleware; a `client_message_id` unique index becomes a DB backstop, not a second mechanism. Confirm the web sends the header (unconfirmed) |
| F7 | **`message_receipt.status = 'ack'` is only a TypeScript type** (`kinds.ts:163`); nothing writes it | Safe to define clinical acknowledgment fresh (ADR); retire `ack` from the type to prevent misuse |
| F8 | **Job catalogue ≠ running jobs.** Queues for `retention_scan`, `hash_verify`, `channel_sync`, `bereavement_close`, `fan_out` are catalogued and the processors are pure functions; only the four out-of-band delivery queues are registered (`registerM36DeliveryWorkers`). No scheduler for hash-verify/retention found in M36; `runHashVerify`'s only non-test callers found are in the audit package | Treat message integrity verification and retention/legal-hold as **not running** until proven. Feeds WP 1.3 / 1.9 / 5.6 **Resolved for hash-verify and the scheduling of retention-scan (WP 1.9):** both are registered repeatable jobs and recorded in audit; the retention scan is plan-only (destruction and the message hold overlay remain WP 5.6) |
| F9 | **Read auditing is configured** on message/channel reads (`auditRead` with `resourceIdParam`; aggregate list audit with `patientIdPayloadPath`) | Good. Keep as the pattern; add a live assertion per new read route |
| F10 | **`arch:tenancy` passes** (three-column rule, `app.org_id`, RLS forced). `test:rls:live:m36` and `test:m36:channel-membership:live` exist | Baseline for the Phase 1 adversarial suite; no dedicated message-send/IDOR/attachment suite found |
| F11 | **Oversized files**: backend `messaging-route-service-db.ts` 2,132 lines; web `conversation-thread.tsx` 852, `staff-messaging.css` 978, `staff-messaging.dom.test.tsx` 1,059 | Exceeds the 800-line ceiling; split as work packages touch them |
| F12 | **M19 exposes escalation lifecycle** (`lifecycle/escalation.ts`: acknowledge/resolve/auto-resolve over `triage_escalation`; `escalation-sla` cron) **but no message-facing seam** was found | The `EscalationRouter` seam is net-new work on M19's side; scope it in the ADR before WP 4.3 |
| F13 | The idempotency middleware only guards requests that *send* the header, and skips unauthenticated routes | The server cannot assume clients send it → require `clientMessageId`/header on send and urgent-escalation routes |

## 2. Checklist results (from [`01` §4](../01-baseline-and-gap-matrix.md))

| # | Item | Result |
|---|---|---|
| 1 | Routes | ~25 routes in `messaging-routes.ts`, each via `requirePermission` or `requireAbac` (`channel_visibility`, `channel_member_admin`). Per-route table (audit/idempotency/test) still to produce (*unconfirmed*) |
| 2 | Authorization | RBAC keys + ABAC on channel routes confirmed. Non-membership read paths (alerts inbox, summaries) not yet traced (*unconfirmed*) |
| 3 | Tenancy | `arch:tenancy` green; `message_entity_reference` has RLS+FORCE (migration 1065) |
| 4 | Attachments | Not implemented (F4) |
| 5 | Retention & holds | ~~Pure processors only; no scheduling found (F8)~~ Scheduled and plan-only since WP 1.9 (consults M4's active legal holds); still no link to the ADR-0051 message overlay (WP 5.6) |
| 6 | Realtime | None (F1) |
| 7 | Receipts | `ack` unused (F7); read receipts written via `/messages/:id/read` |
| 8 | Threads | Schema-only (F5); same-channel parent/quote check done (WP 1.7 / 1.9) |
| 9 | Web | Polling thread view; load/refresh/access-revoked/send error states exist (`loadError`, `refreshError`, `isAccessError`); oversized files (F11). Whether the screenshot's "No messages yet" can mask a failure needs a visual check (*unconfirmed*) |
| 10 | Seams | `CareTeamProvider`-driven membership; outbox consumers for M5/M6; M2 events missing (F3); M19 message seam missing (F12) |
| 11 | Data | Not queried. Prod is demo data → reseed, don't remediate |
| 12 | Threat model | `THREAT_MODEL.md` exists (STRIDE, DR tier, integrations); extend with the new surfaces |

## 3. Disposition updates to the gap matrix (`01` §2)

| Row | Was | Now |
|---|---|---|
| 4 `message_receipt.ack` | Modify | **Deprecate** the `ack` value (unused); clinical ack lives in the new aggregate |
| 8 Idempotent send | Modify (new column) | **Consolidate** onto `Idempotency-Key` middleware + DB unique backstop |
| 11 Realtime | Replace | Replace via a **new ADR superseding ADR-0036 §2–3** |
| 15 On-call/escalation | Keep, add seam | Keep; **the seam is net-new** (F12) |
| 20 Offboarding | Modify | **Build the consumer** for `m2.membership.revoked/suspended`, `m2.user.deactivated` (F3) |
| 19 Legal hold | ⚑ verify | ~~Not wired (F8)~~ The scheduled retention scan consults M4's active holds and withholds held messages (WP 1.9, live-proven); the message hold overlay is WP 5.6 |
| 6 Threads | ⚑ verify | Schema-only; ~~add same-channel check (F5)~~ same-channel check done (WP 1.7 / 1.9) |
| 5 Attachments | ⚑ verify | Not implemented (F4) |

## 4. Remaining Phase 0 work

1. ~~Run the existing M36 live suites~~ **Done 2026-10-11** on a private `pgvector/pgvector:pg18` container (one fresh DB per suite, `wardenx_app` role, no Valkey needed): `test:rls:live:m36` 21/21, `test:m36:channel-membership:live` 11/11, `test:m36:delivery:live` 13/13, `test:m36:alert-outcome:live` 10/10, `test:m36:locked-alert-rule:live` 9/9, `test:m36:transactional-email:live` 8/8. **`test:m36:alert-emitter:live` 8/9: FAIL** — `gap-096-alert-emitter-live.test.ts` "care_team resolver reaches the real GAP-059 CareTeamProvider seam" (`expected [] to deeply equal [ Array(1) ]`, i.e. no recipients). **Investigated: deterministic stale-test bug, not a product bug.** The resolver returns the clinician (recipient count 1); the failing assertion is the empty `notification_delivery` rows. Commit `108d4d6f9` added a final-audience revalidation in `alert-emitter-drizzle.ts:286-325` (drops anyone without an active `membership` + active user, unless a `portal_caregiver` channel member), and the test (`gap-096-alert-emitter-live.test.ts:123-125`) creates the clinician as a bare `user` with no `membership`. The filter is correct (no alerts to departed or cross-tenant users). Fix = create the clinician via `insertMember` and add a test that an assigned clinician with no membership gets zero deliveries. Not applied; becomes a small WP 1.7 item (relevant: this filter is the offboarding safeguard F3 depends on). Coverage confirms F10: table-level RLS only; no route-level send/IDOR suite and no attachment tests (non-live: `messaging-routes`, `gap065-m36-part2-channel-gate`, `gap064-messaging-read-audit`, `messaging-eraser`).
2. ~~Per-route table~~ **Done:** [`ROUTE_TABLE.md`](./ROUTE_TABLE.md) (27 routes: 23 tenant, 1 admin, 3 vendor webhooks; the "~25" above was wrong). No route has an HTTP-level live test; HTTP route tests run on the in-memory service; nine service methods have no live coverage; rate limiting is one shared 600/min tenant bucket.
3. ~~Trace non-membership read paths~~ **Done** (same file). No row-level IDOR on membership-scoped reads. **Corrections and new findings:**
   - **F3 refined:** channel-scoped routes already recheck active membership + active user per request, so the missing `m2.*` consumer matters mainly for write paths, alerts, stale `channel_member` rows and future socket rooms.
   - **N1 (High):** edit, delete and mark-read check only authorship, not membership, active user, archive state or Part 2; a removed or suspended user can still PATCH/DELETE their own messages. PATCH overwrites `body_cipher` with no revision, and the 5-minute edit window is not enforced. → WP 1.3, 1.4.
   - **N2 (Medium-High):** any active user can POST to an announcement channel by UUID (send ignores channel kind); `announce()` adds no members. → WP 2.9, 1.7.
   - **F5 strengthened:** `parentMessageId`/`quotedMessageId` are plain FKs with no org/channel scope, so cross-channel or cross-tenant parents are accepted; possible delete-blocking. → WP 1.9, 1.8. **Resolved (WP 1.7 / 1.9).**
   - **F4 strengthened:** `attachments[]` is silently dropped (201 with nothing stored). Interim: 422 on a non-empty array. → WP 1.5.
   - **F6/F13 confirmed and worse:** the web sends a fresh `Idempotency-Key` per call, so a retry duplicates. → WP 1.2.
   - **N3 (Medium):** `GET /alerts/inbox` writes state and has no active-user/Part 2/patient-access recheck; `getChannel`/`listMessages` rely on the route-level check only.
4. Read-only row counts for `message`, `channel`, `message_receipt` on demo/prod; confirm the reseed path.
5. Visual check of the "No messages yet" case in the running web app.
6. Confirm whether the web client sends `Idempotency-Key` on send, and what the server does with `attachments[]`.
7. **Drafted 2026-10-11, promoted to `docs/adr/` the same day with status Proposed** (ADR-0054 realtime, 0055 revisions/redaction, 0056 clinical ack, 0057 escalation ownership, 0058 global search). New facts they surfaced: `editMessage` overwrites `body_cipher`/`body_sha256` and deletes entity references; `ack` is also a Postgres enum value (retire via CHECK); M19 default tier SLAs (15/30/15/60/15 min) conflict with D4; GAP-002 is the auth audit trail, session timeout lives in ADR-0004; `m36.message.sent.v1` and ack events are not in the event catalog; which key model protects bodies in production (HKDF from `MESSAGING_ENCRYPTION_KEY` vs `TenantKeyProvider`) is unconfirmed and blocks ADR-0058. Original item: draft ADRs: realtime (supersedes ADR-0036), revisions/redaction, clinical acknowledgment, escalation ownership (needs an M19 owner), search (option B design review).
8. ~~Socket.IO spike on Fastify/Bun (D1 gate)~~ **Done 2026-10-11: GO-WITH-CONDITIONS.** socket.io 4.8.4 + `@socket.io/redis-adapter` 8.3.0 + ioredis 5.11.1 on Bun 1.3.5 / Fastify 5.12.5 / Valkey 8.1.10 (also works on Node; `npm audit` clean). The standard engine runs on Bun (no `bun-engine` needed); websocket, polling and upgrade all pass. Localhost results (no TLS/LB): node-to-node 9 ms; 500 clients, 5000/5000 delivered, p95 10 ms (target 2 s); about 0.15 MB per connection; reconnect storm of 500 back in ≤ 1.5 s; killed node recovered in ≤ 4.1 s. Cursor catch-up lost nothing but produced a live+REST duplicate, so clients must dedupe by cursor. `connectionStateRecovery` does not work with the Redis adapter: do not use it. Spike code is in the session scratchpad only (not in the repo).
   **Conditions for WP 1.1:** (a) authenticate in `allowRequest` as well as `io.use` (otherwise unauthenticated clients get an engine session); the server joins rooms, clients never choose them; (b) the DB cursor stays the only record, and events carry hints only (`{cursor, kind, ids}`, no PHI); (c) plan for reconnect-storm load on the auth path (jitter, session-lookup cache, rate-limited cursor endpoint); (d) drop sockets on `m2.membership.revoked/suspended` and `m2.user.deactivated` with `io.in(room).disconnectSockets(true)` (works across nodes) — this also closes F3 on the realtime side; (e) new ADR superseding ADR-0036 §2–3; (f) sticky sessions at the ingress if polling stays enabled; (g) decide whether socket activity counts for session timeout (GAP-002); (h) live suite with its own `package.json` script and `ci.yml` row.
   **Placement:** server in `apps/backend/src/bootstrap/realtime/` (M1), api role only, started from `bootWardenX`; outbox consumer for `m36.*` wired in `index.ts` and registered with `arch:outbox-bindings`; optional `socket.io` entry in `VENDOR_ADAPTERS` in both manifests. Not tested: more than 500 connections, a real LB/proxy, TLS.
9. Clinical lead: review the hazard log ([`05` §4](../05-clinical-workflows-and-safety.md)) and the D4 numbers.
