/**
 * M20-T06 — the §4.1 route layer: the §4.6 permission keys, the §4.7 ABAC predicates, the §4.9 typed M36
 * alert rules, the §4.10 outbox catalog, the §2.4 effects runner and the §4.1 concurrency policy.
 *
 * These tests are about the DECISIONS, not the SQL: every rule below is expressed as a pure function
 * precisely so it can be exercised with no database, and the Drizzle services compose over them. The §9.3
 * RLS isolation and the §9.2 end-to-end paths run against a real PostgreSQL in the live suites.
 *
 * The properties pinned here are the ones the task exists to guarantee:
 *   • all twenty-five §4.6 keys reach M3's catalog, are single-owner, and the step-up set is EXACTLY the
 *     two §4.1 marks — the SOS cancel's biometric is deliberately NOT one of them;
 *   • `org_scope` is NOT registered by M20 (it is M3's `inOrg`), and the six that ARE registered are the
 *     six §4.7 names;
 *   • a §4.1 `∨` cell passes when EITHER arm allows and refuses only when both do — the ANDing bug that
 *     would deny everyone on `clinician_self ∨ supervises_clinician`;
 *   • `active_sos_responder` treats an unreadable M19 roster (`null`) differently from an empty one
 *     (`[]`), and refuses outside the actively-escalating states;
 *   • the effects runner throws on an unknown effect and on a declared event with no payload, and writes
 *     NO history row for a transition that does not move the state;
 *   • every §4.9 alert type has a rule, the six system-locked ones are unsuppressible, and the three that
 *     mean "a human is in danger and nobody has answered" carry the voice override;
 *   • the M20-F16 coordinate sentinel is distinguishable from a real cipher in both directions;
 *   • every §4.10 event name has a catalog entry, and the two composite-keyed payloads carry their
 *     discriminators.
 */
import {
  M20_CONTRIBUTED_PERMISSIONS,
  PERMISSIONS,
  allPermissionMirrorRows,
  createPredicateRegistry,
} from "@chartwarden/auth";
import {
  M20_EVENT_IDEMPOTENCY_KEYS,
  M20_EVENT_NAMES,
  M20_SYSTEM_LOCKED_ALERT_TYPES,
  SAFETY_SOS_TERMINAL_STATES,
} from "@chartwarden/types";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_SOS_RESPONDER_STATES,
  FIELD_ELIGIBLE_ROLE_KEYS,
  M20_ABAC_PREDICATES,
  SAFETY_OVERSIGHT_ROLES,
  buildFieldSafetyAbacPredicates,
  decideActiveSosResponder,
  decideFieldEligibleForSos,
  decideSafetySupervisorOrAbove,
  decideSupervisesClinician,
  denyStubSafetyAbacResolver,
  subscriptionCoversClinician,
} from "../src/modules/20-field-safety/abac-predicates";
import {
  M20_ALERT_CATEGORY,
  M20_ALERT_RULES,
  buildOshaFiledAlert,
  buildSosRaisedAlert,
  buildSosTerminusAlert,
  isSafetyAlertSuppressible,
  safetyAlertRuleFor,
} from "../src/modules/20-field-safety/alerts";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/events-by-m20";
import {
  M20_PERMISSION_KEY_LIST,
  M20_STEP_UP_PERMISSION_KEYS,
  M20_WARN_READ_AUDIT_PERMISSION_KEYS,
} from "../src/modules/20-field-safety/permission-keys";
import { ABAC_ANY } from "../src/modules/20-field-safety/routes/guards";
import {
  MissingSafetyOutboxPayloadError,
  SAFETY_NO_COORDINATE_SENTINEL,
  UnknownSafetyEffectError,
  coordinatesCaptured,
  decodeCoordinates,
  decodeCursor,
  encodeCoordinates,
  encodeCursor,
  ifMatchVersion,
  runEffects,
} from "../src/modules/20-field-safety/routes/index";
import {
  AcknowledgeSosBody,
  CreateIncidentBody,
  OshaSignoffBody,
  PatchPolicyBody,
  RaiseSosBody,
  RecordCheckInBody,
  parse,
} from "../src/modules/20-field-safety/routes/m20-typebox";

// ── §4.6 permission keys ─────────────────────────────────────────────────────────────────────────────

