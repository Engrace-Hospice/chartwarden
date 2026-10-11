// @wardenx/x12-837-client — the shared 837I writer pieces: envelope (ISA/GS/ST … SE/GE/IEA), field validation and
// the name/address/physician segments. Extracted from the transfer-notice builder so the claim, NOE and NOTR
// generators emit byte-identical envelopes (ADR-0053 D9, ADR-0037). PURE: no IO, no clock (the caller passes
// `createdAt`). Every error names the FIELD only, never its value (PHI).
import { isoToX12Date } from "../eligibility/x12-envelope";

/** Thrown for an input the 837I cannot carry. Names the FIELD only, never its value (PHI). */
export class X12BuildError extends Error {
  public override readonly name: string = "X12BuildError";
  constructor(
    public readonly field: string,
    message = `invalid X12 input: ${field}`,
  ) {
    super(message);
  }
}

export interface X12Address {
  readonly line1: string;
  readonly line2?: string | null;
  readonly city: string;
  readonly state: string;
  /** 5 or 9 digits (a hyphen is stripped). */
  readonly postalCode: string;
}

export interface X12PersonName {
  readonly lastName: string;
  readonly firstName: string;
  readonly middleInitial?: string | null;
}

export interface X12Physician extends X12PersonName {
  readonly npi: string;
}

export interface X12Envelope {
  readonly senderId: string;
  readonly receiverId: string;
  /** GS03 — the receiver's application code. */
  readonly applicationReceiverCode: string;
  /** ISA13 / GS06 / ST02 seed: 1..999 999 999. */
  readonly interchangeControlNumber: number;
  /** ISA15: `T` reaches only the receiver's test mode. */
  readonly usage: "P" | "T";
  readonly createdAt: Date;
}

export const NAME_LIMIT = 60;
export const ORG_NAME_LIMIT = 60;
/**
 * Anything outside printable ASCII (control characters such as LF/CR/NUL, accented letters) or one of the X12
 * delimiters / separators (`* ~ : ^ |`) and the escape character `\`. The basic character set cannot carry these, and
 * a control character could smuggle a segment break into the interchange.
 */
const FORBIDDEN = /[^\x20-\x7E]|[*~:^|\\]/;
const IMPLEMENTATION_GUIDE = "005010X223A2";
const MAX_CONTROL_NUMBER = 999_999_999;

/** True only for a string that matches `re`: a regex `.test` alone would coerce null/undefined/arrays. */
export function matches(re: RegExp, value: unknown): boolean {
  return typeof value === "string" && re.test(value);
}

export function text(value: string | null | undefined, field: string, max: number): string {
  const v = (value ?? "").trim().toUpperCase();
  if (v.length === 0 || v.length > max || FORBIDDEN.test(v)) throw new X12BuildError(field);
  return v;
}

export function optionalText(value: string | null | undefined, field: string, max: number): string {
  if (value === null || value === undefined || value.trim() === "") return "";
  return text(value, field, max);
}

/** The NPI check digit: Luhn mod 10 over the "80840" card-issuer prefix + the first nine digits. */
export function isValidNpi(value: string): boolean {
  if (!/^\d{10}$/.test(value)) return false;
  const digits = `80840${value.slice(0, 9)}`;
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let d = Number(digits.charAt(digits.length - 1 - i));
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10 === Number(value.charAt(9));
}

/** "National Provider Identifiers will be validated against the NPI algorithm" (NOE companion guide). */
export function npi(value: string, field: string): string {
  if (!isValidNpi(value)) throw new X12BuildError(field);
  return value;
}

export function d8(iso: string, field: string): string {
  try {
    return isoToX12Date(iso);
  } catch {
    throw new X12BuildError(field);
  }
}

const two = (n: number): string => String(n).padStart(2, "0");
const pad = (value: string, width: number): string => value.padEnd(width, " ").slice(0, width);

export function addressSegments(a: X12Address, field: string): string[][] {
  const zip = a.postalCode.replace("-", "");
  if (!/^\d{5}(\d{4})?$/.test(zip)) throw new X12BuildError(`${field}.postalCode`);
  if (!/^[A-Z]{2}$/.test(a.state.trim().toUpperCase())) throw new X12BuildError(`${field}.state`);
  const line2 = optionalText(a.line2, `${field}.line2`, 55);
  return [
    ["N3", text(a.line1, `${field}.line1`, 55), ...(line2 ? [line2] : [])],
    ["N4", text(a.city, `${field}.city`, 30), a.state.trim().toUpperCase(), zip],
  ];
}

