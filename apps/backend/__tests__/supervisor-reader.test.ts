// apps/backend/__tests__/supervisor-reader.test.ts — M3's SupervisorReader seam over a scripted fake db.
// Each `select()` pops the next scripted result, so the tests also pin the query ORDER (fail-closed
// short-circuits must not issue the later queries).
import type { DbClient } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import {
  SUPERVISORY_ROLE_KEYS,
  createSupervisorReader,
} from "../src/modules/03-authorization/supervisor-reader";

const ORG = "org-1";
const ME = "mem-sup";
const LOC_A = "loc-a";
const LOC_B = "loc-b";

function makeFakeDb(script: readonly unknown[][]) {
  const queue = [...script];
  const probe = { selects: 0, setConfigCalls: [] as string[] };
  const chain = (result: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "leftJoin", "where", "limit"]) c[m] = () => c;
    // biome-ignore lint/suspicious/noThenProperty: the fake Drizzle query chain must be awaitable (thenable)
    c.then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject);
    return c;
  };
  const tx = {
    async execute(q: unknown) {
      probe.setConfigCalls.push(JSON.stringify(q));
    },
    select() {
      probe.selects += 1;
      return chain(queue.shift() ?? []);
    },
  };
  const db = { transaction: async <R>(fn: (t: typeof tx) => Promise<R>) => fn(tx) };
  return { db: db as unknown as DbClient, probe };
}

const platformRole = (key: string) => ({
  roleKey: key,
  roleOrganizationId: null,
  roleCategory: "clinical_leadership",
});

describe("SupervisorReader.membershipLocationIds", () => {
  it("returns the active membership's location scope under an org context", async () => {
    const { db, probe } = makeFakeDb([[{ locationIds: [LOC_A, LOC_B, 7, null] }]]);
    const out = await createSupervisorReader(db).membershipLocationIds({
      organizationId: ORG,
      membershipId: ME,
    });
    expect(out).toEqual([LOC_A, LOC_B]);
    expect(probe.setConfigCalls.join(" ")).toContain(ORG);
  });

  it("returns [] for an unknown / non-active membership (no row)", async () => {
    const { db } = makeFakeDb([[]]);
    expect(
      await createSupervisorReader(db).membershipLocationIds({
        organizationId: ORG,
        membershipId: ME,
      }),
    ).toEqual([]);
  });

  it("returns [] when the stored scope is not an array", async () => {
    const { db } = makeFakeDb([[{ locationIds: { bad: true } }]]);
    expect(
      await createSupervisorReader(db).membershipLocationIds({
        organizationId: ORG,
        membershipId: ME,
      }),
    ).toEqual([]);
  });
});

describe("SupervisorReader.isSupervisorForLocation", () => {
  it("is false, with no role query, when the location is outside the membership's scope", async () => {
    const { db, probe } = makeFakeDb([[{ locationIds: [LOC_A] }]]);
    const ok = await createSupervisorReader(db).isSupervisorForLocation({
      organizationId: ORG,
      membershipId: ME,
      locationId: LOC_B,
    });
    expect(ok).toBe(false);
    expect(probe.selects).toBe(1);
  });

  it("is true for an in-scope location when a supervisory role is held", async () => {
    const { db } = makeFakeDb([[{ locationIds: [LOC_A] }], [platformRole("clinical_supervisor")]]);
    expect(
      await createSupervisorReader(db).isSupervisorForLocation({
        organizationId: ORG,
        membershipId: ME,
        locationId: LOC_A,
      }),
    ).toBe(true);
  });

  it("is false when no supervisory role is held", async () => {
    const { db } = makeFakeDb([[{ locationIds: [LOC_A] }], []]);
    expect(
      await createSupervisorReader(db).isSupervisorForLocation({
        organizationId: ORG,
        membershipId: ME,
        locationId: LOC_A,
      }),
    ).toBe(false);
  });

  it("is false when the only supervisory row is a tenant-owned role in the reserved platform category", async () => {
    const { db } = makeFakeDb([
      [{ locationIds: [LOC_A] }],
      [{ roleKey: "director_of_nursing", roleOrganizationId: ORG, roleCategory: "platform_staff" }],
    ]);
    expect(
      await createSupervisorReader(db).isSupervisorForLocation({
        organizationId: ORG,
        membershipId: ME,
        locationId: LOC_A,
      }),
    ).toBe(false);
  });
});

describe("SupervisorReader tenant-owned role", () => {
  it("a tenant-owned clinical_supervisor role confers supervision", async () => {
    const { db } = makeFakeDb([
      [{ locationIds: [LOC_A] }],
      [
        {
          roleKey: "clinical_supervisor",
          roleOrganizationId: ORG,
          roleCategory: "clinical_leadership",
        },
      ],
    ]);
    expect(
      await createSupervisorReader(db).isSupervisorForLocation({
        organizationId: ORG,
        membershipId: ME,
        locationId: LOC_A,
      }),
    ).toBe(true);
  });
});

describe("SupervisorReader.resolveSupervisedMembershipIds", () => {
  it("returns [] without querying members when the membership is not a supervisor", async () => {
    const { db, probe } = makeFakeDb([[{ locationIds: [LOC_A] }], []]);
    const out = await createSupervisorReader(db).resolveSupervisedMembershipIds({
      organizationId: ORG,
      membershipId: ME,
    });
    expect(out).toEqual([]);
    expect(probe.selects).toBe(2);
  });

  it("returns [] for a supervisor with no locations", async () => {
    const { db, probe } = makeFakeDb([[{ locationIds: [] }]]);
    expect(
      await createSupervisorReader(db).resolveSupervisedMembershipIds({
        organizationId: ORG,
        membershipId: ME,
      }),
    ).toEqual([]);
    expect(probe.selects).toBe(1);
  });

  it("returns the distinct co-located members, never the supervisor itself", async () => {
    const { db } = makeFakeDb([
      [{ locationIds: [LOC_A, LOC_B] }],
      [platformRole("director_of_nursing")],
      [{ id: "m2" }, { id: ME }, { id: "m3" }, { id: "m2" }],
    ]);
    expect(
      await createSupervisorReader(db).resolveSupervisedMembershipIds({
        organizationId: ORG,
        membershipId: ME,
      }),
    ).toEqual(["m2", "m3"]);
  });
});

describe("SUPERVISORY_ROLE_KEYS", () => {
  it("is the documented fixed set", () => {
    expect([...SUPERVISORY_ROLE_KEYS].sort()).toEqual([
      "clinical_supervisor",
      "director_of_nursing",
    ]);
  });
});
