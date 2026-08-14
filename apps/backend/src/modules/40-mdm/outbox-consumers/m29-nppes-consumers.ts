// apps/backend/src/modules/40-mdm/outbox-consumers/m29-nppes-consumers.ts — M40-T09's M29 NPPES-sync
// outbox consumers (M40 spec §4.7, §7.11–7.12). LIVE as of GAP-099.
//
// This file shipped as a forward-seam deny-stub: M29 was Wave H and did not exist, so the two consumers
// were declared but never registered, and `M29_CONSUMERS_DEFERRED` was `true`. M29 landed, and GAP-045
// then built the platform NPPES sync that actually publishes `m29.nppes.provider_synced` /
// `m29.nppes.provider_deactivated` — at which point the stub's premise ("no producer exists") stopped
// being true and the events began accumulating undelivered.
//
// Wiring was NOT the "mechanical" job the original comment predicted. Three separate things were missing:
//   1. the dispatcher could not DELIVER a platform-wide (`organization_id IS NULL`) event to any consumer
//      at all — `pollPlatform()` claimed rows and put them straight back down as deferred (GAP-099 built
//      `PlatformOutboxConsumerBinding` + migration 0201's org-less receipt path);
//   2. M40's canonical tables had NO WRITE PATH — migration 0019 created `mdm_canonical_writer` and its
//      grants but never a function owning them, so `external_physician` had been read-only since it
//      landed (migration 0202);
//   3. `m40.canonical.updated` was not in any event catalog (events-by-m40.ts).
// Only the fourth piece — the decision logic in `@wardenx/mdm` — was genuinely ready to bind.
//
// This flips the system from W-M40-13 (the T08 nightly delta job as the authoritative sync) to W-M40-12
// (M29 updates the canonical within minutes of the registry change).
import type {
  M29ProviderDeactivatedPayload,
  M29ProviderSyncedPayload,
  NppesConsumerPorts,
  ProviderDeactivatedOutcome,
  ProviderSyncedDecision,
} from "@wardenx/mdm";
import { handleProviderDeactivated, handleProviderSynced } from "@wardenx/mdm";
import type { DbClient } from "@wardenx/db";
import type {
  PlatformDispatchableOutboxEvent,
  PlatformOutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";
import {
  type M40NppesConsumerDeps,
  type NppesApplyRecord,
  buildNppesConsumerPorts,
} from "./nppes-consumer-ports";

/** A declared (event → consumer) binding M29 dispatches to. */
export interface M29ConsumerDescriptor {
  /** The M29-owned event this consumer subscribes to (`m29.*`; M29 owns the catalog entry). */
  readonly eventName: "m29.nppes.provider_synced" | "m29.nppes.provider_deactivated";
  /** M40's consumer name on the dispatcher (the §4.7 `m40.*` handler id). */
  readonly consumerName:
    | "m40.nppes-provider-synced-applier"
    | "m40.nppes-provider-deactivated-applier";
}

/** The two §4.7 consumers M40 declares against M29's events. */
export const M29_NPPES_CONSUMERS: readonly M29ConsumerDescriptor[] = [
  { eventName: "m29.nppes.provider_synced", consumerName: "m40.nppes-provider-synced-applier" },
  {
    eventName: "m29.nppes.provider_deactivated",
    consumerName: "m40.nppes-provider-deactivated-applier",
  },
] as const;

/**
 * False since GAP-099 — the consumers are registered on the dispatcher's platform list at the composition
 * root. Kept (rather than deleted) because `assertNoInMemoryBindingsOnDbBoot`-style honesty flags read it,
 * and a constant that flipped is a clearer record than one that vanished.
 */
export const M29_CONSUMERS_DEFERRED = false;

/**
 * The handler factory: binds the pure @wardenx/mdm handlers over injected ports. Retained from the
 * deny-stub era for the slice/unit tests, which inject fakes.
 */
export function createM29NppesConsumerHandlers(ports: NppesConsumerPorts): {
  onProviderSynced(payload: M29ProviderSyncedPayload): Promise<ProviderSyncedDecision>;
  onProviderDeactivated(payload: M29ProviderDeactivatedPayload): Promise<ProviderDeactivatedOutcome>;
} {
  return {
    onProviderSynced: (payload) => handleProviderSynced(payload, ports),
    onProviderDeactivated: (payload) => handleProviderDeactivated(payload, ports),
  };
}

function asRecord(payload: unknown, eventName: string): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`${eventName}: payload is not an object`);
  }
  return payload as Record<string, unknown>;
}

/**
 * Narrow the claimed row's `unknown` payload. The boot catalog validated it at PUBLISH time, but a
 * consumer reads rows that were written by an older deploy against an older schema — so it re-checks the
 * fields it dereferences. A throw here fails the delivery into the ordinary retry/dead-letter path, which
 * is the correct outcome for a row this consumer cannot understand.
 */
