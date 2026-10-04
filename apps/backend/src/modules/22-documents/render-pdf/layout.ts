// apps/backend/src/modules/22-documents/render-pdf/layout.ts — the pure layout engine: DocModel -> pages of
// drawing ops (US Letter). Wraps text with the Helvetica metrics, paginates paragraphs/tables/entries line
// by line, repeats table headers on each page and keeps headings with the text that follows them.
import type { Block, DocModel, Tone } from "./doc-model";
import { type FontKey, sanitizeText, textWidth, wrapText } from "./text";

export const PAGE_WIDTH = 612;
export const PAGE_HEIGHT = 792;
export const MARGIN_X = 54;
export const MARGIN_TOP = 60;
export const MARGIN_BOTTOM = 62; // room for the footer
export const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN_X;

export type Rgb = readonly [number, number, number];

export type PageOp =
  | {
      readonly op: "text";
      readonly x: number;
      readonly y: number;
      readonly font: FontKey;
      readonly size: number;
      readonly text: string;
      readonly color: Rgb;
      /** Extra space between characters in points (PDF `Tc`) — absent = the font's own spacing. */
      readonly charSpacing?: number;
    }
  | {
      readonly op: "rect";
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly fill?: Rgb;
      readonly stroke?: Rgb;
    }
  | {
      readonly op: "line";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
      readonly stroke: Rgb;
      readonly width: number;
    };

export interface LaidOutPage {
  readonly ops: PageOp[];
}

const INK: Rgb = [0.1, 0.1, 0.12];
const MUTED: Rgb = [0.38, 0.4, 0.45];
const RULE: Rgb = [0.75, 0.77, 0.8];
const HEAD_FILL: Rgb = [0.93, 0.95, 0.98];
const TONES: Record<Tone, { fill: Rgb; stroke: Rgb; ink: Rgb }> = {
  info: { fill: [0.92, 0.95, 1], stroke: [0.55, 0.68, 0.9], ink: [0.1, 0.2, 0.45] },
  warn: { fill: [1, 0.96, 0.85], stroke: [0.9, 0.7, 0.2], ink: [0.45, 0.3, 0] },
  danger: { fill: [1, 0.91, 0.9], stroke: [0.85, 0.35, 0.3], ink: [0.55, 0.1, 0.08] },
};

const BODY = 10;
const BODY_LEADING = 13.5;
const SMALL = 8.5;
const SMALL_LEADING = 11.5;
const CELL_PAD = 4;

class Cursor {
  readonly pages: LaidOutPage[] = [];
  y = 0;
  constructor() {
    this.newPage();
  }
  get page(): LaidOutPage {
    return this.pages[this.pages.length - 1] as LaidOutPage;
  }
  newPage(): void {
    this.pages.push({ ops: [] });
    this.y = PAGE_HEIGHT - MARGIN_TOP;
  }
  /** Room left above the bottom margin. */
  get room(): number {
    return this.y - MARGIN_BOTTOM;
  }
  ensure(height: number): void {
    if (this.room < height) this.newPage();
  }
}

function drawText(
  c: Cursor,
  text: string,
  x: number,
  baselineY: number,
  font: FontKey,
  size: number,
  color: Rgb,
): void {
  if (text === "") return;
  c.page.ops.push({ op: "text", x, y: baselineY, font, size, text, color });
}

/** Draw wrapped lines top-down starting at cursor.y, paginating between lines. */
function flowLines(
  c: Cursor,
  lines: readonly string[],
  x: number,
  font: FontKey,
  size: number,
  leading: number,
  color: Rgb,
): void {
  for (const line of lines) {
    c.ensure(leading);
    drawText(c, line, x, c.y - size, font, size, color);
    c.y -= leading;
  }
}

