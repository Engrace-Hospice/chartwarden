// @chartwarden/x12-835-client — review hardening: money-safety, envelope gating, whitespace tolerance.
import { describe, expect, it } from "vitest";
import { createX12835Client, parseX12835 } from "../src/index";
import { CLEAN_BODY, replaceSeg, wrap835 } from "./fixtures-835";

const parse = (raw: string) => parseX12835(raw, "medicare");
const HEADER = CLEAN_BODY.slice(1, CLEAN_BODY.findIndex((x) => x.startsWith("CLP*PCN-0001")));
const bpr = (amount: string, method = "ACH"): string =>
  `BPR*I*${amount}*C*${method}*CCP*01*999999992*DA*123456789*1512345678**01*999988880*DA*98765*20260615`;

function expectDegraded(raw: string, code: string, part: string): void {
  const r = parse(raw);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.degraded.code).toBe(code);
  expect(r.degraded.reason).toContain(part);
  expect(r.degraded.retryable).toBe(false);
}

describe("whitespace and terminator tolerance", () => {
  const ok = wrap835(CLEAN_BODY);

  it("tolerates CRLF, blanks between segments and a leading BOM", () => {
    expect(parse(ok.replace(/~/g, "~\r\n"))).toEqual(parse(ok));
    expect(parse(ok.replace(/~/g, "~ \n  "))).toEqual(parse(ok));
    expect(parse("﻿" + ok)).toEqual(parse(ok));
  });

  it("fails closed when a bare-LF-terminated file is CRLF-converted (ISA[105] becomes CR)", () => {
    const lf = wrap835(CLEAN_BODY, { el: "+", comp: "<", term: "\n" });
    expect(parse(lf).ok).toBe(true);
    expectDegraded(lf.replace(/\n/g, "\r\n"), "X12_835_PARSE_FAILED", "delimiters");
  });
});

describe("no-payment statuses and reversals", () => {
  it("passes and foots a reversal (CLP02=22, negative amounts) netted against a payment", () => {
    const body = [
      bpr("0.00"),
      ...HEADER,
      "CLP*PCN-0100*22*-500.00*-100.00*0.00*MC*ICN-R1",
      "CAS*CO*45*-400.00",
      "CLP*PCN-0101*1*500.00*100.00*0.00*MC*ICN-R2",
      "CAS*CO*45*400.00",
    ];
    const r = parse(wrap835(body));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.claims[0]).toMatchObject({ statusCode: 22, totalPayment: -100, totalCharge: -500 });
    expect(r.value.totalPaymentAmount).toBe(0);
  });

  it.each([23, 25])("rejects status %i with a non-zero CLP04", (st) => {
    const body = [bpr("50.00"), ...HEADER, `CLP*PCN-0200*${st}*100.00*50.00*0.00*MC*ICN-X`];
    expectDegraded(wrap835(body), "X12_835_UNBALANCED", "non-zero CLP04");
  });

  it("accepts status 23 with CLP04 = 0", () => {
    const body = [bpr("0.00", "NON"), ...HEADER, "CLP*PCN-0201*23*100.00*0.00*0.00*MC*ICN-X"];
    expect(parse(wrap835(body)).ok).toBe(true);
  });
});

describe("balancing edge cases", () => {
  const mixed = [
    bpr("350.00"),
    ...HEADER,
    "CLP*PCN-0300*1*500.00*350.00*20.00*MC*ICN-M1",
    "CAS*PR*2*20.00",
    "SVC*HC:Q5001*500.00*370.00",
    "CAS*CO*45*130.00",
  ];

  it("balances claim-level plus line-level CAS together", () => {
    // claim: 500 - 350 = 150 = 20 (claim PR) + 130 (line CO); line: 500 - 370 = 130
    expect(parse(wrap835(mixed)).ok).toBe(true);
    const bad = replaceSeg(mixed, "CAS*PR*2*20.00", "CAS*PR*2*10.00");
    expectDegraded(wrap835(bad), "X12_835_UNBALANCED", "claim 1");
  });

  it("foots PLB exactly with float-trap amounts and a negative PLB", () => {
    const body = [
      bpr("1.00"),
      ...HEADER,
      "CLP*PCN-0400*1*1.00*1.00*0.00*MC*ICN-P1",
      "PLB*1512345678*20261231*WO:A*0.10*WO:B*0.20*L6:C*-0.30",
    ];
    expect(parse(wrap835(body)).ok).toBe(true);
    expectDegraded(wrap835(replaceSeg(body, "BPR", bpr("0.70"))), "X12_835_UNBALANCED", "BPR02 0.70");
  });

  it("rejects a negative BPR02", () => {
    expectDegraded(wrap835([bpr("-1.00"), ...HEADER]), "X12_835_PARSE_FAILED", "BPR02 is negative");
  });
});

