// @chartwarden/messaging — cache layer (M36-T08, spec §4.8).
//
// The §4.8 cache key grammar + TTLs + invalidation, and the cache port + in-memory adapter. The
// Valkey WIRING (connection, SCAN/UNLINK, EXPIRE) lives in the app composition root; this package
// stays free of any Valkey import — the same M1-owns-mechanism / module-owns-policy split as jobs.
export * from "./keys";
export * from "./store";
