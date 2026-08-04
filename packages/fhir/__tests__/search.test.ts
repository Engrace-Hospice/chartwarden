// Module 28 — §4.5 D6 FhirSearchTranslator + `?patient=:id` search (M28-T04, W-FHIR-14).
//
// The translator is the single point that knows the FHIR search grammar; it translates into typed
// reader-seam calls (no SQL in M28). These lock: validate() against the US Core parameter catalog
// (unsupported-parameter → not-supported; missing patient anchor → required), and the wired
// DiagnosticReport?patient path resolving to OrderProvider.searchOrdersByPatient + per-order projection
// with cursor pagination (W-FHIR-14).

import { describe, expect, it } from "vitest";

import {
  type DiagnosticReportProjectorDeps,
  type FhirSearchRequest,
  type LabObservationRow,
  type LabOrderRow,
  type SearchContext,
  applySudRedactionToDiagnosticReport,
  createFhirSearchTranslator,
  decodeCursor,
  normalizeCount,
  parseReferenceId,
} from "../src";

const ctx: SearchContext = {
  organizationId: "org-1",
  recipientClientId: "client-1",
  allowedScopes: ["system/DiagnosticReport.read"],
  tenantFhirHost: "engrace.fhir.wardenx.com",
  identifierUriBase: "https://engrace.fhir.wardenx.com",
  redactSudContent: false,
};

function makeOrder(id: string): LabOrderRow {
  return {
    id,
    kind: "lab",
    patientId: "pat-1",
    lastLabObservationAttachedId: `obs-${id}`,
    orderingPhysicianMdmId: null,
    labDestinationFacilityId: null,
    signedAt: "2026-07-01T10:00:00Z",
    data: { observationIdentifier: { code: "58410-2", text: "CBC" } },
  };
}

const obs: LabObservationRow = {
  id: "obs-x",
  attachedAt: "2026-07-02T08:00:00Z",
  values: [
    {
      loincCode: "6690-2",
      loincText: "WBC",
      numericValue: 7.2,
      unit: "10*3/uL",
      stringValue: null,
      criticalFlag: null,
      abnormalFlag: null,
      referenceRange: null,
      sudRedactionStatus: "not_applicable",
    },
  ],
};

function depsFor(orders: LabOrderRow[]): DiagnosticReportProjectorDeps {
  const byId = new Map(orders.map((o) => [o.id, o]));
  return {
    orderProvider: {
      async findOrder(_org, id) {
        return byId.get(id) ?? null;
      },
      async searchOrdersByPatient(_org, _patientId, o) {
        const start = o.afterId ? orders.findIndex((x) => x.id === o.afterId) + 1 : 0;
        return orders.slice(start, start + o.limit);
      },
    },
    labObservationReader: {
      async loadById() {
        return { ...obs };
      },
    },
    patientReader: {
      async findById() {
        return {
          id: "pat-1",
          mrn: null,
          firstName: "A",
          lastName: "B",
          middleName: null,
          gender: "unknown",
          birthDate: null,
          deceasedDateTime: null,
          phone: null,
          email: null,
          addressLines: null,
          city: null,
          state: null,
          postalCode: null,
        };
      },
    },
    externalPhysicianReader: {
      async findById() {
        return null;
      },
    },
    facilityReader: {
      async findById() {
        return null;
      },
    },
    sudRedactionApplier: applySudRedactionToDiagnosticReport,
  };
}

function req(overrides: Partial<FhirSearchRequest>): FhirSearchRequest {
  return {
    resourceType: "DiagnosticReport",
    parameters: [],
    includes: [],
    revincludes: [],
    count: 10,
    ...overrides,
  };
}

