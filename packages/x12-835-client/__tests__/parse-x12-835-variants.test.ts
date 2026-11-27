// CW-PI-03 — the documented 835 variants (partial service lines, adjustments, interest, several ST/SE sets) and the
// refusal of anything the parser does not recognise. Every file here is synthetic and built from the fixtures; none
// says how a real MAC formats a remittance (that needs de-identified real files, docs/runbooks/m25-835-real-file-intake.md).
// The expectations pin what the parser does TODAY; they are not a reading of the X12 835 implementation guide.
import { describe, expect, it } from "vitest";
import { parseX12835, parseX12835AllSets } from "../src/index";
import { CLEAN_BODY, wrap835, wrap835Sets } from "./fixtures-835";

const HEADER = CLEAN_BODY.slice(
  1,
  CLEAN_BODY.findIndex((x) => x.startsWith("CLP*PCN-0001")),
);
const bpr = (amount: string, method = "ACH*CCP"): string =>
  `BPR*I*${amount}*C*${method}*01*999999992*DA*123456789*1512345678**01*999988880*DA*98765*20260615`;
/** One set body: BPR, the shared header (TRN, payer, payee, LX), then the claim segments. */
const setBody = (amount: string, ...claim: string[]): string[] => [
  bpr(amount),
  ...HEADER,
  ...claim,
];
const parse = (body: readonly string[]) => parseX12835(wrap835(body), "medicare");

function ok(body: readonly string[]) {
  const r = parse(body);
  if (!r.ok)
    throw new Error(`expected a clean parse, got ${r.degraded.code}: ${r.degraded.reason}`);
  return r.value;
}
function refusal(body: readonly string[]): { code: string; reason: string } {
  const r = parse(body);
  if (r.ok) throw new Error("expected the file to be refused");
  return { code: r.degraded.code, reason: r.degraded.reason };
}

