// apps/backend/__tests__/supplies-authz.test.ts — M21-T05 (§4.3 permission keys · §4.4 ABAC predicates ·
// §2.11 the effect runner · §8.2 the eraser).
//
// The properties this file exists to hold — each one is a way the surface could quietly become fail-OPEN,
// or a way a documented obligation could silently stop happening:
//
//   • every §4.3 key is single-owner in the platform mirror, and the platform-only catalog keys are the
//     ONLY ones marked as such;
//   • `controlled_substance_dispatcher_eligible` denies an unreadable role set, denies a subject assigned
//     to a different Location unless they hold a cross-location designation, and — the part that is easy to
//     get backwards — ALLOWS a target that moves nothing scheduled, because §4.1's cell is conditional;
//   • `comfort_kit_return_reconciler_eligible` denies the DISPATCHER of the same kit (separation of duties)
//     BEFORE it ever considers their authority, and denies a controlled kit with no witness on the row;
//   • both predicates deny on an unresolvable target, an unreadable resolver and a thrown error — there is
//     no fact about a CII solution whose unavailability should be read as permission to move it;
//   • the §2.11 effect runner THROWS on a declared event with no payload, and THROWS on a `set_timestamp`
//     naming a column it does not know (the M21-T03 gotcha: an effect naming a non-existent column
//     compiles clean and passes every gate while writing nothing);
//   • an alert failure never fails the mutation;
//   • the §8.2 eraser SHREDS before it deletes, PRESERVES the de-identified controlled-substance ledger
//     (DEA 21 CFR §1304.04), and a second erase reports zero.
import { M21_CONTRIBUTED_PERMISSIONS, allPermissionMirrorRows } from "@chartwarden/auth";
import type { AbacContext } from "@chartwarden/auth";
import { describe, expect, it } from "vitest";
import {
  COMFORT_KIT_RECONCILER_ROLES,
  CONTROLLED_SUBSTANCE_DISPATCHER_ROLES,
  CROSS_LOCATION_DISPATCH_ROLES,
  DEIDENTIFIED_UUID,
  M21_ABAC_PREDICATES,
  M21_PERMISSION_KEY_LIST,
  M21_PLATFORM_ONLY_PERMISSION_KEYS,
  MissingOutboxPayloadError,
  type SuppliesAbacResolver,
  type SupplyEraseStore,
  UnknownTimestampFieldError,
  buildSuppliesAbacPredicates,
  decideDispatcherEligible,
  decideReconcilerEligible,
  denyStubSuppliesAbacResolver,
  eraseSupplyRecord,
  runEffects,
} from "../src/modules/21-supplies/index";
import type { SupplySideEffect } from "../src/modules/21-supplies/index";

const ORG = "11111111-1111-1111-1111-111111111111";
const LOC_A = "22222222-2222-2222-2222-222222222222";
const LOC_B = "33333333-3333-3333-3333-333333333333";
const DISPATCHER = "44444444-4444-4444-4444-444444444444";
const RECONCILER = "55555555-5555-5555-5555-555555555555";
const WITNESS = "66666666-6666-6666-6666-666666666666";
const RETURN_ID = "77777777-7777-7777-7777-777777777777";
const DISPATCH_ID = "88888888-8888-8888-8888-888888888888";

function contextOf(overrides: Partial<AbacContext> = {}): AbacContext {
  return {
    organizationId: ORG,
    userId: "user-1",
    roles: [],
    locationIds: [],
    attributes: {},
    ...overrides,
  } as AbacContext;
}

// ── §4.3 permission keys ─────────────────────────────────────────────────────────────────────────────

describe("M21-T05 §4.3 — the permission keys M21 contributes to M3", () => {
  it("every key is single-owner in the platform mirror", () => {
    const mirror = allPermissionMirrorRows().map((r) => r.key);
    for (const key of M21_PERMISSION_KEY_LIST) {
      expect(mirror.filter((k) => k === key)).toHaveLength(1);
    }
  });

  it("keys are `resource.action`-shaped and reconstruct from their resource/action", () => {
    for (const [key, def] of Object.entries(M21_CONTRIBUTED_PERMISSIONS)) {
      expect(key.endsWith(`.${def.action}`)).toBe(true);
    }
  });

  it("the platform-only catalog keys are exactly the two §4.3 marks them", () => {
    expect([...M21_PLATFORM_ONLY_PERMISSION_KEYS].sort()).toEqual([
      "supplies.item.retire",
      "supplies.item.write",
    ]);
  });

  it("`supplies.request.create` records NO default predicate — §4.1's cell is conditional", () => {
    // Recording `controlled_substance_dispatcher_eligible` as the catalog default would make every DME and
    // wound-supply request require controlled-substance dispatch authority, grounding the aides who file
    // most of them. The conditional gate lives in the route guard, where the kind is in hand.
    expect(M21_CONTRIBUTED_PERMISSIONS["supplies.request.create"].abac).toBe("none");
    expect(M21_CONTRIBUTED_PERMISSIONS["comfort_kit.dispatch.create"].abac).toBe(
      "controlled_substance_dispatcher_eligible",
    );
  });
});

