// apps/backend/__tests__/consent-abac-predicates.test.ts — M39-T07 (§4.8).
//
// Proves M39 registers its seven ABAC predicate resolvers into M3's named-predicate registry and
// that each resolves THROUGH the published ConsentEvaluator seam (one decision engine). Uses a slice
// dataset so a real allow/deny is observable: an active 42_cfr_part_2_release naming the recipient
// makes `sud_consent_present` true; a patient with no consent makes the predicates fail-closed.
//
// Four §4.8 names M39 does NOT register here — `dpoa_active`/`sud_disclosure_allowed` (M7 owns them,
// keyed on its own planId/elementId targets), `family_violence_disclosure_allowed` (M15 owns it), and
// `telehealth_consent_active` (M31 owns it, keyed on telehealthVisitId) — see the ownership note atop
// `../src/modules/39-consent/abac-predicates.ts`.
import { abacRegistry } from "@chartwarden/auth";
import { type StoredConsent, createInMemoryConsentStore } from "@chartwarden/consent";
import { createConsentEvaluator } from "@chartwarden/consent";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import {
  M39_ABAC_PREDICATES,
  registerConsentAbacPredicates,
} from "../src/modules/39-consent/index";

const ORG = "org-1";
const PAT = "pat-1";

function seedEvaluator(consents: StoredConsent[]) {
  const { store } = createInMemoryConsentStore({ consents, deceasedPatientIds: new Set() });
  registerSeam("ConsentEvaluator", createConsentEvaluator(store));
}

beforeEach(() => {
  __resetSeamsForTest();
});

describe("M39-T07 — the 7 ABAC predicate resolvers (§4.8)", () => {
  it("registers exactly the seven named predicates", () => {
    expect(M39_ABAC_PREDICATES).toHaveLength(7);
    seedEvaluator([]);
    registerConsentAbacPredicates();
    for (const name of M39_ABAC_PREDICATES) expect(abacRegistry.has(name)).toBe(true);
  });

  it("re-registration is idempotent (single-owner registry guarded by has)", () => {
    seedEvaluator([]);
    registerConsentAbacPredicates();
    expect(() => registerConsentAbacPredicates()).not.toThrow();
  });

  it("sud_consent_present resolves TRUE through the seam when an active Part 2 release names the recipient", async () => {
    seedEvaluator([
      {
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
        recipients: [{ removedAtMs: null, expiresAtMs: null, recipientResolvedId: "r1" }],
      },
    ]);
    registerConsentAbacPredicates();
    const allowed = await abacRegistry.evaluate(
      "sud_consent_present",
      {
        organizationId: ORG,
        userId: "u1",
        roles: [],
        providerEntityIds: [],
        locationIds: [],
        attributes: { sessionClass: "staff" },
      },
      { patientId: PAT },
    );
    expect(allowed).toBe(true);
  });

  it("fail-closed: a predicate denies when no consent is on file", async () => {
    seedEvaluator([]);
    registerConsentAbacPredicates();
    const allowed = await abacRegistry.evaluate(
      "hipaa_release_active",
      {
        organizationId: ORG,
        userId: "u1",
        roles: [],
        providerEntityIds: [],
        locationIds: [],
        attributes: {},
      },
      { patientId: PAT },
    );
    expect(allowed).toBe(false);
  });
});
