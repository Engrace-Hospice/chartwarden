// apps/backend/src/modules/10-hope/hope-cms-xml-render.ts — the byte layout of one iQIES HOPE record file.
//
// CMS HOPE Data Submission Specifications Overview (V1.00.1), §9 "XML File Structure":
//   - ASCII encoding, `<?xml version="1.0" standalone="yes"?>` header;
//   - a single `<ASSESSMENT>` root holding one flat element per active item — no wrapper, no attributes;
//   - one assessment per .xml file.
// The overview's Figure 1 still shows the pre-V1.00.1 `ITM_SET_SYS_CD`; the itm_mstr CSV (authoritative)
// replaced it with `ASMT_SYS_CD`, which is what the header builder emits.

import { HopeSubmissionPayloadError } from "./hope-submission-header";

const XML_DECLARATION = '<?xml version="1.0" standalone="yes"?>';

const XML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

const NON_PRINTABLE_ASCII = /[^\x20-\x7E]/;

/**
 * Item text as iQIES accepts it: ASCII only. Accents are folded (José → Jose) because the record's name
 * must still match the patient's; anything that cannot be folded (CJK, emoji, …) fails packaging naming
 * the item, rather than reaching iQIES as a parse error or silently becoming a different name.
 */
export function toCmsAsciiText(itemCode: string, value: string): string {
  const folded = value.normalize("NFD").replace(/\p{M}/gu, "");
  if (NON_PRINTABLE_ASCII.test(folded)) {
    throw new HopeSubmissionPayloadError(
      `HOPE item ${itemCode} contains characters iQIES cannot accept (ASCII only)`,
      "WX-HOPE-SUBMISSION-NON-ASCII",
      { itemCode },
    );
  }
  return folded;
}

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => XML_ENTITIES[char] as string);
}

/** Render one assessment's items, in order, as a CMS HOPE XML record file. */
export function renderCmsAssessmentXml(
  items: ReadonlyArray<{ readonly itemCode: string; readonly value: string }>,
): string {
  return [
    XML_DECLARATION,
    "<ASSESSMENT>",
    // The tag is an item code from the frozen spec, never user input; only the value is escaped.
    ...items.map(
      ({ itemCode, value }) =>
        `<${itemCode}>${xmlEscape(toCmsAsciiText(itemCode, value))}</${itemCode}>`,
    ),
    "</ASSESSMENT>",
    "",
  ].join("\n");
}