// ── §4.4 `controlled_substance_dispatcher_eligible` ─────────────────────────────────────────────────

describe("M21-T05 §4.4 — controlled_substance_dispatcher_eligible", () => {
  const facts = {
    organizationId: ORG,
    targetId: DISPATCH_ID,
    locationId: LOC_A,
    involvesControlledSubstance: true,
  };

  it("admits a dispatcher assigned to the kit's own Location", () => {
    expect(
      decideDispatcherEligible(facts, {
        organizationId: ORG,
        membershipId: DISPATCHER,
        roleKeys: ["supply_coordinator"],
        locationIds: [LOC_A],
      }),
    ).toBe(true);
  });

  it("DENIES a dispatcher assigned only to another Location", () => {
    expect(
      decideDispatcherEligible(facts, {
        organizationId: ORG,
        membershipId: DISPATCHER,
        roleKeys: ["supply_coordinator"],
        locationIds: [LOC_B],
      }),
    ).toBe(false);
  });

  it("every cross-location role is ALSO a dispatcher role — the designation is a modifier, not a substitute", () => {
    for (const role of CROSS_LOCATION_DISPATCH_ROLES) {
      expect(CONTROLLED_SUBSTANCE_DISPATCHER_ROLES).toContain(role);
    }
  });

  it("admits a cross-location designation regardless of assignment", () => {
    for (const role of CROSS_LOCATION_DISPATCH_ROLES) {
      expect(
        decideDispatcherEligible(facts, {
          organizationId: ORG,
          membershipId: DISPATCHER,
          roleKeys: [role],
          locationIds: [],
        }),
      ).toBe(true);
    }
  });

  it("DENIES an unreadable role set — `null` is never 'no restriction'", () => {
    expect(
      decideDispatcherEligible(facts, {
        organizationId: ORG,
        membershipId: DISPATCHER,
        roleKeys: null,
        locationIds: [LOC_A],
      }),
    ).toBe(false);
  });

  it("DENIES an unreadable Location set for a subject with no cross-location designation", () => {
    expect(
      decideDispatcherEligible(facts, {
        organizationId: ORG,
        membershipId: DISPATCHER,
        roleKeys: ["supply_coordinator"],
        locationIds: null,
      }),
    ).toBe(false);
  });

  it("DENIES a session with no membership, and a cross-tenant target", () => {
    expect(
      decideDispatcherEligible(facts, {
        organizationId: ORG,
        membershipId: null,
        roleKeys: ["pharmacist"],
        locationIds: [LOC_A],
      }),
    ).toBe(false);
    expect(
      decideDispatcherEligible(
        { ...facts, organizationId: "other-org" },
        {
          organizationId: ORG,
          membershipId: DISPATCHER,
          roleKeys: ["pharmacist"],
          locationIds: [LOC_A],
        },
      ),
    ).toBe(false);
  });

  it("every role in the dispatcher set is accepted at its own Location", () => {
    for (const role of CONTROLLED_SUBSTANCE_DISPATCHER_ROLES) {
      expect(
        decideDispatcherEligible(facts, {
          organizationId: ORG,
          membershipId: DISPATCHER,
          roleKeys: [role],
          locationIds: [LOC_A],
        }),
      ).toBe(true);
    }
  });

  it("ALLOWS a resolved target that moves nothing scheduled (§4.1's conditional cell)", async () => {
    const resolver: SuppliesAbacResolver = {
      ...denyStubSuppliesAbacResolver,
      async loadRequest() {
        return {
          organizationId: ORG,
          targetId: "req-1",
          locationId: LOC_A,
          involvesControlledSubstance: false,
        };
      },
    };
    const predicate = buildSuppliesAbacPredicates({
      resolver,
    }).controlled_substance_dispatcher_eligible;
    // A wound-supply delivery: RBAC already passed and this narrower gate simply does not apply.
    expect(
      await predicate(contextOf({ attributes: { membershipId: DISPATCHER } }), {
        supplyRequestId: "req-1",
      }),
    ).toBe(true);
  });

  // ── GAP-064 — the Location is a SERVER fact, never the body's claim ───────────────────────────────
  it("GAP-064: evaluates a dispatch-create target against the STORED request Location, not the body's", async () => {
    const resolver: SuppliesAbacResolver = {
      ...denyStubSuppliesAbacResolver,
      async loadRequest() {
        // a wound-supply-kind row: the request-kind gate would allow, but the dispatch route declares it controlled
        return {
          organizationId: ORG,
          targetId: "req-1",
          locationId: LOC_B,
          involvesControlledSubstance: false,
        };
      },
      async roleKeysOf() {
        return ["supply_coordinator"];
      },
      async locationIdsOf() {
        return [LOC_A];
      },
    };
    const predicate = buildSuppliesAbacPredicates({
      resolver,
    }).controlled_substance_dispatcher_eligible;
    expect(
      await predicate(contextOf({ attributes: { membershipId: DISPATCHER } }), {
        supplyRequestId: "req-1",
        locationId: LOC_A, // the body's lie
        involvesControlledSubstance: true,
      }),
    ).toBe(false);
  });

  it("GAP-064: a dispatch-create target naming a request that does not exist DENIES", async () => {
    const predicate = buildSuppliesAbacPredicates({
      resolver: denyStubSuppliesAbacResolver,
    }).controlled_substance_dispatcher_eligible;
    expect(
      await predicate(contextOf({ attributes: { membershipId: DISPATCHER } }), {
        supplyRequestId: "missing",
        locationId: LOC_A,
        involvesControlledSubstance: true,
      }),
    ).toBe(false);
  });

  it("GAP-064: a request-create target resolves the Location off the ADMISSION, ignoring the body's", async () => {
    const resolver: SuppliesAbacResolver = {
      ...denyStubSuppliesAbacResolver,
      async loadAdmissionLocation() {
        return LOC_B;
      },
      async roleKeysOf() {
        return ["supply_coordinator"];
      },
      async locationIdsOf() {
        return [LOC_A];
      },
    };
    const predicate = buildSuppliesAbacPredicates({
      resolver,
    }).controlled_substance_dispatcher_eligible;
    expect(
      await predicate(contextOf({ attributes: { membershipId: DISPATCHER } }), {
        admissionId: "adm-1",
        locationId: LOC_A,
        involvesControlledSubstance: true,
      }),
    ).toBe(false);
  });

  it("GAP-064: a request-create target whose admission Location cannot be resolved DENIES", async () => {
    const predicate = buildSuppliesAbacPredicates({
      resolver: denyStubSuppliesAbacResolver,
    }).controlled_substance_dispatcher_eligible;
    expect(
      await predicate(contextOf({ attributes: { membershipId: DISPATCHER } }), {
        admissionId: "adm-1",
        locationId: LOC_A,
        involvesControlledSubstance: true,
      }),
    ).toBe(false);
  });

  it("GAP-064: a NON-controlled create target passes WITHOUT consulting the admission siting", async () => {
    const resolver: SuppliesAbacResolver = {
      ...denyStubSuppliesAbacResolver,
      async loadAdmissionLocation() {
        throw new Error("must not be consulted");
      },
    };
    const predicate = buildSuppliesAbacPredicates({
      resolver,
    }).controlled_substance_dispatcher_eligible;
    expect(
      await predicate(contextOf({ attributes: { membershipId: DISPATCHER } }), {
        admissionId: "adm-1",
        locationId: LOC_A,
        involvesControlledSubstance: false,
      }),
    ).toBe(true);
  });

  it("GAP-064: a controlled create target on an UNSITED admission evaluates against the actor's own Locations", async () => {
    const resolver: SuppliesAbacResolver = {
      ...denyStubSuppliesAbacResolver,
      async roleKeysOf() {
        return ["supply_coordinator"];
      },
      async locationIdsOf() {
        return [LOC_A];
      },
    };
    const predicate = buildSuppliesAbacPredicates({
      resolver,
    }).controlled_substance_dispatcher_eligible;
    const ctx = contextOf({ attributes: { membershipId: DISPATCHER } });
    const target = { admissionId: "adm-1", involvesControlledSubstance: true };
    expect(await predicate(ctx, { ...target, locationId: LOC_A })).toBe(true);
    expect(await predicate(ctx, { ...target, locationId: LOC_B })).toBe(false);
  });

  it("GAP-064: a controlled create target DENIES when the admission siting read throws", async () => {
    const resolver: SuppliesAbacResolver = {
      ...denyStubSuppliesAbacResolver,
      async loadAdmissionLocation() {
        throw new Error("seam down");
      },
      async roleKeysOf() {
        return ["supply_coordinator"];
      },
      async locationIdsOf() {
        return [LOC_A];
      },
    };
    const predicate = buildSuppliesAbacPredicates({
      resolver,
    }).controlled_substance_dispatcher_eligible;
    expect(
      await predicate(contextOf({ attributes: { membershipId: DISPATCHER } }), {
        admissionId: "adm-1",
        locationId: LOC_A,
        involvesControlledSubstance: true,
      }),
    ).toBe(false);
  });

  it("DENIES a create-path target that declares no Location (a route that forgot its getTarget)", async () => {
    const predicate = buildSuppliesAbacPredicates({
      resolver: denyStubSuppliesAbacResolver,
    }).controlled_substance_dispatcher_eligible;
    expect(
      await predicate(contextOf({ attributes: { membershipId: DISPATCHER } }), {
        involvesControlledSubstance: true,
      }),
    ).toBe(false);
  });

  it("DENIES when the resolver throws", async () => {
    const resolver: SuppliesAbacResolver = {
      ...denyStubSuppliesAbacResolver,
      async roleKeysOf() {
        throw new Error("db down");
      },
    };
    const predicate = buildSuppliesAbacPredicates({
      resolver,
    }).controlled_substance_dispatcher_eligible;
    expect(
      await predicate(contextOf({ attributes: { membershipId: DISPATCHER } }), {
        locationId: LOC_A,
        involvesControlledSubstance: true,
      }),
    ).toBe(false);
  });
});