function layoutBlock(c: Cursor, b: Block): void {
  switch (b.kind) {
    case "title": {
      const lines = wrapText(b.text, "F2", 18, CONTENT_WIDTH);
      c.ensure(lines.length * 23 + (b.subtitle ? 16 : 0));
      flowLines(c, lines, MARGIN_X, "F2", 18, 23, INK);
      if (b.subtitle)
        flowLines(
          c,
          wrapText(b.subtitle, "F1", 10.5, CONTENT_WIDTH),
          MARGIN_X,
          "F1",
          10.5,
          14,
          MUTED,
        );
      c.y -= 6;
      return;
    }
    case "heading": {
      const size = b.level === 1 ? 13 : b.level === 2 ? 11.5 : 10.5;
      const lines = wrapText(b.text, "F2", size, CONTENT_WIDTH);
      const leading = size + 4;
      c.y -= b.level === 1 ? 10 : 6;
      // keep-with-next: the heading plus two lines of what follows must fit on this page.
      c.ensure(lines.length * leading + 2 * BODY_LEADING);
      flowLines(c, lines, MARGIN_X, "F2", size, leading, INK);
      if (b.level === 1) {
        c.page.ops.push({
          op: "line",
          x1: MARGIN_X,
          y1: c.y + 1,
          x2: MARGIN_X + CONTENT_WIDTH,
          y2: c.y + 1,
          stroke: RULE,
          width: 0.75,
        });
      }
      c.y -= 4;
      return;
    }
    case "paragraph": {
      const lines = wrapText(b.text, "F1", BODY, CONTENT_WIDTH);
      flowLines(c, lines, MARGIN_X, "F1", BODY, BODY_LEADING, b.muted ? MUTED : INK);
      c.y -= 4;
      return;
    }
    case "banner": {
      const tone = TONES[b.tone];
      const lines = wrapText(b.text, "F2", BODY, CONTENT_WIDTH - 16);
      const h = lines.length * BODY_LEADING + 12;
      c.ensure(h + 6);
      c.page.ops.push({
        op: "rect",
        x: MARGIN_X,
        y: c.y - h,
        w: CONTENT_WIDTH,
        h,
        fill: tone.fill,
        stroke: tone.stroke,
      });
      let ty = c.y - 6;
      for (const line of lines) {
        drawText(c, line, MARGIN_X + 8, ty - BODY, "F2", BODY, tone.ink);
        ty -= BODY_LEADING;
      }
      c.y -= h + 8;
      return;
    }
    case "facts": {
      const labelW = 120;
      for (const [label, value] of b.rows) {
        const vLines = wrapText(value === "" ? "-" : value, "F1", BODY, CONTENT_WIDTH - labelW);
        const lLines = wrapText(label, "F2", BODY, labelW - 6);
        const n = Math.max(vLines.length, lLines.length);
        // Draw both columns in lockstep so a page break never separates a label from its value line.
        for (let i = 0; i < n; i++) {
          c.ensure(BODY_LEADING);
          drawText(c, lLines[i] ?? "", MARGIN_X, c.y - BODY, "F2", BODY, MUTED);
          drawText(c, vLines[i] ?? "", MARGIN_X + labelW, c.y - BODY, "F1", BODY, INK);
          c.y -= BODY_LEADING;
        }
      }
      c.y -= 4;
      return;
    }
    case "bullets": {
      for (const item of b.items) {
        const lines = wrapText(item, "F1", BODY, CONTENT_WIDTH - 14);
        lines.forEach((line, i) => {
          c.ensure(BODY_LEADING);
          if (i === 0) drawText(c, "•", MARGIN_X + 3, c.y - BODY, "F1", BODY, INK);
          drawText(c, line, MARGIN_X + 14, c.y - BODY, "F1", BODY, INK);
          c.y -= BODY_LEADING;
        });
      }
      c.y -= 4;
      return;
    }
    case "table": {
      if (b.rows.length === 0) {
        flowLines(
          c,
          wrapText(b.emptyText, "F1", BODY, CONTENT_WIDTH),
          MARGIN_X,
          "F1",
          BODY,
          BODY_LEADING,
          MUTED,
        );
        c.y -= 4;
        return;
      }
      layoutTable(c, b);
      c.y -= 6;
      return;
    }
    case "entry": {
      const metaLines = wrapText(b.meta, "F2", 9.5, CONTENT_WIDTH - 16);
      const mutedLines = b.muted ? wrapText(b.muted, "F1", SMALL, CONTENT_WIDTH - 16) : [];
      const bodyLines = wrapText(b.body, b.withheld ? "F2" : "F1", BODY, CONTENT_WIDTH - 16);
      // Entries paginate line by line; a left rule marks each page's slice of the entry.
      c.ensure(metaLines.length * 12.5 + 2 * BODY_LEADING + 8);
      const all: Array<{ t: string; font: FontKey; size: number; leading: number; color: Rgb }> = [
        ...metaLines.map((t) => ({
          t,
          font: "F2" as FontKey,
          size: 9.5,
          leading: 12.5,
          color: INK,
        })),
        ...mutedLines.map((t) => ({
          t,
          font: "F1" as FontKey,
          size: SMALL,
          leading: SMALL_LEADING,
          color: MUTED,
        })),
        ...bodyLines.map((t) => ({
          t,
          font: (b.withheld ? "F2" : "F1") as FontKey,
          size: BODY,
          leading: BODY_LEADING,
          color: b.withheld ? TONES.warn.ink : INK,
        })),
      ];
      let sliceTop = c.y;
      const closeSlice = (): void => {
        if (sliceTop - c.y > 0) {
          c.page.ops.push({
            op: "line",
            x1: MARGIN_X + 2,
            y1: sliceTop,
            x2: MARGIN_X + 2,
            y2: c.y,
            stroke: RULE,
            width: 2,
          });
        }
      };
      for (const l of all) {
        if (c.room < l.leading) {
          closeSlice();
          c.newPage();
          sliceTop = c.y;
        }
        drawText(c, l.t, MARGIN_X + 10, c.y - l.size, l.font, l.size, l.color);
        c.y -= l.leading;
      }
      closeSlice();
      c.y -= 8;
      return;
    }
    case "spacer":
      c.y -= b.height;
      return;
    case "pageBreak":
      c.newPage();
      return;
  }
}

