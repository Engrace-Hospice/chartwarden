import { createHash } from "node:crypto";

export interface X12ClaimEvidence {
  readonly billingNpi: string;
  readonly billingTin: string;
  readonly payerId: string;
  readonly pcn: string;
  readonly claimType: string;
  readonly serviceFrom: string | null;
  readonly serviceTo: string | null;
  readonly isa13: string;
  readonly gs06: string;
  readonly st02: string;
  /** Service-line facts extracted from the exact outbound 837 bytes. References are absent unless REF*6R was sent. */
  readonly serviceLines: readonly X12SubmittedServiceLineEvidence[];
}

export interface X12SubmittedServiceLineEvidence {
  readonly position: number;
  readonly lineItemControlNumber: string | null;
  readonly revenueCode: string | null;
  readonly procedureCode: string | null;
  readonly serviceFrom: string | null;
  readonly serviceTo: string | null;
  readonly units: string | null;
  readonly chargeCents: number | null;
}

type PendingSubmittedServiceLine = {
  lineItemControlNumber: string | null;
  revenueCode: string | null;
  procedureCode: string | null;
  serviceFrom: string | null;
  serviceTo: string | null;
  units: string | null;
  chargeCents: number | null;
};

export interface X12SubmissionEvidence {
  readonly payloadSha256: string;
  readonly transactionSet: "837I" | "837P";
  readonly claims: readonly X12ClaimEvidence[];
}

export class X12EvidenceError extends Error {
  constructor(
    readonly code:
      | "INVALID_X12"
      | "UNSUPPORTED_TRANSACTION"
      | "INCOMPLETE_IDENTITY"
      | "CONTROL_MISMATCH",
  ) {
    super(code);
    this.name = "X12EvidenceError";
  }
}

