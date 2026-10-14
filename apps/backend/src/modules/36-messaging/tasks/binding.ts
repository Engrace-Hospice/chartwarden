// apps/backend/src/modules/36-messaging/tasks/binding.ts - WP 3.4: the composition-root binding for communication tasks.
//
// The tenant flag `messaging.tasks` is read through the platform's FeatureFlagReaderPort (tenant row wins; absent = off,
// a kill switch = off), cached a few seconds per org like clinical links and SBAR. The care-team seam is read lazily and
// only on the offboarding path. Everything is built from ports so the routes (S2) and the revocation consumer share one
// service and one store.
import type { DbClient } from "@wardenx/db";
import type { CareTeamProvider } from "@wardenx/types";
import { getSeam } from "../../../bootstrap/index";
import type { HintOutboxPort } from "../message-hint-events";
import { cacheFlagRead } from "../presence/binding";
import { type ReassignSummary, reassignTasksForLeaver } from "./task-reassign";
import {
  type MessageFacts,
  TASKS_FLAG_KEY,
  type TaskService,
  createTaskService,
} from "./task-service";
import { createDbTaskStore } from "./task-store-db";

export interface TaskBindingInput {
  readonly db: DbClient;
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  readonly outbox?: HintOutboxPort | undefined;
  readonly messaging: {
    canViewChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;
  };
  readonly messageLookup: (
    orgId: string,
    channelId: string,
    messageId: string,
  ) => Promise<MessageFacts | null>;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  /** Defaults to the CareTeamProvider seam. */
  readonly careTeamMembers?: (orgId: string, patientId: string) => Promise<readonly string[]>;
  readonly now?: () => Date;
}

export interface TaskBinding {
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: TaskService;
  /** Offboarding: wire as the access-revocation consumer's `reassignOwnedItems`. */
  readonly reassignForLeaver: (orgId: string, leaverUserId: string) => Promise<ReassignSummary>;
}

const seamCareTeamMembers = async (orgId: string, patientId: string): Promise<readonly string[]> =>
  (getSeam("CareTeamProvider") as CareTeamProvider).careTeamMembers({
    organizationId: orgId,
    patientId,
  });

export function buildTaskBinding(input: TaskBindingInput): TaskBinding {
  const { db, flags, outbox, messaging } = input;
  const store = createDbTaskStore(db);
  const clock = input.now ? { now: input.now } : {};
  return {
    isEnabled: cacheFlagRead(async (organizationId) =>
      flags ? (await flags.forOrg(organizationId))[TASKS_FLAG_KEY] === true : false,
    ),
    service: createTaskService({
      db,
      outbox,
      messaging,
      messageLookup: input.messageLookup,
      displayName: input.displayName,
      store,
      ...clock,
    }),
    reassignForLeaver: (orgId, leaverUserId) =>
      reassignTasksForLeaver(
        {
          db,
          outbox,
          store,
          isEligible: (org, userId, channelId) => messaging.canViewChannel(org, userId, channelId),
          careTeamMembers: input.careTeamMembers ?? seamCareTeamMembers,
          ...clock,
        },
        orgId,
        leaverUserId,
      ),
  };
}