describe("partial service lines", () => {
  // 400.00 paid in full, 400.00 paid 250.00 (PR 60.00 + CO 90.00), 200.00 denied (CO 200.00): 650.00 paid of 1000.00.
  const THREE_LINES = [
    "CLP*PCN-V-A1*1*1000.00*650.00*60.00*MC*ICN-V-A1",
    "SVC*HC:Q5001*400.00*400.00**4",
    "SVC*HC:Q5002*400.00*250.00**3**4",
    "CAS*PR*2*60.00",
    "CAS*CO*45*90.00",
    "SVC*HC:Q5005*200.00*0.00",
    "CAS*CO*50*200.00",
  ];
  const swap = (from: string, to: string): string[] => THREE_LINES.map((s) => s.replace(from, to));

  it("keeps each line's own paid amount, units and adjustments when only part of the claim is paid", () => {
    const claim = ok(setBody("650.00", ...THREE_LINES)).claims[0];
    expect(claim).toMatchObject({
      totalCharge: 1000,
      totalPayment: 650,
      patientResponsibility: 60,
    });
    expect(claim?.serviceLines.map((l) => [l.chargeAmount, l.paidAmount])).toEqual([
      [400, 400],
      [400, 250],
      [200, 0],
    ]);
    expect(claim?.serviceLines[1]).toMatchObject({ paidUnits: 3, submittedUnits: 4 });
    expect(claim?.serviceLines[1]?.adjustments).toEqual([
      { groupCode: "PR", reasonCode: "2", amount: 60 },
      { groupCode: "CO", reasonCode: "45", amount: 90 },
    ]);
    expect(claim?.serviceLines[0]?.adjustments).toEqual([]);
    expect(claim?.serviceLines[2]?.adjustments).toEqual([
      { groupCode: "CO", reasonCode: "50", amount: 200 },
    ]);
  });

  it("accepts a line paid MORE than charged when a negative CAS accounts for the difference", () => {
    const claim = ok(
      setBody(
        "110.00",
        "CLP*PCN-V-A2*1*100.00*110.00*0.00*MC*ICN-V-A2",
        "SVC*HC:Q5001*100.00*110.00",
        "CAS*CO*45*-10.00",
      ),
    ).claims[0];
    expect(claim?.serviceLines[0]?.adjustments).toEqual([
      { groupCode: "CO", reasonCode: "45", amount: -10 },
    ]);
  });

  it.each<[string, string[], string]>([
    [
      "line charges that do not add up to CLP03",
      swap("SVC*HC:Q5005*200.00*0.00", "SVC*HC:Q5005*150.00*0.00").map((s) =>
        s.replace("CAS*CO*50*200.00", "CAS*CO*50*150.00"),
      ),
      "service-line charges do not sum to CLP03",
    ],
    [
      "one line off by a single cent",
      swap("SVC*HC:Q5002*400.00*250.00", "SVC*HC:Q5002*400.00*250.01"),
      "service line 2 does not balance",
    ],
    [
      "CLP05 that does not equal the PR adjustments on the lines",
      swap("1000.00*650.00*60.00", "1000.00*650.00*50.00"),
      "patient responsibility (CLP05) disagrees with PR adjustments",
    ],
    [
      "CLP04 that does not equal what the lines paid",
      swap("1000.00*650.00*60.00", "1000.00*640.00*60.00"),
      "does not balance",
    ],
  ])("refuses %s", (_name, claim, part) => {
    const { code, reason } = refusal(setBody("650.00", ...claim));
    expect(code).toBe("X12_835_UNBALANCED");
    expect(reason).toContain(part);
  });

  it("refuses a file whose BPR02 is not the sum of what the partial claims paid", () => {
    expect(refusal(setBody("1000.00", ...THREE_LINES)).code).toBe("X12_835_UNBALANCED");
  });

  it("does not let a partial line of one claim take the adjustments of the next claim", () => {
    const claims = ok(
      setBody(
        "850.00",
        "CLP*PCN-V-A3*1*500.00*400.00*0.00*MC*ICN-V-A3",
        "SVC*HC:Q5001*500.00*400.00",
        "CAS*CO*45*100.00",
        "CLP*PCN-V-A4*1*450.00*450.00*0.00*MC*ICN-V-A4",
        "SVC*HC:Q5002*450.00*450.00",
      ),
    ).claims;
    expect(claims[0]?.serviceLines[0]?.adjustments).toHaveLength(1);
    expect(claims[1]?.serviceLines[0]?.adjustments).toEqual([]);
    expect(claims[1]?.adjustments).toEqual([]);
  });
});

