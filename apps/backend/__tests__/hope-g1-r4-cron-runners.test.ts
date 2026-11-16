import type { DbClient } from "@chartwarden/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Group g1, round 4: the cron runners with the stores and the database faked (no live infrastructure).
//  - the retention scan hands the hold's patients to the store (which compares them in SQL on canonical uuids) and
//    believes what the store answers, so a hold typed in another spelling still blocks the flag;
//  - the unwired assemble cron takes the manual route's per-provider-entity advisory key and reads its candidates AGAIN
//    behind it, in a stable order, so an overlapping run skips what the winner batched instead of inserting twice;
//  - the reconcile worker matches the acceptance report's items on the database's id (an adapter may spell it another
//    way), says so when a report names none of a batch's items, and fails a batch whose item is no longer pending.
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
  runAssembleSubmissionCron,
  runHopeRetentionCron,
  runIqiesReconcileCron,
} from "../src/modules/10-hope/jobs/cron-workers";

const ORG = "11111111-1111-4111-8111-111111111111";
const PE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PATIENT = "abcdef01-2345-4678-89ab-cdef01234567";
const REVIEW_ID = "44444444-4444-4444-8444-444444444444";
const SUBMISSION = "55555555-5555-4555-8555-555555555555";
const ASSESSMENT = "cdef0123-4567-4789-8abc-def012345678";
const NOW = new Date("2030-06-01T00:00:00.000Z");

const dialect = new PgDialect();
/** What the fake transaction ran, in order: the statements the cron issued itself and the store reads it faked. */
let order: string[] = [];
const fakeDb = {
  transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
        const { sql, params } = dialect.sqlToQuery(query);
        if (/app\.(org|user)_id/.test(sql)) return; // the tenancy envelope's own statements
        order.push(`exec: ${sql} [${params.join(",")}]`);
      },
    }),
} as unknown as DbClient;

const baseDeps = (over: Partial<M10WorkerDeps> = {}): M10WorkerDeps => ({
  connection: {} as never,
  db: fakeDb,
  outbox: { publish: vi.fn(async () => undefined) },
  activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
  retentionHolds: {
    activeLegalHoldScopeForOrg: async () => ({ orgWide: false, patientIds: new Set<string>() }),
  },
  now: () => NOW,
  ...over,
});

let warnings: { mock: { calls: readonly unknown[][] } };
let errors: { mock: { calls: readonly unknown[][] } };
const textOf = (spy: { mock: { calls: readonly unknown[][] } }): string =>
  spy.mock.calls.map((call) => String(call[0])).join("\n");

