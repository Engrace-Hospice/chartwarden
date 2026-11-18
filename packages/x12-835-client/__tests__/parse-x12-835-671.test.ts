// #671 — SVC01 qualifier kept, production-date preference, BPR02=0 pinned, one-pass multi-set parse.
import { describe, expect, it } from "vitest";
import {
  createX12835Client,
  parseX12835,
  parseX12835AllSets,
  parseX12835Grouped,
} from "../src/index";
import {
  CLEAN_BODY,
  DENIAL_BODY,
  replaceSeg,
  wrap835,
  wrap835Groups,
  wrap835Sets,
} from "./fixtures-835";

describe("SVC01 qualifier is kept (#671)", () => {
  it("surfaces HC and NU per line", () => {
    const r = parseX12835(wrap835(CLEAN_BODY), "medicare");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const lines = r.value.claims.flatMap((c) => c.serviceLines);
    expect(lines.map((l) => l.serviceIdQualifier)).toEqual(["HC", "HC", "NU"]);
  });
});

describe("835 source date semantics (#671)", () => {
  it("keeps payment, adjudication cutoff, and functional group dates distinct", () => {
    const r = parseX12835(wrap835(CLEAN_BODY), "medicare"); // BPR16 20260615, DTM*405 20260616
    expect(r.ok && r.value).toMatchObject({
      paymentEffectiveDate: "2026-06-15",
      adjudicationCutoffDate: "2026-06-16",
      functionalGroupCreationDate: "2026-06-16",
      productionDate: "2026-06-15T00:00:00Z",
    });
  });
  it("does not substitute DTM*405 for a missing BPR16", () => {
    const body = replaceSeg(
      CLEAN_BODY,
      "BPR*",
      "BPR*C*1250.00*C*ACH*CCP*01*999999992*DA*123456789*1512345678**01*999988880*DA*98765*",
    );
    const r = parseX12835(wrap835(body), "medicare");
    expect(r.ok && r.value).toMatchObject({
      paymentEffectiveDate: null,
      adjudicationCutoffDate: "2026-06-16",
      productionDate: null,
    });
  });
  it("preserves identical BPR16 and DTM*405 source dates", () => {
    const body = replaceSeg(CLEAN_BODY, "DTM*405", "DTM*405*20260615");
    const r = parseX12835(wrap835(body), "medicare");
    expect(r.ok && r.value.paymentEffectiveDate).toBe("2026-06-15");
    expect(r.ok && r.value.adjudicationCutoffDate).toBe("2026-06-15");
  });
  it("retains the GS04 date when DTM*405 is absent", () => {
    const body = CLEAN_BODY.filter((s) => !s.startsWith("DTM*405"));
    const r = parseX12835(wrap835(body), "medicare");
    expect(r.ok && r.value.adjudicationCutoffDate).toBeNull();
    expect(r.ok && r.value.functionalGroupCreationDate).toBe("2026-06-16");
  });
  it("does not invent payment or cutoff dates when both segments are absent", () => {
    const body = CLEAN_BODY.filter((s) => !s.startsWith("DTM*405")).map((s) =>
      s.startsWith("BPR*") ? s.replace(/\*20260615$/, "") : s,
    );
    const r = parseX12835(wrap835(body), "medicare");
    expect(r.ok && r.value.paymentEffectiveDate).toBeNull();
    expect(r.ok && r.value.adjudicationCutoffDate).toBeNull();
    expect(r.ok && r.value.functionalGroupCreationDate).toBe("2026-06-16");
  });
  it.each([
    ["BPR16", (raw: string) => raw.replace("*20260615~", "*20260230~")],
    ["GS04", (raw: string) => raw.replace("20260616*1200*77", "20260230*1200*77")],
  ])("rejects invalid %s calendar dates", (_field, change) => {
    expect(parseX12835(change(wrap835(CLEAN_BODY)), "medicare").ok).toBe(false);
  });
});

