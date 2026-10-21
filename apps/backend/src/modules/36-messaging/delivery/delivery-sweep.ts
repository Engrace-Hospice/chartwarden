// apps/backend/src/modules/36-messaging/delivery/delivery-sweep.ts — GAP-101, the §4.4 send_* worker body.
//
// One tick for ONE channel: enumerate the active orgs, and per org claim a bounded batch, dispatch each claimed
// delivery through the transport seam and persist the outcome. BOUNDED (`DELIVERY_SWEEP_BATCH_LIMIT` per org
// per tick), IDEMPOTENT (a settled row is never claimed again; a row already holding a vendor id is never
// re-sent) and ISOLATED (one org's — or one delivery's — failure is recorded and the sweep continues).
import {
  type ClaimedDelivery,
  DELIVERY_CLAIM_LEASE_MS,
  DELIVERY_SWEEP_BATCH_LIMIT,
  type OutOfBandTransportChannel,
  type OutOfBandTransports,
  dispatchClaimedDelivery,
} from "@chartwarden/messaging";
import type { DeliveryDispatchStore } from "./delivery-dispatch-store-db";

export interface DeliverySweepDeps {
  readonly store: DeliveryDispatchStore;
  readonly transports: OutOfBandTransports;
  readonly appBaseUrl: string;
  readonly activeOrgs: {
    listActiveOrgs(): Promise<readonly { readonly organizationId: string }[]>;
  };
  readonly now?: () => Date;
  readonly onError?: (
    context: { organizationId: string; deliveryId?: string },
    error: unknown,
  ) => void;
}

export interface DeliverySweepResult {
  readonly claimed: number;
  readonly sent: number;
  readonly retried: number;
  readonly failed: number;
  readonly errors: number;
}

const EMPTY: DeliverySweepResult = { claimed: 0, sent: 0, retried: 0, failed: 0, errors: 0 };

function add(a: DeliverySweepResult, b: Partial<DeliverySweepResult>): DeliverySweepResult {
  return {
    claimed: a.claimed + (b.claimed ?? 0),
    sent: a.sent + (b.sent ?? 0),
    retried: a.retried + (b.retried ?? 0),
    failed: a.failed + (b.failed ?? 0),
    errors: a.errors + (b.errors ?? 0),
  };
}

async function dispatchOne(
  deps: DeliverySweepDeps,
  claim: ClaimedDelivery,
  now: Date,
): Promise<Partial<DeliverySweepResult>> {
  const outcome = await dispatchClaimedDelivery(claim, {
    transports: deps.transports,
    appBaseUrl: deps.appBaseUrl,
    resolveDestination: (c) => deps.store.resolveDestination(c),
  });
  switch (outcome.kind) {
    case "sent":
      await deps.store.markSent(
        claim,
        outcome.vendorMessageId,
        outcome.endpointId,
        outcome.settlesOnAcceptance,
        now,
      );
      return { sent: 1 };
    case "retry":
      await deps.store.scheduleRetry(
        claim,
        outcome.reason,
        outcome.delayMs,
        outcome.endpointId,
        now,
      );
      return { retried: 1 };
    case "failed":
      await deps.store.markFailed(claim, outcome.reason, outcome.endpointId, now);
      return { failed: 1 };
  }
}

async function sweepOrg(
  deps: DeliverySweepDeps,
  organizationId: string,
  channel: OutOfBandTransportChannel,
  now: Date,
): Promise<DeliverySweepResult> {
  const claims = await deps.store.claimBatch(
    organizationId,
    channel,
    DELIVERY_SWEEP_BATCH_LIMIT,
    now,
    DELIVERY_CLAIM_LEASE_MS,
  );
  let result: DeliverySweepResult = add(EMPTY, { claimed: claims.length });
  for (const claim of claims) {
    try {
      result = add(result, await dispatchOne(deps, claim, now));
    } catch (error) {
      // The lease on this row lapses and the next tick retries it; the rest of the batch still goes out.
      deps.onError?.({ organizationId, deliveryId: claim.deliveryId }, error);
      result = add(result, { errors: 1 });
    }
  }
  return result;
}

/** Run one sweep tick for `channel` over every active org. */
export async function runDeliverySweep(
  deps: DeliverySweepDeps,
  channel: OutOfBandTransportChannel,
): Promise<DeliverySweepResult> {
  const now = (deps.now ?? (() => new Date()))();
  const orgs = await deps.activeOrgs.listActiveOrgs();
  let total = EMPTY;
  for (const { organizationId } of orgs) {
    try {
      total = add(total, await sweepOrg(deps, organizationId, channel, now));
    } catch (error) {
      deps.onError?.({ organizationId }, error);
      total = add(total, { errors: 1 });
    }
  }
  return total;
}
