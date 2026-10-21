import { REQUIRED_SIGNER_SET_IDG_REVIEW, REQUIRED_SIGNER_SET_INITIAL } from "@chartwarden/types";
// GAP-011 / GAP-012 — care-plan sign-off is bound to the AUTHENTICATED actor, and the Required Signer Set
// can be tightened but never loosened.
//   011: a one-role user cannot stamp another seat (SIGNER_ROLE_MISMATCH 403) and one membership cannot
//        fill a second slot (SIGNER_ALREADY_SIGNED 409).
//   012: finalize's `requiredSignerSet` must COVER the floor; equal LENGTH is not enough.
import { describe, expect, it } from "vitest";
import { createInMemoryCarePlanBackend } from "../src/modules/07-care-plan/index";
import { resolveTightenedSignerSet } from "../src/modules/07-care-plan/lifecycle/required-signer-set";

const ORG = "org_a";
const PATIENT = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "33333333-3333-4333-8333-333333333333";
const AT = "2026-06-21T12:00:00Z";

const actor = (user: string, roles: string[]) => ({
  userId: user,
  membershipId: `${user}_membership`,
  roles,
});

async function inReviewIdgVersion() {
  const { service } = createInMemoryCarePlanBackend();
  const boot = (await service.bootstrapCarePlan(ORG, PATIENT, ADMISSION)) as {
    id: string;
    initialVersionId: string;
  };
  await service.addProblem(ORG, boot.id, {
    description: "Terminal CA",
    kind: "terminal",
    source: "clinical",
  });
  const rn = actor("rn_user", ["rn_case_manager"]);
  const md = actor("md_user", ["hospice_physician"]);
  await service.finalizeVersion(ORG, boot.id, boot.initialVersionId, 1, null);
  await service.signVersion(ORG, boot.id, boot.initialVersionId, 2, "rn_case_manager", AT, rn);
  await service.signVersion(ORG, boot.id, boot.initialVersionId, 3, "hospice_physician", AT, md);
  const review = (await service.createVersion(ORG, boot.id, "idg_review", "idg_meeting_1")) as {
    id: string;
  };
  await service.finalizeVersion(ORG, boot.id, review.id, 1, null);
  return { service, planId: boot.id, versionId: review.id };
}

describe("GAP-011 — signing is bound to the authenticated actor", () => {
  it("rejects a signer role the actor does not hold (403 SIGNER_ROLE_MISMATCH) for every seat", async () => {
    const { service, planId, versionId } = await inReviewIdgVersion();
    const onlyRn = actor("solo", ["rn_case_manager"]);
    for (const role of ["hospice_physician", "msw", "chaplain"] as const) {
      await expect(
        service.signVersion(ORG, planId, versionId, 2, role, AT, onlyRn),
      ).rejects.toMatchObject({ code: "SIGNER_ROLE_MISMATCH", statusCode: 403 });
    }
  });

  it("rejects a second slot signed by the same membership (409 SIGNER_ALREADY_SIGNED)", async () => {
    const { service, planId, versionId } = await inReviewIdgVersion();
    const both = actor("both", ["rn_case_manager", "msw"]);
    await service.signVersion(ORG, planId, versionId, 2, "rn_case_manager", AT, both);
    await expect(
      service.signVersion(ORG, planId, versionId, 3, "msw", AT, both),
    ).rejects.toMatchObject({ code: "SIGNER_ALREADY_SIGNED", statusCode: 409 });
  });

  it("lets four distinct people holding their own role complete the IDG quorum", async () => {
    const { service, planId, versionId } = await inReviewIdgVersion();
    const roles = ["rn_case_manager", "msw", "chaplain", "hospice_physician"] as const;
    let ifVersion = 2;
    let status = "";
    for (const role of roles) {
      const res = (await service.signVersion(
        ORG,
        planId,
        versionId,
        ifVersion,
        role,
        AT,
        actor(`user_${role}`, [role]),
      )) as { status: string };
      status = res.status;
      ifVersion += 1;
    }
    expect(status).toBe("signed");
  });
});

describe("GAP-012 — finalize cannot loosen the Required Signer Set floor", () => {
  it("refuses a same-length set that drops the physician seat", async () => {
    const { service } = createInMemoryCarePlanBackend();
    const boot = (await service.bootstrapCarePlan(ORG, PATIENT, ADMISSION)) as {
      id: string;
      initialVersionId: string;
    };
    await service.addProblem(ORG, boot.id, {
      description: "Terminal CA",
      kind: "terminal",
      source: "clinical",
    });
    await expect(
      service.finalizeVersion(ORG, boot.id, boot.initialVersionId, 1, [
        { role: "rn_case_manager", count: 1 },
        { role: "chaplain", count: 1 },
      ]),
    ).rejects.toMatchObject({ code: "REQUIRED_SIGNER_SET_UNMET" });
  });

  it("accepts the floor plus an extra slot (tightening)", () => {
    const tightened = [...REQUIRED_SIGNER_SET_INITIAL, { role: "msw", count: 1 }];
    expect(resolveTightenedSignerSet(REQUIRED_SIGNER_SET_INITIAL, tightened)).toEqual(tightened);
  });

  it("accepts a narrower physician seat (NP removed) but not a lower count or an unknown role", () => {
    const narrower = [
      { role: "hospice_physician", count: 1 },
      { role: "rn_case_manager", count: 1 },
    ];
    expect(resolveTightenedSignerSet(REQUIRED_SIGNER_SET_INITIAL, narrower)).toEqual(narrower);
    expect(() =>
      resolveTightenedSignerSet(REQUIRED_SIGNER_SET_INITIAL, [
        { role: "hospice_physician|nurse_practitioner", count: 1 },
        { role: "rn_case_manager", count: 1 },
        { role: "wizard", count: 1 },
      ]),
    ).toThrow(/unknown signer role/);
  });

  it("does not let one requested slot stand in for two floor slots", () => {
    expect(() =>
      resolveTightenedSignerSet(REQUIRED_SIGNER_SET_IDG_REVIEW, [
        { role: "rn_case_manager", count: 1 },
        { role: "rn_case_manager", count: 1 },
        { role: "msw", count: 1 },
        { role: "chaplain", count: 1 },
      ]),
    ).toThrow(/loosen the floor/);
  });
});
