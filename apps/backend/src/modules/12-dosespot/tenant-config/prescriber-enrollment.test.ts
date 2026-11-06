import type { DbClient } from "@chartwarden/db";
// Slice 4 — a prescriber's DoseSpot (vendor) enrolment: create-then-record. The roster row and the committed
// `vendor_enrollment_requested_at` come first, the vendor call runs with NO transaction open, and only the vendor's id is
// recorded as the link `transmit-newrx` sends under. Pure: a fake roster store, a fake vendor client, recording ports.
import { DegradedError, type DoseSpotClient } from "@chartwarden/dosespot";
import { describe, expect, it } from "vitest";
import {
  type RosterRow,
  type RosterStore,
  createPrescriberEnrollmentService,
  isValidNpi,
} from "./prescriber-enrollment";

const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const ACTOR = {
  organizationId: ORG,
  userId: "u-1",
  membershipId: "44444444-4444-4444-8444-444444444444",
};
const NPI = "1234567893"; // passes the NPI check digit
const BODY = { npi: NPI, firstName: "Ada", lastName: "Lovelace" };

const clock = { at: new Date("2026-11-06T12:00:00.000Z") };

function build(
  opts: {
    status?: string | null;
    membershipInOrg?: boolean;
    row?: Partial<RosterRow> | null;
    vendor?: (
      n: number,
    ) => Promise<{ dosespotPrescriberId: string; epcsEnrollmentStarted: boolean }>;
  } = {},
) {
  const log: string[] = [];
  let txDepth = 0;
  let calledInsideTx = false;
  let roster: RosterRow | null =
    opts.row === null
      ? null
      : {
          id: "roster-1",
          membershipId: MEMBER,
          dosespotPrescriberId: null,
          revokedAt: null,
          vendorEnrollmentRequestedAt: null,
          npi: null,
          ...opts.row,
        };
  const store: RosterStore = {
    configStatus: async () => (opts.status === undefined ? "verified" : opts.status),
    membershipExists: async () => opts.membershipInOrg !== false,
    async ensureRequested(_org, membershipId, at, claimWindowMs) {
      log.push("ensureRequested");
      if (roster && (roster.revokedAt !== null || roster.dosespotPrescriberId !== null)) {
        return { row: roster, inProgress: false }; // revoked or already linked: nothing is stamped
      }
      const marker = roster?.vendorEnrollmentRequestedAt ?? null;
      if (marker !== null && at.getTime() - marker.getTime() < claimWindowMs) {
        return { row: roster as RosterRow, inProgress: true };
      }
      roster = {
        id: roster?.id ?? "roster-new",
        membershipId,
        dosespotPrescriberId: null,
        revokedAt: null,
        vendorEnrollmentRequestedAt: at,
        npi: roster?.npi ?? null,
      };
      return { row: roster, inProgress: false };
    },
    async releaseRequest() {
      log.push("releaseRequest");
      if (roster) roster = { ...roster, vendorEnrollmentRequestedAt: null };
    },
    async recordVendorId(_org, membershipId, input) {
      log.push("recordVendorId");
      roster = {
        ...(roster as RosterRow),
        membershipId,
        dosespotPrescriberId: input.dosespotPrescriberId,
        npi: input.npi,
      };
      return roster;
    },
  };
  let vendorCalls = 0;
  const client: Pick<DoseSpotClient, "enrollPrescriber"> = {
    async enrollPrescriber(_org, payload) {
      vendorCalls += 1;
      calledInsideTx = calledInsideTx || txDepth > 0;
      log.push(`vendor:${payload.npi}:${payload.epcsRequested}`);
      return opts.vendor
        ? opts.vendor(vendorCalls)
        : { dosespotPrescriberId: "700", epcsEnrollmentStarted: false };
    },
  };
  const published: { eventName: string; payload: Record<string, unknown> }[] = [];
  const audits: { eventType: string; changedFields: readonly string[]; detail?: unknown }[] = [];
  const voids: string[] = [];
  const service = createPrescriberEnrollmentService({
    inTx: async (_org, _user, fn) => {
      txDepth += 1;
      try {
        return await fn(store, {} as DbClient);
      } finally {
        txDepth -= 1;
      }
    },
    client,
    outbox: {
      publish: async (_tx, e) => {
        published.push({ eventName: e.eventName, payload: e.payload });
      },
    },
    audit: {
      record: async (_tx, entry) => {
        audits.push({
          eventType: entry.eventType,
          changedFields: entry.changedFields,
          detail: entry.detail,
        });
      },
    },
    afterWrite: async (_tx, scope) => {
      voids.push(scope.organizationId);
    },
    now: () => clock.at,
  });
  return {
    service,
    log,
    published,
    audits,
    voids,
    calls: () => vendorCalls,
    insideTx: () => calledInsideTx,
    roster: () => roster,
  };
}

