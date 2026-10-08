// GAP-010 — admit feeds the §2.3 matcher the candidate's primary address / phone / email, so the soft
// (>= 0.75) outcome is reachable and a same-name/DOB/address admit hard-blocks; and what admit cannot
// persist is refused loudly instead of discarded. GAP-009 — the bypass writes a CRITICAL audit event.
import type { DbClient } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import {
  assertAdmitDemographicsStorable,
  buildMatchCandidates,
  toE164,
} from "../src/modules/05-patient/admit-matching-db";
import { runMatch } from "../src/modules/05-patient/matching/matcher";
import { normalizeSubject } from "../src/modules/05-patient/matching/normalize";
import { createDbPatientRouteService } from "../src/modules/05-patient/patient-route-service-db";

const ADDRESS = { line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701" };

const existing = [{ id: "pat-0", lastName: "Doe", firstName: "Jane", dob: "1950-01-01", mbi: null }];

describe("GAP-010 — match candidates carry contact signals", () => {
  const incomingBase = { lastName: "Doe", firstName: "Jane", dob: "1950-01-01" };

  it("name+dob alone (the old candidate shape) can never reach soft_review", () => {
    const old = buildMatchCandidates(existing, [], [], []);
    const result = runMatch(normalizeSubject(incomingBase), old);
    expect(result.outcome).toBe("quiet_create");
  });

  it("same name, DOB and primary address hard-blocks (deterministic rule 3)", () => {
    const candidates = buildMatchCandidates(
      existing,
      [{ patientId: "pat-0", line1: "1 main st", city: "austin", postalCode: "78701" }],
      [],
      [],
    );
    const result = runMatch(
      normalizeSubject({ ...incomingBase, primaryAddress: ADDRESS }),
      candidates,
    );
    expect(result).toMatchObject({ outcome: "hard_block", existingPatientId: "pat-0" });
  });

  it("name + dob + phone + email scores 0.75 and opens a soft review", () => {
    const candidates = buildMatchCandidates(
      existing,
      [],
      [{ patientId: "pat-0", e164: "+15125551234" }],
      [{ patientId: "pat-0", email: "Jane@Example.com" }],
    );
    const result = runMatch(
      normalizeSubject({ ...incomingBase, phone: "(512) 555-1234", email: "jane@example.com" }),
      candidates,
    );
    expect(result.outcome).toBe("soft_review");
  });

  it("normalizes national numbers to E.164 and rejects junk", () => {
    expect(toE164("(512) 555-1234")).toBe("+15125551234");
    expect(toE164("1-512-555-1234")).toBe("+15125551234");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
    expect(toE164("12345")).toBeNull();
  });
});

describe("GAP-010 — admit refuses demographics it cannot keep", () => {
  const base = { lastName: "Doe", firstName: "Jane", dob: "1950-01-01", administrativeSex: "F" };

  it("refuses an SSN (no envelope-encrypted writer) with a 422", () => {
    expect(() => assertAdmitDemographicsStorable({ ...base, ssn: "123-45-6789" })).toThrow(
      /SSN capture/,
    );
  });
  it("refuses a primary address without a state", () => {
    expect(() =>
      assertAdmitDemographicsStorable({
        ...base,
        primaryAddress: { line1: "1 Main", city: "Austin", postalCode: "78701" },
      }),
    ).toThrow(/state/);
  });
  it("refuses an unusable phone, accepts a complete set", () => {
    expect(() => assertAdmitDemographicsStorable({ ...base, phone: "123" })).toThrow(/phone/);
    expect(() =>
      assertAdmitDemographicsStorable({
        ...base,
        primaryAddress: ADDRESS,
        phone: "512-555-1234",
        email: "a@b.co",
      }),
    ).not.toThrow();
  });
});

describe("GAP-009 — the bypass is audited CRITICAL on the write transaction", () => {
  it("inserts a critical patient.create_bypass_match audit_event carrying the justification", async () => {
    const inserted: unknown[] = [];
    const chain = (value: unknown): unknown =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === "then") return (resolve: (v: unknown) => void) => resolve(value);
            if (prop === "values") return (row: unknown) => (inserted.push(row), chain(value));
            return () => chain(value);
          },
        },
      );
    const tx = {
      execute: async () => undefined,
      select: () => chain([]),
      insert: () => chain([{ id: "00000000-0000-4000-8000-000000000001" }]),
      update: () => chain([]),
    };
    const db = { transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) };
    const service = createDbPatientRouteService(db as unknown as DbClient, {
      async publish() {},
    });
    await service.admit(
      "org-1",
      {
        lastName: "Doe",
        firstName: "Jane",
        dob: "1950-01-01",
        administrativeSex: "F",
        bypassMatchReview: true,
        bypassJustification: "Confirmed distinct twin with the registrar",
      },
      "user-1",
    );
    const auditRow = inserted.find(
      (r) => (r as { eventType?: string }).eventType === "patient.create_bypass_match",
    ) as { severity: string; context: Record<string, unknown> } | undefined;
    expect(auditRow?.severity).toBe("critical");
    expect(auditRow?.context).toMatchObject({
      byUserId: "user-1",
      justification: "Confirmed distinct twin with the registrar",
    });
  });
});
