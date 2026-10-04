// apps/backend/__tests__/f235-doclens-writeback.test.ts — F-235 (#248), no DB: the two PURE halves of the
// DocLens → M5 demographics writeback. M22's commit planner (where decisions A1 + B are enforced on the
// sending side) and M5's receipt planner (the allowlist re-check + value normalization). The live chain is
// `f235-doclens-m5-writeback.live.test.ts`.
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizePhoneE164,
  planExtractionWriteback,
} from "../src/modules/05-patient/outbox-consumers/m22-extraction-writeback";
import { createCandidateValueCipher } from "../src/modules/22-documents/extraction/candidate-value-cipher";
import {
  type WritebackCandidateFact,
  planDocLensWriteback,
} from "../src/modules/22-documents/extraction/writeback-plan";

const PATIENT = "44444444-4444-4444-4444-444444444444";
let n = 0;
function fact(over: Partial<WritebackCandidateFact>): WritebackCandidateFact {
  n += 1;
  return {
    candidateId: `cand-${n}`,
    decisionId: `dec-${n}`,
    fieldPath: "patient.phoneHome",
    riskLevel: "low",
    sudDetected: false,
    extractedValue: "(503) 555-0100",
    decision: "approve",
    editedValue: null,
    sourceDocumentId: "doc-1",
    ...over,
  };
}

describe("F-235 — M22 commit planner (A1 + B on the sending side)", () => {
  it("commits an approved, allowlisted, low-risk, non-SUD field onto the batch patient", () => {
    const plan = planDocLensWriteback({ batchPatientId: PATIENT, facts: [fact({})] });
    expect(plan.targetPatientId).toBe(PATIENT);
    expect(plan.fields).toEqual([{ fieldPath: "patient.phoneHome", value: "(503) 555-0100" }]);
    expect(plan.excluded).toEqual([]);
  });

  it("A1 — a medication field is never a writeback target, even approved and low-risk", () => {
    const plan = planDocLensWriteback({
      batchPatientId: PATIENT,
      facts: [fact({ fieldPath: "medications[0].name", extractedValue: "Morphine" })],
    });
    expect(plan.committed).toEqual([]);
    expect(plan.targetPatientId).toBeNull();
    expect(plan.excluded).toMatchObject([{ reason: "not_a_writeback_target" }]);
  });

  it("B — identity fields (legal name, DOB, sex) and identifiers are not on the allowlist", () => {
    const plan = planDocLensWriteback({
      batchPatientId: PATIENT,
      facts: [
        fact({ fieldPath: "patient.legalLastName", extractedValue: "SMITH" }),
        fact({ fieldPath: "patient.dateOfBirth", extractedValue: "1940-01-01" }),
        fact({ fieldPath: "patient.mbi", extractedValue: "1EG4-TE5-MK73" }),
      ],
    });
    expect(plan.committed).toEqual([]);
    expect(plan.excluded.map((e) => e.reason)).toEqual([
      "not_a_writeback_target",
      "not_a_writeback_target",
      "not_a_writeback_target",
    ]);
  });

  it("B — no resolved patient means no writeback (never a headless create)", () => {
    const plan = planDocLensWriteback({ batchPatientId: null, facts: [fact({})] });
    expect(plan.committed).toEqual([]);
    expect(plan.excluded).toMatchObject([{ reason: "patient_unresolved" }]);
  });

  it("excludes a mis-tiered (non-low) candidate and a SUD-flagged one", () => {
    const plan = planDocLensWriteback({
      batchPatientId: PATIENT,
      facts: [fact({ riskLevel: "high" }), fact({ fieldPath: "patient.email", sudDetected: true })],
    });
    expect(plan.excluded.map((e) => e.reason)).toEqual(["risk_not_low", "sud_detected"]);
  });

  it("rejected decisions produce nothing and are not reported as exclusions", () => {
    const plan = planDocLensWriteback({
      batchPatientId: PATIENT,
      facts: [fact({ decision: "reject" })],
    });
    expect(plan.committed).toEqual([]);
    expect(plan.excluded).toEqual([]);
  });

  it("approve_with_edit commits the stored edit, and refuses when the edit is missing", () => {
    const ok = planDocLensWriteback({
      batchPatientId: PATIENT,
      facts: [fact({ decision: "approve_with_edit", editedValue: " 503-555-0199 " })],
    });
    expect(ok.fields).toEqual([{ fieldPath: "patient.phoneHome", value: "503-555-0199" }]);
    const missing = planDocLensWriteback({
      batchPatientId: PATIENT,
      facts: [fact({ decision: "approve_with_edit", editedValue: null })],
    });
    expect(missing.excluded).toMatchObject([{ reason: "edited_value_missing" }]);
  });

  it("two approved candidates disagreeing on one field commit neither; agreeing ones dedupe", () => {
    const conflict = planDocLensWriteback({
      batchPatientId: PATIENT,
      facts: [fact({ extractedValue: "503-555-0100" }), fact({ extractedValue: "503-555-0101" })],
    });
    expect(conflict.committed).toEqual([]);
    expect(conflict.excluded.map((e) => e.reason)).toEqual([
      "conflicting_values",
      "conflicting_values",
    ]);
    const agree = planDocLensWriteback({
      batchPatientId: PATIENT,
      facts: [fact({ extractedValue: "503-555-0100" }), fact({ extractedValue: "503-555-0100" })],
    });
    expect(agree.committed).toHaveLength(2); // two decisions → two provenance rows
    expect(agree.fields).toHaveLength(1); // one value on the wire
  });
});

