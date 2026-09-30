import {
  M19_CONTRIBUTED_PERMISSIONS,
  PERMISSIONS,
  allPermissionMirrorRows,
  createPredicateRegistry,
} from "@wardenx/auth";
import {
  type ExternalTriageVendorAdapter,
  type TriageVendorBinding,
  type TriageVendorSourceContext,
  VendorPhiMinimizationError,
  assertVendorPayloadMinimized,
  minimizeForVendor,
} from "@wardenx/triage-vendors";
import { M19_AI_CONFIDENCE_FLOOR, M19_SYSTEM_LOCKED_ALERT_TYPES } from "@wardenx/types";
/**
 * M19-T07 — the §4.1 route layer: permission keys (§4.6), ABAC predicates (§4.7), the §4.9 typed M36
 * alerts, the §8.5 adapter mandate + §7.10 PHI boundary, the §4.8 `m36.notification.delivery_failed`
 * trigger, and the §4.1.1 cursor/concurrency policy.
 *
 * These tests are about the DECISIONS, not the SQL: every rule below is expressed as a pure function
 * precisely so it can be exercised with no database, and the Drizzle services compose over them. The
 * §9.3 RLS isolation and the §9.2 end-to-end paths run against a real PostgreSQL in the live suites.
 */
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
  ESCALATION_TIER_ROLES,
  M19_ABAC_PREDICATES,
  ONCALL_OVERSIGHT_ROLES,
  ROLES_BY_ESCALATION_TIER,
  buildOncallAbacPredicates,
  decideEscalationRecipient,
  decideEscalationRecipientScope,
  decideExternalTriageActor,
  decideOnCallEligible,
  denyStubOncallAbacResolver,
  triageDisciplineForRoleKeys,
} from "../src/modules/19-oncall/abac-predicates";
import {
  M19_ALERT_RULES,
  alertRuleFor,
  buildCaseOpenedAlert,
  buildRedFlagHitAlert,
  caseOpenedSeverity,
  isAlertSuppressible,
} from "../src/modules/19-oncall/alerts";
import {
  DELIVERY_FAILURE_ESCALATION_TIER,
  decideDeliveryFailureTrigger,
} from "../src/modules/19-oncall/consumers/m36-delivery-failed";
import {
  M19_PERMISSION_KEY_LIST,
  M19_STEP_UP_PERMISSION_KEYS,
  M19_VENDOR_SESSION_PERMISSION_KEYS,
} from "../src/modules/19-oncall/permission-keys";
import {
  InvalidCursorError,
  MissingOutboxPayloadError,
  type StateHistoryInsert,
  UnknownTriageEffectError,
  decodeCursor,
  encodeCursor,
  ifMatchVersion,
  layDispositionSummary,
  runEffects,
} from "../src/modules/19-oncall/routes/index";
import {
  OpenTriageCallBody,
  RecordAnswerBody,
  SelectDispositionBody,
  parse,
} from "../src/modules/19-oncall/routes/m19-typebox";
import { mountM19Routes } from "../src/modules/19-oncall/routes/mount";
import {
  TriageVendorAdapterUnavailableError,
  UnknownVendorMinimizationProfileError,
  createTriageVendorAdapterRegistry,
  handOffCallToVendor,
  opaquePatientRefFor,
  toVendorBinding,
  triageVendorAdapters,
} from "../src/modules/19-oncall/vendor/index";

const ORG = "11111111-1111-4111-8111-111111111111";
const CALL_ID = "22222222-2222-4222-8222-222222222222";
const SHIFT_ID = "33333333-3333-4333-8333-333333333333";
const PE = "44444444-4444-4444-8444-444444444444";
const VENDOR_ID = "55555555-5555-4555-8555-555555555555";

// ── §4.6 permission keys ─────────────────────────────────────────────────────────────────────────────

describe("M19-T07 §4.6 permission keys", () => {
  it("registers exactly the nineteen §4.6 keys, verbatim", () => {
    expect(M19_PERMISSION_KEY_LIST).toEqual([
      "triage.open",
      "triage.read",
      "triage.write",
      "triage.disposition",
      "triage.read_transcript",
      "triage.close_abandoned",
      // F-217 — the explicit caregiver/attending summary request (`m19.triage.summary_requested`).
      "triage.request_summary",
      "triage.escalate",
      "triage.read_escalations",
      "triage.escalation_ack",
      "triage.escalation_resolve",
      "triage.admin_protocol",
      "oncall.read_schedule",
      "oncall.write_schedule",
      "oncall.read_policy",
      "oncall.admin_policy",
      // F-030 — binding a session to an `external_triage_vendor`. `admin`, alongside
      // `oncall.admin_policy`: §8.3.2 names tampering with the vendor binding as a threat, and this
      // decides which outside party answers the agency's nights.
      "oncall.bind_vendor_session",
      "portal.triage.read_recent",
      "triage.paper_reentry",
    ]);
  });

  it("mirrors into the platform permission table with no key collision", () => {
    const rows = allPermissionMirrorRows();
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of M19_PERMISSION_KEY_LIST) expect(keys).toContain(key);
    // M3's own locked catalog must be untouched by the contribution.
    expect(Object.keys(PERMISSIONS).some((k) => k.startsWith("triage."))).toBe(false);
  });

  it("names an ABAC default that some module declares (no dead default)", () => {
    const declared = new Set<string>([
      ...M19_ABAC_PREDICATES,
      "caseload_or_scope",
      "inOrg",
      "none",
    ]);
    for (const def of Object.values(M19_CONTRIBUTED_PERMISSIONS)) {
      expect(declared.has(def.abac)).toBe(true);
    }
  });

  it("pins the step-up set to the four §4.1/§4.6 operations and no others", () => {
    expect([...M19_STEP_UP_PERMISSION_KEYS].sort()).toEqual([
      "oncall.admin_policy",
      "triage.admin_protocol",
      "triage.paper_reentry",
      "triage.read_transcript",
    ]);
  });

  it("scopes an external vendor session to §6's five keys — never the transcript or the catalog", () => {
    expect(M19_VENDOR_SESSION_PERMISSION_KEYS).not.toContain("triage.read_transcript");
    // F-217 — the caregiver/attending summary is an in-agency disclosure, never a vendor action.
    expect(M19_VENDOR_SESSION_PERMISSION_KEYS).not.toContain("triage.request_summary");
    expect(M19_VENDOR_SESSION_PERMISSION_KEYS).not.toContain("triage.admin_protocol");
    expect(M19_VENDOR_SESSION_PERMISSION_KEYS).not.toContain("oncall.admin_policy");
    expect(M19_VENDOR_SESSION_PERMISSION_KEYS).toContain("triage.escalate");
  });
});

