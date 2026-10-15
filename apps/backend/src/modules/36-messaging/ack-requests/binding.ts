// apps/backend/src/modules/36-messaging/ack-requests/binding.ts - WP 4.2: the composition-root binding for the acknowledgment-request
// aggregate. The ops flag `messaging.ack_requests` is read through the platform's FeatureFlagReaderPort (tenant row wins; absent
// = off), cached a few seconds per org. It gates CREATING a request; an existing one can always be settled. Eligibility is the
// WP 4.1 rule (the WP 3.5 recipient rule plus `messaging.urgent.receive`): nothing here reads an order or prescribing permission.
import { ACK_REQUESTS_FLAG_KEY, URGENT_RECEIVE_PERMISSION } from "@wardenx/types";
import { recipientEligible } from "../handoffs/handoff-eligibility";
import type { EligibilityPorts } from "../handoffs/handoff-eligibility";
import type { HintOutboxPort } from "../message-hint-events";
import { cacheFlagRead } from "../presence/binding";
import { seamCareTeamMembers } from "../tasks/binding";
import { makeStillQualified } from "../urgent/binding";
import { type AckService, createAckService } from "./ack-service";
import type { AckStore } from "./ack-types";

export interface AckBindingInput {
  readonly flags?: { forOrg(organizationId: string): Promise<Record<string, boolean>> } | undefined;
  readonly outbox?: HintOutboxPort | undefined;
  readonly store: AckStore;
  readonly messaging: {
    canViewChannel(orgId: string, userId: string, channelId: string): Promise<boolean>;
  };
  readonly channelFacts: (
    orgId: string,
    channelId: string,
  ) => Promise<{ readonly kind: string; readonly subjectId: string | null } | null>;
  readonly eligibility: EligibilityPorts;
  /** Defaults to the CareTeamProvider seam. */
  readonly careTeamMembers?: (orgId: string, patientId: string) => Promise<readonly string[]>;
  readonly now?: () => Date;
}

export interface AckBinding {
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: AckService;
  /** Consume-time: is the user active, keyed and Part 2 admitted for the channel's patient? A lookup error propagates. */
  readonly stillQualified: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  /** Consume-time: is the request still open AND still assigned to this user? (A stale event alerts nobody.) */
  readonly isOpenAndAssignedTo: (
    orgId: string,
    requestId: string,
    userId: string,
  ) => Promise<boolean>;
  /** The hook the urgent entry calls inside its own send transaction. */
  readonly responseTracker: {
    readonly enabled: (orgId: string) => Promise<boolean>;
    readonly createInTx: AckService["createForUrgentSend"];
  };
}

export function buildAckBinding(input: AckBindingInput): AckBinding {
  const isEnabled = cacheFlagRead(async (organizationId) =>
    input.flags
      ? (await input.flags.forOrg(organizationId))[ACK_REQUESTS_FLAG_KEY] === true
      : false,
  );
  const stillQualified = makeStillQualified(input.eligibility, input.channelFacts);
  const service = createAckService({
    isEnabled,
    store: input.store,
    outbox: input.outbox,
    canViewChannel: input.messaging.canViewChannel,
    channelFacts: input.channelFacts,
    careTeamMembers: input.careTeamMembers ?? seamCareTeamMembers,
    isQualified: (orgId, userId, patientId) =>
      recipientEligible(input.eligibility, orgId, userId, [patientId], [URGENT_RECEIVE_PERMISSION]),
    stillQualified,
    ...(input.now ? { now: input.now } : {}),
  });
  const open = new Set(["pending", "acknowledged", "escalated", "failed_unreachable"]);
  return {
    isEnabled,
    service,
    stillQualified,
    isOpenAndAssignedTo: (orgId, requestId, userId) =>
      input.store.readAsSystem(orgId, async (tx) => {
        const row = await tx.findById(requestId, false);
        return !!row && open.has(row.status) && row.assignedUserId === userId;
      }),
    responseTracker: { enabled: isEnabled, createInTx: service.createForUrgentSend },
  };
}
