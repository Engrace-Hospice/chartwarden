// apps/backend/src/modules/36-messaging/urgent/binding.ts - WP 4.1: the composition-root binding for the urgent entry. The ops
// flag `messaging.urgent_clinical` is read through the platform's FeatureFlagReaderPort (tenant row wins; absent = off) AND
// requires `messaging.sbar` (SBAR is mandatory), cached a few seconds per org. Eligibility of the recipient is the WP 3.5
// recipient rule plus `messaging.urgent.receive`; nothing here reads an order or prescribing permission.
import { type MessagingRouteService, derivePatient } from "@wardenx/messaging";
import { URGENT_CLINICAL_FLAG_KEY, URGENT_RECEIVE_PERMISSION } from "@wardenx/types";
import { HANDOFF_RECIPIENT_PERMISSIONS, recipientEligible } from "../handoffs/handoff-eligibility";
import type { EligibilityPorts } from "../handoffs/handoff-eligibility";
import type { HintOutboxPort } from "../message-hint-events";
import { cacheFlagRead } from "../presence/binding";
import { SBAR_FLAG_KEY } from "../sbar/binding";
import { seamCareTeamMembers } from "../tasks/binding";
import {
  type UrgentChannelFacts,
  type UrgentService,
  type UrgentServiceDeps,
  createUrgentService,
} from "./urgent-service";

export interface UrgentBindingInput {
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  readonly outbox?: HintOutboxPort | undefined;
  readonly messaging: {
    canViewChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;
    sendMessage: MessagingRouteService["sendMessage"];
  };
  readonly channelFacts: (orgId: string, channelId: string) => Promise<UrgentChannelFacts | null>;
  readonly eligibility: EligibilityPorts;
  readonly displayName: (orgId: string, userId: string) => Promise<string | null>;
  /** Defaults to the CareTeamProvider seam. */
  readonly careTeamMembers?: (orgId: string, patientId: string) => Promise<readonly string[]>;
  readonly findReplayRecipient?: UrgentServiceDeps["findReplayRecipient"];
  readonly now?: () => Date;
}

export interface UrgentBinding {
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  /**
   * Consume-time check for the notification consumer: is this user, right now, active, holding the messaging keys and
   * `messaging.urgent.receive`, and admitted by the Part 2 gate for the channel's patient? Unlike the send-time check, a lookup
   * ERROR propagates (the outbox retries); only a clean "no" returns false.
   */
  readonly stillQualified: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  readonly service: UrgentService;
}

export function buildUrgentBinding(input: UrgentBindingInput): UrgentBinding {
  const isEnabled = cacheFlagRead(async (organizationId) => {
    const flags = input.flags ? await input.flags.forOrg(organizationId) : {};
    return flags[URGENT_CLINICAL_FLAG_KEY] === true && flags[SBAR_FLAG_KEY] === true;
  });
  const stillQualified: UrgentBinding["stillQualified"] = async (orgId, userId, channelId) => {
    if (!(await input.eligibility.isActiveUser(orgId, userId))) return false;
    const permissions = await input.eligibility.permissionsFor(orgId, userId);
    const required = [...HANDOFF_RECIPIENT_PERMISSIONS, URGENT_RECEIVE_PERMISSION];
    if (!required.every((key) => permissions.has(key))) return false;
    const facts = await input.channelFacts(orgId, channelId);
    const patientId =
      facts?.kind === "care_team" ? derivePatient(facts.kind, facts.subjectId) : null;
    if (!patientId) return false;
    const allowed = await input.eligibility.part2Gate.allowedUserIds({
      organizationId: orgId,
      patientId,
      userIds: [userId],
    });
    return allowed.has(userId);
  };
  return {
    isEnabled,
    stillQualified,
    service: createUrgentService({
      isEnabled,
      outbox: input.outbox,
      messaging: input.messaging,
      channelFacts: input.channelFacts,
      careTeamMembers: input.careTeamMembers ?? seamCareTeamMembers,
      isQualified: (orgId, userId, patientId) =>
        recipientEligible(
          input.eligibility,
          orgId,
          userId,
          [patientId],
          [URGENT_RECEIVE_PERMISSION],
        ),
      displayName: input.displayName,
      ...(input.findReplayRecipient ? { findReplayRecipient: input.findReplayRecipient } : {}),
      ...(input.now ? { now: input.now } : {}),
    }),
  };
}
