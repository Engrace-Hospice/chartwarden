// apps/backend/src/modules/36-messaging/care-team-sync/binding.ts - WP 3.9: the composition-root port for the
// channel-membership-sync consumer. Built from ports so the root only supplies the live seams.
import type { DbClient } from "@chartwarden/db";
import type { AlertEmitter } from "@chartwarden/messaging";
import type { ReviewWarn } from "../review/review-alerts";
import { type ReviewStore, createDbReviewStore } from "../review/review-store-db";
import { type TaskStore, createDbTaskStore } from "../tasks/task-store-db";
import { routeRemovedClinicianForReview } from "./care-team-review";

export interface CareTeamReviewBindingInput {
  readonly db: DbClient;
  /** M5 CareTeamProvider.careTeamMembers (the live roster). */
  readonly careTeamMembers: (orgId: string, patientId: string) => Promise<readonly string[]>;
  readonly alerts: AlertEmitter;
  /** The `messaging.tasks` flag (the review binding's own). */
  readonly isFlagOn: (orgId: string) => Promise<boolean>;
  readonly warn?: ReviewWarn | undefined;
  readonly taskStore?: TaskStore;
  readonly store?: ReviewStore;
}

export function buildCareTeamReviewRouter(
  input: CareTeamReviewBindingInput,
): (
  orgId: string,
  patientId: string,
  clinicianUserId: string,
  eventId: string,
) => Promise<unknown> {
  const deps = {
    db: input.db,
    careTeamMembers: input.careTeamMembers,
    taskStore: input.taskStore ?? createDbTaskStore(input.db),
    store: input.store ?? createDbReviewStore(),
    alerts: input.alerts,
    isFlagOn: input.isFlagOn,
    warn: input.warn,
  };
  return (orgId, patientId, clinicianUserId, eventId) =>
    routeRemovedClinicianForReview(deps, { orgId, patientId, clinicianUserId, eventId });
}
