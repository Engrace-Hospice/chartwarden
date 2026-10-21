// apps/backend/src/modules/36-messaging/promotions/deps.ts - WP 3.7: the composition-root factory the boot calls once. It
// supplies what the binding leaves to the caller (the message facts, the Part 2 gate and the display-name resolver default
// to the platform's own) and returns the binding: `isEnabled` + `service` are the route deps, `sourceReader` is the seam
// implementation, `stillProposed` / `requestFacts` are the notification consumer's ports. One factory, so every caller
// shares one service and one store.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq, sql } from "drizzle-orm";
import { createMentionActorNameResolver } from "../mention-non-member-service-db";
import { createSeamPart2ChannelGate } from "../part2-channel-gate";
import {
  type PromotionBinding,
  type PromotionBindingInput,
  buildPromotionBinding,
} from "./binding";
import type { PromotionMessageFacts } from "./promotion-service";

const MSG = schema.messages;
const CH = schema.channels;

/** Facts about one message in one channel: live (not deleted, not erased), the channel's kind and subject, who wrote it. */
export function createDbPromotionMessageLookup(
  db: DbClient,
): (orgId: string, channelId: string, messageId: string) => Promise<PromotionMessageFacts | null> {
  return (orgId, channelId, messageId) =>
    withOrgContext(db, systemOrgContext(orgId), async (tx) => {
      const [row] = await tx
        .select({
          status: MSG.status,
          envelope: MSG.bodyEnvelopeVersion,
          authorUserId: MSG.authorUserId,
          bodySha256: MSG.bodySha256,
          createdAt: MSG.createdAt,
          channelKind: CH.channelKind,
          subjectId: CH.subjectId,
          erased: sql<boolean>`octet_length(${MSG.bodyCipher}) = 0`,
        })
        .from(MSG)
        .innerJoin(CH, and(eq(CH.organizationId, MSG.organizationId), eq(CH.id, MSG.channelId)))
        .where(
          and(eq(MSG.organizationId, orgId), eq(MSG.channelId, channelId), eq(MSG.id, messageId)),
        )
        .limit(1);
      if (!row) return null;
      return {
        live: row.status !== "deleted" && !row.erased,
        channelKind: row.channelKind,
        subjectId: row.subjectId,
        authorUserId: row.authorUserId,
        bodySha256: row.bodySha256,
        createdAt: row.createdAt,
      };
    });
}

export type PromotionDepsInput = Omit<
  PromotionBindingInput,
  "messageLookup" | "part2Gate" | "displayName"
> & {
  readonly messageLookup?: PromotionBindingInput["messageLookup"] | undefined;
  readonly part2Gate?: PromotionBindingInput["part2Gate"] | undefined;
  readonly displayName?: PromotionBindingInput["displayName"] | undefined;
};

export function buildPromotionDeps(input: PromotionDepsInput): PromotionBinding {
  return buildPromotionBinding({
    ...input,
    messageLookup: input.messageLookup ?? createDbPromotionMessageLookup(input.db),
    part2Gate: input.part2Gate ?? createSeamPart2ChannelGate(input.db),
    displayName: input.displayName ?? createMentionActorNameResolver(input.db),
  });
}
