// apps/backend/src/modules/22-documents/render-pdf/forms/compile.ts - compiles a FormSpec to a pure
// `payload -> DocModel` builder (GAP-033).
//
// What the compiler guarantees for EVERY form, so no per-template builder can forget it:
//   * the payload is validated (typed, allow-listed): only declared fields are ever drawn;
//   * the patient's name / MRN / DOB sit in a field grid on page 1 and in a running header on pages 2..N;
//   * the PDF /Title, the footer label and the document title are the spec's CONSTANT title (PHI-free);
//   * a REQUIRED signature that is missing or blank THROWS (retry -> DLQ) - an unsigned document is never
//     drawn under a "signed" event. Patient identity is validated by the payload schema (non-empty);
//   * the 42 CFR 2.32 redisclosure notice appears when Part 2 content is present;
//   * glyphs WinAnsi cannot draw are disclosed on the page (never silently replaced).
import {
  RenderPayloadError,
  type SignatureRecord,
  type UndatedSignatureRecord,
  formatMrn,
} from "@wardenx/types";
import type { Block, DocModel, SignatureBlock } from "../doc-model";
import { latestInstant } from "../doc-model";
import { PART2_REDISCLOSURE_NOTICE, PART2_WITHHELD, fmtInstant, rec } from "../shared";
import type { FormContext, FormSection, FormSpec, SignatureSpec } from "./spec";

const BLANK = "______________________________";

type AnySignature = SignatureRecord | UndatedSignatureRecord;

function signatureViolation(sig: AnySignature | null | undefined): string | undefined {
  if (sig === null || sig === undefined) return "no signature record";
  if (sig.printedName.trim() === "") return "signature has no printed name";
  // An undated record (a witness whose time the source does not capture) is legitimate; a dated one must parse.
  if (sig.signedAt !== undefined && !Number.isFinite(Date.parse(sig.signedAt)))
    return "signature has no valid date";
  return undefined;
}

function toSignatureBlock(sig: AnySignature, role: string): Block {
  const block: SignatureBlock = {
    role,
    printedName: sig.printedName,
    ...(sig.signedAt !== undefined ? { signedAt: sig.signedAt } : {}),
    method: sig.method,
    meaning: sig.meaning,
    ref: sig.recordId,
    ...(sig.credentials ? { credentials: sig.credentials } : {}),
    ...(sig.npi ? { npi: sig.npi } : {}),
    ...(sig.capacity ? { capacity: sig.capacity } : {}),
    // A paper signature prints the ruled blank AND the record-of-scan line.
    ...(sig.method === "wet_ink_scanned" ? { ruledLine: true } : {}),
  };
  return { kind: "signature", ...block };
}

function sectionBlocks<P>(s: FormSection<P>, p: P, ctx: FormContext): Block[] {
  const head: Block[] = [
    ...(s.heading ? ([{ kind: "heading", level: 1, text: s.heading }] as Block[]) : []),
    // `legal` sections print their own citation line above the verbatim text.
    ...(s.cite && s.kind !== "legal"
      ? ([{ kind: "paragraph", muted: true, text: `[${s.cite}]` }] as Block[])
      : []),
  ];
  switch (s.kind) {
    case "legal":
      return [
        ...head,
        { kind: "legalText", id: s.id, text: s.text, ...(s.cite ? { cite: s.cite } : {}) },
      ];
    case "fields":
      return [...head, { kind: "fieldGrid", cells: s.cells(p) }];
    case "narrative": {
      const text = s.text(p)?.trim();
      return [...head, { kind: "paragraph", text: text && text.length > 0 ? text : s.emptyText }];
    }
    case "list": {
      const items = s.items(p);
      const withheld = s.withheld?.(p) ?? 0;
      const all = [...items, ...Array.from({ length: withheld }, () => PART2_WITHHELD)];
      return [
        ...head,
        all.length > 0
          ? { kind: "bullets", items: all }
          : { kind: "paragraph", muted: true, text: s.emptyText },
      ];
    }
    case "attestation":
      return [...head, { kind: "attestation", text: s.text(p, ctx), checked: true }];
    case "banner": {
      const message = s.message(p);
      return message === undefined ? [] : [{ kind: "banner", tone: s.tone, text: message }];
    }
    case "custom":
      return [...head, ...s.blocks(p, ctx)];
  }
}

function signatureBlocks<P>(spec: FormSpec<P>, p: P): Block[] {
  const out: Block[] = [];
  for (const sigSpec of spec.signatures as ReadonlyArray<SignatureSpec<P>>) {
    const record = sigSpec.from(p);
    const problem = signatureViolation(record);
    if (problem !== undefined) {
      const required =
        typeof sigSpec.required === "function" ? sigSpec.required(p) : sigSpec.required;
      if (required) {
        throw new RenderPayloadError(spec.key, [`/${sigSpec.id}: ${problem}`]);
      }
      continue;
    }
    out.push(toSignatureBlock(record as AnySignature, sigSpec.role));
  }
  return out;
}

/** A compiled form: the pure builder, with its spec attached so tests can audit it against the registry. */
export interface CompiledForm<P> {
  (payload: unknown): DocModel;
  readonly spec: FormSpec<P>;
}

/** Compile `spec` to a pure builder. The builder THROWS on a malformed payload or a missing required signature. */
export function defineForm<P>(spec: FormSpec<P>): CompiledForm<P> {
  const build = (payload: unknown): DocModel => {
    const p = spec.parse(payload);
    const ctx: FormContext = { part2ContentPresent: rec(payload).sudRedacted === true };
    const patient = spec.patient(p);
    const hospice = spec.hospiceName(p);
    const documentDate = spec.documentDate(p);

    const blocks: Block[] = [
      { kind: "title", text: spec.title, ...(hospice ? { subtitle: hospice } : {}) },
      {
        kind: "fieldGrid",
        cells: [
          ...(patient
            ? ([
                ["Patient", patient.name],
                ["Medical record number", patient.mrn],
                ["Date of birth", patient.dateOfBirth ?? BLANK],
              ] as const)
            : []),
          ...(documentDate === null
            ? []
            : ([["Document date", fmtInstant(documentDate)]] as const)),
        ],
      },
    ];
    if (ctx.part2ContentPresent) {
      blocks.push({ kind: "banner", tone: "danger", text: PART2_REDISCLOSURE_NOTICE });
    }
    for (const section of spec.sections) blocks.push(...sectionBlocks(section, p, ctx));

    const signatures = signatureBlocks(spec, p);
    // The text just above a signature (the CTI narrative) must travel with it: never a signature alone.
    const last = blocks[blocks.length - 1];
    if (signatures.length > 0 && last?.kind === "paragraph") {
      blocks[blocks.length - 1] = { ...last, keepWithNext: true };
    }
    // Never strand a signature alone on a page: the signature group travels as one unit.
    // No heading between the last section and the signatures: 418.22(b)(3) wants the narrative immediately
    // above the physician's signature, and each signature block carries its own role line.
    if (signatures.length > 0) blocks.push({ kind: "keepTogether", blocks: signatures });

    const watermark = spec.watermark?.(p);
    return {
      title: spec.title,
      createdAtIso: latestInstant([documentDate ?? undefined]),
      blocks,
      runningHeader: patient
        ? `${patient.name} - ${formatMrn(patient.mrn)} - ${spec.title}`
        : spec.title,
      discloseDegradedGlyphs: true,
      ...(watermark ? { watermark } : {}),
    };
  };
  return Object.assign(build, { spec });
}
