// GAP-033 - golden files for the Wave 1 forms: model, laid-out text per page, and the PDF byte hash. A change to
// a form's content, wording, layout or pagination shows up here as a reviewable diff.
//   UPDATE_GOLDEN=1 bun run test:golden:m22     (regenerate deliberately)
import { describe, it } from "vitest";
import { COMPILED_FORMS } from "../src/modules/22-documents/render-pdf/forms";
import { expectGolden } from "./_golden-m22";
import {
  BILLING_FIXTURES,
  CTI,
  DISCHARGE,
  F2F,
  LONG_NARRATIVE,
  MEDICATION_ORDER,
  NOR,
  ORDER_RECORD,
  REVOCATION,
  TRANSFER,
} from "./_m22-form-fixtures";

describe("M22 form goldens (waves 1-3)", () => {
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

  // Wave 2 - the signed order documents.
  it("order_record", () => expectGolden("order_record", COMPILED_FORMS.order_record(ORDER_RECORD)));
  it("order_record (no published field contract)", () =>
    expectGolden(
      "order_record-no-contract",
      COMPILED_FORMS.order_record({
        ...ORDER_RECORD,
        kind: "ancillary_service",
        kindVersion: "ancillary_service.v1",
        details: [],
        detailsNote:
          "No reviewed field contract is published for this order kind, so its specifics are not reproduced on this page. They are held on the order in the chart.",
        viaVerbal: true,
        cosign: { required: true, status: "pending" },
      }),
    ));
  it("medication_order", () =>
    expectGolden("medication_order", COMPILED_FORMS.medication_order(MEDICATION_ORDER)));
  it("medication_order (compounded, SUD treatment, allergy override)", () =>
    expectGolden(
      "medication_order-compounded-sud",
      COMPILED_FORMS.medication_order({
        ...MEDICATION_ORDER,
        medClass: "compounded",
        deaSchedule: null,
        isSudTreatment: true,
        compounded: {
          formulationDescription: "Haloperidol, lorazepam and diphenhydramine gel for topical use.",
          containsControlled: true,
          components: [
            { name: "Haloperidol", strength: "2 mg/mL", quantityRatio: "1:1" },
            { name: "Lorazepam", strength: "2 mg/mL", quantityRatio: "1:1" },
          ],
        },
        allergyOverride: {
          reason: "Tolerated this drug class previously without reaction.",
          acknowledgedAt: "2026-09-30T13:50:00.000Z",
          matchedClasses: ["benzodiazepine"],
        },
      }),
    ));

  // Wave 3 - billing correspondence.
  for (const key of Object.keys(BILLING_FIXTURES) as Array<keyof typeof BILLING_FIXTURES>) {
    it(key, () => expectGolden(key, COMPILED_FORMS[key](BILLING_FIXTURES[key] as never)));
  }
});