function layoutTable(c: Cursor, b: Extract<Block, { kind: "table" }>): void {
  const totalWeight = b.columns.reduce((s, col) => s + col.weight, 0);
  const widths = b.columns.map((col) => (col.weight / totalWeight) * CONTENT_WIDTH);
  const xs: number[] = [];
  let acc = MARGIN_X;
  for (const w of widths) {
    xs.push(acc);
    acc += w;
  }
  const size = 9;
  const leading = 12;
  const headerLines = b.columns.map((col, i) =>
    wrapText(col.header, "F2", size, (widths[i] as number) - 2 * CELL_PAD),
  );
  const headerH = Math.max(...headerLines.map((l) => l.length)) * leading + 2 * CELL_PAD;

  const drawHeader = (): void => {
    c.ensure(headerH + leading + 2 * CELL_PAD);
    c.page.ops.push({
      op: "rect",
      x: MARGIN_X,
      y: c.y - headerH,
      w: CONTENT_WIDTH,
      h: headerH,
      fill: HEAD_FILL,
    });
    headerLines.forEach((lines, i) => {
      lines.forEach((line, li) =>
        drawText(
          c,
          line,
          (xs[i] as number) + CELL_PAD,
          c.y - CELL_PAD - li * leading - size,
          "F2",
          size,
          INK,
        ),
      );
    });
    c.y -= headerH;
  };

  drawHeader();
  for (const row of b.rows) {
    const cells = b.columns.map((_, i) =>
      wrapText(row[i] ?? "", "F1", size, (widths[i] as number) - 2 * CELL_PAD),
    );
    const n = Math.max(...cells.map((l) => l.length), 1);
    const fullH = n * leading + 2 * CELL_PAD;
    const pageBody = PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM - headerH;
    // A row that would fit on a fresh page moves there whole; only a row taller than a page is split.
    if (c.room < fullH && fullH <= pageBody) {
      c.newPage();
      drawHeader();
    }
    let done = 0;
    while (done < n) {
      const fit = Math.floor((c.room - 2 * CELL_PAD) / leading);
      if (fit < 1) {
        c.newPage();
        drawHeader();
        continue;
      }
      const take = Math.min(fit, n - done);
      cells.forEach((lines, i) => {
        for (let li = 0; li < take; li++) {
          drawText(
            c,
            lines[done + li] ?? "",
            (xs[i] as number) + CELL_PAD,
            c.y - CELL_PAD - li * leading - size,
            "F1",
            size,
            INK,
          );
        }
      });
      c.y -= take * leading + 2 * CELL_PAD;
      done += take;
      c.page.ops.push({
        op: "line",
        x1: MARGIN_X,
        y1: c.y,
        x2: MARGIN_X + CONTENT_WIDTH,
        y2: c.y,
        stroke: RULE,
        width: 0.5,
      });
    }
  }
}

/** Lay the document out into pages of drawing ops (footers are added by the writer, which knows the total). */
export function layoutDocument(doc: DocModel): LaidOutPage[] {
  const c = new Cursor();
  for (const block of doc.blocks) layoutBlock(c, block);
  return c.pages;
}

/** Exposed for tests: every text string the layout drew, in order. */
export function pageTexts(pages: readonly LaidOutPage[]): string[][] {
  return pages.map((p) => p.ops.flatMap((o) => (o.op === "text" ? [sanitizeText(o.text)] : [])));
}

export { textWidth };