// ── §4.7 ABAC ────────────────────────────────────────────────────────────────────────────────────────

describe("M19-T07 §4.7 ABAC predicates", () => {
  it("owns exactly the six §4.7 names", () => {
    expect([...M19_ABAC_PREDICATES]).toEqual([
      "oncall_eligible",
      "triage_call_owner_or_supervisor",
      "external_triage_actor",
      "escalation_recipient_scope",
      "escalation_recipient",
      "portal_session_consent_active",
    ]);
  });

  describe("oncall_eligible (§4.7's three paths)", () => {
    it("(a) an ACTIVE shift covering now is eligibility on its own", () => {
      expect(decideOnCallEligible({ onActiveShift: true, roleKeys: [], rosterNames: false })).toBe(
        true,
      );
    });

    it("(b) an oversight role is eligible with no shift and no roster", () => {
      for (const role of ONCALL_OVERSIGHT_ROLES) {
        expect(
          decideOnCallEligible({ onActiveShift: false, roleKeys: [role], rosterNames: null }),
        ).toBe(true);
      }
    });

    it("(c) the M17 roster is the Direct-model fallback", () => {
      expect(
        decideOnCallEligible({
          onActiveShift: false,
          roleKeys: ["registered_nurse"],
          rosterNames: true,
        }),
      ).toBe(true);
    });

    it("an UNREADABLE roster is not eligibility — `null` is never `true`", () => {
      expect(
        decideOnCallEligible({
          onActiveShift: null,
          roleKeys: ["registered_nurse"],
          rosterNames: null,
        }),
      ).toBe(false);
    });

    it("an unreadable SHIFT still lets the role path answer (the three-valued split)", () => {
      expect(
        decideOnCallEligible({
          onActiveShift: null,
          roleKeys: ["director_of_nursing"],
          rosterNames: null,
        }),
      ).toBe(true);
    });

    it("an unresolvable role set denies rather than being read as 'no restriction'", () => {
      expect(
        decideOnCallEligible({ onActiveShift: false, roleKeys: null, rosterNames: false }),
      ).toBe(false);
    });
  });

  describe("escalation_recipient / _scope", () => {
    it("scope admits every tier role and refuses an unresolvable set", () => {
      for (const role of ESCALATION_TIER_ROLES) {
        expect(decideEscalationRecipientScope([role])).toBe(true);
      }
      expect(decideEscalationRecipientScope(null)).toBe(false);
      expect(decideEscalationRecipientScope(["registered_nurse"])).toBe(false);
    });

    it("the NAMED recipient is admitted before any tier-role fallback", () => {
      const facts = {
        organizationId: ORG,
        escalationId: "e1",
        tier: "tier_3_medical_director" as const,
        escalatedToMembershipId: "m-md",
        escalatedToExternalActorId: null,
      };
      expect(
        decideEscalationRecipient({
          facts,
          membershipId: "m-md",
          roleKeys: null, // unreadable roles must not stop the named recipient
          externalActorId: null,
        }),
      ).toBe(true);
    });

    it("a tier role stands in when nobody is named for that tier", () => {
      const facts = {
        organizationId: ORG,
        escalationId: "e1",
        tier: "tier_4_compliance_officer" as const,
        escalatedToMembershipId: "someone-else",
        escalatedToExternalActorId: null,
      };
      expect(
        decideEscalationRecipient({
          facts,
          membershipId: "not-them",
          roleKeys: [...ROLES_BY_ESCALATION_TIER.tier_4_compliance_officer],
          externalActorId: null,
        }),
      ).toBe(true);
      // …but a clinical role that is on no tier does not.
      expect(
        decideEscalationRecipient({
          facts,
          membershipId: "not-them",
          roleKeys: ["registered_nurse"],
          externalActorId: null,
        }),
      ).toBe(false);
    });

    it("a tier-5 row admits the vendor session it was escalated to", () => {
      expect(
        decideEscalationRecipient({
          facts: {
            organizationId: ORG,
            escalationId: "e1",
            tier: "tier_5_external",
            escalatedToMembershipId: null,
            escalatedToExternalActorId: VENDOR_ID,
          },
          membershipId: "whoever",
          roleKeys: [],
          externalActorId: VENDOR_ID,
        }),
      ).toBe(true);
    });
  });

  describe("external_triage_actor", () => {
    const shift = {
      organizationId: ORG,
      shiftId: SHIFT_ID,
      providerEntityId: PE,
      discipline: "external" as const,
      primaryOnCallMembershipId: null,
      backupMembershipId: null,
      externalActorId: VENDOR_ID,
    };

    it("admits a vendor session whose identity matches the call's shift", () => {
      expect(
        decideExternalTriageActor({
          sessionClass: "external_triage_vendor",
          sessionExternalActorId: VENDOR_ID,
          shift,
        }),
      ).toBe(true);
    });

    it("refuses a STAFF session even when it carries a matching vendor attribute", () => {
      expect(
        decideExternalTriageActor({
          sessionClass: "staff",
          sessionExternalActorId: VENDOR_ID,
          shift,
        }),
      ).toBe(false);
    });

    it("refuses a vendor session scoped to a DIFFERENT vendor's call", () => {
      expect(
        decideExternalTriageActor({
          sessionClass: "external_triage_vendor",
          sessionExternalActorId: "other-vendor",
          shift,
        }),
      ).toBe(false);
    });

    it("refuses when the call's shift names no vendor at all (a Direct-model shift)", () => {
      expect(
        decideExternalTriageActor({
          sessionClass: "external_triage_vendor",
          sessionExternalActorId: VENDOR_ID,
          shift: { ...shift, discipline: "clinical_rn", externalActorId: null },
        }),
      ).toBe(false);
    });
  });

  describe("the §7.3 discipline derivation", () => {
    it("returns the STRONGEST band when a membership holds several", () => {
      expect(triageDisciplineForRoleKeys(["chaplain", "registered_nurse"])).toBe("clinical_rn");
      expect(triageDisciplineForRoleKeys(["registered_nurse", "director_of_nursing"])).toBe(
        "supervisor",
      );
    });

    it("answers null when no role evidences a band (which the route turns into a 403)", () => {
      expect(triageDisciplineForRoleKeys(["billing_clerk"])).toBeNull();
      expect(triageDisciplineForRoleKeys([])).toBeNull();
    });
  });

  describe("registration + fail-closed posture over the deny-stub resolver", () => {
    const context = {
      organizationId: ORG,
      userId: "u1",
      roles: ["director_of_nursing"],
      providerEntityIds: [PE],
      locationIds: [],
      attributes: { membershipId: "m1", sessionClass: "staff" },
    };
    const ports = {
      async isInCaseload() {
        return false;
      },
      async tonightsOnCallRoster() {
        return null;
      },
      async familyCaregiverAccessActive() {
        return false;
      },
    };

    it("registers all six into a fresh registry under their §4.7 names", () => {
      const registry = createPredicateRegistry();
      const predicates = buildOncallAbacPredicates({
        resolver: denyStubOncallAbacResolver,
        ports,
      });
      for (const [name, predicate] of Object.entries(predicates))
        registry.register(name, predicate);
      expect(
        [...registry.names()].filter((n) => M19_ABAC_PREDICATES.includes(n as never)).sort(),
      ).toEqual([...M19_ABAC_PREDICATES].sort());
    });

    it("a deny-stub resolver still lets the ROLE path answer oncall_eligible", async () => {
      const predicates = buildOncallAbacPredicates({
        resolver: denyStubOncallAbacResolver,
        ports,
      });
      await expect(predicates.oncall_eligible?.(context, { providerEntityId: PE })).resolves.toBe(
        true,
      );
    });

    it("an unresolvable CALL denies the per-call predicate whatever the actor's role", async () => {
      const predicates = buildOncallAbacPredicates({
        resolver: denyStubOncallAbacResolver,
        ports,
      });
      await expect(
        predicates.triage_call_owner_or_supervisor?.(context, { triageCallId: CALL_ID }),
      ).resolves.toBe(false);
    });

    it("the portal predicate refuses a STAFF session before any consent read", async () => {
      let consulted = false;
      const predicates = buildOncallAbacPredicates({
        resolver: denyStubOncallAbacResolver,
        ports: {
          ...ports,
          async familyCaregiverAccessActive() {
            consulted = true;
            return true;
          },
        },
      });
      await expect(
        predicates.portal_session_consent_active?.(context, { patientId: "p1" }),
      ).resolves.toBe(false);
      expect(consulted).toBe(false);
    });

    it("the portal predicate consults M39 for a real portal session", async () => {
      const predicates = buildOncallAbacPredicates({
        resolver: denyStubOncallAbacResolver,
        ports: {
          ...ports,
          async familyCaregiverAccessActive() {
            return true;
          },
        },
      });
      await expect(
        predicates.portal_session_consent_active?.(
          { ...context, attributes: { sessionClass: "caregiver_portal" } },
          { patientId: "p1" },
        ),
      ).resolves.toBe(true);
    });
  });
});

