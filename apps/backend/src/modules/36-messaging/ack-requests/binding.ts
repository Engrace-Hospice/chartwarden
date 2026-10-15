// apps/backend/src/modules/36-messaging/ack-requests/binding.ts - WP 4.2: the composition-root binding for the acknowledgment-request
// aggregate. The ops flag `messaging.ack_requests` is read through the platform's FeatureFlagReaderPort (tenant row wins; absent
// = off), cached a few seconds per org. It gates CREATING a request; an existing one can always be settled. Eligibility is the
// WP 4.1 rule (the WP 3.5 recipient rule plus `messaging.urgent.receive`): nothing here reads an order or prescribing permission.
import {
  ACK_REQUESTS_FLAG_KEY,
  URGENT_RECEIVE_PERMISSION,
  URGENT_SEND_PERMISSION,
} from "@wardenx/types";
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
  readonly log?: (message: string, context: Record<string, string>) => void;
  readonly now?: () => Date;
}

export interface AckBinding {
  /** WP 4.4: the same store the service uses, for the escalation timers. */
  readonly store: AckStore;
  readonly isEnabled: (organizationId: string) => Promise<boolean>;
  readonly service: AckService;
  /** Consume-time: is the user active, keyed and Part 2 admitted for the channel's patient? A lookup error propagates. */
  readonly stillQualified: (orgId: string, userId: string, channelId: string) => Promise<boolean>;
  /**
   * Consume-time: is the request still WAITING (pending), still assigned to this user, and still at the version the event
   * announced? Anything else (acknowledged since, reassigned again, closed, a newer version) is a stale event: alert nobody.
   */
  readonly isWaitingForAssignee: (
    orgId: string,
    requestId: string,
    userId: string,
    version: number,
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
    // The same keys POST /escalations demands; a lookup error propagates (a hand-off is never refused on a blip).
    canRaise: async (orgId, userId) => {
      const permissions = await input.eligibility.permissionsFor(orgId, userId);
      return permissions.has("messaging.send") && permissions.has(URGENT_SEND_PERMISSION);
    },
    ...(input.log ? { log: input.log } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  return {
    store: input.store,
    isEnabled,
    service,
    stillQualified,
    isWaitingForAssignee: (orgId, requestId, userId, version) =>
      input.store.readAsSystem(orgId, async (tx) => {
        const row = await tx.findById(requestId, false);
        return (
          !!row &&
          row.status === "pending" &&
          row.assignedUserId === userId &&
          row.version === version
        );
      }),
    responseTracker: { enabled: isEnabled, createInTx: service.createForUrgentSend },
  };
}