// ── §4.4 `comfort_kit_return_reconciler_eligible` ───────────────────────────────────────────────────

describe("M21-T05 §4.4 — comfort_kit_return_reconciler_eligible", () => {
  const controlledReturn = {
    organizationId: ORG,
    returnId: RETURN_ID,
    dispatchId: DISPATCH_ID,
    dispatchedByMembershipId: DISPATCHER as never,
    assignedRetrievingMembershipId: null,
    disposalWitnessMembershipId: WITNESS as never,
    containsControlledSubstance: true,
  };

  it("admits a reconciler who is not the dispatcher, with a distinct witness on the row", () => {
    expect(
      decideReconcilerEligible(controlledReturn, {
        organizationId: ORG,
        membershipId: RECONCILER,
        roleKeys: ["registered_nurse"],
      }),
    ).toBe(true);
  });

  it("DENIES the DISPATCHER of the same kit — separation of duties, checked first", () => {
    // The dispatcher is usually a pharmacist or supply coordinator who WOULD pass the authority test, so
    // this is the clause a short-circuit refactor would most easily let through.
    expect(
      decideReconcilerEligible(controlledReturn, {
        organizationId: ORG,
        membershipId: DISPATCHER,
        roleKeys: ["supply_coordinator"],
      }),
    ).toBe(false);
  });

  it("DENIES a controlled kit with NO witness recorded on the return row", () => {
    expect(
      decideReconcilerEligible(
        { ...controlledReturn, disposalWitnessMembershipId: null },
        { organizationId: ORG, membershipId: RECONCILER, roleKeys: ["registered_nurse"] },
      ),
    ).toBe(false);
  });

  it("DENIES a witness who is the reconciler, or who is also the retriever", () => {
    expect(
      decideReconcilerEligible(
        { ...controlledReturn, disposalWitnessMembershipId: RECONCILER as never },
        { organizationId: ORG, membershipId: RECONCILER, roleKeys: ["registered_nurse"] },
      ),
    ).toBe(false);
    expect(
      decideReconcilerEligible(
        {
          ...controlledReturn,
          assignedRetrievingMembershipId: WITNESS as never,
        },
        { organizationId: ORG, membershipId: RECONCILER, roleKeys: ["registered_nurse"] },
      ),
    ).toBe(false);
  });

  it("does NOT require a witness on a kit that held nothing scheduled", () => {
    expect(
      decideReconcilerEligible(
        {
          ...controlledReturn,
          containsControlledSubstance: false,
          disposalWitnessMembershipId: null,
        },
        { organizationId: ORG, membershipId: RECONCILER, roleKeys: ["registered_nurse"] },
      ),
    ).toBe(true);
  });

  it("DENIES an unreadable role set and a role outside the reconciler set", () => {
    expect(
      decideReconcilerEligible(controlledReturn, {
        organizationId: ORG,
        membershipId: RECONCILER,
        roleKeys: null,
      }),
    ).toBe(false);
    // `pharmacist` holds DISPATCH authority but is deliberately absent from the reconciler set.
    expect(COMFORT_KIT_RECONCILER_ROLES).not.toContain("pharmacist");
    expect(
      decideReconcilerEligible(controlledReturn, {
        organizationId: ORG,
        membershipId: RECONCILER,
        roleKeys: ["pharmacist"],
      }),
    ).toBe(false);
  });

  it("DENIES an unresolvable return (absent / cross-tenant / unreadable)", async () => {
    const predicate = buildSuppliesAbacPredicates({
      resolver: denyStubSuppliesAbacResolver,
    }).comfort_kit_return_reconciler_eligible;
    expect(
      await predicate(contextOf({ attributes: { membershipId: RECONCILER } }), {
        returnId: RETURN_ID,
      }),
    ).toBe(false);
    // A target that names nothing denies too.
    expect(await predicate(contextOf({ attributes: { membershipId: RECONCILER } }), {})).toBe(
      false,
    );
  });

  it("registers exactly the two §4.4 names M21 owns", () => {
    expect([...M21_ABAC_PREDICATES]).toEqual([
      "controlled_substance_dispatcher_eligible",
      "comfort_kit_return_reconciler_eligible",
    ]);
    expect(
      Object.keys(buildSuppliesAbacPredicates({ resolver: denyStubSuppliesAbacResolver })).sort(),
    ).toEqual([...M21_ABAC_PREDICATES].sort());
  });
});

