// apps/backend/src/bootstrap/realtime/server.ts — ADR-0054: the Socket.IO server (api role only).
//
//  * Authentication happens BEFORE an engine session exists (`allowRequest`), and the principal is re-read in
//    `io.use`; an anonymous client gets nothing. Tenant and user come from the session, never from the client.
//  * `Origin` is checked here because the session cookie is ambient and Socket.IO bypasses Fastify's CSRF hook.
//  * Rooms are chosen by the server (`resolveRooms`); the client sends no room name and has no client->server events.
//  * Events are PHI-free hints (see packages/messaging realtime/hints.ts); the database cursor is the record.
//  * A socket is not session activity (ADR-0054 item 12): the injected `stillValid` re-checks the session with
//    `recordActivity:false`, on an interval, and a dead session is disconnected.
//  * This directory is M1 and imports nothing from M36; everything M36-shaped is injected by the composition root.
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import type { Redis } from "ioredis";
import { Server } from "socket.io";

export interface RealtimePrincipal {
  readonly userId: string;
  readonly organizationId: string;
  readonly sessionId: string;
}

export type RealtimeLog = (event: string, context: Record<string, string | number>) => void;

export interface RealtimeOptions {
  readonly httpServer: HttpServer;
  readonly pubClient: Redis;
  readonly subClient: Redis;
  /** Validate the handshake cookie; null refuses the connection. */
  readonly authenticate: (headers: IncomingMessage["headers"]) => Promise<RealtimePrincipal | null>;
  /** The rooms this principal may join (computed on the server, e.g. `computeRoomSet`). */
  readonly resolveRooms: (principal: RealtimePrincipal) => Promise<readonly string[]>;
  /** Is the session still alive? Must not count as activity (idle timer). */
  readonly stillValid: (principal: RealtimePrincipal) => Promise<boolean>;
  /** Browser origins allowed to open a socket; an absent Origin header (non-browser client) is allowed. */
  readonly trustedOrigins: readonly string[];
  readonly maxSocketsPerUser?: number;
  readonly recheckIntervalMs?: number;
  /** Handshake attempts per client key per minute (default 60); over it the request is refused BEFORE any DB work. */
  readonly handshakesPerClientPerMinute?: number;
  /** Handshake attempts per session cookie per minute (default 20): one valid cookie cannot open a flood. */
  readonly handshakesPerSessionPerMinute?: number;
  /** The caller key for the per-client limit. Default: the socket's remote address (a proxy needs its own key). */
  readonly clientKey?: (req: IncomingMessage) => string;
  readonly log?: RealtimeLog;
}

export interface RealtimeHandle {
  readonly io: Server;
  connectionCount(): number;
  /** `degraded` when the Valkey connections the adapter needs are not ready (cross-node fan-out is lost). */
  state(): "ready" | "degraded";
  close(): Promise<void>;
}

const DEFAULT_MAX_SOCKETS_PER_USER = 8;
const DEFAULT_RECHECK_MS = 60_000;
const MAX_RECHECK_FAILURES = 3;
const RATE_WINDOW_MS = 60_000;
const DEFAULT_HANDSHAKES_PER_CLIENT = 60;
const DEFAULT_HANDSHAKES_PER_SESSION = 20;
// Clients send nothing (no client->server events), so a tiny frame limit costs nothing; the connect timeout bounds
// engine sessions that never complete the namespace CONNECT.
const MAX_HTTP_BUFFER_BYTES = 1024;
const CONNECT_TIMEOUT_MS = 10_000;

// Hard bound on distinct keys per window. Past it the OLDEST key is evicted: memory stays bounded and a key flood can
// only weaken the throttle (it already could by rotating keys), never lock every new legitimate caller out.
const MAX_LIMITER_KEYS = 100_000;

/** Fixed-window counter per key, in memory per node; the whole table resets each window and is capped in size. */
function createWindowLimiter(max: number) {
  let windowStart = Date.now();
  let counts = new Map<string, number>();
  return {
    allow(key: string): boolean {
      const now = Date.now();
      if (now - windowStart >= RATE_WINDOW_MS) {
        windowStart = now;
        counts = new Map();
      }
      const seen = counts.get(key);
      if (seen === undefined && counts.size >= MAX_LIMITER_KEYS) {
        const oldest = counts.keys().next().value;
        if (oldest !== undefined) counts.delete(oldest);
      }
      const n = (seen ?? 0) + 1;
      counts.set(key, n);
      return n <= max;
    },
  };
}

