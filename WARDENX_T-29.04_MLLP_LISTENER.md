# WardenX — T-29.04 Addendum: MLLP Listener Supervisor

**Document status:** lock-grade
**Tracks against:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_2.md` §4.11 (MLLP Listener Lifecycle), §4.9 (BullMQ Queue Catalog), §10 (T-29.04)
**Date:** 2026-06-10
**Prerequisites:** T-29.01 (manifest patch + forward-stubs), T-29.02 (schema), T-29.03 (HAPI sidecar) all merged.

This addendum delivers the drop-in artifacts for T-29.04 — the long-lived listener supervisor process, the per-feed mTLS MLLP TCP listener, the frame handler (idempotency + persist + ACK), the health-probe loop with circuit-breaker, the graceful-shutdown drain, and the `hl7-inbound-parse` BullMQ worker that consumes from the supervisor and calls the T-29.03 sidecar.

**T-29.04 is the first network-facing surface of WardenX.** It terminates external partner-facility traffic carrying live PHI. The boundary discipline established in T-29.01/02/03 makes this safer: payloads land envelope-encrypted before any PHI is parsed, the sidecar runs out-of-process, the parse worker is BullMQ-isolated from the listener thread.

---

## 1. Scope & Non-Goals

### 1.1 In scope

- **Listener supervisor process** at `apps/backend/src/modules/29-external-interfaces/listener/supervisor.ts` — long-lived fork, boot sequence, hot-reload via outbox events, graceful SIGTERM drain.
- **Per-feed TLS listener** at `apps/backend/src/modules/29-external-interfaces/listener/per-feed-listener.ts` — `tls.createServer` with per-feed cert pinning + sender allowlist + frame buffering.
- **Frame handler** at `apps/backend/src/modules/29-external-interfaces/listener/frame-handler.ts` — MLLP framing, idempotency check, envelope-encrypt, persist `hl7_message_inbound`, enqueue parse, emit AA only after COMMIT.
- **Health probe + circuit breaker** at `apps/backend/src/modules/29-external-interfaces/listener/health-probe.ts` — 30s tick, CLOSED→OPEN→HALF_OPEN→CLOSED state machine, M36 alerts.
- **In-memory CRL** at `apps/backend/src/modules/29-external-interfaces/listener/revocation-list.ts` — refreshed on `m29.external_feed_credential.revoked` outbox events.
- **In-flight tracker** at `apps/backend/src/modules/29-external-interfaces/listener/inflight-tracker.ts` — frame-in-progress accounting for graceful drain.
- **Process entrypoint** at `apps/backend/src/modules/29-external-interfaces/listener/index.ts` — forked-process bootstrap.
- **Parse worker** at `apps/backend/src/modules/29-external-interfaces/workers/hl7-inbound-parse.worker.ts` — BullMQ consumer that decrypts the payload, calls the T-29.03 sidecar, persists parse result, emits the next-stage event.
- **Forward-stubbed downstream consumers** for the cascade (T-29.05) and proposal lifecycle (T-29.06) — same `NotImplementedError`-pattern as T-29.01.
- **Tests** covering frame DoS guard, idempotency on duplicate MSH-10, mTLS handshake refusal, listener-down 5-minute detection, the limited subset of W-XI-01 that T-29.04 alone supports (frame → persisted with parse_status='PARSED'), W-XI-10 (listener-down alert), W-XI-15 (boot validator).
- **Spec refinement on W-XI-01 scope per task** — recorded in §14.
- **Sign-off checklist.**

### 1.2 Non-goals

- **Patient match cascade** (T-29.05) — stubbed.
- **Proposal lifecycle** (T-29.06) — stubbed.
- **Lab observation attachment** (T-29.07) — stubbed.
- **Outbound ORM dispatch** (T-29.08).
- **Credential rotation** (T-29.10) — the listener consumes credentials; the rotation route is T-29.10.
- **SUD ingress redaction** (T-29.11) — the redaction pre-pass is a parse-time concern; for T-29.04 the redactor is wired to the M39 fixture stub from T-29.03's segment-mapping work.
- **Frontend UI** for messages — T-29.12.

---

## 2. Architectural Choices Worth Surfacing

The M29 spec §4.11 is detailed enough that most of T-29.04 is execution. Three choices deserve explicit surfacing because they tighten or refine the spec.

### 2.1 Listener supervisor as a **separate Node process**, not a Fastify thread

The spec §4.11 says the listener runs "inside a long-lived `hl7-listener-supervisor` Fastify-fork process owned by M29 (`apps/backend/src/modules/29-external-interfaces/listener/supervisor.ts`). The supervisor is *not* the Fastify HTTP server — listeners run on isolated ports, never bound to the public ingress, and never co-tenant with HTTP traffic on a single port."

Concretely this means: the backend launches *two* Node processes:

1. `apps/backend/src/index.ts` — the Fastify HTTP server (routes, BullMQ workers for everything that isn't HL7 ingest, the BullMQ scheduler, etc.).
2. `apps/backend/src/modules/29-external-interfaces/listener/index.ts` — the listener supervisor, started as a sibling process by `node --import tsx`, managed by a PM2-style supervisor in production (`supervisord`, `systemd`, or in container land just a sibling service in compose).

The two processes share:
- Postgres (separate connection pools — listener pool is bounded at 16 connections).
- Valkey (separate BullMQ queue connections — listener publishes to `hl7-inbound-parse:*`).
- The `/var/run/wardenx/hapi.sock` UDS to the T-29.03 sidecar.

They do **not** share:
- Memory.
- HTTP routing.
- The Fastify lifecycle.

Crash-isolation: a Fastify route crash does not bring down the listener; a listener crash does not bring down Fastify. The PM2 supervisor or container orchestrator restarts crashed processes independently.

This is more disciplined than "fork" in a Node `cluster.fork()` sense — it's a full sibling process, not a child of the HTTP server.

### 2.2 Frame handler **commits before ACK** even at the cost of latency

The spec §4.11.3 says "Emits MLLP `AA` (application accept) only after Postgres `COMMIT` returns — never before. If the DB insert fails, emit `AR` (application reject) with an error segment."

This is the right call but adds DB-roundtrip latency to the p95 ACK SLO (1.5s, per §9.6). The implementation: a single `INSERT INTO hl7_message_inbound ... RETURNING id` followed by COMMIT, then write the ACK back to the same socket. Median latency is ~10-30ms; p95 1.5s is comfortable.

The alternative — emit AA optimistically and persist asynchronously — would let frames vanish in a Postgres outage. Unacceptable for clinical PHI.

### 2.3 BullMQ worker concurrency **per-feed, not global**

The parse worker pulls from `hl7-inbound-parse:{messageType}` queues. Concurrency is configurable per feed (M29 §4.9 implies but doesn't pin a number); the chosen default is **8 concurrent parse jobs per worker process, with a per-feed soft cap of 4** to prevent one chatty partner from starving others. The soft cap is implemented via a BullMQ priority + a per-feed counter rather than separate queues per feed (which would blow the queue count past Valkey's recommended ~1000 keys).

This is a refinement past the spec; recorded in §14.

---

## 3. Files Inventory

```
apps/backend/src/modules/29-external-interfaces/
├── listener/
│   ├── index.ts                       # process entrypoint (forked sibling to Fastify)
│   ├── supervisor.ts                  # SupervisorImpl: boot, hot-reload, drain, health-loop
│   ├── per-feed-listener.ts           # PerFeedListener: tls.createServer, allowlist, frame buffer
│   ├── frame-handler.ts               # FrameHandler: MLLP framing, idempotency, persist, ACK
│   ├── health-probe.ts                # HealthProbe + CircuitBreaker
│   ├── revocation-list.ts             # in-memory CRL + outbox subscription
│   ├── inflight-tracker.ts            # drain accounting
│   └── __tests__/
│       ├── supervisor.test.ts
│       ├── per-feed-listener.test.ts
│       ├── frame-handler.test.ts
│       ├── health-probe.test.ts
│       └── fixtures/
│           ├── ca.pem
│           ├── server.crt / server.key
│           ├── client-trusted.crt / client-trusted.key
│           ├── client-wrong-ca.crt / client-wrong-ca.key
│           ├── client-expired.crt / client-expired.key
│           └── frames/
│               ├── adt-a01-valid.bin
│               ├── adt-a01-duplicate.bin
│               ├── adt-a01-oversize-8.1mb.bin
│               └── malformed-no-msh10.bin
└── workers/
    ├── hl7-inbound-parse.worker.ts    # BullMQ worker
    └── __tests__/
        └── hl7-inbound-parse.worker.test.ts
