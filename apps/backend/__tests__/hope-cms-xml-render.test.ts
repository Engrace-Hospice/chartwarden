// apps/backend/__tests__/hope-cms-xml-render.test.ts — the iQIES HOPE record file layout.
// Golden: CMS HOPE Data Submission Specifications Overview V1.00.1 §9 Figure 1 (a flat <ASSESSMENT>
// root, ASCII, one element per item), with two documented deviations in the fixture: ASMT_SYS_CD in place
// of the pre-V1.00.1 ITM_SET_SYS_CD (itm_mstr CSV is authoritative), and the figure's malformed
// `<A0215>01</A0205>` line left out.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCmsAssessmentXml, toCmsAsciiText } from "../src/modules/10-hope/hope-cms-xml-render";
import { HopeSubmissionPayloadError } from "../src/modules/10-hope/hope-submission-header";

const GOLDEN = readFileSync(join(__dirname, "fixtures", "hope-cms-example-ha.xml"), "utf8");

const EXAMPLE_ITEMS = [
  ["ASMT_SYS_CD", "HOPE"],
  ["ITM_SBST_CD", "HA"],
  ["ITM_SET_VRSN_CD", "1.00"],
  ["SPEC_VRSN_CD", "1.00"],
  ["CRCTN_NUM", "00"],
  ["STATE_CD", "IA"],
  ["FAC_ID", "123122"],
  ["SFTWR_VNDR_ID", "999213459"],
  ["SFTWR_VNDR_NAME", "SOME VENDOR"],
  ["SFTWR_VNDR_EMAIL_ADR", "SUPPORT@VENDOR.COM"],
  ["SFTWR_PROD_NAME", "HOPE ENTRY SYSTEM"],
  ["SFTWR_PROD_VRSN_CD", "V2.44"],
  ["A0050", "1"],
  ["A0100A", "1234567890"],
  ["A0100B", "123456"],
  ["A0500C", "O'NEAL"],
  ["A0810", "1"],
  ["A0900", "19350621"],
  ["F2000A", "0"],
  ["F2000B", "^"],
  ["F2100A", "1"],
  ["F2100B", "-"],
  ["Z0500B", "20251001"],
].map(([itemCode, value]) => ({ itemCode: itemCode as string, value: value as string }));

describe("renderCmsAssessmentXml", () => {
  it("matches the CMS spec example byte for byte", () => {
    expect(renderCmsAssessmentXml(EXAMPLE_ITEMS)).toBe(GOLDEN);
  });

  it("uses the CMS declaration and a bare <ASSESSMENT> root with no wrapper or attributes", () => {
    const xml = renderCmsAssessmentXml(EXAMPLE_ITEMS);
    expect(xml.startsWith('<?xml version="1.0" standalone="yes"?>\n<ASSESSMENT>\n')).toBe(true);
    expect(xml).not.toMatch(/HOPE_SUBMISSION_RECORD|<RECORD|encoding=/);
  });

  it("emits printable ASCII only", () => {
    const xml = renderCmsAssessmentXml([{ itemCode: "A0500C", value: "José Peña" }]);
    expect(xml).toContain("<A0500C>Jose Pena</A0500C>");
    expect(/^[\x20-\x7E\n]*$/.test(xml)).toBe(true);
  });

  it("escapes the XML entities CMS names, lower-case", () => {
    const xml = renderCmsAssessmentXml([{ itemCode: "A0500C", value: `A&B <"C'>` }]);
    expect(xml).toContain("<A0500C>A&amp;B &lt;&quot;C&apos;&gt;</A0500C>");
  });
});

describe("renderCmsAssessmentXml item codes", () => {
  it("accepts real HOPE item codes, including digits and underscores", () => {
    expect(() =>
      renderCmsAssessmentXml([
        { itemCode: "A0500C", value: "v" },
        { itemCode: "SFTWR_PROD_VRSN_CD", value: "v" },
      ]),
    ).not.toThrow();
  });

  it("refuses an item code that is not a plain element name", () => {
    expect(() => renderCmsAssessmentXml([{ itemCode: "A0500C><X", value: "v" }])).toThrowError(
      HopeSubmissionPayloadError,
    );
  });
});

describe("toCmsAsciiText", () => {
  it("rejects characters that cannot be folded to ASCII, naming the item", () => {
    expect(() => toCmsAsciiText("A0500C", "李")).toThrowError(HopeSubmissionPayloadError);
    expect(() => toCmsAsciiText("A0500C", "李")).toThrowError(/A0500C/);
  });

  it("rejects control characters", () => {
    expect(() => toCmsAsciiText("A0500C", "line\nbreak")).toThrowError(HopeSubmissionPayloadError);
  });
});
