// Non-live checks for the `admitting_staff` grant lifecycle hooks: the referral-closed consumer only acts on an
// event that names a patient, and the expiry sweep is org-by-org (one org's failure never skips the others,
// and the pass still rejects so BullMQ retries). The real SQL (cutoff, role filter, RLS) is proven live in
// `m6-create-patient-access.live.test.ts`.
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { endAdmittingAssignments } from "../src/modules/05-patient/assignments-db";
import { runAdmittingGrantExpiry } from "../src/modules/05-patient/jobs/admitting-grant-expiry";
import { buildM5ReferralClosedConsumer } from "../src/modules/05-patient/outbox-consumers/m6-referral-closed";

/** A db whose transactions record the `set` payload of each UPDATE; `failFirst` makes the first UPDATE throw. */
function fakeDb(opts: { failFirst?: boolean } = {}) {
  const sets: unknown[] = [];
  const wheres: unknown[] = [];
  const tx = {
    execute: async () => undefined,
    update: () => ({
      set: (v: unknown) => {
        const first = sets.length === 0;
        sets.push(v);
        return {
          where: (w: unknown) => {
            wheres.push(w);
            if (opts.failFirst && first) throw new Error("boom");
            return { returning: async () => [{ id: "a1" }] };
          },
        };
      },
    }),
  };
  return {
    sets,
    wheres,
    db: { transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as never,
  };
}

describe("m5.m6-referral-closed consumer", () => {
  it("does nothing for an event with no patient id", async () => {
    const { sets, db } = fakeDb();
    const consumer = buildM5ReferralClosedConsumer({ db });
    await consumer.handle({ organizationId: "org_a", payload: { referralId: "r1" } });
    expect(sets).toEqual([]);
  });

  it("ends the grant when the event names a patient", async () => {
    const { sets, db } = fakeDb();
    const consumer = buildM5ReferralClosedConsumer({ db });
    await consumer.handle({
      organizationId: "org_a",
      payload: { referralId: "r1", patientId: "p1" },
    });
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ unassignedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });
});

const renderedParams = (where: unknown) =>
  new PgDialect().sqlToQuery(where as never).params as unknown[];

describe("m5.m6-referral-closed consumer: grant holder scoping", () => {
  it("narrows the end to the patient creator when the event names one", async () => {
    const { wheres, db } = fakeDb();
    await buildM5ReferralClosedConsumer({ db }).handle({
      organizationId: "org_a",
      payload: { referralId: "r1", patientId: "p1", patientCreatedByUserId: "u_creator" },
    });
    expect(renderedParams(wheres[0])).toContain("u_creator");
  });

  it("ends the patient-wide set for an older event without a creator", async () => {
    const { wheres, db } = fakeDb();
    await buildM5ReferralClosedConsumer({ db }).handle({
      organizationId: "org_a",
      payload: { referralId: "r1", patientId: "p1" },
    });
    expect(renderedParams(wheres[0])).not.toContain("u_creator");
    expect(renderedParams(wheres[0])).toContain("p1");
  });
});

describe("endAdmittingAssignments (activation / discharge path)", () => {
  it("ends every holder's grant: activation hands access to the care team, so no user filter", async () => {
    const { wheres, db } = fakeDb();
    await (
      db as unknown as { transaction: (fn: (t: never) => Promise<void>) => Promise<void> }
    ).transaction((tx) =>
      endAdmittingAssignments(tx, { organizationId: "org_a", patientId: "p1" }),
    );
    // organization, patient, role: nothing else (a `clinicianUserId` would add a fourth).
    expect(renderedParams(wheres[0])).toHaveLength(3);
  });
});

describe("m5.admitting_grant_expiry sweep", () => {
  const orgs = {
    listActiveOrgs: async () => [{ organizationId: "org_a" }, { organizationId: "org_b" }],
  };

  it("sweeps every org and stamps today's date on what it ends", async () => {
    const { sets, db } = fakeDb();
    const ended = await runAdmittingGrantExpiry({
      db,
      activeOrgs: orgs,
      now: () => new Date("2026-10-20T12:00:00Z"),
    });
    expect(ended).toBe(2);
    expect(sets).toEqual([{ unassignedAt: "2026-10-20" }, { unassignedAt: "2026-10-20" }]);
  });

  it("one org failing does not skip the others, and the pass still rejects", async () => {
    const { sets, db } = fakeDb({ failFirst: true });
    await expect(runAdmittingGrantExpiry({ db, activeOrgs: orgs })).rejects.toThrow(/org_a/);
    expect(sets).toHaveLength(2); // org_b was still processed
  });
});