describe("adjustments", () => {
  const casOf = (group: string, triplets: readonly (readonly string[])[]): string =>
    `CAS*${group}*${triplets.map((t) => t.join("*")).join("*")}`;
  // Six reason triplets of 25.00 each (the most a CAS segment carries): 600.00 charged, 450.00 paid, 150.00 adjusted.
  const SIX: readonly (readonly string[])[] = [
    ["45", "25.00", "1"],
    ["A1", "25.00", ""],
    ["B13", "25.00", "2"],
    ["96", "25.00", ""],
    ["97", "25.00", ""],
    ["109", "25.00", ""],
  ];
  const withCas = (cas: string) => ["CLP*PCN-V-B2*1*600.00*450.00*0.00*MC*ICN-V-B2", cas];

  it("reads every adjustment group code and keeps the group on each amount", () => {
    const claim = ok(
      setBody(
        "300.00",
        "CLP*PCN-V-B1*1*500.00*300.00*50.00*MC*ICN-V-B1",
        "CAS*CO*45*60.00",
        "CAS*CR*45*40.00",
        "CAS*OA*23*30.00",
        "CAS*PI*45*20.00",
        "CAS*PR*1*50.00",
      ),
    ).claims[0];
    expect(claim?.adjustments.map((a) => [a.groupCode, a.amount])).toEqual([
      ["CO", 60],
      ["CR", 40],
      ["OA", 30],
      ["PI", 20],
      ["PR", 50],
    ]);
    expect(claim?.patientResponsibility).toBe(50);
  });

  it("reads all six reason triplets of one CAS in order, with a quantity only where one was sent", () => {
    const claim = ok(setBody("450.00", ...withCas(casOf("CO", SIX)))).claims[0];
    expect(claim?.adjustments.map((a) => [a.reasonCode, a.amount, a.quantity])).toEqual([
      ["45", 25, 1],
      ["A1", 25, undefined],
      ["B13", 25, 2],
      ["96", 25, undefined],
      ["97", 25, undefined],
      ["109", 25, undefined],
    ]);
  });

  it("refuses a seventh reason triplet instead of dropping it", () => {
    const { code, reason } = refusal(
      setBody("450.00", ...withCas(casOf("CO", [...SIX, ["119", "0.00", ""]]))),
    );
    expect(code).toBe("X12_835_PARSE_FAILED");
    expect(reason).toContain("more than 6 reason triplets");
  });

  it("adds up several CAS segments of the same group on one line", () => {
    const line = ok(
      setBody(
        "400.00",
        "CLP*PCN-V-B3*1*500.00*400.00*0.00*MC*ICN-V-B3",
        "SVC*HC:Q5001*500.00*400.00",
        "CAS*CO*45*60.00",
        "CAS*CO*96*40.00",
      ),
    ).claims[0]?.serviceLines[0];
    expect(line?.adjustments.map((a) => a.reasonCode)).toEqual(["45", "96"]);
  });

  it("records a zero-amount adjustment as zero, not as absent", () => {
    const claim = ok(
      setBody("100.00", "CLP*PCN-V-B4*1*100.00*100.00*0.00*MC*ICN-V-B4", "CAS*CO*45*0.00"),
    ).claims[0];
    expect(claim?.adjustments).toEqual([{ groupCode: "CO", reasonCode: "45", amount: 0 }]);
  });

  it.each([
    ["a lower-case group code", "CAS*co*45*10.00"],
    ["a group code outside CO/CR/OA/PI/PR", "CAS*XX*45*10.00"],
    ["a reason code longer than five characters", "CAS*CO*TOOLONG*10.00"],
    ["a reason code with punctuation", "CAS*CO*4-5*10.00"],
    ["an amount with no reason code", "CAS*CO**10.00"],
  ])("refuses %s", (_name, cas) => {
    const claim = ["CLP*PCN-V-B5*1*100.00*90.00*0.00*MC*ICN-V-B5", cas];
    expect(refusal(setBody("90.00", ...claim)).code).toBe("X12_835_PARSE_FAILED");
  });
});

