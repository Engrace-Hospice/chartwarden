// apps/backend/src/bootstrap/realtime/telemetry.ts — ADR-0054 item 12: connect/disconnect metrics and audit.
//
// The server reports everything through its `log(event, context)` callback; this turns that stream into Prometheus
// series and (via an injected sink, so this M1 directory stays free of M36) audit rows. Refusals are metrics + logs
// only: a row per refused handshake would hand a flood a way to fill the audit table.
import { Counter, Gauge, type Registry } from "prom-client";
import type { RealtimeHandle, RealtimeLog } from "./server";

/** Socket.IO's closed set of disconnect reasons plus the server-initiated ones; anything else is `other` (bounded labels). */
const DISCONNECT_REASONS = new Set([
  "server namespace disconnect",
  "client namespace disconnect",
  "server shutting down",
  "transport close",
  "transport error",
  "ping timeout",
  "parse error",
  "forced close",
  "forced server close",
]);
const REFUSAL_REASONS = new Set([
  "origin",
  "rate_limited",
  "rate_limited_session",
  "throttle_error",
  "unauthenticated",
  "auth_error",
  "connection_cap",
  "rooms_error",
]);
/** The server (not the client or the network) ended the socket: revocation, session end, cap or shutdown. */
const isForced = (reason: string) =>
  reason.startsWith("server") || reason === "forced server close";

export interface RealtimeAuditEvent {
  readonly kind: "connected" | "disconnected";
  readonly organizationId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly reason?: string;
  readonly forced?: boolean;
  readonly durationMs?: number;
}

export interface RealtimeTelemetryDeps {
  readonly handle: () => RealtimeHandle | undefined;
  readonly log: RealtimeLog;
  readonly audit?: (event: RealtimeAuditEvent) => Promise<void>;
  readonly onAuditError?: (err: unknown) => void;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" ? v : 0);

export function createRealtimeTelemetry(
  registry: Registry,
  deps: RealtimeTelemetryDeps,
): RealtimeLog {
  new Gauge({
    name: "wardenx_realtime_connections",
    help: "Open Socket.IO connections on this node",
    registers: [registry],
    collect() {
      this.set(deps.handle()?.connectionCount() ?? 0);
    },
  });
  new Gauge({
    name: "wardenx_realtime_degraded",
    help: "1 when the Valkey connections the realtime adapter needs are not ready (cross-node fan-out lost)",
    registers: [registry],
    collect() {
      this.set(deps.handle()?.state() === "degraded" ? 1 : 0);
    },
  });
  const connects = new Counter({
    name: "wardenx_realtime_connects_total",
    help: "Sockets that completed the handshake and joined their rooms",
    registers: [registry],
  });
  const disconnects = new Counter({
    name: "wardenx_realtime_disconnects_total",
    help: "Joined sockets that ended, by Socket.IO reason",
    labelNames: ["reason"] as const,
    registers: [registry],
  });
  const refused = new Counter({
    name: "wardenx_realtime_refused_total",
    help: "Handshakes or sockets refused, by reason",
    labelNames: ["reason"] as const,
    registers: [registry],
  });
  const record = (event: RealtimeAuditEvent) => {
    if (!deps.audit) return;
    deps.audit(event).catch((err) => deps.onAuditError?.(err));
  };

  return (event, context) => {
    deps.log(event, context);
    if (event === "realtime.connect") {
      connects.inc();
      record({
        kind: "connected",
        organizationId: str(context.organizationId),
        userId: str(context.userId),
        sessionId: str(context.sessionId),
      });
    } else if (event === "realtime.disconnect") {
      const reason = str(context.reason);
      disconnects.inc({ reason: DISCONNECT_REASONS.has(reason) ? reason : "other" });
      record({
        kind: "disconnected",
        organizationId: str(context.organizationId),
        userId: str(context.userId),
        sessionId: str(context.sessionId),
        reason,
        forced: isForced(reason),
        durationMs: num(context.durationMs),
      });
    } else if (event === "realtime.refused") {
      const reason = str(context.reason);
      refused.inc({ reason: REFUSAL_REASONS.has(reason) ? reason : "other" });
    }
  };
}
