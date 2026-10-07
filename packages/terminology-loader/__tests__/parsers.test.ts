// M38 loader — pure per-system parsers over tiny hand-made fixtures (GAP-108). A parser is `bytes -> rows` with
// strict validation: a row it cannot read FAILS the load rather than vanishing from the code system.
import { describe, expect, it } from "vitest";
import { LoaderDataError } from "../src/errors";
import { parseSource, toNdc11 } from "../src/parsers/index";
import {
  CARC_CSV,
  CVX_TXT,
  HCPCS_FIXED,
  ICD10CM_ORDER_2027,
  ICD10PCS_ORDER,
  LOINC_CSV,
  NDC_PACKAGE,
  NDC_PRODUCT,
  REVENUE_CSV,
  RXNCONSO,
  RXNREL,
  RXNSAT,
  SNOMED_CONCEPT,
  SNOMED_DESC,
  SNOMED_REL,
  bytes,
  hcpcsRecord,
  zip,
} from "./_fixtures";

const byCode = <T extends { code: string }>(rows: readonly T[], code: string): T => {
  const r = rows.find((x) => x.code === code);
  if (!r) throw new Error(`no ${code}`);
  return r;
};

describe("icd10cm", () => {
  it("reads codes, billable flags and parents from a raw order file", () => {
    const parsed = parseSource("icd10cm", bytes(ICD10CM_ORDER_2027));
    expect(parsed.concepts.map((c) => c.code)).toEqual([
      "I42",
      "I42.0",
      "I42.00",
      "I42.01",
      "C50.9",
      "C50.91",
    ]);
    const leaf = byCode(parsed.concepts, "I42.00");
    expect(leaf.properties.isBillableLeaf).toBe(true);
    expect(leaf.properties.parentCode).toBe("I42.0");
    expect(byCode(parsed.concepts, "I42.0").properties.isBillableLeaf).toBe(false);
    expect(parsed.warnings.join(" ")).toMatch(/Tabular List absent/);
  });

  it("finds the order file inside a zip", () => {
    const z = zip({ "icd10cm-order-2027.txt": ICD10CM_ORDER_2027 });
    expect(parseSource("icd10cm", z).concepts).toHaveLength(6);
  });

  it("rejects a line outside the fixed-width layout", () => {
    expect(() => parseSource("icd10cm", bytes("garbage line"))).toThrow(/fixed-width/);
  });
});

describe("icd10pcs", () => {
  it("accepts PCS codes that start with a digit", () => {
    const parsed = parseSource("icd10pcs", bytes(ICD10PCS_ORDER));
    expect(parsed.concepts.map((c) => c.code)).toEqual(["001", "0016070"]);
    expect(byCode(parsed.concepts, "0016070").properties.isBillableLeaf).toBe(true);
  });
});

describe("hcpcs", () => {
  it("parses the CMS fixed-width layout incl. Q5xxx, G-codes, a continuation line and a modifier", () => {
    const parsed = parseSource("hcpcs", bytes(HCPCS_FIXED));
    expect(parsed.concepts.map((c) => c.code)).toEqual(["Q5001", "G0299", "G0300", "26"]);
    expect(byCode(parsed.concepts, "Q5001")).toMatchObject({
      status: "active",
      effectiveDate: "2008-01-01",
    });
    const g0300 = byCode(parsed.concepts, "G0300");
    expect(g0300.display).toMatch(/LPN\) in the home health or hospice setting, each 15 minutes$/);
    expect(g0300).toMatchObject({ status: "deprecated", endDate: "2026-12-31" });
    expect(byCode(parsed.concepts, "26").properties.recordKind).toBe("modifier");
  });

  it("refuses a CPT-shaped code (D4)", () => {
    const text = hcpcsRecord({ code: "99213", recId: "3", long: "Office visit" });
    expect(() => parseSource("hcpcs", bytes(text))).toThrow(/CODE_INVALID|CPT/);
  });

  it("refuses an impossible date and an unknown record id", () => {
    expect(() =>
      parseSource(
        "hcpcs",
        bytes(hcpcsRecord({ code: "A0021", recId: "3", long: "x", add: "20261340" })),
      ),
    ).toThrow(/DATE_INVALID/);
    expect(() =>
      parseSource("hcpcs", bytes(hcpcsRecord({ code: "A0021", recId: "9", long: "x" }))),
    ).toThrow(/RECORD_INVALID/);
  });

  it("accepts a normalized CSV and still refuses CPT-shaped codes in it", () => {
    const ok = parseSource("hcpcs", bytes("code,display\nQ5002,Hospice care in assisted living\n"));
    expect(ok.concepts[0]).toMatchObject({ code: "Q5002", status: "active" });
    // a CSV is a single 'upload' entry, so the CSV branch is chosen by the zip's member extension
    const z = zip({ "hcpcs.csv": "code,display\n99213,Office visit\n" });
    expect(() => parseSource("hcpcs", z)).toThrow(LoaderDataError);
  });
});

