import {
  type AlertEmitter,
  type MessagingProvider,
  createInMemoryAlertEmitter,
} from "@chartwarden/messaging";
// apps/backend/src/modules/36-messaging/seams.ts — M36-T06 seam registration (spec §4.6).
//
// M36 publishes the platform's alert/messaging surfaces. This module-owned init registers M36's
// REAL `AlertEmitter` into the M1 seam registry — the ONE boot-validated cross-module surface
// every clinical/billing module emits through (Wave-B acceptance) — overwriting the Phase-0
// deny-stub. The composition root (apps/backend/src/index.ts `wireModuleSeams`) invokes it inside
// the boot gate, after M1's wireSeams() and before validateSeams().
//
// `MessagingProvider` (the channel/message CRUD surface) is registered here over the deny-stub WHEN
// a DB-backed implementation is injected (FB-T05): per-tenant DEK body encryption, receipt fan-out,
// entitled-reader decryption (createDbMessagingProvider). The slice/tests (no `deps.provider`) leave
// it fail-closed — `getMessagingProvider()` then resolves the deny-stub (denies loudly on call),
// present and never failing open.
//
// Both seams follow M38's rich-seam pattern: the interface lives in @chartwarden/messaging (the leaf
// @chartwarden/types may not import it), so the M1 registry holds the instance opaquely
// (`SeamContracts[…] = unknown`); this file is the typed boundary — it registers the typed impl
// and hands consumers a typed handle. Consumers import the `AlertEmitter`/`MessagingProvider` TYPE
// from @chartwarden/messaging (they already list 36 in dependsOn) and resolve the runtime instance here.
//
// SLICE NOTE: the emitter is wired over an in-memory slice (no live DB/Valkey/source-module
// seams) by default — the M36-T04 resolution/fan-out engine over empty recipient ports + the
// platform-default rule seed. Production injects the Drizzle/seam-backed ports (T07/T08) via
// `deps.emitter`.
import type {
  ChartPromotionSourceReader,
  EscalationRouter,
  MessagingResponseAnalyticsReader,
} from "@chartwarden/types";
import { getSeam, registerSeam } from "../../bootstrap/index";

/** Injected production wiring for M36's published seams (the slice defaults to in-memory). */
export interface MessagingSeamDeps {
  /** The `AlertEmitter` to publish (production: T04 engine over Drizzle/seam-backed ports). */
  emitter?: AlertEmitter;
  /** The DB-backed `MessagingProvider` to publish over the deny-stub (FB-T05; production only). */
  provider?: MessagingProvider;
  /** The chart-promotion reader M8 and M14 show their reviewer (WP 3.7); absent = the fail-closed deny-stub stays. */
  promotionSource?: ChartPromotionSourceReader;
  /** WP 6.2: aggregate response analytics, served over M33's route; absent = the fail-closed deny-stub stays. */
  responseAnalytics?: MessagingResponseAnalyticsReader;
}

/**
 * Register M36's published seams into the M1 registry (before validateSeams()): `AlertEmitter`
 * always (M36-T06), and `MessagingProvider` when a DB-backed impl is injected (FB-T05) — otherwise
 * the latter stays the fail-closed deny-stub validateSeams() applies.
 */
export function registerMessagingSeams(deps: MessagingSeamDeps = {}): void {
  const emitter = deps.emitter ?? createInMemoryAlertEmitter().emitter;
  registerSeam("AlertEmitter", emitter);
  if (deps.provider) registerSeam("MessagingProvider", deps.provider);
  if (deps.promotionSource) registerSeam("ChartPromotionSourceReader", deps.promotionSource);
  if (deps.responseAnalytics) {
    registerSeam("MessagingResponseAnalyticsReader", deps.responseAnalytics);
  }
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
export function getMessagingProvider(): import("@chartwarden/messaging").MessagingProvider {
  return getSeam("MessagingProvider") as import("@chartwarden/messaging").MessagingProvider;
}

/**
 * Typed resolver for the `EscalationRouter` (WP 4.3, ADR-0057). M36 only ever REACHES M19 through this accessor: it never registers
 * an implementation (M19 owns it). With no M19 binding the registry holds the deny-stub, which answers `unavailable` /
 * `source: "deny_stub"`; a caller must treat that as "cannot route", never as "nobody needed". WP 4.4 is its first caller.
 */
export function getEscalationRouter(): EscalationRouter {
  return getSeam("EscalationRouter");
}
