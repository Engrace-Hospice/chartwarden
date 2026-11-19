// M23's `m23.claim.acknowledged` means a technical 277CA acceptance only. It is not adjudication,
// payment, remittance, or authorization for a Medicaid-secondary claim. Keep the declared consumer
// bound for event-catalog integrity, but deliberately do not advance M24 claim state until M24 has
// correlated authoritative M25 remittance evidence and the applicable state COB policy is confirmed.
// A future reevaluation may use this event as a trigger; this handler currently records no business
// transition because no safe readiness decision can be made from an acknowledgment alone.
import type { DbClient } from "@chartwarden/db";
import type {
  DispatchableOutboxEvent,
  OutboxConsumerBinding,
} from "../../../bootstrap/outbox-dispatcher";

const M24_MEDICARE_PRIMARY_ACK_EVENT = "m23.claim.acknowledged" as const;
const M24_MEDICARE_PRIMARY_ACK_CONSUMER_NAME = "m24.m23-claim-acknowledged" as const;

export interface MedicarePrimaryAckOutboxPort {
  publish(
    tx: DbClient,
    event: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

export interface MedicarePrimaryAckDeps {
  readonly db: DbClient;
  readonly outbox: MedicarePrimaryAckOutboxPort;
}

function medicareClaimIdOf(payload: unknown): string {
  const p = (payload ?? {}) as Record<string, unknown>;
  const claimId = p.claimId;
  if (typeof claimId !== "string" || claimId.length === 0) {
    throw new Error(`${M24_MEDICARE_PRIMARY_ACK_CONSUMER_NAME}: payload has no claimId`);
  }
  return claimId;
}

/** M24's catalog binding for `m23.claim.acknowledged`; this event is not a COB readiness transition. */
export function buildM24MedicarePrimaryAckConsumer(
  _deps: MedicarePrimaryAckDeps,
): OutboxConsumerBinding {
  return {
    consumerName: M24_MEDICARE_PRIMARY_ACK_CONSUMER_NAME,
    consumerModule: "m24",
    eventTypes: [M24_MEDICARE_PRIMARY_ACK_EVENT],
    async handle(event: DispatchableOutboxEvent): Promise<void> {
      const medicareClaimId = medicareClaimIdOf(event.payload);
      if (event.aggregateKind !== "claim" || event.aggregateId !== medicareClaimId) {
        throw new Error(
          `${M24_MEDICARE_PRIMARY_ACK_CONSUMER_NAME}: event aggregate does not match claimId`,
        );
      }
    },
  };
}
