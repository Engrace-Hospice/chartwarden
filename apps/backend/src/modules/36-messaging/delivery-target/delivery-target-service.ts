// apps/backend/src/modules/36-messaging/delivery-target/delivery-target-service.ts - WP 4.8 (ADR-0075): the resolve step.
// Reader (recipient + organisation + the target still exists) THEN the same channel check the rest of M36 uses, so a user who
// lost access since the alert was sent resolves nothing. Every failure is the one NotFoundError. The channel check runs on a
// nil id when the reader missed, so a hit and a miss do the same work (no cheap timing oracle).
import type { MessagingRouteService } from "@wardenx/messaging";
import { NotFoundError } from "@wardenx/types";
import type { OpenRequestLookup } from "../ack-requests/open-request-lookup";
import type { DeliveryTarget, DeliveryTargetReader } from "./delivery-target-reader-db";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export interface DeliveryTargetActor {
  readonly orgId: string;
  readonly userId: string;
}

export interface DeliveryTargetService {
  resolve(actor: DeliveryTargetActor, deliveryId: string): Promise<DeliveryTarget>;
}

export function createDeliveryTargetService(deps: {
  readonly read: DeliveryTargetReader;
  readonly messaging: Pick<MessagingRouteService, "canViewChannel">;
  readonly openRequestId: OpenRequestLookup;
}): DeliveryTargetService {
  return {
    async resolve(actor, deliveryId) {
      const target = await deps.read(actor.orgId, actor.userId, deliveryId);
      const visible = await deps.messaging.canViewChannel(
        actor.orgId,
        actor.userId,
        target?.channelId ?? NIL_UUID,
      );
      if (!target || !visible) throw new NotFoundError("notification");
      return { ...target, ackRequestId: await deps.openRequestId(actor.orgId, target.messageId) };
    },
  };
}
