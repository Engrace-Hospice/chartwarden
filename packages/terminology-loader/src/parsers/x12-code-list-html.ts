// @wardenx/terminology-loader — X12 external code list page reader (CARC, RARC).
//
// The X12 / Washington Publishing Company code lists are published as HTML pages (no CSV/JSON download exists):
//   https://x12.org/codes/claim-adjustment-reason-codes     (CARC)
//   https://x12.org/codes/remittance-advice-remark-codes    (RARC)
// Each page carries one `<table id="codelist">` whose rows look like
//   <tr class="prod-set current|deactivated|tobe"><td class="code">M4</td><td class="description">…text…
//     <span class="dates"><br>Start: 01/01/1997 | Last Modified: 04/01/2007 | Stop: 08/01/2004<br>…Notes: …</span></td></tr>
// The page is saved as-is by `scripts/terminology/import-x12-codes.ts` (or by the operator's browser) and uploaded to
// the admin load route like any other source; this reader is deterministic over those bytes.
//
// Status: `current` → active; `tobe` (to be deactivated) → active with its Stop date as `endDate`;
// `deactivated` → retired with `endDate` = Stop. A Start date becomes `effectiveDate`. Last Modified, Notes and the
// RARC "Alert:" marker are kept in `properties`. Strict like every parser: a row it cannot read FAILS the load.
//
// COPYRIGHT: X12 asserts copyright over these lists (https://x12.org — "Any use of any X12 work product must be
// compliant with US Copyright laws and X12 Intellectual Property policies"). Reading them is not redistributing
// them: no list content ships in this repository. See docs/runbooks/terminology-catalog-loading.md.
import { decodeUtf8, requireEntry } from "../bytes";
import { LoaderDataError } from "../errors";
import type { ConceptStatus, LoadableSystemId, ParsedSource, SourceBundle } from "../types";
import { NORMALIZED_CODE_SHAPE } from "./normalized-csv";
import { assertCodeShape, assertDisplay, concept, finish, parseDate } from "./shared";

const ROW =
  /<tr class="([^"]*)">\s*<td class="code">(.*?)<\/td>\s*<td class="description">(.*?)<\/td>\s*<\/tr>/gs;
const DATES_SPAN = /<span class="dates">(.*)<\/span>\s*$/s;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode the HTML entities these pages use (named + numeric); an unknown named entity is left as written. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X"))
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Strip tags and collapse whitespace. */
function plainText(html: string): string {
  return decodeEntities(html.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

interface DatesBlock {
  readonly start: string | null;
  readonly lastModified: string | null;
  readonly stop: string | null;
  readonly notes: string | null;
}

function readDates(spanHtml: string, where: string): DatesBlock {
  const text = plainText(spanHtml);
  const grab = (label: string): string | null =>
    new RegExp(`${label}:\\s*(\\d{1,2}/\\d{1,2}/\\d{4})`).exec(text)?.[1] ?? null;
  const notes = /Notes:\s*(.*)$/s.exec(text)?.[1]?.trim() || null;
  return {
    start: parseDate(grab("Start") ?? undefined, `${where} Start`),
    lastModified: parseDate(grab("Last Modified") ?? undefined, `${where} Last Modified`),
    stop: parseDate(grab("Stop") ?? undefined, `${where} Stop`),
    notes,
  };
}

function statusOf(rowClass: string, where: string): ConceptStatus {
  const tokens = rowClass.split(/\s+/);
  if (tokens.includes("deactivated")) return "retired";
  if (tokens.includes("current") || tokens.includes("tobe")) return "active";
  throw new LoaderDataError("STATUS_INVALID", `${where}: unrecognised row class`);
}

/** True when the bytes are an HTML page rather than a normalized CSV (first non-blank character is `<`). */
export function looksLikeHtml(bytes: Uint8Array): boolean {
  const head = decodeUtf8(bytes.subarray(0, 512)).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/** True when the bundle is a saved X12 page: an `.html` member, or a single raw upload that starts like HTML. */
export function isX12Html(bundle: SourceBundle): boolean {
  if (bundle.names.some((n) => /\.html?$/i.test(n))) return true;
  return (
    bundle.names.length === 1 &&
    bundle.names[0] === "upload" &&
    looksLikeHtml(bundle.read("upload"))
  );
}

/** Parse a saved X12 code list page for `system` (`carc` or `rarc`). */
export function parseX12CodeListHtml(system: LoadableSystemId, bundle: SourceBundle): ParsedSource {
  const shape = NORMALIZED_CODE_SHAPE[system];
  if (!shape) throw new LoaderDataError("FORMAT_UNSUPPORTED", `${system} has no X12 code grammar`);
  const name = requireEntry(bundle, /\.html?$/i, "a saved X12 code list .html page");
  const html = decodeUtf8(bundle.read(name));
  const concepts = [];
  let n = 0;
  for (const m of html.matchAll(ROW)) {
    n++;
    const where = `row ${n}`;
    const code = plainText(m[2] as string).toUpperCase();
    assertCodeShape(system, code, shape, where);
    const status = statusOf(m[1] as string, where);
    const rawDescription = m[3] as string;
    const datesMatch = DATES_SPAN.exec(rawDescription);
    const dates = datesMatch ? readDates(datesMatch[1] as string, where) : readDates("", where);
    const display = plainText(
      datesMatch ? rawDescription.slice(0, datesMatch.index) : rawDescription,
    );
    assertDisplay(system, display, where);
    concepts.push(
      concept(code, display, status, {
        effectiveDate: dates.start,
        endDate: dates.stop,
        properties: {
          ...(dates.lastModified ? { lastModified: dates.lastModified } : {}),
          ...(dates.notes ? { notes: dates.notes } : {}),
          ...(system === "rarc" && display.startsWith("Alert:") ? { alert: true } : {}),
        },
      }),
    );
  }
  if (concepts.length === 0) {
    throw new LoaderDataError(
      "SOURCE_EMPTY",
      `${system}: no code rows found; save the X12 code list page (View Source / Save As) and upload that`,
    );
  }
  return finish(system, concepts);
}
