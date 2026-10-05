// apps/backend/__tests__/discipline-derivation.test.ts — F-030.
//
// THE DEFECT. Seven modules — M7, M8, M9, M10, M11, M12, M13 — each assembled the caller's clinical
// discipline set by unioning `context.attributes.disciplines` with the session role keys. No producer in
// the platform has ever written that attribute, so the union was with the empty set on every request the
// codebase has ever served, and the role arm was the entire answer everywhere.
//
// WHY IT SURVIVED. Unlike the other F-030 keys, no test EVER supplied this one — not a live suite, not an
// inject shim, not a unit fixture. It did not need to be faked, because the role arm silently answered and
// the derivation degraded instead of dying. Seven copies of a two-armed derivation whose second arm has
// never once contributed.
//
// THE DECISION. The reads go; the platform keeps ONE derivation. That is not this file's invention — M19's
// `TRIAGE_DISCIPLINE_FOR_ROLE_KEY` states the rule ("M3's `RoleGrant.roleKey` is the platform's one
// authority-derivation input"), and M17, which owns both the discipline vocabulary and the
// `membership_credential` table, resolves its own D8 pre-schedule gate exactly this way. M17 reads the
// credential for the ORTHOGONAL question — is the licence currently active — because a clinician can hold
// the `rn` role while their licence has lapsed. Authority comes from the grant; the credential says
// whether it is exercisable.
//
// WHAT THIS FILE PINS. Each derivation answers from role keys, AND a stray `disciplines` attribute cannot
// change the answer. The second half is the load-bearing one: it means a future producer of that key
// cannot silently widen seven modules' clinical floors — controlled-substance prescribing, medication
// administration, order authoring, scale recording — without a deliberate edit here.
import type { AbacContext } from "@wardenx/auth";
import { describe, expect, it } from "vitest";
import { disciplineScopeOf } from "../src/modules/07-care-plan/abac-predicates";
import { buildEncounterAbacPredicates } from "../src/modules/08-encounters/abac-predicates";
import { disciplinesOf } from "../src/modules/09-assessments/abac-predicates";
import { hopeDisciplinesOf } from "../src/modules/10-hope/abac-predicates";
import { orderDisciplinesOf } from "../src/modules/11-orders/abac-predicates";
import { prescriberDisciplinesOf } from "../src/modules/12-dosespot/abac-predicates";
import { actorDisciplinesOf } from "../src/modules/13-emar/abac-predicates";

const ORG = "org-1";
const ctx = (roles: readonly string[], attributes: Record<string, unknown> = {}): AbacContext =>
  ({
    organizationId: ORG,
    userId: "u1",
    roles: [...roles],
    providerEntityIds: [],
    locationIds: [],
    attributes: { membershipId: "m1", ...attributes },
  }) as AbacContext;

/** The six exported set-derivations, each with the role key it must recognise and its normalization. */
const DERIVATIONS = [
  {
    module: "M09 assessments",
    of: (c: AbacContext) => [...disciplinesOf(c)],
    role: "rn",
    expect: "rn",
  },
  {
    module: "M10 hope (uppercased to the HOPE codes)",
    of: (c: AbacContext) => [...hopeDisciplinesOf(c)],
    role: "rn",
    expect: "RN",
  },
  {
    module: "M11 orders (lower-cased for the @wardenx/orders matrices)",
    of: (c: AbacContext) => [...orderDisciplinesOf(c)],
    role: "np",
    expect: "np",
  },
  {
    module: "M12 dosespot",
    of: (c: AbacContext) => [...prescriberDisciplinesOf(c)],
    role: "md",
    expect: "md",
  },
  {
    module: "M13 emar",
    of: (c: AbacContext) => [...actorDisciplinesOf(c)],
    role: "lpn",
    expect: "lpn",
  },
  {
    module: "M07 care-plan",
    of: (c: AbacContext) => [...disciplineScopeOf(c).disciplines],
    role: "msw",
    expect: "msw",
  },
] as const;

describe("F-030 — the clinical discipline set derives from role keys, in every module that asks", () => {
  for (const { module, of, role, expect: want } of DERIVATIONS) {
    it(`${module} — resolves the granted role key`, () => {
      expect(of(ctx([role]))).toContain(want);
    });

    it(`${module} — a stray \`disciplines\` attribute cannot widen the answer`, () => {
      // Forged or not, this key is not an input. If some future producer stamps it, the seven clinical
      // floors that used to union it in must NOT start honouring it by accident — that decision belongs
      // in a commit, not in whatever happens to land on the attributes bag.
      const withStray = of(ctx([role], { disciplines: ["md", "np", "rn", "pa"] }));
      expect(withStray).toEqual(of(ctx([role])));
    });

    it(`${module} — an actor holding no discipline role resolves to nothing`, () => {
      expect(of(ctx(["org_admin"], { disciplines: ["md"] }))).not.toContain(want);
    });
  }

  // M8's derivation is a private `isRn` behind the cosign predicate, so it is exercised through the gate
  // it guards rather than directly — the same fact, reached the way a request reaches it.
  describe("M08 encounters — `m8.cosigner_role_match` reads the RN discipline off role keys", () => {
    const build = (authoredByUserId: string) =>
      buildEncounterAbacPredicates({
        resolver: {
          async loadEncounter(_organizationId: string, encounterId: string) {
            return {
              encounterId,
              patientId: "p1",
              discipline: "rn" as const,
              authoredByUserId,
            };
          },
          async loadAddendumAuthor() {
            return null;
          },
        },
        async isInCaseload() {
          return true;
        },
      })["m8.cosigner_role_match"];

    const target = { encounterId: "e1" };

    it("an RN role key satisfies the RN requirement", async () => {
      expect(await build("u2")(ctx(["rn"]), target)).toBe(true);
      expect(await build("u2")(ctx(["rn_case_manager"]), target)).toBe(true);
    });

    it("a non-RN clinician is refused even carrying a `disciplines` attribute that claims RN", async () => {
      expect(await build("u2")(ctx(["chaplain"], { disciplines: ["rn"] }), target)).toBe(false);
    });

    it("GAP-029 — refuses the author's own MEMBERSHIP even when the user id differs", async () => {
      // ctx() is user "u1" / membership "m1"; the encounter was authored by membership "m1".
      expect(await build("m1")(ctx(["rn"]), target)).toBe(false);
    });

    it("GAP-029 — a different membership may cosign even if its user id equals the author's id", async () => {
      expect(await build("u1")(ctx(["rn"]), target)).toBe(true);
    });

    it("still refuses a self-cosign — removing the dead arm did not relax the other rule", async () => {
      expect(await build("m1")(ctx(["rn"]), target)).toBe(false);
    });
  });
});
