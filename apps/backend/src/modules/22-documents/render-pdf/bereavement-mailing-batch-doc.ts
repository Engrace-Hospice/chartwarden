// apps/backend/src/modules/22-documents/render-pdf/bereavement-mailing-batch-doc.ts — ADR-0109 D10. The `bereavement_mailing_batch` template:
// M16's `BereavementMailingBatchRenderPayload` -> a {@link DocModel} of ONE LETTER PER RECIPIENT, each on its own page(s). Pure.
//
// AN INTERNAL, SEAM-ONLY DOCUMENT. The batch holds EVERY addressee's name and mailing address (the print shop's input), so it is filed under the aggregate
// type `bereavement_mailing_batch`, which is in `SEAM_ONLY_DOCUMENT_AGGREGATE_TYPES` (`internal-documents.ts`): no M22 document route serves it to anyone
// (not even a scope-bypass role); the only way out is M16's route 49 through the `OrgDocumentAccessProvider` seam. Never in the portal. The PDF /Title,
// the running footer and the running header carry a generic title and NO name or address; the names appear only inside the letters. Each letter ends
// with a muted "Ref N" (the item's ordinal, not PHI) so a letter flagged after the download can be found and pulled.
//
// The builder reads the typed payload through `assertBereavementMailingBatchRenderPayload`: a malformed batch (no letters, an empty address) FAILS the
// render rather than printing a blank envelope window, and the worker moves the run to `failed`.
import { assertBereavementMailingBatchRenderPayload } from "@chartwarden/types";
import { type Block, type DocModel, FALLBACK_CREATED_AT } from "./doc-model";

/** The generic PDF /Title and footer: never a name, an address or the agency's wording. */
export const BEREAVEMENT_MAILING_BATCH_TITLE = "Bereavement Mailing Batch (Internal)";

/** Blank lines between the address block, the greeting, the body and the sign-off. */
const SECTION_GAP = 14;

export function buildBereavementMailingBatchDoc(payload: unknown): DocModel {
  const p = assertBereavementMailingBatchRenderPayload(payload);
  const blocks: Block[] = [];
  p.letters.forEach((letter, index) => {
    if (index > 0) blocks.push({ kind: "pageBreak" });
    blocks.push({ kind: "paragraph", text: letter.recipientName });
    for (const line of letter.addressLines) blocks.push({ kind: "paragraph", text: line });
    blocks.push({ kind: "spacer", height: SECTION_GAP });
    blocks.push({ kind: "heading", level: 1, text: p.heading });
    blocks.push({ kind: "paragraph", text: letter.greeting });
    for (const paragraph of p.paragraphs) blocks.push({ kind: "paragraph", text: paragraph });
    if (p.signoff !== undefined) {
      blocks.push({ kind: "spacer", height: SECTION_GAP });
      blocks.push({ kind: "paragraph", text: p.signoff });
    }
    blocks.push({ kind: "spacer", height: SECTION_GAP });
    blocks.push({ kind: "paragraph", text: `Ref ${letter.ref}`, muted: true });
  });
  return {
    title: BEREAVEMENT_MAILING_BATCH_TITLE,
    createdAtIso: FALLBACK_CREATED_AT,
    blocks,
    discloseDegradedGlyphs: true,
  };
}