// ── §2.11 the effect runner ─────────────────────────────────────────────────────────────────────────

describe("M21-T05 §2.11 — the effect runner", () => {
  const baseCtx = {
    organizationId: ORG,
    at: new Date("2026-07-31T12:00:00.000Z"),
    aggregateKind: "supply_request",
    aggregateId: "req-1",
  };

  it("publishes a declared event with its payload, carrying the org on the envelope", async () => {
    const published: unknown[] = [];
    await runEffects(
      {},
      [{ kind: "outbox", event: "m21.supply_request.status_changed" }] as SupplySideEffect[],
      {
        ...baseCtx,
        outbox: {
          async publish(_tx, emission) {
            published.push(emission);
          },
        },
        payloads: { "m21.supply_request.status_changed": { toStatus: "ordered" } },
      },
    );
    expect(published).toHaveLength(1);
    // `outbox_event.organization_id` is NOT NULL; an emission without it fails the mutation's own tx.
    expect(published[0]).toMatchObject({
      eventName: "m21.supply_request.status_changed",
      organizationId: ORG,
    });
  });

  it("THROWS on a declared event with no payload — a dropped lifecycle event is the failure mode", async () => {
    await expect(
      runEffects(
        {},
        [{ kind: "outbox", event: "m21.comfort_kit.dispatched" }] as SupplySideEffect[],
        { ...baseCtx, outbox: { async publish() {} }, payloads: {} },
      ),
    ).rejects.toBeInstanceOf(MissingOutboxPayloadError);
  });

  it("THROWS on a set_timestamp naming a column it does not know (the M21-T03 gotcha)", async () => {
    // A pure machine's `set_timestamp` effect type-checks against nothing, so an effect naming a
    // non-existent column compiles clean and passes all fourteen gates while writing nothing.
    await expect(
      runEffects(
        {},
        [
          {
            kind: "set_timestamp",
            field: "signed_at",
            at: "2026-07-31T12:00:00.000Z",
          },
        ] as SupplySideEffect[],
        { ...baseCtx, outbox: { async publish() {} }, payloads: {} },
      ),
    ).rejects.toBeInstanceOf(UnknownTimestampFieldError);
  });

  it("maps every real §2.2 timestamp field onto a patch key", async () => {
    const fields = [
      "ordered_at",
      "shipped_at",
      "delivered_at",
      "received_confirmed_at",
      "completed_at",
      "cancelled_at",
      "cancellation_pending_at",
      "deployed_at_patient_at",
      "retrieving_at",
      "retrieved_at",
      "returned_to_hub_at",
      "reconciled_at",
      "effective_to",
      "last_par_review_at",
    ];
    for (const field of fields) {
      const patch = await runEffects(
        {},
        [{ kind: "set_timestamp", field, at: "2026-07-31T12:00:00.000Z" }] as SupplySideEffect[],
        { ...baseCtx, outbox: { async publish() {} }, payloads: {} },
      );
      expect(Object.keys(patch)).toHaveLength(1);
    }
  });

  it("freeze_routing writes the record AND the queryable vendor column together", async () => {
    const resolved = {
      resolverVersion: "v0.2",
      resolvedAt: "2026-07-31T12:00:00.000Z",
      precedenceLevelUsed: "tenant",
      matchedRuleId: "rule-1",
      assignedVendorId: "vendor-1",
      assignedFulfillmentMode: "vendor",
      defaultPharmacyDispatchMode: null,
      candidatesEvaluated: [],
      routingPolicyDigest: "abc",
    } as never;
    const patch = await runEffects({}, [{ kind: "freeze_routing", resolved }], {
      ...baseCtx,
      outbox: { async publish() {} },
      payloads: {},
    });
    expect(patch.routingRuleResolvedJsonb).toBe(resolved);
    expect(patch.assignedVendorId).toBe("vendor-1");
  });

  it("an alert failure never fails the mutation (M36 owns delivery, retry and DLQ)", async () => {
    const patch = await runEffects(
      {},
      [{ kind: "alert", alert: "m21.par.below_threshold" }] as SupplySideEffect[],
      {
        ...baseCtx,
        outbox: { async publish() {} },
        alerts: {
          async emit() {
            throw new Error("m36 down");
          },
        },
        payloads: {},
        alertPayloads: { "m21.par.below_threshold": {} },
      },
    );
    expect(patch).toEqual({});
  });
});

