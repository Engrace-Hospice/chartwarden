import {
  createInMemoryEffectivePermissionStore,
  createInMemorySessionContextStore,
  createSessionContextResolver,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  registerPredicate,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import * as billing from "@chartwarden/billing";
import { BillingRuleRegistry, type ClaimAssemblySeams, pass, reduce } from "@chartwarden/billing";
import {
  CH,
  ClaimMdTransport,
  type ClearinghouseContext,
  InMemoryAttemptStore,
  UNBOUND_BINDING,
} from "@chartwarden/x12-837-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildServer,
  createSessionAuthenticate,
  getSeam,
  registerSeam,
  stepUpFreshFor,
} from "../../../bootstrap";
import type { OrganizationStageReader } from "../../../bootstrap/onboarding-org-gate";
import { registerM23AbacPredicates } from "../abac-predicates";
import { tenantClaimMdAccountReference } from "../claimmd-evidence/store";
import { resolveClaimMdM23PayerRoute } from "../jobs/clearinghouse-context";
import type { AckCursorKey, M23TransportDeps } from "../jobs/clearinghouse-submission";
import {
  type ClaimSubmitJob,
  type M23WorkerDeps,
  runClaimSubmit,
  runTransportAckPull,
} from "../jobs/m23-jobs";
import { registerClaimsRoutes } from "../routes/claims.routes";
import { buildDrizzleM23ReadService } from "../routes/read-service-drizzle";
import { buildDrizzleM23WriteService } from "../routes/write-service-drizzle";
import {
  type Claim837iLoaderDeps,
  loadAndRender837i,
  renderClaim837iPreview,
} from "../services/claim-837i-loader";
import { buildClaimAssemblyService } from "../services/claim-assembly";
import { createTenantClearinghouseRuntime } from "../tenant-clearinghouse/resolver";
import type { FakeStore } from "./_billing-repo-fakes";
import { makeFakeDb } from "./_billing-repo-fakes";
import { createStrictClaimMdFake, createStrictStediFake } from "./_clearinghouse-http-fakes";

vi.mock("@chartwarden/billing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chartwarden/billing")>();
  const { buildFakeRepositories } = await import("./_billing-repo-fakes");
  const { repos, store } = buildFakeRepositories();
  return { ...actual, repositories: { ...actual.repositories, ...repos, __store: store } };
});

const store = (billing.repositories as unknown as { __store: FakeStore }).__store;
const ORG = "10000000-0000-4000-8000-000000000001";
const ORG_B = "20000000-0000-4000-8000-000000000001";
const PROVIDER = "10000000-0000-4000-8000-000000000002";
const PATIENT = "10000000-0000-4000-8000-000000000003";
const PAYER = "10000000-0000-4000-8000-000000000004";
const MEMBERSHIP = "10000000-0000-4000-8000-000000000005";
const NPI = "1234567893";
const TEST_KEY = "synthetic_claimmd_key_never_external";
const NOW = new Date("2026-11-17T15:00:00.000Z");
const liveOrganizationStage: OrganizationStageReader = { isConfined: async () => false };

const actor = {
  organizationId: ORG,
  userId: "synthetic-billing-manager",
  membershipId: MEMBERSHIP,
  roles: ["billing_manager"],
  actorKind: "user" as const,
  stepUpRecent: true,
};

const route = resolveClaimMdM23PayerRoute({
  routes: [
    {
      organizationId: ORG,
      providerEntityId: PROVIDER,
      macJurisdiction: "ngs_j6",
      accountReference: tenantClaimMdAccountReference(ORG),
      usage: "test",
      payerId: "SYNTHETIC-MAC-TEST",
      effectiveFrom: "2026-01-01",
    },
  ],
  organizationId: ORG,
  providerEntityId: PROVIDER,
  macJurisdiction: "ngs_j6",
  accountReference: tenantClaimMdAccountReference(ORG),
  usage: "test",
  at: NOW,
});

const context: ClearinghouseContext = {
  organizationId: ORG,
  providerEntityId: PROVIDER,
  payerId: route.payerId,
  correlationId: "synthetic-rehearsal",
  usage: "test",
  billingNpi: NPI,
  jurisdiction: "ngs_j6",
  claimMdRouteFingerprint: route.routeFingerprint,
};

function registry(): BillingRuleRegistry {
  const rules = new BillingRuleRegistry();
  rules.registerRule({
    key: "synthetic.claimmd.ready",
    version: 1,
    category: "perDiemClass",
    title: "Synthetic rehearsal readiness",
    description: "The deterministic rehearsal fixture is ready.",
    severity: "error",
    regulatoryRequired: false,
    check: () => pass("synthetic.claimmd.ready", "error", "ready"),
  });
  rules.freeze();
  return rules;
}

function assemblySeams(): ClaimAssemblySeams {
  const payer = { patientPayerId: PAYER, medicarePrimary: true } as const;
  return {
    patientPayer: {
      medicarePrimaryForRange: async () => payer,
      medicarePrimaryForRangeInTransaction: async () => payer,
    },
    admission: {
      resolveForRange: async () => ({
        admissionId: "synthetic-admission",
        hospiceAdmissionDate: "2026-01-01",
        dischargeDate: null,
        dischargeReason: null,
        deceasedDate: null,
        placeOfDeath: null,
        transferOut: null,
      }),
    },
    electionPeriods: {
      coveringRange: async () => [
        {
          electionPeriodId: "synthetic-election",
          sequence: 1,
          effectiveFrom: "2026-01-01",
          effectiveTo: null,
          revoked: false,
          revocationDate: null,
        },
      ],
    },
    certifications: { forPatient: async () => [] },
    faceToFace: { forPatient: async () => [] },
    levelOfCare: {
      periodsInRange: async () => [
        {
          levelOfCarePeriodId: "synthetic-loc",
          levelOfCare: "routine_home_care",
          from: "2026-01-01",
          to: "2026-01-07",
          chcDocumentedHours: null,
          gipAdmissionCriteriaDocumented: null,
        },
      ],
    },
    billableEncounters: { forRange: async () => [] },
    diagnoses: {
      forRange: async () => ({
        sequence: [{ position: 1, code: "C34.90", relationship: "terminal" }],
        withheldForConsentCount: 0,
        terminalWithheldForConsent: false,
      }),
    },
    signedEncounters: { inWindow: async () => [] },
    evvCompliance: { bracketsForEncounters: async () => [] },
    mdm: {
      resolveProviderEntity: async () => ({
        ccn: "123456",
        macJurisdiction: "ngs_j6",
        cbsaCode: null,
      }),
      resolveClinicalParticipants: async () => ({
        attending: {
          npi: "1245319599",
          firstName: "Alex",
          lastName: "Testphysician",
          status: "active",
          licenseUnexpiredOnServiceDates: true,
        },
        hospicePhysician: null,
        placeOfService: "home",
      }),
    },
    terminology: {
      resolveForClaim: async () => ({
        valueSetMembership: {},
        icd10Billable: { "C34.90": true },
      }),
    },
    capProjection: {
      projectionForOrg: async () => ({
        status: "unavailable",
        aggregateProjectedCents: null,
        aggregateCapCents: null,
        pctOfCap: null,
        ipuWithinCap: null,
      }),
      projectionForPatient: async () => ({
        status: "unavailable",
        projectedCapCents: null,
        capLimitCents: null,
        withinCap: null,
      }),
    },
    referenceData: {
      perDiemRateTable: async () => ({
        rhcDays1to60PerDiemCents: 20_000,
        rhcDays61PlusPerDiemCents: 16_000,
        chcHourlyRateCents: 6_250,
        ircPerDiemCents: 50_000,
        gipPerDiemCents: 100_000,
        rhcLaborShare: "0.6600",
        chcLaborShare: "0.6600",
        ircLaborShare: "0.5400",
        gipLaborShare: "0.6400",
      }),
      chcHourlyRateCents: async () => 6_250,
      wageIndexForCcn: async () => ({ factorDecimal: "1.0000", cbsaCode: "00000" }),
      activeSequestrationPolicy: async () => ({
        sequestrationPolicyId: "synthetic-sequestration",
        percentage: "2.00",
        effectiveFrom: "2026-01-01",
        effectiveTo: null,
      }),
      visitChargeVersions: async () => [],
    },
    ruleRegistry: registry(),
    outbox: { publish: async (_tx, event) => void store.emitted.push(event) },
    now: () => NOW,
  };
}

