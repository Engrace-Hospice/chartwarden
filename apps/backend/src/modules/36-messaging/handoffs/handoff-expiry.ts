// apps/backend/src/modules/36-messaging/handoffs/handoff-expiry.ts - WP 3.5: the deadline sweep. A read-time check alone
// would never fire when nobody opens the handoff, so a per-minute tick closes every offered handoff past its POLICY-CAPPED
// deadline: its pending items become `expired` (accountability stays with the sender - nothing moves it) and the sender
// and supervisors are told through `m36.handoff.unaccepted`.
//
// A relay tick is not a request: this is org-explicit (`...ForOrg`) and runs under the system actor. It never reads a
// seam (no patient, visit or refill read). It runs for flag-OFF tenants too - rows exist only if the flag was once on, and
// accountability must never stall on a flag. Each handoff has its own transaction and takes the row FOR UPDATE, so an
// accept racing the tick serialises: the loser sees a closed or changed row. Per-handoff failures are isolated, counted,
// and rethrown after the loop so the queue retries; only the error class name is logged (a driver error can carry data).
import type { DbClient } from "@wardenx/db";
import { effectiveHandoffMinutes, isPastDeadline } from "@wardenx/messaging";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import type { HintOutboxPort } from "../message-hint-events";
import type { Tx } from "../messaging-write-core";
import type { HandoffPolicyStore } from "./handoff-policy-store-db";
import { finishHandoff } from "./handoff-settle";
import type { HandoffStore } from "./handoff-store-db";

export const HANDOFF_EXPIRY_BATCH_SIZE = 100;

export interface ExpiryDeps {
  readonly db: DbClient;
  readonly store: HandoffStore;
  readonly policyStore: HandoffPolicyStore;
  readonly outbox: HintOutboxPort | undefined;
  readonly now?: () => Date;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}

export interface ExpirySummary {
  readonly expired: number;
  readonly failed: number;
}

async function expireOne(
  deps: ExpiryDeps,
  clock: () => Date,
  orgId: string,
  minutes: number,
  handoffId: string,
): Promise<boolean> {
  return withOrgContext(deps.db, systemOrgContext(orgId), async (rawTx) => {
    const tx = rawTx as unknown as Tx;
    const h = await deps.store.getForUpdate(tx, orgId, handoffId);
    // Re-check under the lock: an accept, a cancel or a policy change may have settled it since it was selected.
    if (!h || h.state !== "offered" || !isPastDeadline(h, minutes, clock())) return false;
    await deps.store.resolveItems(tx, {
      orgId,
      handoffId,
      itemIds: null,
      action: "expire",
      now: clock(),
    });
    await finishHandoff({ store: deps.store, outbox: deps.outbox, now: clock }, tx, h, {
      state: "expired",
      reason: "deadline",
      eventType: "closed",
      actor: { kind: "system" },
      unacceptedCause: "expired",
    });
    return true;
  });
}

export async function expireDueHandoffsForOrg(
  deps: ExpiryDeps,
  orgId: string,
): Promise<ExpirySummary> {
  const clock = deps.now ?? (() => new Date());
  const minutes = effectiveHandoffMinutes(await deps.policyStore.read(orgId, ""));
  const seen = new Set<string>();
  const failedIds = new Set<string>();
  let expired = 0;
  for (;;) {
    const ids = await deps.store.dueIds(orgId, minutes, clock(), HANDOFF_EXPIRY_BATCH_SIZE, [
      ...seen,
    ]);
    if (ids.length === 0) break;
    for (const handoffId of ids) {
      seen.add(handoffId);
      try {
        if (await expireOne(deps, clock, orgId, minutes, handoffId)) expired += 1;
      } catch (err) {
        failedIds.add(handoffId);
        deps.warn?.("handoff expiry failed", {
          handoff_id: handoffId,
          error_name: err instanceof Error ? err.name : "NonError",
        });
      }
    }
  }
  if (failedIds.size > 0) throw new Error(`handoff expiry failed for ${failedIds.size} handoff(s)`);
  return { expired, failed: 0 };
}
