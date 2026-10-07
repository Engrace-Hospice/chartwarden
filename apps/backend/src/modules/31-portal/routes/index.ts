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

import type { M31EventEmitter } from "../events";
import type { PortalReasonCipher, PortalRoomCipher } from "../portal-crypto";
import type { M17VisitRoomReaderPort } from "../telehealth/room-mint";
import type { PortalStore } from "./store";

export {
  type PortalReasonCipher,
  type PortalRoomCipher,
  type PortalTenantKeyProvider,
  createPortalReasonCipher,
  createPortalRoomCipher,
} from "../portal-crypto";

/**
 * The structural projection of the `@wardenx/telehealth-client` `TelehealthProvider` the route layer calls
 * — mint token / end / start-stop recording / verify webhook. Injected so the routes take no vendor edge;
 * the composition root binds the real Daily.co adapter (D1), a NOOP fail-closed adapter otherwise.
 */
export interface TelehealthAdapterPort {
  readonly vendor: "daily_co" | "twilio_video" | "native_webrtc";
  /** F-220 — optional so a fail-closed NOOP adapter (no vendor key vault bound) simply cannot lazy-mint. */
  mintRoom?(input: {
    telehealthVisitId: string;
    scheduledStartedAt: string;
    recordingEnabled: boolean;
  }): Promise<{ vendorRoomId: string; vendorRoomUrl: string }>;
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
  /**
   * Seals the operator's reason for an account suspend/reinstate (#117). ABSENT ⇒ those two routes
   * refuse with 503 rather than dropping the reason or writing it in the clear into a `_cipher` column
   * — the M32 R18 posture, for the same reason.
   */
  readonly reasonCipher?: PortalReasonCipher;
  /**
   * F-220 — M17's org-explicit published visit read (`VisitReader.visitForEncounter`) for the LAZY room mint: the
   * first clinician join of a `telephonic` visit whose id is not yet a `telehealth_visit` id mints the room. ABSENT
   * (either this or {@link roomCipher}) ⇒ the join route behaves exactly as before (404 for an unknown id).
   */
  readonly visitReader?: M17VisitRoomReaderPort;
  /** F-220 — seals the two vendor-room columns at the lazy mint (per-tenant DEK envelope). */
  readonly roomCipher?: PortalRoomCipher;
  /**
   * GAP-006 — M5's §164.526 amendment intake (M5 owns `patient_amendment_request`; the composition root binds
   * M5's Drizzle intake here). ABSENT ⇒ submit refuses 503 and the list refuses 503: a portal that tells a
   * patient "submitted" must have started M5's 60-day clock, so there is no fake-success fallback.
   */
  readonly amendmentIntake?: PortalAmendmentIntakePort;
  /**
   * GAP-093(d) — M3's engagement coverage reader for the auditor view. Absent ⇒ the `AuditorEngagementReader`
   * seam (deny-stub until M3 registers it, which 403s the view). Injectable so the route suite needs no registry.
   */
  readonly engagementReader?: import("./auditor-engagement").EngagementCoverageReader;
  /** GAP-159 - the M31 outbox emitter for decision-point events (session, upload, amendment, message). */
  readonly events?: M31EventEmitter;
  /** Injected clock (every timestamp decision is reproducible in a unit test). */
  readonly now?: () => Date;
}

/** The M5 amendment intake as M31 calls it (structurally satisfied by M5's `createDbPortalAmendmentIntake`). */
export interface PortalAmendmentIntakePort {
  submit(input: {
    organizationId: string;
    patientId: string;
    requestedByUserId: string;
    portalAccountId: string;
    targetKind: "patient_demographic" | "encounter_narrative";
    targetRef: string;
    requestedChange: string;
  }): Promise<{ id: string; status: string }>;
  listOwn(q: { organizationId: string; patientId: string; requestedByUserId: string }): Promise<
    ReadonlyArray<{
      id: string;
      targetKind: string;
      requestedChange: string;
      status: string;
      submittedAt: string;
      slaDueAt: string;
      decidedAt: string | null;
    }>
  >;
}
