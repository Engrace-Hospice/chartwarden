// @wardenx/mdm — M40-T11 §7 Workflow Acceptance Criteria (the consolidated done-means suite).
//
// The §9 unit/integration coverage lives in the per-task suites (merge-redirect, baa-gate, nppes-
// nightly, nppes-consumers, merge-service, destruction-cache, the route + seam integration tests);
// the RLS-isolation half (§7.3 overlay isolation, §7.4 canonical lockdown, DB-level) lives in the
// live Postgres suite `packages/db/migrations/__tests__/rls-isolation.live.test.ts` (M40-T03). THIS
// file is the traceability layer the spec frames as §7: one named scenario per §7.1–§7.8 "Done
// means", composing the pure engines + the in-memory backend into the end-to-end chains the unit
// suites prove only piecewise.
//
// Everything here is pure and deterministic — no DB, no clock, no vendor. Where a criterion's "Done
// means" is inherently DB-/live-only (§7.4 RLS WITH CHECK, §7.3 cross-tenant WITH CHECK), the
// scenario asserts the engine/data contract the provider owns and points at the live suite.
import { describe, expect, it } from "vitest";
import {
  // §7.1 / §7.2 / §7.3 / §7.6 — the merge-aware read surface over the shared backend
  createInMemoryMdmBackend,
  createMdmEntityProvider,
  type SeedCanonical,
  // §7.5 — the NPPES drift engine + nightly processor
  detectNppesDrift,
  runNppesNightlyDelta,
  type NppesNightlyPorts,
  // §7.7 — the focused BAA gate
  createBaaStatusProvider,
  createInMemoryBaaStore,
  // §7.8 — D7 tenant-offboarding destruction
  createInMemoryMdmEraseStore,
  eraseTenantMdm,
} from "../src/index";

const SURVIVOR = "11111111-1111-1111-1111-111111111111";
const DUPLICATE = "22222222-2222-2222-2222-222222222222";
const ORG_A = "org_a";
const ORG_B = "org_b";
const MERGE_ID = "merge-1";

function physician(id: string, npi: string | null): SeedCanonical {
  return {
    kind: "physician",
    redirect: { id, status: "active", mergedIntoId: null },
    fields: {
      id,
      identifierType: "npi",
      identifierValue: npi,
      displayName: "Dr. Jane Roe",
      firstName: "Jane",
      lastName: "Roe",
      credentials: "MD",
      isNp: false,
      specialtyTaxonomy: null,
      licenseStates: ["OR"],
    },
  };
}

/** A backend seeded with a survivor + a duplicate physician and a pending merge between them. */
function seededBackend() {
  return createInMemoryMdmBackend({
    canonicals: [physician(SURVIVOR, "1234567893"), physician(DUPLICATE, null)],
    mergeRequests: [
      {
        id: MERGE_ID,
        kind: "physician",
        canonicalId: SURVIVOR,
        duplicateId: DUPLICATE,
        status: "pending",
        evidence: { npiMatch: true },
      },
    ],
  });
}

describe("§7.1 One canonical row per real-world entity", () => {
  it("the same NPI resolves to ONE canonical id for two different tenants", async () => {
    const { store } = seededBackend();
    const provider = createMdmEntityProvider(store);
    const a = await provider.resolvePhysician(ORG_A, SURVIVOR);
    const b = await provider.resolvePhysician(ORG_B, SURVIVOR);
    expect(a?.id).toBe(SURVIVOR);
    expect(b?.id).toBe(a?.id); // identical canonical id across tenants
  });

  it("get-or-create with an identifier already in canonical returns matched_canonical (no duplicate)", async () => {
    const { store } = seededBackend();
    const provider = createMdmEntityProvider(store);
    const out = await provider.getOrCreate(
      ORG_A,
      "physician",
      { identifierType: "npi", identifierValue: "1234567893" },
      "u1",
    );
    expect(out.kind).toBe("matched_canonical");
    if (out.kind === "matched_canonical") expect(out.entity.id).toBe(SURVIVOR);
  });
});

describe("§7.2 The merge redirect is invisible to consumers", () => {
  it("after merge, a FK to the duplicate still resolves to the survivor with resolvedFrom", async () => {
    const { store, service } = seededBackend();
    const provider = createMdmEntityProvider(store);
    await service.approveMerge(MERGE_ID, "ops");
    const resolved = await provider.resolvePhysician(ORG_A, DUPLICATE);
    expect(resolved?.id).toBe(SURVIVOR);
    expect(resolved?.resolvedFrom).toBe(DUPLICATE);
  });
});

describe("§7.3 Two-tenant overlay isolation (engine half; DB WITH CHECK → live suite)", () => {
  it("Org A's overlay is visible to A and INVISIBLE to B (same canonical, distinct overlay)", async () => {
    const { store, service } = seededBackend();
    const provider = createMdmEntityProvider(store);
    await service.upsertPhysicianOverlay(
      ORG_A,
      SURVIVOR,
      {
        preferredContactPhone: null,
        preferredContactEmail: null,
        relationshipNotes: "A's note",
        doNotRefer: false,
        isPreferred: true,
        preferredRank: 1,
      },
      "u1",
    );
    const a = await provider.resolvePhysician(ORG_A, SURVIVOR);
    const b = await provider.resolvePhysician(ORG_B, SURVIVOR);
    expect(a?.overlay?.isPreferred).toBe(true);
    expect(b?.overlay).toBeNull(); // B has no overlay → same canonical, distinct opinions
    // The DB WITH CHECK (Org B cannot WRITE an Org-A overlay row) is proven in the live RLS suite.
  });
});

