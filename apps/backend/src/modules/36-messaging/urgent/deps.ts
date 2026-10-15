// apps/backend/src/modules/36-messaging/urgent/deps.ts - WP 4.1: the composition-root factory the boot calls once. It supplies
// what the binding leaves to the caller (channel facts, display names, the active-user check and the Part 2 gate), reusing
// the WP 3.10 database lookups.
import type { DbClient } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
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
  });
}
