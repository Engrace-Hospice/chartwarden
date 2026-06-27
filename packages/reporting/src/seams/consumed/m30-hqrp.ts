// @wardenx/reporting — consumed-seam view of M30 (HQRP / Quality Measures). ABSENT producer (§4.4).
//
// M30 is the spec's ONLY EXPLICIT forward seam (§4.4): until M30 locks, every HQRP measure read resolves
// to `{ value: null, isForwardSeamDenyStub: true }` and the embedded tile renders "Not yet available —
// M30 required". M30 registers the real `HqrpMeasureProvider` over this stub when it lands (P2C).
import { FORWARD_SEAM_UNAVAILABLE, type ForwardSeamMetric } from "./forward-seam";

export interface ReportingHqrpConsumer {
  /** M30 `HqrpMeasureProvider` — HQRP measure value by measure key (forward seam; tile shows the deny-stub state). */
  hqrpMeasure(organizationId: string, measureKey: string): Promise<ForwardSeamMetric>;
}

export const denyStubReportingHqrpConsumer: ReportingHqrpConsumer = {
  async hqrpMeasure(): Promise<ForwardSeamMetric> {
    return FORWARD_SEAM_UNAVAILABLE;
  },
};
