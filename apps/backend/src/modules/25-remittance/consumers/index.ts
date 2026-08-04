// apps/backend/src/modules/25-remittance/consumers — the M25 §4.4 upstream-consumer register surface (the
// M27/M23 consumers/index.ts mirror). Routes each subscribed topic to its pure handler (./handlers.ts) and
// exposes `registerM25Consumers` for the boot dispatcher. NO live inbound relay loop exists yet (RULE 3(d));
// until it lands the composition root calls this with NO registrar — it then merely returns the
// forward-declared subscriptions (nothing boots), the identical posture every other module is in.
import {
  type DenialOpenedEmission,
  type DenialSeedStore,
  handleClaimRejected,
  handleDocumentRendered,
  handleEvvAggregatorRejected,
} from "./handlers";
import { M25_UPSTREAM_SUBSCRIPTIONS } from "./subscription-map";

export { M25_SUBSCRIPTION_MAP, M25_UPSTREAM_SUBSCRIPTIONS } from "./subscription-map";

/** The live ports the consumers run over (the Drizzle-backed denial-seed store + a back-ref store). */
export interface M25ConsumerPorts {
  readonly seedStore: DenialSeedStore;
}

/** The report a dispatched upstream event yields: the seeded denial emission (to fan out), if any. */
export interface M25ConsumeReport {
  readonly handled: boolean;
  readonly denialOpened?: DenialOpenedEmission | null;
}

/** Route one delivered upstream event to its M25 effect (§4.4). PHI-free reports; ids + codes only. */
export async function dispatchM25UpstreamEvent(
  event: { topic: string; payload: Record<string, unknown> },
  ports: M25ConsumerPorts,
): Promise<M25ConsumeReport> {
  const p = event.payload;
  switch (event.topic) {
    case "m23.claim.rejected": {
      const emission = await handleClaimRejected(ports.seedStore, {
        organizationId: String(p.organizationId ?? ""),
        providerEntityId: String(p.providerEntityId ?? ""),
        claimId: String(p.claimId ?? ""),
        rejectionCodes: Array.isArray(p.rejectionCodes) ? (p.rejectionCodes as string[]) : [],
        occurredAt: String(p.occurredAt ?? new Date(0).toISOString()),
      });
      return { handled: true, denialOpened: emission };
    }
    case "m18.evv.aggregator_rejected": {
      const emission = await handleEvvAggregatorRejected(ports.seedStore, {
        organizationId: String(p.organizationId ?? ""),
        providerEntityId: String(p.providerEntityId ?? ""),
        aggregatorSubmissionId: String(p.aggregatorSubmissionId ?? ""),
        carcCode: typeof p.carcCode === "string" ? p.carcCode : undefined,
        rarcCode: typeof p.rarcCode === "string" ? p.rarcCode : undefined,
      });
      return { handled: true, denialOpened: emission };
    }
    case "m22.document.rendered": {
      const at = p.aggregateType;
      if (at !== "appeal_case" && at !== "denial_case") return { handled: false };
      await handleDocumentRendered(ports.seedStore, {
        organizationId: String(p.organizationId ?? ""),
        aggregateType: at,
        aggregateId: String(p.aggregateId ?? ""),
        documentId: String(p.documentId ?? ""),
      });
      return { handled: true };
    }
    default:
      return { handled: false };
  }
}

/**
 * Register the M25 §4.4 upstream consumers (the M27 register-surface mirror). The boot dispatcher calls this
 * with its `bind(eventName, handler)` registrar + the live {@link M25ConsumerPorts}; each subscription is
 * bound to a closure over {@link dispatchM25UpstreamEvent}. Until the live inbound dispatcher lands the
 * composition root calls this with NO registrar — it then merely returns the forward-declared subscriptions.
 */
export function registerM25Consumers(options?: {
  readonly ports?: M25ConsumerPorts;
  readonly bind?: (
    topic: string,
    handler: (payload: Record<string, unknown>) => Promise<M25ConsumeReport>,
  ) => void;
}): readonly string[] {
  const { ports, bind } = options ?? {};
  if (bind && ports) {
    for (const topic of M25_UPSTREAM_SUBSCRIPTIONS) {
      bind(topic, (payload) => dispatchM25UpstreamEvent({ topic, payload }, ports));
    }
  }
  return M25_UPSTREAM_SUBSCRIPTIONS;
}
