import { describe, expect, it } from "vitest";
import {
  type StediClaimStatusInquiry,
  buildClaimStatusRequest,
  parseClaimStatusResponse,
} from "./stedi-claim-status";
import { CH } from "./types";

const INQUIRY: StediClaimStatusInquiry = {
  controlNumber: "000000042",
  payerId: "60054",
  billingProvider: { organizationName: "Synthetic Hospice", npi: "1234567893" },
  subscriber: {
    memberId: "SYN123456",
    firstName: "Test",
    lastName: "Patient",
    dateOfBirth: "1950-02-03",
  },
  serviceFrom: "2026-03-01",
  serviceTo: "2026-03-31",
};
const answer = (...codes: string[]) => ({
  controlNumber: "000000042",
  claims: [
    {
      claimStatus: {
        statusInformation: codes.map((c) => ({ healthCareClaimStatusCategoryCode: c })),
      },
    },
  ],
});
const state = (b: unknown) => {
  const r = parseClaimStatusResponse("000000042", b);
  return r.ok ? r.data.state : r.degraded.code;
};

describe("Stedi claim status (unverified, unbound)", () => {
  it("builds the request with compact dates", () => {
    const r = buildClaimStatusRequest(INQUIRY);
    expect(r.ok && r.data).toMatchObject({
      controlNumber: "000000042",
      tradingPartnerServiceId: "60054",
      subscriber: { dateOfBirth: "19500203" },
      encounter: { beginningDateOfService: "20260301", endDateOfService: "20260331" },
    });
  });

  it("refuses bad input without echoing it", () => {
    for (const bad of [
      { ...INQUIRY, controlNumber: "a b" },
      { ...INQUIRY, payerId: "" },
      { ...INQUIRY, serviceTo: "03/31/2026" },
      { ...INQUIRY, subscriber: { ...INQUIRY.subscriber, memberId: "" } },
    ]) {
      const r = buildClaimStatusRequest(bad);
      expect(!r.ok && r.degraded.code).toBe(CH.INVALID_REQUEST);
      expect(JSON.stringify(r)).not.toContain("Patient");
    }
  });

  it("maps category codes, a rejection winning and unlisted codes staying non-terminal", () => {
    expect(state(answer("A2"))).toBe("received");
    expect(state(answer("F1"))).toBe("payer_accepted");
    expect(state(answer("F1", "F2"))).toBe("payer_rejected");
    expect(state(answer("F1", "P1"))).toBe("received");
    expect(state(answer("A7"))).toBe("payer_rejected");
  });

  it("never answers not_found, and never invents an acknowledgment", () => {
    expect(state(answer("A4"))).toBe(CH.UNAVAILABLE);
    expect(state({ claims: [] })).toBe(CH.UNAVAILABLE);
    expect(state({ errors: [{ code: "x" }] })).toBe(CH.INVALID_REQUEST);
    expect(state(null)).toBe(CH.INVALID_REQUEST);
    const ok = parseClaimStatusResponse("000000042", answer("F1"));
    expect(ok.ok && ok.data.latest).toBeNull();
  });
});
