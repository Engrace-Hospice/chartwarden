// M36 WP 6.7 (ADR-0099 D16) - trail-only outbox events of family messaging. PHI-free by construction: the thread-link id, the acting staff id and instants only;
// never a patient or caregiver id, a name, a token, a code or a message. Published in the SAME transaction as the write. Catalog entries live in events-by-m36.ts.
import {
  FAMILY_EVENT_BEREAVEMENT_MODE,
  FAMILY_EVENT_CREATED,
  FAMILY_EVENT_REVOKED,
} from "@chartwarden/types";
import type { HintOutboxPort } from "../message-hint-events";

export const FAMILY_AGGREGATE_KIND = "message_family_contact";

export type FamilyEventFacts =
  | {
      readonly kind: "created";
      readonly orgId: string;
      readonly contactId: string;
      readonly actorUserId: string;
      readonly expiresAt: Date;
      readonly at: Date;
    }
  | {
      readonly kind: "revoked";
      readonly orgId: string;
      readonly contactId: string;
      readonly actorUserId: string;
      readonly reason: "staff" | "blocked";
      readonly at: Date;
    }
  | { readonly kind: "bereavement_mode"; readonly orgId: string; readonly contactId: string; readonly at: Date };

export function familyEventPayload(facts: FamilyEventFacts): Record<string, unknown> {
  const base = {
    organizationId: facts.orgId,
    contactId: facts.contactId,
    at: facts.at.toISOString(),
  };
  switch (facts.kind) {
    case "created":
      return { ...base, createdBy: facts.actorUserId, expiresAt: facts.expiresAt.toISOString() };
    case "revoked":
      return { ...base, revokedBy: facts.actorUserId, reason: facts.reason };
    case "bereavement_mode":
      return base;
  }
}

const EVENT_NAMES = {
  created: FAMILY_EVENT_CREATED,
  revoked: FAMILY_EVENT_REVOKED,
  bereavement_mode: FAMILY_EVENT_BEREAVEMENT_MODE,
} as const;

export async function publishFamilyEvent(
  outbox: HintOutboxPort,
  tx: unknown,
  facts: FamilyEventFacts,
): Promise<void> {
  await outbox.publish(tx, {
    eventName: EVENT_NAMES[facts.kind],
    organizationId: facts.orgId,
    aggregateKind: FAMILY_AGGREGATE_KIND,
    aggregateId: facts.contactId,
    payload: familyEventPayload(facts),
  });
}