describe("§7.4 Tenants cannot write canonical (engine half; DB grant → live suite)", () => {
  it("canonical state changes only through the admin merge path, never a tenant read", async () => {
    const { store, service } = seededBackend();
    const provider = createMdmEntityProvider(store);
    // A tenant read never mutates the canonical redirect (the duplicate stays canonical until an
    // ADMIN approves the merge — there is no tenant-facing canonical write on the provider surface).
    await provider.resolvePhysician(ORG_A, DUPLICATE);
    let dup = await provider.resolvePhysician(ORG_A, DUPLICATE);
    expect(dup?.resolvedFrom).toBeUndefined(); // unchanged by reads
    await service.approveMerge(MERGE_ID, "ops"); // platform-ops only (route-gated, T07)
    dup = await provider.resolvePhysician(ORG_A, DUPLICATE);
    expect(dup?.resolvedFrom).toBe(DUPLICATE);
    // The DB lockdown (`wardenx_app` has no canonical write grant; only `mdm_canonical_writer`) is
    // proven on real Postgres in the live RLS suite.
  });
});

describe("§7.5 NPPES drift detection", () => {
  it("a deactivated NPI is flagged and flips the canonical, alerting affected tenants", async () => {
    const known = [
      { npi: "1234567893", canonicalId: SURVIVOR, status: "active" as const, lastName: "Roe", specialtyTaxonomy: null },
    ];
    const drift = detectNppesDrift(
      known,
      new Map([["1234567893", { npi: "1234567893", status: "deactivated" as const, lastName: "Roe", specialtyTaxonomy: null }]]),
    );
    expect(drift[0]?.kind).toBe("deactivated");

    const deactivated: string[] = [];
    const alerts: string[] = [];
    const ports: NppesNightlyPorts = {
      now: () => new Date("2026-06-19T02:00:00Z"),
      m29LastSyncCompletedAt: async () => null,
      loadKnownPhysicians: async () => known,
      fetchNppesDelta: async () => [
        { npi: "1234567893", status: "deactivated", lastName: "Roe", specialtyTaxonomy: null },
      ],
      applyDeactivation: async (id) => void deactivated.push(id),
      applyAttributeUpdate: async () => undefined,
      tenantsToAlert: async () => [ORG_A],
      emitDeactivationAlert: async (orgId) => void alerts.push(orgId),
      recordSyncLog: async () => undefined,
    };
    const result = await runNppesNightlyDelta(ports);
    expect(result.deactivations).toBe(1);
    expect(deactivated).toEqual([SURVIVOR]);
    expect(alerts).toEqual([ORG_A]);
  });
});

describe("§7.6 Merge approval & re-pointing", () => {
  it("the merge row flips to executed and the duplicate redirects throughout (no re-point job)", async () => {
    const { store, service } = seededBackend();
    const provider = createMdmEntityProvider(store);
    await service.approveMerge(MERGE_ID, "ops");
    const [row] = await service.listMergeRequests();
    expect(row?.status).toBe("executed");
    // Service-layer resolves of the duplicate keep returning the survivor while re-pointing is async.
    expect((await provider.resolvePhysician(ORG_A, DUPLICATE))?.id).toBe(SURVIVOR);
  });
});

describe("§7.7 BAA gate on disclosure (W-M40-10 / W-M40-11)", () => {
  const FACILITY = "33333333-3333-3333-3333-333333333333";
  function baaProvider(expiresOn: string) {
    const { store } = createInMemoryBaaStore({
      facilities: [{ facilityId: FACILITY, sendingFacilityCodes: ["STANTHONY_LAB"] }],
      required: [{ orgId: ORG_A, kind: "facility", required: true }],
      records: [
        {
          orgId: ORG_A,
          kind: "facility",
          canonicalId: FACILITY,
          record: { id: "baa-1", baaStatus: "executed", executedOn: "2024-01-01", expiresOn },
        },
      ],
    });
    return createBaaStatusProvider(store);
  }

  it("W-M40-10 inbound by sendingFacility resolves the facility's active BAA", async () => {
    const result = await baaProvider("2027-12-31").baaStatusBySendingFacility({
      orgId: ORG_A,
      sendingFacility: "stanthony_lab",
      asOf: new Date("2026-06-19T10:00:00Z"),
    });
    expect(result.isActive).toBe(true);
    expect(result.status).toBe("executed");
  });

  it("W-M40-11 outbound by entity refuses a transmit after expiry (asOf time-travel)", async () => {
    const result = await baaProvider("2026-06-18").baaStatusByMdmEntity({
      orgId: ORG_A,
      kind: "facility",
      id: FACILITY,
      asOf: new Date("2026-06-19T00:00:01Z"),
    });
    expect(result.isActive).toBe(false);
    expect(result.status).toBe("expired");
  });
});

describe("§7.8 Tenant offboarding (D7 destruction)", () => {
  it("erases the org's overlay/provisional/baa rows; canonical is not in scope", async () => {
    const { store } = createInMemoryMdmEraseStore({
      overlaysByOrg: { [ORG_A]: 3 },
      provisionalsByOrg: { [ORG_A]: 1 },
      baaByOrg: { [ORG_A]: 2 },
    });
    const { erased, counts } = await eraseTenantMdm(ORG_A, store);
    expect(counts).toEqual({ overlays: 3, provisionals: 1, baaRecords: 2 });
    expect(erased).toBe(6);
    // canonical entities (physician/facility/payer) have no erase port here — they survive the tenant.
  });
});
