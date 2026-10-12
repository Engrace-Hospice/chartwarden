# ADR-0054 — Realtime delivery to clients is Socket.IO with the Valkey adapter: hints only, the database cursor is the truth, access is server-decided and revocable

- **Status:** **Proposed** — D1 (Socket.IO) was decided by the product owner 2026-10-11 and the Phase 0 spike
  returned GO-WITH-CONDITIONS; this ADR writes the conditions down. Ratified when WP 1.1 passes its live suite.
- **Date:** 2026-10-11
- **Phase:** Messaging Hub Phase 1 (WP 1.1).
- **Supersedes (partially):** [ADR-0036](ADR-0036-no-realtime-backbone.md) **Decision items 2 and 3** only
  (the "client delivery is deferred" and "until then UI freshness is REST poll" clauses). See "What of ADR-0036 remains in force".
- **Related:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (outbox/seams carry cross-module effects),
  [ADR-0004](ADR-0004-retention-and-session-conflicts.md) (session lifetimes), [ADR-0049](ADR-0049-tenant-subdomains.md)
  (host is a consistency check, never an authorization source), ADR-0055 / ADR-0056 (events this transport carries).
  Plan: `docs/messaging-hub/README.md` (D1, D5, D11), `docs/messaging-hub/audit/PHASE_0_AUDIT.md` §4 item 8 (spike).


## Context

- Audit F1: no realtime exists by decision. `packages/messaging/src/realtime/{rooms,events}.ts` is a pure contract (room-name
  builders such as `userRoom`, `careTeamRoom`, `orgRoom`; `MESSAGING_SERVER_EVENTS` including `permissionsChanged`); no
  `socket.io` is installed in any workspace. The web thread view polls (15 s, backoff to 60 s), which cannot meet the
  p95 < 2 s delivery target in the plan.
- ADR-0036 Decision 2 says a future transport "binds in M1 infra behind that contract" and its Consequences say a realtime build
  "requires its own ADR choosing the transport (Socket.IO + Valkey adapter remains the leading candidate)". This is that ADR.
- Spike result (PHASE_0_AUDIT §4 item 8, 2026-10-11, localhost, no TLS/LB): socket.io 4.8.4 + `@socket.io/redis-adapter` 8.3.0 +
  ioredis 5.11.1 on Bun 1.3.5 / Fastify 5.12.5 / Valkey 8.1.10. Websocket, polling and upgrade pass on the standard engine.
  500 clients, 5000/5000 delivered, p95 10 ms; reconnect storm of 500 in <= 1.5 s; killed node recovered <= 4.1 s. Cursor
  catch-up lost nothing but produced a live+REST duplicate. `connectionStateRecovery` does not work with the Redis adapter.
  **Not tested:** more than 500 connections, a real proxy/LB, TLS. Spike code is not in the repo.
- Audit F3: M36 consumes none of `m2.membership.revoked`, `m2.membership.suspended`, `m2.user.deactivated` (all three exist in
  `apps/backend/src/modules/02-identity/events-by-m2.ts`). A transport that keeps a socket open past offboarding would be worse
  than polling, so revocation is part of the decision, not a follow-up.
- Verified repo facts: `VENDOR_ADAPTERS` (architecture/module-manifest.ts) currently maps `twilio`/`postmark` to
  `packages/messaging`; `apps/backend/src/bootstrap/` exists (plugins/, outbox-consumers/, jobs/) and has no `realtime/` yet;
  `packages/messaging/src/cache/keys.ts` is where the room-set cache key (`rooms:user:<id>`) is named.

## Decision

1. **Transport.** Socket.IO 4.x with `@socket.io/redis-adapter` over Valkey (not Redis; throwaway containers in live suites are
   `valkey/valkey:8`). Websocket first, long-polling allowed as the transport fallback
   (D11, decided 2026-10-11 by the product owner; websocket-only is not adopted).
