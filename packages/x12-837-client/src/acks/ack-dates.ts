// @chartwarden/x12-837-client — the payer's own dates on an acknowledgment (ADR-0037: X12 parsing is TypeScript here).
//
//   * 277CA (005010X214): the claim-level loop 2200D opens with `TRN*2*<claim control number>` and carries
//     `STC*<category:status:entity>*<STC02 status information effective date, D8 CCYYMMDD>*<action>…`.
//   * 999 (005010X231A1): no status date. The closest payer-stamped dates are its own envelope's: GS04 (functional
//     group date, CCYYMMDD) and ISA09 (interchange date, YYMMDD).
// Dates and control numbers only — never a name, identifier or any other element of the beneficiary loops.
// The Medicare gateway's `/parse-999` and `/parse-277ca` answers carry these as `functionalGroupDate` /
// `interchangeDate` and `statusEffectiveDate`; this is the reference reading of them.
import { tokenizeInterchange, x12DateToIso } from "../eligibility/x12-envelope";

/** ISA09 `YYMMDD` → ISO. X12 interchange dates are in the 2000s for any acknowledgment ChartWarden can receive. */
function isa09ToIso(value: string | undefined): string | null {
  if (!value || !/^\d{6}$/.test(value)) return null;
  return x12DateToIso(`20${value}`);
}

export interface Ack999EnvelopeDates {
  readonly functionalGroupDate: string | null;
  readonly interchangeDate: string | null;
}

/** The 999's GS04 and ISA09 as ISO dates (null when absent or malformed). */
export function read999EnvelopeDates(raw: string): Ack999EnvelopeDates {
  const { segments } = tokenizeInterchange(raw);
  const isa = segments.find((s) => s[0] === "ISA");
  const gs = segments.find((s) => s[0] === "GS");
  return {
    functionalGroupDate: x12DateToIso(gs?.[4]?.trim()),
    interchangeDate: isa09ToIso(isa?.[9]?.trim()),
  };
}

export interface ClaimStatusDate {
  readonly claimControlNumber: string;
  readonly statusEffectiveDate: string | null;
}

/** Each claim-level (2200D) `TRN*2` control number with the STC02 of its first STC segment. */
export function read277caStatusDates(raw: string): ClaimStatusDate[] {
  const { segments } = tokenizeInterchange(raw);
  const out: ClaimStatusDate[] = [];
  let inPatientLevel = false;
  let current: {
    claimControlNumber: string;
    statusEffectiveDate: string | null;
    seenStc: boolean;
  } | null = null;
  const flush = () => {
    if (current)
      out.push({
        claimControlNumber: current.claimControlNumber,
        statusEffectiveDate: current.statusEffectiveDate,
      });
    current = null;
  };
  for (const seg of segments) {
    const id = seg[0];
    if (id === "HL") {
      flush();
      // HL03 'PT' = the patient (claim) level; TRN/STC above it are the batch-level ones.
      inPatientLevel = seg[3] === "PT";
    } else if (id === "TRN" && inPatientLevel && seg[1] === "2" && seg[2]) {
      flush();
      current = { claimControlNumber: seg[2], statusEffectiveDate: null, seenStc: false };
    } else if (id === "STC" && current && !current.seenStc) {
      current.seenStc = true;
      current.statusEffectiveDate = x12DateToIso(seg[2]?.trim());
    } else if (id === "SE") {
      flush();
    }
  }
  flush();
  return out;
}
