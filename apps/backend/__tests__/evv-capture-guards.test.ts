// GAP-055 — the SERVICE-layer capture guards (§8.2). `recordCapture` re-asserts the assigned-clinician,
// visit-window and device-attestation checks itself, so a non-route caller cannot bypass the HTTP gates.
import { describe, expect, it } from "vitest";
import {
  EvvRouteService,
  clinicianCapture,
  isEvvDeviceAttestationEnforced,
  selectBoundDevice,
  systemCapture,
} from "../src/modules/18-evv/index";

const ORG = "org_a";
const VISIT = "22222222-2222-4222-8222-222222222222";
const START = "2026-06-08T12:00:00.000Z";
const END = "2026-06-08T13:00:00.000Z";
const input = (capturedAt = START) => ({
  visitId: VISIT,
  coords: { lat: 40, lng: -75 },
  accuracyM: 10,
  capturedAt,
});
const ATT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEV = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DEV_OTHER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const make = (deviceAttestationEnforced = true) =>
  new EvvRouteService(
    {
      devices: [
        {
          organizationId: ORG,
          id: DEV,
          membershipId: "rn_1",
          status: "approved",
          attestationId: ATT,
        },
        {
          organizationId: ORG,
          id: DEV_OTHER,
          membershipId: "rn_1",
          status: "approved",
          attestationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
      ],
      visits: [
        {
          organizationId: ORG,
          visitId: VISIT,
          patientId: "p1",
          assignedMembershipId: "rn_1",
          scheduledStartedAt: START,
          scheduledEndedAt: END,
        },
      ],
    },
    { deviceAttestationEnforced },
  );
const ATTESTED = clinicianCapture({ valid: true, attestationId: ATT });

describe("EvvRouteService.recordCapture — GAP-055 service-layer guards", () => {
  it("records for the assigned clinician, in window, on an attested session", async () => {
    const res = await make().recordCapture(ORG, "rn_1", "check_in", input(), ATTESTED);
    expect(res.kind).toBe("check_in");
  });

  it("refuses a membership that is not the visit's assigned clinician", async () => {
    await expect(
      make().recordCapture(ORG, "rn_2", "check_in", input(), ATTESTED),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("refuses a capture instant outside the visit window", async () => {
    await expect(
      make().recordCapture(ORG, "rn_1", "check_out", input("2026-06-09T13:00:00.000Z"), ATTESTED),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("refuses an unknown / cross-tenant visit (fail-closed)", async () => {
    await expect(
      make().recordCapture("org_b", "rn_1", "check_in", input(), ATTESTED),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it.each([
    ["no attestation", clinicianCapture(undefined)],
    ["an invalid attestation", clinicianCapture({ valid: false })],
    ["a non-boolean verdict", clinicianCapture({ valid: "yes" })],
  ])("refuses %s", async (_label, authority) => {
    await expect(
      make().recordCapture(ORG, "rn_1", "check_in", input(), authority),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("an explicit system marker (queue replay) is exempt from the clinician guards", async () => {
    const res = await make().recordCapture(
      ORG,
      "rn_2",
      "check_in",
      input("2026-06-09T13:00:00.000Z"),
      systemCapture("offline-queue replay"),
    );
    expect(res.kind).toBe("check_in");
  });

  it("a forged marker-shaped role string is not a system actor", async () => {
    // @ts-expect-error — only the typed marker is accepted; a role string must not unlock the bypass
    const forged: never = "system";
    await expect(
      make().recordCapture(ORG, "rn_2", "check_in", input(), forged),
    ).rejects.toBeDefined();
  });
});

describe("EvvRouteService.recordCapture — session-bound device (GAP-055 follow-up)", () => {
  it("accepts a capture whose claimed device is the session-bound one", async () => {
    const res = await make().recordCapture(
      ORG,
      "rn_1",
      "check_in",
      { ...input(), claimedDeviceId: DEV },
      ATTESTED,
    );
    expect(res.kind).toBe("check_in");
  });

  it("refuses a claimed device that is another approved device of the same clinician", async () => {
    await expect(
      make().recordCapture(
        ORG,
        "rn_1",
        "check_in",
        { ...input(), claimedDeviceId: DEV_OTHER },
        ATTESTED,
      ),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("refuses a session whose attestation id matches no approved device of the clinician", async () => {
    await expect(
      make().recordCapture(
        ORG,
        "rn_1",
        "check_in",
        input(),
        clinicianCapture({ valid: true, attestationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
      ),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("refuses a valid attestation that carries no attestation id (fail closed)", async () => {
    await expect(
      make().recordCapture(ORG, "rn_1", "check_in", input(), clinicianCapture({ valid: true })),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it("refuses when the bound device belongs to another membership", async () => {
    const svc = new EvvRouteService(
      {
        visits: [
          {
            organizationId: ORG,
            visitId: VISIT,
            patientId: "p1",
            assignedMembershipId: "rn_1",
            scheduledStartedAt: START,
            scheduledEndedAt: END,
          },
        ],
        devices: [
          {
            organizationId: ORG,
            id: DEV,
            membershipId: "rn_9",
            status: "approved",
            attestationId: ATT,
          },
        ],
      },
      { deviceAttestationEnforced: true },
    );
    await expect(
      svc.recordCapture(ORG, "rn_1", "check_in", input(), ATTESTED),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });

  it.each(["pending_approval", "suspended", "retired", "rejected"] as const)(
    "refuses a bound device in status %s",
    async (status) => {
      const svc = new EvvRouteService(
        {
          visits: [
            {
              organizationId: ORG,
              visitId: VISIT,
              patientId: "p1",
              assignedMembershipId: "rn_1",
              scheduledStartedAt: START,
              scheduledEndedAt: END,
            },
          ],
          devices: [
            { organizationId: ORG, id: DEV, membershipId: "rn_1", status, attestationId: ATT },
          ],
        },
        { deviceAttestationEnforced: true },
      );
      await expect(
        svc.recordCapture(ORG, "rn_1", "check_in", input(), ATTESTED),
      ).rejects.toMatchObject({ name: "ForbiddenError" });
    },
  );
});

describe("selectBoundDevice", () => {
  const cand = (over = {}) => ({
    id: DEV,
    membershipId: "rn_1",
    status: "approved",
    attestationId: ATT,
    approvedAtMs: 1,
    ...over,
  });
  it("returns null for the typed system marker (no session device)", () => {
    expect(selectBoundDevice(systemCapture("replay"), "rn_1", undefined, [], true)).toBeNull();
  });
  it("returns the bound device id", () => {
    expect(selectBoundDevice(ATTESTED, "rn_1", undefined, [cand()], true)).toBe(DEV);
  });
  it("throws when the claim differs from the bound device", () => {
    expect(() => selectBoundDevice(ATTESTED, "rn_1", DEV_OTHER, [cand()], true)).toThrow(/device/);
  });
});

describe("selectBoundDevice — device attestation NOT enforced (default; ADR-0035, no attested client yet)", () => {
  const cand = (over = {}) => ({
    id: DEV,
    membershipId: "rn_1",
    status: "approved",
    attestationId: ATT,
    approvedAtMs: 1,
    ...over,
  });
  const UNATTESTED = clinicianCapture(undefined);
  it("resolves the membership's most-recently-approved device with no session attestation", () => {
    const candidates = [cand(), cand({ id: DEV_OTHER, attestationId: null, approvedAtMs: 2 })];
    expect(selectBoundDevice(UNATTESTED, "rn_1", undefined, candidates, false)).toBe(DEV_OTHER);
  });
  it("ignores the session attestation id entirely", () => {
    const candidates = [cand(), cand({ id: DEV_OTHER, approvedAtMs: 2 })];
    expect(selectBoundDevice(ATTESTED, "rn_1", undefined, candidates, false)).toBe(DEV_OTHER);
  });
  it("accepts a claim equal to the resolved device", () => {
    expect(selectBoundDevice(UNATTESTED, "rn_1", DEV, [cand()], false)).toBe(DEV);
  });
  it("accepts a claim naming an OLDER approved device of the same membership (records against it)", () => {
    const candidates = [cand(), cand({ id: DEV_OTHER, approvedAtMs: 2 })];
    expect(selectBoundDevice(UNATTESTED, "rn_1", DEV, candidates, false)).toBe(DEV);
  });
  it("rejects a claim naming another membership's approved device", () => {
    const candidates = [cand(), cand({ id: DEV_OTHER, membershipId: "rn_9", approvedAtMs: 9 })];
    expect(() => selectBoundDevice(UNATTESTED, "rn_1", DEV_OTHER, candidates, false)).toThrow(
      /device/,
    );
  });
  it("rejects a claim naming a non-approved device of the same membership", () => {
    const candidates = [cand(), cand({ id: DEV_OTHER, status: "suspended", approvedAtMs: 9 })];
    expect(() => selectBoundDevice(UNATTESTED, "rn_1", DEV_OTHER, candidates, false)).toThrow(
      /device/,
    );
  });
  it("breaks an approvedAt tie deterministically (smallest id), regardless of array order", () => {
    const a = cand({ id: DEV, approvedAtMs: 5 });
    const b = cand({ id: DEV_OTHER, approvedAtMs: 5 });
    expect(selectBoundDevice(UNATTESTED, "rn_1", undefined, [a, b], false)).toBe(DEV);
    expect(selectBoundDevice(UNATTESTED, "rn_1", undefined, [b, a], false)).toBe(DEV);
  });
  it("only considers approved devices of the acting membership", () => {
    const candidates = [
      cand(),
      cand({ id: DEV_OTHER, status: "suspended", approvedAtMs: 5 }),
      cand({ id: "ffffffff-ffff-4fff-8fff-ffffffffffff", membershipId: "rn_9", approvedAtMs: 9 }),
    ];
    expect(selectBoundDevice(UNATTESTED, "rn_1", undefined, candidates, false)).toBe(DEV);
  });
  it("throws when the membership has no approved device", () => {
    expect(() =>
      selectBoundDevice(
        UNATTESTED,
        "rn_1",
        undefined,
        [cand({ status: "pending_approval" })],
        false,
      ),
    ).toThrow(/no approved EVV device/);
  });
  it("returns null for the typed system marker", () => {
    expect(selectBoundDevice(systemCapture("replay"), "rn_1", undefined, [], false)).toBeNull();
  });
});

describe("EvvRouteService.recordCapture — device attestation NOT enforced", () => {
  const UNATTESTED = clinicianCapture(undefined);
  it("records an un-attested clinician capture (the attestation check is the ONLY thing skipped)", async () => {
    const res = await make(false).recordCapture(ORG, "rn_1", "check_in", input(), UNATTESTED);
    expect(res.kind).toBe("check_in");
  });
  it("accepts a claim equal to the most-recently-approved device", async () => {
    const res = await make(false).recordCapture(
      ORG,
      "rn_1",
      "check_in",
      { ...input(), claimedDeviceId: DEV_OTHER },
      UNATTESTED,
    );
    expect(res.kind).toBe("check_in");
  });
  it("accepts a claim naming an older approved device of the clinician", async () => {
    const res = await make(false).recordCapture(
      ORG,
      "rn_1",
      "check_in",
      { ...input(), claimedDeviceId: DEV },
      UNATTESTED,
    );
    expect(res.kind).toBe("check_in");
  });
  it("rejects a claimed id that is not any device of the clinician", async () => {
    await expect(
      make(false).recordCapture(
        ORG,
        "rn_1",
        "check_in",
        { ...input(), claimedDeviceId: "99999999-9999-4999-8999-999999999999" },
        UNATTESTED,
      ),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });
  it("still refuses a membership that is not the assigned clinician", async () => {
    await expect(
      make(false).recordCapture(ORG, "rn_2", "check_in", input(), UNATTESTED),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });
  it("still refuses a capture instant outside the visit window", async () => {
    await expect(
      make(false).recordCapture(
        ORG,
        "rn_1",
        "check_out",
        input("2026-06-09T13:00:00.000Z"),
        UNATTESTED,
      ),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });
  it("refuses a clinician with no approved device (nothing to record on)", async () => {
    const svc = new EvvRouteService(
      {
        visits: [
          {
            organizationId: ORG,
            visitId: VISIT,
            patientId: "p1",
            assignedMembershipId: "rn_1",
            scheduledStartedAt: START,
            scheduledEndedAt: END,
          },
        ],
      },
      { deviceAttestationEnforced: false },
    );
    await expect(
      svc.recordCapture(ORG, "rn_1", "check_in", input(), UNATTESTED),
    ).rejects.toBeDefined();
  });
  it("assertCaptureDevice applies the same resolution (whole-batch pre-flight)", async () => {
    const svc = make(false);
    await expect(
      svc.assertCaptureDevice(ORG, "rn_1", DEV_OTHER, UNATTESTED),
    ).resolves.toBeUndefined();
    await expect(svc.assertCaptureDevice(ORG, "rn_1", DEV, UNATTESTED)).resolves.toBeUndefined();
    await expect(
      svc.assertCaptureDevice(ORG, "rn_1", "99999999-9999-4999-8999-999999999999", UNATTESTED),
    ).rejects.toMatchObject({ name: "ForbiddenError" });
  });
  it("the typed system marker stays exempt", async () => {
    const res = await make(false).recordCapture(
      ORG,
      "rn_2",
      "check_in",
      input("2026-06-09T13:00:00.000Z"),
      systemCapture("offline-queue replay"),
    );
    expect(res.kind).toBe("check_in");
  });
});

describe("isEvvDeviceAttestationEnforced", () => {
  it("is off by default and for anything but an explicit true", () => {
    expect(isEvvDeviceAttestationEnforced({})).toBe(false);
    expect(isEvvDeviceAttestationEnforced({ EVV_DEVICE_ATTESTATION_ENFORCED: "false" })).toBe(
      false,
    );
    expect(isEvvDeviceAttestationEnforced({ EVV_DEVICE_ATTESTATION_ENFORCED: "1" })).toBe(false);
    expect(isEvvDeviceAttestationEnforced({ EVV_DEVICE_ATTESTATION_ENFORCED: "true" })).toBe(true);
  });
});