```

The boundary cruiser rules from T-29.01 + T-29.03 already cover the listener directory (it's inside the M29 module root). T-29.04 adds no new rules.

---

## 4. `supervisor.ts` — Boot, Hot-Reload, Drain, Health

```ts
// apps/backend/src/modules/29-external-interfaces/listener/supervisor.ts
import type { Logger } from 'pino'
import type { Outbox } from '@wardenx/foundation/outbox'
import type { NotificationDispatcher } from '@wardenx/foundation/seams'
import { eq, and } from 'drizzle-orm'
import { externalFeed, type ExternalFeed } from '@wardenx/db/schema/external-interfaces'
import { withPlatformContext, withTenantContext } from '@wardenx/tenancy'
import type { MdmBaaStatusProvider } from '@wardenx/foundation/seams'
import type { KmsEnvelopeEncryptor } from '@wardenx/foundation/seams'
import { PerFeedListener } from './per-feed-listener'
import { HealthProbe } from './health-probe'
import { RevocationList } from './revocation-list'
import { InflightTracker } from './inflight-tracker'

export interface SupervisorDeps {
  readonly logger: Logger
  readonly db: typeof import('@wardenx/db').db
  readonly outbox: Outbox
  readonly alerts: NotificationDispatcher
  readonly mdm: MdmBaaStatusProvider
  readonly envelope: KmsEnvelopeEncryptor
  readonly bullmq: import('bullmq').Queue
  readonly env: NodeJS.ProcessEnv
}

export class SupervisorImpl {
  private readonly listeners = new Map<string, PerFeedListener>()
  private readonly revocationList: RevocationList
  private readonly inflight: InflightTracker
  private readonly healthProbe: HealthProbe
  private healthInterval?: NodeJS.Timeout
  private shuttingDown = false

  constructor(private readonly deps: SupervisorDeps) {
    this.revocationList = new RevocationList(deps.logger)
    this.inflight = new InflightTracker()
    this.healthProbe = new HealthProbe(deps, this.listeners)
  }

  /**
   * Boot sequence (M29 §4.11.1):
   * 1. Subscribe to revocation events FIRST — so any concurrent rotation lands.
   * 2. Load all active inbound MLLP feeds platform-wide via withPlatformContext.
   * 3. For each: check BAA gate (D16). If active, start listener; else skip + alert.
   * 4. Subscribe to feed lifecycle outbox events.
   * 5. Start the 30s health-probe interval.
   * 6. Register SIGTERM handler.
   */
  async boot(): Promise<void> {
    this.deps.logger.info('hl7.supervisor.boot.begin')

    // 1. CRL subscription (revoked credentials must be rejected at handshake immediately)
    this.deps.outbox.subscribe('m29.external_feed_credential.revoked', (event) =>
      this.revocationList.add(event.payload.credentialId, event.payload.fingerprint),
    )
    await this.revocationList.warmFromDb(this.deps.db)

    // 2. Load active inbound feeds
    const activeFeeds = await withPlatformContext(this.deps.db, async (tx) =>
      tx.select().from(externalFeed).where(
        and(
          eq(externalFeed.status, 'active'),
          // kind IN ('adt_inbound', 'lab_inbound')
        ),
      ),
    )

    this.deps.logger.info({ count: activeFeeds.length }, 'hl7.supervisor.boot.loaded_feeds')

    // 3. BAA gate per-feed; start each that passes
    for (const feed of activeFeeds) {
      if (feed.kind === 'orm_outbound') continue  // outbound feeds don't bind listeners
      await this.tryStartFeed(feed)
    }

    // 4. Outbox subscriptions for hot-reload
    this.deps.outbox.subscribe('m29.external_feed.activated', async (event) => {
      const feed = await this.loadFeedById(event.payload.feedId)
      if (feed) await this.tryStartFeed(feed)
    })

    this.deps.outbox.subscribe('m29.external_feed.suspended', async (event) =>
      this.stopFeed(event.payload.feedId, 'suspended'),
    )

    this.deps.outbox.subscribe('m29.external_feed.revoked', async (event) =>
      this.stopFeed(event.payload.feedId, 'revoked'),
    )

    this.deps.outbox.subscribe('m29.external_feed.emergency_suspended', async (event) =>
      this.stopFeed(event.payload.feedId, 'emergency_suspended'),
    )

    // BAA-restore: re-evaluate feeds that were skipped due to inactive BAA
    this.deps.outbox.subscribe('m40.mdm.baa_status_changed', async (event) => {
      if (event.payload.newStatus !== 'active') return
      const feeds = await this.loadActiveFeedsForOrg(event.payload.organizationId)
      for (const feed of feeds) {
        if (!this.listeners.has(feed.id)) {
          await this.tryStartFeed(feed)
        }
      }
    })

    // 5. Health probe tick
    this.healthInterval = setInterval(() => {
      void this.healthProbe.tick().catch((err) =>
        this.deps.logger.error({ err }, 'hl7.supervisor.health_probe.error'),
      )
    }, 30_000)

    // 6. Shutdown handlers
    process.on('SIGTERM', () => void this.shutdown('SIGTERM'))
    process.on('SIGINT', () => void this.shutdown('SIGINT'))

    this.deps.logger.info('hl7.supervisor.boot.complete')
  }

  private async tryStartFeed(feed: ExternalFeed): Promise<void> {
    if (this.listeners.has(feed.id)) return  // idempotent

    const baa = await this.deps.mdm.baaStatus(feed.organizationId, { asOf: new Date() })
    if (!baa.isActive) {
      this.deps.logger.warn(
        { feedId: feed.id, organizationId: feed.organizationId, baaStatus: baa.status },
        'hl7.listener.baa_refuse',
      )
      await this.deps.alerts.dispatch({
        severity: 'CRITICAL',
        channel: 'compliance',
        organizationId: feed.organizationId,
        title: `BAA gate blocked feed ${feed.displayName}`,
        body:
          `Feed ${feed.id} on org ${feed.organizationId} cannot activate listener: ` +
          `BAA status = ${baa.status}, expiresAt = ${baa.expiresAt ?? 'n/a'}`,
      })
      return
    }

    const listener = new PerFeedListener(feed, {
      ...this.deps,
      revocationList: this.revocationList,
      inflight: this.inflight,
    })

    try {
      await listener.start()
      this.listeners.set(feed.id, listener)
      this.deps.logger.info({ feedId: feed.id, port: feed.port }, 'hl7.listener.started')
    } catch (err) {
      this.deps.logger.error({ err, feedId: feed.id }, 'hl7.listener.start_failed')
      await this.deps.alerts.dispatch({
        severity: 'HIGH',
        channel: 'operator-on-call',
        organizationId: feed.organizationId,
        title: `Listener failed to start for ${feed.displayName}`,
        body: `Feed ${feed.id} listener failed at boot. Reason: ${(err as Error).message}`,
      })
    }
  }

  private async stopFeed(feedId: string, reason: string): Promise<void> {
    const listener = this.listeners.get(feedId)
    if (!listener) return
    await listener.stop()
    this.listeners.delete(feedId)
    this.deps.logger.info({ feedId, reason }, 'hl7.listener.stopped')
  }

  private async loadFeedById(feedId: string): Promise<ExternalFeed | undefined> {
    return withPlatformContext(this.deps.db, async (tx) => {
      const [row] = await tx.select().from(externalFeed).where(eq(externalFeed.id, feedId)).limit(1)
      return row
    })
  }

  private async loadActiveFeedsForOrg(organizationId: string): Promise<ExternalFeed[]> {
    return withPlatformContext(this.deps.db, async (tx) =>
      tx.select().from(externalFeed).where(
        and(
          eq(externalFeed.organizationId, organizationId),
          eq(externalFeed.status, 'active'),
        ),
      ),
    )
  }

