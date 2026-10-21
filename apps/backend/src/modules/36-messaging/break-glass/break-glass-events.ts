// M36 ADR-0087 (PROPOSED), WP 5.8 - the transactional outbox events a break-glass write emits. PHI-free by construction: ids, the closed
// reason code, the review outcome and instants only - never the justification, a review note, a name or a message. Published in the SAME
// transaction as the write (the caller passes its `tx`), so an event never announces a write that rolled back; a repeat that changes nothing
// publishes nothing. The catalog entries live in events-by-m36.ts.
import type { BreakGlassReasonCode, BreakGlassReviewOutcome } from "@chartwarden/types";
import type { HintOutboxPort } from "../message-hint-events";

export const M36_BREAK_GLASS_EVENTS = {
  granted: "m36.break_glass.granted",
  revoked: "m36.break_glass.revoked",
  reviewed: "m36.break_glass.reviewed",
} as const;

export const BREAK_GLASS_AGGREGATE_KIND = "message_break_glass_grant";

export type BreakGlassEventFacts =
  | {
      readonly kind: "granted";
      readonly orgId: string;
      readonly grantId: string;
      readonly channelId: string;
      readonly granteeUserId: string;
      readonly reasonCode: BreakGlassReasonCode;
      readonly grantedAt: Date;
      readonly expiresAt: Date;
    }
  | {
      readonly kind: "revoked";
      readonly orgId: string;
      readonly grantId: string;
      readonly channelId: string;
      readonly granteeUserId: string;
      readonly revokedByUserId: string;
      readonly at: Date;
    }
  | {
      readonly kind: "reviewed";
      readonly orgId: string;
      readonly grantId: string;
      readonly reviewId: string;
      readonly reviewerUserId: string;
      readonly outcome: BreakGlassReviewOutcome;
      readonly at: Date;
    };

/** The event payload: everything but `kind`, instants as ISO strings, `organizationId` named as the catalog expects. */
export function breakGlassEventPayload(facts: BreakGlassEventFacts): Record<string, unknown> {
  const { kind: _kind, orgId, ...rest } = facts;
  const entries = Object.entries(rest).map(([key, value]) => [
    key,
    value instanceof Date ? value.toISOString() : value,
  ]);
  return { organizationId: orgId, ...Object.fromEntries(entries) };
}

export async function publishBreakGlassEvent(
  outbox: HintOutboxPort | undefined,
  tx: unknown,
  facts: BreakGlassEventFacts,
): Promise<void> {
  await outbox?.publish(tx, {
    eventName: M36_BREAK_GLASS_EVENTS[facts.kind],
    organizationId: facts.orgId,
    aggregateKind: BREAK_GLASS_AGGREGATE_KIND,
    aggregateId: facts.grantId,
    payload: breakGlassEventPayload(facts),
  });
}
