// @wardenx/orders — §2.1/§2.2/§4.7 discipline_can_order + signer_eligible — M11-T03.
import { describe, expect, it } from "vitest";
import {
  LPN_DRAFTABLE_KINDS,
  assertDisciplineCanOrder,
  disciplineCanOrder,
} from "../src/lifecycle/discipline-can-order";
import {
  PHYSICIAN_ONLY_SIGN_KINDS,
  assertSignAuthority,
  assertSignerEligible,
  signerEligible,
} from "../src/lifecycle/signer-eligible";

describe("§2.1 disciplineCanOrder", () => {
  it("a discipline in the kind's signer matrix may author it", () => {
    expect(disciplineCanOrder("rn_case_manager", "lab")).toBe(true);
    expect(disciplineCanOrder("medical_director", "recertification")).toBe(true);
    expect(disciplineCanOrder("msw", "ancillary_service")).toBe(true);
  });

  it("an LPN may draft clinical kinds (RN cosign then gates the signature)", () => {
    for (const kind of LPN_DRAFTABLE_KINDS) {
      expect(disciplineCanOrder("lpn", kind)).toBe(true);
      expect(disciplineCanOrder("LPN", kind)).toBe(true); // case-insensitive
    }
  });

  it("an LPN may NOT draft a written-ab-initio or IDG-intake kind", () => {
    expect(disciplineCanOrder("lpn", "recertification")).toBe(false);
    expect(disciplineCanOrder("lpn", "level_of_care_change")).toBe(false);
    expect(disciplineCanOrder("lpn", "idg_requested")).toBe(false);
  });

  it("an off-matrix discipline cannot author (403 DISCIPLINE_CANNOT_ORDER)", () => {
    expect(disciplineCanOrder("msw", "lab")).toBe(false);
    expect(() => assertDisciplineCanOrder("msw", "lab")).toThrowError(
      expect.objectContaining({ code: "DISCIPLINE_CANNOT_ORDER", statusCode: 403 }),
    );
  });
});

describe("§2.2 signerEligible", () => {
  it("honors the kind's signer matrix", () => {
    expect(signerEligible("pa", "lab")).toBe(true);
    expect(signerEligible("msw", "ancillary_service")).toBe(true);
    expect(signerEligible("msw", "lab")).toBe(false);
  });

  it("narrows recertification / level_of_care_change to a physician (§2.2 over the catalog matrix)", () => {
    for (const kind of PHYSICIAN_ONLY_SIGN_KINDS) {
      expect(signerEligible("medical_director", kind)).toBe(true);
      expect(signerEligible("hospice_physician", kind)).toBe(true);
    }
    // np is in the LCC catalog matrix but §2.2 forbids it signing the order.
    expect(signerEligible("np", "level_of_care_change")).toBe(false);
  });

  it("an LPN is never a signer", () => {
    expect(signerEligible("lpn", "lab")).toBe(false);
    expect(() => assertSignerEligible("lpn", "lab")).toThrowError(
      expect.objectContaining({ code: "SIGNER_NOT_ELIGIBLE", statusCode: 403 }),
    );
  });
});

describe("§2.2 assertSignAuthority", () => {
  it("the named practitioner may always sign", () => {
    expect(() =>
      assertSignAuthority({
        isNamedPractitioner: true,
        onBehalf: false,
        onBehalfSignerIsMedicalDirector: false,
        viaVerbal: false,
      }),
    ).not.toThrow();
  });

  it("a non-named signer with no on-behalf is refused (403 SIGNER_NOT_NAMED_PRACTITIONER)", () => {
    expect(() =>
      assertSignAuthority({
        isNamedPractitioner: false,
        onBehalf: false,
        onBehalfSignerIsMedicalDirector: false,
        viaVerbal: false,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "SIGNER_NOT_NAMED_PRACTITIONER", statusCode: 403 }),
    );
  });

  it("a medical_director may sign on behalf in the written flow", () => {
    expect(() =>
      assertSignAuthority({
        isNamedPractitioner: false,
        onBehalf: true,
        onBehalfSignerIsMedicalDirector: true,
        viaVerbal: false,
      }),
    ).not.toThrow();
  });

  it("on-behalf is refused in the verbal flow and for a non-MD (403 ON_BEHALF_NOT_PERMITTED)", () => {
    expect(() =>
      assertSignAuthority({
        isNamedPractitioner: false,
        onBehalf: true,
        onBehalfSignerIsMedicalDirector: true,
        viaVerbal: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "ON_BEHALF_NOT_PERMITTED", statusCode: 403 }));
    expect(() =>
      assertSignAuthority({
        isNamedPractitioner: false,
        onBehalf: true,
        onBehalfSignerIsMedicalDirector: false,
        viaVerbal: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "ON_BEHALF_NOT_PERMITTED" }));
  });
});
