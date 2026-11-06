import type { DbClient } from "@chartwarden/db";
// Slice 4 — a prescriber's DoseSpot (vendor) enrolment: create-then-record. The roster row and the committed
// `vendor_enrollment_requested_at` come first, the vendor call runs with NO transaction open, and only the vendor's id is
// recorded as the link `transmit-newrx` sends under. Pure: a fake roster store, a fake vendor client, recording ports.
import {
  ConfigUnavailableError,
  DOSESPOT_REQUEST_TIMEOUT_MS,
  DegradedError,
  type DoseSpotClient,
  NotEnabledError,
} from "@chartwarden/dosespot";
import { ChartWardenError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  type NppesDirectoryPort,
  type PractitionerDirectoryPort,
  createPractitionerProfileSource,
} from "./practitioner-profile";
import {
  ENROLL_CLAIM_WINDOW_MS,
  type RosterRow,
  type RosterStore,
  createPrescriberEnrollmentService,
} from "./prescriber-enrollment";

const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBER = "33333333-3333-4333-8333-333333333333";
const ACTOR = {
  organizationId: ORG,
  userId: "u-1",
  membershipId: "44444444-4444-4444-8444-444444444444",
};
const NPI = "1234567893"; // passes the NPI check digit (synthetic)
const MDM = "55555555-5555-4555-8555-555555555555"; // the M40 physician record the roster links MEMBER to
const RECORD = { identifierValue: NPI, firstName: "Ada", lastName: "Lovelace" };

const clock = { at: new Date("2026-11-06T12:00:00.000Z") };

