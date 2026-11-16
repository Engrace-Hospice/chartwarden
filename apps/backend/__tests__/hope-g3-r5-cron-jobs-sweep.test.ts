import type { DbClient } from "@chartwarden/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scriptedDb } from "./_hope-g3-fake-db";

// Group g3, round 5: the iQIES job runners and the submission store, with the stores and the database faked (no Postgres):
//  - a reconcile report is an external payload and may name ONE assessment more than once (the same id twice, or in two
//    spellings). The batch must get one outcome per assessment (the worst wins), not a transition that meets an
//    already-settled item and fails the batch on every tick, and not a count that folds the batch while an item is pending;
//  - the unwired assemble cron locks only the provider entities `planAssembleSubmissions` would batch something for;
//  - the two recorders that follow a claim / a row lock name the status they are written from, and a write that matches
//    nothing fails the batch instead of being announced.
// The predicates' SEMANTICS on a real catalog need a live suite; here the SQL they render is asserted.
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
  runIqiesReconcileCron,
  runIqiesSubmitCron,
} from "../src/modules/10-hope/jobs/cron-workers";

const ORG = "11111111-1111-4111-8111-111111111111";
const PE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SUBMISSION = "55555555-5555-4555-8555-555555555555";
const ASSESSMENT_A = "cdef0123-4567-4789-8abc-def012345678";
const ASSESSMENT_B = "bcdef012-3456-4678-89ab-cdef01234567";
const NOW = new Date("2030-06-01T00:00:00.000Z");

const dialect = new PgDialect();
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