/** `NM1` for an individual provider: qualifier 71 attending, DN referring/other. */
export function physicianName(p: X12Physician, qualifier: "71" | "DN", field: string): string[] {
  return [
    "NM1",
    qualifier,
    "1",
    text(p.lastName, `${field}.lastName`, NAME_LIMIT),
    text(p.firstName, `${field}.firstName`, 35),
    optionalText(p.middleInitial, `${field}.middleInitial`, 1),
    "",
    "",
    "XX",
    npi(p.npi, `${field}.npi`),
  ];
}

/** An `HI` segment of `qualifier:value` composites, or none when empty. */
export function hi(qualifier: string, values: readonly string[]): string[][] {
  return values.length === 0 ? [] : [["HI", ...values.map((v) => `${qualifier}:${v}`)]];
}

export interface PreparedEnvelope {
  readonly sender: string;
  readonly receiver: string;
  readonly applicationReceiver: string;
  readonly controlNumber: number;
  readonly usage: "P" | "T";
  /** The envelope's creation date (CCYYMMDD) and time (HHMM), UTC — for BHT04/BHT05 too. */
  readonly stamp: { readonly ccyymmdd: string; readonly hhmm: string };
}

/** Validate the envelope up front so a bad control number fails before any body is built. */
export function prepareEnvelope(envelope: X12Envelope): PreparedEnvelope {
  const sender = text(envelope.senderId, "envelope.senderId", 15);
  const receiver = text(envelope.receiverId, "envelope.receiverId", 15);
  const applicationReceiver = text(
    envelope.applicationReceiverCode,
    "envelope.applicationReceiverCode",
    15,
  );
  const n = envelope.interchangeControlNumber;
  if (!Number.isInteger(n) || n < 1 || n > MAX_CONTROL_NUMBER) {
    throw new X12BuildError("envelope.interchangeControlNumber");
  }
  if (envelope.usage !== "P" && envelope.usage !== "T") throw new X12BuildError("envelope.usage");
  const d = envelope.createdAt;
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) {
    throw new X12BuildError("envelope.createdAt");
  }
  return {
    sender,
    receiver,
    applicationReceiver,
    controlNumber: n,
    usage: envelope.usage,
    stamp: {
      ccyymmdd: `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`,
      hhmm: `${two(d.getUTCHours())}${two(d.getUTCMinutes())}`,
    },
  };
}

/** One 837 transaction set: the body segments (everything between ST and SE). */
export interface TransactionSet {
  readonly transactionSet: "837";
  readonly body: readonly (readonly string[])[];
}

/** Wrap a body in ISA/GS/ST … SE/GE/IEA (one ST-SE per GS-GE per ISA-IEA). */
export function wrapTransaction(env: PreparedEnvelope, tx: TransactionSet): string {
  const { ccyymmdd, hhmm } = env.stamp;
  const icn = String(env.controlNumber);
  const isa13 = icn.padStart(9, "0");
  const st02 = icn.padStart(4, "0");
  const segments: (readonly string[])[] = [
    [
      "ISA",
      "00",
      pad("", 10),
      "00",
      pad("", 10),
      "ZZ",
      pad(env.sender, 15),
      "ZZ",
      pad(env.receiver, 15),
      ccyymmdd.slice(2),
      hhmm,
      "^",
      "00501",
      isa13,
      "1",
      env.usage,
      ":",
    ],
    [
      "GS",
      "HC",
      env.sender,
      env.applicationReceiver,
      ccyymmdd,
      hhmm,
      icn,
      "X",
      IMPLEMENTATION_GUIDE,
    ],
    ["ST", tx.transactionSet, st02, IMPLEMENTATION_GUIDE],
    ...tx.body,
    ["SE", String(tx.body.length + 2), st02],
    ["GE", "1", icn],
    ["IEA", "1", isa13],
  ];
  return segments.map((seg) => `${seg.join("*")}~`).join("");
}
