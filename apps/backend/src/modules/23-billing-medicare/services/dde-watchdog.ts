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
//
// SECOND TRIGGER (ADR-0052 "Consequences", RTP follow-up): `ensureClaimRtpItem` queues ONE `rtp_correction` item for a
// claim the MAC rejected at the payer stage (a 277CA rejection, i.e. the claim is `ack_rejected`). It carries ids only:
// no MBI, no payer text, no rejection codes in the row (the codes ride in the PHI-free history detail). The deadline is
// NULL: the ADR gives a claim-level RTP no filing deadline (the 36-month figure is how long FISS holds a returned
// claim, not a window WardenX tracks). Idempotent through the same open-item unique index as the notices: a replay or a
// second rejection while an item is open creates nothing.
//
// Runs on the cron's org-scoped tx (system actor, `source = 'watchdog'`, no membership). Payloads carry ids, type and
// the deadline only.
import { repositories } from "@wardenx/billing";
import type { BillingTx, WriteOutboxPort } from "./claim-state-service";

/** Priority 1 (high): a notice already in its filing window outranks routine claim work. */
const WATCHDOG_PRIORITY = 1;
/** Priority 2 (normal): an RTP correction is routine claim work with no filing deadline of its own. */
const RTP_PRIORITY = 2;

export interface DdeNoticeAtRisk {
  readonly organizationId: string;
  readonly itemType: "noe" | "notr";
  readonly noticeId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  /** The notice's `window_target_at` (`YYYY-MM-DD`). */
  readonly deadlineAt: string;
}

/** A claim the MAC rejected (277CA, payer stage): the facts the RTP item needs, ids and codes only. */
export interface DdeClaimRejected {
  readonly organizationId: string;
  readonly claimId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  /** The `claim_acknowledgment` row that recorded the rejection (history detail only). */
  readonly acknowledgmentId: string;
  /** Sanitised X12 status codes (`A7:21`); NOT FISS RTP reason codes, so they never fill `rtp_reason_code`. */
  readonly rejectionCodes: readonly string[];
}

/** What the window-watch crons and the claim-ack cron call. */
export interface DdeWatchdogPort {
  ensureNoticeItem(tx: BillingTx, notice: DdeNoticeAtRisk): Promise<{ readonly created: boolean }>;
  ensureClaimRtpItem(
    tx: BillingTx,
    claim: DdeClaimRejected,
  ): Promise<{ readonly created: boolean }>;
}

export function buildDdeWatchdog(
  ports: { readonly outbox?: WriteOutboxPort } = {},
): DdeWatchdogPort {
  /** The append-only `create` history row and the `m23.dde_item.created` event for a freshly inserted item. */
  const recordCreated = async (
    tx: BillingTx,
    created: repositories.DdeWorkItemRecord,
    detail: Record<string, string | number | null>,
  ): Promise<void> => {
    await new repositories.DdeWorkEventRepository(tx).append({
      organizationId: created.organizationId,
      workItemId: created.id,
      event: "create",
      fromState: null,
      toState: "queued",
      attemptNumber: 1,
      actorMembershipId: null,
      actorKind: "system",
      detail,
    });
    if (!ports.outbox) return;
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
  };

  return {
    async ensureClaimRtpItem(tx, claim) {
      const created = await new repositories.DdeWorkItemRepository(tx).insertIfNoOpen({
        organizationId: claim.organizationId,
        providerEntityId: claim.providerEntityId,
        patientId: claim.patientId,
        itemType: "rtp_correction",
        subjectKind: "claim",
        subjectId: claim.claimId,
        priority: RTP_PRIORITY,
        source: "watchdog",
        deadlineAt: null,
        respawnedFromId: null,
      });
      if (!created) return { created: false };
      await recordCreated(tx, created, {
        source: "watchdog",
        trigger: "claim_rejected_277ca",
        acknowledgmentId: claim.acknowledgmentId,
        rejectionCodes: claim.rejectionCodes.join(","),
      });
      return { created: true };
    },

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
      await recordCreated(
        tx,
        created,
        respawnedFromId ? { source: "watchdog", respawnedFromId } : { source: "watchdog" },
      );
      return { created: true };
    },
  };
}
