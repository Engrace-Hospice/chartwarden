// apps/backend/__tests__/consent-seams.test.ts — M39-T05 published seam + M39-T06 consumed seams.
//
// Proves: (1) M39's `ConsentEvaluator` registers over the M1 deny-stub and the boot passes
// validateSeams(); (2) M39 CONSUMES M5's REAL `PatientReader` through the registry (identity
// resolution, §4.4); (3) M22's `DocumentRenderer` stays a fail-closed FORWARD-SEAM deny-stub (M22 is
// Wave F) so the D15 signed-PDF path throws LOUDLY rather than dropping the artifact — and there is no
// 22→39 import edge (the type is the leaf one, the impl is resolved at call time).
import { beforeEach, describe, expect, it } from "vitest";
import { NotImplementedError } from "../src/bootstrap/seams/providers";
import { __resetSeamsForTest, validateSeams } from "../src/bootstrap/seams/registry";
import { wireModuleSeams } from "../src/index";
import {
  getConsentDocumentRenderer,
  getConsentEvaluator,
  getConsentPatientReader,
  renderConsentRecordDocument,
  resolvePatientForConsent,
} from "../src/modules/39-consent/index";

const ORG = "org-1";

describe("M39 seams — published ConsentEvaluator + consumed PatientReader/DocumentRenderer (§4.3/§4.4)", () => {
  beforeEach(() => {
    __resetSeamsForTest();
  });

  it("registers the real ConsentEvaluator over the deny-stub and boots clean", () => {
    wireModuleSeams();
    expect(() => validateSeams()).not.toThrow();
    const evaluator = getConsentEvaluator();
    expect(typeof evaluator.evaluate).toBe("function");
    expect(typeof evaluator.evaluateForDisclosure).toBe("function");
  });

  it("the registered evaluator denies with no consent on file (slice store, fail-closed)", async () => {
    wireModuleSeams();
    const r = await getConsentEvaluator().evaluate({
      organizationId: ORG,
      patientId: "p1",
      consentType: "hipaa_release",
      sessionContext: { sessionClass: "staff" },
      callerModule: "m5",
    });
    expect(r.allowed).toBe(false);
    expect(r.denyReason).toBe("no_active_consent_on_file");
  });

  it("consumes M5's REAL PatientReader for identity resolution (§4.4)", async () => {
    wireModuleSeams();
    const reader = getConsentPatientReader();
    // The real M5 reader resolves a miss to null (no patient seeded) rather than throwing — proving it
    // is the real impl, not the throwing deny-stub.
    const found = await resolvePatientForConsent(reader, {
      organizationId: ORG,
      patientId: "missing",
    });
    expect(found).toBeNull();
  });

  it("M22 DocumentRenderer stays a fail-closed forward-seam deny-stub (D15 path throws)", async () => {
    wireModuleSeams();
    validateSeams(); // applies the DocumentRenderer deny-stub (M22 unbuilt)
    expect(() => getConsentDocumentRenderer()).not.toThrow();
    await expect(
      renderConsentRecordDocument(
        { orgId: ORG },
        {
          consentRecordId: "c1",
          patientId: "p1",
          typeKey: "hipaa_release",
          grantorKind: "patient_self",
          effectiveAt: new Date().toISOString(),
          recipients: [],
        },
      ),
    ).rejects.toThrow(NotImplementedError);
  });
});