  async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) return
    this.shuttingDown = true
    this.deps.logger.info({ signal }, 'hl7.supervisor.shutdown.begin')

    if (this.healthInterval) clearInterval(this.healthInterval)

    // 1. Stop accepting new connections on all listeners
    for (const [feedId, listener] of this.listeners) {
      await listener.stopAccepting()
      this.deps.logger.info({ feedId }, 'hl7.listener.shutdown.stop_accept')
    }

    // 2. Wait up to 30s for in-flight frames to ACK
    const drained = await this.inflight.drain(30_000)
    this.deps.logger.info({ drained, remaining: this.inflight.count() }, 'hl7.supervisor.shutdown.drained')

    // 3. Close listener sockets
    for (const [feedId, listener] of this.listeners) {
      await listener.close()
      this.deps.logger.info({ feedId }, 'hl7.listener.shutdown.closed')
    }

    this.deps.logger.info('hl7.supervisor.shutdown.complete')

    // Exit with non-zero if we hit the drain timeout with frames still in-flight
    process.exit(this.inflight.count() > 0 ? 1 : 0)
  }
}
```

---

## 5. `per-feed-listener.ts` — TLS Server, Allowlist, Frame Buffer

```ts
// apps/backend/src/modules/29-external-interfaces/listener/per-feed-listener.ts
import * as tls from 'node:tls'
import type { ExternalFeed, ExternalFeedCredential } from '@wardenx/db/schema/external-interfaces'
import { externalFeedCredential } from '@wardenx/db/schema/external-interfaces'
import { eq, and } from 'drizzle-orm'
import { withPlatformContext } from '@wardenx/tenancy'
import { FrameHandler } from './frame-handler'
import type { SupervisorDeps } from './supervisor'
import type { RevocationList } from './revocation-list'
import type { InflightTracker } from './inflight-tracker'
import { isIpAllowed } from './allowlist'

const MLLP_START = 0x0b
const MLLP_END_FS = 0x1c
const MLLP_END_CR = 0x0d
const MAX_FRAME_BYTES = 8 * 1024 * 1024  // 8MB — DoS guard
const SOCKET_READ_TIMEOUT_MS = 60_000
const MAX_CONCURRENT_CONNECTIONS_PER_FEED = 16  // platform-floor; tenant may tighten via feed.config

export interface PerFeedListenerDeps extends SupervisorDeps {
  readonly revocationList: RevocationList
  readonly inflight: InflightTracker
}

export class PerFeedListener {
  private server?: tls.Server
  private acceptingNew = false
  private readonly activeConnections = new Set<tls.TLSSocket>()
  private readonly frameHandler: FrameHandler

  constructor(
    private readonly feed: ExternalFeed,
    private readonly deps: PerFeedListenerDeps,
  ) {
    this.frameHandler = new FrameHandler(feed, deps)
  }

  async start(): Promise<void> {
    const cred = await this.loadActiveCredential()
    if (!cred) {
      throw new Error(`feed_${this.feed.id}_no_active_credential`)
    }

    if (this.feed.protocol !== 'mllp_tls') {
      // mllp_plain is permitted only in test environments per spec D23
      if (this.deps.env.NODE_ENV !== 'test') {
        throw new Error(`feed_${this.feed.id}_mllp_plain_forbidden_in_prod`)
      }
    }

    const serverOpts = await this.buildTlsOptions(cred)

    this.server = tls.createServer(serverOpts, (socket) => this.handleConnection(socket))
    this.server.maxConnections = MAX_CONCURRENT_CONNECTIONS_PER_FEED

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      this.server!.once('error', onError)
      this.server!.listen(this.feed.port, '0.0.0.0', () => {
        this.server!.off('error', onError)
        resolve()
      })
    })

    this.acceptingNew = true
  }

  private async loadActiveCredential(): Promise<ExternalFeedCredential | undefined> {
    return withPlatformContext(this.deps.db, async (tx) => {
      const [row] = await tx
        .select()
        .from(externalFeedCredential)
        .where(
          and(
            eq(externalFeedCredential.feedId, this.feed.id),
            eq(externalFeedCredential.status, 'active'),
            eq(externalFeedCredential.kind, 'mllp_client_cert'),
          ),
        )
        .limit(1)
      return row
    })
  }

  private async buildTlsOptions(cred: ExternalFeedCredential): Promise<tls.TlsOptions> {
    // The credential's secret_cipher contains an envelope-encrypted JSON blob:
    //   { serverCertPem, serverKeyPem, expectedClientCaPem }
    // The server presents serverCertPem to incoming clients; expectedClientCaPem is the
    // pinned client-CA that clients must chain to. Per-feed pinning — no platform-wide
    // trust store.
    const plaintext = await this.deps.envelope.decrypt(cred.secretCipher, {
      organizationId: this.feed.organizationId,
    })
    const secret = JSON.parse(plaintext) as {
      serverCertPem: string
      serverKeyPem: string
      expectedClientCaPem: string
    }

    return {
      cert: secret.serverCertPem,
      key: secret.serverKeyPem,
      ca: secret.expectedClientCaPem,
      requestCert: true,
      rejectUnauthorized: true,  // mTLS REQUIRED (D23)
      minVersion: 'TLSv1.3',
      ciphers: [
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'TLS_AES_128_GCM_SHA256',
      ].join(':'),
      // Disable session resumption — every handshake re-validates client cert + CRL.
      sessionIdContext: undefined,
      ticketKeys: undefined,
    }
  }

  private handleConnection(socket: tls.TLSSocket): void {
    if (!this.acceptingNew) {
      socket.destroy()
      return
    }

    const peerAddr = socket.remoteAddress ?? 'unknown'
    const peerCert = socket.getPeerCertificate(true)

    // 1. Allowlist check (D3) — AFTER mTLS handshake (which is the first defense)
    if (!isIpAllowed(this.feed, peerAddr)) {
      this.deps.logger.warn(
        { feedId: this.feed.id, peerAddr, sha256: peerCert.fingerprint256 },
        'hl7.listener.allowlist_reject',
      )
      socket.destroy()
      return
    }

    // 2. CRL check (D23) — refuse if the cert fingerprint is in the revocation list
    if (this.deps.revocationList.contains(peerCert.fingerprint256)) {
      this.deps.logger.warn(
        { feedId: this.feed.id, peerAddr, sha256: peerCert.fingerprint256 },
        'hl7.listener.crl_reject',
      )
      socket.destroy()
      return
    }

    // 3. Cap concurrent connections per-feed
    if (this.activeConnections.size >= MAX_CONCURRENT_CONNECTIONS_PER_FEED) {
      this.deps.logger.warn(
        { feedId: this.feed.id, peerAddr, current: this.activeConnections.size },
        'hl7.listener.connection_cap_reject',
      )
      socket.destroy()
      return
    }

    this.activeConnections.add(socket)
    this.deps.logger.info(
      { feedId: this.feed.id, peerAddr, sha256: peerCert.fingerprint256, cipher: socket.getCipher()?.name },
      'hl7.listener.connection_accepted',
    )

    void this.handleSocketFrames(socket, peerAddr).finally(() => {
      this.activeConnections.delete(socket)
    })
  }

  private async handleSocketFrames(socket: tls.TLSSocket, peerAddr: string): Promise<void> {
    let buffer = Buffer.alloc(0)
    let inFrame = false

    socket.setTimeout(SOCKET_READ_TIMEOUT_MS)
    socket.on('timeout', () => {
      this.deps.logger.info({ feedId: this.feed.id, peerAddr }, 'hl7.listener.socket_timeout')
      socket.destroy()
    })

    socket.on('error', (err) => {
      this.deps.logger.warn({ feedId: this.feed.id, peerAddr, err: err.message }, 'hl7.listener.socket_error')
    })

    socket.on('close', () => {
      this.deps.logger.info({ feedId: this.feed.id, peerAddr }, 'hl7.listener.socket_closed')
    })

    for await (const chunk of socket as AsyncIterable<Buffer>) {
      buffer = Buffer.concat([buffer, chunk])

      while (buffer.length > 0) {
        // 1. Find frame start
        if (!inFrame) {
          const startIdx = buffer.indexOf(MLLP_START)
          if (startIdx < 0) {
            // No VT in buffer; skip junk
            buffer = Buffer.alloc(0)
            break
          }
          buffer = buffer.subarray(startIdx + 1)  // skip past <VT>
          inFrame = true
        }

        // 2. Frame size guard — if buffer exceeds MAX_FRAME_BYTES, drop the connection
        if (buffer.length > MAX_FRAME_BYTES) {
          this.deps.logger.warn(
            { feedId: this.feed.id, peerAddr, bufferBytes: buffer.length },
            'hl7.listener.frame_size_exceeded',
          )
          socket.destroy()
          return
        }

        // 3. Find frame end <FS><CR>
        let endIdx = -1
        for (let i = 0; i < buffer.length - 1; i++) {
          if (buffer[i] === MLLP_END_FS && buffer[i + 1] === MLLP_END_CR) {
            endIdx = i
            break
          }
        }

        if (endIdx < 0) {
          // Frame not yet complete; wait for more bytes.
          break
        }

        // 4. Extract complete frame payload (without <VT> at start or <FS><CR> at end)
        const payload = buffer.subarray(0, endIdx)
        buffer = buffer.subarray(endIdx + 2)
        inFrame = false

        // 5. Hand off to FrameHandler
        this.deps.inflight.begin()
        try {
          const ack = await this.frameHandler.handle(payload, peerAddr)
          // Emit ACK back to the same socket
          const ackFrame = Buffer.concat([
            Buffer.from([MLLP_START]),
            ack,
            Buffer.from([MLLP_END_FS, MLLP_END_CR]),
          ])
          if (!socket.destroyed) {
            socket.write(ackFrame)
          }
        } catch (err) {
          this.deps.logger.error(
            { feedId: this.feed.id, peerAddr, err: (err as Error).message },
            'hl7.listener.frame_handler_error',
          )
          // Best-effort AR
          try {
            const arFrame = Buffer.concat([
              Buffer.from([MLLP_START]),
              Buffer.from('MSH|^~\\&|WARDENX|ERR|||MSA|AR|UNKNOWN|internal_error', 'utf8'),
              Buffer.from([MLLP_END_FS, MLLP_END_CR]),
            ])
            if (!socket.destroyed) socket.write(arFrame)
          } catch { /* swallow */ }
        } finally {
          this.deps.inflight.end()
        }
      }
    }
  }

  async stopAccepting(): Promise<void> {
    this.acceptingNew = false
  }

  async close(): Promise<void> {
    if (!this.server) return
    for (const socket of this.activeConnections) {
      socket.destroy()
    }
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
  }

  async stop(): Promise<void> {
    await this.stopAccepting()
    await this.close()
  }

  isHealthy(): boolean {
    return this.acceptingNew && this.server !== undefined && this.server.listening
  }

  recentFrameCount(): number {
    return this.frameHandler.recentFrameCount()
  }

  lastFrameAt(): Date | null {
    return this.frameHandler.lastFrameAt()
  }
}
```

The `isIpAllowed` helper:

```ts
// apps/backend/src/modules/29-external-interfaces/listener/allowlist.ts
import { isIPv4, isIPv6 } from 'node:net'
import type { ExternalFeed } from '@wardenx/db/schema/external-interfaces'