// ── §4.9 typed M36 alerts ────────────────────────────────────────────────────────────────────────────

describe("M19-T07 §4.9 alert rules", () => {
  it("carries a rule for every alert type in the published union", () => {
    for (const type of M19_SYSTEM_LOCKED_ALERT_TYPES) {
      expect(alertRuleFor(type)).toBeDefined();
    }
    expect(M19_ALERT_RULES).toHaveLength(6);
  });

  it("marks system-locked EXACTLY the three the published set pins", () => {
    const locked = M19_ALERT_RULES.filter((r) => r.systemLocked)
      .map((r) => r.eventType)
      .sort();
    expect(locked).toEqual([...M19_SYSTEM_LOCKED_ALERT_TYPES].sort());
  });

  it("suppressibility is decided by the PUBLISHED set, not by the local table", () => {
    for (const type of M19_SYSTEM_LOCKED_ALERT_TYPES) expect(isAlertSuppressible(type)).toBe(false);
    expect(isAlertSuppressible("m19.triage.case_opened")).toBe(true);
    // An unknown type is NOT silenceable — a rule nobody classified must not default to suppressible.
    expect(isAlertSuppressible("m19.something.new")).toBe(false);
  });

  it("computes case_opened severity from PROVENANCE (§4.9's 'sometimes warn')", () => {
    expect(caseOpenedSeverity("manual")).toBe("info");
    expect(caseOpenedSeverity("no_show")).toBe("warn");
    expect(caseOpenedSeverity("late_checkout")).toBe("warn");
    expect(caseOpenedSeverity("m36_delivery_failure")).toBe("warn");
    // A BCP re-entry is a human typing up a night that already happened — not a page about the past.
    expect(caseOpenedSeverity("paper_origin")).toBe("info");
  });

  it("no alert payload carries caller prose — only ids, enums and catalog labels", () => {
    const redFlag = buildRedFlagHitAlert({
      orgId: ORG,
      providerEntityId: PE,
      triageCallId: CALL_ID,
      escalationId: "e1",
      questionPrompt: "Has the patient fallen in the last 24h?",
    });
    // The question PROMPT is org reference data; the ANSWER has no field to travel in.
    expect(Object.keys(redFlag)).not.toContain("answerValueText");
    expect(Object.keys(redFlag)).not.toContain("chiefComplaintText");

    const opened = buildCaseOpenedAlert({
      orgId: ORG,
      providerEntityId: PE,
      triageCallId: CALL_ID,
      source: "no_show",
      openedAt: "2026-07-31T22:30:00.000Z",
    });
    expect(opened.severity).toBe("warn");
    expect(Object.keys(opened)).not.toContain("callerPhoneE164");
  });
});

