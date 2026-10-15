// apps/backend/src/modules/36-messaging/ack-requests/deps.ts - WP 4.2: the composition-root factory the boot calls once. It supplies
// what the binding leaves to the caller (the Drizzle store, channel facts, the active-user check and the Part 2 gate), reusing the
// WP 4.1 database lookups.
import type { DbClient } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { createDbChannelFactsLookup } from "../medication-questions/deps";
import { isActiveMessagingUser } from "../messaging-route-service-db";
import { createSeamPart2ChannelGate } from "../part2-channel-gate";
import type { Part2ChannelGate } from "../part2-channel-gate";
import { createDbAckStore } from "./ack-store-db";
import { type AckBinding, type AckBindingInput, buildAckBinding } from "./binding";

export type AckDepsInput = Omit<AckBindingInput, "store" | "channelFacts" | "eligibility"> & {
  readonly db: DbClient;
  readonly permissionsFor: (orgId: string, userId: string) => Promise<ReadonlySet<string>>;
  readonly part2Gate?: Part2ChannelGate | undefined;
  readonly isActiveUser?: ((orgId: string, userId: string) => Promise<boolean>) | undefined;
};

export function buildAckDeps(input: AckDepsInput): AckBinding {
  const { db, permissionsFor, part2Gate, isActiveUser, ...rest } = input;
  return buildAckBinding({
    ...rest,
    store: createDbAckStore(db),
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
  });
}