describe("the reconcile worker and a report that names one assessment more than once", () => {
  const BATCH = { submissionId: SUBMISSION, iqiesBatchId: "iqies-batch-1" };
  const pendingItem = (hopeAssessmentId: string) => ({
    hopeAssessmentId,
    rfaKind: "01_admission",
    dischargeReason: null,
    data: {},
    targetDate: new Date("2030-05-01T00:00:00.000Z"),
    providerEntityId: PE_A,
    locationId: PE_B,
    correctsIqiesRecordId: null,
  });
  type ReportRow = {
    hopeAssessmentId: string;
    outcome: "accepted" | "rejected";
    iqiesRecordId: string | null;
    findings: { ruleId: string; message: string }[];
  };
  const accepted = (hopeAssessmentId: string, iqiesRecordId = "iqies-rec-1"): ReportRow => ({
    hopeAssessmentId,
    outcome: "accepted",
    iqiesRecordId,
    findings: [],
  });
  const rejected = (hopeAssessmentId: string, ruleId: string): ReportRow => ({
    hopeAssessmentId,
    outcome: "rejected",
    iqiesRecordId: null,
    findings: [{ ruleId, message: `${ruleId} failed` }],
  });
  const iqiesReporting = (items: ReportRow[]) => ({
    submitBatch: vi.fn(),
    fetchAcceptanceReport: vi.fn(async (iqiesBatchId: string) => ({ iqiesBatchId, items })),
  });
  /** Behaves like the real store: the first transition of an item settles it, a second finds it no longer pending. */
  const settleOnce = () => {
    const settled = new Set<string>();
    submissionStore.applyItemTransition.mockImplementation(
      async (
        _tx: unknown,
        _org: string,
        _submission: string,
        transition: { hopeAssessmentId: string },
      ) => {
        if (settled.has(transition.hopeAssessmentId)) return false;
        settled.add(transition.hopeAssessmentId);
        return true;
      },
    );
  };

  beforeEach(() => {
    submissionStore.inFlightSubmissionsForOrg.mockResolvedValue([BATCH]);
    submissionStore.lockInFlightSubmission.mockResolvedValue(true);
    submissionStore.writeValidationFindings.mockResolvedValue({ written: 0, unsited: 0 });
    submissionStore.recordReconcileOutcome.mockResolvedValue(true);
    settleOnce();
  });

  it("one assessment named twice, with a second item still unanswered: ONE transition, the batch is neither failed nor folded", async () => {
    submissionStore.pendingItemsForSubmission.mockResolvedValue([
      pendingItem(ASSESSMENT_A),
      pendingItem(ASSESSMENT_B),
    ]);
    const publish = vi.fn(async () => undefined);

    const outcome = await runIqiesReconcileCron(
      baseDeps({
        outbox: { publish },
        iqies: iqiesReporting([accepted(ASSESSMENT_A), accepted(ASSESSMENT_A)]),
      }),
    );

    expect(outcome).toEqual({ reconciled: [], failed: [] });
    expect(submissionStore.applyItemTransition).toHaveBeenCalledTimes(1);
    expect(submissionStore.recordReconcileOutcome).not.toHaveBeenCalled(); // B is still pending
    expect(publish).not.toHaveBeenCalled();
    expect(textOf(errors)).not.toContain("ReconcileItemNotPendingError");
  });

  it("one assessment in two spellings is one assessment: one transition on the database's id, and the batch folds", async () => {
    submissionStore.pendingItemsForSubmission.mockResolvedValue([pendingItem(ASSESSMENT_A)]);

    const outcome = await runIqiesReconcileCron(
      baseDeps({
        iqies: iqiesReporting([accepted(ASSESSMENT_A.toUpperCase()), accepted(ASSESSMENT_A)]),
      }),
    );

    expect(outcome.reconciled).toEqual([SUBMISSION]);
    expect(submissionStore.applyItemTransition).toHaveBeenCalledTimes(1);
    expect(submissionStore.applyItemTransition).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      SUBMISSION,
      expect.objectContaining({ hopeAssessmentId: ASSESSMENT_A, itemStatus: "accepted" }),
      expect.anything(),
    );
    expect(submissionStore.recordReconcileOutcome).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      expect.objectContaining({ acceptedCount: 1, rejectedCount: 0, nextStatus: "accepted" }),
    );
  });

  it.each([
    ["accepted then rejected", [accepted(ASSESSMENT_A), rejected(ASSESSMENT_A, "R1")]],
    ["rejected then accepted", [rejected(ASSESSMENT_A, "R1"), accepted(ASSESSMENT_A)]],
  ])(
    "the worst outcome wins whatever the row order (%s): the item is rejected, never accepted",
    async (_label, rows) => {
      submissionStore.pendingItemsForSubmission.mockResolvedValue([pendingItem(ASSESSMENT_A)]);

      await runIqiesReconcileCron(baseDeps({ iqies: iqiesReporting(rows) }));

      expect(submissionStore.applyItemTransition).toHaveBeenCalledTimes(1);
      expect(submissionStore.applyItemTransition).toHaveBeenCalledWith(
        expect.anything(),
        ORG,
        SUBMISSION,
        expect.objectContaining({ hopeAssessmentId: ASSESSMENT_A, itemStatus: "rejected" }),
        expect.objectContaining({ outcome: "rejected" }),
      );
      expect(submissionStore.recordReconcileOutcome).toHaveBeenCalledWith(
        expect.anything(),
        ORG,
        expect.objectContaining({ acceptedCount: 0, rejectedCount: 1, nextStatus: "rejected" }),
      );
    },
  );

  it("two rejections of one assessment keep the findings of both, once each", async () => {
    submissionStore.pendingItemsForSubmission.mockResolvedValue([pendingItem(ASSESSMENT_A)]);

    await runIqiesReconcileCron(
      baseDeps({
        iqies: iqiesReporting([rejected(ASSESSMENT_A, "R1"), rejected(ASSESSMENT_A, "R2")]),
      }),
    );

    const written = submissionStore.writeValidationFindings.mock.calls[0]?.[2] as {
      ruleId: string;
    }[];
    expect(written.map((f) => f.ruleId)).toEqual(["R1", "R2"]);
    expect(submissionStore.applyItemTransition).toHaveBeenCalledWith(
      expect.anything(),
      ORG,
      SUBMISSION,
      expect.anything(),
      {
        outcome: "rejected",
        findings: [
          { ruleId: "R1", message: "R1 failed" },
          { ruleId: "R2", message: "R2 failed" },
        ],
      },
    );
  });

  it("a row repeated verbatim (the same rejection twice) writes its finding once", async () => {
    submissionStore.pendingItemsForSubmission.mockResolvedValue([pendingItem(ASSESSMENT_A)]);

    await runIqiesReconcileCron(
      baseDeps({
        iqies: iqiesReporting([rejected(ASSESSMENT_A, "R1"), rejected(ASSESSMENT_A, "R1")]),
      }),
    );

    const written = submissionStore.writeValidationFindings.mock.calls[0]?.[2] as {
      ruleId: string;
    }[];
    expect(written.map((f) => f.ruleId)).toEqual(["R1"]);
  });

  it("says so, with the ids and no content, when a report names an assessment more than once", async () => {
    submissionStore.pendingItemsForSubmission.mockResolvedValue([pendingItem(ASSESSMENT_A)]);

    await runIqiesReconcileCron(
      baseDeps({ iqies: iqiesReporting([accepted(ASSESSMENT_A), accepted(ASSESSMENT_A)]) }),
    );

    const said = textOf(warnings);
    expect(said).toContain(SUBMISSION);
    expect(said).toContain(ORG);
    expect(said).toContain("more than once");
  });

  it("a report with no repeated row says nothing about repeats", async () => {
    submissionStore.pendingItemsForSubmission.mockResolvedValue([pendingItem(ASSESSMENT_A)]);

    await runIqiesReconcileCron(baseDeps({ iqies: iqiesReporting([accepted(ASSESSMENT_A)]) }));

    expect(textOf(warnings)).not.toContain("more than once");
  });

  it("an item that was settled by a writer that took no lock still fails the batch, with a log that names the ids", async () => {
    submissionStore.pendingItemsForSubmission.mockResolvedValue([pendingItem(ASSESSMENT_A)]);
    submissionStore.applyItemTransition.mockResolvedValue(false);
    const publish = vi.fn(async () => undefined);

    await expect(
      runIqiesReconcileCron(
        baseDeps({ outbox: { publish }, iqies: iqiesReporting([accepted(ASSESSMENT_A)]) }),
      ),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(submissionStore.recordReconcileOutcome).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(textOf(warnings)).toContain(ASSESSMENT_A);
    expect(textOf(warnings)).not.toContain("unreachable");
  });

  it("an outcome that matched no row (the batch left in_flight under the lock) fails the batch: nothing announced, the ids logged", async () => {
    submissionStore.pendingItemsForSubmission.mockResolvedValue([pendingItem(ASSESSMENT_A)]);
    submissionStore.recordReconcileOutcome.mockResolvedValue(false);
    const publish = vi.fn(async () => undefined);

    await expect(
      runIqiesReconcileCron(
        baseDeps({ outbox: { publish }, iqies: iqiesReporting([accepted(ASSESSMENT_A)]) }),
      ),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(publish).not.toHaveBeenCalled();
    expect(textOf(warnings)).toContain(SUBMISSION);
    expect(textOf(warnings)).toContain(ORG);
    expect(textOf(errors)).toContain("SubmissionNotInFlightError");
  });
});

