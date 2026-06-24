// apps/backend/src/modules/22-documents/render-variants/lab-backref-bindings.ts — M22-T09 the §7.15 lab-results
// back-ref forward-declared binding + the M29 observation-reader DENY-STUB resolver. PHASE-1 DEFERRED (M29
// lands in Wave H; M6-T11 / T06 bindings precedent).
//
// What ships now: the PURE decider ({@link decideLabBackref}) + the deny-stub fact resolver below. The live
// wiring — subscribing the boot dispatcher to `m11.order.results_received`, resolving the M29
// `LabObservationReader` seam into a `LabResultsRenderPayload`, calling the decider, executing the render via
// the T04 `DocumentRenderer` seam, and emitting `m22.document.rendered` — is forward-declared here but NOT
// live-wired (no dispatcher binding, no real M29 reader). The event name is a STRING literal and the M29
// seam is reached OPAQUELY via getSeam, so M22 deps stay `[1, 5]` (no producer import, no edge).
import { getSeam } from "../../../bootstrap/index";
import type { LabResultsRenderPayload } from "./render-variants";
import {
  M22_LAB_RESULTS_CONSUMER,
  M22_LAB_RESULTS_EVENT,
} from "./lab-backref-consumer";

/** The forward-declared §7.15 binding: the consumed event + the M22 consumer the dispatcher routes to once
 * M29 (Wave H) lands and the live lab-results render worker is wired. */
export interface LabBackrefBinding {
  readonly eventName: typeof M22_LAB_RESULTS_EVENT;
  readonly consumerName: typeof M22_LAB_RESULTS_CONSUMER;
}

/** The §7.15 forward-declared binding (one event → the lab-results render consumer). */
export const M22_LAB_RESULTS_BINDING: LabBackrefBinding = {
  eventName: M22_LAB_RESULTS_EVENT,
  consumerName: M22_LAB_RESULTS_CONSUMER,
} as const;

/** True in Phase 1 — M29 is not yet built (Wave H); the binding is declared but not wired into the dispatcher. */
export const M22_LAB_RESULTS_BINDING_DEFERRED = true;

/** The M22-side structural projection of M29's `LabObservationReader` (the only arm M22 will consume once M29
 * lands). The real (richer) contract lives in @wardenx/lab; M22 will read it opaquely from the M1 registry. */
export interface LabObservationReaderPort {
  resolveLabResultsPayload(input: {
    organizationId: string;
    orderId: string;
    observationId: string;
  }): Promise<LabResultsRenderPayload | null>;
}

/**
 * Resolve the lab-results render payload via M29's `LabObservationReader` seam (§7.15). PHASE-1 DENY-STUB:
 * M29 is not yet registered, so `getSeam("LabObservationReader")` throws / returns undefined and this
 * fail-CLOSES to `null` (→ the decider returns `observations_unresolved`; the worker defers — it NEVER
 * renders a blank/unredacted lab PDF). Once M29 lands in Wave H this resolves the real reader.
 */
export async function resolveLabResultsPayload(input: {
  organizationId: string;
  orderId: string;
  observationId: string;
}): Promise<LabResultsRenderPayload | null> {
  try {
    const reader = getSeam("LabObservationReader" as never) as LabObservationReaderPort | undefined;
    if (reader === undefined || typeof reader.resolveLabResultsPayload !== "function") {
      return null; // deny-stub: M29 reader not registered (Wave H) ⇒ fail-closed
    }
    return await reader.resolveLabResultsPayload(input);
  } catch {
    return null; // fail-closed — observation reader unavailable ⇒ defer the render
  }
}
