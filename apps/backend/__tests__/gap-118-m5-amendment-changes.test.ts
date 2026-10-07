// GAP-118 — an amendment request stores a structured change and an ACCEPTED demographic amendment applies it.
import type { DbClient } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import {
  AMENDABLE_DEMOGRAPHIC_FIELDS,
  changeToApply,
  normalizeRequestedChange,
} from "../src/modules/05-patient/amendments";
import type { M5OutboxPort } from "../src/modules/05-patient/deceased-db";
import { createDbPatientRouteService } from "../src/modules/05-patient/patient-route-service-db";

const TODAY = "2026-10-06";
const ORG = "org-1";
const PATIENT = "pat-1";
const USER = "user-1";

describe("normalizeRequestedChange", () => {
  it("a demographic request must name an allowlisted field", () => {
    expect(() => normalizeRequestedChange("demographic", undefined, TODAY)).toThrow();
    expect(() =>
      normalizeRequestedChange(
        "demographic",
        { fieldPath: "organization_id", requestedValue: "x" },
        TODAY,
      ),
    ).toThrow(/not an amendable/);
    expect(Object.keys(AMENDABLE_DEMOGRAPHIC_FIELDS)).not.toContain("mrn");
  });

  it("validates dates and refuses to clear a required field", () => {
    expect(() =>
      normalizeRequestedChange(
        "demographic",
        { fieldPath: "dob", requestedValue: "03/02/1948" },
        TODAY,
      ),
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      normalizeRequestedChange(
        "demographic",
        { fieldPath: "dob", requestedValue: "2999-01-01" },
        TODAY,
      ),
    ).toThrow(/future/);
    expect(() =>
      normalizeRequestedChange(
        "demographic",
        { fieldPath: "legalLastName", requestedValue: " " },
        TODAY,
      ),
    ).toThrow(/cannot be cleared/);
    expect(
      normalizeRequestedChange(
        "demographic",
        { fieldPath: "legalMiddleName", requestedValue: "" },
        TODAY,
      ),
    ).toEqual({ fieldPath: "legalMiddleName", requestedValue: null });
  });

  it("clinical/narrative need no structured change", () => {
    expect(normalizeRequestedChange("clinical", undefined, TODAY)).toBeNull();
  });
});

describe("changeToApply", () => {
  it("applies only demographic, allowlisted, non-clearing-of-required changes", () => {
    expect(
      changeToApply("demographic", {
        fieldPath: "dob",
        currentValue: "1948-03-02",
        requestedValue: "1948-03-03",
      }),
    ).toEqual({ column: "dob", value: "1948-03-03" });
    expect(changeToApply("clinical", { fieldPath: "dob", requestedValue: "x" })).toBeNull();
    expect(changeToApply("demographic", { fieldPath: "mrn", requestedValue: "x" })).toBeNull();
    expect(changeToApply("demographic", {})).toBeNull();
    expect(changeToApply("demographic", { fieldPath: "dob", requestedValue: null })).toBeNull();
  });
});

// A scripted fake Drizzle tx: results in await order; `set(...)`/`values(...)` arguments are recorded.
function harness(results: unknown[]) {
  const queue = [...results];
  const sets: unknown[] = [];
  const values: unknown[] = [];
  const published: string[] = [];
  const chain = (): unknown => {
    const node: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve(queue.shift());
          if (prop === "set") {
            return (v: unknown) => {
              sets.push(v);
              return node;
            };
          }
          if (prop === "values") {
            return (v: unknown) => {
              values.push(v);
              return node;
            };
          }
          return () => node;
        },
      },
    );
    return node;
  };
  const tx = {
    execute: async () => undefined,
    select: () => chain(),
    insert: () => chain(),
    update: () => chain(),
  };
  const db = { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
  const outbox: M5OutboxPort = {
    async publish(_t, e) {
      published.push(e.eventName);
    },
  };
  return {
    service: createDbPatientRouteService(db as unknown as DbClient, outbox),
    sets,
    values,
    published,
  };
}

describe("submitAmendment stores the structured change", () => {
  it("captures the current value of the field being amended", async () => {
    const h = harness([
      [{ id: PATIENT }], // assertPatientVisible
      [{ current: "1948-03-02" }], // current value of dob
      [{ id: "amd-1", slaDueAt: new Date("2026-12-05T00:00:00Z") }], // insert returning
    ]);
    await h.service.submitAmendment(
      ORG,
      PATIENT,
      {
        scope: "demographic",
        rationale: "Wrong date of birth on the chart",
        requestedChange: { fieldPath: "dob", requestedValue: "1948-03-03" },
      },
      USER,
    );
    expect(h.values[0]).toMatchObject({
      scope: "demographic",
      requestedChanges: {
        fieldPath: "dob",
        currentValue: "1948-03-02",
        requestedValue: "1948-03-03",
      },
    });
  });
});

describe("decideAmendment applies an accepted demographic change", () => {
  const row = (scope: string, requestedChanges: unknown) => ({
    patientId: PATIENT,
    status: "pending",
    scope,
    requestedChanges,
    slaDueAt: new Date("2026-12-01T00:00:00Z"),
  });

  it("accept updates the patient column in the same transaction as the decision", async () => {
    const h = harness([
      [
        row("demographic", {
          fieldPath: "dob",
          currentValue: "1948-03-02",
          requestedValue: "1948-03-03",
        }),
      ],
      [{ id: "amd-1" }], // guarded decision UPDATE returning
      undefined, // patient UPDATE
    ]);
    await h.service.decideAmendment(ORG, "amd-1", { accept: true }, USER);
    expect(h.sets).toHaveLength(2);
    expect(h.sets[1]).toEqual({ dob: "1948-03-03" });
    expect(h.published).toContain("m5.patient.amendment_decided");
  });

  it("deny applies nothing", async () => {
    const h = harness([
      [row("demographic", { fieldPath: "dob", requestedValue: "1948-03-03" })],
      [{ id: "amd-1" }],
    ]);
    await h.service.decideAmendment(
      ORG,
      "amd-1",
      { accept: false, denialReason: "no basis" },
      USER,
    );
    expect(h.sets).toHaveLength(1);
  });

  it("accepting a clinical amendment records it without rewriting anything", async () => {
    const h = harness([[row("clinical", {})], [{ id: "amd-1" }]]);
    await h.service.decideAmendment(ORG, "amd-1", { accept: true }, USER);
    expect(h.sets).toHaveLength(1);
  });
});