describe("interest", () => {
  const CLAIM = ["CLP*PCN-V-C1*1*1000.00*1000.00*0.00*MC*ICN-V-C1", "SVC*HC:Q5001*1000.00*1000.00"];
  const WITH_AMT = [CLAIM[0] as string, "AMT*I*12.34", CLAIM[1] as string];

  it("validates a claim-level AMT*I but never adds it to the claim's money", () => {
    const without = ok(setBody("1000.00", ...CLAIM));
    const withInterest = ok(setBody("1000.00", ...WITH_AMT));
    expect(withInterest).toEqual(without);
  });

  it("validates a line-level AMT*I the same way", () => {
    const line = [...CLAIM, "AMT*I*12.34"];
    expect(ok(setBody("1000.00", ...line))).toEqual(ok(setBody("1000.00", ...CLAIM)));
  });

  it("refuses a BPR02 that includes the AMT*I interest, so interest never enters a payment unreconciled", () => {
    const { code, reason } = refusal(setBody("1012.34", ...WITH_AMT));
    expect(code).toBe("X12_835_UNBALANCED");
    expect(reason).toContain("BPR02 1012.34 != sum(CLP04) - sum(PLB) 1000.00");
  });

  it("accepts interest paid through a negative PLB L6 and surfaces it with its reference", () => {
    const body = setBody("1012.34", ...CLAIM, "PLB*1512345678*20261231*L6:INT-0001*-12.34");
    const advice = ok(body);
    expect(advice.totalPaymentAmount).toBe(1012.34);
    expect(advice.providerAdjustmentTotal).toBe(-12.34);
    expect(advice.providerAdjustments).toEqual([
      {
        reason: "L6",
        reference: "INT-0001",
        amount: -12.34,
        providerIdentifier: "1512345678",
        fiscalPeriod: "2026-12-31",
        segmentPosition: body.length,
        occurrence: 1,
      },
    ]);
  });

  it("carries the PLB sign without interpreting it: a positive L6 reduces the payment", () => {
    const advice = ok(setBody("987.66", ...CLAIM, "PLB*1512345678*20261231*L6:INT-0002*12.34"));
    expect(advice.providerAdjustmentTotal).toBe(12.34);
  });

  it("does not reconcile AMT*I against PLB L6 (not certified): the BPR02 must carry the L6 only", () => {
    const plb = "PLB*1512345678*20261231*L6:INT-0003*-12.34";
    const both = [CLAIM[0] as string, "AMT*I*12.34", CLAIM[1] as string, plb];
    expect(ok(setBody("1012.34", ...both)).totalPaymentAmount).toBe(1012.34);
    expect(refusal(setBody("1024.68", ...both)).code).toBe("X12_835_UNBALANCED");
  });

  it("keeps two PLB pairs of one segment apart, in order, netted exactly", () => {
    const advice = ok(
      setBody("1050.00", ...CLAIM, "PLB*1512345678*20261231*WO:OVR-1*25.00*L6:INT-1*-75.00"),
    );
    expect(
      advice.providerAdjustments?.map((p) => [p.occurrence, p.reason, p.reference, p.amount]),
    ).toEqual([
      [1, "WO", "OVR-1", 25],
      [2, "L6", "INT-1", -75],
    ]);
    expect(advice.providerAdjustmentTotal).toBe(-50);
  });

  it.each([
    ["more than two decimals", "AMT*I*12.345"],
    ["text", "AMT*I*abc"],
    ["no amount", "AMT*I"],
  ])("refuses an AMT*I with %s", (_name, amt) => {
    const { code, reason } = refusal(
      setBody("1000.00", CLAIM[0] as string, amt, CLAIM[1] as string),
    );
    expect(code).toBe("X12_835_PARSE_FAILED");
    expect(reason).toContain("AMT02");
  });

  it.each([
    ["a zero PLB amount", "PLB*1512345678*20261231*L6:INT-9*0.00", "PLB amount cannot be zero"],
    [
      "a reason with no amount",
      "PLB*1512345678*20261231*L6:INT-9",
      "PLB reason/amount pair is incomplete",
    ],
    ["no fiscal period", "PLB*1512345678**L6:INT-9*-1.00", "PLB fiscal period is missing"],
    ["an impossible fiscal period", "PLB*1512345678*20261331*L6:INT-9*-1.00", "PLB02"],
  ])("refuses %s", (_name, plb, part) => {
    const { code, reason } = refusal(setBody("1000.00", ...CLAIM, plb));
    expect(code).toBe("X12_835_PARSE_FAILED");
    expect(reason).toContain(part);
  });

  it.each([
    ["a three-letter reason", "PLB*1512345678*20261231*WOX:REF*10.00"],
    ["a one-letter reason", "PLB*1512345678*20261231*W:REF*10.00"],
    ["a lower-case reason", "PLB*1512345678*20261231*wo:REF*10.00"],
  ])("refuses PLB with %s", (_name, plb) => {
    const { code, reason } = refusal(setBody("990.00", ...CLAIM, plb));
    expect(code).toBe("X12_835_PARSE_FAILED");
    expect(reason).toContain("PLB reason code");
  });
});

