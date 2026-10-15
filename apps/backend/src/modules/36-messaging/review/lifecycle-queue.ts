// apps/backend/src/modules/36-messaging/review/lifecycle-queue.ts - WP 3.8: queue a patient's open care-team tasks for
// supervisor review when the patient is discharged, dies or transfers out (ADR-0065 D3).
//
// Runs as the system actor in ONE org-scoped transaction (a relay tick is not a request). Only ACTIVE tasks on a
// `care_team` channel are queued - a bereavement channel is a different kind and is never touched. The insert is
// idempotent, and `openSubjects` is re-read AFTER it, so a redelivered trigger still reports who is affected (the alert
// dedupe absorbs the repeat) instead of going quiet.
import type { DbClient } from "@wardenx/db";
import { REVIEW_QUEUE_BATCH } from "@wardenx/messaging";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import type { ReviewLifecycleCause } from "@wardenx/types";
import type { Tx } from "../messaging-write-core";
import type { ReviewStore } from "./review-store-db";

export const LIFECYCLE_SOURCE = "patient_lifecycle" as const;

export interface LifecycleQueueDeps {
  readonly db: DbClient;
  readonly store: ReviewStore;
}

export interface LifecycleTrigger {
  readonly cause: ReviewLifecycleCause;
  readonly triggerRef: string;
  readonly patientId: string;
}

export async function queueLifecycleReviewForPatient(
  deps: LifecycleQueueDeps,
  orgId: string,
  trigger: LifecycleTrigger,
): Promise<{ openSubjects: string[] }> {
  return withOrgContext(deps.db, systemOrgContext(orgId), async (scoped) => {
    const tx = scoped as unknown as Tx;
    let afterId: string | null = null;
    for (;;) {
      const page = await deps.store.activeCareTeamTasks(
        tx,
        orgId,
        trigger.patientId,
        afterId,
        REVIEW_QUEUE_BATCH,
      );
      if (page.length === 0) break;
      await deps.store.queueItems(tx, {
        orgId,
        source: LIFECYCLE_SOURCE,
        cause: trigger.cause,
        triggerRef: trigger.triggerRef,
        patientId: trigger.patientId,
        items: page.map((t) => ({
          itemKind: "task",
          itemId: t.taskId,
          subjectUserId: t.assigneeId,
        })),
      });
      afterId = page[page.length - 1]?.taskId ?? null;
      if (page.length < REVIEW_QUEUE_BATCH) break;
    }
    const openSubjects = await deps.store.openSubjectsForTrigger(
      tx,
      orgId,
      LIFECYCLE_SOURCE,
      trigger.triggerRef,
    );
    return { openSubjects };
  });
}
