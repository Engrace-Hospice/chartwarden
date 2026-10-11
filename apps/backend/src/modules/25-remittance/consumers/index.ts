// apps/backend/src/modules/25-remittance/consumers — the M25 §4.4 upstream-consumer register surface (the
// M27/M23 consumers/index.ts mirror). Routes each subscribed topic to its pure handler (./handlers.ts) and
// exposes `dispatchM25UpstreamEvent`. GAP-205: the former `registerM25Consumers` registrar was dead scaffolding (no caller, no dispatcher took a registrar) and is deleted; the LIVE bindings are the `OutboxConsumerBinding`s under `../outbox-consumers/` (wired from apps/backend/src/index.ts, proven by `arch:outbox-bindings`).
import {
  DENY_DENIAL_TERMINOLOGY,
  type DenialOpenedEmission,
  type DenialSeedStore,
  type DenialTerminologyLookupPort,
  handleClaimRejected,
  handleDocumentRendered,
  handleEvvAggregatorRejected,
} from "./handlers";
import { M25_UPSTREAM_SUBSCRIPTIONS } from "./subscription-map";

export { M25_SUBSCRIPTION_MAP, M25_UPSTREAM_SUBSCRIPTIONS } from "./subscription-map";

/** The live ports the consumers run over (the Drizzle-backed denial-seed store + a back-ref store). F-153/
 *  F-156 (#248) — `terminology` is optional here ONLY because this whole file is inert scaffolding this
 *  module's own header says is never invoked by the boot dispatcher; a caller that omits it gets the honest
 *  `DENY_DENIAL_TERMINOLOGY` degrade (every code resolves to `unmapped`), never a silent fabrication. */
export interface M25ConsumerPorts {
  readonly seedStore: DenialSeedStore;
  readonly terminology?: DenialTerminologyLookupPort;
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
      // A clearinghouse-stage rejection is not a payer denial (ADR-0053 D2): nothing to seed.
      if (p.rejectionStage === "clearinghouse") return { handled: true, denialOpened: null };
      const emission = await handleClaimRejected(
        ports.seedStore,
        {
          organizationId: String(p.organizationId ?? ""),
          providerEntityId: String(p.providerEntityId ?? ""),
          claimId: String(p.claimId ?? ""),
          rejectionCodes: Array.isArray(p.rejectionCodes) ? (p.rejectionCodes as string[]) : [],
          occurredAt: String(p.occurredAt ?? new Date(0).toISOString()),
        },
        ports.terminology ?? DENY_DENIAL_TERMINOLOGY,
      );
      return { handled: true, denialOpened: emission };
    }
    case "m18.evv.aggregator_rejected": {
      const emission = await handleEvvAggregatorRejected(
        ports.seedStore,
        {
          organizationId: String(p.organizationId ?? ""),
          providerEntityId: String(p.providerEntityId ?? ""),
          aggregatorSubmissionId: String(p.aggregatorSubmissionId ?? ""),
          carcCode: typeof p.carcCode === "string" ? p.carcCode : undefined,
          rarcCode: typeof p.rarcCode === "string" ? p.rarcCode : undefined,
        },
        ports.terminology ?? DENY_DENIAL_TERMINOLOGY,
      );
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
