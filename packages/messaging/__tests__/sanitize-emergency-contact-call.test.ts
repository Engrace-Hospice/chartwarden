// @wardenx/messaging - GAP-032: the emergency-contact call script (spec 4.7 amendment).
//
// The voice channel's fixed script for OUT-OF-BAND ALERTS never speaks a name. The SOS terminus call is a
// different, deliberate thing: an automated safety call to a clinician's consented emergency contact, which
// is useless if anonymous. So it has its OWN chokepoint function with a fixed template and an allowlist of
// exactly two variables (agency name, clinician display name). No patient, location, coordinate or alert id
// can be spoken because there is no parameter that carries one.
import { describe, expect, it } from "vitest";
import { sanitizeForEmergencyContactCall } from "../src/index";

const BASE = {
  idempotencyKey: "m20:sos:abc:dial_contact:0:0",
  agencyName: "Cedar Hospice",
  subjectDisplayName: "Dana Reyes",
};

describe("sanitizeForEmergencyContactCall", () => {
  it("speaks the fixed template with the agency and clinician names", () => {
    const out = sanitizeForEmergencyContactCall(BASE);
    expect(out.short).toContain("Cedar Hospice");
    expect(out.short).toContain("Dana Reyes");
    expect(out.short).toContain("automated safety call");
    expect(out.short).toContain("This call does not involve any patient.");
    expect(out.deepLink).toBe("");
  });

  it("carries nothing but its two variables: PHI-shaped extra fields never reach the script", () => {
    const hostile = {
      ...BASE,
      patientName: "Margaret Q. Patient",
      mrn: "MRN-99887766",
      latitude: 45.5231,
      longitude: -122.6765,
      sosAlertId: "11111111-1111-4111-8111-111111111111",
      address: "12 Elm Street",
    };
    const out = sanitizeForEmergencyContactCall(hostile);
    for (const token of ["Margaret", "MRN-99887766", "45.5231", "-122.6765", "Elm Street"]) {
      expect(out.short).not.toContain(token);
    }
    expect(out.short).not.toContain("11111111-1111");
  });

  it("strips characters outside the name allowlist and caps the length", () => {
    const out = sanitizeForEmergencyContactCall({
      ...BASE,
      agencyName: "Cedar <script>alert(1)</script> Hospice\n\u0000",
      subjectDisplayName: "D".repeat(500),
    });
    for (const forbidden of ["<", ">", "\u0000", "\n"]) {
      expect(out.short).not.toContain(forbidden);
    }
    expect(out.short.length).toBeLessThan(700);
  });

  it("keeps an ampersand in an agency name (the Twilio transport XML-escapes it)", () => {
    expect(
      sanitizeForEmergencyContactCall({ ...BASE, agencyName: "Smith & Sons Hospice" }).short,
    ).toContain("Smith & Sons Hospice");
  });

  it("falls back to generic wording when a name is empty after cleaning", () => {
    const out = sanitizeForEmergencyContactCall({
      ...BASE,
      agencyName: "<>",
      subjectDisplayName: "",
    });
    expect(out.short).toContain("your home health agency");
    expect(out.short).toContain("a member of the care team");
  });
});