describe("M20-T06 §4.6 — the twenty-five contributed permission keys", () => {
  /**
   * §4.6's table spells the keys in TWO dialects — `safety.check_in.*` / `safety.sos.*` /
   * `safety.high_risk_area.*` / `safety.dashboard.*` / `safety.consent.*` on one hand,
   * `safety_incident.*` / `safety_policy.*` / `safety_supervisor.*` on the other — so a key here does NOT
   * reconstruct from `resource.action` the way M1/M2's do. The spec's spelling is the wire contract (a
   * grant a tenant already holds is keyed on it), so it is reproduced VERBATIM rather than normalised,
   * and this test pins the exact set instead of a naming rule that would have to be broken to match it.
   */
  it("contributes exactly §4.6's twenty-five keys, verbatim", () => {
    expect([...M20_PERMISSION_KEY_LIST].sort()).toEqual(
      [
        "safety.check_in.amend",
        "safety.check_in.create",
        "safety.check_in.read",
        "safety.consent.edit_self",
        "safety.consent.read_self",
        "safety.dashboard.read",
        "safety.high_risk_area.create",
        "safety.high_risk_area.edit",
        "safety.high_risk_area.read",
        "safety.sos.acknowledge",
        "safety.sos.cancel",
        "safety.sos.raise",
        "safety.sos.read",
        "safety.sos.read_coords",
        "safety.sos.resolve",
        "safety_incident.create",
        "safety_incident.edit_draft",
        "safety_incident.osha_signoff",
        "safety_incident.read",
        "safety_incident.submit",
        "safety_incident.transition",
        "safety_policy.edit",
        "safety_policy.read",
        "safety_supervisor.edit",
        "safety_supervisor.read",
      ].sort(),
    );
    for (const def of Object.values(M20_CONTRIBUTED_PERMISSIONS)) {
      expect(def.resource.length).toBeGreaterThan(0);
      expect(def.action.length).toBeGreaterThan(0);
    }
  });

  it("does NOT leak into M3's locked cross-cutting catalog", () => {
    for (const key of M20_PERMISSION_KEY_LIST) {
      expect(key in PERMISSIONS).toBe(false);
    }
  });

  it("reaches the platform mirror exactly once per key (single-owner)", () => {
    const rows = allPermissionMirrorRows().filter((r) => r.key.startsWith("safety"));
    const m20 = rows.filter((r) => M20_PERMISSION_KEY_LIST.includes(r.key as never));
    expect(m20).toHaveLength(25);
    expect(new Set(m20.map((r) => r.key)).size).toBe(25);
  });

  it("keeps the coordinate read a SEPARATE key from the alert read (§4.6's own emphasis)", () => {
    expect(M20_CONTRIBUTED_PERMISSIONS["safety.sos.read_coords"]).toBeDefined();
    expect(M20_CONTRIBUTED_PERMISSIONS["safety.sos.read"]).toBeDefined();
    expect(M20_CONTRIBUTED_PERMISSIONS["safety.sos.read_coords"].action).not.toBe(
      M20_CONTRIBUTED_PERMISSIONS["safety.sos.read"].action,
    );
  });

  it("names NO `org_scope` default — §4.7's org_scope IS M3's intrinsic `inOrg`", () => {
    for (const def of Object.values(M20_CONTRIBUTED_PERMISSIONS)) {
      expect(def.abac).not.toBe("org_scope");
    }
    expect(M20_CONTRIBUTED_PERMISSIONS["safety_policy.read"].abac).toBe("inOrg");
    expect(M20_CONTRIBUTED_PERMISSIONS["safety.high_risk_area.read"].abac).toBe("inOrg");
  });

  it("step-up is EXACTLY §4.1's two marks — the D5 cancel biometric is not one of them", () => {
    expect([...M20_STEP_UP_PERMISSION_KEYS].sort()).toEqual([
      "safety_incident.osha_signoff",
      "safety_policy.edit",
    ]);
    expect(M20_STEP_UP_PERMISSION_KEYS).not.toContain("safety.sos.cancel");
  });

  it("the warn-severity read-audit set is §4.1's three `yes (warn)` rows", () => {
    expect([...M20_WARN_READ_AUDIT_PERMISSION_KEYS].sort()).toEqual([
      "safety.sos.read_coords",
      "safety_incident.osha_signoff",
      "safety_policy.edit",
    ]);
  });

  it("puts the consent keys in `self_service`, not `compliance` (§2.2.8's data subject is the clinician)", () => {
    expect(M20_CONTRIBUTED_PERMISSIONS["safety.consent.read_self"].category).toBe("self_service");
    expect(M20_CONTRIBUTED_PERMISSIONS["safety.consent.edit_self"].category).toBe("self_service");
  });
});

