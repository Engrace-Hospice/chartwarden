// @chartwarden/messaging — realtime layer (M36-T08, spec §4.3).
//
// The Socket.IO event & room CONTRACT: the room grammar + connect-time room-set computation
// (./rooms) and the event names + sanitized payload types (./events). The Socket.IO server +
// Valkey adapter WIRING (handshake auth, join/leave, emit) lives in the app composition root /
// M1 infra; this package owns the pure contract and imports no socket.io / Valkey client.
export * from "./rooms";
export * from "./events";
export * from "./hints";
