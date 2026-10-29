import { NotFoundError } from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  assertPrescribingPhysicianActive,
  type PhysicianDirectoryPort,
} from "../src/modules/12-dosespot/prescribing-physician-check";

const ORG = "00000000-0000-4000-8000-0000000000a1";
const MDM_ID = "00000000-0000-4000-8000-0000000000b1";

const directory = (
  rows: Record<string, { status: "active" | "deactivated" | "provisional" }>,
): PhysicianDirectoryPort => ({
  resolvePhysician: async (_orgId, id) => rows[id] ?? null,
});

describe("assertPrescribingPhysicianActive (CW-CLIN-008)", () => {
  it("accepts an active physician in the directory", async () => {
    await expect(
      assertPrescribingPhysicianActive(directory({ [MDM_ID]: { status: "active" } }), ORG, MDM_ID),
    ).resolves.toBeUndefined();
  });

  it("rejects an unknown id (also what a record the tenant cannot see resolves to)", async () => {
    await expect(
      assertPrescribingPhysicianActive(directory({}), ORG, MDM_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects a deactivated physician", async () => {
    await expect(
      assertPrescribingPhysicianActive(
        directory({ [MDM_ID]: { status: "deactivated" } }),
        ORG,
        MDM_ID,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("rejects a provisional (unpromoted, no verified NPI) physician", async () => {
    await expect(
      assertPrescribingPhysicianActive(
        directory({ [MDM_ID]: { status: "provisional" } }),
        ORG,
        MDM_ID,
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("resolves within the caller's tenant", async () => {
    const seen: string[] = [];
    await assertPrescribingPhysicianActive(
      {
        resolvePhysician: async (orgId) => {
          seen.push(orgId);
          return { status: "active" };
        },
      },
      ORG,
      MDM_ID,
    );
    expect(seen).toEqual([ORG]);
  });
});
