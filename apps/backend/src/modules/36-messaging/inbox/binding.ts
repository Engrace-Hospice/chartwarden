// apps/backend/src/modules/36-messaging/inbox/binding.ts - WP 6.1 (ADR-0091): wires the smart inbox over the services M36 already built.
// Nothing here queries a table: the urgent source is the ADR-0076 service narrowed to the caller, tasks and handoffs are their own
// services' list calls, and the conversation counts are the channel list's. Each source honours its OWN tenant flag (tasks off => no task
// rows), so the inbox can never show what the owning screen would hide.
import { ACK_QUEUE_LIMIT_MAX, SMART_INBOX_FLAG_KEY } from "@chartwarden/types";
import type { UnacknowledgedService } from "../ack-requests/unacknowledged-service";
import { cacheFlagRead } from "../presence/binding";
import type { HandoffRouteDeps } from "../routes/handoff-routes";
import type { TaskRouteDeps } from "../routes/task-routes";
import {
  type InboxChannel,
  type SmartInboxService,
  createSmartInboxService,
} from "./inbox-service";

/** Rows asked of the task and handoff lists: their own maximum page (100); the inbox ranks, it does not page them. */
const SOURCE_LIMIT = 100;

export interface SmartInboxBindingInput {
  /** The ops flag `messaging.smart_inbox` (tenant row wins; absent = off). Absent => the feature is off everywhere. */
  readonly isEnabled?: ((organizationId: string) => Promise<boolean>) | undefined;
  readonly unacknowledged: UnacknowledgedService;
  readonly tasks?: TaskRouteDeps | undefined;
  readonly handoffs?: HandoffRouteDeps | undefined;
  readonly listChannels: (orgId: string, userId: string) => Promise<readonly InboxChannel[]>;
  readonly now?: (() => Date) | undefined;
}

/** The ops flag `messaging.smart_inbox` over the platform reader (absent = off), cached a few seconds per org like its siblings. */
export function smartInboxFlag(
  flags: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined,
): (organizationId: string) => Promise<boolean> {
  return cacheFlagRead(async (organizationId) =>
    flags ? (await flags.forOrg(organizationId))[SMART_INBOX_FLAG_KEY] === true : false,
  );
}

export function buildSmartInboxService(input: SmartInboxBindingInput): SmartInboxService {
  return createSmartInboxService({
    isEnabled: input.isEnabled ?? (async () => false),
    urgentAcks: async (actor) => {
      const page = await input.unacknowledged.list(actor, {
        assignedUserId: actor.userId,
        limit: ACK_QUEUE_LIMIT_MAX,
      });
      return { items: page.items, complete: page.complete };
    },
    handoffs: async (actor) => {
      if (!input.handoffs || !(await input.handoffs.isEnabled(actor.orgId).catch(() => false))) {
        return [];
      }
      return input.handoffs.service.list(actor, {
        scope: "incoming",
        state: "active",
        limit: SOURCE_LIMIT,
      });
    },
    tasks: async (actor) => {
      if (!input.tasks || !(await input.tasks.isEnabled(actor.orgId).catch(() => false))) return [];
      return input.tasks.service.list(actor, {
        scope: "assigned",
        state: "active",
        limit: SOURCE_LIMIT,
      });
    },
    channels: (actor) => input.listChannels(actor.orgId, actor.userId),
    ...(input.now ? { now: input.now } : {}),
  });
}
