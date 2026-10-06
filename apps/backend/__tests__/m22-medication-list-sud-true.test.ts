// GAP-036 follow-up — M12 now WRITES medication_order.is_sud_treatment, so M22's patient medication list
// finally sees `isSudTreatment: true` in production. Prove (without a database) that the render handles it:
// redacted without a Part 2 release, plain with one, and a redacted document is inserted compliance_42cfr_part2.
import { describe, expect, it } from "vitest";
import {
  SUD_REDACTED_PLACEHOLDER,
  SUD_REDACTION_BANNER,
  SUD_RETENTION_CLASS,
  planMedicationListRender,
} from "../src/modules/22-documents/render-variants/render-variants";

const entry = (id: string, drugName: string, isSudTreatment: boolean) => ({
  medicationOrderId: id,
  drugName,
  strength: "40 mg",
  doseForm: "tablet",
  route: "oral",
  sigSummary: "40 mg daily",
  status: "active",
  isControlledSubstance: false,
  deaSchedule: null,
  signedAt: null,
  isSudTreatment,
});
const payload = {
  patientId: "pat-1",
  asOfIso: "2026-10-05T00:00:00.000Z",
  medications: [entry("o1", "Methadone", true), entry("o2", "Lorazepam", false)],
};
type Row = { drugName: string; sigSummary: string; strength: string | null; redacted: boolean };

describe("planMedicationListRender with an SUD-treatment order", () => {
  it("redacts the SUD drug name + sig, keeps the non-SUD row, and files it under Part 2 retention", () => {
    const out = planMedicationListRender({ payload, consentPresent: false });
    const rows = out.content.medications as Row[];
    expect(rows[0]).toMatchObject({
      drugName: SUD_REDACTED_PLACEHOLDER,
      sigSummary: SUD_REDACTED_PLACEHOLDER,
      strength: null,
      redacted: true,
    });
    expect(rows[1]).toMatchObject({ drugName: "Lorazepam", redacted: false });
    expect(out.sudRedacted).toBe(true);
    expect(out.retentionClassOverride).toBe(SUD_RETENTION_CLASS);
    expect(out.content.sudBanner).toBe(SUD_REDACTION_BANNER);
    expect(JSON.stringify(out.content)).not.toContain("Methadone");
  });

  it("shows the real drug with a Part 2 release and does not re-class the document", () => {
    const out = planMedicationListRender({ payload, consentPresent: true });
    expect((out.content.medications as Row[])[0]).toMatchObject({
      drugName: "Methadone",
      redacted: false,
    });
    expect(out.sudRedacted).toBe(false);
    expect(out.retentionClassOverride).toBeUndefined();
  });
});
