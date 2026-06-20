// apps/backend/src/modules/36-messaging/seams.ts — M36-T06 seam registration (spec §4.6).
//
// M36 publishes the platform's alert/messaging surfaces. This module-owned init registers M36's
// REAL `AlertEmitter` into the M1 seam registry — the ONE boot-validated cross-module surface
// every clinical/billing module emits through (Wave-B acceptance) — overwriting the Phase-0
// deny-stub. The composition root (apps/backend/src/index.ts `wireModuleSeams`) invokes it inside
// the boot gate, after M1's wireSeams() and before validateSeams().
//
// `MessagingProvider` (the channel/message CRUD surface) is declared fail-closed in REQUIRED_SEAMS
// but is NOT registered here: its DB-backed implementation (per-tenant DEK body encryption,
// receipts, entitled-reader decryption) lands with the routes/realtime tasks (M36-T07/T08), which
// will register it over the deny-stub at their own boot. Until then `getMessagingProvider()`
// resolves the fail-closed stub (denies loudly on call) — present, never failing open.
//
// Both seams follow M38's rich-seam pattern: the interface lives in @wardenx/messaging (the leaf
// @wardenx/types may not import it), so the M1 registry holds the instance opaquely
// (`SeamContracts[…] = unknown`); this file is the typed boundary — it registers the typed impl
// and hands consumers a typed handle. Consumers import the `AlertEmitter`/`MessagingProvider` TYPE
// from @wardenx/messaging (they already list 36 in dependsOn) and resolve the runtime instance here.
//
// SLICE NOTE: the emitter is wired over an in-memory slice (no live DB/Valkey/source-module
// seams) by default — the M36-T04 resolution/fan-out engine over empty recipient ports + the
// platform-default rule seed. Production injects the Drizzle/seam-backed ports (T07/T08) via
// `deps.emitter`.
import { type AlertEmitter, createInMemoryAlertEmitter } from "@wardenx/messaging";
import { getSeam, registerSeam } from "../../bootstrap/index";

/** Injected production wiring for M36's published seams (the slice defaults to in-memory). */
export interface MessagingSeamDeps {
  /** The `AlertEmitter` to publish (production: T04 engine over Drizzle/seam-backed ports). */
  emitter?: AlertEmitter;
}

/** Register M36's `AlertEmitter` into the M1 registry (M36-T06; before validateSeams()). */
export function registerMessagingSeams(deps: MessagingSeamDeps = {}): void {
  const emitter = deps.emitter ?? createInMemoryAlertEmitter().emitter;
  registerSeam("AlertEmitter", emitter);
}

/**
 * Typed resolver for `AlertEmitter` consumers. The M1 registry stores it opaquely; this re-applies
 * the type at the M36 boundary (the cast is sound — `registerMessagingSeams` registered a real
 * `AlertEmitter`, and `validateSeams()` guarantees an instance is present, fail-closed, before any
 * consumer runs).
 */
export function getAlertEmitter(): AlertEmitter {
  return getSeam("AlertEmitter") as AlertEmitter;
}

/**
 * Typed resolver for `MessagingProvider` consumers. Until the DB-backed impl registers (T07/T08)
 * this resolves the fail-closed deny-stub (throws on any call); the typed cast keeps the consumer
 * boundary honest. Imported here lazily as a type so the leaf-free boundary stays clean.
 */
export function getMessagingProvider(): import("@wardenx/messaging").MessagingProvider {
  return getSeam("MessagingProvider") as import("@wardenx/messaging").MessagingProvider;
}