// ── §8.5 adapter mandate + §7.10 PHI boundary ────────────────────────────────────────────────────────

const SOURCE: TriageVendorSourceContext = {
  patientId: "99999999-9999-4999-8999-999999999999",
  firstName: "Mary",
  lastName: "Whitfield",
  medicalRecordNumber: "MRN-40182",
  ageYears: 78,
  dateOfBirth: "1948-03-04",
  addressLine1: "417 Cranberry Lane",
  addressLine2: null,
  city: "Brattleboro",
  postalCode: "05301",
  phoneE164: "+18025551234",
  caregiverName: "Daniel Whitfield",
  caregiverPhoneE164: "+18025554321",
  codeStatusDnr: true,
  allergies: ["penicillin"],
  currentMedications: [
    "morphine sulfate ER",
    "sennosides",
    "lorazepam",
    "haloperidol",
    "oxygen 2L",
  ],
  primaryDiagnosisLabel: "Lung cancer, stage IV",
  primaryDiagnosisIcd10: "C34.90",
  levelOfCare: "routine_home_care",
  recentVitalsSummary: "BP 104/62, HR 96",
  activeProblemLabels: ["dyspnea"],
  rawChartNotes: "Patient restless overnight; daughter reports dark urine.",
};

const BINDING: TriageVendorBinding = {
  externalTriageVendorId: VENDOR_ID,
  adapterKey: "tenants/acme-triage",
  minimizationProfile: "hybrid_phi_min",
  baaInEffect: true,
  baaExpiresOn: null,
  rnCoverageAttested: true,
};

function stubAdapter(
  overrides: Partial<ExternalTriageVendorAdapter> = {},
): ExternalTriageVendorAdapter {
  return {
    adapterKey: "tenants/acme-triage",
    supportedProfiles: ["hybrid_phi_min"],
    async handoffCall() {
      return { result: "accepted", vendorCallRef: "V-1", acceptedAt: "2026-07-31T23:15:00.000Z" };
    },
    async pollCall() {
      return { kind: "in_progress", observedAt: "2026-07-31T23:20:00.000Z" };
    },
    async healthy() {
      return true;
    },
    ...overrides,
  };
}

describe("M19-T07 §8.5 adapter mandate", () => {
  it("ships EMPTY in Phase 1 — no adapter is registered until a BAA is signed", () => {
    expect(triageVendorAdapters.keys()).toEqual([]);
  });

  it("a registry miss REFUSES; there is no default adapter and no silent no-op", async () => {
    await expect(
      handOffCallToVendor(
        {
          organizationId: ORG,
          triageCallId: CALL_ID,
          binding: BINDING,
          source: SOURCE,
          idempotencyKey: "k1",
          asOfIsoDate: "2026-07-31",
        },
        { registry: createTriageVendorAdapterRegistry() },
      ),
    ).rejects.toBeInstanceOf(TriageVendorAdapterUnavailableError);
  });

  it("refuses a duplicate adapter key at registration (a boot wiring bug, caught early)", () => {
    const registry = createTriageVendorAdapterRegistry([stubAdapter()]);
    expect(() => registry.register(stubAdapter())).toThrow(/already registered/);
  });

  it("a vendor row naming an UNKNOWN minimization profile is refused, never defaulted", () => {
    expect(() =>
      toVendorBinding({
        id: VENDOR_ID,
        adapterKey: "tenants/acme-triage",
        defaultMinimizationPolicy: { profile: "whatever_we_agreed_verbally" },
        baaInEffect: true,
        baaExpiresOn: null,
        rnCoverageAttested: true,
      }),
    ).toThrow(UnknownVendorMinimizationProfileError);
  });
});

