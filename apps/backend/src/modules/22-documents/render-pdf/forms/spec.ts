// apps/backend/src/modules/22-documents/render-pdf/forms/spec.ts - the declarative FormSpec (GAP-033). A form is
// data: an identity header, fixed regulatory sections, field sections drawn from a typed payload, and signature
// blocks. `defineForm` (./compile.ts) compiles one to a pure `payload -> DocModel` builder, so registering a form
// is still one row in registry.ts and the layout/PDF pipeline is unchanged. Hand-written builders remain the
// escape hatch for documents that are not form-shaped (IDG packet, lab results, tabular reports).
import type { RenderPatientIdentity, SignatureRecord } from "@wardenx/types";
import type { Block } from "../doc-model";

/** Context derived once per render, never from the payload's own claims about safety. */
export interface FormContext {
  /**
   * 42 CFR Part 2 content is present and the render proceeded (consent resolved upstream). NOTE the legacy
   * name: the render payload's `sudRedacted` flag means "SUD content present WITH consent", not "redacted".
   */
  readonly part2ContentPresent: boolean;
}

export type FormCells = ReadonlyArray<readonly [label: string, value: string]>;

interface SectionBase {
  /** The forms-registry `requiredFields` id this section satisfies (D16 golden-template-diff). */
  readonly id: string;
  readonly heading?: string;
  /** Regulatory citation printed above the section. */
  readonly cite?: string;
}

export type FormSection<P> =
  | (SectionBase & { readonly kind: "legal"; readonly text: string })
  | (SectionBase & { readonly kind: "fields"; readonly cells: (p: P) => FormCells })
  | (SectionBase & {
      readonly kind: "narrative";
      readonly text: (p: P) => string | undefined;
      readonly emptyText: string;
    })
  | (SectionBase & {
      readonly kind: "list";
      readonly items: (p: P) => readonly string[];
      /** Entries withheld under Part 2; printed as the withheld marker rather than silently dropped. */
      readonly withheld?: (p: P) => number;
      readonly emptyText: string;
    })
  | (SectionBase & {
      readonly kind: "attestation";
      readonly text: (p: P, ctx: FormContext) => string;
    })
  | (SectionBase & {
      readonly kind: "banner";
      readonly message: (p: P) => string | undefined;
      readonly tone: "info" | "warn" | "danger";
    })
  | (SectionBase & {
      readonly kind: "custom";
      readonly blocks: (p: P, ctx: FormContext) => Block[];
    });

export interface SignatureSpec<P> {
  /** The forms-registry `requiredFields` id this signature block satisfies. */
  readonly id: string;
  readonly heading?: string;
  /** The signature record, or null when this signer legitimately did not sign (optional signers only). */
  readonly from: (p: P) => SignatureRecord | null;
  /**
   * True for the signer whose absence makes the document meaningless. A required signature that is missing or
   * blank THROWS (retry -> DLQ): an unsigned document is never drawn under a "signed" event.
   */
  readonly required: boolean | ((p: P) => boolean);
  /** Printed as the signature block's role line. */
  readonly role: string;
}

export interface FormSpec<P> {
  readonly key: string;
  /** Bumped with ANY layout or fixed-text change (semver); printed in the golden model. */
  readonly version: string;
  /** Constant, PHI-free title: the PDF /Title, the footer label and the document row title. */
  readonly title: string;
  /** Regulatory authority the form implements (documentation + tests). */
  readonly authority: string;
  /** Validate the payload; throws `RenderPayloadError` listing what is wrong. */
  readonly parse: (payload: unknown) => P;
  readonly patient: (p: P) => RenderPatientIdentity;
  readonly hospiceName: (p: P) => string | null;
  /** ISO instant the document is dated from (never the wall clock). */
  readonly documentDate: (p: P) => string;
  readonly sections: ReadonlyArray<FormSection<P>>;
  readonly signatures: ReadonlyArray<SignatureSpec<P>>;
  /** Optional page watermark (`VOID`, `SUPERSEDED`) derived from the payload. */
  readonly watermark?: (p: P) => { text: string; tone: "info" | "warn" | "danger" } | undefined;
}

/** Fields every compiled form provides on its own; they satisfy the forms-registry base floor. */
export const COMPILER_PROVIDED_FIELDS = [
  "organization_letterhead",
  "document_title",
  "generated_at",
] as const;

/** Every registry field id this spec draws (sections + signatures + the compiler-provided base). */
export function providedFieldIds<P>(spec: FormSpec<P>): readonly string[] {
  return [
    ...COMPILER_PROVIDED_FIELDS,
    ...spec.sections.map((s) => s.id),
    ...spec.signatures.map((s) => s.id),
  ];
}
