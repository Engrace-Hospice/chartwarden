// apps/backend/src/modules/36-messaging/afterhours-triage/afterhours-request.ts - ADR-0082 slice S3: what the urgent send's transaction hook
// writes for an after-hours send: the id-only request event (M19 consumes it) and the link row that remembers the event's id. The event id is
// chosen HERE and handed to the publisher, so the link and the outbox row carry the same id in the same transaction (decision 7).
import { randomUUID } from "node:crypto";
import { AFTERHOURS_TRIAGE_REQUESTED_EVENT } from "@chartwarden/types";
import type { HintOutboxPort } from "../message-hint-events";
import type { AfterHoursLinkStore } from "./afterhours-link-store";

export interface AfterHoursRequestFacts {
  readonly orgId: string;
  readonly messageId: string;
  readonly requestId: string;
  readonly patientId: string;
  readonly at: Date;
}

export interface AfterHoursRequestDeps {
  readonly outbox: HintOutboxPort | undefined;
  readonly store: Pick<AfterHoursLinkStore, "insertInTx">;
  readonly newEventId?: () => string;
}

/** The frozen payload of `m36.afterhours_triage.requested`: ids and one instant, nothing else. */
export function afterHoursRequestedPayload(f: AfterHoursRequestFacts): Record<string, unknown> {
  return {
    messageId: f.messageId,
    requestId: f.requestId,
    patientId: f.patientId,
    occurredAt: f.at.toISOString(),
  };
}

export function createAfterHoursRequestWriter(deps: AfterHoursRequestDeps) {
  const newEventId = deps.newEventId ?? randomUUID;
  return async function requestInTx(tx: unknown, f: AfterHoursRequestFacts): Promise<void> {
    // No outbox bound means the request could not be made: fail the send whole rather than record a link nobody will answer.
    if (!deps.outbox) throw new Error("after-hours triage needs the outbox");
    const eventId = newEventId();
    await deps.outbox.publish(tx, {
      eventName: AFTERHOURS_TRIAGE_REQUESTED_EVENT,
      organizationId: f.orgId,
      aggregateKind: "message",
      aggregateId: f.messageId,
      payload: afterHoursRequestedPayload(f),
      eventId,
    });
    await deps.store.insertInTx(tx, {
      orgId: f.orgId,
      messageId: f.messageId,
      requestId: f.requestId,
      sourceOutboxEventId: eventId,
    });
  };
}
