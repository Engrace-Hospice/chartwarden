// apps/backend/src/modules/36-messaging/care-team-sync/care-team-review.ts - WP 3.9 (ADR-0066): a clinician taken off a
// patient's care team keeps no channel access (GAP-104 sync + the live roster check), and their OPEN care-team tasks for
// that patient are queued for a supervisor to reassign or close. Nothing is reassigned, closed or flagged here - the
// clinician is still employed and the task is still real work. TASKS ONLY: an offered handoff keeps ADR-0062's guarantees
// (the sender stays accountable until acceptance; an unaccepted offer alerts supervisors at expiry).
//
// The roster is read OUTSIDE any transaction (a seam read inside one starves the pool); a seam failure rethrows so the relay
// retries. The queue write is 3.8's own idempotent `queueItems` (its unique indexes also dedupe against a lifecycle review
// of the same task). The trigger reference is the outbox event id: the payload has no assignment id and the id is stable
// across redelivery. The removed clinician is NOT alerted (the 3.8 wording says the patient left care, which is false here).
// Logs carry counts only.
import type { DbClient } from "@chartwarden/db";
import {
  type AlertEmitter,
  careTeamTriggerRef,
  reviewItemBatches,
  shouldRoute,
} from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import type { Tx } from "../messaging-write-core";
import { type ReviewWarn, emitReviewQueuedAlert } from "../review/review-alerts";
import type { ReviewStore } from "../review/review-store-db";
import type { TaskStore } from "../tasks/task-store-db";

export const CARE_TEAM_CHANGE_SOURCE = "care_team_change" as const;

export interface CareTeamReviewDeps {
  readonly db: DbClient;
  /** M5 CareTeamProvider.careTeamMembers; a throw is rethrown (retry). */
  readonly careTeamMembers: (orgId: string, patientId: string) => Promise<readonly string[]>;
  readonly taskStore: Pick<TaskStore, "activeTaskIdsForAssigneeAndPatient">;
  readonly store: Pick<ReviewStore, "queueItems" | "openSubjectsForTrigger">;
  readonly alerts: AlertEmitter;
  /** The `messaging.tasks` flag: alerts only; rows are queued regardless (a safety record, as in 3.8). */
  readonly isFlagOn: (orgId: string) => Promise<boolean>;
  readonly warn?: ReviewWarn | undefined;
}

export interface CareTeamRemoval {
  readonly orgId: string;
  readonly patientId: string;
  readonly clinicianUserId: string;
  /** The outbox event id of m5.patient.assignment_ended. */
  readonly eventId: string;
}

export async function routeRemovedClinicianForReview(
  deps: CareTeamReviewDeps,
  r: CareTeamRemoval,
): Promise<{ routed: number; skipped?: "still_on_team" | "nothing_open" }> {
  const roster = await deps.careTeamMembers(r.orgId, r.patientId);
  if (!shouldRoute(roster, r.clinicianUserId)) return { routed: 0, skipped: "still_on_team" };

  const open = await deps.taskStore.activeTaskIdsForAssigneeAndPatient(
    r.orgId,
    r.clinicianUserId,
    r.patientId,
  );
  const batches = reviewItemBatches(open);
  if (batches.length === 0) return { routed: 0, skipped: "nothing_open" };

  const triggerRef = careTeamTriggerRef(r.eventId);
  const { inserted, hasOpen } = await withOrgContext(
    deps.db,
    systemOrgContext(r.orgId),
    async (scoped) => {
      const tx = scoped as unknown as Tx;
      let n = 0;
      // Every task is queued, a batch at a time, in the one transaction (the unique indexes make a re-run a no-op).
      for (const batch of batches) {
        const { inserted: added } = await deps.store.queueItems(tx, {
          orgId: r.orgId,
          source: CARE_TEAM_CHANGE_SOURCE,
          cause: "care_team_removed",
          triggerRef,
          patientId: r.patientId,
          items: batch.map((itemId) => ({
            itemKind: "task",
            itemId,
            subjectUserId: r.clinicianUserId,
          })),
        });
        n += added;
      }
      const subjects = await deps.store.openSubjectsForTrigger(
        tx,
        r.orgId,
        CARE_TEAM_CHANGE_SOURCE,
        triggerRef,
      );
      return { inserted: n, hasOpen: subjects.length > 0 };
    },
  );

  // Re-read after the insert so a redelivery whose alert failed the first time still alerts (the dedupe absorbs repeats).
  // A flag-read error propagates so the relay retries (rows are idempotent; the alert is re-sent on the retry).
  if (hasOpen && (await deps.isFlagOn(r.orgId))) {
    await emitReviewQueuedAlert({ alerts: deps.alerts, warn: deps.warn }, r.orgId, {
      source: CARE_TEAM_CHANGE_SOURCE,
      triggerRef,
    });
  }
  return { routed: inserted };
}
