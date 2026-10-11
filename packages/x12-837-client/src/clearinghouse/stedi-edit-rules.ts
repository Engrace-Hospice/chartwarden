// @wardenx/x12-837-client — a pre-flight check of the edits Stedi's engine applied in the sandbox (ADR-0053 D9).
//
// Every rule below was observed as a rejection on 2026-10-09; none is inferred from the implementation guide, and
// the check says nothing about payer or MAC acceptance ("passed these edits" only). A finding names the rule and
// the segment, never a value, so it is safe to log. Pure: no IO, no clock.
import { tokenizeInterchange } from "../eligibility/x12-envelope";

export type StediEditRule =
  | "frequency-status-conflict"
  | "total-matches-lines"
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
const DISCHARGED_PATIENT_STATUS = "30"; // CL103 30 = still a patient (an ongoing stay)
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

function frequencyFindings(clm: Segment | undefined, cl1: Segment | undefined, component: string) {
  const frequency = clm?.[5]?.split(component)[2];
  if (frequency === FINAL_BILL_FREQUENCY && cl1?.[3] === DISCHARGED_PATIENT_STATUS) {
    return [
      finding(
        "frequency-status-conflict",
        "CL1",
        "Frequency 1 (final bill) conflicts with patient status 30 (still a patient)",
      ),
    ];
  }
  return [];
}

function totalFindings(segments: readonly Segment[], clm: Segment | undefined) {
  const total = toCents(clm?.[2]);
  const lines = segments.filter((s) => s[0] === "SV2").map((s) => toCents(s[3]));
  if (total === null || lines.some((c) => c === null)) return [];
  const sum = lines.reduce<number>((a, c) => a + (c ?? 0), 0);
  return total === sum
    ? []
    : [
        finding(
          "total-matches-lines",
          "CLM",
          "CLM02 does not equal the sum of the SV2 line charges",
        ),
      ];
}

function replacementFindings(
  segments: readonly Segment[],
  clm: Segment | undefined,
  component: string,
) {
  const frequency = clm?.[5]?.split(component)[2] ?? "";
  if (!REPLACEMENT_OR_VOID_FREQUENCIES.includes(frequency)) return [];
  const cl1 = segments.findIndex((s) => s[0] === "CL1");
  const next = cl1 === -1 ? undefined : segments[cl1 + 1];
  return next?.[0] === "REF" && next[1] === "F8" && next[2]
    ? []
    : [
        finding(
          "payer-claim-number-required",
          "REF",
          "Frequency 7/8 needs REF*F8 (payer claim control number) directly after CL1",
        ),
      ];
}

/** Check one 837I interchange against the sandbox-observed edits. Throws X12FormatError on a non-X12 payload. */
export function checkStediEdits(raw: string): StediEditFinding[] {
  const { segments, delimiters } = tokenizeInterchange(raw);
  const first = (id: string): Segment | undefined => segments.find((s) => s[0] === id);
  const clm = first("CLM");
  const cl1 = first("CL1");
  const bht = first("BHT");
  const out: StediEditFinding[] = [];

  if (first("ST")?.[3] !== IMPLEMENTATION_GUIDE) {
    out.push(finding("implementation-guide-version", "ST", `ST03 must be ${IMPLEMENTATION_GUIDE}`));
  }
  out.push(...frequencyFindings(clm, cl1, delimiters.component));
  out.push(...totalFindings(segments, clm));
  if (cl1 && !cl1[2]) {
    out.push(
      finding(
        "admission-source-required",
        "CL1",
        "CL102 admission source is required on institutional claims",
      ),
    );
  }
  if (bht?.[6] === "CH" && (toCents(clm?.[2]) ?? 0) <= 0) {
    out.push(
      finding(
        "chargeable-needs-charge",
        "BHT",
        "BHT06 CH needs a total claim charge greater than zero",
      ),
    );
  }
  if (segments.some((s) => s[0] === "DTP" && s[1] === "096" && s[2] !== "TM")) {
    out.push(
      finding("discharge-hour-format", "DTP", "DTP*096 (discharge hour) must use the TM format"),
    );
  }
  out.push(...replacementFindings(segments, clm, delimiters.component));
  return out;
}