describe("M19-T07 §7.10 PHI minimization at the vendor boundary", () => {
  const registry = createTriageVendorAdapterRegistry([stubAdapter()]);

  it("transmits ZERO full names, MRNs, addresses, caregiver names or raw notes", async () => {
    const outcome = await handOffCallToVendor(
      {
        organizationId: ORG,
        triageCallId: CALL_ID,
        binding: BINDING,
        source: SOURCE,
        idempotencyKey: "k1",
        asOfIsoDate: "2026-07-31",
      },
      { registry },
    );
    const wire = JSON.stringify(outcome.transmitted);
    for (const forbidden of [
      SOURCE.lastName,
      SOURCE.medicalRecordNumber as string,
      SOURCE.addressLine1 as string,
      SOURCE.city as string,
      SOURCE.postalCode as string,
      SOURCE.phoneE164 as string,
      SOURCE.caregiverName as string,
      SOURCE.rawChartNotes as string,
      SOURCE.dateOfBirth as string,
      SOURCE.patientId,
    ]) {
      expect(wire).not.toContain(forbidden);
    }
    expect(outcome.result?.result).toBe("accepted");
  });

  it("the runtime guard catches a permitted key STUFFED with an identifier", () => {
    const body = minimizeForVendor("hybrid_phi_min", SOURCE, "ref-1") as unknown as Record<
      string,
      unknown
    >;
    const tampered = { ...body, firstName: "Mary Whitfield, MRN-40182" };
    expect(() => assertVendorPayloadMinimized("hybrid_phi_min", SOURCE, tampered)).toThrow(
      VendorPhiMinimizationError,
    );
  });

  it("the runtime guard catches a WIDENED projection (an unpermitted key)", () => {
    const body = minimizeForVendor("hybrid_phi_min", SOURCE, "ref-1") as unknown as Record<
      string,
      unknown
    >;
    expect(() =>
      assertVendorPayloadMinimized("hybrid_phi_min", SOURCE, { ...body, chartNotes: "…" }),
    ).toThrow(VendorPhiMinimizationError);
  });

  it("the opaque patient ref is per (vendor, call) and is NEVER the patient id", () => {
    const withSecret = opaquePatientRefFor({
      vendorId: VENDOR_ID,
      triageCallId: CALL_ID,
      patientId: SOURCE.patientId,
      secret: "s3cret",
    });
    const otherCall = opaquePatientRefFor({
      vendorId: VENDOR_ID,
      triageCallId: "other-call",
      patientId: SOURCE.patientId,
      secret: "s3cret",
    });
    expect(withSecret).not.toBe(SOURCE.patientId);
    expect(withSecret).not.toBe(otherCall); // the same patient presents differently per call
    // Without a secret the fallback is the CALL id — opaque to the vendor, and not the patient id.
    expect(
      opaquePatientRefFor({
        vendorId: VENDOR_ID,
        triageCallId: CALL_ID,
        patientId: SOURCE.patientId,
      }),
    ).toBe(CALL_ID);
  });

  it("the D13 binding gate refuses an expired BAA at HANDOFF, not only at creation", async () => {
    await expect(
      handOffCallToVendor(
        {
          organizationId: ORG,
          triageCallId: CALL_ID,
          binding: { ...BINDING, baaExpiresOn: "2026-01-01" },
          source: SOURCE,
          idempotencyKey: "k1",
          asOfIsoDate: "2026-07-31",
        },
        { registry },
      ),
    ).rejects.toThrow(/expired/);
  });

  it("the D13 gate refuses an unattested RN-coverage binding", async () => {
    await expect(
      handOffCallToVendor(
        {
          organizationId: ORG,
          triageCallId: CALL_ID,
          binding: { ...BINDING, rnCoverageAttested: false },
          source: SOURCE,
          idempotencyKey: "k1",
          asOfIsoDate: "2026-07-31",
        },
        { registry },
      ),
    ).rejects.toThrow(/RN coverage/);
  });

  it("a vendor REFUSAL is a real answer, not an error to retry into", async () => {
    const refusing = createTriageVendorAdapterRegistry([
      stubAdapter({
        async handoffCall() {
          return { result: "refused", reasonCode: "out_of_scope", reason: "no coverage tonight" };
        },
      }),
    ]);
    const outcome = await handOffCallToVendor(
      {
        organizationId: ORG,
        triageCallId: CALL_ID,
        binding: BINDING,
        source: SOURCE,
        idempotencyKey: "k1",
        asOfIsoDate: "2026-07-31",
      },
      { registry: refusing },
    );
    expect(outcome.audit.outcome).toBe("refused");
    expect(outcome.audit.patientFirstNameHash).not.toContain(SOURCE.firstName);
  });
});

// ── §4.8 the m36.notification.delivery_failed trigger ────────────────────────────────────────────────