function loaderDeps(claimId: string): Claim837iLoaderDeps {
  return {
    persistence: {
      claimById: async (id) => store.claims.get(id) ?? null,
      linesForClaim: async (id) => store.lines.filter((line) => line.claimId === id),
    },
    admission: {
      resolveForRange: async () => ({ hospiceAdmissionDate: "2026-01-01" }) as never,
    },
    mbiUnlock: () => ({
      unlockForEligibility: async () => ({
        patientPayerId: PAYER,
        mbi: "1EG4TE5MK73",
        lastName: "Testpatient",
        firstName: "Jamie",
        dateOfBirth: "1940-03-15",
      }),
    }),
    patients: {
      findById: async () => ({ administrativeSex: "F", dateOfBirth: "1940-03-15" }),
    } as never,
    addresses: {
      primaryAddress: async () => ({
        kind: "home",
        facilityId: null,
        line1: "123 Test St",
        line2: null,
        city: "Testville",
        state: "OR",
        postalCode: "00000",
        country: "US",
        county: null,
      }),
    } as never,
    parties: {
      partiesFor: async () => ({
        submitter: {
          name: "Fictional Test Hospice",
          id: "CWTESTHOSPICE",
          contactName: "Synthetic Billing",
          contactPhone: "5035550100",
        },
        receiver: { name: "Claim.MD Test", id: "CLAIMMD", applicationCode: "CLAIMMD" },
        billingProvider: {
          organizationName: "Fictional Test Hospice",
          npi: NPI,
          taxId: "900123456",
          address: {
            line1: "123 Test St",
            city: "Testville",
            state: "OR",
            postalCode: "00000",
          },
        },
        payer: { name: "Synthetic Medicare Contractor", payerId: route.payerId },
      }),
    },
    accountReference: tenantClaimMdAccountReference(ORG),
    previewIntegrityKey: "synthetic-preview-integrity-key-32-bytes",
  };
}

const fakeClaimMd = () => createStrictClaimMdFake({ accountKey: TEST_KEY, billingNpi: NPI });

async function readySyntheticClaim(): Promise<{ claimId: string; sourceFingerprint: string }> {
  const assembled = await buildClaimAssemblyService(
    makeFakeDb() as never,
    assemblySeams(),
  ).assemble(actor, {
    providerEntityId: PROVIDER,
    patientId: PATIENT,
    serviceFrom: "2026-01-01",
    serviceTo: "2026-01-07",
    tob: "812",
  });
  expect(assembled.initialValidationOutcome).toBe("all_pass");
  const repo = new billing.repositories.ClaimRepository({} as never);
  await repo.refreshAdmissionCodes(assembled.claimId, {
    admissionTypeCode: "1",
    admissionSourceCode: "1",
  });
  await repo.refreshSnapshot(
    assembled.claimId,
    { attendingPhysicianNpi: "1245319599", certifyingPhysicianNpi: null },
    {
      attendingPhysicianFirstName: "Alex",
      attendingPhysicianLastName: "Testphysician",
      certifyingPhysicianFirstName: null,
      certifyingPhysicianLastName: null,
      diagnosisSnapshot: [{ icd10Code: "C34.90", sequence: 1, qualifier: "ABK" }],
    },
  );
  const draft = store.claims.get(assembled.claimId);
  const validating = reduce(draft.state, "begin_validation");
  expect(validating.error).toBeUndefined();
  await repo.transitionToState(draft.id, draft.version, validating.state, {});
  const current = store.claims.get(draft.id);
  const ready = reduce(current.state, "validation_passed", { unresolvedBlockingFailures: 0 });
  expect(ready.error).toBeUndefined();
  await repo.transitionToState(current.id, current.version, ready.state, {});
  const preview = await renderClaim837iPreview(loaderDeps(draft.id), {
    claimId: draft.id,
    context,
    interchangeControlNumber: 1,
    createdAt: NOW,
    claimControlNumber: "WXHOSP0001",
    actorUserId: actor.userId,
    routeFingerprint: route.routeFingerprint,
  });
  if (!preview.ok || !preview.sourceFingerprint) {
    throw new Error(
      `synthetic preview failed: ${
        preview.ok
          ? "missing fingerprint"
          : preview.kind === "gaps"
            ? preview.gaps.map((gap) => `${gap.field}:${gap.reason}`).join(",")
            : preview.kind
      }`,
    );
  }
  return { claimId: draft.id, sourceFingerprint: preview.sourceFingerprint };
}

beforeEach(() => store.reset());
afterEach(() => {
  resetAuthorizationContract();
  resetRbacEngine();
});

