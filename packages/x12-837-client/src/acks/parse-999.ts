// @wardenx/x12-837-client — a 999 implementation acknowledgment (005010X231A1), read in TypeScript (ADR-0037,
// ADR-0053 D9). The clearinghouse's answer to "was the file structurally valid?" — NOT the payer's answer; only a
// 277CA/payer-stage event satisfies NOE timeliness (ADR-0052 D4).
//
// Codes and control numbers only. IK4-04 / AK4-04 echo the offending element value (can be PHI) and are never read.
import { X12FormatError, tokenizeInterchange, x12DateToIso } from "../eligibility/x12-envelope";
import type { AckError, AckOutcome, Parsed999 } from "../types";

export interface Ack999TransactionSet {
  /** AK202 — the ST02 of the acknowledged transaction set. */
  readonly controlNumber: string;
  /** AK5/IK5-01: A accepted, E accepted with errors (reported as `partial`, not success), M/R/W/X rejected, P partially accepted. */
  readonly status: string;
}

export interface Parsed999Detail extends Parsed999 {
  /** AK1-02 — the GS06 of OUR functional group that this 999 answers (the correlation key). */
  readonly acknowledgedGroupControlNumber: string;
  readonly transactionSets: readonly Ack999TransactionSet[];
}

const UNKNOWN_CODE = "Unrecognized code";

const SEGMENT_ERRORS: Readonly<Record<string, string>> = {
  "1": "Unrecognized segment ID",
  "2": "Unexpected segment",
  "3": "Required segment missing",
  "4": "Loop occurs over maximum times",
  "5": "Segment exceeds maximum use",
  "6": "Segment not in defined transaction set",
  "7": "Segment not in proper sequence",
  "8": "Segment has data element errors",
};

const ELEMENT_ERRORS: Readonly<Record<string, string>> = {
  "1": "Required data element missing",
  "2": "Conditional required data element missing",
  "3": "Too many data elements",
  "4": "Data element too short",
  "5": "Data element too long",
  "6": "Invalid character in data element",
  "7": "Invalid code value",
  "8": "Invalid date",
  "9": "Invalid time",
  "10": "Exclusion condition violated",
  "12": "Too many repetitions",
  "13": "Too many components",
};

const TRANSACTION_ERRORS: Readonly<Record<string, string>> = {
  "1": "Transaction set not supported",
  "2": "Transaction set trailer missing",
  "3": "Transaction set control number in header and trailer do not match",
  "4": "Number of included segments does not match actual count",
  "5": "One or more segments in error",
  "6": "Missing or invalid transaction set identifier",
  "7": "Missing or invalid transaction set control number",
  "23": "Transaction set control number not unique within the functional group",
};

const GROUP_ERRORS: Readonly<Record<string, string>> = {
  "1": "Functional group not supported",
  "2": "Functional group version not supported",
  "3": "Functional group trailer missing",
  "4": "Group control number in header and trailer do not match",
  "5": "Number of included transaction sets does not match actual count",
  "6": "Group control number violates syntax",
};

const OUTCOME_BY_AK9: Readonly<Record<string, AckOutcome>> = {
  A: "accepted",
  E: "partial",
  P: "partial",
  R: "rejected",
  M: "rejected",
  W: "rejected",
  X: "rejected",
};

const SEVERITY: Readonly<Record<AckOutcome, number>> = { accepted: 0, partial: 1, rejected: 2 };

const describe = (table: Readonly<Record<string, string>>, code: string): string =>
  table[code] ?? UNKNOWN_CODE;

/** A segment id or status echoed from the sender is trusted only if it looks like one (never free text). */
const safeToken = (value: string | undefined): string =>
  value !== undefined && /^[A-Z0-9]{1,3}$/.test(value) ? value : "UNKNOWN";

/** A short code or control number echoed from the sender; anything else is dropped to a constant. */
const safeCode = (value: string | undefined): string =>
  value !== undefined && /^[A-Za-z0-9]{1,9}$/.test(value) ? value : "UNKNOWN";

/** A strictly numeric AK9 count, or null (a missing or non-numeric count is never read as zero). */
const count = (value: string | undefined): number | null =>
  value !== undefined && /^\d{1,6}$/.test(value) ? Number(value) : null;