// ── §4.7 ABAC predicates ─────────────────────────────────────────────────────────────────────────────

describe("M20-T06 §4.7 — the six ABAC predicates M20 owns", () => {
  it("owns exactly six names, and neither `org_scope` nor `caseload_or_scope` is one of them", () => {
    expect([...M20_ABAC_PREDICATES]).toEqual([
      "clinician_self",
      "supervises_clinician",
      "safety_supervisor_or_above",
      "incident_subject_or_supervisor",
      "active_sos_responder",
      "field_eligible_for_sos",
    ]);
    expect(M20_ABAC_PREDICATES).not.toContain("org_scope");
    expect(M20_ABAC_PREDICATES).not.toContain("caseload_or_scope");
  });

  it("`buildFieldSafetyAbacPredicates` returns a resolver for each owned name", () => {
    const built = buildFieldSafetyAbacPredicates({ resolver: denyStubSafetyAbacResolver });
    expect(Object.keys(built).sort()).toEqual([...M20_ABAC_PREDICATES].sort());
  });

  it("the deny-stub resolver denies every predicate (fail-closed, never open)", async () => {
    const built = buildFieldSafetyAbacPredicates({
      resolver: denyStubSafetyAbacResolver,
      ports: {
        async onCallForProviderEntity() {
          return null;
        },
      },
    });
    const context = {
      organizationId: "org-1",
      userId: "user-1",
      roles: [] as string[],
      attributes: { membershipId: "m-1" } as Record<string, unknown>,
      providerEntityIds: [] as string[],
      locationIds: [] as string[],
    };
    for (const name of M20_ABAC_PREDICATES) {
      // `clinician_self` on a NAMELESS target is the create case ("acting as yourself"), which is the one
      // legitimate `true` a deny-stub can produce — every predicate that names a ROW still denies.
      expect(await built[name]?.(context as never, { sosAlertId: "sos-1" })).toBe(false);
    }
  });

  it("`safety_supervisor_or_above` reads the M3 role-template spellings, not just §4.7's four words", () => {
    expect(decideSafetySupervisorOrAbove(["director_of_nursing"])).toBe(true);
    expect(decideSafetySupervisorOrAbove(["compliance_officer"])).toBe(true);
    expect(decideSafetySupervisorOrAbove(["registered_nurse"])).toBe(false);
    // an unreadable grant set DENIES; it is not "no roles"
    expect(decideSafetySupervisorOrAbove(null)).toBe(false);
    expect(SAFETY_OVERSIGHT_ROLES).toContain("clinical_supervisor");
  });

  it("`field_eligible_for_sos` covers the §4.7 discipline set and refuses an unreadable grant", () => {
    expect(decideFieldEligibleForSos(["registered_nurse"])).toBe(true);
    expect(decideFieldEligibleForSos(["volunteer"])).toBe(true);
    expect(decideFieldEligibleForSos(["billing_specialist"])).toBe(false);
    expect(decideFieldEligibleForSos(null)).toBe(false);
    expect(FIELD_ELIGIBLE_ROLE_KEYS).toContain("chaplain");
  });

  it("`supervises_clinician` reads BOTH arms of a vacation-forwarding row", () => {
    const clinician = {
      membershipId: "rn-1" as never,
      locationIds: ["loc-1"],
      providerEntityId: "pe-1" as never,
    };
    const forwarding = {
      supervisorMembershipId: "sup-1" as never,
      clinicianMembershipId: "rn-1" as never,
      locationId: null,
      providerEntityId: null,
      scopeKind: "explicit" as const,
      isVacationForwarding: true,
      vacationForwardToMembershipId: "sup-2" as never,
    };
    // the SUBSCRIBER keeps read access to the clinician whose coverage she arranged …
    expect(
      decideSupervisesClinician({
        subscriptions: [forwarding],
        actingMembershipId: "sup-1",
        clinician,
      }),
    ).toBe(true);
    // … and the FORWARD TARGET, who is the one being paged tonight, must also pass.
    expect(
      decideSupervisesClinician({
        subscriptions: [forwarding],
        actingMembershipId: "sup-2",
        clinician,
      }),
    ).toBe(true);
    // a third party does not
    expect(
      decideSupervisesClinician({
        subscriptions: [forwarding],
        actingMembershipId: "sup-3",
        clinician,
      }),
    ).toBe(false);
    // an UNREADABLE subscription list denies — it is not "nobody watches her"
    expect(
      decideSupervisesClinician({ subscriptions: null, actingMembershipId: "sup-1", clinician }),
    ).toBe(false);
  });

  it("the subscription scope match ignores alert kinds — authorization is not paging", () => {
    const clinician = {
      membershipId: "rn-1" as never,
      locationIds: ["loc-1"],
      providerEntityId: "pe-1" as never,
    };
    // a `location`-scoped row covers ANY of a traveling clinician's locations
    expect(
      subscriptionCoversClinician(
        {
          supervisorMembershipId: "sup-1" as never,
          clinicianMembershipId: null,
          locationId: "loc-1",
          providerEntityId: null,
          scopeKind: "location",
          isVacationForwarding: false,
          vacationForwardToMembershipId: null,
        },
        clinician,
      ),
    ).toBe(true);
    // the `role` layer covers everyone by construction (D8)
    expect(
      subscriptionCoversClinician(
        {
          supervisorMembershipId: "sup-1" as never,
          clinicianMembershipId: null,
          locationId: null,
          providerEntityId: null,
          scopeKind: "role",
          isVacationForwarding: false,
          vacationForwardToMembershipId: null,
        },
        clinician,
      ),
    ).toBe(true);
  });

  it("`active_sos_responder` distinguishes an unreadable roster from an empty one", () => {
    const alert = {
      organizationId: "org-1" as never,
      sosAlertId: "sos-1",
      providerEntityId: "pe-1" as never,
      postedByMembershipId: "rn-1" as never,
      lifecycleState: "escalation_tier_2" as const,
    };
    // the SUBSCRIPTION arm answers on its own
    expect(
      decideActiveSosResponder({
        alert,
        supervises: true,
        onCallMemberships: null,
        actingMembershipId: "sup-1",
      }),
    ).toBe(true);
    // M19 answered and named her
    expect(
      decideActiveSosResponder({
        alert,
        supervises: false,
        onCallMemberships: ["rn-9" as never],
        actingMembershipId: "rn-9",
      }),
    ).toBe(true);
    // M19 answered and did NOT name her
    expect(
      decideActiveSosResponder({
        alert,
        supervises: false,
        onCallMemberships: [],
        actingMembershipId: "rn-9",
      }),
    ).toBe(false);
    // M19 did NOT answer — `null` is not eligibility
    expect(
      decideActiveSosResponder({
        alert,
        supervises: false,
        onCallMemberships: null,
        actingMembershipId: "rn-9",
      }),
    ).toBe(false);
  });

  it("`active_sos_responder` refuses outside the actively-escalating states", () => {
    for (const lifecycleState of SAFETY_SOS_TERMINAL_STATES) {
      expect(
        decideActiveSosResponder({
          alert: {
            organizationId: "org-1" as never,
            sosAlertId: "sos-1",
            providerEntityId: "pe-1" as never,
            postedByMembershipId: "rn-1" as never,
            lifecycleState,
          },
          supervises: true,
          onCallMemberships: null,
          actingMembershipId: "sup-1",
        }),
      ).toBe(false);
    }
  });

  it("`emergency_terminus` IS an active-responder state — the terminus must be acknowledgeable", () => {
    expect(ACTIVE_SOS_RESPONDER_STATES).toContain("emergency_terminus");
    expect(ACTIVE_SOS_RESPONDER_STATES).not.toContain("cancel_window_open");
  });

  it("every owned name resolves through a fresh M3 predicate registry", () => {
    const registry = createPredicateRegistry();
    const built = buildFieldSafetyAbacPredicates({ resolver: denyStubSafetyAbacResolver });
    for (const [name, fn] of Object.entries(built)) registry.register(name, fn as never);
    for (const name of M20_ABAC_PREDICATES) expect(registry.has(name)).toBe(true);
  });
});

