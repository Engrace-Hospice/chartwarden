// Synthetic 5010 835 fixtures (NO PHI: invented names/ids). Segments are written in canonical `*` / `:` form
// and re-delimited by `wrap835`, so the same body can be rendered with any ISA delimiters.

export interface WrapOptions {
  el?: string;
  comp?: string;
  term?: string;
  isa13?: string;
  st01?: string;
  st02?: string;
  se02?: string;
  seCount?: number;
  gs06?: string;
  ge02?: string;
  ge01?: string;
  iea02?: string;
  iea01?: string;
}

/** Build a full interchange around `body` (the segments strictly between ST and SE). */
export function wrap835(body: readonly string[], o: WrapOptions = {}): string {
  const el = o.el ?? "*";
  const comp = o.comp ?? ":";
  const term = o.term ?? "~";
  const isa13 = o.isa13 ?? "100000001";
  const st02 = o.st02 ?? "0001";
  const gs06 = o.gs06 ?? "77";
  const isa = [
    "ISA",
    "00",
    " ".repeat(10),
    "00",
    " ".repeat(10),
    "ZZ",
    "SYNTHMAC".padEnd(15),
    "ZZ",
    "SYNTHHOSPICE".padEnd(15),
    "260616",
    "1200",
    "^",
    "00501",
    isa13.padEnd(9),
    "0",
    "P",
    comp,
  ].join(el);
  const segs = [
    `GS*HP*SYNTHMAC*SYNTHHOSPICE*20260616*1200*${gs06}*X*005010X221A1`,
    `ST*${o.st01 ?? "835"}*${st02}`,
    ...body,
    `SE*${o.seCount ?? body.length + 2}*${o.se02 ?? st02}`,
    `GE*${o.ge01 ?? "1"}*${o.ge02 ?? gs06}`,
    `IEA*${o.iea01 ?? "1"}*${o.iea02 ?? isa13}`,
  ].map((s) => s.split("*").join(el).split(":").join(comp));
  return isa + term + segs.map((s) => s + term).join("");
}

const HEADER = [
  "TRN*1*EFT0001*1512345678",
  "REF*EV*RECV01",
  "DTM*405*20260616",
  "N1*PR*SYNTHETIC MAC*XV*99999",
  "N3*1 TEST WAY",
  "N4*TESTVILLE*ZZ*00000",
  "N1*PE*SYNTH HOSPICE*XX*1999999999",
  "LX*1",
];

/** BPR02 = sum(CLP04) 1200.00 - sum(PLB) 50.00. */
export const CLEAN_BODY: readonly string[] = [
  "BPR*I*1150.00*C*ACH*CCP*01*999999992*DA*123456789*1512345678**01*999988880*DA*98765*20260615",
  ...HEADER,
  // claim 1: two service lines, line-level CAS (one SVC with two CAS segments, one with a quantity)
  "CLP*PCN-0001*1*1000.00*800.00*50.00*MC*ICN-A1*11*1",
  "NM1*QC*1*DOE*JANE****MI*MBR0001",
  "DTM*232*20260501",
  "DTM*233*20260531",
  "MOA***MA01*MA18",
  "SVC*HC:Q5001*600.00*500.00**1**1",
  "DTM*472*20260501",
  "CAS*CO*45*100.00*1",
  "REF*6R*L1",
  "AMT*B6*550.00",
  "LQ*HE*N30",
  "SVC*HC:Q5002*400.00*300.00**2",
  "CAS*PR*2*50.00",
  "CAS*CO*45*50.00*2",
  // claim 2: revenue-coded line
  "CLP*PCN-0002*1*500.00*400.00*0.00*MC*ICN-A2",
  "MIA*0****MA01",
  "SVC*NU:0651*500.00*400.00*0651*5",
  "CAS*CO*45*100.00",
  // claim 3: denial, zero paid, claim-level CO-45 + a claim-level RARC
  "CLP*PCN-0003*4*300.00*0.00*0.00*MC*ICN-A3",
  "CAS*CO*45*300.00",
  "MOA***MA130",
  "PLB*1512345678*20261231*WO:REF1*-25.00*L6:REF2*75.00",
];

/** A single denied claim (CLP02=4), no service lines, no PLB. */
export const DENIAL_BODY: readonly string[] = [
  "BPR*I*0.00*C*NON*CCP*01*999999992*DA*123456789*1512345678**01*999988880*DA*98765*20260615",
  ...HEADER,
  "CLP*PCN-0009*4*250.00*0.00*0.00*MC*ICN-D1",
  "CAS*CO*45*250.00",
];

/** Float-trap amounts: 0.10 + 0.20 must foot to exactly 0.30. */
export const FLOAT_TRAP_BODY: readonly string[] = [
  "BPR*I*0.30*C*CHK************20260615",
  ...HEADER,
  "CLP*PCN-0005*1*0.30*0.30*0.00*MC*ICN-F1",
  "SVC*HC:Q5001*0.10*0.10",
  "SVC*HC:Q5002*0.20*0.20",
];

/** Replace the first segment starting with `prefix`; throws when absent so a typo can't pass silently. */
export function replaceSeg(body: readonly string[], prefix: string, next: string): string[] {
  const i = body.findIndex((s) => s.startsWith(prefix));
  if (i < 0) throw new Error(`fixture has no segment ${prefix}`);
  return body.map((s, n) => (n === i ? next : s));
}
