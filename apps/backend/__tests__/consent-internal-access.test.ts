/**
 * M39 §4.3 — `evaluateForInternalAccess`, the PER-ACTOR 42 CFR Part 2 decision, and the two
 * consumers that resolve through it.
 *
 * THE GAP THIS CLOSES. Every recipient class M39 shipped with is EXTERNAL (external_physician,
 * facility, pharmacy, irb, family_member, attorney, employer, researcher, free_text). A consent
 * record could therefore name who OUTSIDE the agency may receive a patient's records and could not
 * name who INSIDE it may — which left the question the spec's own `sud_disclosure_allowed` is defined
 * by ("returns allowed=true AND recipient matches the requesting party", §6.4, consumed by M7, M8, M9,
 * M11, M12, M13, M14, M15, M22, M28) with no backing fact at all. Internal callers got the
 * patient-scope answer instead — `evaluateForIngressRedaction`, "does a release exist" — which is a
 * true answer to a different question. `workforce_member` (mig 0209) is the missing fact.
 *
 * THE RULE UNDER TEST, stated once: a release naming NO workforce member authorizes the treating
 * program as a whole (42 CFR §2.12(c)(3) — communications within a program are not disclosures);
 * naming any RESTRICTS the release to those named. It narrows, never widens, so no existing consent
 * record changes meaning.
 */
import type { AbacContext } from "@wardenx/auth";
import {
  type StoredConsent,
  type StoredRecipient,
  createConsentEvaluator,
  createInMemoryConsentStore,
} from "@wardenx/consent";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  buildCarePlanAbacPredicates,
  defaultInternalSudAccessChecker,
  sudDisclosureAllowedForPatient,
} from "../src/modules/07-care-plan/abac-predicates";
import { createInMemoryCarePlanBackend } from "../src/modules/07-care-plan/routes/service";

const ORG = "org-1";
const PAT = "pat-1";
const ME = "membership-me";
const SOMEONE_ELSE = "membership-other";

function recipient(over: Partial<StoredRecipient> = {}): StoredRecipient {
  return { removedAtMs: null, expiresAtMs: null, ...over };
}

/** A workforce recipient — the internal class mig 0209 added; id space = M2 membership. */
function workforce(membershipId: string, over: Partial<StoredRecipient> = {}): StoredRecipient {
  return recipient({
    recipientResolvedKind: "workforce_member",
    recipientResolvedId: membershipId,
    ...over,
  });
}

function part2Release(recipients: StoredRecipient[], over: Partial<StoredConsent> = {}) {
  const base: StoredConsent = {
    id: "c1",
    organizationId: ORG,
    patientId: PAT,
    typeKey: "42_cfr_part_2_release",
    status: "active",
    version: 1,
    effectiveAtMs: 0,
    expiresAtMs: null,
    survivesDeath: false,
    scopeDescriptor: {},
    recipients,
  };
  return { ...base, ...over };
}

function evaluatorOver(consents: StoredConsent[]) {
  const { store } = createInMemoryConsentStore({ consents, deceasedPatientIds: new Set() });
  return createConsentEvaluator(store);
}

const ask = (consents: StoredConsent[], membershipId: string | null) =>
  evaluatorOver(consents).evaluateForInternalAccess({
    organizationId: ORG,
    patientId: PAT,
    actor: { membershipId },
    callerModule: "m9",
  });

