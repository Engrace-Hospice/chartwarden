// Golden-file harness for the M22 PDF forms (GAP-033). A layout or fixed-text change must be an explicit, reviewed
// diff, never an accident. Three artifacts per form, under __tests__/__golden__/m22/:
//   <key>.model.json  the DocModel (content + order; the reviewable diff of what the form says)
//   <key>.pages.txt   the laid-out text per page (catches wrap/pagination regressions)
//   <key>.sha256      sha256 of the PDF bytes (valid because the writer is byte-deterministic)
// Regenerate deliberately:  UPDATE_GOLDEN=1 bun run test:golden:m22
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import type { DocModel } from "../src/modules/22-documents/render-pdf/doc-model";
import { layoutDocument, pageTexts } from "../src/modules/22-documents/render-pdf/layout";
import { renderDocModelToPdf } from "../src/modules/22-documents/render-pdf/pdf-writer";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "__golden__", "m22");
const UPDATING = process.env.UPDATE_GOLDEN === "1";

function compareOrWrite(file: string, actual: string): void {
  const path = join(GOLDEN_DIR, file);
  if (UPDATING || !existsSync(path)) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, actual);
    return;
  }
  expect(
    actual,
    `${file} drifted - review the diff, then UPDATE_GOLDEN=1 bun run test:golden:m22`,
  ).toBe(readFileSync(path, "utf8"));
}

/** Check (or, with UPDATE_GOLDEN=1, rewrite) the three goldens of one form render. */
export function expectGolden(name: string, doc: DocModel): void {
  compareOrWrite(`${name}.model.json`, `${JSON.stringify(doc, null, 2)}\n`);
  const pages = pageTexts(layoutDocument(doc))
    .map((lines, i) => `--- page ${i + 1} ---\n${lines.join("\n")}`)
    .join("\n");
  compareOrWrite(`${name}.pages.txt`, `${pages}\n`);
  const sha = createHash("sha256").update(renderDocModelToPdf(doc)).digest("hex");
  compareOrWrite(`${name}.sha256`, `${sha}\n`);
}
