// F-238 — the ICD-10-CM release parsers behind `scripts/db/load-icd10cm.ts`. Fixtures are cut from the real
// NCHS FY2026/FY2027 files (same fixed-width columns, same tabular XML shape), so a layout misread fails here.
import { describe, expect, it } from "vitest";
import {
  buildConceptRows,
  deprecationsBetween,
  dotted,
  midYearAdditions,
  parentOf,
  parseOrderAddenda,
  parseOrderFile,
  parseTabular,
} from "../db/lib/icd10cm-release";

const line = (order: number, code: string, billable: 0 | 1, short: string, long: string) =>
  `${String(order).padStart(5, "0")} ${code.padEnd(7)} ${billable} ${short.padEnd(60)} ${long}`;

const FY27_ORDER = [
  line(
    5190,
    "F02",
    0,
    "Dementia in other diseases classified elsewhere",
    "Dementia in other diseases classified elsewhere",
  ),
  line(
    5191,
    "F02B",
    0,
    "Dementia in other dis classd elswhr, moderate",
    "Dementia in other diseases classified elsewhere, moderate",
  ),
  line(
    5192,
    "F02B0",
    1,
    "Dem in other dis classd elswhr, mod, w/o beh/psych/mood/anx",
    "Dementia in other diseases classified elsewhere, moderate, without behavioral disturbance, psychotic disturbance, mood disturbance, and anxiety",
  ),
  line(11800, "I42", 0, "Cardiomyopathy", "Cardiomyopathy"),
  line(11801, "I420", 0, "Dilated cardiomyopathy", "Dilated cardiomyopathy"),
  line(
    11802,
    "I4200",
    1,
    "Dilated cardiomyopathy, unspecified",
    "Dilated cardiomyopathy, unspecified",
  ),
  line(
    11803,
    "I4201",
    1,
    "Familial-genetic dilated cardiomyopathy",
    "Familial-genetic dilated cardiomyopathy",
  ),
  line(11900, "I50", 0, "Heart failure", "Heart failure"),
  line(
    11901,
    "I502",
    0,
    "Systolic (congestive) heart failure",
    "Systolic (congestive) heart failure",
  ),
  line(
    11902,
    "I5022",
    1,
    "Chronic systolic (congestive) heart failure",
    "Chronic systolic (congestive) heart failure",
  ),
  line(12000, "I10", 1, "Essential (primary) hypertension", "Essential (primary) hypertension"),
  line(40000, "T814", 0, "Infection following a procedure", "Infection following a procedure"),
  line(
    40001,
    "T8140XA",
    1,
    "Infct fol a procedure, unsp, init",
    "Infection following a procedure, unspecified, initial encounter",
  ),
].join("\n");

const FY26_ORDER = [
  line(11800, "I42", 0, "Cardiomyopathy", "Cardiomyopathy"),
  line(11801, "I420", 1, "Dilated cardiomyopathy", "Dilated cardiomyopathy"),
  line(11900, "I50", 0, "Heart failure", "Heart failure"),
  line(
    11901,
    "I502",
    0,
    "Systolic (congestive) heart failure",
    "Systolic (congestive) heart failure",
  ),
  line(
    11902,
    "I5022",
    1,
    "Chronic systolic (congestive) heart failure",
    "Chronic systolic (congestive) heart failure",
  ),
  line(12000, "I10", 1, "Essential (primary) hypertension", "Essential (primary) hypertension"),
].join("\n");

const FY27_ADDENDA = [
  "Delete:      1 I420    Dilated cardiomyopathy                                       Dilated cardiomyopathy",
  "Add:         0 I420    Dilated cardiomyopathy                                       Dilated cardiomyopathy",
  "Add:         1 I4200   Dilated cardiomyopathy, unspecified                          Dilated cardiomyopathy, unspecified",
  "Add:         1 I4201   Familial-genetic dilated cardiomyopathy                      Familial-genetic dilated cardiomyopathy",
  "Revise from: 1 I10     Essential (primary) hypertension                             Essential (primary) hypertension",
].join("\n");