// ── §4.1 the `∨` cell ────────────────────────────────────────────────────────────────────────────────

describe("M20-T06 §4.1 — a disjunction cell is ONE preHandler, not two ANDed", () => {
  const allow = async () => {};
  const deny = (label: string) => async () => {
    throw new Error(label);
  };

  it("passes when the FIRST arm allows (the second is never consulted)", async () => {
    let secondRan = false;
    const guard = ABAC_ANY(allow, async () => {
      secondRan = true;
    });
    await guard({} as never, {} as never);
    expect(secondRan).toBe(false);
  });

  it("passes when only the SECOND arm allows — the ANDing bug would deny here", async () => {
    const guard = ABAC_ANY(deny("clinician_self"), allow);
    await expect(guard({} as never, {} as never)).resolves.toBeUndefined();
  });

  it("re-throws the LAST arm's refusal when every arm denies (keeps its 403/404 shape)", async () => {
    const guard = ABAC_ANY(deny("first"), deny("last"));
    await expect(guard({} as never, {} as never)).rejects.toThrow("last");
  });
});

// ── §2.4 the effects runner ──────────────────────────────────────────────────────────────────────────

describe("M20-T06 §2.4 — the effects runner cannot lose an effect", () => {
  const baseCtx = {
    organizationId: "org-1",
    providerEntityId: "pe-1",
    locationId: null,
    sosAlertId: "sos-1",
    at: new Date("2026-07-31T10:00:00.000Z"),
    actorMembershipId: "sup-1",
    reason: null,
    outbox: { async publish() {} },
    aggregateKind: "safety_sos_alert",
    aggregateId: "sos-1",
    payloads: {},
  };

  it("throws when a declared outbox event has no payload (rule 1)", async () => {
    await expect(
      runEffects({}, [{ kind: "outbox", event: "m20.safety.sos_alert_resolved" }], baseCtx),
    ).rejects.toBeInstanceOf(MissingSafetyOutboxPayloadError);
  });

  it("throws on a `set_timestamp` naming a column the schema does not have (rule 2)", async () => {
    await expect(
      runEffects(
        {},
        [
          {
            kind: "set_timestamp",
            field: "posted_at" as never,
            at: "2026-07-31T10:00:00.000Z" as never,
          },
        ],
        baseCtx,
      ),
    ).rejects.toBeInstanceOf(UnknownSafetyEffectError);
  });

  it("throws on an effect kind the runner does not know (rule 5)", async () => {
    await expect(
      runEffects({}, [{ kind: "teleport_supervisor" } as never], baseCtx),
    ).rejects.toBeInstanceOf(UnknownSafetyEffectError);
  });

  it("writes the D5 cancel TRIPLE as one branch — status, verdict and instant move together", async () => {
    const patch = await runEffects(
      {},
      [
        {
          kind: "set_cancel_status",
          status: "cancelled_in_window",
          biometricResult: "passed",
          attemptedAt: "2026-07-31T10:00:01.000Z" as never,
        },
      ],
      baseCtx,
    );
    expect(patch.cancelStatus).toBe("cancelled_in_window");
    expect(patch.cancelBiometricResult).toBe("passed");
    expect(patch.cancelAttemptedAt?.toISOString()).toBe("2026-07-31T10:00:01.000Z");
  });

  it("writes a history row ONLY for an effect list that declares one (the terminus loop declares none)", async () => {
    const rows: unknown[] = [];
    const ctx = {
      ...baseCtx,
      stateHistory: {
        async insert(_tx: unknown, row: unknown) {
          rows.push(row);
        },
      },
    };
    // a real transition
    await runEffects(
      {},
      [
        {
          kind: "sos_state_history",
          from: "acknowledging",
          to: "escalation_tier_1",
          systemActor: true,
        },
      ],
      ctx,
    );
    // the terminus re-page: audit only, no history (m20_ssash_no_self would refuse from === to)
    await runEffects({}, [{ kind: "audit" }, { kind: "page_wardenx_ops" }], ctx);
    expect(rows).toHaveLength(1);
    expect(
      (rows[0] as { transitionedByMembershipId: string | null }).transitionedByMembershipId,
    ).toBeNull();
  });

  it("a watchdog transition carries NO acting membership; a human one does", async () => {
    const rows: { transitionedByMembershipId: string | null }[] = [];
    const ctx = {
      ...baseCtx,
      stateHistory: {
        async insert(_tx: unknown, row: unknown) {
          rows.push(row as { transitionedByMembershipId: string | null });
        },
      },
    };
    await runEffects(
      {},
      [
        {
          kind: "sos_state_history",
          from: "acknowledging",
          to: "acknowledged",
          systemActor: false,
        },
      ],
      ctx,
    );
    expect(rows[0]?.transitionedByMembershipId).toBe("sup-1");
  });
});

