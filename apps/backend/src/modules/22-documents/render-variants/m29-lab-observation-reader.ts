// apps/backend/src/modules/22-documents/render-variants/m29-lab-observation-reader.ts — M22-T09 (§7.15 W-M22-22).
//
// The M29 `LabObservationReader` seam M22's lab-results consumer reads to hydrate observation values BEFORE
// rendering the `lab_results_pdf` (no direct M29 schema import — M22 `dependsOn` stays `[1, 5]`). M29 (External
// Interfaces) lands in Wave H, so M22 boots with the deny-stub here — exactly the M32 DocLens deny-stub precedent
// (`@wardenx/intake-extraction`): the reader resolves to a registered M29 capability OR this deny-stub, never
// neither. While denied, the lab consumer is INERT (`awaiting_reader`): no observation is read, no PDF is rendered,
// no back-ref is stamped. The moment M29 registers the real reader (injected), the consumer flips live unchanged.
//
// PHI / SUD boundary: the reader returns `isSudClass` per value (resolved from M29's `lab_observation
// .sud_redaction_status`); the SUD plaintext is dropped by `buildLabResultsRenderPayload` (D20) — the renderer
// NEVER calls M29's `SudUnredactProvider.exercise()` (D20). The reader is a one-shot disclosure source.

import type { LabResultValueInput } from "@wardenx/forms";

/** A lab observation resolved by M29 for a `lab_results_pdf` render (the §7.15 W-M22-22 hydration target). */
export interface ResolvedLabObservation {
  readonly observationId: string;
  readonly orderId: string;
  /** Resolved via M40 `MdmEntityProvider.resolvePhysician` by the M29 reader impl (chart-banner context, §7.15). */
  readonly orderingProviderName: string | null;
  /** Per-value results incl. the `isSudClass` flag the D20 redaction keys on. */
  readonly resultValues: readonly LabResultValueInput[];
}

/** The deny reason the M29 reader returns until M29 (Wave H) registers the real capability. */
export type LabObservationReaderUnavailableReason = "capability_unavailable";

/** The §7.15 W-M22-22 M29 reader seam — `available:false` until M29 lands (deny-stub), else the resolved obs. */
export interface LabObservationReader {
  loadObservation(args: {
    readonly organizationId: string;
    readonly observationId: string;
  }): Promise<
    | { readonly available: true; readonly observation: ResolvedLabObservation }
    | { readonly available: false; readonly reason: LabObservationReaderUnavailableReason }
  >;
}

/** The Phase-1 deny-stub M22 boots with: every load refuses, so the lab consumer stays inert (M29 = Wave H). */
export const denyStubLabObservationReader: LabObservationReader = {
  async loadObservation() {
    return { available: false, reason: "capability_unavailable" };
  },
};