describe("the iQIES submit worker and a transmit that matched no row", () => {
  const item = {
    hopeAssessmentId: ASSESSMENT_A,
    rfaKind: "01_admission" as const,
    dischargeReason: null,
    data: {},
    targetDate: NOW,
    providerEntityId: PE_A,
    locationId: PE_B,
    correctsIqiesRecordId: null,
  };

  it("recordTransmit answering false fails THAT batch: not announced as transmitted, released, the ids logged", async () => {
    submissionStore.queuedSubmissionsForOrg.mockResolvedValue([
      {
        submissionId: SUBMISSION,
        providerEntityId: PE_A,
        submissionPeriod: "2030-Q2",
        status: "queued",
      },
    ]);
    submissionStore.pendingItemsForSubmission.mockResolvedValue([item]);
    submissionStore.claimSubmissionForTransmit.mockResolvedValue(true);
    submissionStore.recordTransmit.mockResolvedValue(false);
    const publish = vi.fn(async () => undefined);

    await expect(
      runIqiesSubmitCron(
        baseDeps({
          outbox: { publish },
          validateItem: async () => [],
          providerEntityCcn: { ccnFor: async () => "123456" },
          iqies: {
            submitBatch: vi.fn(async () => ({
              iqiesBatchId: "iqies-batch-1",
              transmittedAt: NOW.toISOString(),
            })),
            fetchAcceptanceReport: vi.fn(),
          },
        }),
      ),
    ).rejects.toBeInstanceOf(AggregateError);

    expect(publish).not.toHaveBeenCalled();
    expect(submissionStore.releaseSubmission).toHaveBeenCalledTimes(1);
    expect(textOf(warnings)).toContain(SUBMISSION);
    expect(textOf(warnings)).toContain(ORG);
    expect(textOf(errors)).toContain("SubmissionNotInFlightError");
  });
});

