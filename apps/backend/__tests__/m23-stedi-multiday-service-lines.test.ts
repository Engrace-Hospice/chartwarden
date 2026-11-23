// M23 — pins how a multi-day claim line reaches Stedi's JSON and the raw 837I. The shape is
// `serviceDate` (first day) + `serviceDateEnd` (last day), both CCYYMMDD; a single-day line carries `serviceDate`
// alone. The earlier shape put the range in `serviceDate` as `CCYYMMDD-CCYYMMDD`. Stedi's field names have not been
// exercised against its sandbox (it cannot submit claims), so this pins OUR output, not Stedi's acceptance.
import type { ClaimDocument837iDetail } from "@chartwarden/billing";
import { describe, expect, it } from "vitest";
import {
  type MapClaimTo837iArgs,
  mapClaimTo837iInput,
  render837i,
} from "../src/modules/23-billing-medicare/services/claim-837i-mapper";

const ADDRESS = { line1: "100 Main St", city: "Portland", state: "OR", postalCode: "97201" };

const document: ClaimDocument837iDetail = {
  claimId: "claim-1",
  claimControlNumber: "WXHOSP0001",
  tob: "813",
  frequency: "3",
  serviceFrom: "2026-01-01",
  serviceTo: "2026-01-31",
  admissionDate: "2026-01-01",
  admissionTypeCode: "1",
  admissionSourceCode: "1",
  valueCodes: [],
  dischargeCodes: { patientStatus: "30", conditionCodes: [], occurrenceCodes: [] },
  occurrenceSpans: [],
  lines: [
    {
      sourceLineId: null,
      lineNumber: 1,
      revenueCode: "0651",
      hcpcs: "Q5001",
      modifiers: [],
      units: 8,
      chargeCents: 20_000,
      noncoveredCents: 0,
      serviceDateFrom: "2026-01-02",
      serviceDateTo: "2026-01-09",
    },
    {
      sourceLineId: null,
      lineNumber: 2,
      revenueCode: "0651",
      hcpcs: "Q5001",
      modifiers: [],
      units: 1,
      chargeCents: 2_500,
      noncoveredCents: 0,
      serviceDateFrom: "2026-01-10",
      serviceDateTo: "2026-01-10",
    },
  ],
  totalChargeCents: 22_500,
  nonCoveredChargeCents: 0,
  diagnoses: [{ icd10Code: "C3490", sequence: 1, qualifier: "ABK" }],
  attendingPhysician: { npi: "1245319599", firstName: "Alan", lastName: "Smith" },
  certifyingPhysician: null,
  payerClaimControlNumber: null,
};

const args: MapClaimTo837iArgs = {
  document,
  subscriber: {
    mbi: "1EG4TE5MK73",
    lastName: "Doe",
    firstName: "Jane",
    dateOfBirth: "1940-03-15",
    sex: "F",
    address: ADDRESS,
  },
  parties: {
    submitter: {
      name: "Example Hospice of Oregon",
      id: "CHARTWARDEN01",
      contactName: "Billing Office",
      contactPhone: "5035550100",
    },
    receiver: { name: "Stedi Test Payer", id: "STEDI", applicationCode: "STEDI" },
    billingProvider: {
      organizationName: "Example Hospice of Oregon",
      npi: "1234567893",
      taxId: "931234567",
      address: ADDRESS,
    },
    payer: { name: "Stedi Test Payer", payerId: "STEDI" },
  },
  envelope: {
    interchangeControlNumber: 101,
    usage: "T",
    createdAt: new Date("2026-10-09T15:00:00.000Z"),
  },
};

function rendered() {
  const mapped = mapClaimTo837iInput(args);
  expect(mapped.ok).toBe(true);
  if (!mapped.ok) throw new Error("synthetic claim did not map");
  const result = render837i(mapped.value);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("synthetic claim did not render");
  return result.value;
}

describe("M23 multi-day service lines in the Stedi JSON and raw 837I", () => {
  it("puts the first day in serviceDate and the last day in serviceDateEnd, never a combined range", () => {
    const { stediJson } = rendered();
    const [multiDay, singleDay] = stediJson?.claimInformation.serviceLines ?? [];
    expect(multiDay).toEqual({
      serviceDate: "20260102",
      serviceDateEnd: "20260109",
      institutionalService: {
        serviceLineRevenueCode: "0651",
        procedureIdentifier: "HC",
        procedureCode: "Q5001",
        lineItemChargeAmount: "200.00",
        measurementUnit: "UN",
        serviceUnitCount: "8",
      },
    });
    expect(multiDay?.serviceDate).not.toContain("-");
    // A single-day line is unchanged: serviceDate alone.
    expect(singleDay).toEqual({
      serviceDate: "20260110",
      institutionalService: {
        serviceLineRevenueCode: "0651",
        procedureIdentifier: "HC",
        procedureCode: "Q5001",
        lineItemChargeAmount: "25.00",
        measurementUnit: "UN",
        serviceUnitCount: "1",
      },
    });
  });

  it("emits the same days as RD8 and D8 in the raw 837I", () => {
    const { x12 } = rendered();
    expect(x12).toContain("DTP*472*RD8*20260102-20260109~");
    expect(x12).toContain("DTP*472*D8*20260110~");
  });
});