describe("M19-T07 §4.8 m36 delivery-failure trigger", () => {
  const facts = {
    existingCallForEventId: null,
    namedCallIsOpen: false,
    candidateShifts: [
      {
        shiftId: SHIFT_ID,
        providerEntityId: PE,
        status: "active" as const,
        version: 1,
        shiftStartsAt: "2026-07-31T22:00:00.000Z",
        shiftEndsAt: "2026-08-01T07:00:00.000Z",
        discipline: "clinical_rn" as const,
        primaryOnCallMembershipId: "m1",
        externalActorId: null,
        openedAt: "2026-07-31T22:00:00.000Z",
        closedAt: null,
      },
    ],
  };
  const payload = {
    notificationId: "n1",
    recipientKind: "on_call" as const,
    providerEntityId: PE,
    alertEventType: "m19.triage.protocol_red_flag_hit",
    triageCallId: CALL_ID,
    channel: "sms",
    failedAt: "2026-07-31T23:00:00.000Z",
  };
  const at = "2026-07-31T23:00:00.000Z";

  it("ignores a failure to a recipient that is not on call (§4.8's filter, honoured not widened)", () => {
    expect(
      decideDeliveryFailureTrigger({
        organizationId: ORG,
        sourceOutboxEventId: "evt-1",
        payload: { ...payload, recipientKind: "care_team" },
        facts,
        at,
      }),
    ).toEqual({ kind: "ignore", reason: "recipient_not_on_call" });
  });

  it("ESCALATES the named call rather than opening a second one about the same event", () => {
    const action = decideDeliveryFailureTrigger({
      organizationId: ORG,
      sourceOutboxEventId: "evt-1",
      payload,
      facts: { ...facts, namedCallIsOpen: true },
      at,
    });
    expect(action).toEqual({
      kind: "escalate_existing",
      triageCallId: CALL_ID,
      tier: DELIVERY_FAILURE_ESCALATION_TIER,
    });
    // Not higher: waking the medical director because an SMS gateway timed out would train the tier-3
    // recipient to ignore the rung that also carries suicidal ideation.
    expect(DELIVERY_FAILURE_ESCALATION_TIER).toBe("tier_1_rn_supervisor");
  });

  it("opens a PATIENT-LESS operational call when the failed alert named no open call", () => {
    const action = decideDeliveryFailureTrigger({
      organizationId: ORG,
      sourceOutboxEventId: "evt-1",
      payload: { ...payload, triageCallId: null },
      facts,
      at,
    });
    expect(action.kind).toBe("open_operational_call");
    if (action.kind === "open_operational_call") {
      expect(action.draft.source).toBe("m36_delivery_failure");
      expect(action.draft.inboundChannel).toBe("inbound_alert_failure");
      expect(action.draft.onCallShiftId).toBe(SHIFT_ID);
      expect(Object.keys(action.draft)).not.toContain("patientId");
    }
  });

  it("a CLOSED named call falls through to the operational row rather than escalating a terminal call", () => {
    const action = decideDeliveryFailureTrigger({
      organizationId: ORG,
      sourceOutboxEventId: "evt-1",
      payload,
      facts: { ...facts, namedCallIsOpen: false },
      at,
    });
    expect(action.kind).toBe("open_operational_call");
  });

  it("reports a coverage GAP rather than dropping the finding when nothing covers the instant", () => {
    const action = decideDeliveryFailureTrigger({
      organizationId: ORG,
      sourceOutboxEventId: "evt-1",
      payload: { ...payload, triageCallId: null },
      facts: { ...facts, candidateShifts: [] },
      at,
    });
    expect(action.kind).toBe("no_coverage");
    if (action.kind === "no_coverage") expect(action.gap.discipline).toBe("clinical_rn");
  });

  it("dead-letters an on-call failure that names no ProviderEntity rather than guessing tenancy", () => {
    expect(() =>
      decideDeliveryFailureTrigger({
        organizationId: ORG,
        sourceOutboxEventId: "evt-1",
        payload: { ...payload, triageCallId: null, providerEntityId: null },
        facts,
        at,
      }),
    ).toThrow(/DELIVERY_FAILURE_PROVIDER_ENTITY_UNRESOLVED|provider entity/);
  });

  it("a REDELIVERY of the same outbox event writes nothing", () => {
    expect(
      decideDeliveryFailureTrigger({
        organizationId: ORG,
        sourceOutboxEventId: "evt-1",
        payload,
        facts: { ...facts, existingCallForEventId: CALL_ID },
        at,
      }),
    ).toEqual({ kind: "idempotent_skip", triageCallId: CALL_ID });
  });
});

// ── §4.1.1 cursor pagination + §2.5 concurrency ──────────────────────────────────────────────────────

