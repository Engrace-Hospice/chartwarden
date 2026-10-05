// apps/backend/__tests__/discipline-plans-signer-binding.test.ts — GAP-045: the M15 quorum signer is bound
// to the AUTHENTICATED actor. The claimed `signerRole` must be one the actor holds (403 SIGNER_ROLE_MISMATCH,
// the §2.3 code) and one membership may fill at most ONE slot per version (409 SIGNER_ALREADY_SIGNED), so a
// single person can no longer satisfy the MSW + RN quorum alone. Drives the Drizzle write service over a fake tx.
import { describe, expect, it } from "vitest";
import { DisciplinePlanStateError } from "../src/modules/15-discipline-care-plans/lifecycle/index";
import {
  type M15WriteActor,
  buildDrizzleM15WriteService,
  systemM15Actor,
} from "../src/modules/15-discipline-care-plans/routes/index";

const ORG = "org_a";
const PLAN = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const PLAN_ROW = {
  id: PLAN,
  organizationId: ORG,
  patientId: "p1",
  status: "active",
  kind: "msw_plan",
  version: 1,
};
const VERSION_ROW = {
  id: VERSION,
  planId: PLAN,
  status: "in_review",
  kind: "initial",
  version: 1,
  requiredSignerSet: [
    { role: "msw", count: 1, isAcknowledgment: false },
    { role: "rn_case_manager", count: 1, isAcknowledgment: false },
  ],
};

let inserted: unknown[] = [];

/** select() results in call order: plan, version, collected signatures. Everything past that is a no-op. */
function fakeDb(
  signatures: readonly Record<string, unknown>[],
  requiredSignerSet: unknown = VERSION_ROW.requiredSignerSet,
  insertError?: unknown,
) {
  inserted = [];
  const results: unknown[][] = [
    [PLAN_ROW],
    [{ ...VERSION_ROW, requiredSignerSet }],
    [...signatures],
  ];
  const tx = {
    execute: async () => [],
    select: () => {
      const rows = results.shift() ?? [];
      const chain: Promise<unknown[]> = Object.assign(Promise.resolve(rows), {
        from: (): unknown => chain,
        where: (): unknown => chain,
        orderBy: (): unknown => chain,
        limit: async () => rows,
      });
      return chain;
    },
    insert: () => ({
      values: (v: unknown) => {
        if (insertError) throw insertError;
        inserted.push(v);
        return { returning: async () => [v] };
      },
    }),
    update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
  };
  return { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) } as never;
}

const service = (
  signatures: readonly Record<string, unknown>[] = [],
  requiredSignerSet?: unknown,
  insertError?: unknown,
) =>
  buildDrizzleM15WriteService(fakeDb(signatures, requiredSignerSet, insertError), {
    isInCaseload: async () => true,
  });

const actor = (membershipId: string, roles: readonly string[]): M15WriteActor => ({
  organizationId: ORG,
  userId: `u_${membershipId}`,
  membershipId,
  roles,
  sessionClass: "staff",
  locationIds: [],
  stepUpRecent: true,
});

const sign = (signerRole: string) =>
  ({ expectedVersion: null, signerRole, attestationText: "I attest" }) as never;