describe("isValidNpi", () => {
  it("checks length and the Luhn digit with the 80840 prefix", () => {
    expect(isValidNpi(NPI)).toBe(true);
    for (const bad of ["1234567890", "123456789", "12345678931", "abcdefghij", ""]) {
      expect(isValidNpi(bad)).toBe(false);
    }
  });
});

describe("prescriber vendor enrolment", () => {
  it("records the vendor's id after the vendor call, and the vendor call never runs inside a transaction", async () => {
    const h = build();
    const out = await h.service.enroll(ACTOR, MEMBER, BODY);
    expect(out).toEqual({ membershipId: MEMBER, enrolledWithDoseSpot: true });
    expect(h.log).toEqual(["ensureRequested", `vendor:${NPI}:false`, "recordVendorId"]);
    expect(h.log).not.toContain("releaseRequest");
    expect(h.insideTx()).toBe(false);
    expect(h.roster()).toMatchObject({ dosespotPrescriberId: "700", npi: NPI });
  });

  it("publishes m12.prescriber_enrolled with the REAL vendor id, audits field names only, and voids a pending go-live", async () => {
    const h = build();
    await h.service.enroll(ACTOR, MEMBER, BODY);
    expect(h.published).toEqual([
      {
        eventName: "m12.prescriber_enrolled",
        payload: { membershipId: MEMBER, dosespotPrescriberId: "700" },
      },
    ]);
    expect(h.audits).toHaveLength(1);
    expect(h.audits[0]).toMatchObject({
      eventType: "m12.dosespot_clinic.prescriber_enrolled",
      changedFields: ["dosespotPrescriberId", "npi"],
    });
    expect(JSON.stringify(h.audits)).not.toContain(NPI);
    expect(h.voids).toEqual([ORG]);
  });

  it("never asks the vendor to start EPCS", async () => {
    const h = build();
    await h.service.enroll(ACTOR, MEMBER, BODY);
    expect(h.log.find((l) => l.startsWith("vendor:"))).toBe(`vendor:${NPI}:false`);
  });

  it("is idempotent: a prescriber already linked to DoseSpot is not enrolled a second time", async () => {
    const h = build({ row: { dosespotPrescriberId: "700" } });
    const out = await h.service.enroll(ACTOR, MEMBER, BODY);
    expect(out.enrolledWithDoseSpot).toBe(true);
    expect(h.calls()).toBe(0);
    expect(h.published).toEqual([]);
  });

  it("is refused until the registration is verified or active (409), and calls nothing", async () => {
    for (const status of [null, "draft", "registered"]) {
      const h = build({ status });
      await expect(h.service.enroll(ACTOR, MEMBER, BODY)).rejects.toMatchObject({
        statusCode: 409,
        code: "DOSESPOT_NOT_READY",
      });
      expect(h.calls()).toBe(0);
      expect(h.log).toEqual([]);
    }
    for (const status of ["verified", "active"]) {
      expect(
        (await build({ status }).service.enroll(ACTOR, MEMBER, BODY)).enrolledWithDoseSpot,
      ).toBe(true);
    }
  });

  it("creates the roster row when the prescriber is not on it yet", async () => {
    const h = build({ row: null });
    await h.service.enroll(ACTOR, MEMBER, BODY);
    expect(h.roster()).toMatchObject({ id: "roster-new", dosespotPrescriberId: "700" });
  });

  it("a vendor refusal releases the request claim (a fixed retry may go straight away) and records no vendor id", async () => {
    const h = build({
      vendor: async () => {
        throw new DegradedError(
          "dosespot",
          "enrollPrescriber",
          false,
          "DoseSpot rejected the request (HTTP 422).",
          "c1",
        );
      },
    });
    await expect(h.service.enroll(ACTOR, MEMBER, BODY)).rejects.toMatchObject({
      statusCode: 422,
      code: "DOSESPOT_ENROLLMENT_REJECTED",
    });
    expect(h.log).toEqual(["ensureRequested", `vendor:${NPI}:false`, "releaseRequest"]);
    expect(h.roster()).toMatchObject({
      dosespotPrescriberId: null,
      vendorEnrollmentRequestedAt: null,
    });
    expect(h.published).toEqual([]);
    expect(h.voids).toEqual([]);
  });

  it("a transient vendor failure is a retryable 503, and a retry then succeeds", async () => {
    const h = build({
      vendor: async (n) => {
        if (n === 1) {
          throw new DegradedError(
            "dosespot",
            "enrollPrescriber",
            true,
            "E-prescribe service is temporarily unavailable.",
            "c2",
          );
        }
        return { dosespotPrescriberId: "701", epcsEnrollmentStarted: false };
      },
    });
    await expect(h.service.enroll(ACTOR, MEMBER, BODY)).rejects.toMatchObject({
      statusCode: 503,
      code: "DOSESPOT_UNAVAILABLE",
    });
    expect((await h.service.enroll(ACTOR, MEMBER, BODY)).enrolledWithDoseSpot).toBe(true);
    expect(h.roster()?.dosespotPrescriberId).toBe("701");
  });

  it("a second enrolment while one is in flight is a 409 and makes no second vendor call (the claim)", async () => {
    // the first attempt crashed between the vendor create and the record: its marker is committed with no vendor id
    const h = build({ row: { vendorEnrollmentRequestedAt: new Date("2026-11-06T11:59:30.000Z") } });
    await expect(h.service.enroll(ACTOR, MEMBER, BODY)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_ENROLLMENT_IN_PROGRESS",
    });
    expect(h.calls()).toBe(0);
    // once the claim window has passed the retry goes through
    clock.at = new Date("2026-11-06T12:05:00.000Z");
    expect((await h.service.enroll(ACTOR, MEMBER, BODY)).enrolledWithDoseSpot).toBe(true);
    expect(h.calls()).toBe(1);
    clock.at = new Date("2026-11-06T12:00:00.000Z");
  });

  it("never reinstates a revoked prescriber: 409, no vendor call, and the row is left revoked", async () => {
    for (const row of [
      { revokedAt: new Date("2026-11-01T00:00:00.000Z") },
      { revokedAt: new Date("2026-11-01T00:00:00.000Z"), dosespotPrescriberId: "700" },
    ]) {
      const h = build({ row });
      await expect(h.service.enroll(ACTOR, MEMBER, BODY)).rejects.toMatchObject({
        statusCode: 409,
        code: "DOSESPOT_PRESCRIBER_REVOKED",
      });
      expect(h.calls()).toBe(0);
      expect(h.roster()?.revokedAt).not.toBeNull();
    }
  });

  it("refuses a membership that is not in this organization (404) before any roster write or vendor call", async () => {
    const h = build({ membershipInOrg: false });
    await expect(h.service.enroll(ACTOR, MEMBER, BODY)).rejects.toMatchObject({ statusCode: 404 });
    expect(h.log).toEqual([]);
    expect(h.calls()).toBe(0);
  });

  it("refuses a bad NPI or an empty name before any store call (422)", async () => {
    for (const bad of [
      { ...BODY, npi: "1234567890" },
      { ...BODY, firstName: " " },
      { ...BODY, lastName: "" },
    ]) {
      const h = build();
      await expect(h.service.enroll(ACTOR, MEMBER, bad)).rejects.toMatchObject({ statusCode: 422 });
      expect(h.log).toEqual([]);
    }
  });
});