// ── §4.9 the M36 alert rules ─────────────────────────────────────────────────────────────────────────

describe("M20-T06 §4.9 — the twelve alert rules", () => {
  it("every §4.9 alert type has a rule, in the `field_safety` category", () => {
    for (const rule of M20_ALERT_RULES) {
      expect(rule.category).toBe(M20_ALERT_CATEGORY);
      expect(safetyAlertRuleFor(rule.eventType)).toBe(rule);
    }
    expect(new Set(M20_ALERT_RULES.map((r) => r.eventType)).size).toBe(M20_ALERT_RULES.length);
  });

  it("the six §4.9 system-locked types are unsuppressible, and the list is the PINNED one", () => {
    for (const eventType of M20_SYSTEM_LOCKED_ALERT_TYPES) {
      expect(isSafetyAlertSuppressible(eventType)).toBe(false);
      expect(safetyAlertRuleFor(eventType)?.systemLocked).toBe(true);
    }
    expect(isSafetyAlertSuppressible("m20.safety.sos_alert_resolved")).toBe(true);
    // an unclassified type must NOT default to silenceable
    expect(isSafetyAlertSuppressible("m20.safety.something_nobody_classified")).toBe(false);
  });

  it("the Tier-1 voice override rides the raise, the escalation AND the terminus", () => {
    for (const eventType of [
      "m20.safety.sos_alert_raised",
      "m20.safety.sos_alert_escalated",
      "m20.safety.sos_terminus_reached",
    ] as const) {
      expect(safetyAlertRuleFor(eventType)?.channelsOverride).toContain("voice");
    }
    // …and NOT the check-in escalation, whose top rung is carried on the PAYLOAD's `tier`
    expect(safetyAlertRuleFor("m20.safety.check_in_escalated")?.channelsOverride).toBeNull();
  });

  it("the SOS rules bind the §4.5 composed resolver, not an M36 built-in", () => {
    expect(safetyAlertRuleFor("m20.safety.sos_alert_raised")?.recipientResolver).toBe(
      "field_safety_composed",
    );
    expect(safetyAlertRuleFor("m20.safety.sos_alert_acknowledged")?.recipientResolver).toBe(
      "field_safety_composed_plus_poster",
    );
  });

  it("no alert payload carries a coordinate or a narrative (§8.2 — every field leaves the platform)", () => {
    const raised = buildSosRaisedAlert({
      orgId: "org-1" as never,
      providerEntityId: "pe-1" as never,
      sosAlertId: "sos-1" as never,
      postedByMembershipId: "rn-1" as never,
      postedByFirstName: "Sarah",
      postedAt: "2026-07-31T11:00:00.000Z" as never,
    });
    const keys = Object.keys(raised);
    expect(keys).not.toContain("latitude");
    expect(keys).not.toContain("longitude");
    expect(keys).not.toContain("postedCoordinates");
    expect(raised.severityNote).toBe("LIFE_SAFETY");
  });

  it("the terminus alert says whether a PSAP number is available, never the number", () => {
    const terminus = buildSosTerminusAlert({
      orgId: "org-1" as never,
      providerEntityId: "pe-1" as never,
      sosAlertId: "sos-1" as never,
      terminusReachedAt: "2026-07-31T11:05:00.000Z" as never,
      loopIteration: 3,
      emergencyContactCallInitiated: false,
      psapNumberAvailable: true,
    });
    expect(Object.keys(terminus)).not.toContain("psapNumber");
    expect(terminus.psapNumberAvailable).toBe(true);
    expect(terminus.loopIteration).toBe(3);
  });

  it("the OSHA alert carries the state's own clock, because M20 holds no OSHA rule table", () => {
    const filed = buildOshaFiledAlert({
      orgId: "org-1" as never,
      providerEntityId: "pe-1" as never,
      incidentId: "inc-1" as never,
      category: "dog_bite",
      severityLevel: "moderate",
      signedOffByMembershipId: "co-1" as never,
      stateCode: "OR",
      reportingWindowHours: 24,
    });
    expect(filed.stateCode).toBe("OR");
    expect(filed.reportingWindowHours).toBe(24);
    // the incident's clinical severity and the ALERT's severity are different ladders
    expect(filed.severity).toBe("warn");
    expect(filed.severityLevel).toBe("moderate");
  });
});

