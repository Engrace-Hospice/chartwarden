// apps/backend/src/bootstrap/realtime/emitter.ts — ADR-0054 addendum A1: the worker-side half of the transport.
//
// Outbox consumers run in the worker role while the Socket.IO `Server` lives in the api role, so a consumer never
// holds a Server. It talks to every api node through the same Valkey, via @socket.io/redis-emitter: `emit` reaches
// the sockets in the named rooms on whichever node holds them, and `disconnectRoom` ends them
// (`io.in(room).disconnectSockets(true)` semantics). Rooms are plain strings chosen by the caller: this directory is
// M1 and may not import M36's room grammar (module-1-boundary), so M36 composes `user:<id>` etc. itself.
import { Emitter } from "@socket.io/redis-emitter";
import type { Redis } from "ioredis";

export interface RealtimeEmitterPort {
  emit(rooms: readonly string[], event: string, payload: unknown): Promise<void>;
  disconnectRoom(room: string): Promise<void>;
}

// The emitter library publishes fire-and-forget, so a publish into a down Valkey would queue silently and the
// outbox row would be acked. Refuse up front instead: the dispatcher then retries (revocation must not be at-most-once).
function assertReady(client: Redis): void {
  if (client.status !== "ready") throw new Error(`realtime emitter not ready (${client.status})`);
}

export function createRealtimeEmitter(client: Redis): RealtimeEmitterPort {
  const emitter = new Emitter(client);
  return {
    async emit(rooms, event, payload) {
      if (rooms.length === 0) return;
      assertReady(client);
      emitter.to([...rooms]).emit(event, payload);
    },
    async disconnectRoom(room) {
      assertReady(client);
      emitter.in(room).disconnectSockets(true);
    },
  };
}
