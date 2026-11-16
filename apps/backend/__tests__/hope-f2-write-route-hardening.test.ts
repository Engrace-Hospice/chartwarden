import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOPE_SCHEDULE_SKIP_REASON_CODES,
  NotFoundError,
  ValidationError,
} from "@chartwarden/types";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import { requireSkipReasonCode } from "../src/modules/10-hope/hope-schedule-skip";
import { closeCompletedSfv } from "../src/modules/10-hope/hope-sfv-completion-record";
import {
  advancePackagedToExported,
  cancelHopeSubmission,
} from "../src/modules/10-hope/hope-submission-cancel-db";
import { regenerateSchedulesForAdmission } from "../src/modules/10-hope/scheduling/schedule-writer";
import { scriptedDb } from "./_hope-g3-fake-db";

// M10 pre-PR review, fixer F2 (no Postgres; the fake database is scripted): the write routes carry an explicit
// `organization_id` predicate on every statement (on top of RLS), the skip / retry / regenerate waits are bounded,
// the skip reason is a closed list that never echoes what was sent, and recordTimepoint reads the M6 seam before it
// opens its transaction.
const ORG = "11111111-1111-4111-8111-111111111111";
// The acting membership a skip / regenerate hands the service for its audit event (no HTTP request in these tests).
const OPERATOR = { membershipId: "88888888-8888-4888-8888-888888888888" };
const USER = "33333333-3333-4333-8333-333333333333";
const SUB = "66666666-6666-4666-8666-666666666666";
const SCHEDULE = "55555555-5555-4555-8555-555555555555";
const ADMISSION = "abcdef01-2345-4678-89ab-cdef01234567";
const PE = "77777777-7777-4777-8777-777777777777";

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  __resetSeamsForTest();
});

const pgFailure = (code: string): Error =>
  new Error("Failed query: update ... (secret bound value)", {
    cause: Object.assign(new Error("driver message"), { code }),
  });

type Fake = ReturnType<typeof scriptedDb>;
type Statement = Fake["statements"][number];
/** The data statements (not the tenant GUC and lock-timeout `execute`s). */
const dataStatements = (fake: Fake): Statement[] =>
  fake.statements.filter((s) => s.kind !== "execute");
/** True when the statement's WHERE names the organization column and binds the tenant. */
const namesTenant = (s: Statement, org = ORG): boolean =>
  /"organization_id" = \$\d+/.test(s.rendered?.sql ?? "") &&
  (s.rendered?.params ?? []).includes(org);

function backend(outcomes: Parameters<typeof scriptedDb>[0]) {
  const fake = scriptedDb(outcomes);
  return { ...fake, svc: createDbHopeBackend(fake.db, { publish: async () => undefined }) };
}

