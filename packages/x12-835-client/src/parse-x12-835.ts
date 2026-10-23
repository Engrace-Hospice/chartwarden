// @chartwarden/x12-835-client — pure-TypeScript X12 5010 835 parser (ADR-0037: X12 parsing is TypeScript,
// in-monorepo; no sidecar). raw 835 text -> ParsedRemittanceAdvice, or a degraded envelope. FAIL CLOSED:
// envelope/control-number/segment-count mismatches, non-835 sets, malformed amounts and unbalanced
// remittances all return a non-retryable degraded result; partial data is never returned as good.
// Money is parsed from the decimal text into integer cents (no float math) and emitted as cents/100.
import { checkClaimBalance, checkPaymentBalance, type CentsAdjustment } from "./balance-835";
import {
  type ParsedAdjustment,
  type ParsedCasGroupCode,
  type ParsedClaim835,
  type ParsedPaymentMethod,
  type ParsedRemark,
  type ParsedRemittanceAdvice,
  type ParsedServiceLine,
  type PayerProgram,
  type X12WorkerResult,
  degraded835,
} from "./types";
import { X12ParseError, elem, segId, tokenizeX12, type X12Segment } from "./x12-tokenizer";

const CAS_GROUPS: ReadonlySet<string> = new Set(["CO", "CR", "OA", "PI", "PR"]);
const PAYMENT_METHODS: Readonly<Record<string, ParsedPaymentMethod>> = {
  CHK: "check",
  ACH: "eft",
  FWT: "eft",
  BOP: "eft",
  NON: "non_payment_remit",
};
const MAX_CAS_TRIPLETS = 6;

function fail(message: string): never {
  throw new X12ParseError("X12_835_PARSE_FAILED", message);
}

/** Decimal text -> integer cents. At most 2 significant decimals; anything else fails closed. */
function toCents(v: string, field: string): number {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(v.trim());
  if (!m || (!m[2] && !m[3])) return fail(`${field} is not a decimal amount`);
  const frac = (m[3] ?? "").replace(/0+$/, "");
  if (frac.length > 2) return fail(`${field} has more than 2 decimal places`);
  const n = Number((m[2] || "0") + frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(n)) return fail(`${field} is out of range`);
  return m[1] === "-" && n !== 0 ? -n : n;
}

