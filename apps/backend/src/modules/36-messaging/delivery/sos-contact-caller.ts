// apps/backend/src/modules/36-messaging/delivery/sos-contact-caller.ts - GAP-032: M36's implementation of the
// leaf `SosContactCaller` contract. M20's SOS terminus asks for ONE automated safety call to a clinician's
// consented emergency contact (a third party with no user and no verified endpoint, so it cannot ride the
// `notification_delivery` recipient model). What it reuses is M36's chokepoint and transport:
//   script  - `sanitizeForEmergencyContactCall` (fixed template, two allowlisted name variables), and
//   carrier - the bound Twilio voice `OutOfBandTransport` (or the fail-closed deny transport).
// The destination number exists only in the call arguments: it is never stored, logged or echoed back.
import {
  type OutOfBandTransport,
  TransportError,
  sanitizeForEmergencyContactCall,
} from "@wardenx/messaging";
import type { SosContactCallResult, SosContactCaller } from "@wardenx/types";

const NOT_CONFIGURED = "transport_not_configured";

function refusalOf(error: unknown): Extract<SosContactCallResult, { kind: "refused" }> {
  if (error instanceof TransportError) {
    if (error.reason === NOT_CONFIGURED) {
      return { kind: "refused", reason: NOT_CONFIGURED, retryable: false };
    }
    return { kind: "refused", reason: "vendor_refused", retryable: error.retryable };
  }
  // Any other throw (network, abort) is transient by the transport contract's own rule.
  return { kind: "refused", reason: "timeout", retryable: true };
}

export function createSosContactCaller(voice: OutOfBandTransport): SosContactCaller {
  return {
    async place(input) {
      const notification = sanitizeForEmergencyContactCall({
        idempotencyKey: input.idempotencyKey,
        agencyName: input.agencyName,
        subjectDisplayName: input.subjectDisplayName,
      });
      try {
        const sent = await voice.send({ notification, destination: input.toE164 });
        return { kind: "accepted", vendorCallId: sent.vendorMessageId };
      } catch (error) {
        return refusalOf(error);
      }
    },
  };
}