/** Extracts only the explicitly supported billing-provider/payer/claim loop values from final X12 bytes. */
export function extractX12SubmissionEvidence(
  x12: string,
  expectedControlNumber?: string,
): X12SubmissionEvidence {
  if (typeof x12 !== "string" || x12.length < 106 || !x12.startsWith("ISA"))
    throw new X12EvidenceError("INVALID_X12");
  const element = x12[3];
  const segment = x12[105];
  if (!element || !segment || element === segment) throw new X12EvidenceError("INVALID_X12");
  const rawSegments = x12
    .split(segment)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!rawSegments[0]?.startsWith("ISA")) throw new X12EvidenceError("INVALID_X12");
  const segments = rawSegments.map((raw) => raw.split(element));
  const isa = segments[0]!;
  if (isa[0] !== "ISA" || !isa[13] || !isa[13].trim()) throw new X12EvidenceError("INVALID_X12");
  const isa13 = isa[13].trim();
  if (expectedControlNumber && isa13 !== expectedControlNumber)
    throw new X12EvidenceError("CONTROL_MISMATCH");

  let gs06 = "";
  let gsImplementation = "";
  let st02 = "";
  let transactionSet: "837I" | "837P" | null = null;
  let billNpi: string | null = null;
  let billTin: string | null = null;
  let payerId: string | null = null;
  let currentClaim: Omit<X12ClaimEvidence, "serviceLines"> | null = null;
  const claims: X12ClaimEvidence[] = [];
  let serviceFrom: string | null = null;
  let serviceTo: string | null = null;
  let serviceLines: X12SubmittedServiceLineEvidence[] = [];
  let currentServiceLine: PendingSubmittedServiceLine | null = null;
  let nextLinePosition = 0;

  const finishServiceLine = () => {
    if (!currentServiceLine) return;
    serviceLines.push({ ...currentServiceLine, position: ++nextLinePosition });
    currentServiceLine = null;
  };
  const updateServiceLine = (patch: Partial<PendingSubmittedServiceLine>) => {
    if (currentServiceLine) currentServiceLine = { ...currentServiceLine, ...patch };
  };

  const finishClaim = () => {
    if (!currentClaim) return;
    finishServiceLine();
    if (!billNpi || !billTin || !payerId) throw new X12EvidenceError("INCOMPLETE_IDENTITY");
    claims.push({
      ...currentClaim,
      billingNpi: billNpi,
      billingTin: billTin,
      payerId,
      serviceFrom,
      serviceTo,
      serviceLines,
    });
    currentClaim = null;
  };

  for (const s of segments.slice(1)) {
    const tag = s[0];
    if (tag === "GS") gs06 = s[6]?.trim() ?? "";
    if (tag === "GE" && (!gs06 || s[2]?.trim() !== gs06))
      throw new X12EvidenceError("CONTROL_MISMATCH");
    if (tag === "ST") {
      st02 = s[2]?.trim() ?? "";
      if (s[1]?.trim() !== "837") throw new X12EvidenceError("UNSUPPORTED_TRANSACTION");
      if (s[3]?.trim() && s[3].trim() !== gsImplementation)
        throw new X12EvidenceError("CONTROL_MISMATCH");
      billNpi = null;
      billTin = null;
      payerId = null;
      serviceLines = [];
      currentServiceLine = null;
      nextLinePosition = 0;
    }
    if (tag === "GS" && s[1]?.trim() === "HC") {
      gsImplementation = s[8]?.trim() ?? "";
      const implementation = gsImplementation;
      const nextType =
        implementation === "005010X223A2" || implementation === "005010X223A3"
          ? "837I"
          : implementation === "005010X222A1"
            ? "837P"
            : null;
      if (transactionSet && transactionSet !== nextType)
        throw new X12EvidenceError("UNSUPPORTED_TRANSACTION");
      if (nextType) transactionSet = nextType;
      else throw new X12EvidenceError("UNSUPPORTED_TRANSACTION");
    }
    if (tag === "NM1" && s[1] === "85") {
      billNpi = s[8] === "XX" ? s[9]?.trim() || null : null;
      billTin = null;
    } else if (tag === "REF" && s[1] === "EI" && billNpi && !currentClaim) {
      billTin = s[2]?.trim() || null;
    } else if (tag === "NM1" && s[1] === "PR") {
      payerId = s[8] === "PI" ? s[9]?.trim() || null : null;
    } else if (tag === "CLM") {
      finishClaim();
      if (
        !billNpi ||
        !/^\d{10}$/.test(billNpi) ||
        !billTin ||
        !/^\d{9}$/.test(billTin) ||
        !payerId ||
        !s[1]?.trim()
      )
        throw new X12EvidenceError("INCOMPLETE_IDENTITY");
      const composite = s[5]?.split(":") ?? [];
      currentClaim = {
        pcn: s[1].trim(),
        claimType: composite.join(":"),
        billingNpi: billNpi,
        billingTin: billTin,
        payerId,
        serviceFrom: null,
        serviceTo: null,
        isa13,
        gs06,
        st02,
      };
      serviceFrom = null;
      serviceTo = null;
      serviceLines = [];
      currentServiceLine = null;
      nextLinePosition = 0;
    } else if (tag === "LX" && currentClaim) {
      finishServiceLine();
      currentServiceLine = {
        lineItemControlNumber: null,
        revenueCode: null,
        procedureCode: null,
        serviceFrom: null,
        serviceTo: null,
        units: null,
        chargeCents: null,
      };
    } else if (tag === "SV2" && currentClaim && currentServiceLine !== null) {
      const procedure = s[2]?.split(":") ?? [];
      updateServiceLine({
        revenueCode: s[1]?.trim() || null,
        procedureCode: procedure[1]?.trim() || null,
        chargeCents: decimalX12Cents(s[3]),
        units: s[5]?.trim() || null,
      });
    } else if (tag === "SV1" && currentClaim && currentServiceLine !== null) {
      const procedure = s[1]?.split(":") ?? [];
      updateServiceLine({
        procedureCode: procedure[1]?.trim() || null,
        chargeCents: decimalX12Cents(s[2]),
        units: s[4]?.trim() || null,
      });
    } else if (tag === "REF" && s[1]?.trim() === "6R" && currentServiceLine) {
      updateServiceLine({ lineItemControlNumber: s[2]?.trim() || null });
    } else if (tag === "DTP" && currentServiceLine && s[1]?.trim() === "472") {
      const value = s[3]?.trim() ?? "";
      updateServiceLine(
        s[2] === "D8" && /^\d{8}$/.test(value)
          ? { serviceFrom: value, serviceTo: value }
          : s[2] === "RD8" && /^\d{8}-\d{8}$/.test(value)
            ? { serviceFrom: value.slice(0, 8), serviceTo: value.slice(9) }
            : {},
      );
    } else if (tag === "DTP" && currentClaim && s[1] === "434") {
      const value = s[3]?.trim();
      if (s[2] === "D8" && value && /^\d{8}$/.test(value)) serviceFrom = value;
      if (s[2] === "RD8" && value && /^\d{8}-\d{8}$/.test(value)) {
        [serviceFrom, serviceTo] = value.split("-") as [string, string];
      }
    }
    if (tag === "SE") {
      if (!st02 || s[2]?.trim() !== st02) throw new X12EvidenceError("CONTROL_MISMATCH");
      finishServiceLine();
      finishClaim();
    }
    if (tag === "IEA" && s[2]?.trim() !== isa13) throw new X12EvidenceError("CONTROL_MISMATCH");
  }
  finishClaim();
  if (
    !segments.some((s) => s[0] === "SE") ||
    !segments.some((s) => s[0] === "GE") ||
    !segments.some((s) => s[0] === "IEA")
  )
    throw new X12EvidenceError("INVALID_X12");
  if (claims.length === 0) throw new X12EvidenceError("INCOMPLETE_IDENTITY");
  if (!transactionSet) throw new X12EvidenceError("UNSUPPORTED_TRANSACTION");
  return {
    payloadSha256: createHash("sha256").update(Buffer.from(x12, "utf8")).digest("hex"),
    transactionSet,
    claims,
  };
}

function decimalX12Cents(raw: string | undefined): number | null {
  const value = raw?.trim() ?? "";
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const amount = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0") || "0");
  if (!Number.isSafeInteger(amount)) return null;
  return match[1] ? -amount : amount;
}
