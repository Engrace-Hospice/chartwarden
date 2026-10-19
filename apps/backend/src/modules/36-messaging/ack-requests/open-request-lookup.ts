// apps/backend/src/modules/36-messaging/ack-requests/open-request-lookup.ts - WP 4.8: the id of the OPEN request on a message, for the
// deep-link resolver (it names the card to land on). A read through the aggregate's own store; never writes.
import { ACK_OPEN_STATUSES } from "@wardenx/types";
import type { AckStore } from "./ack-types";

export type OpenRequestLookup = (orgId: string, messageId: string) => Promise<string | null>;

export function createOpenRequestLookup(store: AckStore): OpenRequestLookup {
  return (orgId, messageId) =>
    // System read on purpose: the caller (the resolver) has already proven the recipient and channel access; this only names the open request id.
    store.readAsSystem(orgId, async (tx) => {
      const row = await tx.findByMessage(messageId, false);
      return row && (ACK_OPEN_STATUSES as readonly string[]).includes(row.status) ? row.id : null;
    });
}