describe("every write names the tenant beside the id, on top of RLS", () => {
  /** A hold port that reports no hold: the purge path runs (an unbound port would keep the bytes, a path with the same shape). */
  const NO_HOLD = {
    activeLegalHoldScopeInTransaction: async () => ({
      orgWide: false,
      patientIds: new Set<string>(),
    }),
  };
  const HELD_PATIENT = "99999999-9999-4999-8999-999999999999";
  const cancelArgs = (legalHolds: Parameters<typeof cancelHopeSubmission>[1]["legalHolds"]) => ({
    id: SUB,
    organizationId: ORG,
    actorMembershipId: USER,
    reasonCode: "other" as const,
    now: new Date("2026-06-01T00:00:00.000Z"),
    legalHolds,
  });
  const packaged = {
    id: SUB,
    status: "packaged",
    providerEntityId: PE,
    packageSha256: "a".repeat(64),
  };

  it("cancelHopeSubmission: the lock read, the item update and the batch update (the PURGE path, no hold)", async () => {
    const fake = scriptedDb([[packaged], [], [{ id: SUB, status: "cancelled" }], []]);

    await cancelHopeSubmission(fake.tx, cancelArgs(NO_HOLD));

    const data = dataStatements(fake);
    // The last statement is the `hope.submission_cancelled` audit event: audit_event carries no tenant predicate (its RLS
    // and the row's own organization_id do), the three statements before it do.
    expect(data.map((s) => s.kind)).toEqual(["select", "update", "update", "insert"]);
    for (const statement of data.slice(0, 3)) expect(namesTenant(statement)).toBe(true);
  });

  it("cancelHopeSubmission under a patient-scoped hold: the hold lookup names the tenant beside the batch", async () => {
    const fake = scriptedDb([[packaged], [], [], [{ id: SUB, status: "cancelled" }], []]);
    const patientHold = {
      activeLegalHoldScopeInTransaction: async () => ({
        orgWide: false,
        patientIds: new Set([HELD_PATIENT]),
      }),
    };

    await cancelHopeSubmission(fake.tx, cancelArgs(patientHold));

    const data = dataStatements(fake);
    expect(data.map((s) => s.kind)).toEqual(["select", "select", "update", "update", "insert"]);
    for (const statement of data.slice(0, 4)) expect(namesTenant(statement)).toBe(true);
  });

  it("a repeat cancel that purges: the bytes-present read and both purge updates name the tenant", async () => {
    const fake = scriptedDb([
      [{ ...packaged, status: "cancelled", cancelReasonCode: "other" }],
      [{ id: SUB }],
      [],
      [{ id: SUB, status: "cancelled" }],
      [],
    ]);

    await cancelHopeSubmission(fake.tx, cancelArgs(NO_HOLD));

    const data = dataStatements(fake);
    expect(data.map((s) => s.kind)).toEqual(["select", "select", "update", "update", "insert"]);
    for (const statement of data.slice(0, 4)) expect(namesTenant(statement)).toBe(true);
  });

  it("advancePackagedToExported: the guarded write and the status re-read", async () => {
    const fake = scriptedDb([[], [{ status: "packaged" }]]);

    await advancePackagedToExported(fake.tx, ORG, SUB, USER);

    const data = dataStatements(fake);
    expect(data.map((s) => s.kind)).toEqual(["update", "select"]);
    for (const statement of data) expect(namesTenant(statement)).toBe(true);
  });

  it("closeCompletedSfv: the status-guarded completion", async () => {
    const fake = scriptedDb([[{ id: "sfv-1" }]]);

    await closeCompletedSfv(fake.tx, ORG, { id: "sfv-1" } as never, "assessment-1", new Date());

    expect(namesTenant(dataStatements(fake)[0] as Statement)).toBe(true);
  });

  it("skipSchedule: the guarded update and the status re-read", async () => {
    const { svc, ...fake } = backend([[], []]);

    await expect(svc.skipSchedule(ORG, SCHEDULE, "other", OPERATOR)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    const data = dataStatements(fake as Fake);
    expect(data.map((s) => s.kind)).toEqual(["update", "select"]);
    for (const statement of data) expect(namesTenant(statement)).toBe(true);
  });

  it("retrySubmission: the read and the guarded update", async () => {
    const row = { id: SUB, status: "rejected", providerEntityId: PE, itemCount: 1 };
    const { svc, ...fake } = backend([[row], []]);

    await expect(svc.retrySubmission(ORG, SUB)).rejects.toMatchObject({
      code: "M10_SUBMISSION_RETRY_NOT_REJECTED",
    });

    const data = dataStatements(fake as Fake);
    expect(data.map((s) => s.kind)).toEqual(["select", "update"]);
    for (const statement of data) expect(namesTenant(statement)).toBe(true);
  });

  it("markSubmissionUploaded: the row lock and the update", async () => {
    const row = { id: SUB, status: "packaged", packageSha256: "a".repeat(64) };
    const { svc, ...fake } = backend([[row], []]);

    await svc.markSubmissionUploaded(ORG, USER, SUB, {}).catch(() => undefined);

    const data = dataStatements(fake as Fake);
    expect(data.map((s) => s.kind).slice(0, 2)).toEqual(["select", "update"]);
    for (const statement of data.slice(0, 2)) expect(namesTenant(statement)).toBe(true);
  });

  it("downloadSubmissionPackage: both reads", async () => {
    const { svc, ...fake } = backend([[], []]);

    await expect(svc.downloadSubmissionPackage(ORG, SUB)).rejects.toBeInstanceOf(NotFoundError);

    for (const statement of dataStatements(fake as Fake)) expect(namesTenant(statement)).toBe(true);
  });
});

describe("the discharge consumer's system skip names the tenant too", () => {
  it("its UPDATE of the open HUV windows carries the event's organization beside the admission", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "apps/backend/src/modules/10-hope/outbox-consumers/m6-admission-workflow.ts",
      ),
      "utf8",
    );
    const skipUpdate = source.slice(source.indexOf(".update(SCHED)"));
    expect(skipUpdate.slice(0, skipUpdate.indexOf(".insert(SCHED)"))).toContain(
      "eq(SCHED.organizationId, event.organizationId)",
    );
  });
});

