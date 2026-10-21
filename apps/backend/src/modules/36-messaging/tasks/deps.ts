// apps/backend/src/modules/36-messaging/tasks/deps.ts - WP 3.4: the composition-root factory the boot calls once.
// It supplies the two ports the S1 binding leaves to the caller (the message facts and the display name) and returns
// the binding: `isEnabled` + `service` are the route deps; `reassignForLeaver` is the access-revocation consumer's
// `reassignOwnedItems`. One factory, so the routes and the revocation consumer share one service and one store.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import { createMentionActorNameResolver } from "../mention-non-member-service-db";
import { type TaskBinding, type TaskBindingInput, buildTaskBinding } from "./binding";
import type { MessageFacts } from "./task-service";

const MSG = schema.messages;
const CH = schema.channels;

/** Facts about one message in one channel: live (not tombstoned) and the channel's kind and subject. */
export function createDbMessageFactsLookup(
  db: DbClient,
): (orgId: string, channelId: string, messageId: string) => Promise<MessageFacts | null> {
  return (orgId, channelId, messageId) =>
    withOrgContext(db, systemOrgContext(orgId), async (tx) => {
      const [row] = await tx
        .select({
          status: MSG.status,
          channelKind: CH.channelKind,
          subjectId: CH.subjectId,
          isArchived: CH.isArchived,
        })
        .from(MSG)
        .innerJoin(CH, and(eq(CH.organizationId, MSG.organizationId), eq(CH.id, MSG.channelId)))
        .where(
          and(eq(MSG.organizationId, orgId), eq(MSG.channelId, channelId), eq(MSG.id, messageId)),
        )
        .limit(1);
      if (!row) return null;
      return {
        live: row.status !== "deleted",
        archived: row.isArchived,
        channelKind: row.channelKind,
        subjectId: row.subjectId,
      };
    });
}

export type TaskDepsInput = Omit<TaskBindingInput, "messageLookup" | "displayName">;

export function buildTaskDeps(input: TaskDepsInput): TaskBinding {
  return buildTaskBinding({
    ...input,
    messageLookup: createDbMessageFactsLookup(input.db),
    displayName: createMentionActorNameResolver(input.db),
  });
}
