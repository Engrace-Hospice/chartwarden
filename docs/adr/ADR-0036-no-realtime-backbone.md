# ADR-0036 — Realtime backbone deferred: the transactional outbox is the cross-module channel

- **Status:** **Accepted** — ratifies the as-built state (2026-08-14, architecture-corpus
  remediation AR-02; see `audit/ARCHITECTURE_DOC_REMEDIATION_PLAN.md`).
- **Date:** 2026-08-14
- **Amended (additive, 2026-10-11):** Decisions 2 and 3 are superseded by [ADR-0054](ADR-0054-realtime-transport-socketio-valkey.md) (Accepted 2026-10-12); Decision 1 and the contract-only-package consequence stay in force. The Status word is unchanged.
- **Phase:** post-build divergence record. All 40 modules shipped without a realtime transport;
  this ADR records that as a decision rather than leaving the architecture doc describing an
  unbuilt channel in present tense.
- **Supersedes (wording):** `CHARTWARDEN_ARCHITECTURE_v0_11.md` §25.13 ("modules communicate via
  Socket.IO events") and every present-tense Socket.IO delivery claim in
  `CHARTWARDEN_SYSTEM_DESIGN_v0.3.md`; both now carry a verified divergence banner pointing here.
- **Related:** [ADR-0005](ADR-0005-manifest-single-source-of-truth.md) (seam/outbox consumption
  needs no import edge — the pattern that actually carries cross-module effects).

## Context

The architecture corpus prescribed Socket.IO as *the* cross-module communication channel and a
realtime UX backbone (live messaging, presence, kill-switch cache invalidation). What was actually
built:

- **`socket.io` is not installed** in any workspace `package.json`.
- `packages/messaging/src/realtime/{rooms,events}.ts` (M36-T08) is a **pure contract** — room-name
  grammar, event-name constants, sanitized payload types. Both files state in their headers that
  the Socket.IO server/adapter **wiring lives in the app composition root / M1 infra** and that
  the package **imports no socket.io** — and that wiring was never built.
- Every cross-module side effect in the repo travels through the **transactional outbox**
  (`mN.*` events, written in the same DB transaction as the state change, dispatched
  asynchronously to consumers) — not through any socket. This is gate-enforced
  (`arch:gaps` event-catalog checks), so the outbox is the channel *by construction*.
- Frontends poll/refetch over REST via the generated typed client (ADR-0032); no SSE, no
  WebSocket endpoint exists in `apps/backend`.

## Decision

1. **Cross-module communication is the transactional outbox, full stop.** Socket.IO (or any
   realtime transport) is *never* a module-to-module channel; §25.13's statement is void. Modules
   that need another module's state change consume its `mN.*` outbox event or resolve a seam.
2. **Realtime *delivery to clients* is deferred, not rejected.** The M36 contract package
   (`packages/messaging/src/realtime/*`) remains the locked interface: if/when a realtime
   transport lands, it binds in M1 infra behind that contract, and payloads keep the §4.3
   invariant (no decrypted PHI to an unentitled recipient; server computes per-user payloads).
3. Until then, UI freshness is REST refetch/poll. Features specced against "live" updates
   (messaging, presence, kill-switch invalidation) degrade to fetch-on-navigation/interval, and
   their specs' Socket.IO wording reads as **target state**, not description.

## Consequences

- The architecture doc's realtime sections are aspirational and are marked as such; a future
  realtime build requires its own ADR choosing the transport (Socket.IO + Valkey adapter remains
  the leading candidate because the contract was shaped for it).
- No availability/scale story needs to exist today for a socket tier that doesn't exist —
  DR/BCP and ops docs must not list one.
- The contract-only package is *intentional* — do not delete it as dead code, and do not add a
  socket.io import to it (it must stay pure; the dependency edge belongs to the composition root).
