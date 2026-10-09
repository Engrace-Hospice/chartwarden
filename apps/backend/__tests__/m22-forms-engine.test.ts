// GAP-033 Wave 0 - the renderer engine primitives: field grid, verbatim legal text, check boxes, signature
// blocks, keep-together, running header, watermark, and the disclosed (never silent) glyph degradation.
import { describe, expect, it } from "vitest";
import type { Block, DocModel } from "../src/modules/22-documents/render-pdf/doc-model";
import {
  documentDegradedGlyphs,
  layoutDocument,
  pageTexts,
} from "../src/modules/22-documents/render-pdf/layout";
import { renderDocModelToPdf } from "../src/modules/22-documents/render-pdf/pdf-writer";
import { countDegradedGlyphs } from "../src/modules/22-documents/render-pdf/text";

const doc = (blocks: Block[], extra: Partial<DocModel> = {}): DocModel => ({
  title: "Engine Test",
  createdAtIso: "2026-10-01T00:00:00.000Z",
  blocks,
  ...extra,
});

const raw = (d: DocModel): string => Buffer.from(renderDocModelToPdf(d)).toString("latin1");
const filler = (n: number): Block[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "paragraph", text: `Filler line ${i}` }) as Block);

describe("legalText is never truncated and keeps two lines either side of a page break", () => {
  it("prints every word of a very long verbatim text", () => {
    const text = Array.from({ length: 600 }, (_, i) => `word${i}`).join(" ");
    const printed = pageTexts(layoutDocument(doc([{ kind: "legalText", id: "x", text }])))
      .flat()
      .join(" ");
    expect(printed).toContain("word0");
    expect(printed).toContain("word599");
  });

  it("never leaves a single line alone on a page", () => {
    for (let pad = 40; pad <= 52; pad++) {
      const text = Array.from({ length: 160 }, (_, i) => `w${i}`).join(" ");
      const pages = pageTexts(
        layoutDocument(doc([...filler(pad), { kind: "legalText", id: "x", text }])),
      );
      const legalPerPage = pages.map((p) => p.filter((l) => /^w\d/.test(l)).length);
      for (const n of legalPerPage) expect(n === 0 || n >= 2).toBe(true);
    }
  });
});

describe("signature and attestation blocks", () => {
  it("prints printed name, date/time, meaning and reference (21 CFR 11.50)", () => {
    const pages = pageTexts(
      layoutDocument(
        doc([
          {
            kind: "signature",
            role: "Hospice physician",
            printedName: "Dr. Imani Okafor",
            credentials: "MD",
            npi: "1234567893",
            signedAt: "2026-09-30T14:05:00.000Z",
            method: "electronic",
            meaning: "certification",
            ref: "1a2b3c4d-9999",
          },
        ]),
      ),
    )
      .flat()
      .join("\n");
    expect(pages).toContain("Electronically signed by Dr. Imani Okafor, MD (NPI 1234567893)");
    expect(pages).toContain("2026-09-30 14:05 UTC");
    expect(pages).toContain("Meaning of signature: Certification");
    expect(pages).toContain("Signature record ref 1a2b3c4d");
  });

  it("a paper signature prints the ruled blank AND the record-of-scan line", () => {
    const d = doc([
      {
        kind: "signature",
        role: "Patient",
        printedName: "A Patient",
        signedAt: "2026-09-02",
        method: "wet_ink_scanned",
        ruledLine: true,
      },
    ]);
    const laid = layoutDocument(d);
    expect(pageTexts(laid).flat().join("\n")).toContain("Record of scan");
    expect(laid[0]?.ops.filter((o) => o.op === "line").length).toBeGreaterThanOrEqual(2);
  });

  it("keepTogether moves a signature group to the next page instead of splitting it", () => {
    const sig: Block = {
      kind: "signature",
      role: "Physician",
      printedName: "Dr. A",
      signedAt: "2026-09-30T14:05:00.000Z",
      method: "electronic",
      meaning: "certification",
      ref: "abcdef12",
    };
    let moved = false;
    for (let pad = 38; pad <= 52 && !moved; pad++) {
      const pages = pageTexts(
        layoutDocument(doc([...filler(pad), { kind: "keepTogether", blocks: [sig, sig] }])),
      );
      const withSig = pages.map((p) => p.filter((l) => l === "Physician").length);
      // never one signature on a page and the other on the next
      expect(withSig.every((n) => n === 0 || n === 2)).toBe(true);
      if (pages.length > 1 && withSig[0] === 0) moved = true;
    }
    expect(moved).toBe(true);
  });
});

describe("options and check boxes", () => {
  it("draws check boxes as rectangles (WinAnsi has no ballot-box glyph) and crosses the selected one", () => {
    const laid = layoutDocument(
      doc([
        {
          kind: "options",
          title: "Choose one",
          items: [
            { label: "Option 1", selected: true },
            { label: "Option 2", selected: false },
          ],
        },
      ]),
    );
    const ops = laid[0]?.ops ?? [];
    expect(ops.filter((o) => o.op === "rect")).toHaveLength(2);
    expect(ops.filter((o) => o.op === "line")).toHaveLength(2);
  });
});

describe("running header and watermark", () => {
  it("draws the running header on pages 2..N only", () => {
    const text = raw(doc(filler(120), { runningHeader: "Zelda Q - MRN 1 - Engine Test" }));
    const pages = text.split("/Type /Page /Parent").slice(1);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]).not.toContain("Zelda Q");
    for (const page of pages.slice(1)) expect(page).toContain("Zelda Q");
  });

  it("draws a translucent rotated watermark on every page, under the content", () => {
    const text = raw(doc(filler(120), { watermark: { text: "VOID", tone: "danger" } }));
    expect(text).toContain("/ExtGState << /GS1 << /ca 0.12 /CA 0.12 >> >>");
    const streams = [...text.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) => m[1] as string);
    expect(streams.length).toBeGreaterThan(1);
    for (const s of streams) {
      expect(s.startsWith("q /GS1 gs BT /F2 64 Tf")).toBe(true);
      expect(s).toContain("(VOID) Tj");
    }
  });

  it("leaves the resources untouched when there is no watermark", () => {
    expect(raw(doc(filler(3)))).not.toContain("ExtGState");
  });
});

describe("glyph degradation is disclosed, not silent (R1)", () => {
  it("counts code points WinAnsi cannot draw; plain ASCII and a literal ? are not counted", () => {
    expect(countDegradedGlyphs("Jose Garcia ?")).toBe(0);
    expect(countDegradedGlyphs("José")).toBe(0);
    expect(countDegradedGlyphs("王小明")).toBe(3);
  });

  it("prints a footer note on a disclosing document that lost glyphs, and not otherwise", () => {
    const lossy = doc([{ kind: "paragraph", text: "Patient: 王小明" }], {
      discloseDegradedGlyphs: true,
    });
    expect(documentDegradedGlyphs(lossy)).toBe(3);
    expect(raw(lossy)).toContain("Some characters could not be displayed");
    const clean = doc([{ kind: "paragraph", text: "Patient: Jose" }], {
      discloseDegradedGlyphs: true,
    });
    expect(raw(clean)).not.toContain("Some characters could not be displayed");
    const notDisclosing = doc([{ kind: "paragraph", text: "王小明" }]);
    expect(raw(notDisclosing)).not.toContain("Some characters could not be displayed");
  });
});
