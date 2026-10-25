/** Synthetic X12 835 builders shared by the M25/M23 live suites (no PHI; fixed-width ISA built for the envelope parser). */
import { createHash } from "node:crypto";

export const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** ISA + GS + ST around the fixed-width header (`isa13` is the interchange control number, `st02` the set number). */
export function buildRawEdi(isa13: string, st02: string): string {
  const sep = "*";
  const elems = [
    "00",
    "          ",
    "00",
    "          ",
    "ZZ",
    "SENDERID       ",
    "ZZ",
    "RECEIVERID     ",
    "250101",
    "1200",
    "^",
    "00501",
    isa13.padStart(9, "0").slice(0, 9),
    "0",
    "P",
    ":",
  ];
  const isaBody = `ISA${sep}${elems.join(sep)}`;
  if (isaBody.length !== 105)
    throw new Error(`test ISA header must be 105 chars, got ${isaBody.length}`);
  const isaSegment = `${isaBody}~`;
  const gsSt = `GS${sep}HP${sep}SENDER${sep}RECEIVER${sep}20250101${sep}1200${sep}1${sep}X${sep}005010X221A1~ST${sep}835${sep}${st02}~`;
  return isaSegment + gsSt;
}

export interface FullEdiClaim {
  /** CLP01, the patient control number the claim is matched by. */
  readonly clp01?: string;
  /** CLP07, the payer's claim control number. */
  readonly icn?: string;
  readonly charge?: string;
  readonly paid?: string;
  /** Patient responsibility (CLP05); when above zero a service-line `CAS*PR*1` carries it. */
  readonly patientResponsibility?: string;
}

/** A complete, balanced 835 (ISA..IEA) with one CLP; `bpr02` must equal the claim's paid amount to foot. */
export function buildFullEdi(
  isa13: string,
  st02: string,
  bpr02: string,
  claim: FullEdiClaim = {},
): string {
  const { clp01 = "PCN-RAW", icn = "ICN-PAID", charge = "500.00", paid = "500.00" } = claim;
  const pr = claim.patientResponsibility ?? "0.00";
  const body = [
    `BPR*I*${bpr02}*C*ACH*CCP*01*999999992*DA*123456789*1512345678**01*999988880*DA*98765*20260615`,
    `TRN*1*EFT-RAW-${isa13}*1512345678`,
    "N1*PR*SYNTHETIC MAC",
    "N1*PE*SYNTH HOSPICE",
    `CLP*${clp01}*1*${charge}*${paid}*${pr}*MC*${icn}`,
    `SVC*HC:T1005*${charge}*${paid}`,
    ...(Number(pr) > 0 ? [`CAS*PR*1*${pr}`] : []),
  ];
  return `${buildRawEdi(isa13, st02)}${body.map((x) => `${x}~`).join("")}SE*${body.length + 2}*${st02}~GE*1*1~IEA*1*${isa13.padStart(9, "0")}~`;
}
