// apps/backend/src/modules/36-messaging/idg/idg-discussion-store-db.ts - WP 3.6: the READ-ONLY list of a care-team
// channel's IDG discussions.
//
// An IDG discussion is not a row of its own: it is a ROOT message (not a reply, not deleted) of a care_team channel that
// carries at least one `idg_meeting` clinical link. Nothing here writes. The rows are hydrated by the same function the
// pins and the channel history use, so the DTO (decrypted body, clinicalLinks, replyCount) is identical.
import { type DbClient, schema } from "@wardenx/db";
import type { ResolvedMessage } from "@wardenx/messaging";
import { withOrgContext } from "@wardenx/tenancy";
import { NotFoundError } from "@wardenx/types";
import { and, desc, eq, sql } from "drizzle-orm";
import { MESSAGE_ROW_COLUMNS, hydrateMessages } from "../messaging-message-hydration";
import { type MessageBodyCipher, createMessageBodyCipher } from "../messaging-write-core";

const CH = schema.channels;
const MSG = schema.messages;
const USER = schema.users;

export interface IdgDiscussionList {
  readonly discussions: readonly ResolvedMessage[];
  readonly patientId: string | null;
}

export interface IdgDiscussionStore {
  list(
    organizationId: string,
    input: { userId: string; channelId: string; limit: number },
  ): Promise<IdgDiscussionList>;
}

export function createDbIdgDiscussionStore(deps: {
  readonly db: DbClient;
  readonly cipher?: MessageBodyCipher;
  readonly warn?: (message: string, context: Record<string, string>) => void;
}): IdgDiscussionStore {
  const cipher = deps.cipher ?? createMessageBodyCipher();
  return {
    async list(orgId, input) {
      return withOrgContext(
        deps.db,
        { organizationId: orgId, userId: input.userId },
        async (tx): Promise<IdgDiscussionList> => {
          const [channel] = await tx
            .select({ kind: CH.channelKind, subjectId: CH.subjectId })
            .from(CH)
            .where(and(eq(CH.organizationId, orgId), eq(CH.id, input.channelId)))
            .limit(1);
          if (!channel) throw new NotFoundError("channel", input.channelId);
          // Only a care-team channel can hold a patient's IDG discussion.
          if (channel.kind !== "care_team") return { discussions: [], patientId: null };
          // EXISTS, not a join: a message with two idg links is still one row. Uses clinical_link_unique_target.
          const rows = await tx
            .select(MESSAGE_ROW_COLUMNS)
            .from(MSG)
            .leftJoin(USER, eq(USER.id, MSG.authorUserId))
            .where(
              and(
                eq(MSG.organizationId, orgId),
                eq(MSG.channelId, input.channelId),
                sql`${MSG.parentMessageId} IS NULL`,
                sql`${MSG.status} <> 'deleted'`,
                sql`EXISTS (SELECT 1 FROM clinical_link l WHERE l.organization_id = ${MSG.organizationId} AND l.message_id = ${MSG.id} AND l.link_kind = 'idg_meeting')`,
              ),
            )
            .orderBy(desc(MSG.createdAt), desc(MSG.id))
            .limit(input.limit);
          const discussions = await hydrateMessages(
            tx,
            {
              orgId,
              viewerUserId: input.userId,
              channelKind: channel.kind,
              cipher,
              warn: deps.warn,
            },
            rows,
            input.channelId,
          );
          return { discussions, patientId: channel.subjectId };
        },
      );
    },
  };
}
