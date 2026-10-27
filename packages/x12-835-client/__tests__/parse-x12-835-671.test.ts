// #671 — SVC01 qualifier kept, production-date preference, BPR02=0 pinned, one-pass multi-set parse.
import { describe, expect, it } from "vitest";
import { createX12835Client, parseX12835, parseX12835AllSets } from "../src/index";
import { CLEAN_BODY, DENIAL_BODY, replaceSeg, wrap835, wrap835Sets } from "./fixtures-835";

describe("SVC01 qualifier is kept (#671)", () => {
  it("surfaces HC and NU per line", () => {
    const r = parseX12835(wrap835(CLEAN_BODY), "medicare");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = r.value.claims.flatMap((c) => c.serviceLines);
    expect(lines.map((l) => l.serviceIdQualifier)).toEqual(["HC", "HC", "NU"]);
  });
});

describe("production date preference (#671)", () => {
  // Spec rule (5010 835 TR3, not in this repo; unverified): BPR16 is the check issue / EFT effective date,
  // DTM*405 the production date. BPR16 wins when both are present; DTM*405 is the fallback.
  it("prefers BPR16 over DTM*405", () => {
    const r = parseX12835(wrap835(CLEAN_BODY), "medicare"); // BPR16 20260615, DTM*405 20260616
    expect(r.ok && r.value.productionDate).toBe("2026-06-15T00:00:00Z");
  });
  it("falls back to DTM*405 when BPR16 is empty", () => {
    const body = replaceSeg(
      CLEAN_BODY,
      "BPR*",
      "BPR*I*1250.00*C*ACH*CCP*01*999999992*DA*123456789*1512345678**01*999988880*DA*98765*",
    );
    const r = parseX12835(wrap835(body), "medicare");
    expect(r.ok && r.value.productionDate).toBe("2026-06-16T00:00:00Z");
  });
});

describe("BPR02 = 0 with BPR04 other than NON (#671)", () => {
  // Pinned, not enforced: the TR3 rule is not in the repo and no real zero-pay MAC file has been seen.
  it("is accepted today", () => {
    const body = ["BPR*I*0.00*C*CHK************20260615", ...DENIAL_BODY.slice(1)];
    const r = parseX12835(wrap835(body), "medicare");
    expect(r.ok && r.value.paymentMethod).toBe("check");
  });
});

describe("parseX12835AllSets (#671)", () => {
  const two = wrap835Sets([
    ["0001", CLEAN_BODY],
    ["0002", DENIAL_BODY],
  ]);
  it("returns every set in file order, equal to parsing each by ST02", () => {
    const all = parseX12835AllSets(two, "medicare");
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    expect(all.value.map((a) => a.transactionSetControlNumber)).toEqual(["0001", "0002"]);
    for (const a of all.value) {
      const one = parseX12835(two, "medicare", {}, a.transactionSetControlNumber);
      expect(one).toEqual({ ok: true, value: a });
    }
  });
  it("is all-or-nothing: a bad second set fails the file", () => {
    const bad = two.replace(/SE\*\d+\*0002/, "SE*99*0002");
    expect(parseX12835AllSets(bad, "medicare").ok).toBe(false);
  });
  it("the client exposes it and reports a missing reader as retryable", async () => {
    const c = createX12835Client();
    const ok = await c.parse835All?.({
      minioObjectKey: "k",
      payerProgram: "medicare",
      rawEdi: two,
    });
    expect(ok?.ok && ok.value.length).toBe(2);
    const missing = await c.parse835All?.({ minioObjectKey: "k", payerProgram: "medicare" });
    expect(missing && !missing.ok && missing.degraded.retryable).toBe(true);
  });
});
