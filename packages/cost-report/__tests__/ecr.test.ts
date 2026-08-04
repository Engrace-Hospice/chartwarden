import {
  ECR_SPEC_VERSION,
  type EcrHeaderContext,
  type EcrRecord,
  type SnapshotWorksheets,
  buildEcrArtifacts,
  formatRecordLine,
  parseRecordLine,
  recordsToText,
  renderPi,
  textToRecords,
  writeEcr,
} from "@wardenx/cost-report";
// @wardenx/cost-report — M27 ECR/PI generation pure-domain unit tests (D11, §1.1 / §2.4).
//
// Covers the deterministic fixed-field ECR writer (`writeEcr`), the records-model round-trip closure
// (`parse(write(x)) === x` via `textToRecords ∘ recordsToText`), the snapshot → artifacts adapter
// (`buildEcrArtifacts` ⇒ `{ ecrText, piText }`), and the human-readable Print-Image renderer (`renderPi`).
// PURE DOMAIN only — no DB, no Fastify, no network. Money is integer cents; M27 carries no PHI (D18).
import { describe, expect, it } from "vitest";

const HEADER: EcrHeaderContext = {
  providerCcn: "100001",
  fiscalYearStartDate: "2026-01-01",
  fiscalYearEndDate: "2026-12-31",
};

// A small worksheet fixture: keys are deliberately unsorted in source so we exercise the
// lexicographic-key determinism of the leaf walk (`ccn` < `totalCostCents`).
const WORKSHEETS: SnapshotWorksheets = {
  "S-1": { totalCostCents: 50000, ccn: "100001" },
};

describe("writeEcr — deterministic fixed-field text", () => {
  it("renders a byte-stable header / data / trailer line set for a small fixture", () => {
    const text = writeEcr(WORKSHEETS, HEADER);
    const lines = text.split("\r\n").filter((l) => l.length > 0);

    const expectedHeader = `1${"100001".padEnd(10)}2026010120261231${ECR_SPEC_VERSION.padEnd(12)}`;
    // leaf order is lexicographic by key: ccn (alpha) then totalCostCents (money).
    const expectedCcnLine = `2${"S-1".padEnd(7)}${"1".padStart(5, "0")}${"1".padStart(5, "0")}${"100001".padEnd(40)}`;
    const expectedMoneyLine = `3${"S-1".padEnd(7)}${"2".padStart(5, "0")}${"1".padStart(5, "0")}${"500.00".padStart(40)}`;
    // header + 2 data records precede the trailer ⇒ recordCount === 3.
    const expectedTrailer = `9${"3".padStart(7, "0")}`;

    expect(lines).toEqual([expectedHeader, expectedCcnLine, expectedMoneyLine, expectedTrailer]);
  });

  it("is deterministic — the same snapshot always yields byte-identical text", () => {
    expect(writeEcr(WORKSHEETS, HEADER)).toBe(writeEcr(WORKSHEETS, HEADER));
  });

  it("emits a blank-but-present header when no context is supplied (never fabricated)", () => {
    const text = writeEcr(WORKSHEETS);
    const firstLine = text.split("\r\n")[0]!;
    expect(firstLine.startsWith("1")).toBe(true);
    // CCN + both fiscal dates render blank (spaces), spec version defaults.
    expect(firstLine).toContain(ECR_SPEC_VERSION);
    expect(firstLine.slice(1, 11).trim()).toBe("");
  });
});