function toIsoDate(v: string, field: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (!m) return fail(`${field} is not a CCYYMMDD date`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return fail(`${field} is not a real calendar date`);
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function toNumber(v: string, field: string): number {
  const n = Number(v);
  if (v.trim() === "" || !Number.isFinite(n)) return fail(`${field} is not numeric`);
  return n;
}

interface AdjDraft extends CentsAdjustment {
  readonly adj: ParsedAdjustment;
}

function parseCas(seg: X12Segment): AdjDraft[] {
  const group = elem(seg, 1);
  if (!CAS_GROUPS.has(group)) return fail("CAS01 is not a valid adjustment group code");
  const out: AdjDraft[] = [];
  for (let t = 0; t < MAX_CAS_TRIPLETS; t++) {
    const base = 2 + t * 3;
    const reason = elem(seg, base);
    if (!reason) break;
    const cents = toCents(elem(seg, base + 1), "CAS amount");
    const qty = elem(seg, base + 2);
    out.push({
      groupCode: group,
      cents,
      adj: {
        groupCode: group as ParsedCasGroupCode,
        reasonCode: reason,
        amount: cents / 100,
        ...(qty ? { quantity: toNumber(qty, "CAS quantity") } : {}),
      },
    });
  }
  if (out.length === 0) return fail("CAS carries no reason code");
  return out;
}

function remarksOf(seg: X12Segment): ParsedRemark[] {
  const id = segId(seg);
  if (id === "LQ") {
    return elem(seg, 1) === "HE" && elem(seg, 2) ? [{ kind: "LQ", code: elem(seg, 2) }] : [];
  }
  const idx = id === "MOA" ? [3, 4, 5, 6, 7] : [5, 20, 21, 22, 23, 24];
  return idx
    .map((i) => elem(seg, i))
    .filter((c) => c !== "")
    .map((code) => ({ kind: id as "MIA" | "MOA", code }));
}

interface LineDraft {
  procedureCode?: string;
  revenueCode?: string;
  charge: number;
  paid: number;
  paidUnits?: number;
  submittedUnits?: number;
  adjs: AdjDraft[];
  remarks: ParsedRemark[];
}
interface ClaimDraft {
  patientControlNumber?: string;
  payerIcn?: string;
  statusCode: number;
  charge: number;
  paid: number;
  patientResponsibility: number;
  patientMemberId?: string;
  serviceFrom?: string;
  serviceTo?: string;
  adjs: AdjDraft[];
  remarks: ParsedRemark[];
  lines: LineDraft[];
}

function newClaim(seg: X12Segment): ClaimDraft {
  const status = elem(seg, 2);
  if (!/^\d+$/.test(status)) fail("CLP02 is not a claim status code");
  const pcn = elem(seg, 1);
  const icn = elem(seg, 7);
  return {
    ...(pcn ? { patientControlNumber: pcn } : {}),
    ...(icn ? { payerIcn: icn } : {}),
    statusCode: Number(status),
    charge: toCents(elem(seg, 3), "CLP03"),
    paid: toCents(elem(seg, 4), "CLP04"),
    patientResponsibility: elem(seg, 5) ? toCents(elem(seg, 5), "CLP05") : 0,
    adjs: [],
    remarks: [],
    lines: [],
  };
}

function newLine(seg: X12Segment, compSep: string): LineDraft {
  const [qual, code] = elem(seg, 1).split(compSep);
  if (!qual || !code) fail("SVC01 is not a qualifier:code composite");
  const rev = elem(seg, 4);
  const units = elem(seg, 5);
  const sub = elem(seg, 7);
  return {
    ...(qual === "NU" ? { revenueCode: code } : { procedureCode: code }),
    ...(rev ? { revenueCode: rev } : {}),
    charge: toCents(elem(seg, 2), "SVC02"),
    paid: toCents(elem(seg, 3), "SVC03"),
    ...(units ? { paidUnits: toNumber(units, "SVC05") } : {}),
    ...(sub ? { submittedUnits: toNumber(sub, "SVC07") } : {}),
    adjs: [],
    remarks: [],
  };
}

function applyClaimSegment(claim: ClaimDraft, seg: X12Segment): void {
  const id = segId(seg);
  const line = claim.lines[claim.lines.length - 1];
  if (id === "CAS") (line ?? claim).adjs.push(...parseCas(seg));
  else if (id === "LQ") (line ?? claim).remarks.push(...remarksOf(seg));
  else if (id === "MIA" || id === "MOA") claim.remarks.push(...remarksOf(seg));
  else if (id === "AMT") toCents(elem(seg, 2), "AMT02");
  else if (id === "NM1" && (elem(seg, 1) === "QC" || elem(seg, 1) === "IL") && elem(seg, 9)) {
    if (elem(seg, 1) === "QC" || !claim.patientMemberId) claim.patientMemberId = elem(seg, 9);
  } else if (id === "DTM" && !line) {
    const q = elem(seg, 1);
    if (q === "232") claim.serviceFrom = toIsoDate(elem(seg, 2), "DTM232");
    else if (q === "233") claim.serviceTo = toIsoDate(elem(seg, 2), "DTM233");
  }
}

const toLine = (l: LineDraft): ParsedServiceLine => ({
  ...(l.procedureCode ? { procedureCode: l.procedureCode } : {}),
  ...(l.revenueCode ? { revenueCode: l.revenueCode } : {}),
  chargeAmount: l.charge / 100,
  paidAmount: l.paid / 100,
  ...(l.paidUnits !== undefined ? { paidUnits: l.paidUnits } : {}),
  ...(l.submittedUnits !== undefined ? { submittedUnits: l.submittedUnits } : {}),
  adjustments: l.adjs.map((a) => a.adj),
  remarks: l.remarks,
});

const toClaim = (c: ClaimDraft): ParsedClaim835 => ({
  ...(c.patientControlNumber ? { patientControlNumber: c.patientControlNumber } : {}),
  ...(c.payerIcn ? { payerIcn: c.payerIcn } : {}),
  statusCode: c.statusCode,
  totalCharge: c.charge / 100,
  totalPayment: c.paid / 100,
  patientResponsibility: c.patientResponsibility / 100,
  ...(c.patientMemberId ? { patientMemberId: c.patientMemberId } : {}),
  ...(c.serviceFrom ? { serviceFrom: c.serviceFrom } : {}),
  ...(c.serviceTo ? { serviceTo: c.serviceTo } : {}),
  adjustments: c.adjs.map((a) => a.adj),
  remarks: c.remarks,
  serviceLines: c.lines.map(toLine),
});

/** Validate ISA..IEA / GS..GE / ST..SE; returns the segments strictly between ST and SE. */
function unwrapEnvelope(segs: readonly X12Segment[]): {
  isa13: string;
  st02: string;
  body: readonly X12Segment[];
} {
  const ids = segs.map(segId);
  const at = (id: string): number[] => ids.flatMap((x, i) => (x === id ? [i] : []));
  const [isa, gs, st, se, ge, iea] = ["ISA", "GS", "ST", "SE", "GE", "IEA"].map(at);
  if (ids[0] !== "ISA" || ids[ids.length - 1] !== "IEA") fail("interchange is not wrapped in ISA..IEA");
  if (isa?.length !== 1 || iea?.length !== 1) fail("expected exactly one ISA/IEA");
  if (gs?.length !== 1 || ge?.length !== 1) fail("expected exactly one GS/GE functional group");
  if (st?.length !== 1 || se?.length !== 1) fail("expected exactly one ST/SE transaction set per file");
  const [isaS, gsS, stS, seS, geS, ieaS] = [isa, gs, st, se, ge, iea].map((x) => segs[(x as number[])[0] as number] as X12Segment);
  const [iPos, gPos, sPos, ePos, geP] = [isa, gs, st, se, ge].map((x) => (x as number[])[0] as number);
  if (!(gPos! < sPos! && sPos! < ePos! && ePos! < geP! && geP! < segs.length - 1)) fail("envelope segments are out of order");
  const isa13 = elem(isaS!, 13);
  const st02 = elem(stS!, 2);
  if (!isa13) fail("missing ISA13 interchange control number");
  if (!st02) fail("missing ST02 transaction set control number");
  if (elem(stS!, 1) !== "835") fail(`transaction set is not an 835 (ST01=${elem(stS!, 1)})`);
  if (elem(seS!, 2) !== st02) fail("SE02 does not match ST02");
  if (elem(seS!, 1) !== String(ePos! - sPos! + 1)) fail("SE01 segment count does not match the transaction set");
  if (elem(gsS!, 6) === "" || elem(geS!, 2) !== elem(gsS!, 6)) fail("GE02 does not match GS06");
  if (elem(geS!, 1) !== "1") fail("GE01 transaction-set count is not 1");
  if (elem(ieaS!, 2) !== isa13) fail("IEA02 does not match ISA13");
  if (elem(ieaS!, 1) !== "1") fail("IEA01 functional-group count is not 1");
  return { isa13, st02, body: segs.slice(sPos! + 1, ePos!) };
}

function parsePlb(seg: X12Segment): number[] {
  const out: number[] = [];
  for (let i = 3; i < seg.el.length; i += 2) {
    const reason = elem(seg, i);
    const amount = elem(seg, i + 1);
    if (!reason && !amount) continue;
    if (!reason || !amount) fail("PLB reason/amount pair is incomplete");
    out.push(toCents(amount, "PLB amount"));
  }
  return out;
}

function build(raw: string, payerProgram: PayerProgram): ParsedRemittanceAdvice {
  const doc = tokenizeX12(raw);
  const { isa13, st02, body } = unwrapEnvelope(doc.segments);
  let bpr: X12Segment | undefined;
  let trn: X12Segment | undefined;
  let dtm405: string | undefined;
  const parties = new Set<string>();
  const claims: ClaimDraft[] = [];
  const plb: number[] = [];
  for (const seg of body) {
    const id = segId(seg);
    const current = claims[claims.length - 1];
    if (id === "BPR") {
      if (bpr) fail("more than one BPR");
      bpr = seg;
    } else if (id === "TRN" && !current) {
      if (trn) fail("more than one TRN");
      trn = seg;
    } else if (id === "CLP") {
      if (!bpr || !trn) fail("CLP before BPR/TRN");
      claims.push(newClaim(seg));
    } else if (id === "PLB") plb.push(...parsePlb(seg));
    else if (id === "SVC") (current ?? fail("SVC outside a CLP")).lines.push(newLine(seg, doc.componentSeparator));
    else if (id === "N1" && !current) parties.add(elem(seg, 1));
    else if (current) applyClaimSegment(current, seg);
    else if (id === "CAS") fail("CAS outside a CLP");
    else if (id === "DTM" && elem(seg, 1) === "405") dtm405 = toIsoDate(elem(seg, 2), "DTM405");
  }
  if (!bpr) fail("missing BPR");
  if (!trn) fail("missing TRN");
  if (!parties.has("PR") || !parties.has("PE")) fail("missing N1 payer (PR) or payee (PE) loop");
  const method = PAYMENT_METHODS[elem(bpr, 4)];
  if (!method) fail("BPR04 is not a supported payment method");
  if (elem(bpr, 3) !== "C") fail("BPR03 is not C (credit); debit remittances are unsupported");
  const trace = elem(trn, 2);
  if (!trace) fail("missing TRN02 trace number");
  const production = elem(bpr, 16) ? toIsoDate(elem(bpr, 16), "BPR16") : dtm405;
  if (!production) fail("missing BPR16/DTM405 production date");
  claims.forEach((c, i) =>
    checkClaimBalance(
      {
        statusCode: c.statusCode,
        charge: c.charge,
        paid: c.paid,
        patientResponsibility: c.patientResponsibility,
        adjustments: c.adjs,
        lines: c.lines.map((l) => ({ charge: l.charge, paid: l.paid, adjustments: l.adjs })),
      },
      i + 1,
    ),
  );
  const total = toCents(elem(bpr, 2), "BPR02");
  checkPaymentBalance(total, claims.map((c) => c.paid), plb);
  return {
    payerProgram,
    interchangeControlNumber: isa13,
    transactionSetControlNumber: st02,
    checkOrEftTraceNumber: trace,
    paymentMethod: method,
    totalPaymentAmount: total / 100,
    productionDate: `${production}T00:00:00Z`,
    claims: claims.map(toClaim),
  };
}

/** Parse raw 835 text. Never throws: any failure is a non-retryable degraded envelope (PHI-free reason). */
export function parseX12835(
  raw: string,
  payerProgram: PayerProgram,
): X12WorkerResult<ParsedRemittanceAdvice> {
  try {
    return { ok: true, value: build(raw, payerProgram) };
  } catch (err) {
    if (err instanceof X12ParseError) return degraded835(err.code, err.message, "parse835", false);
    return degraded835("X12_835_PARSE_FAILED", "unexpected parser failure", "parse835", false);
  }
}