// ── §4.10 the outbox catalog ─────────────────────────────────────────────────────────────────────────

describe("M20-T06 §4.10 — the outbox catalog contribution", () => {
  it("carries one entry per §4.10 event name, all owned by m20", () => {
    const names = M20_OUTBOX_EVENTS.map((e) => e.eventName).sort();
    expect(names).toEqual([...M20_EVENT_NAMES].sort());
    for (const entry of M20_OUTBOX_EVENTS) {
      expect(entry.moduleOwner).toBe("m20");
      expect(entry.eventName).toMatch(/^m20\.[a-z_]+\.[a-z_]+$/);
    }
  });

  it("the two composite-keyed events declare their discriminators as REQUIRED payload fields", () => {
    const escalated = M20_OUTBOX_EVENTS.find(
      (e) => e.eventName === "m20.safety.check_in_escalated",
    );
    const terminus = M20_OUTBOX_EVENTS.find(
      (e) => e.eventName === "m20.safety.sos_terminus_reached",
    );
    const props = (entry: typeof escalated) =>
      Object.keys(
        (entry?.payloadSchema as { properties?: Record<string, unknown> })?.properties ?? {},
      );
    expect(props(escalated)).toContain("tier");
    expect(props(terminus)).toContain("loopIteration");
    expect(M20_EVENT_IDEMPOTENCY_KEYS["m20.safety.check_in_escalated"]).toEqual([
      "scheduleId",
      "tier",
    ]);
    expect(M20_EVENT_IDEMPOTENCY_KEYS["m20.safety.sos_terminus_reached"]).toEqual([
      "sosAlertId",
      "loopIteration",
    ]);
  });

  it("the SOS raise carries `coordinatesCaptured`, never a coordinate (§8.8.2)", () => {
    const raised = M20_OUTBOX_EVENTS.find((e) => e.eventName === "m20.safety.sos_alert_raised");
    const props = Object.keys(
      (raised?.payloadSchema as { properties?: Record<string, unknown> })?.properties ?? {},
    );
    expect(props).toContain("coordinatesCaptured");
    expect(props).not.toContain("latitude");
  });
});

