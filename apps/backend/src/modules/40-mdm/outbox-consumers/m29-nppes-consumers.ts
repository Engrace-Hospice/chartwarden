// apps/backend/src/modules/40-mdm/outbox-consumers/m29-nppes-consumers.ts — M40-T09 the M29
// NPPES-sync outbox consumers (M40 spec §4.7, §7.11–7.12). PHASE-1 FORWARD-SEAM / DENY-STUB.
//
// M29 (HL7/NPPES interop) is Wave H — it does not exist yet, so there is NO `m29.*` producer and no
// M1 outbox dispatcher to subscribe to. These two consumers are DECLARED here (the binding contract
// M29 will satisfy) but are NOT live-wired: the composition root does not register them in Phase 1.
// Until M29 lands, the M40-T08 nightly delta job (`mdm.nppes_nightly_delta`) is the Phase-1
// AUTHORITATIVE sync path — the same drift is caught, just on a 24h cadence instead of event-driven.
//
// When M29 lands, wiring is mechanical: bind {@link handleProviderSynced}/{@link handleProviderDeactivated}
// (pure, already shipped + tested in @wardenx/mdm) over Drizzle/M36 ports and register them on the
// dispatcher under the consumer names below. That flips the system from W-M40-13 (nightly fallback)
// to W-M40-12 (M29 updates the canonical within minutes, nightly skips as recently-synced).
import type {
  M29ProviderDeactivatedPayload,
  M29ProviderSyncedPayload,
  NppesConsumerPorts,
  ProviderDeactivatedOutcome,
  ProviderSyncedDecision,
} from "@wardenx/mdm";
import { handleProviderDeactivated, handleProviderSynced } from "@wardenx/mdm";

/** A declared (event → consumer) binding M29 will dispatch to once it lands. */
export interface M29ConsumerDescriptor {
  /** The M29-owned event this consumer subscribes to (`m29.*`; M29 owns the catalog entry). */
  readonly eventName: "m29.nppes.provider_synced" | "m29.nppes.provider_deactivated";
  /** M40's consumer name on the dispatcher (the §4.7 `m40.*` handler id). */
  readonly consumerName:
    | "m40.nppes-provider-synced-applier"
    | "m40.nppes-provider-deactivated-applier";
}

/** The two §4.7 consumers M40 declares against M29's events (wired live when M29 lands, Wave H). */
export const M29_NPPES_CONSUMERS: readonly M29ConsumerDescriptor[] = [
  { eventName: "m29.nppes.provider_synced", consumerName: "m40.nppes-provider-synced-applier" },
  {
    eventName: "m29.nppes.provider_deactivated",
    consumerName: "m40.nppes-provider-deactivated-applier",
  },
] as const;

/** True in Phase 1 — there is no M29 producer, so the consumers run via the T08 nightly fallback. */
export const M29_CONSUMERS_DEFERRED = true;

/**
 * The handler factory M29 wiring will use (Wave H): binds the pure @wardenx/mdm handlers over the
 * injected Drizzle/M36 ports. Exposed now so the binding is type-checked against the real handler
 * shapes; the composition root does NOT call this in Phase 1 (the consumers stay deferred).
 */
export function createM29NppesConsumerHandlers(ports: NppesConsumerPorts): {
  onProviderSynced(payload: M29ProviderSyncedPayload): Promise<ProviderSyncedDecision>;
  onProviderDeactivated(
    payload: M29ProviderDeactivatedPayload,
  ): Promise<ProviderDeactivatedOutcome>;
} {
  return {
    onProviderSynced: (payload) => handleProviderSynced(payload, ports),
    onProviderDeactivated: (payload) => handleProviderDeactivated(payload, ports),
  };
}