export function startRealtimeServer(options: RealtimeOptions): RealtimeHandle {
  const log: RealtimeLog = options.log ?? (() => {});
  const trusted = new Set(options.trustedOrigins);
  const maxPerUser = options.maxSocketsPerUser ?? DEFAULT_MAX_SOCKETS_PER_USER;
  const principals = new WeakMap<IncomingMessage, RealtimePrincipal>();
  const socketsByUser = new Map<string, Set<string>>();

  const clientLimiter = createWindowLimiter(
    options.handshakesPerClientPerMinute ?? DEFAULT_HANDSHAKES_PER_CLIENT,
  );
  const sessionLimiter = createWindowLimiter(
    options.handshakesPerSessionPerMinute ?? DEFAULT_HANDSHAKES_PER_SESSION,
  );
  const clientKey =
    options.clientKey ?? ((req: IncomingMessage) => req.socket.remoteAddress ?? "unknown");

  const io = new Server(options.httpServer, {
    path: "/socket.io",
    serveClient: false,
    maxHttpBufferSize: MAX_HTTP_BUFFER_BYTES,
    connectTimeout: CONNECT_TIMEOUT_MS,
    // websocket first, long-polling allowed as the fallback (D11); polling needs sticky sessions at the ingress.
    transports: ["websocket", "polling"],
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      if (origin && !trusted.has(origin)) {
        log("realtime.refused", { reason: "origin" });
        callback("unauthorized", false);
        return;
      }
      // Cheapest check first: nothing below touches the database once the client budget is spent. The per-session
      // budget is charged AFTER authentication, on the session id the authenticator resolved: keying on the raw cookie
      // would have to mirror its parsing (decoding, quoting, which cookie name it reads), and any difference lets a
      // caller mint a fresh bucket per request. A throw here fails closed.
      try {
        if (!clientLimiter.allow(clientKey(req))) {
          log("realtime.refused", { reason: "rate_limited" });
          callback("unauthorized", false);
          return;
        }
      } catch {
        log("realtime.refused", { reason: "throttle_error" });
        callback("unauthorized", false);
        return;
      }
      options
        .authenticate(req.headers)
        .then((principal) => {
          if (!principal) {
            log("realtime.refused", { reason: "unauthenticated" });
            callback("unauthorized", false);
            return;
          }
          if (!sessionLimiter.allow(principal.sessionId)) {
            log("realtime.refused", { reason: "rate_limited_session", userId: principal.userId });
            callback("unauthorized", false);
            return;
          }
          principals.set(req, principal);
          callback(null, true);
        })
        .catch(() => {
          log("realtime.refused", { reason: "auth_error" });
          callback("unauthorized", false);
        });
    },
  });

  io.adapter(createAdapter(options.pubClient, options.subClient));
  // The adapter is an EventEmitter: an unhandled 'error' would crash the process. Degraded, not down (item 11).
  io.of("/").adapter.on?.("error", () => log("realtime.adapter_error", {}));

  io.use((socket, next) => {
    const principal = principals.get(socket.request);
    if (!principal) {
      next(new Error("unauthorized"));
      return;
    }
    socket.data.principal = principal;
    next();
  });

  io.on("connection", (socket) => {
    const principal = socket.data.principal as RealtimePrincipal;
    const mine = socketsByUser.get(principal.userId) ?? new Set<string>();
    socketsByUser.set(principal.userId, mine);
    socket.on("disconnect", (reason) => {
      mine.delete(socket.id);
      if (mine.size === 0) socketsByUser.delete(principal.userId);
      log("realtime.disconnect", { reason, userId: principal.userId });
    });
    if (mine.size >= maxPerUser) {
      log("realtime.refused", { reason: "connection_cap", userId: principal.userId });
      socket.disconnect(true);
      return;
    }
    mine.add(socket.id);
    options
      .resolveRooms(principal)
      .then((rooms) => socket.join([...rooms]))
      .then(() =>
        log("realtime.connect", {
          userId: principal.userId,
          organizationId: principal.organizationId,
        }),
      )
      .catch(() => {
        log("realtime.refused", { reason: "rooms_error", userId: principal.userId });
        socket.disconnect(true);
      });
  });

  // Session expiry: one sweep, one check per distinct session per tick. A failed check is tolerated (a DB blip must
  // not mass-disconnect) but only MAX_RECHECK_FAILURES times in a row, so an outage cannot keep a revoked session alive.
  const failures = new Map<string, number>();
  const timer = setInterval(() => {
    const checked = new Map<string, Promise<boolean>>();
    for (const socket of io.sockets.sockets.values()) {
      const principal = socket.data.principal as RealtimePrincipal | undefined;
      if (!principal) continue;
      let alive = checked.get(principal.sessionId);
      if (!alive) {
        const sessionId = principal.sessionId;
        alive = options.stillValid(principal).then(
          (ok) => {
            failures.delete(sessionId);
            return ok;
          },
          () => {
            const n = (failures.get(sessionId) ?? 0) + 1;
            failures.set(sessionId, n);
            log("realtime.recheck_failed", { userId: principal.userId, consecutive: n });
            return n < MAX_RECHECK_FAILURES;
          },
        );
        checked.set(principal.sessionId, alive);
      }
      void alive.then((ok) => {
        if (ok) return;
        log("realtime.session_ended", { userId: principal.userId });
        socket.disconnect(true);
      });
    }
  }, options.recheckIntervalMs ?? DEFAULT_RECHECK_MS);
  timer.unref();

  return {
    io,
    connectionCount: () => io.sockets.sockets.size,
    state: () =>
      options.pubClient.status === "ready" && options.subClient.status === "ready"
        ? "ready"
        : "degraded",
    async close() {
      clearInterval(timer);
      // `.local`: a node shutting down must drop ITS sockets only, never broadcast a cluster-wide disconnect.
      io.local.disconnectSockets(true);
      // Not `io.close()`: that also closes the shared HTTP server, which Fastify owns and closes itself.
      io.engine.close();
    },
  };
}
