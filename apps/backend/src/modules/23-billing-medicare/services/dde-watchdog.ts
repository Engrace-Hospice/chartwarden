// apps/backend/src/modules/23-billing-medicare/services/dde-watchdog.ts — the NOE / NOTR window-watch crons' second
// duty (ADR-0052 "Consequences"): when a notice is at risk of missing its 5-day window, queue the DDE work for it.
//
// Idempotent and never duplicating: the watchdog files at most ONE item per (notice, type) for the notice's whole
// life. It skips when ANY item of that type already exists on the notice (open, finished or cancelled), so a
// cancelled item does not respawn on the next 30-minute tick, and the partial unique index
// `dde_work_item_open_subject_uq` backstops a race with a manual create. Runs on the cron's org-scoped tx (system
// actor, `source = 'watchdog'`, no membership). Payloads carry ids, type and the deadline only.
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
      if (await items.existsForSubject(subjectKind, notice.noticeId, notice.itemType)) {
        return { created: false };
      }
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
        detail: { source: "watchdog" },
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
          },
        });
      }
      return { created: true };
    },
  };
}