describe("ndc", () => {
  it("keys concepts by the 11-digit package NDC, skips excluded rows, maps end-marketing to deprecated", () => {
    const z = zip({ "product.txt": NDC_PRODUCT, "package.txt": NDC_PACKAGE });
    const parsed = parseSource("ndc", z);
    expect(parsed.concepts.map((c) => c.code)).toEqual([
      "01111222203",
      "01111222205",
      "33333044401",
    ]);
    const gone = byCode(parsed.concepts, "33333044401");
    expect(gone).toMatchObject({ status: "deprecated", endDate: "2025-12-31" });
    expect(byCode(parsed.concepts, "01111222203").display).toBe(
      "Comfortex (morphine sulfate) SOLUTION — 30 mL in 1 BOTTLE",
    );
  });

  it("converts the three labeller segment shapes and refuses others", () => {
    expect(toNdc11("1111-2222-03")).toBe("01111222203");
    expect(toNdc11("12345-678-90")).toBe("12345067890");
    expect(toNdc11("12345-6789-1")).toBe("12345678901");
    expect(() => toNdc11("123-45-6")).toThrow(/segment shape/);
    expect(() => toNdc11("not-an-ndc")).toThrow(/dashed/);
  });
});

describe("cvx", () => {
  it("maps CDC vaccine status to concept status", () => {
    const parsed = parseSource("cvx", bytes(CVX_TXT));
    expect(parsed.concepts.map((c) => [c.code, c.status])).toEqual([
      ["21", "active"],
      ["54", "deprecated"],
      ["999", "active"],
    ]);
    expect(() => parseSource("cvx", bytes("21|a|b||Weird|1"))).toThrow(/STATUS_INVALID/);
  });
});

describe("x12 CARC/RARC and UB-04 revenue (normalized CSV)", () => {
  it("parses CARC with alphanumeric codes and an end date", () => {
    const parsed = parseSource("carc", bytes(CARC_CSV));
    expect(byCode(parsed.concepts, "A1")).toMatchObject({
      effectiveDate: "2000-01-01",
      endDate: "2030-12-31",
    });
  });

  it("parses revenue codes and enforces the 4-digit grammar", () => {
    expect(parseSource("revenue", bytes(REVENUE_CSV)).concepts.map((c) => c.code)).toEqual([
      "0651",
      "0652",
    ]);
    expect(() => parseSource("revenue", bytes("code,display\n651,Short\n"))).toThrow(
      /CODE_INVALID/,
    );
  });

  it("rejects duplicates, a missing column and an unknown status", () => {
    expect(() => parseSource("rarc", bytes("code,display\nN1,a\nN1,b\n"))).toThrow(
      /DUPLICATE_CODE/,
    );
    expect(() => parseSource("rarc", bytes("code\nN1\n"))).toThrow(/missing required column/);
    expect(() => parseSource("rarc", bytes("code,display,status\nN1,a,weird\n"))).toThrow(
      /STATUS_INVALID/,
    );
  });

  it("refuses an empty source", () => {
    expect(() => parseSource("carc", bytes("code,display\n"))).toThrow(/SOURCE_EMPTY/);
  });
});

