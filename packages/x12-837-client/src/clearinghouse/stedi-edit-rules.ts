// @wardenx/x12-837-client — a pre-flight check of the edits Stedi's engine applied in the sandbox (ADR-0053 D9).
//
// Every rule below was observed as a rejection on 2026-10-09; none is inferred from the implementation guide, and
// the check says nothing about payer or MAC acceptance ("passed these edits" only). A finding names the rule and
// the segment, never a value, so it is safe to log. Pure: no IO, no clock.
import { X12FormatError, tokenizeInterchange } from "../eligibility/x12-envelope";

export type StediEditRule =
  | "frequency-status-conflict"
  | "total-matches-lines"
  | "amount-unreadable"
  | "admission-source-required"
  | "chargeable-needs-charge"
  | "discharge-hour-format"
  | "payer-claim-number-required"
  | "implementation-guide-version";

export interface StediEditFinding {
  readonly rule: StediEditRule;
  /** The segment id the rule reads (never a value). */
  readonly segment: string;
  readonly message: string;
}

const IMPLEMENTATION_GUIDE = "005010X223A2";
const ONGOING_PATIENT_STATUS = "30"; // CL103 30 = still a patient (an ongoing stay)
const FINAL_BILL_FREQUENCY = "1";
const REPLACEMENT_OR_VOID_FREQUENCIES: readonly string[] = ["7", "8"];

/** A decimal amount ("1500.00") as integer cents, or null when it is not one. */
function toCents(value: string | undefined): number | null {
  if (value === undefined || !/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole = "0", frac = ""] = value.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

type Segment = readonly string[];

const finding = (rule: StediEditRule, segment: string, message: string): StediEditFinding => ({
  rule,
  segment,
  message,
});

/** One claim: its CLM and every segment up to the next CLM (or the transaction trailer). */
function claimChunks(segments: readonly Segment[]): Segment[][] {
  const chunks: Segment[][] = [];
  for (const seg of segments) {
    if (seg[0] === "CLM") chunks.push([seg]);
    else if (seg[0] === "SE") break;
    else chunks.at(-1)?.push(seg);
  }
  return chunks;
}

function claimFindings(
  claim: readonly Segment[],
  bht06: string | undefined,
  component: string,
): StediEditFinding[] {
  const out: StediEditFinding[] = [];
  const clm = claim[0] ?? [];
  const cl1Index = claim.findIndex((s) => s[0] === "CL1");
  const cl1 = claim[cl1Index];
  const frequency = clm[5]?.split(component)[2] ?? "";

  if (frequency === FINAL_BILL_FREQUENCY && cl1?.[3] === ONGOING_PATIENT_STATUS) {
    out.push(
      finding(
        "frequency-status-conflict",
        "CL1",
        "Frequency 1 (final bill) conflicts with patient status 30 (still a patient)",
      ),
    );
  }

  const total = toCents(clm[2]);
  const lines = claim.filter((s) => s[0] === "SV2").map((s) => toCents(s[3]));
  if (total === null || lines.length === 0 || lines.some((c) => c === null)) {
    out.push(
      finding(
        "amount-unreadable",
        "CLM",
        "CLM02 or an SV2 line charge is missing or not a decimal amount, so the total cannot be checked",
      ),
    );
  } else if (total !== lines.reduce<number>((a, c) => a + (c ?? 0), 0)) {
    out.push(
      finding("total-matches-lines", "CLM", "CLM02 does not equal the sum of the SV2 line charges"),
    );
  }

  if (cl1 && !cl1[2]) {
    out.push(
      finding(
        "admission-source-required",
        "CL1",
        "CL102 admission source is required on institutional claims",
      ),
    );
  }
  if (bht06 === "CH" && total !== null && total <= 0) {
    out.push(
      finding(
        "chargeable-needs-charge",
        "BHT",
        "BHT06 CH needs a total claim charge greater than zero",
      ),
    );
  }
  if (claim.some((s) => s[0] === "DTP" && s[1] === "096" && s[2] !== "TM")) {
    out.push(
      finding("discharge-hour-format", "DTP", "DTP*096 (discharge hour) must use the TM format"),
    );
  }
  if (REPLACEMENT_OR_VOID_FREQUENCIES.includes(frequency)) {
    const next = cl1Index === -1 ? undefined : claim[cl1Index + 1];
    if (!(next?.[0] === "REF" && next[1] === "F8" && next[2])) {
      out.push(
        finding(
          "payer-claim-number-required",
          "REF",
          "Frequency 7/8 needs REF*F8 (payer claim control number) as the segment immediately after CL1",
        ),
      );
    }
  }
  return out;
}

/**
 * Check one 837I interchange against the sandbox-observed edits, claim by claim. Throws X12FormatError on a
 * non-X12 payload or one with no claim — never an empty (passing) result for a file that was not read.
 */
export function checkStediEdits(raw: string): StediEditFinding[] {
  const { segments, delimiters } = tokenizeInterchange(raw);
  const claims = claimChunks(segments);
  if (claims.length === 0) throw new X12FormatError("interchange has no CLM segment");
  const bht06 = segments.find((s) => s[0] === "BHT")?.[6];
  const out: StediEditFinding[] = [];
  if (segments.find((s) => s[0] === "ST")?.[3] !== IMPLEMENTATION_GUIDE) {
    out.push(finding("implementation-guide-version", "ST", `ST03 must be ${IMPLEMENTATION_GUIDE}`));
  }
  for (const claim of claims) out.push(...claimFindings(claim, bht06, delimiters.component));
  return out;
}
