// apps/backend/__tests__/f238-prospect-summary.test.ts — F-238 prospect summary: the PURE builder
// (`prospect-summary.ts`) and the route through the full M1 middleware chain via Fastify `inject` behind the
// real Authorization Contract (no live infra). Proves: only approved / edited values appear (rejected and
// undecided omitted), an `other_patient` document and a re-sent duplicate contribute nothing, repeated values
// merge with every citation while differing ones are all shown, principal diagnoses lead, a replaced code drops
// the checks judged on the old one, Part 2 content is withheld (counted, never shown) unless the detection was
// rejected, and the plain text carries the same facts with "(Document p.N)" citations. The route needs
// `intake.review` and answers what the service returns.
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@wardenx/auth";
import { ChartWardenError } from "@wardenx/types";
import type { FastifyRequest } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import {
  type ProspectSummaryInput,
  type ProspectSummaryService,
  buildProspectSummary,
  formatCitations,
  registerDocLensProspectSummaryRoutes,
} from "../src/modules/22-documents/index";

type Fact = ProspectSummaryInput["facts"][number];
type Doc = ProspectSummaryInput["documents"][number];

let seq = 0;
function fact(over: Partial<Fact> & Pick<Fact, "fieldPath">): Fact {
  seq++;
  return {
    candidateId: `c${seq}`,
    extractionJobId: "job_dc",
    documentPageFrom: 1,
    page: 1,
    top: seq,
    sudDetected: false,
    decision: "approve",
    extractedValue: null,
    editedValue: null,
    editedCode: null,
    codingFlags: [],
    ...over,
  };
}

const DC: Doc = {
  pageFrom: 1,
  pageTo: 4,
  documentType: "discharge_summary",
  title: "St Mary Discharge Summary",
  date: "2026-09-28",
  duplicateOfPage: null,
  identityResolution: null,
};
const HP: Doc = {
  pageFrom: 5,
  pageTo: 6,
  documentType: "hp",
  title: null,
  date: null,
  duplicateOfPage: null,
  identityResolution: "same_patient",
};
const OTHER: Doc = {
  pageFrom: 7,
  pageTo: 7,
  documentType: "consult",
  title: "Consult — John Smith",
  date: "2026-09-01",
  duplicateOfPage: null,
  identityResolution: "other_patient",
};
const DUP: Doc = {
  pageFrom: 8,
  pageTo: 8,
  documentType: "discharge_summary",
  title: "St Mary Discharge Summary",
  date: null,
  duplicateOfPage: 1,
  identityResolution: null,
};
const AD: Doc = {
  pageFrom: 9,
  pageTo: 10,
  documentType: "advance_directive",
  title: "POLST",
  date: "2025-01-02",
  duplicateOfPage: null,
  identityResolution: null,
};

function input(
  facts: Fact[],
  over: Partial<ProspectSummaryInput["batch"]> = {},
  sudPages: number[] = [],
): ProspectSummaryInput {
  return {
    batch: {
      id: "b1",
      uploadedAt: "2026-10-04T10:00:00.000Z",
      sourceChannel: "fax",
      patientId: "p1",
      patientName: "Doe, Jane",
      referralId: null,
      sudStatus: "not_detected",
      ...over,
    },
    review: { id: "r1", completedAt: "2026-10-04T12:00:00.000Z" },
    documents: [DC, HP, OTHER, DUP, AD],
    sudPages,
    facts,
  };
}

