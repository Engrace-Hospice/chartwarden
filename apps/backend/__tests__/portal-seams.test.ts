import type {
  PortalAccessGrantDigest,
  PortalAccountDigest,
  PortalScopeSet,
  TelehealthVisitDigest,
} from "@wardenx/types";
// apps/backend/__tests__/portal-seams.test.ts — M31-T06 the seven §4.3 published reader seams + §3.7 eraser.
//
// Covers each seam impl over the in-memory slice (PHI-minimal digests in, projections out), the §4.4 consumed
// contract + published-name tuple, and the §3.7/D15 destruction eraser order-of-operations. No IO.
import { describe, expect, it } from "vitest";
import { createInMemoryPortalEraseStore, erasePortalRecord } from "../src/modules/31-portal/eraser";
import { PortalStateError } from "../src/modules/31-portal/lifecycle/index";
import {
  M31_PUBLISHED_SEAM_NAMES,
  M31_REQUIRED_SEAMS,
  createInMemoryM31SeamStores,
  createM31PublishedSeamImpls,
  createPortalAccessGrantReader,
  createPortalAccountReader,
  createPortalSessionMinter,
  createTelehealthMetricsProvider,
  registerM31PublishedSeams,
} from "../src/modules/31-portal/seams/index";

const scope = (cats: Partial<Record<string, boolean>>): PortalScopeSet => ({
  categories: cats as PortalScopeSet["categories"],
  floorVersion: "floor-v1",
});