describe("skip, retry and regenerate wait for a row lock at most M10_LOCK_TIMEOUT_MS", () => {
  const boundBeforeFirst = (fake: Fake, kind: Statement["kind"]): boolean => {
    const bound = fake.indexOf("execute", "lock_timeout");
    return bound >= 0 && bound < fake.indexOf(kind);
  };

  it("skipSchedule: the bound is set before the update, and a lock timeout is the typed busy 409", async () => {
    const { svc, ...fake } = backend([pgFailure("55P03")]);

    const failure = await svc
      .skipSchedule(ORG, SCHEDULE, "other", OPERATOR)
      .catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: "M10_RECORD_BUSY", statusCode: 409 });
    expect(boundBeforeFirst(fake as unknown as Fake, "update")).toBe(true);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      `schedule row ${SCHEDULE} (org ${ORG}) for a skip`,
    );
  });

  it("retrySubmission: the bound is set before the update, and a lock timeout is the typed busy 409", async () => {
    const row = { id: SUB, status: "rejected", providerEntityId: PE, itemCount: 1 };
    const { svc, ...fake } = backend([[row], pgFailure("55P03")]);

    const failure = await svc.retrySubmission(ORG, SUB).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: "M10_RECORD_BUSY", statusCode: 409 });
    expect(boundBeforeFirst(fake as unknown as Fake, "update")).toBe(true);
  });

  it("regenerate-schedules: the insert is bounded, and a lock timeout is the typed busy 409 (nothing written)", async () => {
    const fake = scriptedDb([[], pgFailure("55P03")]);
    const sitedAdmission = async () => ({
      patientId: "p-1",
      providerEntityId: PE,
      locationId: "88888888-8888-4888-8888-888888888888",
      admissionAt: "2026-06-01",
      activatedAt: "2026-06-01",
      dischargedAt: null,
    });

    const failure = await regenerateSchedulesForAdmission(
      fake.db,
      { publish: async () => undefined },
      { organizationId: ORG, admissionId: ADMISSION, resolveSiting: sitedAdmission },
    ).catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: "M10_RECORD_BUSY", statusCode: 409 });
    expect(boundBeforeFirst(fake, "insert")).toBe(true);
  });
});

