// @wardenx/cost-report — M27 Print Image (PI) renderer (D11, §1.1). The PI file is the human-readable
// rendition of the cost report the agency's Compliance Officer reviews BEFORE the machine ECR file is
// uploaded to MCReF — same underlying snapshot values, presented as labeled, aligned text tables instead
// of fixed-field records. It is review evidence, not a machine artifact, so its contract is legibility +
// determinism (the same snapshot always renders identically) rather than byte-conformance. Plain-text is
// the canonical form; an HTML variant wraps the same text in an escaped `<pre>` block for in-browser
// review.
//
// PURE DOMAIN: reuses the writer's deterministic leaf walk + the records kernel's money formatting; no
// Fastify, no Drizzle/DB, no BullMQ, no `@wardenx/db`, no `getSeam`. No PHI — aggregate financial /
// statistical values only (D18).
import { WORKSHEET_CODES, type WorksheetCode } from "../contracts";
import { centsToEcrDollars } from "./records";
import {
  type EcrHeaderContext,
  type SnapshotWorksheets,
  type WorksheetLeaf,
  flattenWorksheetLeaves,
  leafToEcrValue,
} from "./writer";

/** Output format for the Print Image. `text` is canonical; `html` wraps the text in an escaped `<pre>`. */
export type PiFormat = "text" | "html";

export interface RenderPiOptions {
  format?: PiFormat;
}

const LABEL_WIDTH = 56;

/** Human-readable label for a worksheet leaf: its dotted path. */
function leafLabel(leaf: WorksheetLeaf): string {
  return leaf.path.length > 0 ? leaf.path.join(".") : "(value)";
}

/** Human-readable, review-facing rendering of a leaf value. */
function leafDisplay(leaf: WorksheetLeaf): string {
  const value = leafToEcrValue(leaf);
  switch (value.kind) {
    case "alpha":
      return value.text === "" ? "—" : value.text;
    case "money": {
      const dollars = centsToEcrDollars(value.cents);
      return value.cents < 0 ? `-$${dollars.slice(1)}` : `$${dollars}`;
    }
    case "count":
      return String(value.count);
  }
}

function renderWorksheetSection(code: WorksheetCode, data: unknown): string[] {
  const leaves = data === undefined || data === null ? [] : flattenWorksheetLeaves(data);
  const lines: string[] = [`Worksheet ${code}`, "-".repeat(72)];
  if (leaves.length === 0) {
    lines.push("  (not populated)");
  } else {
    for (const leaf of leaves) {
      const label = leafLabel(leaf);
      const padded = label.length >= LABEL_WIDTH ? label : label + " ".repeat(LABEL_WIDTH - label.length);
      lines.push(`  ${padded}${leafDisplay(leaf)}`);
    }
  }
  lines.push("");
  return lines;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render the human-readable Print Image text for the 21 worksheets' snapshot data. Worksheets are
 * emitted in canonical `WORKSHEET_CODES` order with a labeled line per leaf value; a worksheet absent
 * from the snapshot renders as "(not populated)". The optional header context prints an identity banner.
 * TODO(CMS-fixture): the official PI page layout (page breaks, the CMS worksheet titles, the line/column
 * grid headings) follows the CMS-1984-14 Print-Image specification; this is a faithful labeled-table
 * rendition pending that fixture.
 */
export function renderPi(
  snapshotWorksheets: SnapshotWorksheets,
  header?: EcrHeaderContext,
  options?: RenderPiOptions,
): string {
  const lines: string[] = [
    "CMS-1984-14 HOSPICE COST REPORT — PRINT IMAGE (PRE-SUBMISSION REVIEW)",
    "=".repeat(72),
    `Provider CCN       : ${header?.providerCcn ?? "—"}`,
    `Fiscal Year        : ${header?.fiscalYearStartDate ?? "—"} through ${header?.fiscalYearEndDate ?? "—"}`,
    `ECR Spec Version   : ${header?.ecrSpecVersion ?? "CMS-1984-14"}`,
    "",
  ];

  for (const code of WORKSHEET_CODES) {
    lines.push(...renderWorksheetSection(code, snapshotWorksheets[code]));
  }

  const text = lines.join("\n");
  if (options?.format === "html") {
    return `<pre class="wardenx-cost-report-pi">\n${escapeHtml(text)}\n</pre>\n`;
  }
  return text;
}
