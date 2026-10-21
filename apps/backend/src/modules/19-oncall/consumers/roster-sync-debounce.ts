import type { DbClient } from "@chartwarden/db";
// apps/backend/src/modules/19-oncall/consumers/roster-sync-debounce.ts — the live `m17.visit.assigned`
// outbox consumer for the §4.5 path 1 / §4.8 `m19.shift-sync.debounced` roster sync (m19
// `handlers-unbound` group, #248; F-155's own finding, now built).
//
// THIS CONSUMER DOES NOT RECONCILE. Its one job is to bump the org's `on_call_roster_sync_queue` debounce
// window forward (`../jobs/repository.ts`'s `triggerDebounce`) — the actual reconciliation runs on the
// separate `m19.shift-sync.debounced` drain tick (`../jobs/worker.ts`), once 30 seconds of quiet have
// passed. That split is what makes a scheduling burst of fifty assignments in the same org collapse onto
// ONE reconciliation pass rather than fifty, each re-reading M17's whole roster.
//
// `m17.visit.assigned`'s catalogued `declaredConsumers` already names `m19` (`events-by-m17.ts`) and
// `packages/types/src/oncall.ts`'s `M19_SUBSCRIBED_EVENT_NAMES` already names this event — both were true
// before this file existed; what was missing was a factory yielding a live binding at all.
//
// NO PAYLOAD READ, DELIBERATELY — the same "no purpose filter" reasoning `../roster/shift-sync.ts`'s own
// `decideRosterSyncTrigger` header already states in full: M17's `VisitPurpose` enum has no `on_call_*`
// member for a filter to key on, and the debounce key that decider computes
// (`m19.shift-sync:${organizationId}`) is a function of `event.organizationId` alone. This consumer's one
// real decision — which org to debounce — is therefore already fully determined by the outbox envelope,
// so `decideRosterSyncTrigger` is not called here: calling it and discarding its BullMQ-jobId-shaped
// output would be dead code, not an honored decision (its rule — react to every assignment, unfiltered —
// is already what "one debounce row per org, regardless of payload" implements).
import { withOrgContext } from "@chartwarden/tenancy";
import type { OrgId } from "@chartwarden/types";
import type { OutboxConsumerBinding } from "../../../bootstrap/outbox-dispatcher";
import { M19_ROSTER_SYNC_DEBOUNCE_WINDOW_MS } from "../jobs/index";
import { OnCallRosterSyncQueueRepository } from "../jobs/repository";

/** §3.3 — a machine-driven debounce trigger names no acting membership. */
const CONSUMER_USER_ID = "";

export interface RosterSyncDebounceConsumerDeps {
  readonly db: DbClient;
  readonly now?: () => Date;
  readonly debounceWindowMs?: number;
}

/** The live `m17.visit.assigned` → debounce-bump binding. */
export function buildOncallRosterSyncDebounceConsumer(
  deps: RosterSyncDebounceConsumerDeps,
): OutboxConsumerBinding {
  const clock = deps.now ?? (() => new Date());
  const debounceWindowMs = deps.debounceWindowMs ?? M19_ROSTER_SYNC_DEBOUNCE_WINDOW_MS;

  return {
    consumerName: "m19.roster-sync-debounce",
    consumerModule: "m19",
    eventTypes: ["m17.visit.assigned"],
    async handle(event) {
      const organizationId = event.organizationId as OrgId;
      const at = clock();

      await withOrgContext(
        deps.db,
        { organizationId, userId: CONSUMER_USER_ID },
        async (handle) => {
          const repo = new OnCallRosterSyncQueueRepository(handle as DbClient);
          await repo.triggerDebounce({
            organizationId,
            triggeringEventOutboxId: event.id,
            now: at,
            debounceWindowMs,
          });
        },
      );
    },
  };
}
