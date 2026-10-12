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
import type { IncomingMessage, Server as HttpServer } from "node:http";
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

export function startRealtimeServer(options: RealtimeOptions): RealtimeHandle {
  const log: RealtimeLog = options.log ?? (() => {});
  const trusted = new Set(options.trustedOrigins);
  const maxPerUser = options.maxSocketsPerUser ?? DEFAULT_MAX_SOCKETS_PER_USER;
  const principals = new WeakMap<IncomingMessage, RealtimePrincipal>();
  const socketsByUser = new Map<string, Set<string>>();

  const io = new Server(options.httpServer, {
    path: "/socket.io",
    serveClient: false,
    // websocket first, long-polling allowed as the fallback (D11); polling needs sticky sessions at the ingress.
    transports: ["websocket", "polling"],
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      if (origin && !trusted.has(origin)) {
        log("realtime.refused", { reason: "origin" });
        callback("origin not allowed", false);
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
