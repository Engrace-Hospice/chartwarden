// @chartwarden/x12-835-client — pure-TypeScript X12 5010 835 parser (ADR-0037: X12 parsing is TypeScript,
// in-monorepo; no sidecar). raw 835 text -> ParsedRemittanceAdvice, or a degraded envelope. FAIL CLOSED:
// envelope/control-number/segment-count mismatches, non-835 sets, malformed amounts and unbalanced
// remittances all return a non-retryable degraded result; partial data is never returned as good.
// Money is parsed from the decimal text into integer cents (no float math) and emitted as cents/100.
//
// Current-behavior limits (deliberate; tracked as follow-ups, not silent):
//  - one ST/SE transaction set per file (a second one is rejected);
//  - SVC01 qualifier is validated only (modifiers and SVC06 are surfaced);
//  - the production date is BPR16, falling back to DTM*405 (label not reconciled with the spec);
//  - BPR02 = 0 does not force BPR04 = NON;
//  - test files (ISA15 != P) are rejected unless `allowTestFiles` is set; only GS01=HP / GS08=005010X221* pass.
import { type CentsAdjustment, checkClaimBalance, checkPaymentBalance } from "./balance-835";
import {
  type ParsedAdjustment,
  type ParsedCasGroupCode,
  type ParsedClaim835,
  type ParsedPaymentMethod,
  type ParsedRemark,
  type ParsedRemittanceAdvice,
  type ParsedRemittanceParty,
  type ParsedServiceLine,
  type PayerProgram,
  type X12WorkerResult,
  degraded835,
} from "./types";
import { X12ParseError, type X12Segment, elem, segId, tokenizeX12 } from "./x12-tokenizer";

const CAS_GROUPS: ReadonlySet<string> = new Set(["CO", "CR", "OA", "PI", "PR"]);
const PAYMENT_METHODS: Readonly<Record<string, ParsedPaymentMethod>> = {
  CHK: "check",
  ACH: "eft",
  FWT: "eft",
  BOP: "eft",
  NON: "non_payment_remit",
};
const MAX_CAS_TRIPLETS = 6;
const MAX_MODIFIERS = 4;
/** numeric(12,2) ceiling (9,999,999,999.99): a larger sum would fail at insert, so refuse it at parse. */
const MAX_CENTS = 999_999_999_999;
const CLAIM_STATUSES: ReadonlySet<number> = new Set([1, 2, 3, 4, 19, 20, 21, 22, 23, 25]);
const SVC_QUALIFIERS: ReadonlySet<string> = new Set([
  "AD",
  "ER",
  "HC",
  "HP",
  "IV",
  "N4",
  "N6",
  "NU",
  "UI",
  "WK",
]);

export interface ParseX12835Options {
  /** Accept interchanges flagged as test (ISA15 = T). Default false: test data must never post as real money. */
  readonly allowTestFiles?: boolean;
}

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
  if (n > MAX_CENTS) return fail(`${field} is out of range`);
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
  if (!/^-?\d+(\.\d+)?$/.test(v.trim())) return fail(`${field} is not numeric`);
  return Number(v);
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
    if (!reason) {
      // A blank triplet is skipped, not a terminator; a stray amount/quantity without a reason is malformed.
      if (elem(seg, base + 1) || elem(seg, base + 2)) fail("CAS amount without a reason code");
      continue;
    }
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
  const idx = id === "MOA" ? [3, 4, 5, 6, 7] : [5, 20, 21, 22, 23];
  return idx
    .map((i) => elem(seg, i))
    .filter((c) => c !== "")
    .map((code) => ({ kind: id as "MIA" | "MOA", code }));
}