beforeEach(() => {
  order = [];
  for (const group of [retentionStore, assembleStore, submissionStore]) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
  warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the retention scan and a legal hold typed in another spelling", () => {
  const facts = (legalHold: boolean) => ({
    patientId: PATIENT,
    providerEntityId: null,
    locationId: null,
    lastEffectiveAt: new Date("2000-01-01T00:00:00.000Z"), // long past the 7-year horizon
    lastTransmittedAt: null,
    openIqiesError: false,
    pendingCorrection: false,
    legalHold,
  });
  const heldInUpperCase = new Set([PATIENT.toUpperCase()]);
  const deps = (publish = vi.fn(async () => undefined)) =>
    baseDeps({
      outbox: { publish },
      retentionHolds: {
        activeLegalHoldScopeForOrg: async () => ({ orgWide: false, patientIds: heldInUpperCase }),
      },
    });

  beforeEach(() => {
    retentionStore.retentionReviewsForOrg.mockResolvedValue([]);
    retentionStore.insertRetentionReview.mockResolvedValue(REVIEW_ID);
  });

  it("hands the hold's patients, as the hold names them, to the store that compares them in SQL", async () => {
    retentionStore.hopeRetentionFactsForOrg.mockResolvedValue([]);

    await runHopeRetentionCron(deps());

    expect(retentionStore.hopeRetentionFactsForOrg).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      heldInUpperCase,
    );
  });

  it("a patient the store reports as held is blocked with legal_hold, never flagged, and nothing is announced", async () => {
    retentionStore.hopeRetentionFactsForOrg.mockResolvedValue([facts(true)]);
    const publish = vi.fn(async () => undefined);

    await runHopeRetentionCron(deps(publish));

    expect(retentionStore.insertRetentionReview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "blocked", blockers: ["legal_hold"], patientId: PATIENT }),
    );
    expect(publish).not.toHaveBeenCalled();
  });

  it("a patient the store reports as not held is flagged and announced once", async () => {
    retentionStore.hopeRetentionFactsForOrg.mockResolvedValue([facts(false)]);
    const publish = vi.fn(async () => undefined);

    await runHopeRetentionCron(deps(publish));

    expect(retentionStore.insertRetentionReview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "eligible" }),
    );
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("an org-wide hold still blocks everyone without the store's help", async () => {
    retentionStore.hopeRetentionFactsForOrg.mockResolvedValue([facts(false)]);
    const publish = vi.fn(async () => undefined);

    await runHopeRetentionCron(
      baseDeps({
        outbox: { publish },
        retentionHolds: {
          activeLegalHoldScopeForOrg: async () => ({
            orgWide: true,
            patientIds: new Set<string>(),
          }),
        },
      }),
    );

    expect(retentionStore.insertRetentionReview).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "blocked", blockers: ["legal_hold"] }),
    );
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("the assemble cron serialises per provider entity behind the manual route's advisory key", () => {
  const candidate = (providerEntityId: string, assessmentId: string, hasActive = false) => ({
    assessmentId,
    providerEntityId,
    submissionPeriod: "2030-06",
    rfaKind: "01_admission",
    signedAt: "2030-05-01T00:00:00.000Z",
    hasActiveSubmissionItem: hasActive,
    iqiesRecordId: null,
    correctsIqiesRecordId: null,
  });
  const A1 = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
  const B1 = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1";

  beforeEach(() => {
    assembleStore.persistAssembledSubmission.mockImplementation(
      async (
        _tx: unknown,
        _org: string,
        planned: { providerEntityId: string; items: unknown[] },
      ) => {
        order.push(`persist:${planned.providerEntityId}`);
        return {
          submission: {
            id: `sub-${planned.providerEntityId}`,
            providerEntityId: planned.providerEntityId,
            itemCount: planned.items.length,
          },
          assessmentIds: [],
        };
      },
    );
  });

  it("reads which entities have work (unlocked), then per entity, in sorted order: key, candidates again, persist", async () => {
    assembleStore.assemblableAssessmentsForOrg.mockImplementation(
      async (_tx: unknown, _org: string, providerEntityId?: string) => {
        order.push(`read:${providerEntityId ?? "all"}`);
        const all = [candidate(PE_B, B1), candidate(PE_A, A1)];
        return {
          eligible: providerEntityId
            ? all.filter((c) => c.providerEntityId === providerEntityId)
            : all,
          unsitedAssessmentIds: [],
        };
      },
    );

    const outcome = await runAssembleSubmissionCron(baseDeps());

    expect(outcome).toEqual({ submissionsCreated: 2, assessmentsBatched: 2, skippedUnsited: 0 });
    const steps = order.map((step) =>
      step.startsWith("exec: SELECT pg_advisory_xact_lock") ? "lock" : step.split(" [")[0],
    );
    const keyed = order.filter((step) => step.includes("pg_advisory_xact_lock"));
    expect(keyed).toHaveLength(2);
    expect(keyed[0]).toContain(`m10:assemble:${ORG},${PE_A}`);
    expect(keyed[1]).toContain(`m10:assemble:${ORG},${PE_B}`);
    expect(
      steps.filter((s) => s === "lock" || s.startsWith("read:") || s.startsWith("persist:")),
    ).toEqual([
      "read:all",
      "lock",
      `read:${PE_A}`,
      `persist:${PE_A}`,
      "lock",
      `read:${PE_B}`,
      `persist:${PE_B}`,
    ]);
  });

  it("an overlapping run: what the winner already batched reads back as a skip behind the key, and nothing is inserted", async () => {
    assembleStore.assemblableAssessmentsForOrg.mockImplementation(
      async (_tx: unknown, _org: string, providerEntityId?: string) => ({
        // the unlocked read still saw the assessment unbatched; behind the key the winner's pending item is visible
        eligible: [candidate(PE_A, A1, providerEntityId !== undefined)],
        unsitedAssessmentIds: [],
      }),
    );
    const publish = vi.fn(async () => undefined);

    const outcome = await runAssembleSubmissionCron(baseDeps({ outbox: { publish } }));

    expect(outcome).toEqual({ submissionsCreated: 0, assessmentsBatched: 0, skippedUnsited: 0 });
    expect(assembleStore.persistAssembledSubmission).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("a key that cannot be had in time fails that org (logged, typed busy), and inserts nothing", async () => {
    const timeout = new Error("Failed query", {
      cause: Object.assign(new Error("driver"), { code: "55P03" }),
    });
    const lockFails = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
            const { sql } = dialect.sqlToQuery(query);
            if (sql.includes("pg_advisory_xact_lock")) throw timeout;
          },
        }),
    } as unknown as DbClient;
    assembleStore.assemblableAssessmentsForOrg.mockResolvedValue({
      eligible: [candidate(PE_A, A1)],
      unsitedAssessmentIds: [],
    });

    await expect(runAssembleSubmissionCron(baseDeps({ db: lockFails }))).rejects.toBeInstanceOf(
      AggregateError,
    );

    expect(assembleStore.persistAssembledSubmission).not.toHaveBeenCalled();
    expect(textOf(warnings)).toContain(`advisory key m10:assemble:${ORG}`);
    expect(textOf(errors)).toContain("assemble-hope-submission");
    expect(textOf(errors)).toContain(ORG);
  });

  it("an org with nothing to batch takes no key", async () => {
    assembleStore.assemblableAssessmentsForOrg.mockResolvedValue({
      eligible: [],
      unsitedAssessmentIds: ["unsited-1"],
    });

    const outcome = await runAssembleSubmissionCron(baseDeps());

    expect(outcome).toEqual({ submissionsCreated: 0, assessmentsBatched: 0, skippedUnsited: 1 });
    expect(order.some((step) => step.includes("pg_advisory_xact_lock"))).toBe(false);
  });
});