const TABULAR = `<?xml version="1.0" encoding="utf-8"?>
<ICD10CM.tabular>
  <chapter><name>5</name><desc>Mental, Behavioral and Neurodevelopmental disorders (F01-F99)</desc>
    <section id="F01-F09"><desc>Mental disorders due to known physiological conditions (F01-F09)</desc>
      <diag><name>F02</name><desc>Dementia in other diseases classified elsewhere</desc>
        <codeFirst><note>the underlying physiological condition, such as:</note><note>Alzheimer's (G30.-)</note></codeFirst>
        <diag><name>F02.B</name><desc>Dementia in other diseases classified elsewhere, moderate</desc>
          <diag><name>F02.B0</name><desc>Dementia in other diseases classified elsewhere, moderate, without behavioral disturbance</desc></diag>
        </diag>
      </diag>
    </section>
  </chapter>
  <chapter><name>9</name><desc>Diseases of the circulatory system (I00-I99)</desc>
    <section id="I10-I1A"><desc>Hypertensive diseases (I10-I1A)</desc>
      <diag><name>I10</name><desc>Essential (primary) hypertension</desc>
        <excludes1><note>hypertensive disease complicating pregnancy (O10-O11)</note></excludes1>
      </diag>
    </section>
    <section id="I30-I5A"><desc>Other forms of heart disease (I30-I5A)</desc>
      <diag><name>I42</name><desc>Cardiomyopathy</desc>
        <diag><name>I42.0</name><desc>Dilated cardiomyopathy</desc>
          <diag><name>I42.00</name><desc>Dilated cardiomyopathy, unspecified</desc></diag>
          <diag><name>I42.01</name><desc>Familial-genetic dilated cardiomyopathy</desc></diag>
        </diag>
      </diag>
      <diag><name>I50</name><desc>Heart failure</desc>
        <codeFirst><note>heart failure due to hypertension (I11.0)</note><note>heart failure due to hypertension with chronic kidney disease (I13.-)</note></codeFirst>
        <diag><name>I50.2</name><desc>Systolic (congestive) heart failure</desc>
          <diag><name>I50.22</name><desc>Chronic systolic (congestive) heart failure</desc></diag>
        </diag>
      </diag>
    </section>
  </chapter>
  <chapter><name>19</name><desc>Injury, poisoning (S00-T88)</desc>
    <section id="T80-T88"><desc>Complications of surgical and medical care (T80-T88)</desc>
      <diag><name>T81.4</name><desc>Infection following a procedure</desc>
        <useAdditionalCode><note>code to identify infection</note></useAdditionalCode>
      </diag>
    </section>
  </chapter>
</ICD10CM.tabular>`;

describe("ICD-10-CM release parsers", () => {
  it("dots codes the way the chart stores them", () => {
    expect(dotted("I5022")).toBe("I50.22");
    expect(dotted("I10")).toBe("I10");
    expect(dotted("t8140xa")).toBe("T81.40XA");
  });

  it("reads the fixed-width order file, and refuses a line that is not in that layout", () => {
    const rows = parseOrderFile(FY27_ORDER);
    expect(rows).toHaveLength(13);
    expect(rows.find((r) => r.code === "F02B0")).toMatchObject({
      billable: true,
      shortTitle: "Dem in other dis classd elswhr, mod, w/o beh/psych/mood/anx",
    });
    expect(rows.find((r) => r.code === "I420")?.billable).toBe(false);
    expect(() => parseOrderFile("not an order line")).toThrow(/fixed-width/);
  });

  it("reads the addenda actions", () => {
    const a = parseOrderAddenda(FY27_ADDENDA);
    expect(a.map((x) => `${x.action}:${x.code}:${x.billable ? 1 : 0}`)).toEqual([
      "delete:I420:1",
      "add:I420:0",
      "add:I4200:1",
      "add:I4201:1",
      "revise_from:I10:1",
    ]);
    expect(a[2]?.title).toBe("Dilated cardiomyopathy, unspecified");
  });

  it("finds the nearest existing parent, stripping 7th-character placeholders", () => {
    const known = new Set(parseOrderFile(FY27_ORDER).map((e) => e.code));
    expect(parentOf("I5022", known)).toBe("I502");
    expect(parentOf("T8140XA", known)).toBe("T814");
    expect(parentOf("I10", known)).toBeNull();
  });

  it("inherits instructional notes downward and marks manifestation codes", () => {
    const rows = buildConceptRows(parseOrderFile(FY27_ORDER), parseTabular(TABULAR));
    const by = new Map(rows.map((r) => [r.code, r]));
    const f02b0 = by.get("F02.B0");
    expect(f02b0).toMatchObject({ chapter: "5", parentCode: "F02.B", isBillableLeaf: true });
    expect(f02b0?.properties).toMatchObject({
      manifestation: true,
      hasCodeFirstNote: true,
      noteSources: ["F02"],
    });
    // I50.22 inherits I50's (conditional) code-first note but is not a manifestation code.
    expect(by.get("I50.22")?.properties).toMatchObject({
      manifestation: false,
      hasCodeFirstNote: true,
    });
    // The note TEXT stays where it is stated.
    expect(by.get("I50")?.properties.notes?.codeFirst).toHaveLength(2);
    expect(by.get("I50.22")?.properties.notes).toBeUndefined();
    expect(by.get("I10")?.properties).toMatchObject({
      hasCodeFirstNote: false,
      notes: { excludes1: [expect.any(String)] },
    });
    expect(by.get("T81.40XA")?.properties.useAdditionalCode).toBe(true);
  });

  it("maps a code that became a header to its new billable children", () => {
    const deps = deprecationsBetween(parseOrderFile(FY26_ORDER), parseOrderFile(FY27_ORDER));
    expect(deps).toEqual([
      expect.objectContaining({
        code: "I42.0",
        successors: ["I42.00", "I42.01"],
        kind: "narrower",
      }),
    ]);
  });

  it("dates codes added by a mid-year update instead of treating them as new in October", () => {
    const mid = midYearAdditions(
      parseOrderFile(FY26_ORDER),
      parseOrderFile(FY27_ORDER),
      parseOrderAddenda(FY27_ADDENDA),
    );
    // F02*, T81.4*: not in FY2026 and not on FY2027's October Add list → April additions in this fixture.
    expect([...mid].sort()).toEqual(["F02", "F02B", "F02B0", "T814", "T8140XA"]);
    expect(mid.has("I4200")).toBe(false);
  });
});
