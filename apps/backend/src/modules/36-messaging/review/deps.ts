// apps/backend/src/modules/36-messaging/review/deps.ts - WP 3.8: the composition-root factory the boot calls once. It
// supplies what the binding leaves to the caller (the Part 2 gate, the active-user check and the display-name resolver
// default to the platform's own) and returns the binding: `isEnabled` + `service` are the route deps; `queueForPatient` is
// the lifecycle consumer's port. One factory, so every caller shares one service and one store.
import type { DbClient } from "@wardenx/db";
import { systemOrgContext, withOrgContext } from "@wardenx/tenancy";
import { createMentionActorNameResolver } from "../mention-non-member-service-db";
import { isActiveMessagingUser } from "../messaging-route-service-db";
import { createSeamPart2ChannelGate } from "../part2-channel-gate";
import { type ReviewBinding, type ReviewBindingInput, buildReviewBinding } from "./binding";

export type ReviewDepsInput = Omit<
  ReviewBindingInput,
  "part2Gate" | "isActiveUser" | "displayName"
> & {
  readonly part2Gate?: ReviewBindingInput["part2Gate"] | undefined;
  readonly isActiveUser?: ReviewBindingInput["isActiveUser"] | undefined;
  readonly displayName?: ReviewBindingInput["displayName"] | undefined;
};

const dbIsActiveUser =
  (db: DbClient): ReviewBindingInput["isActiveUser"] =>
  (orgId, userId) =>
    withOrgContext(db, systemOrgContext(orgId), (tx) =>
      isActiveMessagingUser(
        tx as unknown as Parameters<typeof isActiveMessagingUser>[0],
        orgId,
        userId,
      ),
    );

export function buildReviewDeps(input: ReviewDepsInput): ReviewBinding {
  return buildReviewBinding({
    ...input,
    part2Gate: input.part2Gate ?? createSeamPart2ChannelGate(input.db),
    isActiveUser: input.isActiveUser ?? dbIsActiveUser(input.db),
    displayName: input.displayName ?? createMentionActorNameResolver(input.db),
  });
}
