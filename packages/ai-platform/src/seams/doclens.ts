// @wardenx/ai-platform — §4.2.2 the four DocLens seams (M32-T06).
//
// Consumed by M22, which per M22 D7 holds ZERO AI capability code and routes every model invocation
// through M32. All four capabilities sit at `DESIGN_REVIEW` in §2.4's Phase-1 inventory, so even with
// `ai.full` on they would refuse at the lifecycle gate — which is the same posture M22 already ships
// (`documents.doclens` OFF → 503 EXTRACTION_DISABLED).
//
// FOUR SEAMS, NOT ONE. M22-T08 forward-referenced a single `"DocLensCapability"` key with a structural
// four-arm port (`packages/intake-extraction`), explicitly noting "that registration is M32's to own
// when the AI Platform lands". M32 owns it and publishes §4.2.2's FOUR names, because the four are
// separately governed: `doclens_classify` is medium-risk on a local classifier, `doclens_sud_detect` is
// a 42 CFR Part 2 detector with no entry in the architecture capability catalog at all, and a kill
// switch has to be able to stop one without stopping the others. Collapsing them into one seam would
// make the finest kill available to an operator "turn off document AI entirely".
//
// M22's flip from its deny-stub onto these four is M22's edit, not M32's — M22 must not gain a
// `dependsOn` edge here, and the adapter that composes four seams into its one structural port belongs
// on the consumer side of the boundary.
import type { AIWarning, AiSeamRefusal } from "./common";

/** §4.2.2 — classify an uploaded document into a `document_type` taxonomy entry. */
export interface DocLensClassifier {
  classify(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    /** FK to the M22 `document` row. */
    readonly documentId: string;
    /** OCR'd text from M22's stage 2. */
    readonly extractedText: string;
    readonly pageCount: number;
    /** F-236 — set when `extractedText` is ONE page (per-page classification, fax-bundle splitting). */
    readonly pageNumber?: number;
  }): Promise<DocLensClassifyResult>;
}

/** §4.2.2 — extract structured fields from a classified document (face sheet → demographics, …). */
export interface DocLensExtractor {
  extract(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly documentId: string;
    /** Taxonomy key produced by `classify`. */
    readonly documentType: string;
    readonly extractedText: string;
    /** Which extraction schema to apply. */
    readonly schemaKey: string;
    /**
     * F-236 (ADR-0048) — the fields to extract, owned by M22's schema registry. When present the model is
     * asked for exactly these paths (`[]` marks a repeatable group: `medications[].name`).
     */
    readonly fieldSpecs?: readonly { readonly fieldPath: string; readonly description: string }[];
    /** F-236 — the document page by page; when present it is sent with page markers instead of
     *  `extractedText`, so every quote the model returns can name its page. */
    readonly pages?: readonly { readonly page: number; readonly text: string }[];
  }): Promise<DocLensExtractResult>;
}

/** §4.2.2 — vision-based verification of signature presence, page integrity, redaction quality. */
export interface DocLensVisionVerifier {
  verify(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly documentId: string;
    readonly pageImages: readonly {
      readonly pageNumber: number;
      readonly objectStorageKey: string;
    }[];
    readonly verificationKey: "signature_presence" | "redaction_quality" | "page_integrity";
  }): Promise<DocLensVerifyResult>;
}

/** §4.2.2 — detect 42 CFR Part 2 SUD indicators in document text and flag for special handling. */
export interface DocLensSudDetector {
  detect(input: {
    readonly organizationId: string;
    readonly actorUserId: string;
    readonly documentId: string;
    readonly extractedText: string;
  }): Promise<DocLensSudResult>;
}

export type DocLensClassifyResult =
  | {
      readonly available: true;
      readonly invocationId: string;
      readonly documentType: string;
      readonly confidence: number;
      readonly alternates: readonly { readonly type: string; readonly confidence: number }[];
      readonly warnings: readonly AIWarning[];
    }
  | AiSeamRefusal;

/** The bounding box §4.2.2 attaches to an extracted field: `[x0, y0, x1, y1]`. */
export type DocLensSourceBBox = readonly [number, number, number, number];

export type DocLensExtractResult =
  | {
      readonly available: true;
      readonly invocationId: string;
      readonly fields: Readonly<
        Record<
          string,
          {
            readonly value: unknown;
            readonly confidence: number;
            readonly sourceSpan?: { readonly page: number; readonly bbox: DocLensSourceBBox };
            /** F-236 — the model's VERBATIM quote and claimed page. The consumer GROUNDS it against its
             *  own parsed text (ADR-0048); M32 never asserts it is true. */
            readonly sourceQuote?: { readonly page: number; readonly text: string };
          }
        >
      >;
      readonly warnings: readonly AIWarning[];
    }
  | AiSeamRefusal;

export type DocLensVerifyResult =
  | {
      readonly available: true;
      readonly invocationId: string;
      readonly verdict: "pass" | "fail" | "uncertain";
      readonly confidence: number;
      readonly evidence: readonly {
        readonly pageNumber: number;
        readonly description: string;
      }[];
      readonly warnings: readonly AIWarning[];
    }
  | AiSeamRefusal;

export type DocLensSudResult =
  | {
      readonly available: true;
      readonly invocationId: string;
      readonly sudIndicatorsDetected: boolean;
      readonly confidence: number;
      readonly indicators: readonly {
        readonly pageNumber: number;
        readonly snippet: string;
        readonly category: string;
      }[];
      readonly warnings: readonly AIWarning[];
    }
  | AiSeamRefusal;
