// apps/backend/src/modules/36-messaging/handoffs/deps.ts - WP 3.5: the composition-root factory the boot calls once. It
// supplies what the binding leaves to the caller (the Part 2 gate, the active-user check and the display-name resolver
// default to the platform's own) and returns the binding: `isEnabled` + `service` are the route deps; `expireDue` is the
// tick body; `reassignForLeaver` is the offboarding half; `stillOffered` / `markNeedsAttention` are the notification
// consumer's ports. One factory, so every caller shares one service and one store.
import type { DbClient } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { createMentionActorNameResolver } from "../mention-non-member-service-db";
import { isActiveMessagingUser } from "../messaging-route-service-db";
import { createSeamPart2ChannelGate } from "../part2-channel-gate";
import { type HandoffBinding, type HandoffBindingInput, buildHandoffBinding } from "./binding";

export type HandoffDepsInput = Omit<
  HandoffBindingInput,
  "part2Gate" | "isActiveUser" | "displayName"
> & {
  readonly part2Gate?: HandoffBindingInput["part2Gate"] | undefined;
  readonly isActiveUser?: HandoffBindingInput["isActiveUser"] | undefined;
  readonly displayName?: HandoffBindingInput["displayName"] | undefined;
};

const dbIsActiveUser =
  (db: DbClient): HandoffBindingInput["isActiveUser"] =>
  (orgId, userId) =>
    withOrgContext(db, systemOrgContext(orgId), (tx) =>
      isActiveMessagingUser(
        tx as unknown as Parameters<typeof isActiveMessagingUser>[0],
        orgId,
        userId,
      ),
    );

export function buildHandoffDeps(input: HandoffDepsInput): HandoffBinding {
  return buildHandoffBinding({
    ...input,
    part2Gate: input.part2Gate ?? createSeamPart2ChannelGate(input.db),
    isActiveUser: input.isActiveUser ?? dbIsActiveUser(input.db),
    displayName: input.displayName ?? createMentionActorNameResolver(input.db),
  });
}
