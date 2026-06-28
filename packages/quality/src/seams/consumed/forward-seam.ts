// @wardenx/quality — the forward-seam-unavailable marker (M30 §4.4).
//
// M30 CONSUMES every upstream clinical/billing module's read seam through the M1 SeamRegistry
// (`getSeam`) — no import edge (the dependency-cruiser schema rule enforces this). The producers that
// are not yet implemented (M15 Discipline / M16 Bereavement / M23 Billing / M27 Cost Report, §4.4)
// are authored as DENY-STUBS that resolve to a typed "forward-seam unavailable" marker rather than
// throwing or failing open: a measure bound to such a source is suppressed ("Not yet available —
// M<n> required") and never fabricates a number (D6 / D13). When the owning module lands it registers
// its real reader over the deny-stub at boot (P2C) and `isForwardSeamDenyStub` flips false.

/**
 * The typed answer a forward-seam deny-stub returns for every read until the owning module lands.
 * Mirrors the aggregate-read shape's `{ value: null, isForwardSeamDenyStub }` contract so a consuming
 * calculator can branch on it uniformly (D6 — never fails open, never throws).
 */
export interface ForwardSeamMetric {
  readonly value: null;
  readonly isForwardSeamDenyStub: true;
}

/** The single shared forward-seam-unavailable value every deny-stub returns (never fails open). */
export const FORWARD_SEAM_UNAVAILABLE: ForwardSeamMetric = {
  value: null,
  isForwardSeamDenyStub: true,
};

/** A windowed aggregate read result M30 maps to a measure input (present producers; aggregate-by-default, D6). */
export interface QualityAggregate {
  readonly value: number | null;
  readonly rowCount: number;
}