describe("records model — parse(write(x)) === x round-trip closure", () => {
  it("round-trips a mixed header / money / count / alpha / trailer record set", () => {
    const records: EcrRecord[] = [
      {
        recordKind: "header",
        providerCcn: "100001",
        fiscalYearStartDate: "2026-01-01",
        fiscalYearEndDate: "2026-12-31",
        ecrSpecVersion: ECR_SPEC_VERSION,
      },
      {
        recordKind: "data",
        worksheetCode: "A",
        lineNumber: 1,
        columnNumber: 1,
        value: { kind: "money", cents: 1234567 },
      },
      {
        recordKind: "data",
        worksheetCode: "A",
        lineNumber: 2,
        columnNumber: 1,
        value: { kind: "money", cents: -5 },
      },
      {
        recordKind: "data",
        worksheetCode: "S-2",
        lineNumber: 1,
        columnNumber: 1,
        value: { kind: "count", count: 365 },
      },
      {
        recordKind: "data",
        worksheetCode: "S-2",
        lineNumber: 1,
        columnNumber: 1,
        value: { kind: "alpha", text: "ACME HOSPICE LLC" },
      },
      { recordKind: "trailer", recordCount: 5 },
    ];

    // parse(write(x)) === x at the record level …
    expect(textToRecords(recordsToText(records))).toEqual(records);
    // … and per-line for each record individually.
    for (const r of records) {
      expect(parseRecordLine(formatRecordLine(r))).toEqual(r);
    }
  });

  it("writer output round-trips through the parser losslessly", () => {
    const text = writeEcr(WORKSHEETS, HEADER);
    // Re-serializing the parsed records reproduces the exact text.
    expect(recordsToText(textToRecords(text))).toBe(text);
  });

  it("preserves penny-exact negative cents across the dollars round-trip", () => {
    const rec: EcrRecord = {
      recordKind: "data",
      worksheetCode: "C",
      lineNumber: 7,
      columnNumber: 1,
      value: { kind: "money", cents: -98765 },
    };
    const back = parseRecordLine(formatRecordLine(rec));
    expect(back).toEqual(rec);
  });
});

describe("buildEcrArtifacts — snapshot → { ecrText, piText }", () => {
  it("returns both artifact strings, matching the underlying writer/renderer", () => {
    const artifacts = buildEcrArtifacts({ worksheetSnapshot: WORKSHEETS, header: HEADER });

    expect(Object.keys(artifacts).sort()).toEqual(["ecrText", "piText"]);
    expect(artifacts.ecrText).toBe(writeEcr(WORKSHEETS, HEADER));
    expect(artifacts.piText).toBe(renderPi(WORKSHEETS, HEADER, { format: "text" }));
    expect(artifacts.ecrText.length).toBeGreaterThan(0);
    expect(artifacts.piText.length).toBeGreaterThan(0);
  });

  it("prefers an option-supplied header over the snapshot's own header", () => {
    const snapHeader: EcrHeaderContext = { ...HEADER, providerCcn: "999999" };
    const overrideHeader: EcrHeaderContext = { ...HEADER, providerCcn: "111111" };
    const artifacts = buildEcrArtifacts(
      { worksheetSnapshot: WORKSHEETS, header: snapHeader },
      { header: overrideHeader },
    );
    expect(artifacts.ecrText.split("\r\n")[0]).toContain("111111");
    expect(artifacts.ecrText.split("\r\n")[0]).not.toContain("999999");
  });
});

describe("renderPi — non-empty, human-readable Print Image", () => {
  it("renders a labeled, review-facing text rendition with the identity banner", () => {
    const pi = renderPi(WORKSHEETS, HEADER);
    expect(pi.length).toBeGreaterThan(0);
    expect(pi).toContain("PRINT IMAGE");
    expect(pi).toContain("Provider CCN");
    expect(pi).toContain("100001");
    expect(pi).toContain("Worksheet S-1");
    // money leaf rendered as a dollar string, alpha leaf rendered as its label/value.
    expect(pi).toContain("$500.00");
    expect(pi).toContain("totalCostCents");
  });

  it("marks an unpopulated worksheet as '(not populated)'", () => {
    const pi = renderPi(WORKSHEETS, HEADER);
    // Worksheet 'A' is absent from the fixture snapshot.
    expect(pi).toContain("Worksheet A");
    expect(pi).toContain("(not populated)");
  });

  it("wraps the same text in an escaped <pre> block for the html variant", () => {
    const html = renderPi(WORKSHEETS, HEADER, { format: "html" });
    expect(html.startsWith("<pre")).toBe(true);
    expect(html).toContain("PRINT IMAGE");
  });
});
