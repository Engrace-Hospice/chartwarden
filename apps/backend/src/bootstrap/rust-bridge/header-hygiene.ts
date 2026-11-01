// apps/backend/src/bootstrap/rust-bridge/header-hygiene.ts — CW-RUST-M02 P1.
//
// `X-CW-Actor-Assertion` is Bun's own signed statement to Rust about who the caller is. A client must never be able
// to supply one, so it is DELETED from every incoming request before any other hook runs. This applies whether or
// not the bridge is enabled. Bun never reads the incoming value; the forwarder mints its own for the outgoing call
// to Rust (and Rust verifies its Ed25519 signature). nginx also drops it on every public vhost (defence in depth).
import type { FastifyInstance } from "fastify";

export function applyAssertionHeaderHygiene(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    // Header names arrive lower-cased (Fastify/Node), so one delete covers every casing a client sends. Spelled as a
    // literal (= ASSERTION_HEADER) so arch:request-header-auth can see which header this touches.
    // biome-ignore lint/performance/noDelete: the header must be ABSENT, not present-with-undefined (downstream `in` checks and forwarding).
    delete request.headers["x-cw-actor-assertion"];
  });
}
