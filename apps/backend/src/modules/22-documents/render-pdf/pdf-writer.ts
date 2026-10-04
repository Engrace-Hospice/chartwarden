// apps/backend/src/modules/22-documents/render-pdf/pdf-writer.ts — a minimal, dependency-free PDF 1.4 writer
// for laid-out pages: base-14 Helvetica / Helvetica-Bold (WinAnsi), uncompressed content streams, a classic
// xref table. Deterministic by construction: no wall clock, no random ids — /CreationDate comes from the
// document model and the trailer /ID is a hash of the body, so identical models yield identical bytes.
//
// Why hand-rolled: no PDF library is installed in this monorepo (no pdf-lib/pdfkit/jspdf/@react-pdf), and
// text-only, standard-font documents need ~150 lines of PDF syntax. Adding a dependency would pull a new
// supply-chain surface (and an `arch:vuln-allowlist` review) into an EHR for no capability we use.
import { createHash } from "node:crypto";
import type { DocModel } from "./doc-model";
import {
  type LaidOutPage,
  MARGIN_X,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  type PageOp,
  type Rgb,
  layoutDocument,
} from "./layout";
import { type FontKey, textWidth, toWinAnsi } from "./text";

const num = (n: number): string => {
  const s = n.toFixed(2);
  return s.replace(/\.?0+$/, "") || "0";
};
const rgb = (c: Rgb): string => `${num(c[0])} ${num(c[1])} ${num(c[2])}`;

/** A PDF literal string from WinAnsi bytes: ( ) \ escaped, every non-ASCII byte as an octal escape, so the
 * whole file stays 7-bit clean and byte offsets equal string offsets. */
function pdfString(text: string): string {
  let out = "(";
  for (const b of toWinAnsi(text)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) out += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) out += `\\${b.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(b);
  }
  return `${out})`;
}

/** ISO instant -> PDF date string `D:YYYYMMDDHHmmSSZ`. */
export function pdfDate(iso: string): string {
  const d = new Date(iso);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function opToStream(op: PageOp): string {
  switch (op.op) {
    case "text": {
      const run = `BT /${op.font} ${num(op.size)} Tf ${rgb(op.color)} rg ${num(op.x)} ${num(op.y)} Td ${pdfString(op.text)} Tj ET`;
      // `Tc` is graphics state that outlives ET — scope it in q/Q so later text keeps the font's spacing.
      return op.charSpacing ? `q ${num(op.charSpacing)} Tc ${run} Q` : run;
    }
    case "rect": {
      const path = `${num(op.x)} ${num(op.y)} ${num(op.w)} ${num(op.h)} re`;
      const fill = op.fill ? `${rgb(op.fill)} rg ` : "";
      const stroke = op.stroke ? `${rgb(op.stroke)} RG 0.75 w ` : "";
      const paint = op.fill && op.stroke ? "B" : op.fill ? "f" : "S";
      return `q ${fill}${stroke}${path} ${paint} Q`;
    }
    case "line":
      return `q ${rgb(op.stroke)} RG ${num(op.width)} w ${num(op.x1)} ${num(op.y1)} m ${num(op.x2)} ${num(op.y2)} l S Q`;
  }
}

function footerOps(title: string, pageNo: number, pageCount: number): PageOp[] {
  const color: Rgb = [0.45, 0.47, 0.52];
  const label = `Page ${pageNo} of ${pageCount}`;
  const font: FontKey = "F1";
  return [
    {
      op: "line",
      x1: MARGIN_X,
      y1: 46,
      x2: PAGE_WIDTH - MARGIN_X,
      y2: 46,
      stroke: [0.8, 0.82, 0.85],
      width: 0.5,
    },
    {
      op: "text",
      x: MARGIN_X,
      y: 34,
      font,
      size: 8,
      text: `${title} - Confidential: contains protected health information`,
      color,
    },
    {
      op: "text",
      x: PAGE_WIDTH - MARGIN_X - textWidth(label, font, 8),
      y: 34,
      font,
      size: 8,
      text: label,
      color,
    },
  ];
}

/** Serialise laid-out pages into PDF bytes. */
export function writePdf(doc: DocModel, pages: readonly LaidOutPage[]): Uint8Array {
  // Object numbering: 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then (page, content) pairs.
  const pageCount = Math.max(pages.length, 1);
  const bodies: string[] = [];
  const pageObjNums: number[] = [];
  const firstPageObj = 6;
  for (let i = 0; i < pageCount; i++) pageObjNums.push(firstPageObj + i * 2);

  bodies[1] = `<< /Type /Catalog /Pages 2 0 R /Lang (en-US) /ViewerPreferences << /DisplayDocTitle true >> >>`;
  bodies[2] = `<< /Type /Pages /Count ${pageCount} /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] >>`;
  bodies[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  bodies[4] =
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  const date = pdfDate(doc.createdAtIso);
  bodies[5] = `<< /Title ${pdfString(doc.title)} /Producer (WardenX M22 renderer) /Creator (WardenX) /CreationDate (${date}) /ModDate (${date}) >>`;

  for (let i = 0; i < pageCount; i++) {
    const ops = [...(pages[i]?.ops ?? []), ...footerOps(doc.title, i + 1, pageCount)];
    const stream = ops.map(opToStream).join("\n");
    const pageNum = firstPageObj + i * 2;
    bodies[pageNum] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageNum + 1} 0 R >>`;
    bodies[pageNum + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }

  const lastObj = firstPageObj + pageCount * 2 - 1;
  let out = "%PDF-1.4\n%âãÏÓ\n";
  const offsets: number[] = [];
  for (let n = 1; n <= lastObj; n++) {
    offsets[n] = out.length;
    out += `${n} 0 obj\n${bodies[n]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${lastObj + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= lastObj; n++) out += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  const id = createHash("sha256").update(out, "latin1").digest("hex").slice(0, 32);
  out += `trailer\n<< /Size ${lastObj + 1} /Root 1 0 R /Info 5 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** Lay out and serialise a document model. Pure and deterministic. */
export function renderDocModelToPdf(doc: DocModel): Uint8Array {
  return writePdf(doc, layoutDocument(doc));
}