2. **Hints only, no PHI.** A socket event is `{ cursor, kind, ids }` (kinds drawn from `MESSAGING_SERVER_EVENTS`). It never
   carries a message body, patient identifier, name or diagnosis. The client reacts by fetching over REST, where
   `requirePermission` / `requireAbac` / read-audit apply. This keeps the ADR-0036 §4.3 invariant (no decrypted PHI to an
   unentitled recipient) true by construction instead of by per-user payload filtering.
3. **The database cursor is the only record.** Reconnect, resume and gap repair all reconcile with
   `GET /channels/:id/messages?after=<cursor>`. Clients dedupe by cursor (the spike showed live+REST duplicates). Do **not**
   enable `connectionStateRecovery`. A dropped hint costs latency, never correctness.
4. **Authentication.** Better Auth session is validated in `allowRequest` **and** `io.use`; an unauthenticated client gets no
   engine session. The server resolves tenant and principal from the session, never from a client-supplied org id.
5. **Rooms are server-chosen.** After auth the server calls `computeRoomSet` (packages/messaging/src/realtime/rooms.ts) and
   `socket.join`s the result; clients never send a room name. Recompute on `permissions.changed` and on membership change.
6. **Revocation.** A new outbox consumer for `m2.membership.revoked`, `m2.membership.suspended` and `m2.user.deactivated`
   calls `io.in(room).disconnectSockets(true)` (works across nodes via the adapter) and also ends channel memberships (WP 1.4,
   audit F3). Target: socket dropped <= 5 s after the event.
7. **Placement.** `apps/backend/src/bootstrap/realtime/` (M1), started from `bootWardenX`, **api role only** (not the worker or
   relay role). `socket.io` and the adapter are added as a `VENDOR_ADAPTERS` entry in both manifests (`.ts` + `.cjs`) mapped to the
   code path that owns the import; `packages/messaging/src/realtime` stays contract-only and gets no socket.io import
   (ADR-0036 Consequences, unchanged).
8. **Event source.** A new `m36.*` outbox consumer turns committed events into hints. It must be registered so `arch:outbox-bindings`
   sees it and wired in `apps/backend/src/index.ts` (verify by grepping for its factory; bound is not computing).
9. **Sticky sessions** at the ingress (Envoy Gateway per ADR-0050; stickiness config is a deployment item). Required because
   long-polling stays enabled as the fallback (D11, decided 2026-10-11 by the product owner).
10. **Reconnect-storm controls.** Client backoff with jitter; session-lookup cache on the handshake path; rate limit on the cursor
    catch-up endpoint; per-user connection cap.
11. **Degraded mode.** If Valkey is down the adapter cannot fan out across nodes. Behaviour: sockets stay up per node, cross-node
    hints are lost, the client falls back to polling (existing 15 s loop) when it detects missed cursors or a failed
    handshake. No message is lost because the DB is the record. Readiness reports the degradation; it does not fail boot.
12. **Session lifetime.** A socket does not extend or refresh a session. Socket activity does **not** count as activity for the
    ADR-0004 idle timer (15 min idle, 8 h work-session, 24 h hard absolute), and the socket is disconnected on session expiry or
    revocation (D11, decided 2026-10-11 by the product owner). Connect, disconnect and forced-disconnect are audited.
13. **Ops ownership.** The realtime component gets an owner in the ops runbook: platform/ops (D11, decided 2026-10-11 by the
    product owner).

### What of ADR-0036 remains in force

Decided 2026-10-11 by the product owner (D5): ADR-0036 **stays `Accepted`**. It receives only an additive header pointer
("Decision 2 and 3 superseded by ADR-0054"); it is not flipped to `Superseded`, and `arch:adr-docs` is not loosened for this case.

- **Decision 1 (unchanged):** cross-module communication is the transactional outbox. Socket.IO is never a module-to-module channel.
- **Consequences (unchanged):** `packages/messaging/src/realtime/*` stays a pure contract package; no socket.io import there.
- **Superseded:** Decision 2 (deferral of client delivery) and Decision 3 (REST poll as the freshness mechanism). Polling survives
  only as the degraded fallback in item 11.
