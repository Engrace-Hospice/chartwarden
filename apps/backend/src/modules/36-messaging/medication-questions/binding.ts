// apps/backend/src/modules/36-messaging/medication-questions/binding.ts - WP 3.10: the composition-root binding for the
// medication-clarification entry. The ops flag `messaging.medication_questions` is read through the platform's
// FeatureFlagReaderPort (tenant row wins; absent = off) AND requires `messaging.tasks`, cached a few seconds per org. Built
// from ports so the routes (S2) share one service. Nothing here reads an order or prescribing permission: eligibility is
// the WP 3.5 recipient rule (messaging read/send, patient read, Part 2 gate).
import type { MessagingRouteService } from "@chartwarden/messaging";
import { MEDICATION_QUESTION_FLAG_KEY } from "@chartwarden/types";
import { recipientEligible } from "../handoffs/handoff-eligibility";
import type { EligibilityPorts } from "../handoffs/handoff-eligibility";
import type { HintOutboxPort } from "../message-hint-events";
import { cacheFlagRead } from "../presence/binding";
import { seamCareTeamMembers, seamPrimaryRn } from "../tasks/binding";
import { TASKS_FLAG_KEY } from "../tasks/task-service";
import type { TaskStore } from "../tasks/task-store-db";
import {
  type ChannelFacts,
  type MedicationQuestionService,
  createMedicationQuestionService,
} from "./medication-question-service";

const CLINICAL_LINKS_FLAG_KEY = "messaging.clinical_links";

export interface MedicationQuestionBindingInput {
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  readonly outbox?: HintOutboxPort | undefined;
  readonly messaging: {
    canViewChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;
    sendMessage: MessagingRouteService["sendMessage"];
  };
  readonly channelFacts: (orgId: string, channelId: string) => Promise<ChannelFacts | null>;
  readonly eligibility: EligibilityPorts;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  readonly taskStore: TaskStore;
  /** Default to the CareTeamProvider seam. */
  readonly careTeamMembers?: (orgId: string, patientId: string) => Promise<readonly string[]>;
  readonly primaryRn?: (orgId: string, patientId: string) => Promise<string | null>;
  readonly now?: () => Date;
}

export interface MedicationQuestionBinding {
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: MedicationQuestionService;
}

export function buildMedicationQuestionBinding(
  input: MedicationQuestionBindingInput,
): MedicationQuestionBinding {
  const flag = (key: string) => async (organizationId: string) =>
    input.flags ? (await input.flags.forOrg(organizationId))[key] === true : false;
  const readFlags = cacheFlagRead(async (organizationId) => {
    const flags = input.flags ? await input.flags.forOrg(organizationId) : {};
    return flags[MEDICATION_QUESTION_FLAG_KEY] === true && flags[TASKS_FLAG_KEY] === true;
  });
  const isEnabled = (organizationId: string) => readFlags(organizationId);
  return {
    isEnabled,
    service: createMedicationQuestionService({
      isEnabled,
      linksEnabled: cacheFlagRead(flag(CLINICAL_LINKS_FLAG_KEY)),
      outbox: input.outbox,
      messaging: input.messaging,
      channelFacts: input.channelFacts,
      careTeamMembers: input.careTeamMembers ?? seamCareTeamMembers,
      primaryRn: input.primaryRn ?? seamPrimaryRn,
      isEligible: (orgId, userId, patientId) =>
        recipientEligible(input.eligibility, orgId, userId, [patientId]),
      displayName: input.displayName,
      taskStore: input.taskStore,
      ...(input.now ? { now: input.now } : {}),
    }),
  };
}