describe("FhirSearchTranslator.validate", () => {
  const t = createFhirSearchTranslator({ diagnosticReport: depsFor([]) });

  it("rejects an unknown resource type as not-supported", () => {
    const v = t.validate(req({ resourceType: "Flavor" }));
    expect(v.valid).toBe(false);
    expect(v.issues[0].code).toBe("not-supported");
  });

  it("rejects an unsupported search parameter", () => {
    const v = t.validate(
      req({
        parameters: [
          { name: "patient", value: "pat-1" },
          { name: "ethnicity", value: "x" },
        ],
      }),
    );
    expect(v.valid).toBe(false);
    expect(
      v.issues.some(
        (i) => i.code === "not-supported" && i.expression === "DiagnosticReport.ethnicity",
      ),
    ).toBe(true);
  });

  it("requires a patient anchor for a compartment resource", () => {
    const v = t.validate(req({ parameters: [{ name: "category", value: "LAB" }] }));
    expect(v.valid).toBe(false);
    expect(v.issues.some((i) => i.code === "required")).toBe(true);
  });

  it("accepts a valid DiagnosticReport?patient search", () => {
    const v = t.validate(
      req({
        parameters: [
          { name: "patient", value: "Patient/pat-1" },
          { name: "category", value: "LAB" },
        ],
      }),
    );
    expect(v.valid).toBe(true);
  });
});

describe("FhirSearchTranslator.resolve — DiagnosticReport?patient (W-FHIR-14)", () => {
  it("returns one Bundle entry per lab order for the patient", async () => {
    const t = createFhirSearchTranslator({
      diagnosticReport: depsFor([makeOrder("o1"), makeOrder("o2"), makeOrder("o3")]),
    });
    const resolved = t.resolve(
      req({ count: 10, parameters: [{ name: "patient", value: "Patient/pat-1" }] }),
      ctx,
    );
    const out = await resolved.execute();
    expect(out.rows).toHaveLength(3);
    expect((out.rows[0] as { resourceType: string }).resourceType).toBe("DiagnosticReport");
    expect(out.nextCursor).toBeNull(); // fewer than count ⇒ no next page
  });

  it("emits a next cursor when the page is full, and resumes from it", async () => {
    const orders = [makeOrder("o1"), makeOrder("o2"), makeOrder("o3")];
    const t = createFhirSearchTranslator({ diagnosticReport: depsFor(orders) });

    const page1 = await t
      .resolve(req({ count: 2, parameters: [{ name: "patient", value: "pat-1" }] }), ctx)
      .execute();
    expect(page1.rows).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    expect(decodeCursor(page1.nextCursor!)?.lastId).toBe("o2");

    const page2 = await t
      .resolve(
        req({
          count: 2,
          cursor: page1.nextCursor!,
          parameters: [{ name: "patient", value: "pat-1" }],
        }),
        ctx,
      )
      .execute();
    expect(page2.rows).toHaveLength(1);
    expect((page2.rows[0] as { id: string }).id).toBe("o3");
    expect(page2.nextCursor).toBeNull();
  });

  it("rejects execution for a grammar-known but unwired resource", async () => {
    const t = createFhirSearchTranslator({ diagnosticReport: depsFor([]) });
    const resolved = t.resolve(
      req({ resourceType: "Observation", parameters: [{ name: "patient", value: "pat-1" }] }),
      ctx,
    );
    await expect(resolved.execute()).rejects.toThrow(/not yet wired/);
  });
});

describe("search helpers", () => {
  it("normalizeCount clamps to [1,500] and defaults", () => {
    expect(normalizeCount(undefined)).toBe(50);
    expect(normalizeCount(0)).toBe(1);
    expect(normalizeCount(9999)).toBe(500);
    expect(normalizeCount(42)).toBe(42);
  });

  it("parseReferenceId accepts typed and bare references", () => {
    expect(parseReferenceId("Patient/pat-1")).toBe("pat-1");
    expect(parseReferenceId("pat-1")).toBe("pat-1");
  });

  it("decodeCursor rejects a malformed token", () => {
    expect(decodeCursor("!!!not-base64-json!!!")).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });
});