// ── M20-F16 the coordinate sentinel ──────────────────────────────────────────────────────────────────

describe("M20-T06 / M20-F16 — the coordinate sentinel", () => {
  it("is distinguishable from a real cipher in both directions", () => {
    expect(coordinatesCaptured(SAFETY_NO_COORDINATE_SENTINEL)).toBe(false);
    expect(coordinatesCaptured(Buffer.from("some-real-aead-ciphertext", "utf8"))).toBe(true);
    // an EMPTY buffer is what a failed encrypt also produces, and it is not a captured coordinate either
    expect(coordinatesCaptured(Buffer.alloc(0))).toBe(false);
    expect(coordinatesCaptured(null)).toBe(false);
  });

  it("round-trips the at-rest shape and refuses an unusable one rather than answering 0,0", () => {
    const plain = encodeCoordinates({ latitude: 45.52, longitude: -122.68, accuracyM: 12 });
    expect(decodeCoordinates(plain)).toEqual({ lat: 45.52, lng: -122.68, acc: 12 });
    expect(decodeCoordinates("not json")).toBeNull();
    expect(decodeCoordinates(JSON.stringify({ lat: 999, lng: 0 }))).toBeNull();
    expect(decodeCoordinates(null)).toBeNull();
  });
});

// ── §4.1 concurrency policy ──────────────────────────────────────────────────────────────────────────

