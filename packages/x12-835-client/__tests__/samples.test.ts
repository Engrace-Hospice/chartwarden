// The committed synthetic samples (packages/x12-835-client/samples) stay in step with their generator and pin
// how the parser treats each shape today. Synthetic: this proves our parser agrees with our fixtures, not what a
// real MAC sends (#671 needs de-identified real files for that).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SAMPLES } from "../samples/generate";
import { parseX12835 } from "../src/index";

const parse = (raw: string, st02?: string) => parseX12835(raw, "medicare", {}, st02);
const ok = (raw: string, st02?: string) => {
  const r = parse(raw, st02);
  if (!r.ok) throw new Error(`degraded: ${r.degraded.reason}`);
  return r.value;
};

/** The degraded reason of a refused file, so a refusal test cannot pass on an unrelated failure. */
const refusal = (raw: string, st02?: string): string => {
  const r = parse(raw, st02);
  if (r.ok) throw new Error("expected the parse to be refused");
  return r.degraded.reason;
};

describe("committed .835 samples", () => {
  it.each(Object.entries(SAMPLES))("%s matches the generator", (name, text) => {
    const onDisk = readFileSync(new URL(`../samples/${name}.835`, import.meta.url), "utf8");
    expect(onDisk).toBe(text);
  });

  it("01 clean routine home care: one paid claim", () => {
    const v = ok(SAMPLES["01-clean-routine-home-care"]);
    expect(v.totalPaymentAmount).toBe(1500);
    expect(v.claims).toHaveLength(1);
    expect(v.payee).toMatchObject({ idQualifier: "XX", id: "1999999999" });
  });

  it("02 mixed: a denied claim carries its CO-18 and a partial claim its PR/CO split", () => {
    const v = ok(SAMPLES["02-mixed-paid-denied-partial"]);
    expect(v.totalPaymentAmount).toBe(1150);
    expect(v.claims).toHaveLength(3);
    expect(v.claims[1].adjustments).toMatchObject([{ groupCode: "CO", reasonCode: "18" }]);
    expect(v.claims[2].patientResponsibility).toBe(50);
    expect(v.claims[2].adjustments.map((a) => a.groupCode).sort()).toEqual(["CO", "PR"]);
  });

  it("03 reversal + rebill + PLB: the PLB recoupment is netted into the payment", () => {
    const v = ok(SAMPLES["03-reversal-rebill-plb"]);
    expect(v.totalPaymentAmount).toBe(80);
    expect(v.providerAdjustmentTotal).toBe(120);
    expect(v.claims).toHaveLength(2);
    expect(v.claims[0]).toMatchObject({ statusCode: 22, totalPayment: -700 });
  });

  it("03 does not apply CLP05/PR equality to a reversal, but still checks its financial balance", () => {
    const reversalOnly = SAMPLES["03-reversal-rebill-plb"].replace(
      "CLP*PCN-3001*22*-700.00*-700.00*0.00",
      "CLP*PCN-3001*22*-700.00*-700.00*12.34",
    );
    expect(ok(reversalOnly).claims[0]?.patientResponsibility).toBe(12.34);
    const unbalanced = reversalOnly.replace(
      "CLP*PCN-3001*22*-700.00*-700.00*12.34",
      "CLP*PCN-3001*22*-700.00*-699.99*12.34",
    );
    expect(refusal(unbalanced)).toMatch(/claim 1 does not balance/);
  });

  it("04 partial with lines: line charge and paid sums equal the claim's, PR equals CLP05", () => {
    const v = ok(SAMPLES["04-partial-with-service-lines"]);
    const claim = v.claims[0];
    expect(claim.serviceLines).toHaveLength(2);
    expect(claim.serviceLines.reduce((s, l) => s + l.chargeAmount, 0)).toBe(claim.totalCharge);
    expect(claim.serviceLines.reduce((s, l) => s + l.paidAmount, 0)).toBe(claim.totalPayment);
    expect(claim.totalPayment).toBe(850);
    expect(claim.patientResponsibility).toBe(100);
  });

  it("04 refuses a claim whose lines do not add up to the claim", () => {
    const bad = SAMPLES["04-partial-with-service-lines"].replace(
      "SVC*HC:Q5002*400.00*340.00",
      "SVC*HC:Q5002*400.00*330.00",
    );
    expect(refusal(bad)).toMatch(/service line 2 does not balance/);
  });

  it("05 reconciles AMT*I with opposite-signed PLB L6", () => {
    expect(ok(SAMPLES["05-interest-amt-i"]).totalPaymentAmount).toBe(1012.34);
    const withoutL6 = SAMPLES["05-interest-amt-i"]
      .replace("PLB*1512345678*20261231*L6*-12.34~", "")
      .replace("SE*16*0001", "SE*15*0001")
      .replace("BPR*C*1012.34", "BPR*C*1000.00");
    expect(refusal(withoutL6)).toMatch(/AMT\*I net interest/);
    const wrongL6 = SAMPLES["05-interest-amt-i"]
      .replace("L6*-12.34", "L6*12.34")
      .replace("BPR*C*1012.34", "BPR*C*987.66");
    expect(refusal(wrongL6)).toMatch(/AMT\*I net interest/);
  });

  it("06 zero-dollar remit by ACH is accepted (BPR02 = 0 does not force NON)", () => {
    expect(ok(SAMPLES["06-zero-payment-ach"]).totalPaymentAmount).toBe(0);
  });

  it("07 a tax-id payee surfaces its qualifier, tax id and PTAN for the caller to judge", () => {
    const v = ok(SAMPLES["07-payee-tax-id-and-ptan"]);
    expect(v.payee).toMatchObject({
      idQualifier: "FI",
      id: "123456789",
      taxId: "123456789",
      payerAssignedId: "PTAN0001",
    });
  });

  it("08 several transaction sets in one interchange are selected by ST02", () => {
    const raw = SAMPLES["08-two-transaction-sets"];
    expect(refusal(raw)).toMatch(/select one by ST02/);
    expect(ok(raw, "0001").totalPaymentAmount).toBe(500);
    expect(ok(raw, "0002").totalPaymentAmount).toBe(250);
    expect(refusal(raw, "0003")).toMatch(/no transaction set/);
  });

  it("01 + an injected second GS group is refused (still unsupported)", () => {
    const raw = SAMPLES["01-clean-routine-home-care"].replace(
      "GE*1*77~",
      "GE*1*77~\nGS*HP*A*B*20260616*1200*78*X*005010X221A1~",
    );
    expect(refusal(raw)).toMatch(/exactly one GS\/GE/);
  });
});