describe("M39 evaluateForInternalAccess — the per-actor Part 2 verdict", () => {
  it("redacts when NO release is on file, for anyone", async () => {
    const v = await ask([], ME);
    expect(v.redactSubstanceUseDisorderFields).toBe(true);
    expect(v.basis).toBe("no_active_release");
    expect(v.consentRecordId).toBeUndefined();
  });

  it("a release naming NO workforce member covers the treating program — every actor alike", async () => {
    // The §2.12(c)(3) default, and the behaviour every existing consent record already has: this is
    // what makes the new class purely additive.
    const consents = [part2Release([recipient({ recipientResolvedId: "external-hospital-1" })])];
    for (const actor of [ME, SOMEONE_ELSE, null]) {
      const v = await ask(consents, actor);
      expect(v.redactSubstanceUseDisorderFields).toBe(false);
      expect(v.basis).toBe("release_covers_program");
      expect(v.consentRecordId).toBe("c1");
    }
  });

  it("a release that names workforce members discloses to those named", async () => {
    const v = await ask([part2Release([workforce(ME), workforce(SOMEONE_ELSE)])], ME);
    expect(v.redactSubstanceUseDisorderFields).toBe(false);
    expect(v.basis).toBe("release_names_actor");
  });

  it("…and redacts for a workforce member it does NOT name", async () => {
    const v = await ask([part2Release([workforce(SOMEONE_ELSE)])], ME);
    expect(v.redactSubstanceUseDisorderFields).toBe(true);
    expect(v.basis).toBe("release_names_others");
  });

  it("redacts against a restricted release when the caller cannot say who is asking", async () => {
    // A session with no membership id cannot be one of the named — the honest answer is redact, not
    // "probably fine".
    const v = await ask([part2Release([workforce(SOMEONE_ELSE)])], null);
    expect(v.redactSubstanceUseDisorderFields).toBe(true);
    expect(v.basis).toBe("actor_unidentified");
  });

  it("a REMOVED or EXPIRED workforce recipient does not GRANT, and does not re-widen the release", async () => {
    // 2026-08-14 review — this used to answer `release_covers_program`, i.e. removing the last named
    // recipient turned SUD redaction OFF for the whole org. Narrowing a recipient list to zero must
    // never grant strictly more access than leaving one name on it. A restricted release with no
    // live recipient names nobody: everyone is `release_names_others`.
    const removed = await ask([part2Release([workforce(SOMEONE_ELSE, { removedAtMs: 1 })])], ME);
    expect(removed.basis).toBe("release_names_others");
    expect(removed.redactSubstanceUseDisorderFields).toBe(true);

    const expired = await ask([part2Release([workforce(SOMEONE_ELSE, { expiresAtMs: 1 })])], ME);
    expect(expired.basis).toBe("release_names_others");
    expect(expired.redactSubstanceUseDisorderFields).toBe(true);

    // A removed recipient does not GRANT either — being the departed name buys nothing.
    const wasNamed = await ask([part2Release([workforce(ME, { removedAtMs: 1 })])], ME);
    expect(wasNamed.redactSubstanceUseDisorderFields).toBe(true);

    // An expired one alongside a LIVE one leaves the restriction standing, and the live name grants.
    const stillRestricted = await ask(
      [part2Release([workforce(SOMEONE_ELSE, { expiresAtMs: 1 }), workforce(SOMEONE_ELSE)])],
      ME,
    );
    expect(stillRestricted.basis).toBe("release_names_others");
    const liveNamed = await ask(
      [part2Release([workforce(SOMEONE_ELSE, { expiresAtMs: 1 }), workforce(ME)])],
      ME,
    );
    expect(liveNamed.basis).toBe("release_names_actor");
  });

  it("a release that NEVER named a workforce member still covers the treating program", async () => {
    // The §2.12(c)(3) case is unchanged: the fix above distinguishes "never restricted" from
    // "restricted, named parties now gone" — only the second one stays redacted.
    const external = await ask([part2Release([])], ME);
    expect(external.basis).toBe("release_covers_program");
    expect(external.redactSubstanceUseDisorderFields).toBe(false);
  });

  it("a revoked or expired release redacts however it names the actor", async () => {
    for (const over of [
      { status: "revoked" as const },
      { expiresAtMs: 1 },
      { status: "draft" as const },
    ]) {
      const v = await ask([part2Release([workforce(ME)], over)], ME);
      expect(v.redactSubstanceUseDisorderFields).toBe(true);
      expect(v.basis).toBe("no_active_release");
    }
  });

  it("does NOT leak across patients or tenants", async () => {
    const other = part2Release([workforce(ME)], { patientId: "pat-2" });
    expect((await ask([other], ME)).basis).toBe("no_active_release");
    const otherOrg = part2Release([workforce(ME)], { organizationId: "org-2" });
    expect((await ask([otherOrg], ME)).basis).toBe("no_active_release");
  });

  it("stays independent of evaluateForIngressRedaction, which remains patient-scoped", async () => {
    // The two coexist on purpose: M29's inbound-frame persistence has no actor to key on, and M9's
    // read service carries none through its signatures. A restricted release must not change what
    // ingress does.
    const evaluator = evaluatorOver([part2Release([workforce(SOMEONE_ELSE)])]);
    const ingress = await evaluator.evaluateForIngressRedaction({
      organizationId: ORG,
      patientId: PAT,
      callerModule: "m29",
    });
    expect(ingress.redactSubstanceUseDisorderFields).toBe(false); // a release exists
    const internal = await evaluator.evaluateForInternalAccess({
      organizationId: ORG,
      patientId: PAT,
      actor: { membershipId: ME },
      callerModule: "m9",
    });
    expect(internal.redactSubstanceUseDisorderFields).toBe(true); // …but not for me
  });
});