describe("M15 signVersion — the signer role is bound to the authenticated actor (GAP-045)", () => {
  it("refuses a claimed role the actor does not hold with 403 SIGNER_ROLE_MISMATCH", async () => {
    const err = await service()
      .signVersion(actor("m1", ["rn_case_manager"]), PLAN, VERSION, sign("msw"))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisciplinePlanStateError);
    expect((err as DisciplinePlanStateError).code).toBe("SIGNER_ROLE_MISMATCH");
    expect((err as DisciplinePlanStateError).statusCode).toBe(403);
    expect(inserted).toHaveLength(0);
  });

  it("refuses an actor with no roles at all", async () => {
    await expect(
      service().signVersion(actor("m1", []), PLAN, VERSION, sign("msw")),
    ).rejects.toMatchObject({ code: "SIGNER_ROLE_MISMATCH" });
  });

  it("refuses a second signature by the same membership even when it holds both roles (409)", async () => {
    const prior = [{ signerMembershipId: "m1", signerRole: "msw" }];
    const err = await service(prior)
      .signVersion(actor("m1", ["msw", "rn_case_manager"]), PLAN, VERSION, sign("rn_case_manager"))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisciplinePlanStateError);
    expect((err as DisciplinePlanStateError).code).toBe("SIGNER_ALREADY_SIGNED");
    expect((err as DisciplinePlanStateError).statusCode).toBe(409);
    expect(inserted).toHaveLength(0);
  });

  it("maps a concurrent-sign 23505 on the one-slot-per-membership index to 409 SIGNER_ALREADY_SIGNED", async () => {
    // Drizzle wraps the driver error: the Postgres code/constraint sit on `.cause`.
    const driver = Object.assign(new Error("duplicate key"), {
      code: "23505",
      constraint: "discipline_care_plan_signature_version_membership_uq",
    });
    const wrapped = Object.assign(new Error("Failed query: insert ..."), { cause: driver });
    for (const raised of [driver, wrapped]) {
      const err = await service([], undefined, raised)
        .signVersion(actor("m1", ["msw"]), PLAN, VERSION, sign("msw"))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DisciplinePlanStateError);
      expect((err as DisciplinePlanStateError).code).toBe("SIGNER_ALREADY_SIGNED");
      expect((err as DisciplinePlanStateError).statusCode).toBe(409);
    }
  });

  it("maps the 0329 trigger's 23505 (constraint field absent, name only in the message) to 409", async () => {
    const trigger = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "discipline_care_plan_signature_version_membership_uq"',
      ),
      { code: "23505" },
    );
    const wrapped = Object.assign(new Error("Failed query: insert ..."), { cause: trigger });
    for (const raised of [trigger, wrapped]) {
      const err = await service([], undefined, raised)
        .signVersion(actor("m1", ["msw"]), PLAN, VERSION, sign("msw"))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DisciplinePlanStateError);
      expect((err as DisciplinePlanStateError).code).toBe("SIGNER_ALREADY_SIGNED");
    }
  });

  it("leaves a 23505 on any OTHER constraint untouched (not mapped to a 409)", async () => {
    const other = Object.assign(new Error("dup"), { code: "23505", constraint: "something_else" });
    await expect(
      service([], undefined, other).signVersion(actor("m1", ["msw"]), PLAN, VERSION, sign("msw")),
    ).rejects.toBe(other);
  });

  it("does not echo the body-supplied signerRole in the SIGNER_ROLE_MISMATCH message", async () => {
    const err = await service()
      .signVersion(actor("m1", ["rn_case_manager"]), PLAN, VERSION, sign("<script>msw</script>"))
      .catch((e: unknown) => e);
    expect((err as DisciplinePlanStateError).code).toBe("SIGNER_ROLE_MISMATCH");
    expect((err as DisciplinePlanStateError).message).not.toContain("script");
    expect((err as DisciplinePlanStateError).message).not.toContain("msw");
  });

  it("lets a holder of the role sign, attributing the row to the server-side membership", async () => {
    await service([{ signerMembershipId: "m2", signerRole: "rn_case_manager" }])
      .signVersion(actor("m1", ["msw"]), PLAN, VERSION, sign("msw"))
      .catch(() => undefined);
    expect(inserted[0]).toMatchObject({ signerMembershipId: "m1", signerRole: "msw" });
  });

  it("maps the chha_acknowledgment slot onto the chha role key", async () => {
    const aideSet = [{ role: "chha_acknowledgment", count: 1, isAcknowledgment: true }];
    await service([], aideSet)
      .signVersion(actor("m1", ["chha"]), PLAN, VERSION, sign("chha_acknowledgment"))
      .catch(() => undefined);
    expect(inserted[0]).toMatchObject({
      signerMembershipId: "m1",
      signerRole: "chha_acknowledgment",
    });
    await expect(
      service([], aideSet).signVersion(
        actor("m2", ["msw"]),
        PLAN,
        VERSION,
        sign("chha_acknowledgment"),
      ),
    ).rejects.toMatchObject({ code: "SIGNER_ROLE_MISMATCH" });
  });

  it("exempts the explicit system actor from the role check (internal callers hold no roles)", async () => {
    await service()
      .signVersion(
        systemM15Actor(ORG, { userId: "sys", membershipId: "sysm" }),
        PLAN,
        VERSION,
        sign("msw"),
      )
      .catch(() => undefined);
    expect(inserted[0]).toMatchObject({ signerMembershipId: "sysm", signerRole: "msw" });
  });
});