describe("F-238 — prospect summary builder", () => {
  it("uses approved and edited values only; rejected and undecided are omitted", () => {
    const s = buildProspectSummary(
      input([
        fact({ fieldPath: "patient.legalFirstName", extractedValue: "Jane" }),
        fact({ fieldPath: "patient.legalLastName", extractedValue: "Doe" }),
        fact({
          fieldPath: "patient.dateOfBirth",
          decision: "approve_with_edit",
          extractedValue: "01/02/1904",
          editedValue: "01/02/1940",
        }),
        fact({ fieldPath: "patient.phoneHome", decision: "reject", extractedValue: "555-0100" }),
        fact({ fieldPath: "patient.email", decision: null, extractedValue: "x@example.test" }),
      ]),
    );
    expect(s.patient.map((f) => f.key)).toEqual(["legalName", "dateOfBirth"]);
    expect(s.patient[0]?.values[0]?.value).toBe("Jane Doe");
    expect(s.patient[1]?.values).toEqual([
      {
        value: "01/02/1940",
        edited: true,
        citations: [
          { document: "St Mary Discharge Summary", documentType: "discharge_summary", page: 1 },
        ],
      },
    ]);
    expect(s.plainText).not.toContain("555-0100");
    expect(s.plainText).not.toContain("x@example.test");
    expect(s.plainText).not.toContain("1904");
    expect(s.plainText).toContain(
      "- Date of birth: 01/02/1940 [corrected by reviewer] (St Mary Discharge Summary p.1)",
    );
  });

  it("excludes another patient's document and a re-sent duplicate, and hides the other patient's title", () => {
    const s = buildProspectSummary(
      input([
        fact({
          fieldPath: "medications[0].name",
          extractedValue: "Morphine 5 mg PO q4h PRN",
          page: 2,
        }),
        fact({
          fieldPath: "medications[0].name",
          extractedValue: "Warfarin 5 mg daily",
          extractionJobId: "job_other",
          documentPageFrom: 7,
          page: 7,
        }),
        fact({
          fieldPath: "medications[0].name",
          extractedValue: "Lisinopril 10 mg",
          extractionJobId: "job_dup",
          documentPageFrom: 8,
          page: 8,
        }),
      ]),
    );
    expect(s.medications.map((m) => m.text)).toEqual(["Morphine 5 mg PO q4h PRN"]);
    const other = s.documents.find((d) => d.pageFrom === 7);
    expect(other).toMatchObject({ status: "other_patient", title: null, date: null });
    expect(s.documents.find((d) => d.pageFrom === 8)?.status).toBe("duplicate");
    expect(s.plainText).not.toContain("John Smith");
    expect(s.plainText).not.toContain("Warfarin");
    expect(s.plainText).toContain("- p.7 Consult note — another patient's record; excluded");
    expect(s.plainText).toContain("- p.8 Discharge summary — re-sent copy of p.1; skipped");
  });

  it("merges a value repeated across documents with every citation, and shows differing values side by side", () => {
    const s = buildProspectSummary(
      input([
        fact({ fieldPath: "allergies[0].substance", extractedValue: "Penicillin - rash", page: 2 }),
        fact({
          fieldPath: "allergies[0].substance",
          extractedValue: "penicillin  - rash.",
          extractionJobId: "job_hp",
          documentPageFrom: 5,
          page: 5,
        }),
        fact({ fieldPath: "patient.dateOfBirth", extractedValue: "01/02/1940", page: 1 }),
        fact({
          fieldPath: "patient.dateOfBirth",
          extractedValue: "01/03/1940",
          extractionJobId: "job_hp",
          documentPageFrom: 5,
          page: 5,
        }),
      ]),
    );
    expect(s.allergies).toHaveLength(1);
    expect(s.allergies[0]?.citations.map((c) => [c.document, c.page])).toEqual([
      ["St Mary Discharge Summary", 2],
      ["History & physical", 5],
    ]);
    expect(s.plainText).toContain(
      "- Penicillin - rash (St Mary Discharge Summary p.2; History & physical p.5)",
    );
    const dob = s.patient.find((f) => f.key === "dateOfBirth");
    expect(dob?.values.map((v) => v.value)).toEqual(["01/02/1940", "01/03/1940"]);
    expect(s.plainText).toContain("- Date of birth: documents differ —");
  });

  it("composes the address from one document's parts", () => {
    const s = buildProspectSummary(
      input([
        fact({ fieldPath: "patient.address.line1", extractedValue: "12 Main St" }),
        fact({ fieldPath: "patient.address.city", extractedValue: "Springfield" }),
        fact({ fieldPath: "patient.address.state", extractedValue: "IL" }),
        fact({ fieldPath: "patient.address.postalCode", extractedValue: "62701" }),
      ]),
    );
    expect(s.patient.find((f) => f.key === "address")?.values[0]?.value).toBe(
      "12 Main St, Springfield, IL 62701",
    );
  });

  it("orders principal diagnoses first, merges repeats by code, and drops checks on a replaced code", () => {
    const s = buildProspectSummary(
      input([
        // Discharge summary: [0] hypertension (secondary), [1] CHF (principal, unspecified code flagged)
        fact({ fieldPath: "diagnoses[0].description", extractedValue: "Hypertension", page: 3 }),
        fact({ fieldPath: "diagnoses[0].icd10", extractedValue: "I10", page: 3 }),
        fact({ fieldPath: "diagnoses[0].role", extractedValue: "secondary", page: 3 }),
        fact({
          fieldPath: "diagnoses[1].description",
          extractedValue: "Congestive heart failure",
          page: 3,
        }),
        fact({
          fieldPath: "diagnoses[1].icd10",
          extractedValue: "I50.9",
          page: 3,
          codingFlags: [{ kind: "unspecified_code", code: "I50.9", detail: "Unspecified HF." }],
        }),
        fact({ fieldPath: "diagnoses[1].role", extractedValue: "principal", page: 3 }),
        // Discharge summary [2]: code edited by the reviewer — the old code's check no longer applies.
        fact({ fieldPath: "diagnoses[2].description", extractedValue: "COPD", page: 4 }),
        fact({
          fieldPath: "diagnoses[2].icd10",
          decision: "approve_with_edit",
          extractedValue: "J44",
          editedValue: "J44.9",
          editedCode: "J44.9",
          page: 4,
          codingFlags: [{ kind: "unknown_code", code: "J44", detail: "Category, not a code." }],
        }),
        // H&P repeats hypertension (history) — merged by code, keeps the stronger role.
        fact({
          fieldPath: "diagnoses[0].description",
          extractedValue: "HTN",
          extractionJobId: "job_hp",
          documentPageFrom: 5,
          page: 5,
        }),
        fact({
          fieldPath: "diagnoses[0].icd10",
          extractedValue: "i10",
          extractionJobId: "job_hp",
          documentPageFrom: 5,
          page: 5,
        }),
        // A rejected description sinks its diagnosis.
        fact({
          fieldPath: "diagnoses[3].description",
          decision: "reject",
          extractedValue: "Rule out sepsis",
          page: 4,
        }),
        fact({ fieldPath: "diagnoses[3].icd10", extractedValue: "A41.9", page: 4 }),
      ]),
    );
    expect(s.diagnoses.map((d) => [d.role, d.description, d.icd10Code])).toEqual([
      ["principal", "Congestive heart failure", "I50.9"],
      ["secondary", "Hypertension", "I10"],
      ["unspecified", "COPD", "J44.9"],
    ]);
    expect(s.diagnoses[0]?.codingFlags.map((f) => f.kind)).toEqual(["unspecified_code"]);
    expect(s.diagnoses[2]).toMatchObject({
      icd10Source: "reviewer_edit",
      edited: true,
      codingFlags: [],
    });
    expect(s.diagnoses[1]?.citations.map((c) => c.page)).toEqual([3, 5]);
    expect(s.plainText).not.toContain("sepsis");
    expect(s.plainText).toContain(
      "- [Principal] Congestive heart failure — ICD-10 I50.9 (St Mary Discharge Summary p.3)",
    );
    expect(s.plainText).toContain("    ! Unspecified code (I50.9): Unspecified HF.");
    expect(s.plainText.indexOf("[Principal]")).toBeLessThan(s.plainText.indexOf("[Secondary]"));
  });

  it("withholds 42 CFR Part 2 content (counted, never shown) unless the detection was rejected", () => {
    const facts = [
      fact({ fieldPath: "medications[0].name", extractedValue: "Buprenorphine 8 mg SL daily" }),
      fact({ fieldPath: "medications[1].name", extractedValue: "Metoprolol 25 mg BID", page: 2 }),
      fact({ fieldPath: "diagnoses[0].description", extractedValue: "Opioid use disorder" }),
      fact({ fieldPath: "diagnoses[0].icd10", extractedValue: "F11.20" }),
      fact({
        fieldPath: "allergies[0].substance",
        extractedValue: "Codeine",
        page: 3,
        sudDetected: true,
      }),
    ];
    const held = buildProspectSummary(input(facts, { sudStatus: "confirmed" }, [3]));
    expect(held.medications.map((m) => m.text)).toEqual(["Metoprolol 25 mg BID"]);
    expect(held.diagnoses).toEqual([]);
    expect(held.allergies).toEqual([]);
    expect(held.withheld.part2Values).toBe(4);
    // The document holding a flagged page shows its type, not its title.
    expect(held.documents[0]?.title).toBeNull();
    expect(held.plainText).not.toMatch(/Buprenorphine|Opioid|F11|Codeine|St Mary/);
    expect(held.plainText).toContain("4 approved values are not shown: 42 CFR Part 2");

    const cleared = buildProspectSummary(input(facts, { sudStatus: "rejected" }, [3]));
    expect(cleared.withheld.part2Values).toBe(0);
    expect(cleared.medications).toHaveLength(2);
    expect(cleared.diagnoses[0]?.icd10Code).toBe("F11.20");
    expect(cleared.allergies[0]?.text).toBe("Codeine");
  });

  it("lists advance-directive documents present and what DocLens does not capture", () => {
    const s = buildProspectSummary(input([]));
    expect(s.advanceDirectives.map((d) => d.title)).toEqual(["POLST"]);
    expect(s.plainText).toContain(
      '- Advance directive in packet, pp.9-10 — "POLST", dated 2025-01-02 (content not extracted; read the document)',
    );
    expect(s.plainText).toContain(
      "- No allergy lines were approved (this is not 'no known allergies').",
    );
    expect(s.plainText).toContain("NOT CAPTURED BY WARDENLENS");
    expect(s.notCaptured.length).toBeGreaterThan(0);
  });

  it("is deterministic and formats grouped citations", () => {
    const facts = [fact({ fieldPath: "medications[0].name", extractedValue: "Senna 8.6 mg HS" })];
    expect(buildProspectSummary(input(facts)).plainText).toBe(
      buildProspectSummary(input(facts)).plainText,
    );
    expect(
      formatCitations([
        { document: "A", documentType: "hp", page: 3 },
        { document: "A", documentType: "hp", page: 1 },
        { document: "B", documentType: "lab", page: 9 },
      ]),
    ).toBe("(A pp.1, 3; B p.9)");
  });
});

