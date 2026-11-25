// One MRN label, then the identifier once, on every screen that prints a label beside an MRN. The patient service stores "MRN-" +
// 12 hex digits, so a screen that glues its own "MRN" label on shows "MRN MRN-...". The rule lives in @chartwarden/types (`mrnValue`
// when the layout supplies the label, `formatMrn` when it does not); the banner in @chartwarden/ui keeps a one-line copy because the
// kit is a leaf, and this test pins the copy to the rule. Synthetic identifiers only.
import { formatMrn, mrnValue } from "@chartwarden/types";
import { PatientBanner } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

const STORED = [
  "MRN-FB250B6C6A8A",
  "FB250B6C6A8A",
  "mrn 123",
  "MRN: 123",
  "mrn#123",
  "  MRN-0042817  ",
  "MRNX-1",
  "MRN",
  "",
];

describe("the banner and the shared rule", () => {
  it.each(STORED)("print the same identifier for %j", (stored) => {
    render(<PatientBanner name="Emma Charlotte" mrn={stored} />);

    const label = screen.queryByText("MRN");
    const shown = label?.parentElement?.textContent?.replace(/^MRN/, "") ?? "";
    expect(shown).toBe(mrnValue(stored));
  });
});

describe("a bare value keeps its label where no layout supplies one", () => {
  it("formatMrn labels a bare value and shows a labelled one as stored", () => {
    expect(formatMrn("FB250B6C6A8A")).toBe("MRN FB250B6C6A8A");
    expect(formatMrn("MRN-FB250B6C6A8A")).toBe("MRN-FB250B6C6A8A");
  });
});
