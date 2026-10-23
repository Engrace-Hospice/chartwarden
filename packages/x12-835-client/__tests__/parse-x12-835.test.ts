// @chartwarden/x12-835-client — pure-TypeScript 835 parser: exact parsed values + fail-closed cases.
import { describe, expect, it } from "vitest";
import { createX12835Client, parseX12835 } from "../src/index";
import {
  CLEAN_BODY,
  DENIAL_BODY,
  FLOAT_TRAP_BODY,
  replaceSeg,
  type WrapOptions,
  wrap835,
} from "./fixtures-835";

const parse = (raw: string) => parseX12835(raw, "medicare");

function expectDegraded(raw: string, code: string, reasonPart: string): void {
  const r = parse(raw);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.degraded.code).toBe(code);
  expect(r.degraded.reason).toContain(reasonPart);
  expect(r.degraded.retryable).toBe(false);
}

describe("parseX12835 clean multi-claim 835", () => {
  const r = parse(wrap835(CLEAN_BODY));

  it("parses the envelope and payment header", () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({
      payerProgram: "medicare",
      interchangeControlNumber: "100000001",
      transactionSetControlNumber: "0001",
      checkOrEftTraceNumber: "EFT0001",
      paymentMethod: "eft",
      totalPaymentAmount: 1150,
      productionDate: "2026-06-15T00:00:00Z",
    });
    expect(r.value.claims).toHaveLength(3);
  });

  it("parses claim 1 with service lines, CAS, RARC, dates and member id", () => {
    if (!r.ok) throw new Error("expected ok");
    expect(r.value.claims[0]).toEqual({
      patientControlNumber: "PCN-0001",
      payerIcn: "ICN-A1",
      statusCode: 1,
      totalCharge: 1000,
      totalPayment: 800,
      patientResponsibility: 50,
      patientMemberId: "MBR0001",
      serviceFrom: "2026-05-01",
      serviceTo: "2026-05-31",
      adjustments: [],
      remarks: [
        { kind: "MOA", code: "MA01" },
        { kind: "MOA", code: "MA18" },
      ],
      serviceLines: [
        {
          procedureCode: "Q5001",
          chargeAmount: 600,
          paidAmount: 500,
          paidUnits: 1,
          submittedUnits: 1,
          adjustments: [{ groupCode: "CO", reasonCode: "45", amount: 100, quantity: 1 }],
          remarks: [{ kind: "LQ", code: "N30" }],
        },
        {
          procedureCode: "Q5002",
          chargeAmount: 400,
          paidAmount: 300,
          paidUnits: 2,
          adjustments: [
            { groupCode: "PR", reasonCode: "2", amount: 50 },
            { groupCode: "CO", reasonCode: "45", amount: 50, quantity: 2 },
          ],
          remarks: [],
        },
      ],
    });
  });

  it("parses a revenue-coded line and a MIA remark", () => {
    if (!r.ok) throw new Error("expected ok");
    const c = r.value.claims[1]!;
    expect(c.remarks).toEqual([{ kind: "MIA", code: "MA01" }]);
    expect(c.serviceLines[0]).toEqual({
      revenueCode: "0651",
      chargeAmount: 500,
      paidAmount: 400,
      paidUnits: 5,
      adjustments: [{ groupCode: "CO", reasonCode: "45", amount: 100 }],
      remarks: [],
    });
  });

  it("parses the claim-level denial", () => {
    if (!r.ok) throw new Error("expected ok");
    const c = r.value.claims[2]!;
    expect(c.statusCode).toBe(4);
    expect(c.totalPayment).toBe(0);
    expect(c.adjustments).toEqual([{ groupCode: "CO", reasonCode: "45", amount: 300 }]);
    expect(c.remarks).toEqual([{ kind: "MOA", code: "MA130" }]);
  });
});

