// apps/backend/src/bootstrap/realtime — ADR-0054 realtime transport (M1 infra). Owner of the socket.io,
// @socket.io/redis-adapter and @socket.io/redis-emitter imports (VENDOR_ADAPTERS in both manifests).
export { createRealtimeEmitter, type RealtimeEmitterPort } from "./emitter";
export {
  startRealtimeServer,
  type RealtimeHandle,
  type RealtimeLog,
  type RealtimeOptions,
  type RealtimePrincipal,
} from "./server";
