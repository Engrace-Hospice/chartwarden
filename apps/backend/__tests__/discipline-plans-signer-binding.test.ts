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
  // The assigned aide of an Aide POC: only this membership may fill the CHHA acknowledgment slot.
  aideMembershipId: "m1",
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
  planKind: string = PLAN_ROW.kind,
  planOverrides: Record<string, unknown> = {},
) {
  inserted = [];
  const results: unknown[][] = [
    [{ ...PLAN_ROW, kind: planKind, ...planOverrides }],
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
  planKind?: string,
) =>
  buildDrizzleM15WriteService(fakeDb(signatures, requiredSignerSet, insertError, planKind), {
    isInCaseload: async () => true,
  });

const actor = (membershipId: string, roles: readonly string[]): M15WriteActor => ({
  organizationId: ORG,
  userId: `u_${membershipId}`,
  membershipId,
  roles,
  sessionClass: "staff",
  actorKind: "user",
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

  it("lets only the plan's assigned aide fill the CHHA acknowledgment slot", async () => {
    const aideSet = [{ role: "chha_acknowledgment", count: 1, isAcknowledgment: true }];
    // Another aide of the same org holds the chha role but is not the aide this plan names.
    const err = await service([], aideSet, undefined, "aide_poc")
      .signVersion(actor("m9", ["chha"]), PLAN, VERSION, sign("chha_acknowledgment"))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DisciplinePlanStateError);
    expect((err as DisciplinePlanStateError).code).toBe("SIGNER_ROLE_MISMATCH");
    expect((err as DisciplinePlanStateError).statusCode).toBe(403);
    expect(inserted).toHaveLength(0);
    // The assigned aide ("m1") signs.
    await service([], aideSet, undefined, "aide_poc")
      .signVersion(actor("m1", ["chha"]), PLAN, VERSION, sign("chha_acknowledgment"))
      .catch(() => undefined);
    expect(inserted[0]).toMatchObject({
      signerMembershipId: "m1",
      signerRole: "chha_acknowledgment",
    });
  });

  it("refuses the acknowledgment on a plan that names no aide (fail closed)", async () => {
    const aideSet = [{ role: "chha_acknowledgment", count: 1, isAcknowledgment: true }];
    const noAide = buildDrizzleM15WriteService(
      fakeDb([], aideSet, undefined, "aide_poc", { aideMembershipId: null }),
      { isInCaseload: async () => true },
    );
    await expect(
      noAide.signVersion(actor("m1", ["chha"]), PLAN, VERSION, sign("chha_acknowledgment")),
    ).rejects.toMatchObject({ code: "SIGNER_ROLE_MISMATCH" });
  });

  it("lets a plain RN fill the RN slot of an Aide POC, and of no other plan kind", async () => {
    const aideSet = [
      { role: "rn_case_manager", count: 1, isAcknowledgment: false },
      { role: "chha_acknowledgment", count: 1, isAcknowledgment: true },
    ];
    await service([], aideSet, undefined, "aide_poc")
      .signVersion(actor("m1", ["rn"]), PLAN, VERSION, sign("rn_case_manager"))
      .catch(() => undefined);
    expect(inserted[0]).toMatchObject({ signerMembershipId: "m1", signerRole: "rn_case_manager" });

    for (const kind of ["msw_plan", "volunteer_plan"]) {
      inserted = [];
      await expect(
        service([], undefined, undefined, kind).signVersion(
          actor("m2", ["rn"]),
          PLAN,
          VERSION,
          sign("rn_case_manager"),
        ),
        kind,
      ).rejects.toMatchObject({ code: "SIGNER_ROLE_MISMATCH" });
      expect(inserted, kind).toHaveLength(0);
    }
  });

  it("still refuses an actor with neither rn nor rn_case_manager the Aide POC RN slot", async () => {
    await expect(
      service([], undefined, undefined, "aide_poc").signVersion(
        actor("m3", ["lpn"]),
        PLAN,
        VERSION,
        sign("rn_case_manager"),
      ),
    ).rejects.toMatchObject({ code: "SIGNER_ROLE_MISMATCH" });
  });

  it("takes the acknowledgment flag from the sealed slot, never from the request body", async () => {
    const aideSet = [
      { role: "rn_case_manager", count: 1, isAcknowledgment: false },
      { role: "chha_acknowledgment", count: 1, isAcknowledgment: true },
    ];
    const body = (signerRole: string, isAcknowledgment: boolean) =>
      ({
        expectedVersion: null,
        signerRole,
        attestationText: "I attest",
        isAcknowledgment,
      }) as never;
    await service([], aideSet, undefined, "aide_poc")
      .signVersion(actor("m1", ["chha"]), PLAN, VERSION, body("chha_acknowledgment", false))
      .catch(() => undefined);
    expect(inserted[0]).toMatchObject({
      signerRole: "chha_acknowledgment",
      isAcknowledgment: true,
    });
    inserted = [];
    await service([], aideSet, undefined, "aide_poc")
      .signVersion(actor("m2", ["rn"]), PLAN, VERSION, body("rn_case_manager", true))
      .catch(() => undefined);
    expect(inserted[0]).toMatchObject({ signerRole: "rn_case_manager", isAcknowledgment: false });
  });

  it("records the role key the signer actually held, not only the slot it filled", async () => {
    const aideSet = [
      { role: "rn_case_manager", count: 1, isAcknowledgment: false },
      { role: "chha_acknowledgment", count: 1, isAcknowledgment: true },
    ];
    const signAs = async (roles: readonly string[], slot: string, kind = "aide_poc") => {
      inserted = [];
      await service([], aideSet, undefined, kind)
        .signVersion(actor("m1", roles), PLAN, VERSION, sign(slot))
        .catch(() => undefined);
      return inserted[0];
    };
    // A plain RN fills the case-manager slot: the slot name says rn_case_manager, the held key says rn.
    expect(await signAs(["rn"], "rn_case_manager")).toMatchObject({
      signerRole: "rn_case_manager",
      heldRoleKey: "rn",
    });
    // A holder of both keys is recorded under the slot's own key.
    expect(await signAs(["rn", "rn_case_manager"], "rn_case_manager")).toMatchObject({
      heldRoleKey: "rn_case_manager",
    });
    // The acknowledgment slot is held through the chha key.
    expect(await signAs(["chha"], "chha_acknowledgment")).toMatchObject({ heldRoleKey: "chha" });
  });

  it("records no held role key for the system actor (it holds no role by design)", async () => {
    await service()
      .signVersion(
        systemM15Actor(ORG, { userId: "sys", membershipId: "sysm" }),
        PLAN,
        VERSION,
        sign("msw"),
      )
      .catch(() => undefined);
    expect(inserted[0]).toMatchObject({ heldRoleKey: null });
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
