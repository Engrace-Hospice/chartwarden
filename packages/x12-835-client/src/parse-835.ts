// @chartwarden/x12-835-client — the wire→typed mapper for the sidecar's /parse835 JSON response. PURE: no IO.
// The Python `x12-worker` does the pyx12 segment parsing; this maps its JSON into ParsedRemittanceAdvice
// and fails closed (degraded, never throws) on a malformed envelope. Imports ONLY ./types (no ./index —
// the no-circular rule).
import {
  type ParsedAdjustment,
  type ParsedCasGroupCode,
  type ParsedClaim835,
  type ParsedPaymentMethod,
  type ParsedRemark,
  type ParsedRemarkKind,
  type ParsedRemittanceAdvice,
  type ParsedServiceLine,
  type PayerProgram,
  type X12WorkerResult,
  degraded835,
} from "./types";

const CAS_GROUPS: ReadonlySet<string> = new Set(["CO", "CR", "OA", "PI", "PR"]);
const REMARK_KINDS: ReadonlySet<string> = new Set(["LQ", "MIA", "MOA"]);
const PAYMENT_METHODS: ReadonlySet<string> = new Set(["check", "eft", "non_payment_remit"]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function num(v: unknown, fallback = 0): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function mapAdjustment(w: unknown): ParsedAdjustment | null {
  if (!isObj(w)) return null;
  const groupCode = str(w.groupCode);
  const reasonCode = str(w.reasonCode);
  if (!groupCode || !CAS_GROUPS.has(groupCode) || !reasonCode) return null;
  return {
    groupCode: groupCode as ParsedCasGroupCode,
    reasonCode,
    amount: num(w.amount),
    ...(w.quantity !== undefined ? { quantity: num(w.quantity) } : {}),
  };
}

function mapRemark(w: unknown): ParsedRemark | null {
  if (!isObj(w)) return null;
  const kind = str(w.kind);
  const code = str(w.code);
  if (!kind || !REMARK_KINDS.has(kind) || !code) return null;
  return { kind: kind as ParsedRemarkKind, code, ...(str(w.text) ? { text: str(w.text)! } : {}) };
}

function mapServiceLine(w: unknown): ParsedServiceLine {
  const o = isObj(w) ? w : {};
  return {
    ...(str(o.procedureCode) ? { procedureCode: str(o.procedureCode)! } : {}),
    ...(str(o.revenueCode) ? { revenueCode: str(o.revenueCode)! } : {}),
    chargeAmount: num(o.chargeAmount),
    paidAmount: num(o.paidAmount),
    ...(o.paidUnits !== undefined ? { paidUnits: num(o.paidUnits) } : {}),
    ...(o.submittedUnits !== undefined ? { submittedUnits: num(o.submittedUnits) } : {}),
    adjustments: Array.isArray(o.adjustments)
      ? o.adjustments.map(mapAdjustment).filter((a): a is ParsedAdjustment => a !== null)
      : [],
    remarks: Array.isArray(o.remarks)
      ? o.remarks.map(mapRemark).filter((r): r is ParsedRemark => r !== null)
      : [],
  };
}

function mapClaim(w: unknown): ParsedClaim835 | null {
  if (!isObj(w)) return null;
  if (w.statusCode === undefined) return null;
  return {
    ...(str(w.patientControlNumber) ? { patientControlNumber: str(w.patientControlNumber)! } : {}),
    ...(str(w.payerIcn) ? { payerIcn: str(w.payerIcn)! } : {}),
    statusCode: num(w.statusCode),
    totalCharge: num(w.totalCharge),
    totalPayment: num(w.totalPayment),
    patientResponsibility: num(w.patientResponsibility),
    ...(str(w.patientMemberId) ? { patientMemberId: str(w.patientMemberId)! } : {}),
    ...(str(w.serviceFrom) ? { serviceFrom: str(w.serviceFrom)! } : {}),
    ...(str(w.serviceTo) ? { serviceTo: str(w.serviceTo)! } : {}),
    adjustments: Array.isArray(w.adjustments)
      ? w.adjustments.map(mapAdjustment).filter((a): a is ParsedAdjustment => a !== null)
      : [],
    remarks: Array.isArray(w.remarks)
      ? w.remarks.map(mapRemark).filter((r): r is ParsedRemark => r !== null)
      : [],
    serviceLines: Array.isArray(w.serviceLines) ? w.serviceLines.map(mapServiceLine) : [],
  };
}

/**
 * Map the sidecar's /parse835 JSON into a typed {@link ParsedRemittanceAdvice}. `payerProgram` is supplied
 * by the M25 puller (the sidecar parses the same X12 5010 envelope regardless of program). Returns a
 * degraded envelope (retryable=false — a malformed file does not get better on retry) rather than throwing.
 */
export function mapParsed835(
  wire: unknown,
  payerProgram: PayerProgram,
): X12WorkerResult<ParsedRemittanceAdvice> {
  if (!isObj(wire)) {
    return degraded835(
      "X12_835_PARSE_FAILED",
      "sidecar response was not an object",
      "parse835",
      false,
    );
  }
  const isa = str(wire.interchangeControlNumber);
  const st = str(wire.transactionSetControlNumber);
  if (!isa || !st) {
    return degraded835(
      "X12_835_PARSE_FAILED",
      "missing ISA13/ST02 control numbers",
      "parse835",
      false,
    );
  }
  const paymentMethod = str(wire.paymentMethod);
  if (!paymentMethod || !PAYMENT_METHODS.has(paymentMethod)) {
    return degraded835(
      "X12_835_PARSE_FAILED",
      "missing/invalid BPR04 payment method",
      "parse835",
      false,
    );
  }
  const claimsRaw = Array.isArray(wire.claims) ? wire.claims : [];
  const claims = claimsRaw.map(mapClaim).filter((c): c is ParsedClaim835 => c !== null);
  return {
    ok: true,
    value: {
      payerProgram,
      interchangeControlNumber: isa,
      transactionSetControlNumber: st,
      ...(str(wire.checkOrEftTraceNumber)
        ? { checkOrEftTraceNumber: str(wire.checkOrEftTraceNumber)! }
        : {}),
      paymentMethod: paymentMethod as ParsedPaymentMethod,
      totalPaymentAmount: num(wire.totalPaymentAmount),
      productionDate: str(wire.productionDate) ?? "",
      claims,
    },
  };
}
