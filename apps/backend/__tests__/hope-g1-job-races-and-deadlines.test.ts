import type { DbClient } from "@chartwarden/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Two defect classes in the M10 jobs, with the stores and the database faked (no live infrastructure):
//  - an unbounded wait: a port read that never answers must fail ITS org (or batch) after a deadline instead of stalling the
//    sequential job for every org behind it;
//  - decide-before-lock: a decision made on an unlocked read must not be written, or announced, when the row moved meanwhile.
const retentionStore = vi.hoisted(() => ({
  hopeRetentionFactsForOrg: vi.fn(),
  insertRetentionReview: vi.fn(),
  retentionReviewsForOrg: vi.fn(),
  updateRetentionReview: vi.fn(),
}));
vi.mock("../src/modules/10-hope/jobs/retention-store", () => retentionStore);
const assembleStore = vi.hoisted(() => ({
  assemblableAssessmentsForOrg: vi.fn(),
  persistAssembledSubmission: vi.fn(),
}));
vi.mock("../src/modules/10-hope/jobs/assemble-store", () => assembleStore);
const submissionStore = vi.hoisted(() => ({
  applyItemTransition: vi.fn(),
  claimSubmissionForTransmit: vi.fn(),
  inFlightSubmissionsForOrg: vi.fn(),
  lockInFlightSubmission: vi.fn(),
  pendingItemsForSubmission: vi.fn(),
  queuedSubmissionsForOrg: vi.fn(),
  recordReconcileOutcome: vi.fn(),
  recordTransmit: vi.fn(),
  releaseSubmission: vi.fn(),
  writeValidationFindings: vi.fn(),
}));
vi.mock("../src/modules/10-hope/jobs/submission-store", () => submissionStore);

import {
  type M10WorkerDeps,
  runHopeRetentionCron,
  runIqiesReconcileCron,
  runIqiesSubmitCron,
} from "../src/modules/10-hope/jobs/cron-workers";
import { M10_SEAM_READ_TIMEOUT_MS } from "../src/modules/10-hope/jobs/deadline";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const SUBMISSION_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const SUBMISSION_2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const REVIEW_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PATIENT = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2030-06-01T00:00:00.000Z");

const fakeDb = {
  transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ execute: async () => undefined }),
} as unknown as DbClient;

const loggedOf = (spy: { mock: { calls: readonly unknown[][] } }): string =>
  spy.mock.calls.map((call) => String(call[0])).join("\n");