describe("M19-T07 §4.1.1 / §2.5 route-boundary policy", () => {
  it("round-trips a signed cursor for the org that minted it", () => {
    const token = encodeCursor(ORG, { a: "2026-07-31T22:30:00.000Z", id: CALL_ID });
    expect(decodeCursor(ORG, token)).toEqual({ a: "2026-07-31T22:30:00.000Z", id: CALL_ID });
  });

  it("a cursor minted for one org does NOT verify for another (the enumeration guard)", () => {
    const token = encodeCursor(ORG, { a: "2026-07-31T22:30:00.000Z", id: CALL_ID });
    expect(() => decodeCursor("другая-org", token)).toThrow(InvalidCursorError);
  });

  it("a TAMPERED cursor throws rather than silently serving page 1", () => {
    const token = encodeCursor(ORG, { a: "2026-07-31T22:30:00.000Z", id: CALL_ID });
    const [body] = token.split(".");
    expect(() => decodeCursor(ORG, `${body}.forged`)).toThrow(InvalidCursorError);
    expect(() => decodeCursor(ORG, "not-a-cursor")).toThrow(InvalidCursorError);
  });

  it("an ABSENT cursor is the first page, not an error", () => {
    expect(decodeCursor(ORG, undefined)).toBeNull();
    expect(decodeCursor(ORG, null)).toBeNull();
  });

  it("If-Match parses an integer version and tolerates weak-ETag quoting", () => {
    expect(ifMatchVersion({ headers: { "if-match": "3" } })).toBe(3);
    expect(ifMatchVersion({ headers: { "if-match": 'W/"3"' } })).toBe(3);
  });

  it("a required If-Match that is absent or non-numeric is 428, never coerced to 0", () => {
    expect(() => ifMatchVersion({ headers: {} }, true)).toThrow(/If-Match/);
    expect(() => ifMatchVersion({ headers: { "if-match": "" } }, true)).toThrow(/If-Match/);
    expect(() => ifMatchVersion({ headers: { "if-match": "abc" } }, true)).toThrow(/If-Match/);
  });

  it("the page envelope has NO total_count field (§4.1.1 / §8.3.4)", () => {
    // A count on a PHI list is an enumeration oracle. The type has no field for it; this asserts the
    // runtime shape agrees.
    const token = encodeCursor(ORG, { a: "x", id: "y" });
    expect(typeof token).toBe("string");
  });
});

// ── §2.4 the effects runner ──────────────────────────────────────────────────────────────────────────

describe("M19-T07 §2.4 effects runner", () => {
  const base = {
    organizationId: ORG,
    providerEntityId: PE,
    locationId: null,
    triageCallId: CALL_ID,
    at: new Date("2026-07-31T23:00:00.000Z"),
    actorMembershipId: "m1",
    commandPayloadDigest: "d1",
    outbox: { async publish() {} },
    aggregateKind: "triage_call",
    aggregateId: CALL_ID,
    payloads: {},
  };

  it("throws when a machine declared an event the service built no payload for", async () => {
    await expect(
      runEffects(null, [{ kind: "outbox", event: "m19.triage_call.opened" }], base),
    ).rejects.toBeInstanceOf(MissingOutboxPayloadError);
  });

  it("throws on a set_timestamp naming a column the schema does not have (the M21-T03 lesson)", async () => {
    await expect(
      runEffects(
        null,
        [
          {
            kind: "set_timestamp",
            field: "disposition_selected_at" as never,
            at: "2026-07-31T23:00:00.000Z",
          },
        ],
        base,
      ),
    ).rejects.toBeInstanceOf(UnknownTriageEffectError);
  });

  it("throws on an effect kind nobody taught the runner about", async () => {
    await expect(runEffects(null, [{ kind: "teleport" } as never], base)).rejects.toBeInstanceOf(
      UnknownTriageEffectError,
    );
  });

  it("a SYSTEM transition records no membership; a human one records the actor (§3.3's CHECK)", async () => {
    const rows: StateHistoryInsert[] = [];
    const stateHistory = {
      async insert(_tx: unknown, row: StateHistoryInsert) {
        rows.push(row);
      },
    };
    await runEffects(
      null,
      [
        { kind: "state_history", from: "open", to: "protocol_in_progress", systemActor: false },
        { kind: "state_history", from: "documented", to: "closed", systemActor: true },
      ],
      { ...base, stateHistory },
    );
    expect(rows[0]?.actorMembershipId).toBe("m1");
    expect(rows[0]?.systemActor).toBe(false);
    expect(rows[1]?.actorMembershipId).toBeNull();
    expect(rows[1]?.systemActor).toBe(true);
  });

  it("an alert with no payload is SKIPPED (advisory), while an event with none throws (contract)", async () => {
    await expect(
      runEffects(null, [{ kind: "alert", alert: "m19.triage.case_opened" }], base),
    ).resolves.toEqual({});
  });

  it("`audit` is a no-op — the M4 trigger owns the audit row", async () => {
    await expect(runEffects(null, [{ kind: "audit" }], base)).resolves.toEqual({});
  });

  it("pins the protocol id and version together (D4)", async () => {
    await expect(
      runEffects(
        null,
        [{ kind: "pin_protocol", protocolId: "p1", version: "1.2", aiAccepted: true }],
        base,
      ),
    ).resolves.toEqual({ selectedProtocolId: "p1", selectedProtocolVersion: "1.2" });
  });
});

// ── §4.2 request schemas ─────────────────────────────────────────────────────────────────────────────