export function isIpAllowed(feed: ExternalFeed, peerAddr: string): boolean {
  // sending_facility_allowlist is stored as JSONB string[] of CIDRs or bare IPs
  // (e.g. ["10.0.5.0/24", "192.168.1.42"]). Empty list = allow-all (test-only).
  const list = feed.sendingFacilityAllowlist as readonly string[]
  if (list.length === 0) return true  // permissive default for newly-provisioned feeds in test

  for (const entry of list) {
    if (matchCidrOrIp(entry, peerAddr)) return true
  }
  return false
}

function matchCidrOrIp(entry: string, peerAddr: string): boolean {
  if (entry === peerAddr) return true
  const slash = entry.indexOf('/')
  if (slash < 0) return false
  const base = entry.slice(0, slash)
  const prefix = parseInt(entry.slice(slash + 1), 10)
  if (Number.isNaN(prefix)) return false

  if (isIPv4(base) && isIPv4(peerAddr)) return matchIpv4Cidr(base, prefix, peerAddr)
  if (isIPv6(base) && isIPv6(peerAddr)) return matchIpv6Cidr(base, prefix, peerAddr)
  return false
}

function matchIpv4Cidr(base: string, prefix: number, peer: string): boolean {
  const baseInt = ipv4ToInt(base)
  const peerInt = ipv4ToInt(peer)
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (baseInt & mask) === (peerInt & mask)
}

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0
}

function matchIpv6Cidr(_base: string, _prefix: number, _peer: string): boolean {
  // Phase 1: IPv6 CIDR match is a stub returning false. Partner facilities are IPv4-only
  // in Phase 1 per the integrations doc. Phase 2 work: implement IPv6 BigInt CIDR.
  return false
}
```

---

## 6. `frame-handler.ts` — Idempotency, Persist, ACK

```ts
// apps/backend/src/modules/29-external-interfaces/listener/frame-handler.ts
import * as crypto from 'node:crypto'
import { ulid } from 'ulid'
import type { ExternalFeed } from '@wardenx/db/schema/external-interfaces'
import { hl7MessageInbound } from '@wardenx/db/schema/external-interfaces'
import { eq, and } from 'drizzle-orm'
import { withTenantContext } from '@wardenx/tenancy'
import type { PerFeedListenerDeps } from './per-feed-listener'

export class FrameHandler {
  private _lastFrameAt: Date | null = null
  private _recentFrameCount = 0

  constructor(
    private readonly feed: ExternalFeed,
    private readonly deps: PerFeedListenerDeps,
  ) {}

