// apps/backend/src/modules/36-messaging/review/binding.ts - WP 3.8: the composition-root binding for the lifecycle review
// queue. The queue is gated on the existing tenant flag `messaging.tasks` (read through the platform's FeatureFlagReaderPort,
// cached a few seconds per org like tasks and handoffs); the CONSUMER queues regardless of the flag (a safety record, like
// handoff expiry), the routes and the alerts honour it. Everything is built from ports so the routes and the consumer share
// one service and one store.
import type { DbClient } from "@chartwarden/db";
import type { PatientLabelPort } from "../handoffs/handoff-dto";
import type { HintOutboxPort } from "../message-hint-events";
import { isActiveMessagingUser } from "../messaging-route-service-db";
import type { Part2ChannelGate } from "../part2-channel-gate";
import { cacheFlagRead } from "../presence/binding";
import { TASKS_FLAG_KEY } from "../tasks/task-service";
import { type TaskStore, createDbTaskStore } from "../tasks/task-store-db";
import { type LifecycleTrigger, queueLifecycleReviewForPatient } from "./lifecycle-queue";
import { type ReviewService, createReviewService } from "./review-service";
import { type ReviewStore, createDbReviewStore } from "./review-store-db";

export interface ReviewBindingInput {
  readonly db: DbClient;
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  readonly outbox?: HintOutboxPort | undefined;
  readonly messaging: {
    canViewChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;
  };
  readonly isActiveUser: (orgId: string, userId: string) => Promise<boolean>;
  readonly part2Gate: Part2ChannelGate;
  readonly patientLabels: PatientLabelPort;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  readonly store?: ReviewStore;
  readonly taskStore?: TaskStore;
  readonly now?: () => Date;
}

export interface ReviewBinding {
  /** The `messaging.tasks` tenant flag. Routes answer uniformly 404 (list: enabled:false) when it is off. */
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: ReviewService;
  /** Consumer port: queue the patient's open care-team tasks; returns who holds an OPEN review of this trigger. */
  readonly queueForPatient: (
    orgId: string,
    trigger: LifecycleTrigger,
  ) => Promise<{ openSubjects: string[] }>;
}

export function buildReviewBinding(input: ReviewBindingInput): ReviewBinding {
  const { db, flags } = input;
  const store = input.store ?? createDbReviewStore();
  const taskStore = input.taskStore ?? createDbTaskStore(db);
  return {
    isEnabled: cacheFlagRead(async (organizationId) =>
      flags ? (await flags.forOrg(organizationId))[TASKS_FLAG_KEY] === true : false,
    ),
    service: createReviewService({
      db,
      outbox: input.outbox,
      store,
      taskStore,
      isEligible: async (orgId, userId, channelId) =>
        (await input.isActiveUser(orgId, userId)) &&
        (await input.messaging.canViewChannel(orgId, userId, channelId)),
      isActiveInTx: (tx, orgId, userId) =>
        isActiveMessagingUser(
          tx as unknown as Parameters<typeof isActiveMessagingUser>[0],
          orgId,
          userId,
        ),
      part2Gate: input.part2Gate,
      patientLabels: input.patientLabels,
      displayName: input.displayName,
      ...(input.now ? { now: input.now } : {}),
    }),
    queueForPatient: (orgId, trigger) =>
      queueLifecycleReviewForPatient({ db, store }, orgId, trigger),
  };
}
