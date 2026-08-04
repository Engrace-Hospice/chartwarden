// apps/backend/src/modules/31-portal/routes/index.ts — M31-T07 route-surface barrel.
//
// The single deps object every M31 route plugin composes over (`PortalRouteDeps`), plus the Drizzle-backed
// store builder + the guard/actor/typebox re-exports the composition root binds (the M19/M20 routes/index.ts
// precedent). The store owns the three tables; the video vendor adapter is injected structurally so the
// route layer takes no `@wardenx/telehealth-client` edge (the composition root binds the real Daily.co
// adapter).
export {
  type PortalStore,
  buildDrizzlePortalStore,
  buildPortalAbacResolverFromStore,
  PORTAL_DISCLOSURE_CATEGORIES,
} from "./store";
export {
  type M31Actor,
  type PreHandler,
  actorOf,
  portalAccountIdOf,
  portalPatientIdOf,
} from "./actor";
export { requireIdempotencyKey, rejectOffsetPagination } from "./concurrency";
export {
  ABAC_ACCOUNT,
  ABAC_BEREAVED,
  ABAC_CAREGIVER_ATTEST,
  ABAC_GRANT,
  ABAC_IN_ORG,
  ABAC_RECORDING_STATE,
  ABAC_TELEHEALTH_CONSENT,
  P,
  STEP_UP,
} from "./guards";
export { parse, parseQuery } from "./portal-typebox";

import type { PortalStore } from "./store";

/**
 * The structural projection of the `@wardenx/telehealth-client` `TelehealthProvider` the route layer calls
 * — mint token / end / start-stop recording / verify webhook. Injected so the routes take no vendor edge;
 * the composition root binds the real Daily.co adapter (D1), a NOOP fail-closed adapter otherwise.
 */
export interface TelehealthAdapterPort {
  readonly vendor: "daily_co" | "twilio_video" | "native_webrtc";
  mintParticipantToken(input: {
    telehealthVisitId: string;
    role: "patient" | "clinician";
  }): Promise<{ token: string; expiresAt: string }>;
  endRoom(vendorRoomId: string): Promise<void>;
  startRecording(vendorRoomId: string): Promise<{ vendorRecordingId: string }>;
  stopRecording(
    vendorRoomId: string,
    vendorRecordingId: string,
  ): Promise<{ recordingUrl: string; durationSec: number }>;
  verifyWebhookSignature(headers: Record<string, string>, rawBody: string): boolean;
}

/** The deps every M31 route plugin composes over (bound at the composition root). */
export interface PortalRouteDeps {
  /** The Drizzle-backed store over M31's three owned tables. */
  readonly store: PortalStore;
  /** The video vendor adapter (Daily.co default per D1); a fail-closed NOOP when absent. */
  readonly telehealth?: TelehealthAdapterPort;
  /** Injected clock (every timestamp decision is reproducible in a unit test). */
  readonly now?: () => Date;
}
