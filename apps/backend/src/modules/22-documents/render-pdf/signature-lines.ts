// apps/backend/src/modules/22-documents/render-pdf/signature-lines.ts - the text of a 21 CFR 11.50 signature
// manifestation (printed name, date/time, meaning) as a pure function, shared by the layout engine and tests.
import type { SignatureBlock } from "./doc-model";
import { fmtWhen, humanize } from "./shared";

export interface SignatureLine {
  readonly text: string;
  readonly bold: boolean;
}

const METHOD_VERB: Readonly<Record<NonNullable<SignatureBlock["method"]>, string>> = {
  electronic: "Electronically signed by",
  wet_ink_scanned: "Signed on paper by",
  verbal_cosign: "Verbal acknowledgment recorded for",
};

const shortRef = (v: string): string => v.slice(0, 8);

/** The lines a signature block prints, top to bottom. */
export function signatureLines(sig: SignatureBlock): SignatureLine[] {
  const lines: SignatureLine[] = [{ text: sig.role, bold: true }];
  const who = [sig.printedName, sig.credentials]
    .filter((v) => v !== undefined && v !== "")
    .join(", ");
  const capacity = sig.capacity ? ` (${sig.capacity})` : "";
  if (sig.printedName !== undefined && sig.signedAt !== undefined) {
    const verb = METHOD_VERB[sig.method ?? "electronic"];
    const npi = sig.npi ? ` (NPI ${sig.npi})` : "";
    lines.push({
      text: `${verb} ${who}${npi}${capacity} on ${fmtWhen(sig.signedAt)}.`,
      bold: false,
    });
  } else if (sig.printedName !== undefined) {
    lines.push({ text: `Name: ${who}${capacity}`, bold: false });
  }
  if (sig.meaning) {
    lines.push({ text: `Meaning of signature: ${humanize(sig.meaning)}.`, bold: false });
  }
  if (sig.method === "wet_ink_scanned" && sig.signedAt !== undefined) {
    lines.push({
      text: `Record of scan: the signed paper copy was filed on ${fmtWhen(sig.signedAt)}.`,
      bold: false,
    });
  }
  if (sig.ref) lines.push({ text: `Signature record ref ${shortRef(sig.ref)}.`, bold: false });
  return lines;
}