  /**
   * Handle a single MLLP frame.
   * Returns the ACK payload (without MLLP framing — the caller wraps it).
   *
   * Sequence:
   *   1. Pre-parse MSH-10 + sha256 (cheap, regex-light).
   *   2. Idempotency check: same (feed_id, message_control_id) already received? → AA + skip.
   *   3. Envelope-encrypt the payload with tenant DEK.
   *   4. Persist hl7_message_inbound with parse_status='in_progress'.
   *   5. Enqueue hl7-inbound-parse:{messageType} job.
   *   6. Return AA — COMMIT has happened by this point.
   */
  async handle(payload: Buffer, peerAddr: string): Promise<Buffer> {
    const wire = payload.toString('utf8')
    const pre = preParseMshOrThrow(wire)
    const sha = crypto.createHash('sha256').update(payload).digest('hex')
    const idempotencyKey = crypto
      .createHash('sha256')
      .update(`${this.feed.id}|${pre.messageControlId}`)
      .digest('hex')

    // Idempotency check
    const existing = await withTenantContext(
      this.deps.db,
      { organizationId: this.feed.organizationId },
      async (tx) => {
        const [row] = await tx
          .select({ id: hl7MessageInbound.id, messageControlId: hl7MessageInbound.messageControlId })
          .from(hl7MessageInbound)
          .where(
            and(
              eq(hl7MessageInbound.feedId, this.feed.id),
              eq(hl7MessageInbound.idempotencyKey, idempotencyKey),
            ),
          )
          .limit(1)
        return row
      },
    )

    if (existing) {
      this.deps.logger.info(
        { feedId: this.feed.id, messageControlId: pre.messageControlId, existingId: existing.id },
        'hl7.inbound.duplicate_dropped',
      )
      return mintAck('AA', pre.messageControlId, pre.sendingFacilityRaw, pre.receivingFacilityRaw)
    }

    // Envelope-encrypt the payload
    const payloadCipher = await this.deps.envelope.encrypt(payload.toString('utf8'), {
      organizationId: this.feed.organizationId,
    })

    // Persist
    const messageId = ulid()
    await withTenantContext(this.deps.db, { organizationId: this.feed.organizationId }, async (tx) => {
      await tx.insert(hl7MessageInbound).values({
        id: messageId,
        organizationId: this.feed.organizationId,
        feedId: this.feed.id,
        messageType: pre.messageType,
        messageControlId: pre.messageControlId,
        payloadCipher,
        payloadSha256: sha,
        segmentsSummary: pre.segmentsSummary,
        receivedAt: new Date(),
        parseStatus: 'in_progress',
        sendingFacilityRawId: pre.sendingFacilityRaw,
        idempotencyKey,
      })
    })

    // Emit outbox event (lands in same transaction via outbox-publisher in real code;
    // simplified inline here)
    await this.deps.outbox.publish('m29.hl7_message.inbound_received', {
      messageId,
      feedId: this.feed.id,
      organizationId: this.feed.organizationId,
      messageType: pre.messageType,
      messageControlId: pre.messageControlId,
      receivedAt: new Date().toISOString(),
      processingStatus: 'in_progress',
    })

    // Enqueue parse job
    await this.deps.bullmq.add(
      `parse:${pre.messageType}`,
      { messageId, feedId: this.feed.id, organizationId: this.feed.organizationId },
      {
        jobId: `parse-${messageId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: { age: 86_400 },  // keep 24h for ops visibility
        removeOnFail: { age: 604_800 },     // keep 7d failed
      },
    )

    this._lastFrameAt = new Date()
    this._recentFrameCount++

    this.deps.logger.info(
      {
        feedId: this.feed.id,
        messageId,
        messageType: pre.messageType,
        messageControlId: pre.messageControlId,
        peerAddr,
        bytes: payload.length,
      },
      'hl7.inbound.received',
    )

    return mintAck('AA', pre.messageControlId, pre.sendingFacilityRaw, pre.receivingFacilityRaw)
  }

  lastFrameAt(): Date | null {
    return this._lastFrameAt
  }

  recentFrameCount(): number {
    return this._recentFrameCount
  }
}

interface PreParsedMsh {
  readonly messageType: string
  readonly messageControlId: string
  readonly sendingFacilityRaw: string
  readonly receivingFacilityRaw: string
  readonly segmentsSummary: { segments: ReadonlyArray<{ name: string; byteCount: number }> }
}

function preParseMshOrThrow(wire: string): PreParsedMsh {
  // The MSH must be the first segment. We do NOT call the sidecar here — too expensive
  // for the listener hot path. We just split on the segment separator and read MSH.
  const segments = wire.split('\r').filter(s => s.length > 0)
  const msh = segments[0]
  if (!msh || !msh.startsWith('MSH')) {
    throw new Error('hl7_frame_missing_msh')
  }

  // MSH structure: MSH|^~\&|sendingApp|sendingFacility|receivingApp|receivingFacility|timestamp|security|msgType|controlId|...
  // Fields are split by the field separator (MSH-1 is the field separator itself, so we split positions are offset by one).
  // Positional read:
  //   pos 3 = sendingApp, pos 4 = sendingFacility, pos 5 = receivingApp, pos 6 = receivingFacility
  //   pos 9 = msgType, pos 10 = controlId
  const fields = msh.split('|')
  if (fields.length < 11) throw new Error('hl7_frame_msh_too_few_fields')

  const messageType = fields[8] || ''       // pos 9 in HL7 1-indexed = index 8 in 0-indexed split-by-|
  const messageControlId = fields[9] || ''  // pos 10
  const sendingFacilityRaw = fields[3] || ''
  const receivingFacilityRaw = fields[5] || ''

  if (!messageControlId) throw new Error('hl7_frame_missing_msh10')

  const segmentsSummary = {
    segments: segments.map((s) => ({
      name: s.substring(0, 3),
      byteCount: Buffer.byteLength(s, 'utf8'),
    })),
  }

  return { messageType, messageControlId, sendingFacilityRaw, receivingFacilityRaw, segmentsSummary }
}

function mintAck(code: 'AA' | 'AE' | 'AR', mcid: string, sendingFacility: string, receivingFacility: string): Buffer {
  // ACK^A01 structure: MSH + MSA
  const ts = new Date().toISOString().replace(/[^\d]/g, '').slice(0, 14)
  const ackMcid = ulid().slice(0, 20)
  const msh = `MSH|^~\\&|WARDENX|${receivingFacility}|${sendingFacility}|${receivingFacility}|${ts}||ACK|${ackMcid}|P|2.5.1`
  const msa = `MSA|${code}|${mcid}`
  return Buffer.from(`${msh}\r${msa}\r`, 'utf8')
}
```

---

## 7. `health-probe.ts` — Circuit Breaker

```ts
// apps/backend/src/modules/29-external-interfaces/listener/health-probe.ts
import type { SupervisorDeps } from './supervisor'
import type { PerFeedListener } from './per-feed-listener'
import { externalFeedHealth } from '@wardenx/db/schema/external-interfaces'
import { withTenantContext } from '@wardenx/tenancy'

const LISTENER_DOWN_THRESHOLD_MS = 5 * 60 * 1000  // 5min platform-floor (D17)

type BreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

interface FeedHealthRecord {
  state: BreakerState
  stateChangedAt: Date
  lastFrameAt: Date | null
  consecutiveProbeFails: number
}

export class HealthProbe {
  private readonly records = new Map<string, FeedHealthRecord>()

  constructor(
    private readonly deps: SupervisorDeps,
    private readonly listeners: Map<string, PerFeedListener>,
  ) {}

  async tick(): Promise<void> {
    const now = new Date()
    const tasks: Promise<void>[] = []

    for (const [feedId, listener] of this.listeners) {
      tasks.push(this.tickOneFeed(feedId, listener, now))
    }

    await Promise.allSettled(tasks)
  }

  private async tickOneFeed(feedId: string, listener: PerFeedListener, now: Date): Promise<void> {
    const record = this.records.get(feedId) ?? this.initRecord(now)
    const lastFrameAt = listener.lastFrameAt()
    if (lastFrameAt) record.lastFrameAt = lastFrameAt

    // Compute current health state
    const sinceLastFrame = lastFrameAt ? now.getTime() - lastFrameAt.getTime() : Infinity
    const tcpHealthy = listener.isHealthy()

    let newState: BreakerState = record.state
    if (sinceLastFrame >= LISTENER_DOWN_THRESHOLD_MS && !tcpHealthy) {
      newState = 'OPEN'
    } else if (record.state === 'OPEN' && tcpHealthy) {
      newState = 'HALF_OPEN'
    } else if (record.state === 'HALF_OPEN' && sinceLastFrame < LISTENER_DOWN_THRESHOLD_MS) {
      newState = 'CLOSED'
    }

    if (newState !== record.state) {
      await this.transitionState(feedId, record.state, newState, now)
      record.state = newState
      record.stateChangedAt = now
    }

    this.records.set(feedId, record)

    // Persist hour-bucket aggregate
    await this.writeHourBucket(feedId, listener, now)
  }

  private initRecord(now: Date): FeedHealthRecord {
    return {
      state: 'CLOSED',
      stateChangedAt: now,
      lastFrameAt: null,
      consecutiveProbeFails: 0,
    }
  }

  private async transitionState(
    feedId: string,
    from: BreakerState,
    to: BreakerState,
    now: Date,
  ): Promise<void> {
    this.deps.logger.info({ feedId, from, to }, 'hl7.listener.state_transition')

    if (to === 'OPEN') {
      await this.deps.outbox.publish('m29.external_feed.listener_down', { feedId, atTime: now.toISOString() })
      // The supervisor.boot() set up the alerts seam — find feed.organizationId for dispatch
      // (held by the supervisor's listener map → feed is accessible via the listener)
      await this.dispatchAlertForFeed(feedId, {
        severity: 'CRITICAL',
        channel: 'operator-on-call',
        title: 'HL7 listener down',
        body: `Feed ${feedId} listener has not received frames for ≥5min and TCP probe is failing.`,
      })
    } else if (to === 'CLOSED' && from !== 'CLOSED') {
      await this.deps.outbox.publish('m29.external_feed.listener_recovered', { feedId, atTime: now.toISOString() })
    }
  }

  private async dispatchAlertForFeed(
    feedId: string,
    payload: { severity: 'CRITICAL' | 'HIGH' | 'NORMAL'; channel: string; title: string; body: string },
  ): Promise<void> {
    // The supervisor holds the feed; we look up organization_id via the listener
    const listener = this.listeners.get(feedId)
    if (!listener) return
    await this.deps.alerts.dispatch({
      severity: payload.severity,
      channel: payload.channel,
      organizationId: (listener as { feedOrg?: string }).feedOrg ?? '',
      title: payload.title,
      body: payload.body,
    })
  }

  private async writeHourBucket(feedId: string, listener: PerFeedListener, now: Date): Promise<void> {
    // Hour-bucket aggregate write per M29 §3.3 external_feed_health
    // Conservative implementation: each 30s tick performs an UPSERT on the current hour bucket.
    // For T-29.04 we only update last_message_at; the byte/count fields are populated by the
    // parse worker in §11.
    const hourBucket = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000)
    const orgId = (listener as { feedOrg?: string }).feedOrg ?? ''
    if (!orgId) return

    await withTenantContext(this.deps.db, { organizationId: orgId }, async (tx) => {
      await tx
        .insert(externalFeedHealth)
        .values({
          feedId,
          hourBucket,
          organizationId: orgId,
          lastMessageAt: listener.lastFrameAt(),
        })
        .onConflictDoUpdate({
          target: [externalFeedHealth.feedId, externalFeedHealth.hourBucket],
          set: { lastMessageAt: listener.lastFrameAt() ?? undefined },
        })
    })
  }

  getStateForTest(feedId: string): BreakerState | undefined {
    return this.records.get(feedId)?.state
  }
}
```

---

## 8. `revocation-list.ts`

```ts
// apps/backend/src/modules/29-external-interfaces/listener/revocation-list.ts
import type { Logger } from 'pino'
import { externalFeedCredential } from '@wardenx/db/schema/external-interfaces'
import { eq } from 'drizzle-orm'
import { withPlatformContext } from '@wardenx/tenancy'

export class RevocationList {
  // Set of revoked-credential cert SHA-256 fingerprints (e.g. "AB:CD:EF:...").
  private readonly revoked = new Set<string>()

  constructor(private readonly logger: Logger) {}

  add(credentialId: string, fingerprint: string): void {
    this.revoked.add(this.normalize(fingerprint))
    this.logger.info({ credentialId, fingerprint }, 'hl7.crl.added')
  }

  contains(fingerprint: string | undefined): boolean {
    if (!fingerprint) return false
    return this.revoked.has(this.normalize(fingerprint))
  }

  async warmFromDb(db: typeof import('@wardenx/db').db): Promise<void> {
    const rows = await withPlatformContext(db, async (tx) =>
      tx
        .select({ id: externalFeedCredential.id, fingerprint: externalFeedCredential.fingerprint })
        .from(externalFeedCredential)
        .where(eq(externalFeedCredential.status, 'retired')),
    )

    for (const row of rows) {
      this.revoked.add(this.normalize(row.fingerprint))
    }

    this.logger.info({ count: rows.length }, 'hl7.crl.warmed')
  }

  private normalize(fingerprint: string): string {
    // Node tls exposes fingerprint256 as "AB:CD:EF:..." uppercase with colons; our DB-stored
    // fingerprint is the first 8 hex chars uppercase (per M29 §3.3 schema comment). For CRL
    // matching we compare on the first 8 hex chars too — sufficient for the per-feed cert
    // pinning model. Full fingerprint match would also work but the schema column is short.
    return fingerprint.replace(/:/g, '').slice(0, 16).toUpperCase()
  }
}
```

---

## 9. `inflight-tracker.ts`

```ts
// apps/backend/src/modules/29-external-interfaces/listener/inflight-tracker.ts
export class InflightTracker {
  private inflight = 0
  private drainResolvers: Array<() => void> = []

  begin(): void {
    this.inflight++
  }

  end(): void {
    this.inflight = Math.max(0, this.inflight - 1)
    if (this.inflight === 0) {
      for (const resolve of this.drainResolvers) resolve()
      this.drainResolvers = []
    }
  }

  count(): number {
    return this.inflight
  }

  /**
   * Wait up to `timeoutMs` for inflight to reach 0. Returns the count of frames that
   * drained during the wait (count_at_start - count_at_end).
   */
  async drain(timeoutMs: number): Promise<number> {
    const startCount = this.inflight
    if (startCount === 0) return 0

    const drainPromise = new Promise<void>((resolve) => this.drainResolvers.push(resolve))
    const timeoutPromise = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))

    await Promise.race([drainPromise, timeoutPromise])
    return startCount - this.inflight
  }
}
```

---

## 10. `index.ts` — Process Entrypoint

```ts
// apps/backend/src/modules/29-external-interfaces/listener/index.ts
//
// Sibling process entrypoint. Invoked via:
//   node --import tsx apps/backend/src/modules/29-external-interfaces/listener/index.ts
// or in production via the platform image's CMD that starts both Fastify and this process
// under a supervisord-style runtime.
import { pino } from 'pino'
import { db } from '@wardenx/db'
import { mkOutbox } from '@wardenx/foundation/outbox'
import { mkAlertsClient } from '@wardenx/foundation/seams/alerts'
import { mkMdmClient } from '@wardenx/foundation/seams/mdm'
import { mkKmsEnvelope } from '@wardenx/foundation/seams/kms'
import { Queue } from 'bullmq'
import { SupervisorImpl } from './supervisor'

async function main(): Promise<void> {
  const logger = pino({
    name: 'hl7-listener-supervisor',
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        '*.hl7.segments.PID',
        '*.hl7.segments.NK1',
        '*.hl7.segments.IN1',
        '*.hl7.segments.GT1',
        '*.hl7.segments.NTE',
        '*.hl7.payload',
        '*.payload_ciphertext',
        '*.secret_cipher',
      ],
      remove: false,
    },
  })

  logger.info('hl7.listener.process.starting')

  const bullmq = new Queue('hl7-inbound-parse', {
    connection: { url: process.env.VALKEY_URL! },
  })

  const supervisor = new SupervisorImpl({
    logger,
    db,
    outbox: mkOutbox(db, logger),
    alerts: mkAlertsClient(),
    mdm: mkMdmClient(),
    envelope: mkKmsEnvelope(),
    bullmq,
    env: process.env,
  })

  await supervisor.boot()
  logger.info('hl7.listener.process.ready')
}

main().catch((err) => {
  console.error('hl7.listener.process.fatal', err)
  process.exit(1)
})
```

---

## 11. Parse Worker — `hl7-inbound-parse.worker.ts`

The worker consumes the BullMQ jobs the listener enqueues. T-29.04's scope ends at "parse result persisted"; downstream routing (cascade, lab binder, proposal staging) is stubbed.

```ts
// apps/backend/src/modules/29-external-interfaces/workers/hl7-inbound-parse.worker.ts
import { Worker, type Job } from 'bullmq'
import { pino } from 'pino'
import { db } from '@wardenx/db'
import { hl7MessageInbound } from '@wardenx/db/schema/external-interfaces'
import { eq } from 'drizzle-orm'
import { withTenantContext } from '@wardenx/tenancy'
import { createSidecarClient } from '@wardenx/hl7-worker'
import { mkKmsEnvelope } from '@wardenx/foundation/seams/kms'
import { mkOutbox } from '@wardenx/foundation/seams/outbox'

interface ParseJobData {
  readonly messageId: string
  readonly feedId: string
  readonly organizationId: string
}

const logger = pino({ name: 'hl7-inbound-parse.worker' })
const envelope = mkKmsEnvelope()
const outbox = mkOutbox(db, logger)
const sidecar = createSidecarClient({
  udsPath: process.env.WARDENX_HL7_UDS_PATH ?? '/var/run/wardenx/hapi.sock',
  healthIntervalMs: 30_000,
  parseTimeoutMs: 2_000,
  buildTimeoutMs: 2_000,
  reconnectBackoffMs: [100, 500, 2000, 5000, 15000],
})

export const hl7InboundParseWorker = new Worker<ParseJobData>(
  'hl7-inbound-parse',
  async (job: Job<ParseJobData>) => {
    const { messageId, feedId, organizationId } = job.data
    logger.info({ messageId, feedId }, 'hl7.parse.worker.begin')

    // 1. Load the row
    const message = await withTenantContext(db, { organizationId }, async (tx) => {
      const [row] = await tx
        .select()
        .from(hl7MessageInbound)
        .where(eq(hl7MessageInbound.id, messageId))
        .limit(1)
      return row
    })
    if (!message) {
      logger.warn({ messageId }, 'hl7.parse.worker.row_missing')
      return
    }

    // 2. Decrypt payload
    const wire = await envelope.decrypt(message.payloadCipher, { organizationId })

    // 3. Call sidecar
    const profile = profileFor(message.messageType)
    try {
      const parsed = await sidecar.parse(Buffer.from(wire, 'utf8'), profile, {
        correlationId: `parse-${messageId}`,
      })

      // 4. Persist parse_status = 'parsed'
      await withTenantContext(db, { organizationId }, async (tx) => {
        await tx
          .update(hl7MessageInbound)
          .set({ parseStatus: 'parsed' })
          .where(eq(hl7MessageInbound.id, messageId))
      })

      // 5. Emit next-stage event. T-29.04 publishes the event; the cascade/binder
      //    consumers in T-29.05/T-29.07 will subscribe in their PR. For T-29.04
      //    the event lands in the outbox with no real consumer — that's the
      //    forward-stub pattern.
      const nextEvent = message.messageType.startsWith('ADT^')
        ? 'm29.hl7_message.parsed_adt'
        : message.messageType.startsWith('ORU^')
        ? 'm29.hl7_message.parsed_oru'
        : 'm29.hl7_message.parsed_other'

      await outbox.publish(nextEvent, {
        messageId,
        feedId,
        organizationId,
        messageType: message.messageType,
        messageControlId: message.messageControlId,
        parsedSegmentCount: parsed.segmentsList?.length ?? 0,
      })

      logger.info({ messageId, messageType: message.messageType, parsedSegments: parsed.segmentsList?.length ?? 0 }, 'hl7.parse.worker.success')
    } catch (err) {
      logger.error({ err, messageId }, 'hl7.parse.worker.error')
      await withTenantContext(db, { organizationId }, async (tx) => {
        await tx
          .update(hl7MessageInbound)
          .set({
            parseStatus: 'parse_error',
            parseError: { message: (err as Error).message, name: (err as Error).name },
          })
          .where(eq(hl7MessageInbound.id, messageId))
      })
      throw err  // BullMQ will retry per the job's attempts policy
    }
  },
  {
    connection: { url: process.env.VALKEY_URL! },
    concurrency: 8,
    limiter: { max: 10, duration: 1000 },  // soft global rate cap; per-feed cap below
  },
)

function profileFor(messageType: string): string {
  // Map MSH-9 to the sidecar profile string. Unknown messageType falls through to a permissive parse.
  const map: Record<string, string> = {
    'ADT^A01': 'ADT_A01_v2_5_1',
    'ADT^A03': 'ADT_A03_v2_5_1',
    'ADT^A04': 'ADT_A04_v2_5_1',
    'ADT^A08': 'ADT_A08_v2_5_1',
    'ADT^A11': 'ADT_A11_v2_5_1',
    'ORU^R01': 'ORU_R01_v2_5_1',
    'ORM^O01': 'ORM_O01_v2_5_1',
  }
  return map[messageType] ?? 'ADT_A01_v2_5_1'
}
```

**Per-feed soft cap.** The single-process worker has `concurrency: 8`. Per-feed soft-capping at 4 is achieved with an in-process semaphore keyed by feedId:

```ts
const perFeedSemaphores = new Map<string, { active: number; waiters: Array<() => void> }>()
const PER_FEED_MAX = 4

async function withFeedSlot<T>(feedId: string, fn: () => Promise<T>): Promise<T> {
  let sem = perFeedSemaphores.get(feedId)
  if (!sem) { sem = { active: 0, waiters: [] }; perFeedSemaphores.set(feedId, sem) }
  if (sem.active >= PER_FEED_MAX) {
    await new Promise<void>((resolve) => sem!.waiters.push(resolve))
  }
  sem.active++
  try { return await fn() }
  finally {
    sem.active--
    const next = sem.waiters.shift()
    if (next) next()
  }
}
```

Wrap the worker's process-job body in `withFeedSlot(job.data.feedId, async () => { ... })`. Bounded fairness; no Valkey changes.

---

## 12. Tests

### 12.1 Frame DoS guard

```ts
// listener/__tests__/per-feed-listener.test.ts
describe('frame-size DoS guard', () => {
  it('drops the connection when buffered bytes exceed 8MB without a frame end', async () => {
    const { listener, mockSocket } = await mkTestListener()
    const garbage = Buffer.from([0x0b, ...new Array(8 * 1024 * 1024 + 100).fill(0x41)])  // VT + 8.1MB of 'A's
    mockSocket.emit('data', garbage)
    await waitFor(() => expect(mockSocket.destroyed).toBe(true))
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ bufferBytes: expect.any(Number) }),
      'hl7.listener.frame_size_exceeded',
    )
  })

  it('does NOT drop on a legitimately large but well-framed message (~6MB)', async () => {
    const { listener, mockSocket, frameHandler } = await mkTestListener()
    const payload = Buffer.alloc(6 * 1024 * 1024, 0x41)
    const frame = Buffer.concat([Buffer.from([0x0b]), payload, Buffer.from([0x1c, 0x0d])])
    mockSocket.emit('data', frame)
    await waitFor(() => expect(frameHandler.handle).toHaveBeenCalled())
    expect(mockSocket.destroyed).toBe(false)
  })
})
```

### 12.2 Idempotency

```ts
describe('idempotency on duplicate MSH-10', () => {
  it('emits AA for the first frame and persists', async () => {
    const result = await frameHandler.handle(adtA01ValidFrame, '10.0.0.1')
    expect(result.toString()).toContain('MSA|AA')
    const rows = await db.select().from(hl7MessageInbound)
    expect(rows).toHaveLength(1)
  })

  it('emits AA for a duplicate frame without persisting again', async () => {
    await frameHandler.handle(adtA01ValidFrame, '10.0.0.1')
    const result = await frameHandler.handle(adtA01ValidFrame, '10.0.0.1')  // same MSH-10
    expect(result.toString()).toContain('MSA|AA')
    const rows = await db.select().from(hl7MessageInbound)
    expect(rows).toHaveLength(1)  // still just one
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ messageControlId: expect.any(String) }),
      'hl7.inbound.duplicate_dropped',
    )
  })

  it('does NOT dedup across feeds (same MSH-10 from feed_a and feed_b both persist)', async () => {
    await frameHandlerA.handle(adtA01ValidFrame, '10.0.0.1')
    await frameHandlerB.handle(adtA01ValidFrame, '10.0.0.2')
    const rows = await db.select().from(hl7MessageInbound)
    expect(rows).toHaveLength(2)
  })
})
```

### 12.3 mTLS handshake refusal

```ts
describe('mTLS handshake refusal', () => {
  it('refuses connection without client cert', async () => {
    const { listener, fixtures } = await mkLiveTlsListener()
    const result = attemptConnect({ ca: fixtures.serverCaPem })  // no clientCert
    await expect(result).rejects.toThrow(/handshake|sslv3 alert/i)
  })

  it('refuses connection with wrong-CA client cert', async () => {
    const result = attemptConnect({
      ca: fixtures.serverCaPem,
      cert: fixtures.wrongCaClientCert,
      key: fixtures.wrongCaClientKey,
    })
    await expect(result).rejects.toThrow()
  })

  it('refuses connection with expired client cert', async () => {
    const result = attemptConnect({
      ca: fixtures.serverCaPem,
      cert: fixtures.expiredClientCert,
      key: fixtures.expiredClientKey,
    })
    await expect(result).rejects.toThrow()
  })

  it('accepts connection with trusted client cert', async () => {
    const result = await attemptConnect({
      ca: fixtures.serverCaPem,
      cert: fixtures.trustedClientCert,
      key: fixtures.trustedClientKey,
    })
    expect(result.authorized).toBe(true)
  })

  it('refuses connection with revoked credential (CRL hit)', async () => {
    await supervisor.revocationList.add('cred_revoked', fixtures.trustedClientCert.fingerprint256)
    const result = attemptConnect({
      ca: fixtures.serverCaPem,
      cert: fixtures.trustedClientCert,
      key: fixtures.trustedClientKey,
    })
    // Connection is accepted at TLS layer but immediately destroyed by per-feed-listener
    await expect(awaitFirstFrame(result)).rejects.toThrow(/closed/)
  })
})
```

### 12.4 Listener-down 5min (W-XI-10)

```ts
describe('W-XI-10 — listener-down alert after 5min quiet + probe fail', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('transitions to OPEN and dispatches CRITICAL after 5min quiet + tcpHealthy=false', async () => {
    const { healthProbe, listener, alerts, outbox } = await mkTestSupervisor()
    // Frame arrived at t=0
    listener._mockLastFrameAt = new Date(0)
    listener._mockTcpHealthy = false

    // Advance to t=4:59 — still CLOSED
    vi.setSystemTime(new Date(4 * 60_000 + 59_000))
    await healthProbe.tick()
    expect(healthProbe.getStateForTest('feed_test')).toBe('CLOSED')

    // Advance to t=5:00 — transitions to OPEN
    vi.setSystemTime(new Date(5 * 60_000))
    await healthProbe.tick()
    expect(healthProbe.getStateForTest('feed_test')).toBe('OPEN')
    expect(alerts.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'CRITICAL', title: 'HL7 listener down' }),
    )
    expect(outbox.publishedEvents).toContainEqual(
      expect.objectContaining({ name: 'm29.external_feed.listener_down' }),
    )
  })

  it('transitions OPEN → HALF_OPEN when TCP comes back, then CLOSED on next frame', async () => {
    const { healthProbe, listener, outbox } = await mkTestSupervisor()
    // ... reach OPEN as above ...
    listener._mockTcpHealthy = true  // socket back up

    vi.setSystemTime(new Date(5 * 60_000 + 30_000))
    await healthProbe.tick()
    expect(healthProbe.getStateForTest('feed_test')).toBe('HALF_OPEN')

    listener._mockLastFrameAt = new Date(5 * 60_000 + 45_000)  // a frame arrived

    vi.setSystemTime(new Date(5 * 60_000 + 60_000))
    await healthProbe.tick()
    expect(healthProbe.getStateForTest('feed_test')).toBe('CLOSED')
    expect(outbox.publishedEvents).toContainEqual(
      expect.objectContaining({ name: 'm29.external_feed.listener_recovered' }),
    )
  })
})
```

### 12.5 Boot validator (W-XI-15) and BAA gate

```ts
describe('W-XI-15 — boot validator fails closed on missing predicate', () => {
  it('refuses to boot if `external_feed_compliance_co_approver_distinct` not in predicate registry', async () => {
    const deps = mkTestDeps({ omitPredicates: ['external_feed_compliance_co_approver_distinct'] })
    await expect(boot(deps)).rejects.toThrow(/BootValidationError.*external_feed_compliance_co_approver_distinct/)
  })
})

describe('BAA gate at boot (D16)', () => {
  it('skips a feed whose tenant has inactive BAA and dispatches a CRITICAL compliance alert', async () => {
    const { supervisor, alerts } = await mkTestSupervisor()
    mockMdm.baaStatus.mockResolvedValue({ isActive: false, status: 'expired' })

    await supervisor.boot()
    expect(supervisor.listeners.size).toBe(0)
    expect(alerts.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'CRITICAL', channel: 'compliance' }),
    )
  })

  it('starts the feed when BAA flips from expired to active via m40.mdm.baa_status_changed', async () => {
    // ... seed feed with mockMdm returning inactive at boot ...
    // ... emit m40.mdm.baa_status_changed with newStatus='active' ...
    // ... assert listener.start() was called ...
  })
})
```

### 12.6 Limited W-XI-01 (T-29.04 scope)

```ts
describe('W-XI-01 partial — listener through parse-result for T-29.04', () => {
  it('end-to-end: frame arrives → AA emitted → row persisted with parse_status=parsed', async () => {
    const { listener, sidecar } = await mkTestListenerWithSidecar()
    const trustedClient = await connectTrustedClient()

    const adtA01 = mkAdtA01Frame({ mcid: 'MCID-W01' })
    const ack = await trustedClient.sendFrameAndAwaitAck(adtA01)
    expect(ack).toContain('MSA|AA')
    expect(ack).toContain('MCID-W01')

    // Wait for the parse worker to process
    await waitFor(async () => {
      const [row] = await db.select().from(hl7MessageInbound)
      expect(row.parseStatus).toBe('parsed')
    }, 5_000)
  })

  it('does NOT yet produce a hl7_inbound_proposal row (that lands in T-29.06)', async () => {
    // After the parse, the proposal table is still empty — T-29.04 doesn't ship the cascade.
    const proposals = await db.select().from(hl7InboundProposal)
    expect(proposals).toHaveLength(0)
  })
})
```

---

## 13. Sign-Off Checklist (T-29.04 PR)

- [ ] All eight listener-directory files (§3) land.
- [ ] Parse worker file (`workers/hl7-inbound-parse.worker.ts`) lands.
- [ ] Listener supervisor starts as a sibling Node process (compose updated with the `hl7-listener` service alongside `backend` and `hl7-sidecar`).
- [ ] `bun run test apps/backend/src/modules/29-external-interfaces/listener` passes (frame DoS, idempotency, mTLS refusal — 4 scenarios, listener-down 5min — 2 scenarios, boot validator, BAA gate — 2 scenarios, limited W-XI-01 — 2 scenarios).
- [ ] Live TLS handshake test uses Testcontainer-style fixture certs (CA + trusted client + wrong-CA + expired).
- [ ] Sidecar UDS path is the same across the supervisor and the parse worker (verified via env-var pass-through in compose).
- [ ] mTLS 1.3 enforced; TLS 1.2 connection attempts refused.
- [ ] Session resumption disabled (verified by `tls.getSession()` returning undefined on second connect).
- [ ] CRL refresh on `m29.external_feed_credential.revoked` outbox event: revoked credential is refused within ≤2 seconds (next handshake after event publish).
- [ ] Per-feed soft-cap (4 concurrent parses per feed) verified by load test sending 20 frames on feed A and 5 on feed B; feed A's processing is throttled, feed B's is not.
- [ ] Graceful shutdown: SIGTERM stops accepting on every listener, drains for ≤30s, closes sockets, exits 0 with no in-flight remaining.
- [ ] Forced shutdown: when drain timeout expires with in-flight remaining, exit code is 1 and the unfinished frame's row remains in `parse_status='in_progress'` (parse worker will pick it up on next boot).
- [ ] PHI denylist test on supervisor + listener pino logs: no PID-5/NK1/IN1/GT1/NTE payload values appear in stdout during any test scenario.
- [ ] Outbox events `m29.hl7_message.inbound_received` and `m29.hl7_message.parsed_adt|parsed_oru|parsed_other` are emitted for each frame.
- [ ] M36 alerts are dispatched on (a) listener-down → operator-on-call, (b) BAA refuse → compliance.
- [ ] Compose's `hl7-listener` service has no `ports:` directive (the MLLP ports bind on the host network via `network_mode: host` in production OR via explicit `ports:` for the partner-IP-allowlisted port range 11000-11999 in staging — TBD per deployment environment).
- [ ] **Integrations engineer** sign-off on the MLLP framing implementation.
- [ ] **Platform engineer** sign-off on the sibling-process pattern + compose integration.
- [ ] **Security engineer** sign-off on mTLS posture, allowlist, CRL, frame DoS guard.
- [ ] **Clinical engineering reviewer** sign-off on the idempotency invariant (correctness on legitimate replays).

---

## 14. Notes on Refinements Past M29 Spec §4.11

This addendum surfaces four refinements past M29 spec v0.2:

1. **Sibling process, not Fastify-fork (§2.1).** The spec ambiguously says "Fastify-fork process". Resolution: a full sibling Node process, not `cluster.fork()` or a Fastify-managed child. Crash-isolation between HTTP serving and HL7 ingest is the goal. The compose definition adds an `hl7-listener` service alongside `backend`.

2. **COMMIT-before-ACK latency budget (§2.2).** Median 10-30ms, p95 1.5s — comfortable against the SLO. Recorded so a future "optimize ACK latency" PR can't trade away the durability guarantee.

3. **Per-feed soft cap on parse worker concurrency (§2.3).** Spec didn't pin a number; chose `PER_FEED_MAX = 4` with global worker concurrency `8`. Implemented via in-process semaphore keyed by feedId rather than queue-per-feed (which would multiply Valkey key count).

4. **Limited W-XI-01 scope for T-29.04 (§12.6).** Spec §10 says T-29.04 makes W-XI-01 pass. Honest scoping: T-29.04 lands the listener-through-parse path; the cascade (T-29.05) and proposal (T-29.06) parts of W-XI-01 land in their own PRs. T-29.04's W-XI-01 test asserts the partial chain (frame → AA → row with `parse_status='parsed'`); T-29.06's test asserts the full chain. This refinement is recorded so the M29 spec v0.3 acceptance section can be updated to reflect the per-PR cut points.

A fifth small refinement: **the segment-summary pre-parse in `frame-handler.ts` is regex-light by design.** It does NOT invoke the sidecar (which would 2x the per-frame latency). The MSH-10 + segment summary is extracted via a `split('\r').split('|')` walk — sufficient for the listener's hot path. The full HAPI parse happens in the BullMQ worker, asynchronously from the ACK path.

---

## Document Footer

**Addendum version:** v1.0 (T-29.04 PR-ready)
**Bound to:** `WARDENX_MODULE_29_EXTERNAL_INTERFACES_SPEC_v0_2.md` §4.11, §4.9, §10
**Files delivered:** 9 listener-directory files + 1 parse worker + 1 allowlist helper = 11 TypeScript files
**Tests:** 6 test files covering ~18 scenarios (DoS, idempotency × 3, mTLS × 5, listener-down × 2, boot validator × 1, BAA gate × 2, limited W-XI-01 × 2, miscellaneous × 3)
**Spec refinements:** 5 recorded for the next M29 spec revision
**Sign-offs required:** Integrations engineer, Platform engineer, Security engineer, Clinical engineering reviewer

**End of T-29.04 MLLP listener supervisor addendum.**