// ── M7's `sud_disclosure_allowed`, the name nine other modules bind ──────────────────────────────

function context(over: Partial<AbacContext> = {}): AbacContext {
  return {
    organizationId: ORG,
    userId: "user-1",
    roles: [],
    providerEntityIds: [],
    locationIds: [],
    attributes: { membershipId: ME },
    ...over,
  };
}

describe("M7 sud_disclosure_allowed — resolved per actor through M39", () => {
  beforeEach(() => __resetSeamsForTest());

  it("forwards the actor's membership id from the session attributes, never the request body", async () => {
    let seen: { membershipId: string | null } | undefined;
    registerSeam("ConsentEvaluator", {
      evaluateForInternalAccess: async (args: { actor: { membershipId: string | null } }) => {
        seen = args.actor;
        return { redactSubstanceUseDisorderFields: false, basis: "release_names_actor" };
      },
    });
    await sudDisclosureAllowedForPatient(context(), PAT, defaultInternalSudAccessChecker());
    expect(seen).toEqual({ membershipId: ME });
  });

  it("clears a named workforce member who holds no special role", async () => {
    registerSeam("ConsentEvaluator", createEvaluatorSeam([part2Release([workforce(ME)])]));
    const allowed = await sudDisclosureAllowedForPatient(
      context(),
      PAT,
      defaultInternalSudAccessChecker(),
    );
    expect(allowed).toBe(true);
  });

  it("the RN Case Manager still reads a chart with NO release on file (§2.12(c)(3) treatment path)", async () => {
    registerSeam("ConsentEvaluator", createEvaluatorSeam([]));
    const allowed = await sudDisclosureAllowedForPatient(
      context({ roles: ["rn_case_manager"] }),
      PAT,
      defaultInternalSudAccessChecker(),
    );
    expect(allowed).toBe(true);
  });

  it("…but does NOT override a release restricted to other named workforce members", async () => {
    registerSeam(
      "ConsentEvaluator",
      createEvaluatorSeam([part2Release([workforce(SOMEONE_ELSE)])]),
    );
    const allowed = await sudDisclosureAllowedForPatient(
      context({ roles: ["rn_case_manager"] }),
      PAT,
      defaultInternalSudAccessChecker(),
    );
    // This is the behaviour the whole change exists for: the patient named who may see this, and a
    // role key does not outrank the person who signed the release.
    expect(allowed).toBe(false);
  });

  it("fails CLOSED in both fields on a seam error — an outage is not 'unrestricted'", async () => {
    registerSeam("ConsentEvaluator", {
      evaluateForInternalAccess: async () => {
        throw new Error("consent store unavailable");
      },
    });
    // Even the role path is denied: if an M39 outage read as "no restriction exists", it would hand
    // the case-manager path a disclosure the consent record might forbid.
    for (const roles of [[], ["rn_case_manager"]]) {
      await expect(
        sudDisclosureAllowedForPatient(context({ roles }), PAT, defaultInternalSudAccessChecker()),
      ).resolves.toBe(false);
    }
  });

  it("the registered predicate resolves the same way for a SUD problem", async () => {
    registerSeam(
      "ConsentEvaluator",
      createEvaluatorSeam([part2Release([workforce(SOMEONE_ELSE)])]),
    );
    const { service, resolver } = createInMemoryCarePlanBackend({
      plans: [{ id: "plan-1", organizationId: ORG, patientId: PAT, status: "draft" }],
    });
    const predicates = buildCarePlanAbacPredicates({ resolver, isInCaseload: async () => false });
    const sud = await service.addProblem(ORG, "plan-1", {
      description: "SUD",
      kind: "related",
      source: "clinical",
      sudRelated: true,
    });
    const nonSud = await service.addProblem(ORG, "plan-1", {
      description: "Pain",
      kind: "terminal",
      source: "clinical",
    });
    // A non-SUD problem never reaches M39 at all (§7.6).
    expect(await predicates.sud_disclosure_allowed(context(), { elementId: nonSud.id })).toBe(true);
    expect(await predicates.sud_disclosure_allowed(context(), { elementId: sud.id })).toBe(false);
    // The actor the release names does get it — same predicate, same release, different actor.
    expect(
      await predicates.sud_disclosure_allowed(
        context({ attributes: { membershipId: SOMEONE_ELSE } }),
        { elementId: sud.id },
      ),
    ).toBe(true);
  });
});

/** A registry-shaped ConsentEvaluator over an in-memory dataset. */
function createEvaluatorSeam(consents: StoredConsent[]) {
  return evaluatorOver(consents) as unknown as Record<string, unknown>;
}
