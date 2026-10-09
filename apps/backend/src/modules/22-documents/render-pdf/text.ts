// apps/backend/src/modules/22-documents/render-pdf/text.ts — the standard-font (Helvetica, WinAnsi) text
// layer of the real PDF path: glyph sanitising + advance-width metrics. No font files are embedded — the
// PDF references the base-14 Helvetica / Helvetica-Bold by name, so the output is small and byte-stable.
//
// Non-Latin text cannot be drawn with a standard font. Rather than crash (or emit mojibake), every code
// point WinAnsi cannot represent is replaced by "?" — a visible, deterministic degradation.

/** Unicode -> WinAnsi (CP1252) byte for the code points that are NOT identical in Latin-1. */
const WIN_ANSI_EXTRAS: Readonly<Record<number, number>> = {
  8364: 0x80, // €
  8218: 0x82,
  402: 0x83,
  8222: 0x84,
  8230: 0x85, // …
  8224: 0x86,
  8225: 0x87,
  710: 0x88,
  8240: 0x89,
  352: 0x8a,
  8249: 0x8b,
  338: 0x8c,
  381: 0x8e,
  8216: 0x91, // ‘
  8217: 0x92, // ’
  8220: 0x93, // “
  8221: 0x94, // ”
  8226: 0x95, // •
  8211: 0x96, // –
  8212: 0x97, // —
  732: 0x98,
  8482: 0x99, // ™
  353: 0x9a,
  8250: 0x9b,
  339: 0x9c,
  382: 0x9e,
  376: 0x9f,
};

/** Convert a string to WinAnsi bytes (one byte per glyph). Unsupported glyphs become "?"; newlines and tabs
 * are the caller's concern (the layout engine splits on "\n" first) and any other control becomes a space. */
export function toWinAnsi(input: string): Uint8Array {
  const out: number[] = [];
  for (const ch of input.normalize("NFC")) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x20 || cp === 0x7f) out.push(0x20);
    else if (cp < 0x7f) out.push(cp);
    else if (cp >= 0xa0 && cp <= 0xff) out.push(cp);
    else if (WIN_ANSI_EXTRAS[cp] !== undefined) out.push(WIN_ANSI_EXTRAS[cp] as number);
    else out.push(0x3f); // "?"
  }
  return Uint8Array.from(out);
}

/** The string as it will actually be drawn: still Unicode, but every code point WinAnsi cannot represent is
 * already "?" and controls are spaces — so `toWinAnsi(sanitizeText(x))` is the identity on the result. */
export function sanitizeText(input: string): string {
  let out = "";
  for (const ch of input.normalize("NFC")) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x0a)
      out += ch; // line breaks are the layout engine's
    else if (cp < 0x20 || cp === 0x7f || cp === 0x00a0) out += " ";
    else if (cp < 0x7f || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRAS[cp] !== undefined)
      out += ch;
    else out += "?";
  }
  return out;
}

/** How many code points of `input` WinAnsi cannot represent (each is drawn as "?"). A literal "?" is not counted.
 * This is the disclosure counter for R1 (no embedded Unicode font): a legal notice must say when it lied. */
export function countDegradedGlyphs(input: string): number {
  let n = 0;
  for (const ch of input.normalize("NFC")) {
    const cp = ch.codePointAt(0) as number;
    const drawable =
      cp < 0x20 ||
      cp === 0x7f ||
      cp < 0x7f ||
      (cp >= 0xa0 && cp <= 0xff) ||
      WIN_ANSI_EXTRAS[cp] !== undefined;
    if (!drawable) n += 1;
  }
  return n;
}

// Helvetica advance widths (AFM), code points 32..126, 1/1000 em.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
] as const;
// Helvetica-Bold, same range.
const HELV_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667,
  611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556,
  278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
] as const;

export type FontKey = "F1" | "F2";

/** WinAnsi punctuation widths above 0x7f that are not "base letter" glyphs. */
const HIGH_WIDTHS: Readonly<Record<number, number>> = {
  133: 1000,
  145: 222,
  146: 222,
  147: 333,
  148: 333,
  149: 350,
  150: 556,
  151: 1000,
  153: 1000,
  128: 556,
};

function byteWidth(b: number, bold: boolean): number {
  const table = bold ? HELV_BOLD : HELV;
  if (b >= 32 && b <= 126) return table[b - 32] as number;
  const high = HIGH_WIDTHS[b];
  if (high !== undefined) return high;
  // Accented Latin-1 letter: use its base letter's advance (NFD strips the accent).
  const base = String.fromCharCode(b).normalize("NFD").charCodeAt(0);
  if (base >= 32 && base <= 126 && base !== b) return table[base - 32] as number;
  return 556;
}

/** Width of `text` in PDF points at `size` for the given font (text is sanitised first). */
export function textWidth(text: string, font: FontKey, size: number): number {
  const bold = font === "F2";
  let total = 0;
  for (const b of toWinAnsi(text)) total += byteWidth(b, bold);
  return (total * size) / 1000;
}

/** Wrap `text` into lines no wider than `maxWidth`. Honors explicit "\n", breaks on spaces, and hard-breaks
 * a single token wider than the line so long unbroken strings (UUIDs, URLs) can never overflow. */
export function wrapText(text: string, font: FontKey, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of sanitizeText(text.replace(/\r\n?/g, "\n")).split("\n")) {
    const words = paragraph.split(/ +/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let line = "";
    const flush = (): void => {
      lines.push(line);
      line = "";
    };
    for (const word of words) {
      const candidate = line === "" ? word : `${line} ${word}`;
      if (textWidth(candidate, font, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line !== "") flush();
      if (textWidth(word, font, size) <= maxWidth) {
        line = word;
        continue;
      }
      // Hard-break an over-wide token character by character.
      let chunk = "";
      for (const ch of word) {
        if (chunk !== "" && textWidth(chunk + ch, font, size) > maxWidth) {
          lines.push(chunk);
          chunk = "";
        }
        chunk += ch;
      }
      line = chunk;
    }
    flush();
  }
  return lines;
}