interface LineDraft {
  procedureCode?: string;
  modifiers: string[];
  submittedProcedureCode?: string;
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
  if (!/^\d+$/.test(status) || !CLAIM_STATUSES.has(Number(status))) {
    fail("CLP02 is not a supported claim status code");
  }
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

/** Modifier slots are positional (SVC01-3..6 = modifier 1..4): keep gaps, drop only trailing empties. */
function trimTrailingEmpty(parts: readonly string[]): string[] {
  let end = parts.length;
  while (end > 0 && parts[end - 1] === "") end--;
  return parts.slice(0, end);
}

function newLine(seg: X12Segment, compSep: string): LineDraft {
  const [qual, code, ...mods] = elem(seg, 1).split(compSep);
  if (!qual || !code) fail("SVC01 is not a qualifier:code composite");
  if (mods.length > MAX_MODIFIERS) fail("SVC01 carries more than 4 modifiers");
  const [, submitted] = elem(seg, 6).split(compSep);
  if (!SVC_QUALIFIERS.has(qual))
    fail("SVC01 qualifier is not a supported product/service id qualifier");
  const rev = elem(seg, 4);
  const units = elem(seg, 5);
  const sub = elem(seg, 7);
  return {
    ...(qual === "NU" ? { revenueCode: code } : { procedureCode: code }),
    ...(rev ? { revenueCode: rev } : {}),
    modifiers: trimTrailingEmpty(mods),
    ...(submitted ? { submittedProcedureCode: submitted } : {}),
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
  ...(l.modifiers.length ? { modifiers: l.modifiers } : {}),
  ...(l.submittedProcedureCode ? { submittedProcedureCode: l.submittedProcedureCode } : {}),
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
function unwrapEnvelope(
  segs: readonly X12Segment[],
  opts: ParseX12835Options,
): { isa13: string; st02: string; body: readonly X12Segment[] } {
  const ids = segs.map(segId);
  const pos = (id: string): number[] => ids.flatMap((x, i) => (x === id ? [i] : []));
  if (ids[0] !== "ISA" || ids[ids.length - 1] !== "IEA")
    fail("interchange is not wrapped in ISA..IEA");
  const only = (id: string, msg: string): number => {
    const at = pos(id);
    if (at.length !== 1) fail(msg);
    return at[0] as number;
  };
  only("ISA", "expected exactly one ISA/IEA");
  only("IEA", "expected exactly one ISA/IEA");
  const gsAt = only("GS", "expected exactly one GS/GE functional group");
  const geAt = only("GE", "expected exactly one GS/GE functional group");
  const stAt = only("ST", "expected exactly one ST/SE transaction set per file");
  const seAt = only("SE", "expected exactly one ST/SE transaction set per file");
  if (!(gsAt < stAt && stAt < seAt && seAt < geAt && geAt < segs.length - 1)) {
    fail("envelope segments are out of order");
  }
  const [isa, gs, st, se, ge, iea] = [0, gsAt, stAt, seAt, geAt, segs.length - 1].map(
    (i) => segs[i] as X12Segment,
  ) as [X12Segment, X12Segment, X12Segment, X12Segment, X12Segment, X12Segment];
  const isa13 = elem(isa, 13);
  const st02 = elem(st, 2);
  if (!isa13) fail("missing ISA13 interchange control number");
  if (!st02) fail("missing ST02 transaction set control number");
  if (!opts.allowTestFiles && elem(isa, 15) !== "P")
    fail("interchange is not flagged production (ISA15 != P)");
  if (elem(gs, 1) !== "HP") fail("functional group is not a health care payment (GS01 != HP)");
  if (!elem(gs, 8).startsWith("005010X221")) fail("GS08 is not a 005010X221 (5010 835) version");
  if (elem(st, 1) !== "835") fail("transaction set is not an 835");
  if (elem(se, 2) !== st02) fail("SE02 does not match ST02");
  if (elem(se, 1) !== String(seAt - stAt + 1))
    fail("SE01 segment count does not match the transaction set");
  if (elem(gs, 6) === "" || elem(ge, 2) !== elem(gs, 6)) fail("GE02 does not match GS06");
  if (elem(ge, 1) !== "1") fail("GE01 transaction-set count is not 1");
  if (elem(iea, 2) !== isa13) fail("IEA02 does not match ISA13");
  if (elem(iea, 1) !== "1") fail("IEA01 functional-group count is not 1");
  return { isa13, st02, body: segs.slice(stAt + 1, seAt) };
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

function partyOf(seg: X12Segment): ParsedRemittanceParty {
  const qual = elem(seg, 3);
  const id = elem(seg, 4);
  return { name: elem(seg, 2), ...(qual ? { idQualifier: qual } : {}), ...(id ? { id } : {}) };
}

/** Party-loop REF segments (payee tax id / PTAN, payer additional id); other REFs are left alone. */
function applyPartyRef(party: ParsedRemittanceParty, kind: "PR" | "PE", seg: X12Segment): void {
  const q = elem(seg, 1);
  const v = elem(seg, 2);
  if (!v) return;
  if (kind === "PE" && q === "TJ") party.taxId = v;
  else if (kind === "PE" && q === "PQ") party.payerAssignedId = v;
  else if (kind === "PR" && q === "2U") party.additionalPayerId = v;
}

interface Body {
  readonly bpr: X12Segment;
  readonly trn: X12Segment;
  readonly production: string | undefined;
  readonly parties: Readonly<Record<"PR" | "PE", ParsedRemittanceParty | undefined>>;
  readonly claims: readonly ClaimDraft[];
  readonly plb: readonly number[];
}

/** Walk the transaction-set body into BPR/TRN/header facts, claim drafts and PLB amounts. */
function walkBody(body: readonly X12Segment[], compSep: string): Body {
  let bpr: X12Segment | undefined;
  let trn: X12Segment | undefined;
  let dtm405: string | undefined;
  const parties: Record<"PR" | "PE", ParsedRemittanceParty | undefined> = {
    PR: undefined,
    PE: undefined,
  };
  let party: ParsedRemittanceParty | undefined;
  let partyKind: "PR" | "PE" | undefined;
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
    else if (id === "SVC") (current ?? fail("SVC outside a CLP")).lines.push(newLine(seg, compSep));
    else if (id === "N1" && !current) {
      const kind = elem(seg, 1);
      partyKind = kind === "PR" || kind === "PE" ? kind : undefined;
      if (partyKind && parties[partyKind]) fail(`more than one N1 ${partyKind} loop`);
      party = partyKind ? partyOf(seg) : undefined;
      if (partyKind) parties[partyKind] = party;
    } else if (id === "REF" && !current && party && partyKind) applyPartyRef(party, partyKind, seg);
    else if (current) applyClaimSegment(current, seg);
    else if (id === "CAS") fail("CAS outside a CLP");
    else if (id === "DTM" && elem(seg, 1) === "405") dtm405 = toIsoDate(elem(seg, 2), "DTM405");
  }
  if (!bpr) return fail("missing BPR");
  if (!trn) return fail("missing TRN");
  if (!parties.PR || !parties.PE) fail("missing N1 payer (PR) or payee (PE) loop");
  const date = elem(bpr, 16) ? toIsoDate(elem(bpr, 16), "BPR16") : dtm405;
  return { bpr, trn, production: date, parties, claims, plb };
}

function checkBalances(b: Body, total: number): void {
  b.claims.forEach((c, i) =>
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
  checkPaymentBalance(
    total,
    b.claims.map((c) => c.paid),
    b.plb,
  );
}

function build(
  raw: string,
  payerProgram: PayerProgram,
  opts: ParseX12835Options,
): ParsedRemittanceAdvice {
  const doc = tokenizeX12(raw);
  const { isa13, st02, body } = unwrapEnvelope(doc.segments, opts);
  const b = walkBody(body, doc.componentSeparator);
  const method = PAYMENT_METHODS[elem(b.bpr, 4)];
  if (!method) fail("BPR04 is not a supported payment method");
  if (elem(b.bpr, 3) !== "C") fail("BPR03 is not C (credit); debit remittances are unsupported");
  const trace = elem(b.trn, 2);
  if (!trace) fail("missing TRN02 trace number");
  if (!b.production) fail("missing BPR16/DTM405 production date");
  const total = toCents(elem(b.bpr, 2), "BPR02");
  if (total < 0) fail("BPR02 is negative");
  checkBalances(b, total);
  return {
    payerProgram,
    interchangeControlNumber: isa13,
    transactionSetControlNumber: st02,
    checkOrEftTraceNumber: trace,
    ...(elem(b.trn, 3) ? { originatingCompanyId: elem(b.trn, 3) } : {}),
    payer: b.parties.PR as ParsedRemittanceParty,
    payee: b.parties.PE as ParsedRemittanceParty,
    paymentMethod: method,
    totalPaymentAmount: total / 100,
    productionDate: `${b.production}T00:00:00Z`,
    claims: b.claims.map(toClaim),
  };
}

/** Parse raw 835 text. Never throws: any failure is a non-retryable degraded envelope (PHI-free reason). */
export function parseX12835(
  raw: string,
  payerProgram: PayerProgram,
  opts: ParseX12835Options = {},
): X12WorkerResult<ParsedRemittanceAdvice> {
  try {
    return { ok: true, value: build(raw, payerProgram, opts) };
  } catch (err) {
    if (err instanceof X12ParseError) return degraded835(err.code, err.message, "parse835", false);
    return degraded835("X12_835_PARSE_FAILED", "unexpected parser failure", "parse835", false);
  }
}