// ── the route ────────────────────────────────────────────────────────────────────────────────────────────

const ORG = "org_a";
const BATCH = "11111111-1111-4111-8111-111111111111";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  request.context.organizationId = ORG;
  request.context.roles = ["intake_coordinator"];
  request.context.attributes.membershipId = `${user}_membership`;
}

const PATIENT = "22222222-2222-4222-8222-222222222222";
const OTHER_PATIENT = "33333333-3333-4333-8333-333333333333";

describe("F-238 — GET /api/v1/intake/uploads/:id/summary + GET /api/v1/patients/:patientId/intake-summaries", () => {
  const calls: unknown[][] = [];
  let complete = true;
  const service: ProspectSummaryService = {
    async getSummary(...args) {
      calls.push(args);
      if (!complete) {
        throw new ChartWardenError("REVIEW_NOT_COMPLETE", "not complete", 409);
      }
      return buildProspectSummary(input([]));
    },
    async listForPatient(...args) {
      calls.push(["list", ...args]);
      return { items: [buildProspectSummary(input([]))] };
    },
  };

  function makeServer() {
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG,
          userId: "reviewer",
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["intake.read", "intake.review"],
            },
          ],
        },
        {
          orgId: ORG,
          userId: "reader",
          grants: [
            { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["intake.read"] },
          ],
        },
        {
          orgId: ORG,
          userId: "clinician",
          grants: [
            { roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: ["patient.read"] },
          ],
        },
      ]).store,
    );
    // The chart scope: the clinician's caseload is PATIENT only.
    const registry = createPredicateRegistry();
    registry.register(
      "caseload_or_scope",
      async (_ctx: unknown, target: Record<string, unknown>) => target.patientId === PATIENT,
    );
    registerAbacRegistry(registry);
    const app = buildServer({ authenticate: headerAuth, security: { rateLimitEnabled: false } });
    registerDocLensProspectSummaryRoutes(app, service);
    return app;
  }

  beforeEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
    calls.length = 0;
    complete = true;
  });

  it("returns the summary to an intake.review holder, scoped to the session's org", async () => {
    const app = makeServer();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/intake/uploads/${BATCH}/summary`,
      headers: { "x-test-user": "reviewer" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ batchId: "b1", reviewId: "r1" });
    expect(typeof res.json().plainText).toBe("string");
    expect(calls).toEqual([[ORG, BATCH]]);
  });

  it("refuses intake.read alone and the unauthenticated, before the service runs", async () => {
    const app = makeServer();
    const reader = await app.inject({
      method: "GET",
      url: `/api/v1/intake/uploads/${BATCH}/summary`,
      headers: { "x-test-user": "reader" },
    });
    expect(reader.statusCode).toBe(403);
    const anon = await app.inject({
      method: "GET",
      url: `/api/v1/intake/uploads/${BATCH}/summary`,
    });
    expect(anon.statusCode).toBe(401);
    expect(calls).toEqual([]);
  });

  it("answers 409 REVIEW_NOT_COMPLETE before completion, and 422 on a malformed id", async () => {
    const app = makeServer();
    complete = false;
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/intake/uploads/${BATCH}/summary`,
      headers: { "x-test-user": "reviewer" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("REVIEW_NOT_COMPLETE");
    const bad = await app.inject({
      method: "GET",
      url: "/api/v1/intake/uploads/not-a-uuid/summary",
      headers: { "x-test-user": "reviewer" },
    });
    expect(bad.statusCode).toBe(422);
  });

  it("the patient chart read: patient.read + caseload, 404 outside the caseload, never intake permissions", async () => {
    const app = makeServer();
    const ok = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/intake-summaries`,
      headers: { "x-test-user": "clinician" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().items).toHaveLength(1);
    expect(calls).toEqual([["list", ORG, PATIENT]]);
    const outside = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${OTHER_PATIENT}/intake-summaries`,
      headers: { "x-test-user": "clinician" },
    });
    expect(outside.statusCode).toBe(404);
    const reviewerOnly = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${PATIENT}/intake-summaries`,
      headers: { "x-test-user": "reviewer" },
    });
    expect(reviewerOnly.statusCode).toBe(403);
    expect(calls).toHaveLength(1);
  });
});