describe("several ST/SE sets in one file", () => {
  const A = setBody("500.00", "CLP*PCN-V-D1*1*500.00*500.00*0.00*MC*ICN-V-D1");
  const B = [
    "BPR*I*250.00*C*CHK************20260615",
    ...HEADER,
    "CLP*PCN-V-D2*1*250.00*250.00*0.00*MC*ICN-V-D2",
    "ZZZ*VENDOR-NOTE*SAFE-SYNTHETIC",
  ];
  const C = [
    "BPR*H*0.00*C*NON************20260615",
    ...HEADER,
    "CLP*PCN-V-D3*4*100.00*0.00*0.00*MC*ICN-V-D3",
    "CAS*CO*45*100.00",
  ];
  const THREE = wrap835Sets([
    ["0001", A],
    ["0002", B],
    ["0003", C],
  ]);

  it("returns each set as its own advice with its own method, total, claims and position", () => {
    const all = parseX12835AllSets(THREE, "medicare");
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(
      all.value.map((a) => [
        a.transactionSetControlNumber,
        a.transactionSetPosition,
        a.paymentMethod,
        a.totalPaymentAmount,
        a.claims.map((c) => c.patientControlNumber),
      ]),
    ).toEqual([
      ["0001", 1, "eft", 500, ["PCN-V-D1"]],
      ["0002", 2, "check", 250, ["PCN-V-D2"]],
      ["0003", 3, "non_payment_remit", 0, ["PCN-V-D3"]],
    ]);
  });

  it("scopes an unrecognised segment to the set that carried it", () => {
    const all = parseX12835AllSets(THREE, "medicare");
    expect(all.ok && all.value.map((a) => a.unknownSegments?.map((s) => s.segmentId))).toEqual([
      undefined,
      ["ZZZ"],
      undefined,
    ]);
  });

  it("refuses the whole file when one set is unbalanced, though each balanced set parses on its own", () => {
    const bad = wrap835Sets([
      ["0001", A],
      ["0002", B.map((s) => s.replace("BPR*I*250.00", "BPR*I*251.00"))],
      ["0003", C],
    ]);
    const all = parseX12835AllSets(bad, "medicare");
    expect(!all.ok && all.degraded.code).toBe("X12_835_UNBALANCED");
    expect(parseX12835(bad, "medicare", {}, "0001").ok).toBe(true);
    expect(parseX12835(bad, "medicare", {}, "0003").ok).toBe(true);
    expect(parseX12835(bad, "medicare", {}, "0002").ok).toBe(false);
  });

  it("refuses a GE01 that counts fewer sets than the group holds", () => {
    const all = parseX12835AllSets(THREE.replace("GE*3*", "GE*2*"), "medicare");
    expect(!all.ok && all.degraded.reason).toContain("GE01 transaction-set count does not match");
  });

  it("refuses to pick a set when the caller does not name one", () => {
    const r = parseX12835(THREE, "medicare");
    expect(!r.ok && r.degraded.reason).toContain("select one by ST02");
  });
});

describe("a segment or element the parser does not recognise is surfaced or refused, never dropped", () => {
  it("does not report the LX header number as an unknown segment", () => {
    expect(ok(CLEAN_BODY).unknownSegments).toBeUndefined();
  });

  it.each([
    ["missing", "LX"],
    ["not a number", "LX*A1"],
    ["longer than six digits", "LX*1234567"],
  ])("refuses an LX header number that is %s", (_name, lx) => {
    const body = CLEAN_BODY.map((s) => (s.startsWith("LX*") ? lx : s));
    const { code, reason } = refusal(body);
    expect(code).toBe("X12_835_PARSE_FAILED");
    expect(reason).toContain("LX01");
  });

  it("surfaces every segment outside the modelled set, at the set, claim and line level, in file order", () => {
    const body = setBody(
      "1000.00",
      "TS3*1999999999*11*20261231*1*1000.00",
      "CUR*PR*USD",
      "CLP*PCN-V-E1*1*1000.00*1000.00*0.00*MC*ICN-V-E1",
      "ZZ1*CLAIM-LEVEL",
      "SVC*HC:Q5001*1000.00*1000.00",
      "ZZ9*LINE-LEVEL",
    );
    expect(ok(body).unknownSegments?.map((s) => s.segmentId)).toEqual(["TS3", "CUR", "ZZ1", "ZZ9"]);
  });
});