describe("parseX12835 other valid shapes", () => {
  it("parses a stand-alone denial with a non-payment BPR", () => {
    const r = parse(wrap835(DENIAL_BODY));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.paymentMethod).toBe("non_payment_remit");
    expect(r.value.totalPaymentAmount).toBe(0);
    expect(r.value.claims[0]).toMatchObject({ statusCode: 4, totalPayment: 0, totalCharge: 250 });
  });

  it("foots decimal amounts exactly (0.10 + 0.20 = 0.30, no float drift)", () => {
    const r = parse(wrap835(FLOAT_TRAP_BODY));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.totalPaymentAmount).toBe(0.3);
    expect(r.value.paymentMethod).toBe("check");
  });

  it.each<[string, WrapOptions]>([
    ["pipe/greater-than/bang", { el: "|", comp: ">", term: "!" }],
    ["newline terminator", { el: "+", comp: "<", term: "\n" }],
  ])("reads delimiters from the ISA (%s) and yields the same result", (_n, o) => {
    expect(parse(wrap835(CLEAN_BODY, o))).toEqual(parse(wrap835(CLEAN_BODY)));
  });
});

describe("parseX12835 fails closed", () => {
  const ok = wrap835(CLEAN_BODY);

  it("rejects an unbalanced BPR02", () => {
    const body = replaceSeg(CLEAN_BODY, "BPR", CLEAN_BODY[0]!.replace("1150.00", "1150.01"));
    expectDegraded(wrap835(body), "X12_835_UNBALANCED", "BPR02 1150.01 != sum(CLP04) - sum(PLB) 1150.00");
  });

  it("rejects a claim whose CLP03-CLP04-CAS does not foot", () => {
    const body = replaceSeg(CLEAN_BODY, "CLP*PCN-0003", "CLP*PCN-0003*4*300.00*0.00*0.00*MC*ICN-A3");
    const bad = replaceSeg(body, "CAS*CO*45*300.00", "CAS*CO*45*299.99");
    expectDegraded(wrap835(bad), "X12_835_UNBALANCED", "claim 3 does not balance");
  });

  it("rejects a service line that does not foot", () => {
    const bad = replaceSeg(CLEAN_BODY, "CAS*CO*45*100.00*1", "CAS*CO*45*90.00*1");
    expectDegraded(wrap835(bad), "X12_835_UNBALANCED", "claim 1 service line 1");
  });

  it("rejects CLP05 that disagrees with the PR adjustments", () => {
    const bad = replaceSeg(CLEAN_BODY, "CLP*PCN-0001", "CLP*PCN-0001*1*1000.00*800.00*40.00*MC*ICN-A1*11*1");
    expectDegraded(wrap835(bad), "X12_835_UNBALANCED", "patient responsibility");
  });

  it("rejects service-line charges that do not sum to CLP03", () => {
    const bad = replaceSeg(CLEAN_BODY, "CLP*PCN-0002", "CLP*PCN-0002*1*510.00*410.00*0.00*MC*ICN-A2");
    expectDegraded(wrap835(bad), "X12_835_UNBALANCED", "service-line charges do not sum");
  });

  it.each<[string, WrapOptions, string]>([
    ["bad SE01 count", { seCount: 99 }, "SE01"],
    ["SE02 != ST02", { se02: "0002" }, "SE02"],
    ["ST01 not 835", { st01: "837" }, "not an 835"],
    ["blank ISA13", { isa13: "" }, "ISA13"],
    ["blank ST02", { st02: "" }, "ST02"],
    ["GE02 != GS06", { ge02: "99" }, "GE02"],
    ["GE01 != 1", { ge01: "2" }, "GE01"],
    ["IEA02 != ISA13", { iea02: "999999999" }, "IEA02"],
    ["IEA01 != 1", { iea01: "3" }, "IEA01"],
  ])("rejects %s", (_n, o, part) => {
    expectDegraded(wrap835(CLEAN_BODY, o), "X12_835_PARSE_FAILED", part);
  });

  it("rejects truncated input", () => {
    expectDegraded(ok.slice(0, ok.length - 10), "X12_835_PARSE_FAILED", "truncated");
    expectDegraded(ok.slice(0, 300), "X12_835_PARSE_FAILED", "truncated");
    expectDegraded(ok.slice(0, 50), "X12_835_PARSE_FAILED", "no ISA");
  });

  it("rejects a file with the closing IEA missing", () => {
    expectDegraded(ok.slice(0, ok.lastIndexOf("IEA")), "X12_835_PARSE_FAILED", "ISA..IEA");
  });

  it("rejects non-X12 text and garbled delimiters", () => {
    expectDegraded("hello world".repeat(20), "X12_835_PARSE_FAILED", "no ISA");
    expectDegraded(ok.slice(0, 3) + "A" + ok.slice(4), "X12_835_PARSE_FAILED", "delimiters");
    expectDegraded(ok.slice(0, 104) + "*" + ok.slice(105), "X12_835_PARSE_FAILED", "not distinct");
  });

  it("rejects amounts with more than two decimals and non-numeric amounts", () => {
    const a = replaceSeg(CLEAN_BODY, "CAS*CO*45*300.00", "CAS*CO*45*300.001");
    expectDegraded(wrap835(a), "X12_835_PARSE_FAILED", "more than 2 decimal places");
    const b = replaceSeg(CLEAN_BODY, "CAS*CO*45*300.00", "CAS*CO*45*abc");
    expectDegraded(wrap835(b), "X12_835_PARSE_FAILED", "not a decimal amount");
  });

  it("rejects an unknown CAS group, a missing payer loop, a bad payment method and a debit BPR", () => {
    expectDegraded(wrap835(replaceSeg(CLEAN_BODY, "CAS*CO*45*300.00", "CAS*ZZ*45*300.00")), "X12_835_PARSE_FAILED", "CAS01");
    expectDegraded(wrap835(replaceSeg(CLEAN_BODY, "N1*PR", "N3*X")), "X12_835_PARSE_FAILED", "N1 payer");
    expectDegraded(wrap835(replaceSeg(CLEAN_BODY, "BPR", CLEAN_BODY[0]!.replace("ACH", "XXX"))), "X12_835_PARSE_FAILED", "BPR04");
    expectDegraded(wrap835(replaceSeg(CLEAN_BODY, "BPR", CLEAN_BODY[0]!.replace("*C*", "*D*"))), "X12_835_PARSE_FAILED", "BPR03");
  });

  it("rejects a file carrying two transaction sets", () => {
    const two = ok.replace("SE*", "SE*").replace(/~GE\*/, "~ST*835*0002~SE*2*0002~GE*");
    expectDegraded(two, "X12_835_PARSE_FAILED", "exactly one ST/SE");
  });

  it("never throws and keeps reasons free of patient/claim identifiers", () => {
    const r = parse(wrap835(CLEAN_BODY, { seCount: 99 }));
    expect(JSON.stringify(r)).not.toMatch(/PCN-|MBR0001|DOE/);
  });
});