function account(over: Partial<PortalAccountDigest> = {}): PortalAccountDigest {
  return {
    portalAccountId: "acct-1",
    userId: "user-1",
    relationship: "family_caregiver",
    status: "active",
    activatedAt: "2026-07-01T00:00:00.000Z",
    lastActiveAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

function grant(over: Partial<PortalAccessGrantDigest> = {}): PortalAccessGrantDigest {
  return {
    grantId: "grant-1",
    portalAccountId: "acct-1",
    patientId: "pat-1",
    grantKind: "family_caregiver",
    scopeSet: scope({ care_plan: true, medications: true }),
    grantedAt: "2026-07-01T00:00:00.000Z",
    revokedAt: null,
    ...over,
  };
}

function visit(over: Partial<TelehealthVisitDigest> = {}): TelehealthVisitDigest {
  return {
    telehealthVisitId: "tv-1",
    m17VisitId: "v-1",
    patientId: "pat-1",
    assignedMembershipId: "mem-1",
    lifecycleState: "ended_clean",
    vendor: "daily_co",
    scheduledVisitSetting: "patient_home_with_video",
    audioOnlyFallbackActive: false,
    visitStartedAt: "2026-08-01T10:00:00.000Z",
    visitEndedAt: "2026-08-01T10:20:00.000Z",
    totalDurationSec: 1200,
    endReason: "clean",
    linkedEncounterId: null,
    ...over,
  };
}

describe("§4.3 seam 1 — PortalAccountReader", () => {
  const { stores } = createInMemoryM31SeamStores({
    accounts: [
      {
        orgId: "org-1",
        digest: account({ portalAccountId: "a1", status: "active" }),
        patientIds: ["pat-1"],
      },
      {
        orgId: "org-1",
        digest: account({ portalAccountId: "a2", userId: "user-2", status: "invited" }),
        patientIds: ["pat-1"],
      },
      {
        orgId: "org-1",
        digest: account({ portalAccountId: "a3", userId: "user-3", status: "revoked" }),
        patientIds: ["pat-2"],
      },
      {
        orgId: "org-2",
        digest: account({ portalAccountId: "b1", userId: "user-9", status: "active" }),
        patientIds: ["pat-9"],
      },
    ],
  });
  const reader = createPortalAccountReader(stores.accounts);

  it("counts by status within the org only", async () => {
    expect(await reader.tenantPortalAccountCount("org-1")).toEqual({
      active: 1,
      invited: 1,
      revoked: 1,
      bereaved: 0,
    });
  });

  it("resolves accounts for a patient", async () => {
    const rows = await reader.accountsForPatient("org-1", "pat-1");
    expect(rows.map((r) => r.portalAccountId).sort()).toEqual(["a1", "a2"]);
  });

  it("resolves an account by user id and returns null cross-tenant", async () => {
    expect((await reader.accountByUserId("org-1", "user-1"))?.portalAccountId).toBe("a1");
    expect(await reader.accountByUserId("org-1", "user-9")).toBeNull();
  });
});

describe("§4.3 seam 2 — PortalAccessGrantReader", () => {
  const { stores } = createInMemoryM31SeamStores({
    grants: [
      {
        orgId: "org-1",
        digest: grant({ grantId: "g1", portalAccountId: "a1", patientId: "pat-1" }),
      },
      {
        orgId: "org-1",
        digest: grant({ grantId: "g2", portalAccountId: "a1", patientId: "pat-2" }),
      },
      {
        orgId: "org-1",
        digest: grant({ grantId: "g3", portalAccountId: "a2", patientId: "pat-1" }),
      },
      {
        orgId: "org-1",
        digest: grant({
          grantId: "g4",
          portalAccountId: "a2",
          patientId: "pat-3",
          revokedAt: "2026-07-15T00:00:00.000Z",
        }),
      },
    ],
  });
  const reader = createPortalAccessGrantReader(stores.grants);

  it("returns only active grants for an account", async () => {
    const rows = await reader.activeGrantsForAccount("org-1", "a2");
    expect(rows.map((r) => r.grantId)).toEqual(["g3"]); // g4 revoked, excluded
  });

  it("resolves the active grant for (account, patient)", async () => {
    expect((await reader.activeGrantForAccountAndPatient("org-1", "a1", "pat-2"))?.grantId).toBe(
      "g2",
    );
    expect(await reader.activeGrantForAccountAndPatient("org-1", "a2", "pat-3")).toBeNull(); // revoked
  });

  it("aggregates patients with active grants (§4004 access-rate input)", async () => {
    const rows = await reader.patientsWithActiveGrantsInOrg("org-1", "2026-08-02T00:00:00.000Z");
    const byPatient = Object.fromEntries(rows.map((r) => [r.patientId, r.grantCount]));
    expect(byPatient).toEqual({ "pat-1": 2, "pat-2": 1 }); // pat-3's only grant is revoked
  });
});

describe("§4.3 seams 4/5 — Telehealth metrics + visit reader", () => {
  const { stores } = createInMemoryM31SeamStores({
    visits: [
      {
        orgId: "org-1",
        digest: visit({
          telehealthVisitId: "tv-1",
          m17VisitId: "v-1",
          lifecycleState: "ended_clean",
          totalDurationSec: 1200,
        }),
      },
      {
        orgId: "org-1",
        digest: visit({
          telehealthVisitId: "tv-2",
          m17VisitId: "v-2",
          lifecycleState: "ended_aborted",
          audioOnlyFallbackActive: true,
          totalDurationSec: 300,
        }),
      },
    ],
  });
  const impls = createM31PublishedSeamImpls(stores);

  it("computes org metrics (clean/aborted/audio-only rate)", async () => {
    const m = await impls.telehealthMetricsProvider.metricsForOrg(
      "org-1",
      "2026-08-01T00:00:00.000Z",
      "2026-08-02T00:00:00.000Z",
    );
    expect(m.visitsTotal).toBe(2);
    expect(m.visitsCompletedClean).toBe(1);
    expect(m.visitsCompletedAborted).toBe(1);
    expect(m.audioOnlyFallbackRate).toBe(0.5);
  });

  it("sums minutes by tenant", async () => {
    const mins = createTelehealthMetricsProvider(stores.telehealth);
    expect(
      (await mins.minutesByTenant("org-1", "2026-08-01T00:00:00.000Z", "2026-08-02T00:00:00.000Z"))
        .totalMinutes,
    ).toBe(25); // (1200+300)/60
  });

  it("reads a visit by id and by M17 visit id, null cross-tenant", async () => {
    expect((await impls.telehealthVisitReader.getById("org-1", "tv-1"))?.m17VisitId).toBe("v-1");
    expect(
      (await impls.telehealthVisitReader.getByM17VisitId("org-1", "v-2"))?.telehealthVisitId,
    ).toBe("tv-2");
    expect(await impls.telehealthVisitReader.getById("org-2", "tv-1")).toBeNull();
  });
});

describe("§4.3 seam 6 — PortalSessionMinter (M28 SMART user-launch)", () => {
  it("mints a session bound to the resolved active grant", async () => {
    const { stores, createdSessions } = createInMemoryM31SeamStores({
      grants: [
        {
          orgId: "org-1",
          digest: grant({ grantId: "g1", portalAccountId: "a1", patientId: "pat-1" }),
        },
      ],
    });
    const minter = createPortalSessionMinter({ grants: stores.grants, sessions: stores.sessions });
    const out = await minter.mintSessionForSmartLaunch({
      orgId: "org-1",
      portalAccountId: "a1",
      patientId: "pat-1",
      requestedScopes: ["patient/Observation.read", "patient/MedicationRequest.read"],
      smartLaunchContext: { iss: "https://ehr.example", launchTokenHash: "hash-1" },
    });
    expect(out.activeGrantId).toBe("g1");
    expect(out.resolvedScopes).toHaveLength(2);
    expect(createdSessions).toHaveLength(1);
    expect(createdSessions[0]).toMatchObject({
      portalAccountId: "a1",
      patientId: "pat-1",
      activeGrantId: "g1",
    });
  });

  it("fails closed when the account has no active grant for the patient", async () => {
    const { stores } = createInMemoryM31SeamStores({ grants: [] });
    const minter = createPortalSessionMinter({ grants: stores.grants, sessions: stores.sessions });
    await expect(
      minter.mintSessionForSmartLaunch({
        orgId: "org-1",
        portalAccountId: "a1",
        patientId: "pat-1",
        requestedScopes: [],
        smartLaunchContext: { iss: "x", launchTokenHash: "h" },
      }),
    ).rejects.toBeInstanceOf(PortalStateError);
  });
});

describe("§4.3 seam 7 — PortalDisclosureAccountingProvider (§164.528)", () => {
  it("returns only in-window disclosures for the patient", async () => {
    const { stores } = createInMemoryM31SeamStores({
      disclosures: [
        {
          orgId: "org-1",
          record: {
            portalAccountId: "a1",
            patientId: "pat-1",
            routePath: "/p/pat-1/medications",
            dataCategoriesDisclosed: ["medications"],
            viewedAt: "2026-07-10T00:00:00.000Z",
          },
        },
        {
          orgId: "org-1",
          record: {
            portalAccountId: "a1",
            patientId: "pat-1",
            routePath: "/p/pat-1/visits",
            dataCategoriesDisclosed: ["visits"],
            viewedAt: "2026-06-01T00:00:00.000Z",
          },
        },
      ],
    });
    const impls = createM31PublishedSeamImpls(stores);
    const rows = await impls.portalDisclosureAccountingProvider.disclosuresForPatient(
      "org-1",
      "pat-1",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.routePath).toBe("/p/pat-1/medications");
  });
});

describe("§4.3/§4.4 registration contract", () => {
  it("publishes exactly the seven §4.3 seams under their SeamContracts keys", () => {
    const { stores } = createInMemoryM31SeamStores();
    const registered: string[] = [];
    registerM31PublishedSeams(
      { registerSeam: (name) => registered.push(name) },
      createM31PublishedSeamImpls(stores),
    );
    expect(registered.sort()).toEqual([...M31_PUBLISHED_SEAM_NAMES].sort());
    expect(M31_PUBLISHED_SEAM_NAMES).toHaveLength(7);
  });

  it("declares the §4.4 consumed seams (all producers live)", () => {
    expect(M31_REQUIRED_SEAMS).toContain("ConsentEvaluator");
    expect(M31_REQUIRED_SEAMS).toContain("MedicationAdministrationProvider");
    expect(M31_REQUIRED_SEAMS).toContain("PortalDocumentReader");
    expect(new Set(M31_REQUIRED_SEAMS).size).toBe(M31_REQUIRED_SEAMS.length); // no dup
  });
});

describe("§3.7/D15 portal destruction eraser", () => {
  it("runs the five steps in order and reports per-table counts", async () => {
    const { store, emitted } = createInMemoryPortalEraseStore({
      telehealthVisitsAborted: 1,
      recordingsShredded: 2,
      grantsRevoked: 3,
      accountsRevoked: 1,
    });
    const out = await erasePortalRecord("org-1", "pat-1", "cert-1", store);
    expect(out.erased).toBe(7);
    expect(out.counts).toEqual({
      telehealthVisitsAborted: 1,
      recordingsShredded: 2,
      grantsRevoked: 3,
      accountsRevoked: 1,
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ patientId: "pat-1", certificateId: "cert-1" });
  });

  it("is a clean no-op when the patient has no portal footprint", async () => {
    const { store, emitted } = createInMemoryPortalEraseStore();
    const out = await erasePortalRecord("org-1", "pat-none", "cert-2", store);
    expect(out.erased).toBe(0);
    expect(emitted).toHaveLength(1); // certificate still records the (zero) manifest
  });
});
