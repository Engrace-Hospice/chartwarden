// apps/backend/src/modules/22-documents/records-request/cover-sheet.ts — the cover sheet + request letter for
// an outbound records request (F-238), as a real PDF: the SAME bytes staff open / print from the referral page
// and the outbound fax transport sends (./records-request-fax.ts), so what was faxed is what was previewed.
//
// Rendered with M22's own dependency-free PDF writer (../render-pdf/pdf-writer.ts — base-14 Helvetica, no
// PDF library is installed in this monorepo and none is added). Deterministic: no wall clock (the creation
// date is the request's `requestedAt`), so the same request renders the same bytes and the send row's
// `document_sha256` proves exactly what went out.
//
// Two parts:
//   page 1 — the FAX COVER SHEET: who it is for, who it is from, the page count, and the CODE printed large
//            (Helvetica-Bold 44pt, widened tracking) inside a heavy box, with the return instructions. The
//            code's alphabet has none of the characters a fax/OCR round trip swaps, and the inbound matcher
//            (@wardenx/intake-extraction `findRecordsRequestCodes`) folds the remaining confusions back, so a
//            returned fax with this page on top is filed under the prospect without anyone retyping it. The
//            code also sits in the instructions and in every page's running footer.
//   page 2+ — the REQUEST LETTER: the prospect's name + date of birth, what is requested, the dates of
//            service and the respond-by date.
// No barcode / QR: no barcode library is a dependency, and the inbound matcher reads OCR text, not symbols.
//
// Minimum necessary (HIPAA §164.502(b)) — the same facts the earlier HTML sheet carried, no more: the
// prospect's name and date of birth (enough for the sender to find the chart) appear ONLY on the letter, not
// on the cover page a fax machine leaves face-up; never a diagnosis, the referral's details, or our ids.
import { createHash } from "node:crypto";
import type { Block, DocModel } from "../render-pdf/doc-model";
import {
  CONTENT_WIDTH,
  type LaidOutPage,
  MARGIN_X,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  type PageOp,
  type Rgb,
  layoutDocument,
} from "../render-pdf/layout";
import { writePdf } from "../render-pdf/pdf-writer";
import { type FontKey, textWidth, wrapText } from "../render-pdf/text";
import type { RecordsRequestKind, RecordsRequestView } from "./records-request-service";

export const RECORDS_REQUEST_KIND_LABEL: Readonly<Record<RecordsRequestKind, string>> = {
  history_and_physical: "History & physical (H&P)",
  discharge_summary: "Discharge summary",
  progress_notes: "Progress notes",
  consult_notes: "Consultation notes",
  labs: "Laboratory results",
  imaging: "Imaging reports",
  medication_list: "Current medication list",
  problem_list: "Problem / diagnosis list",
};

/** yyyy-mm-dd (or an ISO instant) → mm/dd/yyyy (US clinical convention); anything else as given. */
const usDate = (iso: string | null): string => {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
};

export interface CoverSheetSubject {
  /** "LAST, First" — the prospect as the chart (or, before resolution, the referral) names them. */
  readonly displayName: string;
  readonly dateOfBirth: string | null;
}

export interface CoverSheetOptions {
  /** The requesting organization's display name (the "From" line). Omitted when unknown. */
  readonly fromOrganization?: string | null;
  /** The number this copy is faxed to, when it differs from the request's own `recipientFax`. */
  readonly faxTo?: string | null;
}

export interface RenderedCoverSheet {
  readonly bytes: Uint8Array;
  readonly pageCount: number;
  readonly filename: string;
  /** Hex SHA-256 of `bytes` — recorded on a fax send as proof of what went out. */
  readonly sha256: string;
}

const INK: Rgb = [0, 0, 0];
const MUTED: Rgb = [0.3, 0.3, 0.3];
/** Point size and tracking of the printed code — large enough to survive a 100-dpi "standard" fax. */
export const COVER_SHEET_CODE_SIZE = 44;
const CODE_TRACKING = 5;

/** The request letter (page 2+) as document blocks, laid out by the shared engine. */
function letterBlocks(request: RecordsRequestView, subject: CoverSheetSubject): Block[] {
  const kinds = request.recordsRequested.map((k) => RECORDS_REQUEST_KIND_LABEL[k]);
  if (request.recordsRequestedNote) kinds.push(request.recordsRequestedNote);
  const range =
    request.dateRangeStart || request.dateRangeEnd
      ? `${request.dateRangeStart ? usDate(request.dateRangeStart) : "earliest available"} to ${
          request.dateRangeEnd ? usDate(request.dateRangeEnd) : "present"
        }`
      : "All available";
  const patient: Array<readonly [string, string]> = [["Name", subject.displayName]];
  if (subject.dateOfBirth) patient.push(["Date of birth", usDate(subject.dateOfBirth)]);
  const blocks: Block[] = [
    {
      kind: "title",
      text: "Request for medical records",
      subtitle: `Request code ${request.requestCode} - requested ${usDate(request.requestedAt)}`,
    },
    { kind: "heading", level: 1, text: "Patient" },
    { kind: "facts", rows: patient },
    { kind: "heading", level: 1, text: "Records requested" },
    { kind: "bullets", items: kinds },
    { kind: "facts", rows: [["Dates of service", range]] },
  ];
  if (request.dueDate) {
    blocks.push({
      kind: "banner",
      tone: "info",
      text: `Please respond by ${usDate(request.dueDate)}.`,
    });
  }
  blocks.push(
    { kind: "heading", level: 1, text: "Returning the records" },
    {
      kind: "paragraph",
      text: `Fax the records with the cover sheet (page 1) on top, or write the request code ${request.requestCode} on your own cover sheet. If you send them by email, put ${request.requestCode} in the subject line. The code lets us file the records under this patient without delay.`,
    },
    {
      kind: "paragraph",
      muted: true,
      text: "CONFIDENTIAL: this request concerns protected health information, requested for treatment (45 CFR 164.506). If you received it in error, please notify the sender and destroy it. Do not include records of substance use disorder treatment subject to 42 CFR Part 2 without the patient's written consent.",
    },
  );
  return blocks;
}