describe("F-235 — M5 receipt planner (allowlist re-check + normalization)", () => {
  it("normalizes NANP and explicit E.164 phones, refuses anything else", () => {
    expect(normalizePhoneE164("(503) 555-0100")).toBe("+15035550100");
    expect(normalizePhoneE164("1-503-555-0100")).toBe("+15035550100");
    expect(normalizePhoneE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhoneE164("555-0100")).toBeNull();
    expect(normalizePhoneE164("call daughter")).toBeNull();
  });

  it("re-checks the allowlist on receipt (defense in depth against a non-M22 producer)", () => {
    const plan = planExtractionWriteback([
      { fieldPath: "medications[0].name", value: "Morphine" },
      { fieldPath: "patient.dateOfBirth", value: "1940-01-01" },
    ]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["not_allowlisted", "not_allowlisted"]);
    expect(plan.phones).toEqual([]);
  });

  it("builds a complete address, uppercasing state and formatting ZIP+4", () => {
    const plan = planExtractionWriteback([
      { fieldPath: "patient.address.line1", value: " 12  Oak  St " },
      { fieldPath: "patient.address.city", value: "Salem" },
      { fieldPath: "patient.address.state", value: "or" },
      { fieldPath: "patient.address.postalCode", value: "973011234" },
    ]);
    expect(plan.address?.value).toEqual({
      line1: "12 Oak St",
      line2: null,
      city: "Salem",
      state: "OR",
      postalCode: "97301-1234",
    });
    expect(plan.skipped).toEqual([]);
  });

  it("skips every address part when the core is incomplete — never a half-row", () => {
    const plan = planExtractionWriteback([
      { fieldPath: "patient.address.line1", value: "12 Oak St" },
      { fieldPath: "patient.address.city", value: "Salem" },
    ]);
    expect(plan.address).toBeUndefined();
    expect(plan.skipped).toEqual([
      { fieldPath: "patient.address.line1", outcome: "skipped", reason: "address_incomplete" },
      { fieldPath: "patient.address.city", outcome: "skipped", reason: "address_incomplete" },
    ]);
  });

  it("skips an unparseable phone or email but keeps the rest of the commit", () => {
    const plan = planExtractionWriteback([
      { fieldPath: "patient.phoneMobile", value: "ext 12" },
      { fieldPath: "patient.email", value: "not-an-email" },
      { fieldPath: "patient.preferredName", value: "  Bud  " },
    ]);
    expect(plan.preferredName).toEqual({ fieldPath: "patient.preferredName", value: "Bud" });
    expect(plan.skipped.map((s) => s.reason)).toEqual(["phone_not_normalizable", "email_invalid"]);
  });
});

describe("F-235 — extraction_candidate value cipher", () => {
  const keys = new Map([
    ["k1", randomBytes(32)],
    ["k2", randomBytes(32)],
  ]);
  let active = "k1";
  const provider = {
    async dekForOrg() {
      return { version: active, key: keys.get(active) as Buffer };
    },
    async dekForOrgVersion(_org: string, version: string) {
      const key = keys.get(version);
      if (!key) throw new Error("unknown version");
      return { version, key };
    },
  };
  const cipher = createCandidateValueCipher(provider);

  it("round-trips, survives a key rotation, and refuses another tenant's ciphertext", async () => {
    const env = await cipher.encrypt("org-a", "503-555-0100");
    expect(env).not.toContain("503");
    active = "k2";
    expect(await cipher.decrypt("org-a", env)).toBe("503-555-0100");
    await expect(cipher.decrypt("org-b", env)).rejects.toThrow();
  });
});