let errors: { mock: { calls: readonly unknown[][] } };
let warnings: { mock: { calls: readonly unknown[][] } };
beforeEach(() => {
  for (const group of [retentionStore, assembleStore, submissionStore]) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const NEVER = (): Promise<never> => new Promise<never>(() => {});

const baseDeps = (over: Partial<M10WorkerDeps> = {}): M10WorkerDeps => ({
  connection: {} as never,
  db: fakeDb,
  outbox: { publish: vi.fn(async () => undefined) },
  activeOrgs: {
    listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
  },
  retentionHolds: {
    activeLegalHoldScopeForOrg: async () => ({ orgWide: false, patientIds: new Set<string>() }),
  },
  now: () => NOW,
  ...over,
});

describe("the retention scan bounds its port reads", () => {
  beforeEach(() => {
    retentionStore.hopeRetentionFactsForOrg.mockResolvedValue([]);
    retentionStore.retentionReviewsForOrg.mockResolvedValue([]);
  });

  it("a legal-hold read that never answers fails ITS org after the deadline; the next org is still scanned and the read is named", async () => {
    vi.useFakeTimers();
    const activeLegalHoldScopeForOrg = vi.fn(async (org: string) =>
      org === ORG_A ? NEVER() : { orgWide: false, patientIds: new Set<string>() },
    );

    const run = runHopeRetentionCron(baseDeps({ retentionHolds: { activeLegalHoldScopeForOrg } }));
    const settled = expect(run).rejects.toMatchObject({
      name: "AggregateError",
      errors: [expect.objectContaining({ name: "DeadlineError" })],
    });
    await vi.advanceTimersByTimeAsync(M10_SEAM_READ_TIMEOUT_MS);
    await settled;

    expect(activeLegalHoldScopeForOrg.mock.calls.map((c) => c[0])).toEqual([ORG_A, ORG_B]);
    expect(retentionStore.hopeRetentionFactsForOrg.mock.calls.map((c) => c[1])).toEqual([ORG_B]);
    const logged = loggedOf(errors);
    expect(logged).toContain(ORG_A);
    expect(logged).toContain("the M4 legal-hold read");
    expect(logged).toContain("DeadlineError");
    expect(vi.getTimerCount()).toBe(0); // the deadline timer is always cleared
  });

  it("an override read that never answers fails ITS org after the deadline too", async () => {
    vi.useFakeTimers();
    const overrideYearsForOrg = vi.fn(async (org: string) => (org === ORG_A ? NEVER() : null));

    const run = runHopeRetentionCron(baseDeps({ retentionOverride: { overrideYearsForOrg } }));
    const settled = expect(run).rejects.toBeInstanceOf(AggregateError);
    await vi.advanceTimersByTimeAsync(M10_SEAM_READ_TIMEOUT_MS);
    await settled;

    expect(retentionStore.hopeRetentionFactsForOrg.mock.calls.map((c) => c[1])).toEqual([ORG_B]);
    expect(loggedOf(errors)).toContain("the retention-override read");
  });

  it("a read that answers in time, or a deployment with no override port, is unaffected", async () => {
    const overrideYearsForOrg = vi.fn(async () => 9);

    await expect(
      runHopeRetentionCron(baseDeps({ retentionOverride: { overrideYearsForOrg } })),
    ).resolves.toBeUndefined();
    await expect(runHopeRetentionCron(baseDeps())).resolves.toBeUndefined();

    expect(overrideYearsForOrg).toHaveBeenCalledTimes(2);
  });
});

describe("the retention scan does not act on a verdict judged on a row that moved", () => {
  const facts = {
    patientId: PATIENT,
    providerEntityId: null,
    locationId: null,
    lastEffectiveAt: new Date("2000-01-01T00:00:00.000Z"), // long past the 7-year horizon
    lastTransmittedAt: null,
    openIqiesError: false,
    pendingCorrection: false,
    legalHold: false,
  };
  const prior = { id: REVIEW_ID, patientId: PATIENT, status: "blocked" };
  const onlyOrgA = {
    activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
  };

  beforeEach(() => {
    retentionStore.hopeRetentionFactsForOrg.mockResolvedValue([facts]);
    retentionStore.retentionReviewsForOrg.mockResolvedValue([prior]);
  });

  it("keys the update on the status the verdict was judged from, and publishes the event once when it wrote", async () => {
    retentionStore.updateRetentionReview.mockResolvedValue(true);
    const publish = vi.fn(async () => undefined);

    await runHopeRetentionCron(baseDeps({ ...onlyOrgA, outbox: { publish } }));

    expect(retentionStore.updateRetentionReview).toHaveBeenCalledWith(
      expect.anything(),
      REVIEW_ID,
      "blocked",
      expect.objectContaining({ status: "eligible" }),
    );
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("an update that matched no row (another scan moved it, or a destruction deleted it) publishes nothing and says so", async () => {
    retentionStore.updateRetentionReview.mockResolvedValue(false);
    const publish = vi.fn(async () => undefined);

    await expect(
      runHopeRetentionCron(baseDeps({ ...onlyOrgA, outbox: { publish } })),
    ).resolves.toBeUndefined();

    expect(publish).not.toHaveBeenCalled();
    const warned = loggedOf(warnings);
    expect(warned).toContain(REVIEW_ID);
    expect(warned).toContain(ORG_A);
    expect(warned).not.toContain(PATIENT);
  });
});

describe("the iQIES reconcile worker re-judges the batch behind a lock", () => {
  const batch = (submissionId: string) => ({
    submissionId,
    iqiesBatchId: `iqies-${submissionId}`,
    providerEntityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    submissionPeriod: "2030-Q2",
    status: "in_flight" as const,
  });
  const onlyOrgA = { activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] } };
  const iqiesAnswering = {
    submitBatch: vi.fn(),
    fetchAcceptanceReport: vi.fn(async (iqiesBatchId: string) => ({ iqiesBatchId, items: [] })),
  };

  beforeEach(() => {
    iqiesAnswering.fetchAcceptanceReport.mockClear();
    submissionStore.inFlightSubmissionsForOrg.mockResolvedValue([batch(SUBMISSION_1)]);
  });

  it("a batch another tick already finished is left alone: nothing is read, written or published, and the log names it", async () => {
    submissionStore.lockInFlightSubmission.mockResolvedValue(false);
    const publish = vi.fn(async () => undefined);

    const outcome = await runIqiesReconcileCron(
      baseDeps({ ...onlyOrgA, iqies: iqiesAnswering, outbox: { publish } }),
    );

    expect(outcome).toEqual({ reconciled: [], failed: [] });
    expect(submissionStore.pendingItemsForSubmission).not.toHaveBeenCalled();
    expect(submissionStore.applyItemTransition).not.toHaveBeenCalled();
    expect(submissionStore.writeValidationFindings).not.toHaveBeenCalled();
    expect(submissionStore.recordReconcileOutcome).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    const warned = loggedOf(warnings);
    expect(warned).toContain(SUBMISSION_1);
    expect(warned).toContain(ORG_A);
  });

  it("locks the batch BEFORE it reads the pending items, so the items are read behind the lock", async () => {
    const order: string[] = [];
    submissionStore.lockInFlightSubmission.mockImplementation(async () => {
      order.push("lock");
      return true;
    });
    submissionStore.pendingItemsForSubmission.mockImplementation(async () => {
      order.push("read items");
      return [];
    });

    const outcome = await runIqiesReconcileCron(baseDeps({ ...onlyOrgA, iqies: iqiesAnswering }));

    expect(order).toEqual(["lock", "read items"]);
    expect(outcome).toEqual({ reconciled: [SUBMISSION_1], failed: [] });
  });

  it("an acceptance-report read that never answers fails ITS batch after the deadline; the next batch is still reconciled", async () => {
    vi.useFakeTimers();
    submissionStore.inFlightSubmissionsForOrg.mockResolvedValue([
      batch(SUBMISSION_1),
      batch(SUBMISSION_2),
    ]);
    submissionStore.lockInFlightSubmission.mockResolvedValue(true);
    submissionStore.pendingItemsForSubmission.mockResolvedValue([]);
    const fetchAcceptanceReport = vi.fn(async (iqiesBatchId: string) =>
      iqiesBatchId === `iqies-${SUBMISSION_1}` ? NEVER() : { iqiesBatchId, items: [] },
    );

    const run = runIqiesReconcileCron(
      baseDeps({ ...onlyOrgA, iqies: { submitBatch: vi.fn(), fetchAcceptanceReport } }),
    );
    const settled = expect(run).rejects.toBeInstanceOf(AggregateError);
    await vi.advanceTimersByTimeAsync(M10_SEAM_READ_TIMEOUT_MS);
    await settled;

    expect(fetchAcceptanceReport).toHaveBeenCalledTimes(2);
    const logged = loggedOf(errors);
    expect(logged).toContain(SUBMISSION_1);
    expect(logged).toContain("the iQIES acceptance-report read");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the iQIES submit worker bounds the CCN read", () => {
  it("a CCN read that never answers fails ITS batch after the deadline and releases nothing it did not claim; the next org is still served", async () => {
    vi.useFakeTimers();
    const item = {
      hopeAssessmentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      rfaKind: "01_admission" as const,
      dischargeReason: null,
      data: {},
      targetDate: NOW,
      providerEntityId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      locationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      correctsIqiesRecordId: null,
    };
    submissionStore.queuedSubmissionsForOrg.mockImplementation(
      async (_tx: unknown, org: string) => [
        {
          submissionId: org === ORG_A ? SUBMISSION_1 : SUBMISSION_2,
          providerEntityId: item.providerEntityId,
          submissionPeriod: "2030-Q2",
          status: "queued" as const,
        },
      ],
    );
    submissionStore.pendingItemsForSubmission.mockResolvedValue([item]);
    submissionStore.claimSubmissionForTransmit.mockResolvedValue(true);
    const ccnFor = vi.fn(async (org: string) => (org === ORG_A ? NEVER() : null));

    const run = runIqiesSubmitCron(
      baseDeps({
        validateItem: async () => [],
        providerEntityCcn: { ccnFor },
        iqies: { submitBatch: vi.fn(), fetchAcceptanceReport: vi.fn() },
      }),
    );
    const settled = expect(run).rejects.toBeInstanceOf(AggregateError);
    await vi.advanceTimersByTimeAsync(M10_SEAM_READ_TIMEOUT_MS);
    await settled;

    expect(ccnFor.mock.calls.map((c) => c[0])).toEqual([ORG_A, ORG_B]); // org B was still reached
    expect(submissionStore.recordTransmit).not.toHaveBeenCalled();
    expect(loggedOf(errors)).toContain("the M1 CCN read");
    expect(vi.getTimerCount()).toBe(0);
  });
});