/** Page 1 — the fax cover sheet, laid out by hand (the code box is not a document-model block). */
function coverPage(
  request: RecordsRequestView,
  pageCount: number,
  opts: CoverSheetOptions,
): LaidOutPage {
  const ops: PageOp[] = [];
  let y = PAGE_HEIGHT - 60;
  const text = (s: string, x: number, size: number, font: FontKey, color: Rgb = INK) =>
    ops.push({ op: "text", x, y, font, size, text: s, color });
  const centered = (s: string, size: number, font: FontKey, tracking = 0) => {
    const w = textWidth(s, font, size) + tracking * Math.max(s.length - 1, 0);
    ops.push({
      op: "text",
      x: (PAGE_WIDTH - w) / 2,
      y,
      font,
      size,
      text: s,
      color: INK,
      ...(tracking ? { charSpacing: tracking } : {}),
    });
  };

  y -= 30;
  text("FAX", MARGIN_X, 30, "F2");
  y -= 22;
  text("Request for medical records", MARGIN_X, 16, "F2");
  y -= 12;
  ops.push({
    op: "line",
    x1: MARGIN_X,
    y1: y,
    x2: MARGIN_X + CONTENT_WIDTH,
    y2: y,
    stroke: INK,
    width: 1.5,
  });
  y -= 8;

  const labelW = 130;
  const rows: Array<readonly [string, string | null | undefined]> = [
    ["To", request.recipientName],
    ["Organization", request.recipientOrganization],
    ["Fax", opts.faxTo ?? request.recipientFax],
    ["From", opts.fromOrganization],
    ["Date", usDate(request.requestedAt)],
    ["Pages", `${pageCount} (including this cover sheet)`],
    ["Please respond by", request.dueDate ? usDate(request.dueDate) : null],
  ];
  for (const [label, value] of rows) {
    if (!value) continue;
    const lines = wrapText(value, "F1", 12, CONTENT_WIDTH - labelW).slice(0, 2);
    y -= 17;
    text(label, MARGIN_X, 11, "F2", MUTED);
    lines.forEach((line, i) => {
      if (i > 0) y -= 15;
      text(line, MARGIN_X + labelW, 12, "F1");
    });
  }

  // The code box: a heavy frame (four 3pt rules) around the label, the code and the instruction.
  y -= 30;
  const boxTop = y;
  const boxH = 150;
  const boxBottom = boxTop - boxH;
  const frame = (x1: number, y1: number, x2: number, y2: number) =>
    ops.push({ op: "line", x1, y1, x2, y2, stroke: INK, width: 3 });
  const left = MARGIN_X;
  const right = MARGIN_X + CONTENT_WIDTH;
  frame(left, boxTop, right, boxTop);
  frame(left, boxBottom, right, boxBottom);
  frame(left, boxTop, left, boxBottom);
  frame(right, boxTop, right, boxBottom);
  y = boxTop - 26;
  centered("REQUEST CODE", 12, "F2", 2);
  y -= 58;
  centered(request.requestCode, COVER_SHEET_CODE_SIZE, "F2", CODE_TRACKING);
  y -= 30;
  centered("Put this page on top when you fax the records back,", 12, "F2");
  y -= 16;
  centered(`or put ${request.requestCode} in your email subject.`, 12, "F2");
  y = boxBottom;

  y -= 30;
  text("Returning the records", MARGIN_X, 13, "F2");
  for (const line of wrapText(
    `The records we are asking for are listed on the next page. Please fax them back with this cover sheet on top so they are filed under the right patient without delay. If you use your own cover sheet, write the request code ${request.requestCode} on it.`,
    "F1",
    11,
    CONTENT_WIDTH,
  )) {
    y -= 15;
    text(line, MARGIN_X, 11, "F1");
  }

  y -= 26;
  for (const line of wrapText(
    "CONFIDENTIALITY NOTICE: the pages that follow concern protected health information and are intended only for the recipient named above. If you received this fax in error, please notify the sender and destroy all pages.",
    "F1",
    9,
    CONTENT_WIDTH,
  )) {
    y -= 12;
    text(line, MARGIN_X, 9, "F1", MUTED);
  }
  return { ops };
}

/**
 * The cover sheet + request letter as PDF bytes. Pure and deterministic: identical inputs, identical bytes.
 */
export function renderRecordsRequestCoverSheetPdf(
  request: RecordsRequestView,
  subject: CoverSheetSubject,
  opts: CoverSheetOptions = {},
): RenderedCoverSheet {
  const doc: DocModel = {
    title: `Records request ${request.requestCode}`,
    createdAtIso: request.requestedAt,
    blocks: letterBlocks(request, subject),
  };
  const letter = layoutDocument(doc);
  const pageCount = letter.length + 1;
  const bytes = writePdf(doc, [coverPage(request, pageCount, opts), ...letter]);
  return {
    bytes,
    pageCount,
    filename: `records-request-${request.requestCode}.pdf`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
