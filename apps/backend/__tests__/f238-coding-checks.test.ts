// F-238 — the ICD-10-CM code scanner (codes come from the page, never the model; OCR repairs only when the
// repaired code is real AND its title matches the words written beside it) and the deterministic coding
// checks, scored against the complex referral packet's answer key on the real docling-worker OCR output,
// over a subset of the real CDC/NCHS FY2026+FY2027 code set (fixtures/doclens-complex-packet/).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ClassifiedPage,
  type CodeOnPage,
  type CodingFlag,
  type ScanPage,
  type ScannedCode,
  attachCodesToDiagnoses,
  findCodeTokens,
  resolveCodeTokens,
  runCodingChecks,
  splitPacket,
} from "@wardenx/intake-extraction";
import { describe, expect, it } from "vitest";
import { fixtureTerminology as T } from "./fixtures/doclens-complex-packet/fixture-terminology";

const DIR = join(__dirname, "fixtures", "doclens-complex-packet");
const key = JSON.parse(readFileSync(join(DIR, "complex-referral-packet.key.json"), "utf8"));
const pagesOf = (engine: string): (ScanPage & { blocks: { text: string; label: string }[] })[] =>
  JSON.parse(readFileSync(join(DIR, `parse.${engine}.json`), "utf8")).pages;
const docOfPage = (pg: number): string =>
  key.documents.find((d: { pages: [number, number] }) => pg >= d.pages[0] && pg <= d.pages[1]).id;

async function run(engine: string): Promise<{ scanned: ScannedCode[]; flags: CodingFlag[] }> {
  const pages = pagesOf(engine);
  const typeOf = new Map<number, ClassifiedPage["documentType"]>();
  for (const d of key.documents)
    for (let p = d.pages[0]; p <= d.pages[1]; p++) typeOf.set(p, d.type);
  const segs = splitPacket(
    pages,
    pages.map((p) => ({
      pageNumber: p.page,
      documentType: typeOf.get(p.page) ?? "unknown",
      confidence: 0.9,
      needsHumanClassification: false,
    })),
  );
  const seg = (pg: number) => segs.find((s) => s.pageNumbers.includes(pg));
  const scanned = await resolveCodeTokens(findCodeTokens(pages), T);
  const flags = await runCodingChecks(
    {
      referenceDate: "2026-10-02",
      pageText: new Map(pages.map((p) => [p.page, p.blocks.map((b) => b.text).join(" ")])),
      codes: scanned.map((s) => ({
        ...s,
        documentDate: seg(s.page)?.documentDate ?? null,
        documentKey: seg(s.page)?.pageNumbers[0] ?? s.page,
      })),
    },
    T,
  );
  return { scanned, flags };
}

const expectedCodes: string[] = key.conditions.flatMap(
  (c: { mentions: { page: number; codeAsWritten: string | null }[] }) =>
    c.mentions
      .filter((m) => m.codeAsWritten)
      .flatMap((m) => (m.codeAsWritten as string).split(", ").map((code) => `${m.page}:${code}`)),
);

describe("code scanner + coding checks on the complex packet (Tesseract OCR)", () => {
  it("finds every printed code on its page — repairing I→1 / Z→2 misreads only where the code's title matches", async () => {
    const { scanned } = await run("tesseract");
    const got = scanned.filter((s) => s.code).map((s) => `${s.page}:${s.code}`);
    expect(expectedCodes.filter((e) => !got.includes(e))).toEqual([]);
    const repairs = scanned.filter((s) => s.repaired).map((s) => `${s.raw}→${s.code}`);
    expect(repairs).toEqual(
      expect.arrayContaining(["110→I10", "150.23→I50.23", "113.0→I13.0", "299.81→Z99.81"]),
    );
    // Nothing that is not a printed code became one (phone area codes, vitals, "SBP").
    const extras = got.filter((g) => !expectedCodes.includes(g));
    expect(extras.every((g) => ["18:Z99.81", "18:Z87.891"].includes(g))).toBe(true); // real codes on the pulmonology note
  });

  it("raises every planted coding problem in the answer key", async () => {
    const { flags } = await run("tesseract");
    for (const f of key.expectedFlags as {
      kind: string;
      code?: string;
      codes?: string[];
      doc?: string;
      suggest?: string[];
    }[]) {
      if (f.kind === "conflicting_codes") {
        expect(
          flags.some(
            (x) =>
              x.kind === "conflicting_codes" &&
              (f.codes ?? []).filter((c) => x.code.includes(c)).length >= 2,
          ),
          f.kind,
        ).toBe(true);
        continue;
      }
      const hit = flags.find(
        (x) => x.kind === f.kind && x.code === f.code && docOfPage(x.page) === f.doc,
      );
      expect(hit, `${f.kind} ${f.code} @${f.doc}`).toBeDefined();
      for (const s of f.suggest ?? [])
        expect(hit?.suggest, `${f.kind} ${f.code} suggests ${s}`).toContain(s);
    }
  });

  it("judges each code by its document's date: I42.0 is invalid on the 10/01 discharge summary, retired-since on the 09/22 consult", async () => {
    const { flags } = await run("tesseract");
    const i420 = flags.filter((f) => f.code === "I42.0" && f.kind.startsWith("code_"));
    expect(i420.map((f) => `${f.kind}@${docOfPage(f.page)}`).sort()).toEqual([
      "code_not_valid_on_date@ds",
      "code_retired_since_written@cardio",
    ]);
    expect(i420[0]?.suggest).toEqual(["I42.00", "I42.01", "I42.09"]);
  });

  it("does not fail 2025 records for a release that is not loaded, and raises no unreadable-code noise", async () => {
    const { flags } = await run("tesseract");
    expect(
      flags.filter(
        (f) =>
          f.kind === "code_not_valid_on_date" && ["pulm", "memory"].includes(docOfPage(f.page)),
      ),
    ).toEqual([]);
    expect(flags.filter((f) => f.kind === "unreadable_code")).toEqual([]);
  });

  it("EasyOCR (the old engine) still finds most codes; what it drops it drops visibly, never by inventing", async () => {
    const { scanned } = await run("easyocr");
    const got = scanned.filter((s) => s.code).map((s) => `${s.page}:${s.code}`);
    expect(expectedCodes.filter((e) => got.includes(e)).length).toBeGreaterThanOrEqual(27);
  });
});

