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
  | { readonly kind: "paragraph"; readonly text: string; readonly muted?: boolean }
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
  | { readonly kind: "pageBreak" };

export interface DocModel {
  /** PDF /Title (also the running footer label). */
  readonly title: string;
  /** ISO instant used for /CreationDate and /ModDate — derived from the payload, never the wall clock. */
  readonly createdAtIso: string;
  readonly blocks: readonly Block[];
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