describe("rxnorm", () => {
  const rrf = zip({
    "rrf/RXNCONSO.RRF": RXNCONSO,
    "rrf/RXNSAT.RRF": RXNSAT,
    "rrf/RXNREL.RRF": RXNREL,
  });

  it("builds one concept per RXCUI from RXNORM, non-suppressed atoms, labelled by best term type", () => {
    const parsed = parseSource("rxnorm", rrf);
    expect(parsed.concepts.map((c) => c.code)).toEqual(["100", "200", "300"]);
    expect(byCode(parsed.concepts, "200")).toMatchObject({
      display: "morphine 10 MG/ML Oral Solution",
    });
    expect(byCode(parsed.concepts, "200").properties).toMatchObject({
      tty: "SCD",
      ingredientRxcui: "100",
      ndcs: ["11112222203", "11112222205"],
    });
  });

  it("loads without the optional SAT/REL files and says so", () => {
    const parsed = parseSource("rxnorm", zip({ "RXNCONSO.RRF": RXNCONSO }));
    expect(parsed.warnings).toHaveLength(2);
    expect(byCode(parsed.concepts, "200").properties.ndcs).toEqual([]);
  });

  it("fails on a short RXNCONSO line", () => {
    expect(() => parseSource("rxnorm", zip({ "RXNCONSO.RRF": "1|ENG|P" }))).toThrow(
      /RECORD_INVALID/,
    );
  });
});

describe("snomed (RF2 snapshot, invented content)", () => {
  const rf2 = zip({
    "Snapshot/Terminology/sct2_Concept_Snapshot_US1000124_20240301.txt": SNOMED_CONCEPT,
    "Snapshot/Terminology/sct2_Description_Snapshot-en_US1000124_20240301.txt": SNOMED_DESC,
    "Snapshot/Terminology/sct2_Relationship_Snapshot_US1000124_20240301.txt": SNOMED_REL,
  });

  it("loads active concepts with FSN display, semantic tag and hierarchy path; skips inactive ones", () => {
    const parsed = parseSource("snomed", rf2);
    expect(parsed.concepts.map((c) => c.code)).toEqual(["900001001", "900001002"]);
    expect(byCode(parsed.concepts, "900001002")).toMatchObject({
      display: "Synthetic child disorder",
      effectiveDate: "2024-03-01",
      properties: {
        semanticTag: "disorder",
        fullySpecifiedName: "Synthetic child disorder (disorder)",
        hierarchyPath: ["900001001"],
      },
    });
  });

  it("fails when an active concept has no FSN", () => {
    const broken = zip({
      "sct2_Concept_Snapshot_x.txt": SNOMED_CONCEPT,
      "sct2_Description_Snapshot_x.txt": SNOMED_DESC.split("\n").slice(0, 2).join("\n"),
    });
    expect(() => parseSource("snomed", broken)).toThrow(/no active FSN/);
  });

  it("detects an is-a cycle", () => {
    const cyc = [
      SNOMED_REL.split("\n")[0],
      "1\t20240301\t1\t9\t900001001\t900001002\t0\t116680003\t9\t9",
      "2\t20240301\t1\t9\t900001002\t900001001\t0\t116680003\t9\t9",
    ].join("\n");
    const z = zip({
      "sct2_Concept_Snapshot_x.txt": SNOMED_CONCEPT,
      "sct2_Description_Snapshot_x.txt": SNOMED_DESC,
      "sct2_Relationship_Snapshot_x.txt": cyc,
    });
    expect(() => parseSource("snomed", z)).toThrow(/cyclic/);
  });
});

describe("loinc (invented content)", () => {
  it("reads columns by name incl. quoted fields with commas, and maps STATUS", () => {
    const parsed = parseSource("loinc", zip({ "LoincTable/Loinc.csv": LOINC_CSV }));
    expect(byCode(parsed.concepts, "99990-1")).toMatchObject({
      status: "active",
      display: "Synthetic analyte [Mass/volume] in Serum or Plasma",
      properties: { component: "Synthetic analyte", scale: "Qn", method: null },
    });
    expect(byCode(parsed.concepts, "99991-9")).toMatchObject({
      status: "retired",
      display: "Old, deprecated analyte",
    });
  });

  it("fails on a malformed LOINC number and on a missing column", () => {
    expect(() => parseSource("loinc", bytes(LOINC_CSV.replace("99990-1", "bad")))).toThrow(
      /CODE_INVALID/,
    );
    expect(() => parseSource("loinc", bytes("LOINC_NUM,COMPONENT\n1-1,a\n"))).toThrow(
      /missing required column/,
    );
  });
});
