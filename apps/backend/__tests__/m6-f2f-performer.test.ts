// GAP-022 (42 CFR 418.22) — the F2F performer role is DERIVED from the clinician's real role grants,
// never taken from the request body. Pure resolver + the in-memory service's service-layer refusal.
import { describe, expect, it } from "vitest";
import {
  createInMemoryAdmissionBackend,
  resolveF2fPerformerRole,
} from "../src/modules/06-admission/index";
import { SYSTEM_F2F_ACTOR } from "../src/modules/06-admission/routes/service";

describe("resolveF2fPerformerRole", () => {
  it.each([
    [["np"], undefined, "hospice_np"],
    [["md"], undefined, "hospice_md"],
    [["hospice_physician"], undefined, "hospice_md"],
    [["medical_director"], undefined, "hospice_md"],
    [["np", "md"], "hospice_np", "hospice_np"],
    [["np", "md"], "hospice_md", "hospice_md"],
  ] as const)("roles %j claim %s -> %s", (roles, claim, expected) => {
    expect(resolveF2fPerformerRole(roles, claim)).toBe(expected);
  });

  it.each([["rn"], ["rn_case_manager"], ["rn", "rn_case_manager"], [[]], ["pa"], ["attending"]])(
    "roles %j hold no performer-eligible role -> F2F_INVALID_PERFORMER",
    (...roles) => {
      expect(() => resolveF2fPerformerRole(roles.flat(), undefined)).toThrowError(
        expect.objectContaining({ code: "F2F_INVALID_PERFORMER", statusCode: 422 }),
      );
    },
  );

  it("refuses a claim the clinician does not hold, even if another eligible role is held", () => {
    expect(() => resolveF2fPerformerRole(["np"], "hospice_md")).toThrowError(
      expect.objectContaining({ code: "F2F_INVALID_PERFORMER" }),
    );
    expect(() => resolveF2fPerformerRole(["rn"], "hospice_np")).toThrowError(
      expect.objectContaining({ code: "F2F_INVALID_PERFORMER" }),
    );
  });

  it("refuses when the clinician has no membership at all (null)", () => {
    expect(() => resolveF2fPerformerRole(null, "hospice_np")).toThrowError(
      expect.objectContaining({ code: "F2F_INVALID_PERFORMER" }),
    );
  });
});

describe("in-memory service — scheduleF2f / attestF2f enforce the facts (a bypassing caller is refused)", () => {
  const ORG = "org_a";
  const NP = "np-user";
  const RN = "rn-user";
  const base = {
    admissionId: "adm",
    electionPeriodId: "ep",
    scheduledDate: "2026-06-25",
  } as const;
  const backend = () =>
    createInMemoryAdmissionBackend({
      clinicianRoleKeys: { [NP]: ["np"], [RN]: ["rn"] },
      records: [
        // GAP-024 — the period must belong to the admission the F2F is scheduled for.
        {
          id: "ep",
          organizationId: ORG,
          kind: "election_period",
          state: "active",
          admissionId: "adm",
        },
        {
          id: "f2f_done",
          organizationId: ORG,
          kind: "f2f",
          state: "completed",
          admissionId: "adm",
        },
      ],
    });

  it("refuses an RN as performer at the service layer", async () => {
    await expect(
      backend().service.scheduleF2f(ORG, {
        ...base,
        scheduledClinicianId: RN,
        clinicianRole: "hospice_md",
        actor: { kind: "user", userId: "scheduler" },
      }),
    ).rejects.toMatchObject({ code: "F2F_INVALID_PERFORMER", statusCode: 422 });
  });

  it("schedules an NP; the explicit system actor is the only way to skip the grants lookup", async () => {
    const b = backend();
    const ok = await b.service.scheduleF2f(ORG, {
      ...base,
      scheduledClinicianId: NP,
      clinicianRole: "hospice_np",
      actor: { kind: "user", userId: "scheduler" },
    });
    expect(ok.state).toBe("scheduled");
    const sys = await b.service.scheduleF2f(ORG, {
      ...base,
      scheduledClinicianId: "unknown-user",
      clinicianRole: "hospice_np",
      actor: SYSTEM_F2F_ACTOR,
    });
    expect(sys.state).toBe("scheduled");
  });

  it("attestF2f refuses a short narrative at the service layer", async () => {
    await expect(
      backend().service.attestF2f(ORG, "f2f_done", 1, "u", "too short"),
    ).rejects.toMatchObject({ code: "F2F_ATTESTATION_TOO_SHORT", statusCode: 422 });
  });
});