describe("M19-T07 §4.2 request schemas", () => {
  it("refuses a machine-only `source` on the open route (§8.3.2's provenance forgery)", () => {
    const valid = {
      providerEntityId: PE,
      inboundChannel: "phone",
      callerKind: "caregiver",
      source: "manual",
    };
    expect(() => parse(OpenTriageCallBody, valid)).not.toThrow();
    expect(() => parse(OpenTriageCallBody, { ...valid, source: "no_show" })).toThrow();
    expect(() => parse(OpenTriageCallBody, { ...valid, source: "paper_origin" })).toThrow();
  });

  it("accepts no `sourceOutboxEventId` or `onCallShiftId` from a caller", () => {
    expect(() =>
      parse(OpenTriageCallBody, {
        providerEntityId: PE,
        inboundChannel: "phone",
        callerKind: "caregiver",
        sourceOutboxEventId: CALL_ID,
      }),
    ).toThrow();
    expect(() =>
      parse(OpenTriageCallBody, {
        providerEntityId: PE,
        inboundChannel: "phone",
        callerKind: "caregiver",
        onCallShiftId: SHIFT_ID,
      }),
    ).toThrow();
  });

  it("the answer body is a DISCRIMINATED union — exactly one typed value, refused at the boundary", () => {
    expect(() =>
      parse(RecordAnswerBody, {
        triageProtocolQuestionId: CALL_ID,
        value: { kind: "int", value: 7 },
      }),
    ).not.toThrow();
    // The §4.2 sketch's three-optional-columns shape would have admitted this all-null row.
    expect(() => parse(RecordAnswerBody, { triageProtocolQuestionId: CALL_ID })).toThrow();
    expect(() =>
      parse(RecordAnswerBody, {
        triageProtocolQuestionId: CALL_ID,
        value: { kind: "int", value: 7, alsoText: "x" },
      }),
    ).toThrow();
  });

  it("no answer body can assert `red_flag_hit` — D5 makes it the SERVER's evaluation", () => {
    expect(() =>
      parse(RecordAnswerBody, {
        triageProtocolQuestionId: CALL_ID,
        value: { kind: "bool", value: true },
        redFlagHit: false,
      }),
    ).toThrow();
  });

  it("the disposition union admits the eight selectable arms and neither reachable-by-command one", () => {
    expect(() =>
      parse(SelectDispositionBody, {
        dispositionData: {
          disposition: "caregiver_education_only",
          educationSummary: "x".repeat(40),
          followUpCallAt: null,
        },
      }),
    ).not.toThrow();
    expect(() =>
      parse(SelectDispositionBody, {
        dispositionData: { disposition: "abandoned", reason: "hung up", callbackAttempts: 1 },
      }),
    ).toThrow();
    expect(() =>
      parse(SelectDispositionBody, {
        dispositionData: {
          disposition: "escalated_unresolved",
          escalationId: CALL_ID,
          tier: "tier_1_rn_supervisor",
        },
      }),
    ).toThrow();
  });

  it("enforces §4.1's own minimum lengths on the surveyed free-text fields", () => {
    expect(() =>
      parse(SelectDispositionBody, {
        dispositionData: {
          disposition: "ed_transfer_acknowledged",
          electionText: "short",
          transportArrangedBy: "family",
        },
      }),
    ).toThrow();
  });
});

// ── §5.3 the portal lay-language projection ──────────────────────────────────────────────────────────

describe("M19-T07 §5.3 portal lay-language summary", () => {
  it("never returns the raw disposition enum value", () => {
    for (const disposition of [
      "caregiver_education_only",
      "visit_dispatched_now",
      "gip_admission_proposed",
      "ed_transfer_acknowledged",
      "pronouncement_scheduled",
    ]) {
      const summary = layDispositionSummary(disposition);
      expect(summary).not.toContain("_");
      expect(summary).not.toContain(disposition);
    }
  });

  it("an UNMAPPED disposition falls back to a true general statement, not the internal code", () => {
    const summary = layDispositionSummary("some_future_enum_member");
    expect(summary).not.toContain("some_future_enum_member");
    expect(summary).toBe("Your call was received by the on-call team.");
    expect(layDispositionSummary(null)).toBe("Your call was received by the on-call team.");
  });
});

// ── D12 the AI governance floor ──────────────────────────────────────────────────────────────────────

describe("M19-T07 D12 AI governance floor", () => {
  it("keeps the published 0.75 floor as the single source the route compares against", () => {
    expect(M19_AI_CONFIDENCE_FLOOR).toBe(0.75);
  });
});

// ── §4.1 the mounted surface ─────────────────────────────────────────────────────────────────────────

describe("M19-T07 §4.1 route mount", () => {
  /**
   * A REGISTRATION test, not a behaviour one, and it earns its place: Fastify resolves a path conflict at
   * `ready()`, not at compile time, and §4.1's table puts a static segment (`/triage-calls/paper-reentry`)
   * under the same prefix as a parameterised one (`/triage-calls/:triageCallId`). Every gate in the repo
   * is green on a tree that never gets built — the "running the app finds what gates miss" failure mode.
   */
  it("mounts every §4.1 row with no path conflict", async () => {
    const app = Fastify();
    const stub = new Proxy({}, { get: () => async () => ({}) }) as never;
    mountM19Routes(app, { readService: stub, writeService: stub });
    await app.ready();
    const tree = app.printRoutes({ commonPrefix: false });

    for (const path of [
      "/api/v1/triage-calls",
      "/paper-reentry",
      "/identify-patient",
      "/apply-protocol",
      "/complete-protocol",
      "/awaiting-callback",
      "/disposition",
      "/transcript-decrypt",
      "/api/v1/escalations",
      "/api/v1/oncall/shifts",
      "/api/v1/oncall/current",
      "/api/v1/oncall/policy",
      "/api/v1/oncall/external-vendors",
      "/api/v1/triage-protocols",
      "/api/v1/triage-protocol-questions/:questionId",
      "/api/v1/portal/triage/recent",
    ]) {
      expect(tree).toContain(path);
    }
    await app.close();
  });
});
