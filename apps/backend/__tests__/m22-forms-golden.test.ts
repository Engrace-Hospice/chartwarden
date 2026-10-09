// GAP-033 - golden files for the Wave 1 forms: model, laid-out text per page, and the PDF byte hash. A change to
// a form's content, wording, layout or pagination shows up here as a reviewable diff.
//   UPDATE_GOLDEN=1 bun run test:golden:m22     (regenerate deliberately)
import { describe, it } from "vitest";
import { COMPILED_FORMS } from "../src/modules/22-documents/render-pdf/forms";
import { expectGolden } from "./_golden-m22";
import {
  CTI,
  DISCHARGE,
  F2F,
  LONG_NARRATIVE,
  NOR,
  REVOCATION,
  TRANSFER,
} from "./_m22-form-fixtures";

describe("M22 Wave 1 form goldens", () => {
  it("cti", () => expectGolden("cti", COMPILED_FORMS.cti(CTI)));
  it("cti (multi-page narrative)", () =>
    expectGolden(
      "cti-long-narrative",
      COMPILED_FORMS.cti({ ...CTI, narrative: `${LONG_NARRATIVE} ${LONG_NARRATIVE}` }),
    ));
  it("f2f", () => expectGolden("f2f", COMPILED_FORMS.f2f(F2F)));
  it("nor", () => expectGolden("nor", COMPILED_FORMS.nor(NOR)));
  it("revocation", () => expectGolden("revocation", COMPILED_FORMS.revocation(REVOCATION)));
  it("discharge_summary", () =>
    expectGolden("discharge_summary", COMPILED_FORMS.discharge_summary(DISCHARGE)));
  it("discharge_summary (pending cosign)", () =>
    expectGolden(
      "discharge_summary-pending-cosign",
      COMPILED_FORMS.discharge_summary({
        ...DISCHARGE,
        status: "pending_cosign",
        cosign: { required: true, completed: false, signature: null },
      }),
    ));
  it("discharge_summary_transfer", () =>
    expectGolden(
      "discharge_summary_transfer",
      COMPILED_FORMS.discharge_summary_transfer(TRANSFER),
    ));
  it("abn (structure only, CMS wording pending)", () =>
    expectGolden(
      "abn-structure-only",
      COMPILED_FORMS.abn({
        abnId: "abn-1",
        serviceDescription: "Wound care supplies beyond the plan of care",
        estimatedCost: 12550,
        reasonNoncovered: "Not reasonable and necessary for the terminal illness",
        requiredBy: "2026-10-09T00:00:00.000Z",
      }),
    ));
});