describe("M20-T06 §4.1 — cursors and If-Match", () => {
  it("a tampered cursor THROWS rather than silently serving page 1", () => {
    const cursor = encodeCursor("org-1", { a: "2026-07-31T10:00:00.000Z", id: "row-1" });
    expect(decodeCursor("org-1", cursor)).toEqual({ a: "2026-07-31T10:00:00.000Z", id: "row-1" });
    expect(() => decodeCursor("org-1", `${cursor}x`)).toThrow();
    // a cursor minted for another org does not verify here
    expect(() => decodeCursor("org-2", cursor)).toThrow();
    expect(decodeCursor("org-1", undefined)).toBeNull();
  });

  it("`If-Match` tolerates weak ETags and refuses a blank one when required", () => {
    expect(ifMatchVersion({ headers: { "if-match": 'W/"3"' } })).toBe(3);
    expect(ifMatchVersion({ headers: {} })).toBeUndefined();
    expect(() => ifMatchVersion({ headers: {} }, true)).toThrow();
    // `Number("")` is 0 and version 0 does not exist — the empty header is refused, not coerced
    expect(() => ifMatchVersion({ headers: { "if-match": "" } }, true)).toThrow();
  });
});

// ── §4.2 request schemas ─────────────────────────────────────────────────────────────────────────────

describe("M20-T06 §4.2 — the request schemas", () => {
  it("the SOS press accepts a coordinate-free body (M20-F16 — §4.2's `required` loses)", () => {
    expect(() => parse(RaiseSosBody, {})).not.toThrow();
    expect(() =>
      parse(RaiseSosBody, {
        postedCoordinates: { latitude: 45.5, longitude: -122.6, accuracyM: 8 },
      }),
    ).not.toThrow();
  });

  it("the incident create pins `category`/`severity` to closed unions, not `Type.String()`", () => {
    const base = {
      affectedClinicianMembershipId: "11111111-1111-4111-8111-111111111111",
      severity: "moderate",
      occurredAt: "2026-07-30T14:30:00.000Z",
      narrative: "x".repeat(220),
    };
    expect(() => parse(CreateIncidentBody, { ...base, category: "dog_bite" })).not.toThrow();
    expect(() => parse(CreateIncidentBody, { ...base, category: "dog_bites" })).toThrow();
  });

  it("the incident create has NO `oshaReportable` field — D9 makes that a supervisor's separate act", () => {
    const props = Object.keys(
      (CreateIncidentBody as unknown as { properties: Record<string, unknown> }).properties,
    );
    expect(props).not.toContain("oshaReportable");
  });

  it("the OSHA sign-off requires the state code and the reporting window", () => {
    expect(() =>
      parse(OshaSignoffBody, {
        oshaReportable: true,
        reason: "x".repeat(45),
        stateCode: "OR",
        reportingWindowHours: 24,
      }),
    ).not.toThrow();
    expect(() =>
      parse(OshaSignoffBody, { oshaReportable: true, reason: "x".repeat(45), stateCode: "OR" }),
    ).toThrow();
    // a two-word reason is refused at the boundary (§7.6's is a citation of the governing rule)
    expect(() =>
      parse(OshaSignoffBody, {
        oshaReportable: true,
        reason: "reportable",
        stateCode: "OR",
        reportingWindowHours: 24,
      }),
    ).toThrow();
  });

  it("the acknowledgment enforces §2.2.6's CRITICAL ≥40 floor, above §3.3's ≥20", () => {
    expect(() => parse(AcknowledgeSosBody, { actionTaken: "x".repeat(40) })).not.toThrow();
    expect(() => parse(AcknowledgeSosBody, { actionTaken: "x".repeat(25) })).toThrow();
  });

  it("the check-in body caps the concern note at §3.3's ≥20 floor", () => {
    expect(() => parse(RecordCheckInBody, { kind: "ad_hoc", status: "ok" })).not.toThrow();
    expect(() =>
      parse(RecordCheckInBody, {
        kind: "ad_hoc",
        status: "concerned_stop",
        concernNote: "too short",
      }),
    ).toThrow();
  });

  it("the policy patch requires a ≥30-char edit reason and restates NO band (the resolver owns it)", () => {
    expect(() => parse(PatchPolicyBody, { editReason: "x".repeat(30) })).not.toThrow();
    expect(() => parse(PatchPolicyBody, { editReason: "too short" })).toThrow();
    // deliberately ACCEPTED at the boundary and refused by `assertPolicyEditValid`, which can name the
    // band AND check the ladder a per-field range cannot express
    expect(() =>
      parse(PatchPolicyBody, { editReason: "x".repeat(30), midVisitCadenceMinutes: 9999 }),
    ).not.toThrow();
  });
});
