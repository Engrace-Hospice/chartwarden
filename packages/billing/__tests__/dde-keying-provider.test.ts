// #765: the keying sheet carries the provider's CCN and billing NPI when the M40 seam supplied them. Synthetic ids.
import { buildDdeKeyingSheet } from "@chartwarden/billing";
import { describe, expect, it } from "vitest";

const claim = {
  tob: "811",
  serviceFrom: "2026-09-01",
  serviceTo: "2026-09-30",
  controlNumber: "CW-1",
  payerControlNumber: null,
  patientStatusCode: null,
  admissionTypeCode: null,
  admissionSourceCode: null,
  rejectionCodes: [],
};
const notice = {
  kind: "noe" as const,
  controlNumber: "CW-N1",
  payerControlNumber: null,
  effectiveDate: "2026-09-01",
  windowTargetAt: "2026-09-06",
  rejectionCodes: [],
};
const provider = { ccn: "991234", npi: "1234567893" };

describe("buildDdeKeyingSheet provider identifiers", () => {
  it("adds Provider CCN and Billing NPI to a claim sheet", () => {
    const labels = buildDdeKeyingSheet("rtp_correction", { claim, provider }).fields;
    expect(labels).toContainEqual({ label: "Provider CCN", value: "991234" });
    expect(labels).toContainEqual({ label: "Billing NPI", value: "1234567893" });
  });
  it("adds them to a notice sheet", () => {
    const labels = buildDdeKeyingSheet("noe", { notice, provider }).fields;
    expect(labels.map((f) => f.label)).toEqual(
      expect.arrayContaining(["Provider CCN", "Billing NPI"]),
    );
  });
  it("omits them when the seam is unbound or the provider is unresolved", () => {
    const labels = buildDdeKeyingSheet("noe", { notice }).fields.map((f) => f.label);
    expect(labels).not.toContain("Provider CCN");
    expect(labels).not.toContain("Billing NPI");
  });
  it("never carries an MBI field", () => {
    const labels = buildDdeKeyingSheet("noe", { notice, provider }).fields.map((f) => f.label);
    expect(labels.join(" ")).not.toMatch(/MBI|Medicare Beneficiary/i);
  });
});
