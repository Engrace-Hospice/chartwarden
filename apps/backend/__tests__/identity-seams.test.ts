// apps/backend/__tests__/identity-seams.test.ts — M2-T07 published-seam registration (M2 spec §4.7).
//
// Proves M2's two boot-validated cross-module seams register over the M1 deny-stubs and pass
// validateSeams():
//   • SessionContextResolver — resolves actor + step-up state; org-scoped (no cross-tenant leak).
//   • AuditorSessionMinter   — mints a magic-link token for an M3-owned engagement (D4).
// Also asserts the fail-closed baseline (unregistered ⇒ deny-stub throws) still holds, and that
// the composition-root `wireModuleSeams` hook wires both during a real buildServer() boot.
import {
  createInMemoryAuditorMagicLinkIssuer,
  createInMemorySessionContextStore,
} from "@wardenx/auth";
import { beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { NotImplementedError } from "../src/bootstrap/seams/providers";
import { __resetSeamsForTest, getSeam, validateSeams } from "../src/bootstrap/seams/registry";
import { wireModuleSeams } from "../src/index";
import { registerIdentitySeams } from "../src/modules/02-identity/index";

const ORG = "org_1";
const OTHER_ORG = "org_2";

describe("M2-T07 — published seams register over the M1 deny-stubs (§4.7)", () => {
  beforeEach(() => __resetSeamsForTest());

  it("registers SessionContextResolver + AuditorSessionMinter so validateSeams() passes", () => {
    registerIdentitySeams();
    expect(() => validateSeams()).not.toThrow();
    // Real impls, not the deny-stub: calling them does NOT throw NotImplementedError.
    expect(getSeam("SessionContextResolver")).toBeDefined();
    expect(getSeam("AuditorSessionMinter")).toBeDefined();
  });

  it("SessionContextResolver resolves actor + step-up state, org-scoped (no cross-tenant leak)", async () => {
    const at = new Date("2026-06-14T12:00:00Z");
    const { store } = createInMemorySessionContextStore([
      {
        providerEntityIds: [],
        locationIds: [],
        sessionClass: "staff",
        portalAccountId: null,
        sessionPatientId: null,
        sessionId: "sess_1",
        userId: "user_1",
        membershipId: "mem_1",
        organizationId: ORG,
        roles: ["clinical_rn"],
        lastStepUpAt: at,
        lastStepUpFactor: "webauthn",
      },
    ]);
    registerIdentitySeams({ sessions: store });
    validateSeams();
    const resolver = getSeam("SessionContextResolver");

    const actor = await resolver.resolveActor({ orgId: ORG }, "sess_1");
    // The FULL `ResolvedActor` shape, not the four fields this seeded row happens to set. It used to
    // assert only those four and passed because `toEqual` reads an absent property and an `undefined`
    // one as equal — so every field the actor gained after this test was written (the PE/location
    // scopes, the session class, the portal anchors, the device attestation) went unasserted here, and
    // one of them silently disappearing would not have failed anything.
    expect(actor).toEqual({
      userId: "user_1",
      membershipId: "mem_1",
      organizationId: ORG,
      roles: ["clinical_rn"],
      // These five used to be asserted as `undefined`, which is what the seeded row produced while it
      // omitted them — a shape the real store can never return (F-098). The seed now carries them, so
      // the assertion is the actor a staff session actually resolves to.
      providerEntityIds: [],
      locationIds: [],
      sessionClass: "staff",
      portalAccountId: null,
      sessionPatientId: null,
      // Explicitly null rather than undefined: a session with no attested device behind it must read
      // as a decided "no device", which is what the §12.4 gate denies on.
      deviceAttestation: null,
      externalActorId: null,
    });
    const stepUp = await resolver.resolveStepUpState({ orgId: ORG }, "sess_1");
    expect(stepUp).toEqual({ lastStepUpAt: at, lastStepUpFactor: "webauthn" });

    // A different tenant's scope resolves to null — the seam cannot leak the session.
    expect(await resolver.resolveActor({ orgId: OTHER_ORG }, "sess_1")).toBeNull();
    expect(await resolver.resolveStepUpState({ orgId: OTHER_ORG }, "sess_1")).toBeNull();
    // An unknown session is null, not a throw.
    expect(await resolver.resolveActor({ orgId: ORG }, "sess_missing")).toBeNull();
  });

  it("AuditorSessionMinter mints a token for a valid window and refuses an inverted one", async () => {
    const { issuer, minted } = createInMemoryAuditorMagicLinkIssuer();
    registerIdentitySeams({ auditorLinks: issuer });
    validateSeams();
    const minter = getSeam("AuditorSessionMinter");

    const out = await minter.mintAuditorSession({
      engagementId: "eng_1",
      organizationId: ORG,
      identity: { name: "Pat Auditor", email: "pat@audit.example" },
      window: { start: new Date("2026-06-14T00:00:00Z"), end: new Date("2026-06-21T00:00:00Z") },
    });
    expect(out.magicLinkToken).toEqual(expect.any(String));
    expect(minted()).toHaveLength(1);

    await expect(
      minter.mintAuditorSession({
        engagementId: "eng_2",
        organizationId: ORG,
        identity: { name: "X", email: "x@audit.example" },
        window: { start: new Date("2026-06-21T00:00:00Z"), end: new Date("2026-06-14T00:00:00Z") },
      }),
    ).rejects.toThrow(/start < end/);
  });

  it("without registration the seams boot FAIL-CLOSED (deny-stub throws on call)", () => {
    validateSeams(); // no module registered anything → deny-stub defaults applied
    // The deny-stub throws synchronously on call (it never returns a promise).
    const resolver = getSeam("SessionContextResolver");
    expect(() => resolver.resolveActor({ orgId: ORG }, "sess_1")).toThrow(NotImplementedError);
    const minter = getSeam("AuditorSessionMinter");
    expect(() =>
      minter.mintAuditorSession({
        engagementId: "eng_1",
        organizationId: ORG,
        identity: { name: "X", email: "x@audit.example" },
        window: { start: new Date("2026-06-14T00:00:00Z"), end: new Date("2026-06-21T00:00:00Z") },
      }),
    ).toThrow(NotImplementedError);
  });

  it("the composition-root wireModuleSeams hook registers M2's seams during buildServer() boot", () => {
    const app = buildServer({ registerModuleSeams: wireModuleSeams });
    // Boot completed (validateSeams() did not throw) AND the seam is the real impl.
    const resolver = getSeam("SessionContextResolver");
    return resolver.resolveActor({ orgId: ORG }, "sess_missing").then((actor) => {
      expect(actor).toBeNull(); // resolves (real impl), returns null for unknown — not a throw
      return app.close();
    });
  });
});