// ── §8.2 the eraser ─────────────────────────────────────────────────────────────────────────────────

describe("M21-T05 §8.2 — the supply_record eraser", () => {
  function slice() {
    const calls: string[] = [];
    let requests = 2;
    let dispatches = 1;
    let returns = 1;
    const store: SupplyEraseStore = {
      async lockPatient() {
        calls.push("lock");
      },
      async shredAndDeleteRequests() {
        calls.push("shredAndDeleteRequests");
        const n = requests;
        requests = 0;
        return n;
      },
      async deidentifyDispatches() {
        calls.push("deidentifyDispatches");
        const n = dispatches;
        dispatches = 0;
        return { rows: n, preservedLines: n === 0 ? 0 : 4 };
      },
      async deidentifyReturns() {
        calls.push("deidentifyReturns");
        const n = returns;
        returns = 0;
        return { rows: n, preservedLines: n === 0 ? 0 : 4 };
      },
    };
    return { store, calls };
  }

  it("locks first, then shreds-and-deletes, then de-identifies", async () => {
    const { store, calls } = slice();
    await eraseSupplyRecord(store, ORG, "patient-1");
    expect(calls).toEqual([
      "lock",
      "shredAndDeleteRequests",
      "deidentifyDispatches",
      "deidentifyReturns",
    ]);
  });

  it("PRESERVES the controlled-substance ledger rather than deleting it (DEA §1304.04)", async () => {
    const { store } = slice();
    const counts = await eraseSupplyRecord(store, ORG, "patient-1");
    expect(counts.requestsDeleted).toBe(2);
    // The dispatch / return HEADERS survive de-identified, and their lot lines survive untouched — the
    // number a destruction certificate must be able to state truthfully.
    expect(counts.dispatchesDeidentified).toBe(1);
    expect(counts.returnsDeidentified).toBe(1);
    expect(counts.perpetualLogLinesPreserved).toBe(4);
    expect(counts.reconciliationLinesPreserved).toBe(4);
  });

  it("is idempotent — a second erase finds nothing and reports zero", async () => {
    const { store } = slice();
    await eraseSupplyRecord(store, ORG, "patient-1");
    const again = await eraseSupplyRecord(store, ORG, "patient-1");
    expect(again.requestsDeleted).toBe(0);
    expect(again.dispatchesDeidentified).toBe(0);
    expect(again.perpetualLogLinesPreserved).toBe(0);
  });

  it("the de-identification sentinel is the all-zero UUID (a real uuid the column accepts)", () => {
    expect(DEIDENTIFIED_UUID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});
