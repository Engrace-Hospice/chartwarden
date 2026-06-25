// @wardenx/reporting — the forward-seam-unavailable marker (M33 §4.4).
//
// M33 CONSUMES every clinical/billing module's read seam through the M1 SeamRegistry (`getSeam`) — no
// import edge. The producers that are not yet implemented (M15/M16/M19/M20/M21/M23/M24/M25/M26/M27/M28
// and the explicit M30 forward seam, §4.4) are authored here as DENY-STUBS that resolve to a typed
// "forward-seam unavailable" marker rather than throwing or failing open: a tile bound to such a metric
// renders "Not yet available — M<n> required" and the drilldown is suppressed. When the owning module
// lands it registers its real reader over the deny-stub (P2C), and `isForwardSeamDenyStub` flips false.

/**
 * The typed answer a forward-seam deny-stub returns for every read until the owning module lands.
 * Mirrors the `MetricsProvider.getDashboardMetric` shape's `{ value: null, isForwardSeamDenyStub }`
 * contract so an embedded tile can branch on it uniformly (D6 — never fails open, never throws).
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

/** A windowed aggregate read result M33 maps to a tile value (present producers; aggregate-by-default, D6). */
export interface ReportingAggregate {
  readonly value: number | null;
  readonly rowCount: number;
}