describe("M23-CM5-T1 synthetic Claim.MD 837I rehearsal", () => {
  it("T1-01/T1-02 assembles, validates, routes and renders a synthetic institutional claim", async () => {
    const { claimId, sourceFingerprint } = await readySyntheticClaim();
    const rendered = await loadAndRender837i(loaderDeps(claimId), {
      claimId,
      context,
      interchangeControlNumber: 2,
      createdAt: NOW,
      claimControlNumber: "WXHOSP0001",
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    const x12 = rendered.rendered.reveal().x12;
    expect(x12).toContain("*CLAIMMD");
    expect(x12).toContain(`NM1*85*2*FICTIONAL TEST HOSPICE*****XX*${NPI}`);
    expect(x12).toContain("NM1*IL*1*TESTPATIENT*JAMIE");
    expect(sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(context.usage).toBe("test");
    expect(route.routeFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("T1-03 through T1-06 creates one intent and dispatches exactly one real Claim.MD adapter upload", async () => {
    const { claimId, sourceFingerprint } = await readySyntheticClaim();
    const jobs: Record<string, unknown>[] = [];
    const write = buildDrizzleM23WriteService(makeFakeDb() as never, {
      providerCcn: { ccnForProviderEntity: async () => "123456" },
      jobs: {
        enqueue: async (queue, key, payload) => {
          jobs.push({ queue, key, payload });
          return { jobId: "synthetic-claim-submit-job" };
        },
      },
      outbox: { publish: async (_tx, event) => void store.emitted.push(event) },
      now: () => NOW,
    });
    await expect(
      write.submitClaim({ ...actor, stepUpRecent: false }, claimId, {
        expectedVersion: store.claims.get(claimId).version,
        expectedRouteFingerprint: route.routeFingerprint,
        reviewedSourceFingerprint: sourceFingerprint,
      }),
    ).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
    expect(store.submissions.size).toBe(0);

    const accepted = await write.submitClaim(actor, claimId, {
      expectedVersion: store.claims.get(claimId).version,
      expectedRouteFingerprint: route.routeFingerprint,
      reviewedSourceFingerprint: sourceFingerprint,
      routingBinding: {
        vendor: "claimmd",
        accountReference: tenantClaimMdAccountReference(ORG),
        mode: "test",
        configId: null,
        configVersion: null,
        credentialFingerprint: null,
        routeFingerprint: route.routeFingerprint,
      },
    });
    expect(accepted.attemptIndex).toBe(0);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      queue: "claim.submit",
      key: `${ORG}:${claimId}:0`,
      payload: {
        claimId,
        submissionId: accepted.submissionId,
        claimControlNumber: accepted.claimControlNumber,
        externalPatientControlNumber: accepted.externalPatientControlNumber,
        attemptIndex: accepted.attemptIndex,
      },
    });

    const server = fakeClaimMd();
    const attempts = new InMemoryAttemptStore();
    const transport = new ClaimMdTransport({
      keys: { test: TEST_KEY },
      attempts,
      fetch: server.fetch,
      now: () => NOW,
    });
    const evidenceOrder: string[] = [];
    const transportDeps: M23TransportDeps = {
      binding: { vendor: "claimmd", account: "tenant", transport },
      contexts: {
        contextFor: async () => context,
        providerEntitiesFor: async () => [PROVIDER],
      },
      attempts,
      tenantClaimMdEvidence: {
        submission: () => ({
          accountReference: tenantClaimMdAccountReference(ORG),
          usage: "test",
          reserve: async () => {
            evidenceOrder.push("reserve");
            return "synthetic-evidence";
          },
          observe: async () => void evidenceOrder.push("observe"),
        }),
        notice: () => ({}) as never,
      },
    };
    const workerDeps = {
      db: makeFakeDb(),
      transport: transportDeps,
      renderClaim: async () => {
        const rendered = await loadAndRender837i(loaderDeps(claimId), {
          claimId,
          context,
          interchangeControlNumber: 3,
          createdAt: NOW,
          claimControlNumber: accepted.externalPatientControlNumber,
          routeFingerprint: route.routeFingerprint,
        });
        if (!rendered.ok) throw new Error("synthetic claim rendering failed");
        return {
          ...rendered.rendered.reveal(),
          correlationId: "synthetic-worker-render",
          sourceFingerprint: rendered.sourceFingerprint,
          submittedLines: [],
        };
      },
      outbox: {
        publish: async (_tx: unknown, event: unknown) => void store.emitted.push(event),
      },
      now: () => NOW,
    } as never;
    const job = {
      organizationId: ORG,
      claimId,
      submissionId: accepted.submissionId,
      claimControlNumber: accepted.claimControlNumber,
      externalPatientControlNumber: accepted.externalPatientControlNumber,
      attemptIndex: accepted.attemptIndex,
      reviewedSourceFingerprint: sourceFingerprint,
      expectedRouteFingerprint: route.routeFingerprint,
    };
    await runClaimSubmit(makeFakeDb() as never, workerDeps, job);
    expect(server.uploadCalls()).toBe(1);
    expect(evidenceOrder).toEqual(["reserve", "observe"]);
    expect(store.submissions.get(accepted.submissionId)).toMatchObject({ outcome: "submitted" });
    expect(store.claims.get(claimId).state).toBe("submitted");

    await runClaimSubmit(makeFakeDb() as never, workerDeps, job);
    expect(server.uploadCalls()).toBe(1);
    expect(store.submissions.get(accepted.submissionId)).toMatchObject({ outcome: "submitted" });
  });

  it("T1-08/T1-09 refuses wrong tenant, production mode and changed route evidence", async () => {
    expect(() =>
      resolveClaimMdM23PayerRoute({
        routes: [],
        organizationId: "20000000-0000-4000-8000-000000000001",
        providerEntityId: PROVIDER,
        macJurisdiction: "ngs_j6",
        accountReference: tenantClaimMdAccountReference(ORG),
        usage: "test",
        at: NOW,
      }),
    ).toThrow("CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE");
    expect(() =>
      resolveClaimMdM23PayerRoute({
        routes: [],
        organizationId: ORG,
        providerEntityId: PROVIDER,
        macJurisdiction: "ngs_j6",
        accountReference: tenantClaimMdAccountReference(ORG),
        usage: "production",
        at: NOW,
      }),
    ).toThrow("CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE");
  });

  it("T1-07 reconciles an ambiguous upload by filename without sending the claim twice", async () => {
    const { claimId } = await readySyntheticClaim();
    const controlNumber = "SYNTHETIC-AMBIG-1";
    const rendered = await loadAndRender837i(loaderDeps(claimId), {
      claimId,
      context,
      interchangeControlNumber: 4,
      createdAt: NOW,
      claimControlNumber: controlNumber,
    });
    if (!rendered.ok) throw new Error("synthetic ambiguous claim did not render");
    let clock = NOW;
    const server = fakeClaimMd();
    const transport = new ClaimMdTransport({
      keys: { test: TEST_KEY },
      attempts: new InMemoryAttemptStore(),
      fetch: server.fetch,
      now: () => clock,
    });
    const request = {
      kind: "claim" as const,
      controlNumber,
      idempotencyKey: "synthetic-ambiguous-upload",
      payload: { format: "x12" as const, x12: rendered.rendered.reveal().x12 },
    };

    server.setMode("lost_after_upload");
    const uncertain = await transport.submitClaim(context, request);
    expect(uncertain.ok).toBe(false);
    if (!uncertain.ok) expect(uncertain.degraded.code).toBe(CH.IN_DOUBT);
    server.setMode("up");
    clock = new Date(NOW.getTime() + 16 * 60_000);
    const reconciled = await transport.submitClaim(context, request);
    expect(reconciled.ok).toBe(true);
    if (reconciled.ok) expect(reconciled.data.replayed).toBe(true);
    expect(server.uploadCalls()).toBe(1);

    for (const [uploadListMode, expectedUploads, expectedCode] of [
      ["absent", 2, null],
      ["inconclusive", 1, CH.UNAVAILABLE],
      ["failure", 1, CH.UNAVAILABLE],
    ] as const) {
      let scenarioClock = NOW;
      const scenarioServer = fakeClaimMd();
      const scenarioTransport = new ClaimMdTransport({
        keys: { test: TEST_KEY },
        attempts: new InMemoryAttemptStore(),
        fetch: scenarioServer.fetch,
        now: () => scenarioClock,
      });
      const scenarioRequest = {
        ...request,
        idempotencyKey: `synthetic-upload-list-${uploadListMode}`,
      };
      scenarioServer.setMode("lost_after_upload");
      const first = await scenarioTransport.submitClaim(context, scenarioRequest);
      expect(first.ok).toBe(false);
      scenarioServer.setMode("up");
      scenarioServer.setUploadListMode(uploadListMode);
      scenarioClock = new Date(NOW.getTime() + 16 * 60_000);
      const retried = await scenarioTransport.submitClaim(context, scenarioRequest);
      expect(scenarioServer.uploadListCalls()).toBeGreaterThan(0);
      expect(scenarioServer.uploadCalls()).toBe(expectedUploads);
      if (expectedCode) {
        expect(retried.ok).toBe(false);
        if (!retried.ok) expect(retried.degraded.code).toBe(expectedCode);
      } else {
        expect(retried.ok).toBe(true);
      }
    }
  });

  it("T1-10/T1-11 polls, correlates and replays responses without advancing before apply", async () => {
    const { claimId, sourceFingerprint } = await readySyntheticClaim();
    const submission = await new billing.repositories.ClaimSubmissionRepository({} as never).append(
      {
        organizationId: ORG,
        providerEntityId: PROVIDER,
        kind: "claim_837i",
        claimId,
        claimControlNumber: "12345626001TEST",
        attemptIndex: 0,
        outcome: "submitted",
        reviewedSourceFingerprint: sourceFingerprint,
      },
    );
    const claim = store.claims.get(claimId);
    await new billing.repositories.ClaimRepository({} as never).transitionToState(
      claimId,
      claim.version,
      "submitted",
      {},
    );
    const server = fakeClaimMd();
    const transport = new ClaimMdTransport({
      keys: { test: TEST_KEY },
      attempts: new InMemoryAttemptStore(),
      fetch: server.fetch,
      now: () => NOW,
    });
    const cursors = new Map<string, { cursor: string | null; version: number }>();
    const keyOf = (key: AckCursorKey) => JSON.stringify(key);
    const transportDeps: M23TransportDeps = {
      binding: { vendor: "claimmd", account: "tenant", transport },
      contexts: {
        contextFor: async () => context,
        providerEntitiesFor: async (organizationId) => (organizationId === ORG ? [PROVIDER] : []),
      },
      ackCursors: {
        read: async (key) => cursors.get(keyOf(key)) ?? { cursor: null, version: 0 },
        advance: async (key, expectedVersion, next) => {
          const current = cursors.get(keyOf(key)) ?? { cursor: null, version: 0 };
          if (current.version !== expectedVersion) return false;
          cursors.set(keyOf(key), { cursor: next, version: current.version + 1 });
          return true;
        },
      },
    };
    const deps = {
      db: makeFakeDb(),
      transport: {
        ...transportDeps,
        binding: {
          ...UNBOUND_BINDING,
          forOrg: async (organizationId: string) =>
            organizationId === ORG ? transportDeps.binding : UNBOUND_BINDING,
        },
      },
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      outbox: { publish: async (_tx: unknown, event: unknown) => void store.emitted.push(event) },
      now: () => NOW,
    } as never;

    server.respond(submission.claimControlNumber, "A", "CLMMD");
    await runTransportAckPull(deps, "ack_999");
    expect(store.acknowledgments.size).toBe(1);
    expect(store.claims.get(claimId).state).toBe("ack_pending");
    const cursorAfterApply = [...cursors.entries()];
    expect(cursorAfterApply).toHaveLength(1);
    expect(cursorAfterApply[0]?.[1].cursor).toBe("1");

    await runTransportAckPull(deps, "ack_999");
    expect(store.acknowledgments.size).toBe(1);
    expect([...cursors.entries()]).toEqual(cursorAfterApply);

    server.respond(submission.claimControlNumber, "R", "MEDICARE");
    await runTransportAckPull(deps, "ack_277ca");
    expect(store.claims.get(claimId).state).toBe("ack_rejected");
    expect(store.acknowledgments.size).toBe(2);
    expect(cursors.size).toBe(2);
    expect([...store.claims.values()].some((row) => row.state === "paid")).toBe(false);
  });

  it("T1.1 HTTP-01..09 prepares and submits through authenticated registered routes with tenant and step-up guards", async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    const { store: sessionRows, put: putSession } = createInMemorySessionContextStore();
    const snapshots = new Map<
      string,
      { sessionId: string; userId: string; activeOrganizationId: string }
    >();
    const addActor = (input: {
      token: string;
      userId: string;
      orgId: string;
      membershipId: string;
      providerIds: string[];
      stepUp: boolean;
      roles?: string[];
    }) => {
      snapshots.set(input.token, {
        sessionId: input.token,
        userId: input.userId,
        activeOrganizationId: input.orgId,
      });
      putSession({
        sessionId: input.token,
        userId: input.userId,
        membershipId: input.membershipId,
        organizationId: input.orgId,
        roles: input.roles ?? ["billing_manager"],
        providerEntityIds: input.providerIds,
        locationIds: [],
        lastStepUpAt: input.stepUp ? new Date(Date.now() - 1_000) : null,
        lastStepUpFactor: input.stepUp ? "totp" : null,
        sessionClass: "staff",
        portalAccountId: null,
        sessionPatientId: null,
      });
    };
    addActor({
      token: "session-a",
      userId: "http-biller-a",
      orgId: ORG,
      membershipId: MEMBERSHIP,
      providerIds: [PROVIDER],
      stepUp: true,
    });
    addActor({
      token: "session-denied",
      userId: "http-denied",
      orgId: ORG,
      membershipId: "10000000-0000-4000-8000-000000000006",
      providerIds: [PROVIDER],
      stepUp: true,
    });
    addActor({
      token: "session-no-stepup",
      userId: "http-no-stepup",
      orgId: ORG,
      membershipId: "10000000-0000-4000-8000-000000000007",
      providerIds: [PROVIDER],
      stepUp: false,
    });
    addActor({
      token: "session-b",
      userId: "http-biller-b",
      orgId: ORG_B,
      membershipId: "20000000-0000-4000-8000-000000000002",
      providerIds: [PROVIDER],
      stepUp: true,
    });
    addActor({
      token: "session-expired",
      userId: "http-expired",
      orgId: ORG,
      membershipId: "10000000-0000-4000-8000-000000000008",
      providerIds: [PROVIDER],
      stepUp: true,
    });
    addActor({
      token: "session-wrong-provider",
      userId: "http-wrong-provider",
      orgId: ORG,
      membershipId: "10000000-0000-4000-8000-000000000009",
      providerIds: [],
      stepUp: true,
    });

    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG,
          userId: "http-biller-a",
          grants: [
            {
              roleKey: "test-biller",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["billing.claim.read", "billing.claim.submit"],
            },
          ],
        },
        { orgId: ORG, userId: "http-denied", grants: [] },
        {
          orgId: ORG,
          userId: "http-no-stepup",
          grants: [
            {
              roleKey: "test-biller",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["billing.claim.read", "billing.claim.submit"],
            },
          ],
        },
        {
          orgId: ORG,
          userId: "http-wrong-provider",
          grants: [
            {
              roleKey: "test-biller",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["billing.claim.read", "billing.claim.submit"],
            },
          ],
        },
        {
          orgId: ORG_B,
          userId: "http-biller-b",
          grants: [
            {
              roleKey: "test-biller",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["billing.claim.read", "billing.claim.submit"],
            },
          ],
        },
      ]).store,
    );
    const abacReader = {
      async loadClaim(readContext: { organizationId: string }, claimId: string) {
        const row = store.claims.get(claimId);
        return row?.organizationId === readContext.organizationId
          ? {
              entityId: row.id,
              organizationId: row.organizationId,
              providerEntityId: row.providerEntityId,
              patientId: row.patientId,
              state: row.state,
            }
          : null;
      },
      async loadNoe() {
        return null;
      },
      async loadNotr() {
        return null;
      },
      async loadValidationResult() {
        return null;
      },
      async loadRuleConfig() {
        return null;
      },
    };
    registerM23AbacPredicates({
      resolver: abacReader,
      isInCaseload: async (q) => q.organizationId === ORG && q.patientId === PATIENT,
    });
    registerPredicate(
      "caseload_or_scope",
      async (context, target) => context.organizationId === ORG && target.patientId === PATIENT,
    );
    registerPredicate("step_up_recent", (context, target) =>
      stepUpFreshFor(
        {
          organizationId: context.organizationId,
          sessionId:
            typeof context.attributes.sessionId === "string" ? context.attributes.sessionId : null,
          operationKey: typeof target.operationKey === "string" ? target.operationKey : undefined,
        },
        () => Date.now(),
      ),
    );
    registerAbacRegistry();

    registerSeam("SessionContextResolver", createSessionContextResolver(sessionRows));
    const authenticate = createSessionAuthenticate({
      getSnapshot: async (request) => {
        const cookie = request.headers.cookie ?? "";
        const token = /(?:^|;\s*)better-auth\.session_token=([^;]+)/.exec(cookie)?.[1];
        return token ? (snapshots.get(token) ?? null) : null;
      },
      getResolver: () => getSeam("SessionContextResolver"),
      organizationStage: liveOrganizationStage,
      sessionTimeout: {
        enforce: async (sessionId) => (sessionId === "session-expired" ? "expired_idle" : "active"),
      },
    });

    const { claimId } = await readySyntheticClaim();
    const jobs: Record<string, unknown>[] = [];
    const writeService = buildDrizzleM23WriteService(makeFakeDb() as never, {
      providerCcn: { ccnForProviderEntity: async () => "123456" },
      jobs: {
        enqueue: async (queue, key, payload) => {
          jobs.push({ queue, key, payload: { organizationId: key.split(":")[0], ...payload } });
          return { jobId: "http-synthetic-job" };
        },
      },
      outbox: { publish: async (_tx, event) => void store.emitted.push(event) },
      now: () => NOW,
    });
    let currentRouteFingerprint = route.routeFingerprint;
    let currentPreviewVendor: "claimmd" | "stedi" | null = "claimmd";
    const app = buildServer({
      authenticate,
      security: { rateLimitEnabled: false },
      registerModuleRoutes: (server) =>
        registerClaimsRoutes(server, {
          readService: buildDrizzleM23ReadService(makeFakeDb() as never),
          writeService,
          assemblyService: buildClaimAssemblyService(makeFakeDb() as never, assemblySeams()),
          payerRouteStatus: async (orgId, providerEntityId) =>
            orgId === ORG && providerEntityId === PROVIDER
              ? { status: "verified", routeFingerprint: currentRouteFingerprint }
              : { status: "not_configured", reasonCode: "CLAIMMD_PAYER_ROUTE_MISSING_OR_INACTIVE" },
          previewIntegrityKey: "synthetic-http-preview-integrity-key-32-bytes",
          now: () => NOW.getTime(),
          renderPreview: async (input) => {
            const result = await renderClaim837iPreview(loaderDeps(input.claimId), {
              claimId: input.claimId,
              context: {
                ...context,
                organizationId: input.organizationId,
                providerEntityId: input.providerEntityId,
                claimMdRouteFingerprint: input.routeFingerprint ?? currentRouteFingerprint,
              },
              interchangeControlNumber: 91,
              createdAt: NOW,
              claimControlNumber:
                store.claims.get(input.claimId)?.claimControlNumber ?? "WXHOSP0001",
              actorUserId: input.actorUserId,
              routeFingerprint: input.routeFingerprint ?? currentRouteFingerprint,
            });
            if (!result.ok)
              return { status: "blocked", gaps: result.kind === "gaps" ? result.gaps : [] };
            return {
              status: "rendered",
              document: result.document,
              sourceFingerprint: result.sourceFingerprint,
              accountReference: tenantClaimMdAccountReference(input.organizationId),
              usage: "test",
              ...(currentPreviewVendor
                ? {
                    clearinghouseVendor: currentPreviewVendor,
                    clearinghouseConfigId: null,
                    clearinghouseConfigVersion: null,
                    clearinghouseCredentialFingerprint: null,
                  }
                : {}),
            };
          },
        }),
    });
    const cookieFor = (session: string) =>
      `better-auth.session_token=${session}; chartwarden_csrf=synthetic-csrf`;
    const get = (session: string | null, path: string) =>
      app.inject({
        method: "GET",
        url: path,
        ...(session ? { headers: { cookie: cookieFor(session) } } : {}),
      });
    const claimPath = `/api/v1/billing/claims/${claimId}`;

    expect((await get(null, `${claimPath}/preparation`)).statusCode).toBe(401); // HTTP-02
    expect((await get("session-expired", `${claimPath}/preparation`)).statusCode).toBe(401);
    expect((await get("session-denied", `${claimPath}/preparation`)).statusCode).toBe(403); // HTTP-03 read permission
    expect((await get("session-wrong-provider", `${claimPath}/preparation`)).statusCode).toBe(404);
    expect((await get("session-b", `${claimPath}/preparation`)).statusCode).toBe(404); // HTTP-09 tenant isolation
    const prepared = await get("session-a", `${claimPath}/preparation`);
    expect(prepared.statusCode).toBe(200); // HTTP-01
    const preview = prepared.json();
    expect(preview).toMatchObject({
      route: { status: "verified" },
      rendererStatus: "rendered",
      submissionEligible: true,
    });
    expect(preview.previewConfirmationToken).toEqual(expect.any(String));
    expect(JSON.stringify(preview)).not.toMatch(/1EG4TE5MK73|AccountKey|TEST_KEY|\bMBI\b|NM1\\*/);

    const body = {
      ifVersion: preview.previewVersion,
      acknowledgeAllOverrides: false,
      previewConfirmationToken: preview.previewConfirmationToken,
    };
    const submit = (
      session: string,
      idempotencyKey: string,
      token = preview.previewConfirmationToken,
    ) =>
      app.inject({
        method: "POST",
        url: `${claimPath}/submit`,
        headers: {
          cookie: cookieFor(session),
          "x-csrf-token": "synthetic-csrf",
          "idempotency-key": idempotencyKey,
          "if-match": String(preview.previewVersion),
        },
        payload: { ...body, previewConfirmationToken: token },
      });
    expect((await submit("session-denied", "http-denied-submit")).statusCode).toBe(403); // HTTP-03
    expect(store.submissions.size).toBe(0);
    expect((await submit("session-no-stepup", "http-no-stepup-submit")).statusCode).toBe(403); // HTTP-04
    expect(store.submissions.size).toBe(0);
    expect((await submit("session-a", "http-missing-preview-token", "")).statusCode).toBe(422); // HTTP-20

    const lineIndex = store.lines.findIndex((line) => line.claimId === claimId);
    const originalLine = store.lines[lineIndex];
    store.lines[lineIndex] = { ...originalLine, lineChargeCents: originalLine.lineChargeCents + 1 };
    expect((await submit("session-a", "http-source-drift")).statusCode).toBe(409); // HTTP-07
    store.lines[lineIndex] = originalLine;
    currentRouteFingerprint = "a".repeat(64);
    expect((await submit("session-a", "http-route-drift")).statusCode).toBe(409); // HTTP-08
    currentRouteFingerprint = route.routeFingerprint;
    expect(store.submissions.size).toBe(0);

    const accepted = await submit("session-a", "http-accepted-submit");
    expect(accepted.statusCode).toBe(202); // HTTP-05
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ queue: "claim.submit", payload: { claimId } });
    let acceptedBody = accepted.json() as {
      submissionId: string;
      claimControlNumber: string;
      externalPatientControlNumber: string;
      attemptIndex: number;
    };
    expect((await submit("session-a", "http-accepted-submit")).statusCode).toBe(202); // HTTP-14 idempotent replay
    expect(jobs).toHaveLength(1);

    const stale = await app.inject({
      method: "POST",
      url: `${claimPath}/submit`,
      headers: {
        cookie: cookieFor("session-a"),
        "x-csrf-token": "synthetic-csrf",
        "idempotency-key": "http-stale-version",
        "if-match": "999",
      },
      payload: { ...body, ifVersion: 999 },
    });
    expect(stale.statusCode).toBe(409); // HTTP-06
    expect(jobs).toHaveLength(1);

    const vendor = fakeClaimMd();
    const attempts = new InMemoryAttemptStore();
    const transport = new ClaimMdTransport({
      keys: { test: TEST_KEY },
      attempts,
      fetch: vendor.fetch,
      now: () => NOW,
    });
    let workerClaimId = claimId;
    let workerControlNumber = acceptedBody.externalPatientControlNumber;
    const workerDeps = {
      db: makeFakeDb(),
      transport: {
        binding: { vendor: "claimmd", account: "tenant", transport },
        contexts: { contextFor: async () => context, providerEntitiesFor: async () => [PROVIDER] },
        attempts,
        tenantClaimMdEvidence: {
          submission: () => ({
            accountReference: tenantClaimMdAccountReference(ORG),
            usage: "test",
            reserve: async () => "http-synthetic-evidence",
            observe: async () => undefined,
          }),
          notice: () => ({}) as never,
        },
      },
      renderClaim: async () => {
        const rendered = await loadAndRender837i(loaderDeps(workerClaimId), {
          claimId: workerClaimId,
          context,
          interchangeControlNumber: 92,
          createdAt: NOW,
          claimControlNumber: workerControlNumber,
          routeFingerprint: currentRouteFingerprint,
        });
        if (!rendered.ok) throw new Error("authenticated HTTP rehearsal claim did not render");
        return {
          ...rendered.rendered.reveal(),
          correlationId: "http-worker-render",
          sourceFingerprint: rendered.sourceFingerprint,
          submittedLines: [],
        };
      },
      outbox: { publish: async (_tx: unknown, event: unknown) => void store.emitted.push(event) },
      now: () => NOW,
    } as unknown as M23WorkerDeps;
    let queuedJob = jobs[0]?.payload as ClaimSubmitJob;
    vendor.setMode("immediate_reject");
    await runClaimSubmit(makeFakeDb() as never, workerDeps, queuedJob);
    expect(vendor.uploadCalls()).toBe(1); // HTTP-11: the sole external boundary is the strict fake

    const rejectedHistory = await get("session-a", `${claimPath}/submissions`);
    expect(rejectedHistory.statusCode).toBe(200);
    expect(rejectedHistory.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          submissionId: acceptedBody.submissionId,
          outcome: "failed_portal",
          outcomeReason: CH.INVALID_REQUEST,
        }),
      ]),
    );
    expect(JSON.stringify(rejectedHistory.json())).not.toMatch(
      /1EG4TE5MK73|synthetic-preview-integrity|Invalid AccountKey|NM1\*/,
    );
    expect((await get("session-b", `${claimPath}/submissions`)).statusCode).toBe(404);

    // The asynchronous route accepted the intent before the vendor refusal. A fresh user action may
    // create a new attempt after that clean refusal; the original failed evidence remains immutable.
    vendor.setMode("up");
    const retry = await submit("session-a", "http-accepted-after-refusal");
    expect(retry.statusCode).toBe(202);
    expect(jobs).toHaveLength(2);
    acceptedBody = retry.json() as typeof acceptedBody;
    workerControlNumber = acceptedBody.externalPatientControlNumber;
    queuedJob = jobs[1]?.payload as ClaimSubmitJob;
    await runClaimSubmit(makeFakeDb() as never, workerDeps, queuedJob);
    expect(vendor.uploadCalls()).toBe(2);

    const claimRead = await get("session-a", claimPath);
    expect(claimRead.statusCode).toBe(200);
    expect(claimRead.json()).toMatchObject({ claimId, state: "submitted" });
    const submissionRead = await get("session-a", `${claimPath}/submissions`);
    expect(submissionRead.statusCode).toBe(200); // HTTP-17
    expect(submissionRead.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ submissionId: acceptedBody.submissionId, outcome: "submitted" }),
      ]),
    );
    expect((await get("session-b", `${claimPath}/submissions`)).statusCode).toBe(404); // HTTP-19

    vendor.respond(acceptedBody.externalPatientControlNumber, "A", "CLMMD");
    const cursorBook = new Map<string, { cursor: string | null; version: number }>();
    const cursorKey = (key: AckCursorKey) => JSON.stringify(key);
    const legacyDeps = {
      db: makeFakeDb(),
      transport: {
        ...({
          binding: { vendor: "claimmd", account: "tenant", transport },
          contexts: {
            contextFor: async () => context,
            providerEntitiesFor: async (organizationId: string) =>
              organizationId === ORG ? [PROVIDER] : [],
          },
          attempts,
        } as M23TransportDeps),
        binding: {
          ...UNBOUND_BINDING,
          forOrg: async (organizationId: string) =>
            organizationId === ORG
              ? { vendor: "claimmd", account: "tenant", transport }
              : UNBOUND_BINDING,
        },
        ackCursors: {
          read: async (key: AckCursorKey) =>
            cursorBook.get(cursorKey(key)) ?? { cursor: null, version: 0 },
          advance: async (key: AckCursorKey, expectedVersion: number, cursor: string) => {
            const current = cursorBook.get(cursorKey(key)) ?? { cursor: null, version: 0 };
            if (current.version !== expectedVersion) return false;
            cursorBook.set(cursorKey(key), { cursor, version: current.version + 1 });
            return true;
          },
        },
      },
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      outbox: { publish: async (_tx: unknown, event: unknown) => void store.emitted.push(event) },
      now: () => NOW,
    } as never;
    await runTransportAckPull(legacyDeps, "ack_999");
    expect(vendor.interceptedCalls()).toBe(3); // Two uploads and one response API request; no real network transport.
    expect(cursorBook.size).toBe(1); // Legacy cursor advances only via existing response processing.
    expect(store.acknowledgments.size).toBe(1);
    expect(store.claims.get(claimId).state).toBe("ack_pending");
    expect(store.claims.get(claimId).state).not.toBe("paid");
    await runTransportAckPull(legacyDeps, "ack_999"); // HTTP-16: response replay is idempotent.
    expect(vendor.interceptedCalls()).toBe(4); // Fourth fixture request is the replay poll; actual network remains blocked.
    expect(store.acknowledgments.size).toBe(1);
    expect(cursorBook.size).toBe(1);
    const ackRead = await get("session-a", `${claimPath}/acknowledgments`);
    expect(ackRead.statusCode).toBe(200); // HTTP-18
    expect(ackRead.json()).toHaveLength(1);
    expect((await get("session-a", claimPath)).json()).toMatchObject({ state: "ack_pending" });
    expect((await get("session-b", `${claimPath}/acknowledgments`)).statusCode).toBe(404);
    expect((await get("session-b", claimPath)).statusCode).toBe(404);

    vendor.respond(acceptedBody.externalPatientControlNumber, "R", "MEDICARE");
    await runTransportAckPull(legacyDeps, "ack_277ca");
    expect(vendor.interceptedCalls()).toBe(5);
    expect(store.acknowledgments.size).toBe(2);
    expect(store.claims.get(claimId).state).toBe("ack_rejected");
    const rejectedAckRead = await get("session-a", `${claimPath}/acknowledgments`);
    expect(rejectedAckRead.statusCode).toBe(200);
    expect(rejectedAckRead.json()).toHaveLength(2);
    expect(JSON.stringify(rejectedAckRead.json())).not.toMatch(/1EG4TE5MK73|NM1\*|AccountKey/);
    expect((await get("session-a", claimPath)).json()).toMatchObject({ state: "ack_rejected" });
    expect([...store.claims.values()].some((row) => row.state === "paid")).toBe(false);

    const ambiguousClaim = await readySyntheticClaim();
    const ambiguousPath = `/api/v1/billing/claims/${ambiguousClaim.claimId}`;
    const ambiguousPreparation = await get("session-a", `${ambiguousPath}/preparation`);
    expect(ambiguousPreparation.statusCode).toBe(200);
    const ambiguousPreview = ambiguousPreparation.json();
    const ambiguousAccepted = await app.inject({
      method: "POST",
      url: `${ambiguousPath}/submit`,
      headers: {
        cookie: cookieFor("session-a"),
        "x-csrf-token": "synthetic-csrf",
        "idempotency-key": "http-ambiguous-submit",
        "if-match": String(ambiguousPreview.previewVersion),
      },
      payload: {
        ifVersion: ambiguousPreview.previewVersion,
        acknowledgeAllOverrides: false,
        previewConfirmationToken: ambiguousPreview.previewConfirmationToken,
      },
    });
    expect(ambiguousAccepted.statusCode).toBe(202);
    expect(jobs).toHaveLength(3);
    const ambiguousBody = ambiguousAccepted.json() as typeof acceptedBody;
    workerClaimId = ambiguousClaim.claimId;
    workerControlNumber = ambiguousBody.externalPatientControlNumber;
    queuedJob = jobs[2]?.payload as ClaimSubmitJob;
    vendor.setMode("lost_after_upload");
    const callsBeforeAmbiguous = vendor.uploadCalls();
    await runClaimSubmit(makeFakeDb() as never, workerDeps, queuedJob);
    expect(vendor.uploadCalls()).toBe(callsBeforeAmbiguous + 1);
    expect(store.submissions.get(ambiguousBody.submissionId)).toMatchObject({
      dispatchState: "in_doubt",
      outcome: "queued",
      outcomeReason: null,
    });
    const ambiguousHistory = await get("session-a", `${ambiguousPath}/submissions`);
    expect(ambiguousHistory.statusCode).toBe(200);
    expect(ambiguousHistory.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          submissionId: ambiguousBody.submissionId,
          dispatchState: "in_doubt",
          outcome: "queued",
          outcomeReason: null,
        }),
      ]),
    );
    await runClaimSubmit(makeFakeDb() as never, workerDeps, queuedJob);
    expect(vendor.uploadCalls()).toBe(callsBeforeAmbiguous + 1);
    expect((await get("session-b", `${ambiguousPath}/submissions`)).statusCode).toBe(404);
    store.claims.set(ambiguousClaim.claimId, {
      ...store.claims.get(ambiguousClaim.claimId),
      state: "ack_rejected",
    });

    const submitFreshClaim = async (idempotencyKey: string) => {
      const fresh = await readySyntheticClaim();
      const path = `/api/v1/billing/claims/${fresh.claimId}`;
      const preparation = await get("session-a", `${path}/preparation`);
      expect(preparation.statusCode).toBe(200);
      const freshPreview = preparation.json();
      const acceptedFresh = await app.inject({
        method: "POST",
        url: `${path}/submit`,
        headers: {
          cookie: cookieFor("session-a"),
          "x-csrf-token": "synthetic-csrf",
          "idempotency-key": idempotencyKey,
          "if-match": String(freshPreview.previewVersion),
        },
        payload: {
          ifVersion: freshPreview.previewVersion,
          acknowledgeAllOverrides: false,
          previewConfirmationToken: freshPreview.previewConfirmationToken,
        },
      });
      expect(acceptedFresh.statusCode).toBe(202);
      return {
        claimId: fresh.claimId,
        path,
        accepted: acceptedFresh.json() as typeof acceptedBody,
        job: jobs.at(-1)?.payload as ClaimSubmitJob,
      };
    };

    for (const [mode, expected] of [
      ["credential_reject", { state: "finished", outcome: "failed_portal", reason: CH.NOT_WIRED }],
      ["http_401", { state: "finished", outcome: "failed_portal", reason: CH.NOT_WIRED }],
      ["http_429", { state: "finished", outcome: "failed_portal", reason: CH.UNAVAILABLE }],
      ["malformed_success", { state: "in_doubt", outcome: "queued", reason: null }],
      ["network_before_response", { state: "in_doubt", outcome: "queued", reason: null }],
    ] as const) {
      const scenario = await submitFreshClaim(`http-${mode}`);
      workerClaimId = scenario.claimId;
      workerControlNumber = scenario.accepted.externalPatientControlNumber;
      vendor.setMode(mode);
      const scenarioAttempts = new InMemoryAttemptStore();
      const scenarioTransport = new ClaimMdTransport({
        keys: { test: TEST_KEY },
        attempts: scenarioAttempts,
        fetch: vendor.fetch,
        now: () => NOW,
      });
      const scenarioWorkerDeps = {
        ...workerDeps,
        transport: {
          ...(workerDeps as { transport: M23TransportDeps }).transport,
          binding: { vendor: "claimmd", account: "tenant", transport: scenarioTransport },
          attempts: scenarioAttempts,
        },
      } as M23WorkerDeps;
      const uploadsBefore = vendor.uploadCalls();
      await runClaimSubmit(makeFakeDb() as never, scenarioWorkerDeps, scenario.job);
      expect(vendor.uploadCalls(), `Claim.MD upload count for ${mode}`).toBe(uploadsBefore + 1);
      const history = await get("session-a", `${scenario.path}/submissions`);
      expect(history.statusCode).toBe(200);
      expect(history.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            submissionId: scenario.accepted.submissionId,
            dispatchState: expected.state,
            outcome: expected.outcome,
            outcomeReason: expected.reason,
          }),
        ]),
      );
      expect(JSON.stringify(history.json())).not.toMatch(
        /1EG4TE5MK73|synthetic_claimmd_key|AccountKey|NM1\*/,
      );
      await runClaimSubmit(makeFakeDb() as never, scenarioWorkerDeps, scenario.job);
      expect(vendor.uploadCalls()).toBe(uploadsBefore + 1);
      store.claims.set(scenario.claimId, {
        ...store.claims.get(scenario.claimId),
        state: "ack_rejected",
      });
    }

    const stediKey = "synthetic_stedi_key_never_external";
    currentPreviewVendor = "stedi";
    const stedi = createStrictStediFake({ apiKey: stediKey });
    vi.stubGlobal("fetch", stedi.fetch);
    const stediAttempts = new InMemoryAttemptStore();
    let stediConfig: Record<string, unknown> | null = {
      organizationId: ORG,
      vendor: "stedi",
      mode: "test",
      status: "active",
      version: 1,
      secretCipher: "synthetic-sealed-stedi-key",
      baaRevokedAt: null,
    };
    const stediRuntime = createTenantClearinghouseRuntime({
      db: makeFakeDb() as never,
      cipher: {
        decrypt: async (organizationId: string, binding: { vendor: string; mode: string }) => {
          if (organizationId !== ORG || binding.vendor !== "stedi" || binding.mode !== "test") {
            throw new Error("synthetic credential binding mismatch");
          }
          return stediKey;
        },
      } as never,
      attempts: stediAttempts,
      platformBinding: UNBOUND_BINDING,
      fallbackOrgIds: new Set(),
      isOrganizationLive: async (organizationId) => organizationId === ORG,
      readRow: async (organizationId) => (organizationId === ORG ? (stediConfig as never) : null),
    });
    const stediScenario = await submitFreshClaim("http-stedi-submit");
    workerClaimId = stediScenario.claimId;
    workerControlNumber = stediScenario.accepted.externalPatientControlNumber;
    const stediWorkerDeps = {
      ...workerDeps,
      transport: {
        binding: stediRuntime.binding,
        contexts: {
          contextFor: async () => context,
          providerEntitiesFor: async () => [PROVIDER],
        },
        attempts: stediAttempts,
      },
    } as M23WorkerDeps;
    const claimMdUploadsBeforeStedi = vendor.uploadCalls();
    await runClaimSubmit(makeFakeDb() as never, stediWorkerDeps, stediScenario.job);
    expect(stedi.requestCalls()).toBe(1);
    expect(vendor.uploadCalls()).toBe(claimMdUploadsBeforeStedi);
    const stediRequest = stedi.requests[0]?.body as {
      usageIndicator?: string;
      claimInformation?: { patientControlNumber?: string };
    };
    expect(stediRequest.usageIndicator).toBe("T");
    expect(stediRequest.claimInformation?.patientControlNumber).toBe(
      stediScenario.accepted.externalPatientControlNumber,
    );
    expect(stediScenario.accepted.externalPatientControlNumber).toMatch(/^[A-Z0-9]{17}$/);
    const stediHistory = await get("session-a", `${stediScenario.path}/submissions`);
    expect(stediHistory.statusCode).toBe(200);
    expect(stediHistory.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          submissionId: stediScenario.accepted.submissionId,
          outcome: "submitted",
          outcomeReason: null,
          externalPatientControlNumber: stediScenario.accepted.externalPatientControlNumber,
        }),
      ]),
    );
    expect(store.claims.get(stediScenario.claimId).state).toBe("submitted");
    expect(store.claims.get(stediScenario.claimId).state).not.toBe("paid");
    store.claims.set(stediScenario.claimId, {
      ...store.claims.get(stediScenario.claimId),
      state: "ack_rejected",
    });

    const missingTransportScenario = await submitFreshClaim("http-stedi-worker-missing-transport");
    workerClaimId = missingTransportScenario.claimId;
    workerControlNumber = missingTransportScenario.accepted.externalPatientControlNumber;
    const requestsBeforeMissingTransport = stedi.requestCalls();
    await runClaimSubmit(
      makeFakeDb() as never,
      { ...stediWorkerDeps, transport: undefined } as never,
      missingTransportScenario.job,
    );
    expect(stedi.requestCalls()).toBe(requestsBeforeMissingTransport);
    const missingTransportHistory = await get(
      "session-a",
      `${missingTransportScenario.path}/submissions`,
    );
    expect(missingTransportHistory.json()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          submissionId: missingTransportScenario.accepted.submissionId,
          outcome: "held_stale_source",
          outcomeReason: "CLEARINGHOUSE_BINDING_CHANGED",
        }),
      ]),
    );
    store.claims.set(missingTransportScenario.claimId, {
      ...store.claims.get(missingTransportScenario.claimId),
      state: "ack_rejected",
    });

    for (const [label, row] of [
      ["missing", null],
      [
        "outside",
        {
          organizationId: ORG,
          vendor: "outside",
          mode: null,
          status: "active",
          version: 2,
          secretCipher: null,
          baaRevokedAt: null,
        },
      ],
      [
        "inactive",
        {
          organizationId: ORG,
          vendor: "stedi",
          mode: "test",
          status: "verified",
          version: 3,
          secretCipher: "synthetic-sealed-stedi-key",
          baaRevokedAt: null,
        },
      ],
    ] as const) {
      currentPreviewVendor = null;
      stediConfig = row;
      const unbound = await submitFreshClaim(`http-stedi-${label}`);
      workerClaimId = unbound.claimId;
      workerControlNumber = unbound.accepted.externalPatientControlNumber;
      const requestsBefore = stedi.requestCalls();
      await runClaimSubmit(makeFakeDb() as never, stediWorkerDeps, unbound.job);
      expect(stedi.requestCalls()).toBe(requestsBefore);
      const history = await get("session-a", `${unbound.path}/submissions`);
      expect(history.json()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            outcome: "held_stale_source",
            outcomeReason: "CLEARINGHOUSE_ROUTE_CHANGED",
          }),
        ]),
      );
      store.claims.set(unbound.claimId, {
        ...store.claims.get(unbound.claimId),
        state: "ack_rejected",
      });
    }
    vi.unstubAllGlobals();

    await app.close();
    resetAuthorizationContract();
    resetRbacEngine();
  });
});
