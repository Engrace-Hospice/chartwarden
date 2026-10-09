// apps/backend/src/modules/23-billing-medicare/services/dde-watchdog.ts — the NOE / NOTR window-watch crons' second
// duty (ADR-0052 "Consequences"): when a notice is at risk of missing its 5-day window, queue the DDE work for it.
//
// Idempotent and never duplicating. Per notice and item type, `watchdogAction` decides (ADR-0052 D4):
//   - never had an item        -> create one;
//   - latest item `closed`, no MAC acceptance, closure not yet respawned, no open item -> RESPAWN one, linked to the
//     closed item (`respawned_from_id`). Each closed item can be followed by at most one respawn, ever, enforced by the
//     unique index `dde_work_item_respawn_once_uq`, so a tick cannot loop and two concurrent ticks create one;
//   - anything else (an open item, a `cancelled` latest item, a closure that followed an accepted outcome, an already
//     respawned closure) -> nothing. A cancelled item is an explicit human decision and never respawns.
// Runs on the cron's org-scoped tx (system actor, `source = 'watchdog'`, no membership). Payloads carry ids, type and
// the deadline only.
import { repositories } from "@wardenx/billing";
import type { BillingTx, WriteOutboxPort } from "./claim-state-service";

/** Priority 1 (high): a notice already in its filing window outranks routine claim work. */
const WATCHDOG_PRIORITY = 1;

export interface DdeNoticeAtRisk {
  readonly organizationId: string;
  readonly itemType: "noe" | "notr";
  readonly noticeId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  /** The notice's `window_target_at` (`YYYY-MM-DD`). */
  readonly deadlineAt: string;
}

/** What the window-watch crons call for each at-risk notice. */
export interface DdeWatchdogPort {
  ensureNoticeItem(tx: BillingTx, notice: DdeNoticeAtRisk): Promise<{ readonly created: boolean }>;
}

export function buildDdeWatchdog(
  ports: { readonly outbox?: WriteOutboxPort } = {},
): DdeWatchdogPort {
  return {
    async ensureNoticeItem(tx, notice) {
      const subjectKind = notice.itemType === "noe" ? "noe_record" : "notr_record";
      const items = new repositories.DdeWorkItemRepository(tx);
      const action = await items.watchdogAction(subjectKind, notice.noticeId, notice.itemType);
      if (action.kind === "none") return { created: false };
      const respawnedFromId = action.kind === "respawn" ? action.fromId : null;
      const created = await items.insertIfNoOpen({
        organizationId: notice.organizationId,
        providerEntityId: notice.providerEntityId,
        patientId: notice.patientId,
        itemType: notice.itemType,
        subjectKind,
        subjectId: notice.noticeId,
        priority: WATCHDOG_PRIORITY,
        source: "watchdog",
        deadlineAt: notice.deadlineAt,
        respawnedFromId,
      });
      if (!created) return { created: false };
      await new repositories.DdeWorkEventRepository(tx).append({
        organizationId: created.organizationId,
        workItemId: created.id,
        event: "create",
        fromState: null,
        toState: "queued",
        attemptNumber: 1,
        actorMembershipId: null,
        actorKind: "system",
        detail: respawnedFromId ? { source: "watchdog", respawnedFromId } : { source: "watchdog" },
      });
      if (ports.outbox) {
        await ports.outbox.publish(tx, {
          eventName: "m23.dde_item.created",
          organizationId: created.organizationId,
          aggregateKind: "dde_work_item",
          aggregateId: created.id,
          payload: {
            ddeItemId: created.id,
            itemType: created.itemType,
            subjectKind: created.subjectKind,
            subjectId: created.subjectId,
            providerEntityId: created.providerEntityId,
            source: created.source,
            deadlineAt: created.deadlineAt,
            respawnedFromId: created.respawnedFromId,
          },
        });
      }
      return { created: true };
    },
  };
}
