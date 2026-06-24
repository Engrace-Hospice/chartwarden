// apps/backend/__tests__/consent-seams.test.ts — M39-T05 published seam + M39-T06 consumed seams.
//
// Proves: (1) M39's `ConsentEvaluator` registers over the M1 deny-stub and the boot passes
// validateSeams(); (2) M39 CONSUMES M5's REAL `PatientReader` through the registry (identity
// resolution, §4.4); (3) M22's `DocumentRenderer` is NOW REAL (M22-T04 registered the W2 render handshake
// over the boot deny-stub) so the D15 signed-PDF path materializes a `consent_record` document — and there
// is still no 22→39 import edge (the type is the leaf one, the impl is resolved at call time).
import { beforeEach, describe, expect, it } from "vitest";
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

  it("consumes M22's REAL DocumentRenderer — the D15 consent_record render path materializes a document", async () => {
    wireModuleSeams(); // registers M22's real renderer (M22-T04) over the boot deny-stub
    validateSeams();
    expect(() => getConsentDocumentRenderer()).not.toThrow();
    // The W2 handshake resolves the `consent_record` template and returns the new documentId. The
    // consent record id is the render aggregate id (§7.2 step 6); the impl never imports M22's schema.
    const { documentId } = await renderConsentRecordDocument(
      { orgId: ORG },
      {
        aggregateId: "c1",
        consentRecordId: "c1",
        patientId: "p1",
        typeKey: "hipaa_release",
        grantorKind: "patient_self",
        effectiveAt: new Date().toISOString(),
        recipients: [],
      },
    );
    expect(documentId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