describe("scanner guard rails", () => {
  const page = (...texts: string[]): ScanPage[] => [
    { page: 1, blocks: texts.map((text) => ({ text })) },
  ];
  const scan = async (...texts: string[]) => resolveCodeTokens(findCodeTokens(page(...texts)), T);

  it("repairs a misread only when the repaired code's title matches the written diagnosis", async () => {
    expect((await scan("3. Hypertension (110)")).map((s) => [s.code, s.repaired])).toEqual([
      ["I10", true],
    ]);
    // Same characters, but a blood pressure: not a code.
    expect((await scan("BP 110/70, HR 88")).filter((s) => s.code)).toEqual([]);
    // Same characters in parentheses next to unrelated words: refused, not guessed.
    expect((await scan("Room (110) east wing")).filter((s) => s.code)).toEqual([]);
  });

  it("ignores phone numbers and vitals", async () => {
    expect(
      (await scan("Phone: (503) 555-0161", "T 37.2 C, SpO2 89%")).filter(
        (s) => s.code || s.codeShaped,
      ),
    ).toEqual([]);
  });

  it("keeps a printed code as written even when its title disagrees (the reviewer decides)", async () => {
    const [s] = await scan("Diagnosis: Pressure ulcer of sacral region, stage 2 (L89.152).");
    expect(s).toMatchObject({ code: "L89.152", repaired: false });
  });
});

describe("attaching page-scanned codes to the model's diagnosis wording", () => {
  const box = [10, 100, 400, 112] as const;
  const code = (over: Partial<CodeOnPage>): CodeOnPage => ({
    page: 4,
    blockIndex: 7,
    raw: "I48.21",
    context: "Permanent atrial fibrillation",
    codeContext: true,
    labelledRole: null,
    codeShaped: true,
    code: "I48.21",
    repaired: false,
    ambiguous: [],
    agreement: 2,
    blockBox: box,
    ...over,
  });

  it("gives a grounded description the code printed beside it — the value is always the scanned code", () => {
    const out = attachCodesToDiagnoses({
      diagnoses: [
        {
          index: 0,
          description: "Permanent atrial fibrillation",
          role: "secondary",
          page: 4,
          bbox: box,
          confidence: 0.9,
        },
      ],
      codes: [code({})],
      flags: [],
    });
    expect(out.map((c) => [c.fieldPath, c.value])).toEqual([
      ["diagnoses[0].description", "Permanent atrial fibrillation"],
      ["diagnoses[0].role", "secondary"],
      ["diagnoses[0].icd10", "I48.21"],
    ]);
  });

  it("one wording printed with two codes becomes two diagnoses; an undescribed printed code is still surfaced", () => {
    const dementia = { context: "Alzheimer's dementia", blockIndex: 8 };
    const out = attachCodesToDiagnoses({
      diagnoses: [
        {
          index: 0,
          description: "Alzheimer's dementia",
          role: null,
          page: 4,
          bbox: box,
          confidence: 0.9,
        },
      ],
      codes: [
        code({ ...dementia, code: "G30.9", raw: "G30.9" }),
        code({ ...dementia, code: "F02.80", raw: "F02.80" }),
        code({
          blockIndex: 9,
          context: "Anemia of chronic kidney disease",
          code: "D63.1",
          raw: "D63.1",
          blockBox: [10, 120, 400, 132],
        }),
      ],
      flags: [
        {
          kind: "manifestation_code",
          code: "F02.80",
          page: 4,
          blockIndex: 8,
          suggest: [],
          detail: "x",
        },
      ],
    });
    const icd = out.filter((c) => c.fieldPath.endsWith(".icd10"));
    expect(icd.map((c) => [c.fieldPath, c.value, c.fromScan])).toEqual([
      ["diagnoses[0].icd10", "G30.9", true],
      ["diagnoses[1].icd10", "F02.80", true],
      ["diagnoses[2].icd10", "D63.1", true],
    ]);
    expect(icd[1]?.codingFlags?.map((f) => f.kind)).toEqual(["manifestation_code"]);
    expect(out.find((c) => c.fieldPath === "diagnoses[2].description")).toMatchObject({
      value: "Anemia of chronic kidney disease",
      fromScan: true,
    });
  });

  it("a code on the same block but for different wording is not stolen by the wrong diagnosis", () => {
    const out = attachCodesToDiagnoses({
      diagnoses: [
        {
          index: 0,
          description: "Moderate protein-calorie malnutrition",
          role: null,
          page: 4,
          bbox: box,
          confidence: 0.9,
        },
      ],
      codes: [code({})], // atrial fibrillation's code, same block
      flags: [],
    });
    expect(out.find((c) => c.fieldPath === "diagnoses[0].icd10")).toBeUndefined();
    expect(out.find((c) => c.value === "I48.21")?.fieldPath).toBe("diagnoses[1].icd10");
  });
});