/** Error-code elements from `from` on, skipping empties (AK5-02..06, AK9-05..09). */
const codesFrom = (seg: readonly string[], from: number): string[] =>
  seg.slice(from).filter((c) => c.length > 0);

/**
 * Parse a 999. Throws {@link X12FormatError} (content-free) when the payload is not a 999 or has no AK9 — a
 * caller must never read a missing verdict as acceptance.
 */
export function parse999(raw: string): Parsed999Detail {
  const { segments, delimiters } = tokenizeInterchange(raw);
  const component = delimiters.component;
  const isa = segments.find((s) => s[0] === "ISA");
  const gs = segments.find((s) => s[0] === "GS");
  const st = segments.find((s) => s[0] === "ST");
  if (st?.[1] !== "999") throw new X12FormatError("interchange is not a 999 acknowledgment");

  const ak1 = segments.find((s) => s[0] === "AK1");
  const ak9s = segments.filter((s) => s[0] === "AK9");
  const verdicts = ak9s.map((s) => OUTCOME_BY_AK9[(s[1] ?? "").trim()]);
  if (!ak1?.[2] || verdicts.length === 0 || verdicts.some((v) => v === undefined)) {
    throw new X12FormatError("999 has no usable AK1/AK9 verdict");
  }

  const errors: AckError[] = [];
  const transactionSets: Ack999TransactionSet[] = [];
  let setControl = "";
  let segmentId = "";
  for (const seg of segments) {
    switch (seg[0]) {
      case "AK2":
        setControl = safeCode(seg[2]);
        break;
      case "IK3":
      case "AK3": {
        segmentId = safeToken(seg[1]);
        const code = safeCode(seg[4]);
        errors.push({ segment: segmentId, code, description: describe(SEGMENT_ERRORS, code) });
        break;
      }
      case "IK4":
      case "AK4": {
        const code = safeCode(seg[3]);
        const rawPosition = (seg[1] ?? "").split(component)[0] ?? "";
        const position = /^\d{1,3}$/.test(rawPosition) ? rawPosition.padStart(2, "0") : "00";
        errors.push({
          segment: `${segmentId}${position}`,
          code,
          description: describe(ELEMENT_ERRORS, code),
        });
        break;
      }
      case "IK5":
      case "AK5":
        transactionSets.push({ controlNumber: setControl, status: safeToken(seg[1]) });
        for (const code of codesFrom(seg, 2).map(safeCode)) {
          errors.push({
            segment: seg[0] ?? "IK5",
            code,
            description: describe(TRANSACTION_ERRORS, code),
          });
        }
        break;
      default:
    }
  }
  for (const code of ak9s.flatMap((s) => codesFrom(s, 5)).map(safeCode)) {
    errors.push({ segment: "AK9", code, description: describe(GROUP_ERRORS, code) });
  }

  // Fail closed: the worst group verdict wins, and an AK9 "accepted" counts only when its numbers add up: the
  // included, received and accepted counts are numeric, equal and positive, the sets present match them, and
  // every set was accepted. Anything else is `partial`, never `accepted`.
  const included = ak9s.map((s) => count(s[2]));
  const sound = ak9s.every((s, i) => {
    const inc = included[i] ?? null;
    const [received, accepted] = [count(s[3]), count(s[4])];
    return inc !== null && inc > 0 && inc === received && inc === accepted;
  });
  const expectedSets = included.reduce<number>((a, c) => a + (c ?? 0), 0);
  const countsShort = !sound || transactionSets.length !== expectedSets;
  const setsNotAccepted = transactionSets.some((t) => t.status !== "A");
  const worst = verdicts.reduce<AckOutcome>(
    (a, v) => (v && SEVERITY[v] > SEVERITY[a] ? v : a),
    "accepted",
  );
  const outcome: AckOutcome =
    worst === "accepted" && (countsShort || setsNotAccepted) ? "partial" : worst;

  return {
    outcome,
    interchangeControlNumber: (isa?.[13] ?? "").trim(),
    acknowledgedGroupControlNumber: ak1[2],
    functionalGroupDate: x12DateToIso(gs?.[4]?.trim()),
    interchangeDate: x12DateToIso(`20${(isa?.[9] ?? "").trim()}`),
    errors,
    transactionSets,
  };
}