- ADR-0036's architecture-doc banners (§25.13 and System Design wording) stay as written: that wording is about module-to-module
  Socket.IO, which remains void.

## Alternatives considered

- **SSE + REST** (the plan's stated fallback). One-way, simple, proxies well, no sticky sessions. Rejected as primary because D1
  chose Socket.IO and Phase 2 adds presence/typing (bidirectional). Remains the fallback if production proxying of websockets fails.
- **Native WebSocket (`ws`/Bun) + our own protocol.** Fewer dependencies, but we would rebuild rooms, ack, reconnect and
  cross-node fan-out. Rejected: more security-sensitive code to own.
- **Keep polling.** Cannot reach p95 < 2 s without hammering the API; kept only as degraded mode.
- **Send message payloads over the socket.** Lower latency, but puts decrypted PHI on a channel whose authorization is
  room-membership computed at connect. Rejected in favour of hints plus REST (item 2).
- **`connectionStateRecovery`.** Rejected: unsupported with the Redis adapter per the spike.

## Consequences

- Reconnect and missed-hint handling live in the client cursor logic; the server stays stateless per connection.
- A new always-on component (Valkey) is on the realtime path; its outage degrades latency, not correctness.
- Operational surface grows: sticky ingress config, WSS idle timeouts, connection-count metrics, DR/BCP and ops-runbook entries
  (ADR-0036 told those docs not to list a socket tier; they must now).
- The `m2.*` revocation consumer also fixes the polling-era offboarding gap (F3), so it ships even if the socket is disabled.

## Migration / rollout

1. Land the manifest/vendor-adapter entry and the `m2.*` revocation consumer (works without sockets: ends memberships).
2. Land `bootstrap/realtime` behind a per-environment flag; web client keeps polling until the flag is on.
3. Enable in the Docker stack first (hit it per the repo's verify-before-merge rule); then production.
4. Update the architecture/ops docs that ADR-0036 told to omit a socket tier.

## Verification

- New live suite `test:m36:realtime:live` (own `package.json` script **and** `ci.yml` job row; private `pgvector/pgvector:pg18`
  plus `valkey/valkey:8` containers; connect as `wardenx_app`, two backend instances).
- Cases: unauthenticated handshake yields no engine session; client-chosen room ignored; cross-tenant subscribe refused;
  revoked/suspended/deactivated user disconnected <= 5 s on both nodes; cursor reconcile yields no gap and no duplicate after
  dedupe; Valkey stopped mid-run degrades to polling without message loss; event payload schema test (no body/PHI fields).
- Load: re-run the spike scenario through a real proxy with TLS, >= 2x the expected peak connections; p95 < 2 s.
- Gates: `arch:outbox-bindings`, `arch:manifest-mirror`, `arch:live-suites`, `arch:route-reachability`, `arch:adr-docs`.

## Open questions

- **GAP-002 mismatch.** The Phase 0 audit labels "does socket activity count for session timeout" as GAP-002. In
  `docs/audits/GAP_ANALYSIS_20261008.md`, GAP-002 is "no authentication audit trail" (login/lockout/logout/session.revoked not
  emitted). The timeout question belongs to ADR-0004 / OPEN-020. GAP-002 is still relevant (socket connect/force-disconnect should
  use the `auth.*`/`session.revoked` audit actions once registered). Confirm which was meant.
- Per-instance connection ceiling and Valkey topology (shared with BullMQ or a separate instance) are untested beyond 500 clients.

Resolved (Decided 2026-10-11 by the product owner): websocket-only vs polling fallback (websocket-first with polling fallback and
sticky sessions, items 1 and 9); whether socket activity extends the idle timer (no, item 12); realtime ops owner (platform/ops,
item 13); ADR-0036 status handling (stays Accepted with additive pointer, D5).