describe("the skip reason is a closed list that never echoes what was sent", () => {
  const TYPED = "Jane Doe asked to be skipped";

  it("refuses a free-text reason with a 422 that names the field and the list, not the value", () => {
    let thrown: unknown;
    try {
      requireSkipReasonCode(TYPED);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    const envelope = JSON.stringify({
      message: (thrown as Error).message,
      details: (thrown as ValidationError).details,
    });
    expect(envelope).not.toContain("Jane");
    expect(envelope).toContain("reasonCode");
    expect(envelope).toContain("patient_deceased");
  });

  it("the service refuses it before any statement is sent", async () => {
    const { svc, ...fake } = backend([]);

    await expect(svc.skipSchedule(ORG, SCHEDULE, TYPED, OPERATOR)).rejects.toBeInstanceOf(
      ValidationError,
    );

    expect(fake.statements).toEqual([]);
  });

  it.each([...HOPE_SCHEDULE_SKIP_REASON_CODES])("%s reaches the database", async (code) => {
    const { svc, ...fake } = backend([[], []]);

    await expect(svc.skipSchedule(ORG, SCHEDULE, code, OPERATOR)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(dataStatements(fake as Fake).length).toBeGreaterThan(0);
  });
});

describe("recordTimepoint reads the M6 seam before it opens its transaction", () => {
  const input = {
    rfaKind: "02_huv1",
    targetDate: "2026-06-01T00:00:00.000Z",
    authorDiscipline: "RN",
    data: {},
  } as never;

  /** The fake database, with a flag that is up while a transaction is open. */
  function trackedBackend() {
    const fake = scriptedDb([]);
    const state = { inTx: false, opened: 0 };
    const db = {
      transaction: async (fn: Parameters<typeof fake.db.transaction>[0]) => {
        state.inTx = true;
        state.opened += 1;
        try {
          return await fake.db.transaction(fn);
        } finally {
          state.inTx = false;
        }
      },
    } as unknown as typeof fake.db;
    return { state, svc: createDbHopeBackend(db, { publish: async () => undefined }) };
  }

  it("the seam call happens outside any transaction", async () => {
    const { state, svc } = trackedBackend();
    const seen: boolean[] = [];
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => {
        seen.push(state.inTx);
        return { organizationId: ORG, patientId: "p-1", admissionAt: null, dischargedAt: null };
      },
    } as never);

    // The scripted database stops the run once the transaction starts reading; the seam has been called by then.
    await svc.recordTimepoint(ORG, USER, ADMISSION, input).catch(() => undefined);

    expect(seen).toEqual([false]);
    expect(state.opened).toBe(1);
  });

  it("a seam answer for another organization is a 404 and no transaction is opened", async () => {
    const { state, svc } = trackedBackend();
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => ({ organizationId: "another-org", patientId: "p-1" }),
    } as never);

    await expect(svc.recordTimepoint(ORG, USER, ADMISSION, input)).rejects.toBeInstanceOf(
      NotFoundError,
    );

    expect(state.opened).toBe(0);
  });

  it("a seam that throws is not swallowed and opens no transaction", async () => {
    const { state, svc } = trackedBackend();
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => {
        throw new Error("seam down");
      },
    } as never);

    await expect(svc.recordTimepoint(ORG, USER, ADMISSION, input)).rejects.toThrow("seam down");

    expect(state.opened).toBe(0);
  });
});

describe("regenerateSchedules answers a count, not the rows", () => {
  it("selects count(*) for the admission, scoped to the tenant, and keeps the answer shape", async () => {
    // No anchor and no discharge: no window to insert.
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => ({
        organizationId: ORG,
        patientId: "p-1",
        providerEntityId: PE,
        locationId: "88888888-8888-4888-8888-888888888888",
        admissionAt: null,
        activatedAt: null,
        dischargedAt: null,
      }),
    } as never);
    // The one write is the run's own `hope.schedules_regenerated` audit event (a no-op run is still recorded), then the count.
    const { svc, ...fake } = backend([[], [{ n: 3 }]]);

    const answer = await svc.regenerateSchedules(ORG, ADMISSION, OPERATOR);

    expect(answer).toEqual({ admissionId: ADMISSION, scheduleCount: 3 });
    const data = dataStatements(fake as Fake);
    expect(data.map((s) => s.kind)).toEqual(["insert", "select"]);
    const count = data[1];
    expect(count?.columns).toEqual(["n"]);
    expect(namesTenant(count as Statement)).toBe(true);
    expect(count?.rendered?.params).toContain(ADMISSION);
  });
});
