// apps/backend/src/modules/36-messaging/medication-questions/deps.ts - WP 3.10: the composition-root factory the boot calls
// once. It supplies what the binding leaves to the caller: the channel-facts lookup, the display-name resolver, the
// active-user check and the Part 2 gate default to the platform's own, and the task store is the database one.
import { type DbClient, schema } from "@chartwarden/db";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import { and, eq } from "drizzle-orm";
import { createMentionActorNameResolver } from "../mention-non-member-service-db";
import { isActiveMessagingUser } from "../messaging-route-service-db";
import { createSeamPart2ChannelGate } from "../part2-channel-gate";
import type { Part2ChannelGate } from "../part2-channel-gate";
import { createDbTaskStore } from "../tasks/task-store-db";
import {
  type MedicationQuestionBinding,
  type MedicationQuestionBindingInput,
  buildMedicationQuestionBinding,
} from "./binding";
import type { ChannelFacts } from "./medication-question-service";

const CH = schema.channels;

/** The kind and subject of one channel (the patient, for a care-team channel); null when it does not exist. */
export function createDbChannelFactsLookup(
  db: DbClient,
): (orgId: string, channelId: string) => Promise<ChannelFacts | null> {
  return (orgId, channelId) =>
    withOrgContext(db, systemOrgContext(orgId), async (tx) => {
      const [row] = await tx
        .select({ kind: CH.channelKind, subjectId: CH.subjectId })
        .from(CH)
        .where(and(eq(CH.organizationId, orgId), eq(CH.id, channelId)))
        .limit(1);
      return row ?? null;
    });
}

export type MedicationQuestionDepsInput = Omit<
  MedicationQuestionBindingInput,
  "channelFacts" | "eligibility" | "displayName" | "taskStore"
> & {
  readonly db: DbClient;
  readonly permissionsFor: (orgId: string, userId: string) => Promise<ReadonlySet<string>>;
  readonly part2Gate?: Part2ChannelGate | undefined;
  readonly isActiveUser?: ((orgId: string, userId: string) => Promise<boolean>) | undefined;
  readonly displayName?: MedicationQuestionBindingInput["displayName"] | undefined;
};

export function buildMedicationQuestionDeps(
  input: MedicationQuestionDepsInput,
): MedicationQuestionBinding {
  const { db, permissionsFor, part2Gate, isActiveUser, displayName, ...rest } = input;
  return buildMedicationQuestionBinding({
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
    taskStore: createDbTaskStore(db),
  });
}