describe("BPR02 = 0 with BPR04 other than NON (#671)", () => {
  // Pinned, not enforced: the TR3 rule is not in the repo and no real zero-pay MAC file has been seen.
  it("is accepted today", () => {
    const body = ["BPR*C*0.00*C*CHK************20260615", ...DENIAL_BODY.slice(1)];
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
  it("keeps multiple groups and repeated ST02 scoped to each group", () => {
    const interchange = wrap835Groups([
      { gs06: "77", gs04: "20260616", sets: [["0001", CLEAN_BODY]] },
      {
        gs06: "78",
        gs04: "20260617",
        sets: [
          ["0001", DENIAL_BODY],
          ["0002", CLEAN_BODY],
        ],
      },
    ]);
    const result = parseX12835AllSets(interchange, "medicare");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.map((x) => [
        x.functionalGroupControlNumber,
        x.transactionSetControlNumber,
        x.functionalGroupCreationDate,
      ]),
    ).toEqual([
      ["77", "0001", "2026-06-16"],
      ["78", "0001", "2026-06-17"],
      ["78", "0002", "2026-06-17"],
    ]);
    expect(parseX12835(interchange, "medicare", {}, "0001").ok).toBe(false);
    expect(parseX12835(interchange, "medicare", {}, "0001", "78")).toMatchObject({
      ok: true,
      value: { functionalGroupControlNumber: "78", totalPaymentAmount: 0 },
    });
    expect(parseX12835(interchange, "medicare", {}, "0001", "99").ok).toBe(false);
    const grouped = parseX12835Grouped(interchange, "medicare");
    expect(
      grouped.ok &&
        grouped.value.functionalGroups.map((group) => [
          group.controlNumber,
          group.creationDate,
          group.transactionSets.length,
        ]),
    ).toEqual([
      ["77", "2026-06-16", 1],
      ["78", "2026-06-17", 2],
    ]);
  });
  it("refuses mixed functional group types before returning any 835 result", () => {
    const mixed = wrap835Groups([
      { gs06: "77", gs04: "20260616", sets: [["0001", CLEAN_BODY]] },
      { gs06: "78", gs04: "20260617", sets: [["0002", DENIAL_BODY]] },
    ]).replace("GS*HP*SYNTHMAC*SYNTHHOSPICE*20260617", "GS*HN*SYNTHMAC*SYNTHHOSPICE*20260617");
    const result = parseX12835AllSets(mixed, "medicare");
    expect(!result.ok && result.degraded.code).toBe("X12_835_UNSUPPORTED_ROUTING");
  });
  it("rejects bad functional-group counts, unclosed groups, and a second ISA", () => {
    const interchange = wrap835Groups([
      { gs06: "77", gs04: "20260616", sets: [["0001", CLEAN_BODY]] },
      { gs06: "78", gs04: "20260617", sets: [["0002", DENIAL_BODY]] },
    ]);
    expect(parseX12835AllSets(interchange.replace("IEA*2*", "IEA*1*"), "medicare").ok).toBe(false);
    expect(parseX12835AllSets(interchange.replace("GE*1*78~", ""), "medicare").ok).toBe(false);
    expect(
      parseX12835AllSets(interchange.replace("IEA*2*", "ISA*" + "IEA*2*"), "medicare").ok,
    ).toBe(false);
    const reusedGroupControl = wrap835Groups([
      { gs06: "77", gs04: "20260616", sets: [["0001", CLEAN_BODY]] },
      { gs06: "77", gs04: "20260617", sets: [["0002", DENIAL_BODY]] },
    ]);
    expect(parseX12835AllSets(reusedGroupControl, "medicare").ok).toBe(false);
    expect(
      parseX12835AllSets(wrap835(CLEAN_BODY).replace("^*00501*", "^*00401*"), "medicare").ok,
    ).toBe(false);
  });
  it("parses many groups and transaction sets deterministically", () => {
    const interchange = wrap835Groups(
      Array.from({ length: 8 }, (_, groupIndex) => ({
        gs06: String(70 + groupIndex),
        gs04: "20260616",
        sets: Array.from(
          { length: 4 },
          (_, setIndex) =>
            [
              String(setIndex + 1).padStart(4, "0"),
              setIndex % 2 === 0 ? CLEAN_BODY : DENIAL_BODY,
            ] as const,
        ),
      })),
    );
    const result = parseX12835Grouped(interchange, "medicare");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.functionalGroups).toHaveLength(8);
    expect(result.value.functionalGroups.map((group) => group.transactionSets.length)).toEqual(
      Array(8).fill(4),
    );
    expect(result.value.functionalGroups[7]?.transactionSets[3]?.transactionSetControlNumber).toBe(
      "0004",
    );
  });
});