describe("createX12835Client.parse835 (in-process, no sidecar)", () => {
  it("parses supplied raw text without any port", async () => {
    const r = await createX12835Client().parse835({
      minioObjectKey: "era/a.835",
      payerProgram: "medicaid",
      rawEdi: wrap835(DENIAL_BODY),
    });
    expect(r.ok && r.value.payerProgram).toBe("medicaid");
  });

  it("reads the staged object through readRaw when no raw text is supplied", async () => {
    const client = createX12835Client({ readRaw: async () => wrap835(DENIAL_BODY) });
    const r = await client.parse835({ minioObjectKey: "k", payerProgram: "medicare" });
    expect(r.ok).toBe(true);
  });

  it("degrades (retryable) when neither raw text nor a reader is available", async () => {
    const r = await createX12835Client().parse835({ minioObjectKey: "k", payerProgram: "medicare" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.degraded.code).toBe("X12_835_RAW_UNAVAILABLE");
    expect(r.degraded.retryable).toBe(true);
  });

  it("degrades (retryable) when the object read rejects", async () => {
    const client = createX12835Client({ readRaw: () => Promise.reject(new Error("boom")) });
    const r = await client.parse835({ minioObjectKey: "k", payerProgram: "medicare" });
    expect(!r.ok && r.degraded.code).toBe("X12_835_RAW_READ");
  });
});
