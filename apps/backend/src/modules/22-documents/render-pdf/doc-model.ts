// apps/backend/src/modules/22-documents/render-pdf/doc-model.ts — the template-independent document model
// the per-template builders produce (pure functions of the render payload) and the layout engine consumes.
// Keeping the model separate from the bytes is what makes the templates unit-testable without a PDF parser.

export type Tone = "info" | "warn" | "danger";

export interface TableColumn {
  readonly header: string;
  /** Relative width; columns are scaled to fill the text width. */
  readonly weight: number;
}

export type Block =
  | { readonly kind: "title"; readonly text: string; readonly subtitle?: string }
  | { readonly kind: "heading"; readonly text: string; readonly level: 1 | 2 | 3 }
  | {
      readonly kind: "paragraph";
      readonly text: string;
      readonly muted?: boolean;
      /** The last lines of this paragraph travel with the NEXT block (a narrative stays with its signature). */
      readonly keepWithNext?: boolean;
    }
  | { readonly kind: "banner"; readonly text: string; readonly tone: Tone }
  | {
      readonly kind: "facts";
      readonly rows: ReadonlyArray<readonly [label: string, value: string]>;
    }
  | { readonly kind: "bullets"; readonly items: readonly string[] }
  | {
      readonly kind: "table";
      readonly columns: readonly TableColumn[];
      readonly rows: ReadonlyArray<readonly string[]>;
      /** Shown instead of the table when there are no rows. */
      readonly emptyText: string;
    }
  | {
      /** A bordered entry (a note / addendum): a bold meta line, an optional muted line, then body text. */
      readonly kind: "entry";
      readonly meta: string;
      readonly muted?: string;
      readonly body: string;
      readonly withheld?: boolean;
    }
  | { readonly kind: "spacer"; readonly height: number }
  | { readonly kind: "pageBreak" }
  | {
      /** CMS-style boxed label/value cells, two per row. A row never splits across a page. */
      readonly kind: "fieldGrid";
      readonly cells: ReadonlyArray<readonly [label: string, value: string]>;
    }
  | {
      /** Verbatim regulatory language. NEVER truncated; a widow/orphan guard keeps two lines on each side of a
       *  page break. `id` is the forms-registry required-field id this text satisfies. */
      readonly kind: "legalText";
      readonly id: string;
      readonly cite?: string;
      readonly text: string;
    }
  | {
      /** A boxed attestation sentence with a drawn check box; kept together with what follows it. */
      readonly kind: "attestation";
      readonly text: string;
      readonly checked: boolean;
    }
  | ({ readonly kind: "signature" } & SignatureBlock)
  | {
      /** A choice group (ABN options 1/2/3, code-status choices). Check boxes are drawn, never glyphs. */
      readonly kind: "options";
      readonly title: string;
      readonly items: ReadonlyArray<{ readonly label: string; readonly selected: boolean }>;
    }
  | {
      /** Blocks that must land on one page (a signature must never be stranded alone). */
      readonly kind: "keepTogether";
      readonly blocks: readonly Block[];
    };

export type SignatureMethodLabel = "electronic" | "wet_ink_scanned" | "verbal_cosign";

/**
 * A 21 CFR 11.50 signature manifestation: printed name, date/time and the meaning of the signature. With
 * `ruledLine` set it is a blank signature line for the signer to complete on paper (the ABN); when `method`
 * is `wet_ink_scanned` the ruled line AND the record-of-scan line are both drawn.
 */
export interface SignatureBlock {
  readonly role: string;
  readonly printedName?: string;
  readonly credentials?: string;
  /** Capacity when the signer acts for another ("Authorized representative"). */
  readonly capacity?: string;
  readonly npi?: string;
  readonly signedAt?: string;
  readonly method?: SignatureMethodLabel;
  readonly meaning?: string;
  readonly ref?: string;
  readonly ruledLine?: boolean;
}

export interface DocWatermark {
  readonly text: string;
  readonly tone: Tone;
}

export interface DocModel {
  /** PDF /Title (also the running footer label). */
  readonly title: string;
  /** ISO instant used for /CreationDate and /ModDate — derived from the payload, never the wall clock. */
  readonly createdAtIso: string;
  readonly blocks: readonly Block[];
  /** Pages 2..N carry this line (patient name / MRN / title) so a loose page is still identified. */
  readonly runningHeader?: string;
  /** A diagonal page watermark drawn under the content of every page (`VOID`, `CRITICAL RESULT`, ...). It is a
   *  render-time property of the stored bytes; an auditor download overlay is applied on top at download time. */
  readonly watermark?: DocWatermark;
  /** When set, a footer note discloses that characters WinAnsi cannot draw were replaced by "?" (R1). */
  readonly discloseDegradedGlyphs?: boolean;
}

/** Fallback creation date when a payload carries no timestamp at all (a fixed, obviously-synthetic epoch). */
export const FALLBACK_CREATED_AT = "2000-01-01T00:00:00.000Z";

/** The latest valid ISO instant among the candidates (payload-derived creation date), else the fallback. */
export function latestInstant(candidates: ReadonlyArray<unknown>): string {
  let best = Number.NEGATIVE_INFINITY;
  for (const c of candidates) {
    if (typeof c !== "string") continue;
    const t = Date.parse(c);
    if (Number.isFinite(t) && t > best) best = t;
  }
  return Number.isFinite(best) ? new Date(best).toISOString() : FALLBACK_CREATED_AT;
}
