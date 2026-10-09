// @wardenx/billing — the date Medicare itself gives a NOE / NOTR answer. PURE.
//
// Timeliness is judged by the MAC's date, not by when our cron happened to pull the acknowledgment:
//   * 277CA: the claim-level STC segment carries the status information effective date (STC02, format D8).
//   * 999: an implementation acknowledgment carries no status date; the closest payer-stamped date is the 999's
//     own functional group date (GS04, CCYYMMDD), else its interchange date (ISA09, YYMMDD).
//   * Otherwise the date we received the file, flagged as such so a reader knows it is ours.
// A payer date later than the day we received the answer cannot be right (the MAC is not ahead of us) and is
// ignored. The source travels with the date (`noe_record.payer_status_date_source`).
//
// Our receipt time becomes a calendar day in Eastern time (`MEDICARE_RECEIPT_TIME_ZONE`), not UTC: an answer
// pulled at 8 pm Eastern on day 5 is a day-5 answer, and a UTC day would push it to day 6 and invent a late NOE.
// Eastern is the CMS / CWF clock and the latest US mainland zone, so it never dates an answer earlier than any
// MAC's local day would.
import type { IsoDate } from "../contracts";
import { toEpochDay } from "../domain/dates";

/** `dde_manual`: the MAC acceptance date an operator read off DDE and keyed into the DDE work queue (ADR-0052 D5). */
export type PayerStatusDateSource =
  | "277ca_stc02"
  | "999_gs04"
  | "999_isa09"
  | "receipt"
  | "dde_manual";

export const PAYER_STATUS_DATE_SOURCES: readonly PayerStatusDateSource[] = [
  "277ca_stc02",
  "999_gs04",
  "999_isa09",
  "receipt",
  "dde_manual",
];

export interface PayerStatusDate {
  readonly date: IsoDate;
  readonly source: PayerStatusDateSource;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The zone our receipt time is read in when Medicare's own date is missing (see the file header). */
export const MEDICARE_RECEIPT_TIME_ZONE = "America/New_York";

const RECEIPT_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: MEDICARE_RECEIPT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Eastern calendar day (`YYYY-MM-DD`) of an instant. */
export function medicareReceiptDay(at: Date): IsoDate {
  return RECEIPT_DAY.format(at);
}

/** A strict calendar `YYYY-MM-DD` no later than `latest`, else null. */
function usable(value: string | null | undefined, latest: IsoDate): IsoDate | null {
  if (!value || !ISO_DATE_RE.test(value)) return null;
  try {
    return toEpochDay(value) <= toEpochDay(latest) ? value : null;
  } catch {
    return null; // an impossible date such as 2026-02-30
  }
}

export function resolvePayerStatusDate(input: {
  readonly kind: "ack_999" | "ack_277ca";
  /** 277CA STC02, as an ISO date. */
  readonly statusEffectiveDate?: string | null;
  /** 999 GS04, as an ISO date. */
  readonly functionalGroupDate?: string | null;
  /** 999 ISA09, as an ISO date. */
  readonly interchangeDate?: string | null;
  readonly receivedAt: Date;
}): PayerStatusDate {
  const receiptDay = medicareReceiptDay(input.receivedAt);
  const candidates: readonly [string | null | undefined, PayerStatusDateSource][] =
    input.kind === "ack_277ca"
      ? [[input.statusEffectiveDate, "277ca_stc02"]]
      : [
          [input.functionalGroupDate, "999_gs04"],
          [input.interchangeDate, "999_isa09"],
        ];
  for (const [value, source] of candidates) {
    const date = usable(value, receiptDay);
    if (date) return { date, source };
  }
  return { date: receiptDay, source: "receipt" };
}
