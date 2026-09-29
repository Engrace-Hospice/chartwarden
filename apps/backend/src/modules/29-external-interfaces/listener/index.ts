// apps/backend/src/modules/29-external-interfaces/listener — the MLLP listener supervisor process
// entrypoint (M29-T03, §4.11). This is the SIBLING process owned by M29 (§4.11: a separate OS process from
// the Fastify HTTP server, for crash isolation). It composes the pure supervisor (`supervisor.ts`) with the
// real IO: a TLS listener registry (§4.11.2) and, wired in the T08 boot task, the DB feed loader + the
// `getSeam("BaaStatusProvider")` gate + the M36 alert dispatcher.
//
// WHAT T03 SHIPS HERE. The real per-feed TLS listener registry (`createTlsListenerRegistry`) — mTLS,
// TLSv1.3-min, per-connection `handleMllpConnection`. WHAT IT DEFERS. The `SupervisorDeps` that reach into
// M1 (the DB `withPlatformContext` feed loader, the `getSeam` BAA gate, the M36 alert dispatcher) — those
// require the M1 dependsOn edge the T08 seam/route task adds, so the concrete `main()` composition lives
// with T08. This file exposes the registry + re-exports the supervisor so T08 wires `startListenerProcess`.
import net from "node:net";
import tls from "node:tls";
import { type MllpConnectionDeps, handleMllpConnection } from "./connection";
import {
  PlainListenerRefusedError,
  inboundPlainAllowed,
  listenerProtocolRefusal,
} from "./protocol-policy";
import type { ListenerRegistryPort, SupervisorFeedDescriptor } from "./supervisor";

export * from "./supervisor";
export * from "./connection";
export * from "./mllp-framing";
export * from "./ack";
export * from "./circuit-breaker";
export * from "./protocol-policy";

/** The per-feed mTLS material (decrypted from `external_feed_credential.secret_cipher` via M2 envelope KMS
 *  by the injected loader — the plaintext PEMs never persist). */
export interface TlsCredentialMaterial {
  readonly serverCertPem: string;
  readonly serverKeyPem: string;
  /** The pinned expected client CA (§8.7 D23 per-feed cert pin) — required for mTLS. */
  readonly expectedClientCaPem: string;
}

/** The injected IO the TLS registry needs per feed. */
export interface TlsListenerRegistryDeps {
  /** Load + decrypt the active mTLS credential for a feed (§4.11.2). */
  loadCredential(feed: SupervisorFeedDescriptor): Promise<TlsCredentialMaterial>;
  /** The per-connection handler deps (the ingest sink, ACK minting, clock) for a feed. */
  connectionDeps(feed: SupervisorFeedDescriptor): MllpConnectionDeps;
  log(level: "info" | "warn", event: string, fields: Record<string, unknown>): void;
  /** F-182 — may a `mllp_plain` listener bind? Omitted ⇒ `inboundPlainAllowed(process.env)` (never in
   *  production, opt-in elsewhere) — FAIL CLOSED. */
  allowPlainProtocol?: boolean;
}

/**
 * The real §4.11.2 listener registry: one TLS (or, for a `mllp_plain` test feed, plain-TCP) MLLP server per
 * feed. mTLS is required for `mllp_tls` (`requestCert` + `rejectUnauthorized`, TLSv1.3-min, per-feed pinned
 * CA); a rejected client cert never reaches `handleMllpConnection`. `stop` closes the server and is
 * idempotent. Binding to `0.0.0.0:<feed.port>` on an isolated port — never the public ingress (§4.11).
 */
export function createTlsListenerRegistry(deps: TlsListenerRegistryDeps): ListenerRegistryPort {
  const servers = new Map<string, net.Server>();

  return {
    async start(feed: SupervisorFeedDescriptor): Promise<void> {
      if (servers.has(feed.id)) return;
      // F-182 — the bind point is the last line of defence: a caller that bypassed the supervisor's gate still
      // cannot open a cleartext socket the deployment forbids. Refuses BEFORE `net.createServer`.
      const allowPlain = deps.allowPlainProtocol ?? inboundPlainAllowed(process.env);
      if (listenerProtocolRefusal(feed.protocol, allowPlain) !== null) {
        deps.log("warn", "hl7.listener.plain_refused", { feedId: feed.id });
        throw new PlainListenerRefusedError(feed.id);
      }
      const connDeps = deps.connectionDeps(feed);

      let server: net.Server;
      if (feed.protocol === "mllp_plain") {
        // Non-production plain TCP only (F-182: refused above unless the explicit opt-in is set outside
        // production — the arch posture is mTLS, §8.7).
        server = net.createServer((socket) => handleMllpConnection(socket, feed, connDeps));
      } else {
        const cred = await deps.loadCredential(feed);
        server = tls.createServer(
          {
            cert: cred.serverCertPem,
            key: cred.serverKeyPem,
            ca: cred.expectedClientCaPem,
            requestCert: true,
            rejectUnauthorized: true,
            minVersion: "TLSv1.3",
          },
          (socket) => handleMllpConnection(socket, feed, connDeps),
        );
      }

      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(feed.port, "0.0.0.0", () => {
          server.off("error", reject);
          resolve();
        });
      });
      servers.set(feed.id, server);
      deps.log("info", "hl7.listener.bound", { feedId: feed.id, port: feed.port });
    },

    async stop(feedId: string, reason: "suspended" | "revoked" | "shutdown"): Promise<void> {
      const server = servers.get(feedId);
      if (!server) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      servers.delete(feedId);
      deps.log("info", "hl7.listener.unbound", { feedId, reason });
    },

    boundFeedIds(): readonly string[] {
      return [...servers.keys()];
    },
  };
}