describe("the assemble cron locks only the provider entities it would batch something for", () => {
  const candidate = (
    providerEntityId: string,
    assessmentId: string,
    over: { hasActive?: boolean; iqiesRecordId?: string | null } = {},
  ) => ({
    assessmentId,
    providerEntityId,
    submissionPeriod: "2030-06",
    rfaKind: "01_admission",
    signedAt: "2030-05-01T00:00:00.000Z",
    hasActiveSubmissionItem: over.hasActive ?? false,
    iqiesRecordId: over.iqiesRecordId ?? null,
    correctsIqiesRecordId: null,
  });
  const keysTaken = (): string[] => order.filter((step) => step.includes("pg_advisory_xact_lock"));

  beforeEach(() => {
    assembleStore.persistAssembledSubmission.mockImplementation(
      async (
        _tx: unknown,
        _org: string,
        planned: { providerEntityId: string; items: unknown[] },
      ) => ({
        submission: {
          id: `sub-${planned.providerEntityId}`,
          providerEntityId: planned.providerEntityId,
          itemCount: planned.items.length,
        },
        assessmentIds: [],
      }),
    );
  });

  it("an entity whose signed records all sit on an active batch or carry an iQIES record takes no key and is not re-read", async () => {
    assembleStore.assemblableAssessmentsForOrg.mockImplementation(
      async (_tx: unknown, _org: string, providerEntityId?: string) => {
        const all = [
          candidate(PE_A, "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1", { hasActive: true }),
          candidate(PE_A, "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2", { iqiesRecordId: "iqies-rec-1" }),
          candidate(PE_B, "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1"),
        ];
        return {
          eligible: providerEntityId
            ? all.filter((c) => c.providerEntityId === providerEntityId)
            : all,
          unsitedAssessmentIds: [],
        };
      },
    );

    const outcome = await runAssembleSubmissionCron(baseDeps());

    expect(outcome).toEqual({ submissionsCreated: 1, assessmentsBatched: 1, skippedUnsited: 0 });
    const keyed = keysTaken();
    expect(keyed).toHaveLength(1);
    expect(keyed[0]).toContain(`m10:assemble:${ORG},${PE_B}`);
    const reads = assembleStore.assemblableAssessmentsForOrg.mock.calls.map((call) => call[2]);
    expect(reads).toEqual([undefined, PE_B]);
  });

  it("an org where nothing is batchable takes no key at all", async () => {
    assembleStore.assemblableAssessmentsForOrg.mockResolvedValue({
      eligible: [candidate(PE_A, "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1", { hasActive: true })],
      unsitedAssessmentIds: [],
    });

    const outcome = await runAssembleSubmissionCron(baseDeps());

    expect(outcome).toEqual({ submissionsCreated: 0, assessmentsBatched: 0, skippedUnsited: 0 });
    expect(keysTaken()).toHaveLength(0);
    expect(assembleStore.assemblableAssessmentsForOrg).toHaveBeenCalledTimes(1);
  });
});

describe("the submission store's recorders name the status they are written from", () => {
  // The REAL store (the module is mocked above, so it is loaded unmocked here).
  const realStore = () =>
    vi.importActual<typeof import("../src/modules/10-hope/jobs/submission-store")>(
      "../src/modules/10-hope/jobs/submission-store",
    );
  const transmit = {
    submissionId: SUBMISSION,
    iqiesBatchId: "iqies-batch-1",
    envelopeStorageUri: null,
    envelopeSha256: "0".repeat(64),
    transmittedAt: NOW.toISOString(),
  };
  const outcome = {
    submissionId: SUBMISSION,
    nextStatus: "accepted" as const,
    acceptedCount: 1,
    rejectedCount: 0,
    acceptanceReport: {},
    at: NOW,
  };

  it("recordTransmit: the UPDATE names `in_flight`; a row it matched is true, none is false", async () => {
    const { recordTransmit } = await realStore();
    const hit = scriptedDb([[{ id: SUBMISSION }]]);
    const miss = scriptedDb([[]]);

    expect(await recordTransmit(hit.tx, ORG, transmit)).toBe(true);
    expect(await recordTransmit(miss.tx, ORG, transmit)).toBe(false);

    const where = hit.statements.find((s) => s.kind === "update")?.rendered;
    expect(where?.sql).toContain('"status"');
    expect(where?.params).toContain("in_flight");
  });

  it("recordReconcileOutcome: the UPDATE names `in_flight`; a row it matched is true, none is false", async () => {
    const { recordReconcileOutcome } = await realStore();
    const hit = scriptedDb([[{ id: SUBMISSION }]]);
    const miss = scriptedDb([[]]);

    expect(await recordReconcileOutcome(hit.tx, ORG, outcome)).toBe(true);
    expect(await recordReconcileOutcome(miss.tx, ORG, outcome)).toBe(false);

    const where = hit.statements.find((s) => s.kind === "update")?.rendered;
    expect(where?.sql).toContain('"status"');
    expect(where?.params).toContain("in_flight");
  });
});

describe("hopeRetentionFactsForOrg has no default for the legal-hold set", () => {
  it("the holds are a required argument: a caller that drops them does not typecheck (a default of `nobody` would flag held patients)", () => {
    // The assertion is the TYPE: with an optional third parameter this initialiser stops compiling (`typecheck:tests`).
    type Holds = Parameters<
      typeof import("../src/modules/10-hope/jobs/retention-store").hopeRetentionFactsForOrg
    >[2];
    const holdsAreRequired: undefined extends Holds ? "optional" : "required" = "required";

    expect(holdsAreRequired).toBe("required");
  });
});