function parseSyncedPayload(payload: unknown): M29ProviderSyncedPayload {
  const raw = asRecord(payload, "m29.nppes.provider_synced");
  const provider = asRecord(raw.provider, "m29.nppes.provider_synced.provider");
  if (typeof raw.npi !== "string" || typeof raw.syncRunId !== "string") {
    throw new Error("m29.nppes.provider_synced: missing npi/syncRunId");
  }
  if (typeof provider.firstName !== "string" || typeof provider.lastName !== "string") {
    throw new Error("m29.nppes.provider_synced: provider snapshot missing firstName/lastName");
  }
  return {
    npi: raw.npi,
    action: raw.action === "inserted" ? "inserted" : "updated",
    changedFields: Array.isArray(raw.changedFields) ? raw.changedFields.map(String) : [],
    syncedAt: typeof raw.syncedAt === "string" ? raw.syncedAt : new Date(0).toISOString(),
    syncRunId: raw.syncRunId,
    provider: {
      firstName: provider.firstName,
      lastName: provider.lastName,
      credentials: typeof provider.credentials === "string" ? provider.credentials : null,
      specialtyTaxonomy:
        typeof provider.specialtyTaxonomy === "string" ? provider.specialtyTaxonomy : null,
    },
  };
}

function parseDeactivatedPayload(payload: unknown): M29ProviderDeactivatedPayload {
  const raw = asRecord(payload, "m29.nppes.provider_deactivated");
  if (typeof raw.npi !== "string") {
    throw new Error("m29.nppes.provider_deactivated: missing npi");
  }
  return {
    npi: raw.npi,
    deactivationDate: typeof raw.deactivationDate === "string" ? raw.deactivationDate : "",
    deactivationReason:
      typeof raw.deactivationReason === "string" ? raw.deactivationReason : "unspecified",
    detectedAt: typeof raw.detectedAt === "string" ? raw.detectedAt : new Date(0).toISOString(),
  };
}

/** Publish M40's own `m40.canonical.deactivated` record after a deactivation actually applied. */
async function emitCanonicalDeactivated(
  deps: M40NppesConsumerDeps,
  payload: M29ProviderDeactivatedPayload,
  record: NppesApplyRecord,
): Promise<void> {
  if (record.canonicalId === null) return;
  const canonicalId = record.canonicalId;
  await deps.db.transaction(async (tx) => {
    await deps.outbox.publish(tx as unknown as DbClient, {
      eventName: "m40.canonical.deactivated",
      payload: {
        kind: "physician",
        canonicalId,
        npi: payload.npi,
        deactivationDate: payload.deactivationDate,
        deactivationReason: payload.deactivationReason,
        alertedOrganizationIds: [...record.alertedOrganizationIds],
      },
      organizationId: null,
      aggregateKind: "external_physician",
      aggregateId: canonicalId,
    });
  });
}

/**
 * The two live PLATFORM bindings the composition root registers on the dispatcher (GAP-099).
 *
 * Ports are built PER DELIVERY, not once: {@link NppesApplyRecord} accumulates what the handler did (which
 * canonical, which fields, which orgs were alerted) so the binding can shape its own follow-on emit, and a
 * shared instance would leak one event's outcome into the next one's record.
 */
export function buildM29NppesPlatformConsumers(
  deps: M40NppesConsumerDeps,
): readonly PlatformOutboxConsumerBinding[] {
  return [
    {
      consumerName: "m40.nppes-provider-synced-applier",
      consumerModule: "m40",
      eventTypes: ["m29.nppes.provider_synced"],
      async handle(event: PlatformDispatchableOutboxEvent): Promise<void> {
        const { ports } = buildNppesConsumerPorts(deps);
        // The decision (`no_canonical_skipped` / `no_op` / `updated_canonical`) is deliberately not
        // surfaced as a failure: skipping an NPI this platform has no canonical for is the SPECIFIED
        // outcome (D10), not an error, and re-delivery of an already-applied update is a `no_op`. The
        // handler only throws when a WRITE it decided to make did not land — which retries.
        await handleProviderSynced(parseSyncedPayload(event.payload), ports);
      },
    },
    {
      consumerName: "m40.nppes-provider-deactivated-applier",
      consumerModule: "m40",
      eventTypes: ["m29.nppes.provider_deactivated"],
      async handle(event: PlatformDispatchableOutboxEvent): Promise<void> {
        const { ports, record } = buildNppesConsumerPorts(deps);
        const payload = parseDeactivatedPayload(event.payload);
        const outcome = await handleProviderDeactivated(payload, ports);
        if (outcome === "deactivated_canonical") {
          await emitCanonicalDeactivated(deps, payload, record);
        }
      },
    },
  ];
}
