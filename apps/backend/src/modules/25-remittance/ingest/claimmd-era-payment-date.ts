import type { ParsedRemittanceAdvice } from "@chartwarden/x12-835-client";

export interface StagedPaymentDate {
  /** `YYYY-MM-DD`, or the BPR16 string as sealed. */
  readonly day: string;
  /**
   * `payment_effective_date`: BPR16, carried by every stage sealed since migration 1508.
   * `legacy_production_date`: the sealed transaction set predates the field and carries only `productionDate`.
   */
  readonly source: "payment_effective_date" | "legacy_production_date";
}

/**
 * The payment date of a staged Claim.MD transaction set, or null when it has none the posting may use.
 *
 * A stage that HAS the `paymentEffectiveDate` key keeps the strict rule: BPR16 must be present and a valid date
 * (a null or invalid value is refused; the production day never stands in for a missing BPR16).
 * A stage sealed before migration 1508 has no such key at all and would otherwise be permanently
 * UNSUPPORTED_OR_INCOMPLETE_835, so for that case alone its legacy `productionDate` day is used.
 */
export function stagedPaymentDate(
  parsed: Pick<ParsedRemittanceAdvice, "productionDate"> & {
    readonly paymentEffectiveDate?: string | null;
  },
): StagedPaymentDate | null {
  if (Object.hasOwn(parsed, "paymentEffectiveDate")) {
    const bpr16 = parsed.paymentEffectiveDate;
    return bpr16 && Number.isFinite(Date.parse(bpr16))
      ? { day: bpr16, source: "payment_effective_date" }
      : null;
  }
  const production = parsed.productionDate;
  const parsedMs = production ? Date.parse(production) : Number.NaN;
  return Number.isFinite(parsedMs)
    ? { day: new Date(parsedMs).toISOString().slice(0, 10), source: "legacy_production_date" }
    : null;
}
