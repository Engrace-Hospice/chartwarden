// apps/backend/src/modules/36-messaging/urgent/deps.ts - WP 4.1: the composition-root factory the boot calls once. It supplies
// what the binding leaves to the caller (channel facts, display names, the active-user check and the Part 2 gate), reusing
// the WP 3.10 database lookups.
import type { DbClient } from "@wardenx/db";
import { schema } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { and, eq } from "drizzle-orm";
import { createDbChannelFactsLookup } from "../medication-questions/deps";
import { createMentionActorNameResolver } from "../mention-non-member-service-db";
import { isActiveMessagingUser } from "../messaging-route-service-db";
import { createSeamPart2ChannelGate } from "../part2-channel-gate";
import type { Part2ChannelGate } from "../part2-channel-gate";
import { type UrgentBinding, type UrgentBindingInput, buildUrgentBinding } from "./binding";

export type UrgentDepsInput = Omit<
  UrgentBindingInput,
  "channelFacts" | "eligibility" | "displayName"
> & {
  readonly db: DbClient;
  readonly permissionsFor: (orgId: string, userId: string) => Promise<ReadonlySet<string>>;
  readonly part2Gate?: Part2ChannelGate | undefined;
  readonly isActiveUser?: ((orgId: string, userId: string) => Promise<boolean>) | undefined;
  readonly displayName?: UrgentBindingInput["displayName"] | undefined;
};

const MSG = schema.messages;

/** The recipient of the urgent message this author already sent in this channel under this client id, or null. */
export function createDbReplayLookup(
  db: DbClient,
): NonNullable<UrgentBindingInput["findReplayRecipient"]> {
  return (orgId, authorUserId, channelId, clientMessageId) =>
    withOrgContext(db, systemOrgContext(orgId), async (tx) => {
      const [row] = await tx
        .select({ recipient: MSG.urgentRecipientUserId })
        .from(MSG)
        .where(
          and(
            eq(MSG.organizationId, orgId),
            eq(MSG.authorUserId, authorUserId),
            eq(MSG.channelId, channelId),
            eq(MSG.clientMessageId, clientMessageId),
          ),
        )
        .limit(1);
      return row?.recipient ?? null;
    });
}

/**
 * ADR-0081: what a role send needs to know about the message this author already stored under this client id in this channel: the
 * recipient and the ROLE its response request was addressed to (null for a person-send, or when no request was tracked). Null when none.
 */
export function createDbRoleReplayLookup(
  db: DbClient,
): (
  orgId: string,
  authorUserId: string,
  channelId: string,
  clientMessageId: string,
) => Promise<{ readonly recipient: string | null; readonly role: string | null } | null> {
  const REQ = schema.messageAckRequests;
  return (orgId, authorUserId, channelId, clientMessageId) =>
    withOrgContext(db, systemOrgContext(orgId), async (tx) => {
      const [row] = await tx
        .select({ recipient: MSG.urgentRecipientUserId, role: REQ.addressedRole })
        .from(MSG)
        .leftJoin(REQ, and(eq(REQ.organizationId, MSG.organizationId), eq(REQ.messageId, MSG.id)))
        .where(
          and(
            eq(MSG.organizationId, orgId),
            eq(MSG.authorUserId, authorUserId),
            eq(MSG.channelId, channelId),
            eq(MSG.clientMessageId, clientMessageId),
          ),
        )
        .limit(1);
      return row ?? null;
    });
}

export function buildUrgentDeps(input: UrgentDepsInput): UrgentBinding {
  const { db, permissionsFor, part2Gate, isActiveUser, displayName, ...rest } = input;
  return buildUrgentBinding({
    ...rest,
    channelFacts: createDbChannelFactsLookup(db),
    eligibility: {
      permissionsFor,
      part2Gate: part2Gate ?? createSeamPart2ChannelGate(db),
      isActiveUser:
        isActiveUser ??
        ((orgId, userId) =>
          withOrgContext(db, systemOrgContext(orgId), (tx) =>
            isActiveMessagingUser(
              tx as unknown as Parameters<typeof isActiveMessagingUser>[0],
              orgId,
              userId,
            ),
          )),
    },
    displayName: displayName ?? createMentionActorNameResolver(db),
    findReplayRecipient: createDbReplayLookup(db),
  });
}
