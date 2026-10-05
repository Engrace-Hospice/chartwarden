// GAP-085 — the clinician lab observation list is caseload-scoped, filters + keyset cursor run before LIMIT.
import { describe, expect, it, vi } from "vitest";

import { decodeObservationCursor, resolveLabListScope } from "../routes/lab-list-scope";
import { createInMemoryM29Store } from "../routes/store";

const ORG = "org-1";
const O1 = "00000000-0000-4000-8000-000000000001";
const O2 = "00000000-0000-4000-8000-000000000002";
const O3 = "00000000-0000-4000-8000-000000000003";
const base = { organizationId: ORG, userId: "user-1" };

describe("resolveLabListScope (GAP-085)", () => {
  it("exempts org-wide roles without consulting the caseload", async () => {
    const caseloadPatientIds = vi.fn();
    const scope = await resolveLabListScope(
      { ...base, roles: ["medical_director"] },
      { caseloadPatientIds },
    );
    expect(scope).toEqual({});
    expect(caseloadPatientIds).not.toHaveBeenCalled();
  });

  it("scopes a clinician to the seam-resolved caseload", async () => {
    const caseloadPatientIds = vi.fn().mockResolvedValue(["p1", "p2"]);
    const scope = await resolveLabListScope(
      { ...base, roles: ["rn_case_manager"] },
      { caseloadPatientIds },
    );
    expect(scope).toEqual({ caseloadPatientIds: ["p1", "p2"] });
    expect(caseloadPatientIds).toHaveBeenCalledWith({ organizationId: ORG, userId: "user-1" });
  });

  it("fails closed to an empty caseload when the lookup throws", async () => {
    const caseloadPatientIds = vi.fn().mockRejectedValue(new Error("seam down"));
    const scope = await resolveLabListScope(
      { ...base, roles: ["rn_case_manager"] },
      { caseloadPatientIds },
    );
    expect(scope).toEqual({ caseloadPatientIds: [] });
  });
});

describe("listObservations scoping, filters and cursor (GAP-085)", () => {
  const seed = () => {
    const store = createInMemoryM29Store();
    const mk = (id: string, patientId: string, date: string, flag: "HH" | "N" = "N") =>
      store.seedObservation(ORG, {
        id,
        patientId,
        observationDate: date,
        values: [
          {
            obxSetId: 1,
            loincCode: "2345-7",
            loincDisplayText: "Glucose",
            valueType: "NM",
            numericValue: 1,
            stringValue: null,
            units: "mg/dL",
            referenceRange: null,
            abnormalFlag: flag,
          },
        ],
      });
    mk(O1, "pa", "2026-01-01T00:00:00.000Z");
    mk(O2, "pb", "2026-01-02T00:00:00.000Z", "HH");
    mk(O3, "pa", "2026-01-03T00:00:00.000Z", "HH");
    return store;
  };

  it("returns nothing for an empty caseload", async () => {
    expect((await seed().listObservations(ORG, { caseloadPatientIds: [] })).items).toEqual([]);
  });

  it("limits to the caseload patients", async () => {
    const page = await seed().listObservations(ORG, { caseloadPatientIds: ["pa"] });
    expect(page.items.map((i) => i.id)).toEqual([O3, O1]);
  });

  it("applies abnormalFlag", async () => {
    const page = await seed().listObservations(ORG, { abnormalFlag: "HH" });
    expect(page.items.map((i) => i.id)).toEqual([O3, O2]);
  });

  it("pages with a keyset cursor after filtering", async () => {
    const store = seed();
    const first = await store.listObservations(ORG, { abnormalFlag: "HH", limit: 1 });
    expect(first.items.map((i) => i.id)).toEqual([O3]);
    expect(first.nextCursor).toBeDefined();
    expect(decodeObservationCursor(first.nextCursor)).toMatchObject({ id: O3 });
    const second = await store.listObservations(ORG, {
      abnormalFlag: "HH",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map((i) => i.id)).toEqual([O2]);
    expect(second.nextCursor).toBeUndefined();
  });
});

describe("decodeObservationCursor (malformed input)", () => {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v), "utf8").toString("base64url");

  it("round-trips a well-formed cursor", () => {
    const c = { d: "2026-01-03T00:00:00.000Z", id: O3 };
    expect(decodeObservationCursor(enc(c))).toEqual(c);
  });

  it("treats a non-uuid id as the first page (no 500 from the uuid cast)", () => {
    expect(decodeObservationCursor(enc({ d: "2026-01-03T00:00:00.000Z", id: "not-a-uuid" }))).toBe(
      undefined,
    );
    expect(decodeObservationCursor(enc({ d: "2026-01-03T00:00:00.000Z", id: "' OR 1=1 --" }))).toBe(
      undefined,
    );
  });

  it("treats an unparseable date or non-JSON as the first page", () => {
    expect(decodeObservationCursor(enc({ d: "nope", id: O3 }))).toBe(undefined);
    expect(decodeObservationCursor("%%%")).toBe(undefined);
  });
});