describe("envelope gating", () => {
  it("rejects test interchanges unless allowTestFiles is set", async () => {
    const t = wrap835(CLEAN_BODY, { isa15: "T" });
    expectDegraded(t, "X12_835_PARSE_FAILED", "ISA15");
    expect(parseX12835(t, "medicare", { allowTestFiles: true }).ok).toBe(true);
    const viaClient = await createX12835Client({ allowTestFiles: true }).parse835({
      minioObjectKey: "k",
      payerProgram: "medicare",
      rawEdi: t,
    });
    expect(viaClient.ok).toBe(true);
    const strict = await createX12835Client().parse835({
      minioObjectKey: "k",
      payerProgram: "medicare",
      rawEdi: t,
    });
    expect(strict.ok).toBe(false);
  });

  it("rejects a wrong GS01 or GS08", () => {
    expectDegraded(wrap835(CLEAN_BODY, { gs01: "HC" }), "X12_835_PARSE_FAILED", "GS01");
    expectDegraded(wrap835(CLEAN_BODY, { gs08: "004010X091A1" }), "X12_835_PARSE_FAILED", "GS08");
  });

  it("does not echo the ST01 value and names the in-process integration", () => {
    const r = parse(wrap835(CLEAN_BODY, { st01: "837" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.degraded.reason).not.toContain("837");
    expect(r.degraded.integration).toBe("x12-835-parser");
  });
});

describe("segment-level validation", () => {
  it("rejects an unknown claim status and an unknown SVC qualifier", () => {
    const st = replaceSeg(CLEAN_BODY, "CLP*PCN-0003", "CLP*PCN-0003*7*300.00*0.00*0.00*MC*ICN-A3");
    expectDegraded(wrap835(st), "X12_835_PARSE_FAILED", "CLP02");
    const q = replaceSeg(CLEAN_BODY, "SVC*HC:Q5001", "SVC*ZZ:Q5001*600.00*500.00**1**1");
    expectDegraded(wrap835(q), "X12_835_PARSE_FAILED", "SVC01 qualifier");
  });

  it("does not read MIA24 (a dollar amount) as a remark code", () => {
    // MIA05 = MA01; MIA24 (element 24) = 12.50 must be ignored.
    const mia = `MIA*0****MA01${"*".repeat(18)}*12.50`;
    expect(mia.split("*")[24]).toBe("12.50");
    const r = parse(wrap835(replaceSeg(CLEAN_BODY, "MIA*0", mia)));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.claims[1]!.remarks).toEqual([{ kind: "MIA", code: "MA01" }]);
  });
});

describe("staged-object read failures", () => {
  it("is retryable with a fixed reason that leaks no endpoint text", async () => {
    const client = createX12835Client({
      readRaw: () => Promise.reject(new Error("https://minio.internal:9000/bucket-secret denied")),
    });
    const r = await client.parse835({ minioObjectKey: "k", payerProgram: "medicare" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.degraded.code).toBe("X12_835_RAW_READ");
    expect(r.degraded.retryable).toBe(true);
    expect(r.degraded.reason).not.toContain("minio");
  });
});

describe("numeric quantity fields", () => {
  it.each(["0x10", "1e3"])("rejects a non-decimal CAS quantity (%s)", (qty) => {
    const raw = wrap835(replaceSeg(CLEAN_BODY, "CAS*CO*45*100.00*1", `CAS*CO*45*100.00*${qty}`));
    expectDegraded(raw, "X12_835_PARSE_FAILED", "CAS quantity is not numeric");
  });
});
