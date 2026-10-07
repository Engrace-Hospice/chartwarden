// @wardenx/terminology-loader — HCPCS Level II parser (CMS quarterly release; tier 1 public).
//
// Two accepted inputs:
//   1. the CMS fixed-width "alpha-numeric" record file (`HCPC<YYYY>_*_ANWEB.txt`, usually inside a zip), read
//      with the column layout below; or
//   2. a normalized CSV (./normalized-csv) — the format an operator uses for a curated subset.
//
// ⚠ LAYOUT PROVENANCE. The fixed-width offsets below are the CMS record layout as documented to the author
// (HCPC 1-5 · SEQNUM 6-10 · RECID 11 · LONG DESC 12-91 · SHORT DESC 92-119 · ADD DT 261-268 · ACT EFF DT
// 269-276 · TERM DT 277-284 · ACTION CD 285). No real CMS file is available in this repository and there is no
// egress in CI, so they are pinned by a hand-made fixture only. The reader is strict (RECID, code grammar and
// every date are validated) so a layout mismatch against the first real file fails the load loudly; confirm
// the offsets against the live file before relying on this path in production.
//
// CPT guard (D4): Level II codes begin with a letter, so a CPT-shaped code anywhere in the file is a hard error.
import { iterLines, requireEntry } from "../bytes";
import { LoaderDataError } from "../errors";
import type { ParsedConcept, ParsedSource, SourceBundle } from "../types";
import { isNormalizedCsv, parseNormalizedCsv } from "./normalized-csv";
import {
  assertCodeShape,
  assertDisplay,
  concept,
  finish,
  parseDate,
  rejectCptShaped,
} from "./shared";

const RECORD_LENGTH = 285;
const CODE_RECORD = new Set(["3", "7"]);
const CONTINUATION = new Set(["4", "8"]);
const HCPCS_CODE = /^(?:[A-Z]\d{4}|[A-Z0-9]{2})$/;

const slice = (line: string, from: number, to: number): string => line.slice(from - 1, to).trim();

interface Working {
  code: string;
  long: string;
  short: string;
  recId: string;
  add: string | null;
  eff: string | null;
  term: string | null;
}

function toConcept(w: Working): ParsedConcept {
  return concept(w.code, w.long || w.short, w.term ? "deprecated" : "active", {
    effectiveDate: w.eff ?? w.add,
    endDate: w.term,
    properties: { shortDescription: w.short, recordKind: w.recId === "7" ? "modifier" : "code" },
  });
}

/** Parse the CMS fixed-width HCPCS file text. */
export function parseHcpcsFixedWidth(lines: Iterable<string>): ParsedSource {
  const working: Working[] = [];
  let n = 0;
  for (const raw of lines) {
    n++;
    if (raw.trim() === "") continue;
    const line = raw.padEnd(RECORD_LENGTH, " ");
    const code = slice(line, 1, 5);
    const recId = slice(line, 11, 11);
    if (CONTINUATION.has(recId)) {
      const prev = working[working.length - 1];
      if (!prev || prev.code !== code) {
        throw new LoaderDataError(
          "RECORD_INVALID",
          `hcpcs line ${n}: continuation without a parent record`,
        );
      }
      prev.long = `${prev.long} ${slice(line, 12, 91)}`.trim();
      continue;
    }
    if (!CODE_RECORD.has(recId)) {
      throw new LoaderDataError("RECORD_INVALID", `hcpcs line ${n}: unknown record id`);
    }
    assertCodeShape("hcpcs", code, HCPCS_CODE, `line ${n}`);
    rejectCptShaped(code, "hcpcs");
    working.push({
      code,
      recId,
      long: slice(line, 12, 91),
      short: slice(line, 92, 119),
      add: parseDate(slice(line, 261, 268), `line ${n} ADD DT`),
      eff: parseDate(slice(line, 269, 276), `line ${n} ACT EFF DT`),
      term: parseDate(slice(line, 277, 284), `line ${n} TERM DT`),
    });
  }
  const rows = working.map(toConcept);
  for (const r of rows) assertDisplay("hcpcs", r.display, `code ${r.code}`);
  return finish("hcpcs", rows);
}

/** Parse an HCPCS bundle: a `.csv` entry is the normalized format, otherwise the CMS fixed-width file. */
export function parseHcpcs(bundle: SourceBundle): ParsedSource {
  if (isNormalizedCsv(bundle)) return parseNormalizedCsv("hcpcs", bundle);
  const name = requireEntry(bundle, /(?:hcpc|anweb).*\.txt$/i, "the HCPCS alpha-numeric .txt file");
  return parseHcpcsFixedWidth(iterLines(bundle.read(name)));
}
