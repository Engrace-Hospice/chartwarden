// apps/backend/src/modules/23-billing-medicare/services/rhc-carry-over-view.ts — the TYPES of the two-tier RHC
// carry-over as M23 exposes it (claim detail `pricing.hipps.rhcCarryOver`, the hospice-periods read). Split from
// `rhc-carry-over.ts` so the route-layer view types can name them without importing the resolver (no cycle).
import type { IsoDate, RhcCarryOverResult } from "@wardenx/billing";

/** The HETS check a carry-over read, as shown to billers (no MBI — ids + dates only). */
export interface RhcHetsCheckRef {
  readonly checkId: string;
  readonly checkedAt: string;
  readonly ageDays: number;
  readonly stale: boolean;
}

/** The computed carry-over + the HETS check it read; persisted as `hipps_calculation.rhc_carry_over`. */
export interface RhcCarryOverView extends RhcCarryOverResult {
  readonly electionDate: IsoDate;
  /** The day of the RHC count the new stay starts at (priorDays + 1). */
  readonly startsAtDay: number;
  readonly highRateDaysRemaining: number;
  readonly hetsCheck: RhcHetsCheckRef | null;
}

export interface PriorStayFact {
  readonly admissionId: string;
  readonly startedOn: IsoDate | null;
  readonly endedOn: IsoDate | null;
  /** Days at ANOTHER hospice that M6 recorded (a transfer-in's sending hospice), with its NPI when captured. */
  readonly otherHospice?: { readonly npi: string | null };
}