function build(
  opts: {
    status?: string | null;
    environment?: string;
    membershipInOrg?: boolean;
    /** The M40 record the directory returns (null = unknown id). */
    record?: {
      status: string;
      canonical: Partial<{ identifierValue: string | null; firstName: string; lastName: string }>;
    } | null;
    /** NPPES's row for the NPI (null = no row). */
    nppes?: { enumerationType: string; status: string; basic: unknown } | null;
    /** Called while the profile is being derived, with the roster row in hand (to simulate a concurrent roster edit). */
    onProfile?: () => void;
    row?: Partial<RosterRow> | null;
    vendor?: (
      n: number,
    ) => Promise<{ dosespotPrescriberId: string; epcsEnrollmentStarted: boolean }>;
  } = {},
) {
  const log: string[] = [];
  const releasedWith: Date[] = [];
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
          externalPhysicianMdmId: MDM,
          ...opts.row,
        };
  const store: RosterStore = {
    registration: async () => {
      const status = opts.status === undefined ? "verified" : opts.status;
      return status === null ? null : { status, environment: opts.environment ?? "sandbox" };
    },
    membershipExists: async () => opts.membershipInOrg !== false,
    rosterRow: async () => roster,
    async ensureRequested(_org, membershipId, at, claimWindowMs, expectedPhysicianMdmId) {
      log.push("ensureRequested");
      if (!roster || roster.externalPhysicianMdmId !== expectedPhysicianMdmId) {
        throw new ChartWardenError("DOSESPOT_ROSTER_CHANGED", "the roster changed", 409);
      }
      if (roster.revokedAt !== null || roster.dosespotPrescriberId !== null) {
        return { row: roster, inProgress: false }; // revoked or already linked: nothing is stamped
      }
      const marker = roster.vendorEnrollmentRequestedAt;
      if (marker !== null && at.getTime() - marker.getTime() < claimWindowMs) {
        return { row: roster, inProgress: true };
      }
      roster = { ...roster, membershipId, vendorEnrollmentRequestedAt: at };
      return { row: roster, inProgress: false };
    },
    async releaseRequest(_org, _membershipId, claimedAt) {
      log.push("releaseRequest");
      releasedWith.push(claimedAt);
      // only the claimant's OWN marker is cleared: a newer claim by someone else is left standing
      if (roster?.vendorEnrollmentRequestedAt?.getTime() === claimedAt.getTime()) {
        roster = { ...roster, vendorEnrollmentRequestedAt: null };
      }
    },
    async recordVendorId(_org, membershipId, input) {
      log.push("recordVendorId");
      if (roster?.revokedAt) {
        throw new ChartWardenError(
          "DOSESPOT_PRESCRIBER_REVOKED",
          "revoked while it was being enrolled",
          409,
        );
      }
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
  const vendorPayloads: Record<string, unknown>[] = [];
  const client: Pick<DoseSpotClient, "enrollPrescriber"> = {
    async enrollPrescriber(_org, payload) {
      vendorCalls += 1;
      vendorPayloads.push({ ...payload });
      calledInsideTx = calledInsideTx || txDepth > 0;
      log.push(`vendor:${payload.npi}:${payload.epcsRequested}`);
      return opts.vendor
        ? opts.vendor(vendorCalls)
        : { dosespotPrescriberId: "700", epcsEnrollmentStarted: false };
    },
  };
  let profileInsideTx = false;
  const directory: PractitionerDirectoryPort = {
    async resolvePhysician(_org, mdmId) {
      log.push(`profile:${mdmId}`);
      profileInsideTx = profileInsideTx || txDepth > 0;
      opts.onProfile?.();
      if (opts.record === null) return null;
      return {
        status: opts.record?.status ?? "active",
        canonical: { ...RECORD, ...opts.record?.canonical },
      };
    },
  };
  const nppes: NppesDirectoryPort = {
    getByNpi: async () =>
      opts.nppes === undefined
        ? { enumerationType: "NPI-1", status: "active", basic: { lastName: "LOVELACE" } }
        : opts.nppes,
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
    profiles: createPractitionerProfileSource({ directory, nppes }),
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
    releasedWith,
    setRoster: (r: RosterRow | null) => {
      roster = r;
    },
    insideTx: () => calledInsideTx,
    profileInsideTx: () => profileInsideTx,
    vendorPayloads,
    roster: () => roster,
  };
}

describe("prescriber vendor enrolment", () => {
  it("records the vendor's id after the vendor call, and the vendor call never runs inside a transaction", async () => {
    const h = build();
    const out = await h.service.enroll(ACTOR, MEMBER);
    expect(out).toEqual({ membershipId: MEMBER, enrolledWithDoseSpot: true });
    expect(h.log).toEqual([
      `profile:${MDM}`,
      "ensureRequested",
      `vendor:${NPI}:false`,
      "recordVendorId",
    ]);
    expect(h.log).not.toContain("releaseRequest");
    expect(h.insideTx()).toBe(false);
    expect(h.profileInsideTx()).toBe(false); // the M40 / NPPES reads run with no roster transaction open
    expect(h.roster()).toMatchObject({ dosespotPrescriberId: "700", npi: NPI });
  });

  it("publishes m12.prescriber_enrolled with the REAL vendor id, audits field names only, and voids a pending go-live", async () => {
    const h = build();
    await h.service.enroll(ACTOR, MEMBER);
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
      detail: { nppesVerified: true },
    });
    expect(JSON.stringify(h.audits)).not.toContain(NPI);
    expect(h.voids).toEqual([ORG]);
  });

  it("never asks the vendor to start EPCS", async () => {
    const h = build();
    await h.service.enroll(ACTOR, MEMBER);
    expect(h.log.find((l) => l.startsWith("vendor:"))).toBe(`vendor:${NPI}:false`);
  });

  it("is idempotent: a prescriber already linked to DoseSpot is not enrolled a second time", async () => {
    const h = build({ row: { dosespotPrescriberId: "700" } });
    const out = await h.service.enroll(ACTOR, MEMBER);
    expect(out.enrolledWithDoseSpot).toBe(true);
    expect(h.calls()).toBe(0);
    expect(h.published).toEqual([]);
    expect(h.log).toEqual([]); // nothing derived, claimed or called
  });

  it("is refused until the registration is verified or active (409), and calls nothing", async () => {
    for (const status of [null, "draft", "registered"]) {
      const h = build({ status });
      await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({
        statusCode: 409,
        code: "DOSESPOT_NOT_READY",
      });
      expect(h.calls()).toBe(0);
      expect(h.log).toEqual([]);
    }
    for (const status of ["verified", "active"]) {
      expect((await build({ status }).service.enroll(ACTOR, MEMBER)).enrolledWithDoseSpot).toBe(
        true,
      );
    }
  });

  it("tells the vendor the profile's NPI and name: nothing identifying comes from the caller", async () => {
    const h = build({
      record: { status: "active", canonical: { firstName: " Grace ", lastName: "Hopper" } },
      nppes: { enumerationType: "NPI-1", status: "active", basic: { lastName: "Hopper" } },
    });
    await h.service.enroll(ACTOR, MEMBER);
    expect(h.vendorPayloads).toEqual([
      {
        membershipId: MEMBER,
        firstName: "Grace",
        lastName: "Hopper",
        npi: NPI,
        epcsRequested: false,
      },
    ]);
  });

  it("a prescriber who is not on the roster has no practitioner record to derive from: 409, and nothing is claimed or called", async () => {
    const h = build({ row: null });
    await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_PRACTITIONER_NOT_LINKED",
    });
    expect(h.log).toEqual([]);
    expect(h.calls()).toBe(0);
  });

  it("a roster row that links no physician record is refused the same way", async () => {
    const h = build({ row: { externalPhysicianMdmId: null } });
    await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({
      code: "DOSESPOT_PRACTITIONER_NOT_LINKED",
    });
    expect(h.log).toEqual([]);
  });

  it("refuses when the linked record cannot vouch (unknown, inactive, no NPI, bad NPI, no name): before any claim or vendor call", async () => {
    const cases: ReadonlyArray<readonly [Parameters<typeof build>[0], number, string]> = [
      [{ record: null }, 409, "DOSESPOT_PRACTITIONER_NOT_ACTIVE"],
      [
        { record: { status: "deactivated", canonical: {} } },
        409,
        "DOSESPOT_PRACTITIONER_NOT_ACTIVE",
      ],
      [
        { record: { status: "provisional", canonical: {} } },
        409,
        "DOSESPOT_PRACTITIONER_NOT_ACTIVE",
      ],
      [
        { record: { status: "active", canonical: { identifierValue: null } } },
        409,
        "DOSESPOT_PRACTITIONER_NPI_MISSING",
      ],
      [
        { record: { status: "active", canonical: { identifierValue: "1234567890" } } },
        422,
        "DOSESPOT_NPI_INVALID",
      ],
      [
        { record: { status: "active", canonical: { lastName: " " } } },
        409,
        "DOSESPOT_PRACTITIONER_NAME_MISSING",
      ],
    ];
    for (const [opts, statusCode, code] of cases) {
      const h = build(opts);
      await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({ statusCode, code });
      expect(h.log).toEqual([`profile:${MDM}`]); // derived, refused: never claimed, never sent
      expect(h.calls()).toBe(0);
    }
  });

  it("refuses an NPI that NPPES contradicts (an organization, a deactivated provider, another surname)", async () => {
    for (const nppes of [
      { enumerationType: "NPI-2", status: "active", basic: { lastName: "LOVELACE" } },
      { enumerationType: "NPI-1", status: "deactivated", basic: { lastName: "LOVELACE" } },
      { enumerationType: "NPI-1", status: "active", basic: { lastName: "BABBAGE" } },
      { enumerationType: "NPI-1", status: "active", basic: {} },
    ]) {
      const h = build({ nppes });
      await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({
        code: "DOSESPOT_NPPES_MISMATCH",
      });
      expect(h.calls()).toBe(0);
      expect(h.log).not.toContain("ensureRequested");
    }
  });

  it("NPPES with no row: a sandbox registration proceeds FLAGGED (nppesVerified false), a production one is refused", async () => {
    const sandbox = build({ nppes: null, environment: "sandbox" });
    await sandbox.service.enroll(ACTOR, MEMBER);
    expect(sandbox.audits[0]?.detail).toEqual({ nppesVerified: false });
    const production = build({ nppes: null, environment: "production" });
    await expect(production.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({
      code: "DOSESPOT_NPPES_UNVERIFIED",
    });
    expect(production.calls()).toBe(0);
  });

  it("a roster edit between deriving the profile and claiming the row voids the profile (409), and nothing is sent", async () => {
    const h = build({
      onProfile: () => {
        // an administrator re-links the member to a different physician record while the profile is being derived
        h.setRoster({
          ...(h.roster() as RosterRow),
          externalPhysicianMdmId: "66666666-6666-4666-8666-666666666666",
        });
      },
    });
    await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_ROSTER_CHANGED",
    });
    expect(h.calls()).toBe(0);
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
    await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({
      statusCode: 422,
      code: "DOSESPOT_ENROLLMENT_REJECTED",
    });
    expect(h.log).toEqual([
      `profile:${MDM}`,
      "ensureRequested",
      `vendor:${NPI}:false`,
      "releaseRequest",
    ]);
    expect(h.roster()).toMatchObject({
      dosespotPrescriberId: null,
      vendorEnrollmentRequestedAt: null,
    });
    expect(h.published).toEqual([]);
    expect(h.voids).toEqual([]);
  });

  it("a transient (ambiguous) vendor failure is a retryable 503 that KEEPS the claim: the clinician may have been created", async () => {
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
    await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({
      statusCode: 503,
      code: "DOSESPOT_UNAVAILABLE",
    });
    expect(h.log).not.toContain("releaseRequest");
    expect(h.roster()?.vendorEnrollmentRequestedAt).not.toBeNull();
    // an immediate retry is refused (the first attempt may still be in flight at the vendor)...
    await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({
      code: "DOSESPOT_ENROLLMENT_IN_PROGRESS",
    });
    expect(h.calls()).toBe(1);
    // ...and once the window has passed the retry goes through
    clock.at = new Date(clock.at.getTime() + ENROLL_CLAIM_WINDOW_MS + 1000);
    expect((await h.service.enroll(ACTOR, MEMBER)).enrolledWithDoseSpot).toBe(true);
    expect(h.roster()?.dosespotPrescriberId).toBe("701");
    clock.at = new Date("2026-11-06T12:00:00.000Z");
  });

  it("releases the claim when nothing could have reached the vendor (no live registration, an unreadable credential)", async () => {
    for (const err of [
      new NotEnabledError(
        "dosespot",
        "enrollPrescriber",
        "E-prescribe is not enabled for this organization.",
        "c5",
      ),
      new ConfigUnavailableError(
        "dosespot",
        "enrollPrescriber",
        "temporarily unavailable",
        "c6",
        new Error("kek"),
      ),
    ]) {
      const h = build({
        vendor: async () => {
          throw err;
        },
      });
      await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toBeDefined();
      expect(h.log).toContain("releaseRequest");
      expect(h.roster()?.vendorEnrollmentRequestedAt).toBeNull();
    }
  });

  it("the release names the marker THIS attempt stamped, so it can never clear a newer claim", async () => {
    const h = build({
      vendor: async () => {
        // while this attempt was calling out, its claim aged out and another admin's attempt stamped a newer marker
        h.setRoster({
          ...(h.roster() as RosterRow),
          vendorEnrollmentRequestedAt: new Date("2026-11-06T12:09:00.000Z"),
        });
        throw new DegradedError(
          "dosespot",
          "enrollPrescriber",
          false,
          "DoseSpot rejected the request (HTTP 422).",
          "c1",
        );
      },
    });
    await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({ statusCode: 422 });
    expect(h.releasedWith).toEqual([new Date("2026-11-06T12:00:00.000Z")]);
    expect(h.roster()?.vendorEnrollmentRequestedAt).toEqual(new Date("2026-11-06T12:09:00.000Z")); // theirs, untouched
  });

  it("the claim window outlasts the worst-case vendor call (a token mint and the call, twice for a forced re-mint)", () => {
    expect(ENROLL_CLAIM_WINDOW_MS).toBeGreaterThan(4 * DOSESPOT_REQUEST_TIMEOUT_MS);
  });

  it("a prescriber revoked while the vendor call was in flight is not linked: the record refuses (409)", async () => {
    const h = build({
      vendor: async () => {
        h.setRoster({
          ...(h.roster() as RosterRow),
          revokedAt: new Date("2026-11-06T12:00:30.000Z"),
        });
        return { dosespotPrescriberId: "702", epcsEnrollmentStarted: false };
      },
    });
    await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({
      code: "DOSESPOT_PRESCRIBER_REVOKED",
    });
    expect(h.published).toEqual([]);
  });

  it("a second enrolment while one is in flight is a 409 and makes no second vendor call (the claim)", async () => {
    // the first attempt crashed between the vendor create and the record: its marker is committed with no vendor id
    const h = build({ row: { vendorEnrollmentRequestedAt: new Date("2026-11-06T11:59:30.000Z") } });
    await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({
      statusCode: 409,
      code: "DOSESPOT_ENROLLMENT_IN_PROGRESS",
    });
    expect(h.calls()).toBe(0);
    // once the claim window has passed the retry goes through
    clock.at = new Date("2026-11-06T12:05:00.000Z");
    expect((await h.service.enroll(ACTOR, MEMBER)).enrolledWithDoseSpot).toBe(true);
    expect(h.calls()).toBe(1);
    clock.at = new Date("2026-11-06T12:00:00.000Z");
  });

  it("never reinstates a revoked prescriber: 409, no vendor call, and the row is left revoked", async () => {
    for (const row of [
      { revokedAt: new Date("2026-11-01T00:00:00.000Z") },
      { revokedAt: new Date("2026-11-01T00:00:00.000Z"), dosespotPrescriberId: "700" },
    ]) {
      const h = build({ row });
      await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({
        statusCode: 409,
        code: "DOSESPOT_PRESCRIBER_REVOKED",
      });
      expect(h.calls()).toBe(0);
      expect(h.roster()?.revokedAt).not.toBeNull();
    }
  });

  it("refuses a membership that is not in this organization (404) before any roster write or vendor call", async () => {
    const h = build({ membershipInOrg: false });
    await expect(h.service.enroll(ACTOR, MEMBER)).rejects.toMatchObject({ statusCode: 404 });
    expect(h.log).toEqual([]);
    expect(h.calls()).toBe(0);
  });
});