describe("the reconcile worker and the acceptance report", () => {
  const BATCH = { submissionId: SUBMISSION, iqiesBatchId: "iqies-batch-1" };
  const pendingItem = {
    hopeAssessmentId: ASSESSMENT,
    rfaKind: "01_admission",
    dischargeReason: null,
    data: {},
    targetDate: new Date("2030-05-01T00:00:00.000Z"),
    providerEntityId: PE_A,
    locationId: PE_B,
    correctsIqiesRecordId: null,
  };
  const iqiesReporting = (items: { hopeAssessmentId: string }[]) => ({
    submitBatch: vi.fn(),
    fetchAcceptanceReport: vi.fn(async (iqiesBatchId: string) => ({
      iqiesBatchId,
      items: items.map((i) => ({
        hopeAssessmentId: i.hopeAssessmentId,
        outcome: "accepted" as const,
        iqiesRecordId: "iqies-rec-1",
        findings: [],
      })),
    })),
  });

  beforeEach(() => {
    submissionStore.inFlightSubmissionsForOrg.mockResolvedValue([BATCH]);
    submissionStore.lockInFlightSubmission.mockResolvedValue(true);
    submissionStore.pendingItemsForSubmission.mockResolvedValue([pendingItem]);
    submissionStore.applyItemTransition.mockResolvedValue(true);
    submissionStore.writeValidationFindings.mockResolvedValue({ written: 0, unsited: 0 });
  });

  it("an item the adapter spells in upper case is the same item: applied on the database's id, and the batch folds", async () => {
    const publish = vi.fn(async () => undefined);

    const outcome = await runIqiesReconcileCron(
      baseDeps({
        outbox: { publish },
        iqies: iqiesReporting([{ hopeAssessmentId: ASSESSMENT.toUpperCase() }]),
      }),
    );

    expect(outcome.reconciled).toEqual([SUBMISSION]);
    expect(submissionStore.applyItemTransition).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      SUBMISSION,
      expect.objectContaining({ hopeAssessmentId: ASSESSMENT, itemStatus: "accepted" }),
      expect.objectContaining({ outcome: "accepted" }),
    );
    expect(submissionStore.recordReconcileOutcome).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalled();
  });

  it("a report that names none of the batch's pending items leaves it in flight and SAYS so, with the ids", async () => {
    const outcome = await runIqiesReconcileCron(
      baseDeps({
        iqies: iqiesReporting([{ hopeAssessmentId: "99999999-9999-4999-8999-999999999999" }]),
      }),
    );

    expect(outcome).toEqual({ reconciled: [], failed: [] });
    expect(submissionStore.applyItemTransition).not.toHaveBeenCalled();
    expect(submissionStore.recordReconcileOutcome).not.toHaveBeenCalled();
    const said = textOf(warnings);
    expect(said).toContain(SUBMISSION);
    expect(said).toContain(ORG);
    expect(said).toContain("named none of its 1 pending item(s)");
  });

  it("an item that is no longer pending fails THAT batch: nothing folded, nothing announced, the ids logged", async () => {
    submissionStore.applyItemTransition.mockResolvedValue(false);
    const publish = vi.fn(async () => undefined);

    await expect(
      runIqiesReconcileCron(
        baseDeps({
          outbox: { publish },
          iqies: iqiesReporting([{ hopeAssessmentId: ASSESSMENT }]),
        }),
      ),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(submissionStore.recordReconcileOutcome).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    const said = textOf(warnings);
    expect(said).toContain(ASSESSMENT);
    expect(said).toContain(SUBMISSION);
    expect(said).toContain(ORG);
    expect(textOf(errors)).toContain("ReconcileItemNotPendingError");
  });
});
