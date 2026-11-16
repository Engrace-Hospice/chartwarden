import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import {
  HOPE_SCHEDULES_REGENERATED_EVENT,
  HOPE_SCHEDULE_SKIPPED_EVENT,
  HOPE_SFV_COMPLETION_DENIED_EVENT,
  HOPE_SUBMISSION_CANCELLED_EVENT,
  auditHopeScheduleSkipped,
  auditHopeSchedulesRegenerated,
  auditHopeSfvCompletionDenied,
  auditHopeSubmissionCancelled,
} from "../src/modules/10-hope/hope-operator-audit";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import {
  auditSfvCompletionRefusal,
  isSfvNoTriggerRefusal,
  requireSfvBoundToAdmission,
} from "../src/modules/10-hope/hope-sfv-completion-guards";
import { createSfvCompletionRecorder } from "../src/modules/10-hope/hope-sfv-completion-record";
import { cancelHopeSubmission } from "../src/modules/10-hope/hope-submission-cancel-db";
import { regenerateSchedulesForAdmission } from "../src/modules/10-hope/scheduling/schedule-writer";
import { renderSql, scriptedDb } from "./_hope-g3-fake-db";

// R-08 / audit-trail gaps (no Postgres; the database is scripted): cancel, schedule skip, the admin regenerate and a
// refused SFV completion each write an explicit audit event with the acting membership and the request's session user,
// ids and enums only; a cancel drops the package bytes and the per-record XML in the same transaction as the status flip.
const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "22222222-2222-4222-8222-222222222222";
const SESSION_USER = "33333333-3333-4333-8333-333333333333";
const SUB = "66666666-6666-4666-8666-666666666666";
const SCHEDULE = "55555555-5555-4555-8555-555555555555";
const ADMISSION = "abcdef01-2345-4678-89ab-cdef01234567";
const PE = "77777777-7777-4777-8777-777777777777";
const TRIGGER = "99999999-9999-4999-8999-999999999999";
const SHA = "a".repeat(64);
const REQUEST = {
  requestId: "req-1",
  actorUserId: SESSION_USER,
  sourceIp: "203.0.113.9",
  userAgent: "agent\r\n/2.0",
  correlationId: "client-corr",
};

type AuditRow = Record<string, unknown> & { context: Record<string, unknown> };

/** `scriptedDb` that also records the argument of every `set(...)` and `values(...)`. */
function capturing(outcomes: Parameters<typeof scriptedDb>[0]) {
  const fake = scriptedDb(outcomes);
  const writes: { kind: "update" | "insert"; values: Record<string, unknown> }[] = [];
  const tx = fake.tx as unknown as Record<string, (...a: unknown[]) => Record<string, unknown>>;
  for (const kind of ["update", "insert"] as const) {
    const original = tx[kind] as (...a: unknown[]) => Record<string, unknown>;
    tx[kind] = (...args: unknown[]) => {
      const link = original(...args);
      for (const method of ["set", "values"]) {
        const inner = link[method] as (a?: unknown) => unknown;
        link[method] = (argument?: unknown) => {
          writes.push({ kind, values: argument as Record<string, unknown> });
          return inner(argument);
        };
      }
      return link;
    };
  }
  /** The audit rows written: `audit()` inserts a row that names an `eventType`. */
  const auditRows = (): AuditRow[] =>
    writes.filter((w) => "eventType" in w.values).map((w) => w.values as AuditRow);
  return { ...fake, writes, auditRows };
}

/** The one row `audit()` inserts through a bare fake tx. */
async function written(run: (t: ReturnType<typeof scriptedDb>["tx"]) => Promise<void>) {
  const fake = capturing([[]]);
  await run(fake.tx);
  return fake.auditRows()[0] as AuditRow;
}

const base = { organizationId: ORG, membershipId: MEMBERSHIP, request: REQUEST };

describe("the operator audit writers", () => {
  it("hope.submission_cancelled names the batch, the reason, the prior status and the purged package's hash", async () => {
    const row = await written((t) =>
      auditHopeSubmissionCancelled(t, {
        ...base,
        submissionId: SUB,
        providerEntityId: PE,
        reasonCode: "package_lost",
        priorStatus: "exported",
        packageSha256: SHA,
        itemsCancelled: 3,
        bytesKeptForLegalHold: false,
      }),
    );

    expect(row).toMatchObject({
      organizationId: ORG,
      actorUserId: SESSION_USER,
      actorKind: "user",
      eventType: HOPE_SUBMISSION_CANCELLED_EVENT,
      resourceKind: "hope_submission",
      resourceId: SUB,
      outcome: "success",
      requestId: "req-1",
      sourceIp: "203.0.113.9",
      userAgent: "agent/2.0",
      // The server's own key; the client's correlation id is only a trace hint in the context.
      correlationId: `hope-submission-cancelled:${SUB}`,
    });
    expect(row.context).toEqual({
      providerEntityId: PE,
      reasonCode: "package_lost",
      priorStatus: "exported",
      packageSha256: SHA,
      packageBytesPurged: true,
      bytesKeptForLegalHold: false,
      itemsCancelled: 3,
      byMembershipId: MEMBERSHIP,
      clientCorrelationId: "client-corr",
    });
  });

  it("hope.schedule_skipped names the window and the closed reason code", async () => {
    const row = await written((t) =>
      auditHopeScheduleSkipped(t, {
        ...base,
        scheduleId: SCHEDULE,
        admissionId: ADMISSION,
        rfaKind: "02_huv1",
        skipReasonCode: "other",
      }),
    );

    expect(row).toMatchObject({
      actorUserId: SESSION_USER,
      eventType: HOPE_SCHEDULE_SKIPPED_EVENT,
      resourceKind: "hope_timepoint_schedule",
      resourceId: SCHEDULE,
      outcome: "success",
      correlationId: `hope-schedule-skipped:${SCHEDULE}`,
    });
    expect(row.context).toEqual({
      admissionId: ADMISSION,
      rfaKind: "02_huv1",
      skipReasonCode: "other",
      byMembershipId: MEMBERSHIP,
      clientCorrelationId: "client-corr",
    });
  });

  it("hope.schedules_regenerated names the admission and the windows it created", async () => {
    const row = await written((t) =>
      auditHopeSchedulesRegenerated(t, {
        ...base,
        admissionId: ADMISSION,
        createdScheduleIds: [SCHEDULE],
      }),
    );

    expect(row).toMatchObject({
      eventType: HOPE_SCHEDULES_REGENERATED_EVENT,
      resourceKind: "admission",
      resourceId: ADMISSION,
      outcome: "success",
      correlationId: `hope-schedules-regenerated:${ADMISSION}`,
    });
    expect(row.context).toMatchObject({ createdCount: 1, createdScheduleIds: [SCHEDULE] });
  });

  it("hope.sfv_completion_denied is a denied, warn-severity row with the triggering id only when it is a uuid", async () => {
    const asUuid = await written((t) =>
      auditHopeSfvCompletionDenied(t, {
        ...base,
        admissionId: ADMISSION,
        triggeringAssessmentId: TRIGGER,
      }),
    );
    const notUuid = await written((t) =>
      auditHopeSfvCompletionDenied(t, {
        ...base,
        admissionId: ADMISSION,
        triggeringAssessmentId: null,
      }),
    );

    expect(asUuid).toMatchObject({
      eventType: HOPE_SFV_COMPLETION_DENIED_EVENT,
      outcome: "denied",
      severity: "warn",
      resourceKind: "admission",
      resourceId: ADMISSION,
    });
    expect(asUuid.context).toMatchObject({
      reason: "sfv_not_bound_to_admission",
      triggeringAssessmentId: TRIGGER,
      triggeringAssessmentIdIsUuid: true,
      byMembershipId: MEMBERSHIP,
    });
    expect(notUuid.context).toMatchObject({
      triggeringAssessmentId: null,
      triggeringAssessmentIdIsUuid: false,
    });
  });

  it("leaves the session user empty for a direct service call that has no request", async () => {
    const row = await written((t) =>
      auditHopeScheduleSkipped(t, {
        organizationId: ORG,
        membershipId: MEMBERSHIP,
        scheduleId: SCHEDULE,
        admissionId: ADMISSION,
        rfaKind: "02_huv1",
        skipReasonCode: "other",
      }),
    );

    expect(row.actorUserId).toBeNull();
    expect(row.context).not.toHaveProperty("clientCorrelationId");
  });

  it("carries only uuids, enums, counts and flags: no value in any context is free text", async () => {
    const rows = await Promise.all([
      written((t) =>
        auditHopeSubmissionCancelled(t, {
          ...base,
          submissionId: SUB,
          providerEntityId: PE,
          reasonCode: "other",
          priorStatus: "packaged",
          packageSha256: SHA,
          itemsCancelled: 0,
          bytesKeptForLegalHold: false,
        }),
      ),
      written((t) =>
        auditHopeScheduleSkipped(t, {
          ...base,
          scheduleId: SCHEDULE,
          admissionId: ADMISSION,
          rfaKind: "02_huv1",
          skipReasonCode: "other",
        }),
      ),
    ]);

    const token = /^[A-Za-z0-9_:.-]{1,64}$/;
    for (const row of rows) {
      for (const [key, value] of Object.entries(row.context)) {
        if (key === "clientCorrelationId") continue;
        const items = Array.isArray(value) ? value : [value];
        for (const item of items) {
          if (typeof item === "string") expect(item, key).toMatch(token);
        }
      }
    }
  });
});

describe("cancelHopeSubmission", () => {
  const cancelled = { id: SUB, status: "cancelled" };
  const locked = (status: string) => ({
    id: SUB,
    status,
    providerEntityId: PE,
    packageSha256: SHA,
  });
  const args = {
    id: SUB,
    organizationId: ORG,
    actorMembershipId: MEMBERSHIP,
    reasonCode: "package_lost" as const,
    now: new Date("2026-06-01T00:00:00.000Z"),
    legalHoldScope: { kind: "read" as const, orgWide: false, patientIds: new Set<string>() },
    request: REQUEST,
  };

  it("nulls the package bytes and every item's XML, keeps the hash and size, and records the event on the same transaction", async () => {
    const fake = capturing([
      [locked("exported")],
      [
        { id: "i1", itemStatus: "cancelled" },
        { id: "i2", itemStatus: "cancelled" },
      ],
      [cancelled],
      [],
    ]);

    await cancelHopeSubmission(fake.tx, args);

    const [itemUpdate, batchUpdate] = fake.writes.filter((w) => w.kind === "update");
    expect(itemUpdate?.values).toMatchObject({ iqiesValidationResult: null });
    // Only a pending item flips; any other status is written back as it is (the purge covers EVERY item of the batch).
    expect(renderSql(itemUpdate?.values.itemStatus).sql).toBe(
      `case when "hope_submission_item"."item_status" = 'pending' then 'cancelled' else "hope_submission_item"."item_status" end`,
    );
    expect(batchUpdate?.values).toMatchObject({
      status: "cancelled",
      cancelReasonCode: "package_lost",
      cancelledByMembershipId: MEMBERSHIP,
      acceptanceReport: null,
    });
    // The evidence that a package existed is never touched by the cancel.
    for (const kept of ["packageSha256", "packageSizeBytes", "packageFilename", "envelopeSha256"]) {
      expect(batchUpdate?.values).not.toHaveProperty(kept);
    }
    const [event] = fake.auditRows();
    expect(event).toMatchObject({
      eventType: HOPE_SUBMISSION_CANCELLED_EVENT,
      actorUserId: SESSION_USER,
      resourceId: SUB,
    });
    expect(event?.context).toMatchObject({
      priorStatus: "exported",
      packageSha256: SHA,
      packageBytesPurged: true,
      bytesKeptForLegalHold: false,
      itemsCancelled: 2,
    });
    expect(fake.statements.filter((s) => s.kind !== "execute").map((s) => s.kind)).toEqual([
      "select",
      "update",
      "update",
      "insert",
    ]);
  });

  it("replaying a cancel writes nothing (no second event, no second purge)", async () => {
    const fake = capturing([[locked("cancelled")]]);

    await cancelHopeSubmission(fake.tx, args);

    expect(fake.writes).toEqual([]);
  });

  it("writes no event when the cancel is refused", async () => {
    const fake = capturing([[locked("submitted_pending_result")]]);

    await expect(cancelHopeSubmission(fake.tx, args)).rejects.toMatchObject({
      code: "M10_SUBMISSION_CANCEL_NOT_ALLOWED",
    });

    expect(fake.writes).toEqual([]);
  });
});

describe("the service writes carry the operator into the event", () => {
  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    __resetSeamsForTest();
  });

  function backend(outcomes: Parameters<typeof scriptedDb>[0]) {
    const fake = capturing(outcomes);
    return { ...fake, svc: createDbHopeBackend(fake.db, { publish: async () => undefined }) };
  }

  it("skipSchedule writes hope.schedule_skipped beside the UPDATE, from the membership and request it was given", async () => {
    const row = {
      id: SCHEDULE,
      patientId: SESSION_USER,
      admissionId: ADMISSION,
      rfaKind: "02_huv1",
      status: "skipped",
      windowOpensAt: new Date("2026-06-01T00:00:00.000Z"),
      windowClosesAt: new Date("2026-06-05T00:00:00.000Z"),
      lateDeadlineAt: new Date("2026-06-10T00:00:00.000Z"),
      generatedBy: "system",
      completedByAssessmentId: null,
    };
    const { svc, auditRows, writes } = backend([[row], []]);

    await svc.skipSchedule(ORG, SCHEDULE, "other", { membershipId: MEMBERSHIP, request: REQUEST });

    expect(writes.map((w) => w.kind)).toEqual(["update", "insert"]);
    expect(auditRows()[0]).toMatchObject({
      eventType: HOPE_SCHEDULE_SKIPPED_EVENT,
      actorUserId: SESSION_USER,
      organizationId: ORG,
      resourceId: SCHEDULE,
    });
    expect(auditRows()[0]?.context).toMatchObject({
      byMembershipId: MEMBERSHIP,
      skipReasonCode: "other",
      rfaKind: "02_huv1",
    });
  });

  it("skipSchedule writes no event for a schedule that is not open", async () => {
    const { svc, writes } = backend([[], [{ status: "completed" }]]);

    await expect(
      svc.skipSchedule(ORG, SCHEDULE, "other", { membershipId: MEMBERSHIP }),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(writes.filter((w) => w.kind === "insert")).toEqual([]);
  });

  it("regenerateSchedules records the run even when it creates nothing, on the write's own transaction", async () => {
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
    const { svc, auditRows } = backend([[], [{ n: 0 }]]);

    await svc.regenerateSchedules(ORG, ADMISSION, { membershipId: MEMBERSHIP, request: REQUEST });

    expect(auditRows()[0]).toMatchObject({
      eventType: HOPE_SCHEDULES_REGENERATED_EVENT,
      actorUserId: SESSION_USER,
      resourceId: ADMISSION,
    });
    expect(auditRows()[0]?.context).toMatchObject({ createdCount: 0, byMembershipId: MEMBERSHIP });
  });
});

describe("regenerateSchedulesForAdmission normalises the admission's dates like the consumer", () => {
  const sited =
    (activatedAt: string | null, dischargedAt: string | null = null) =>
    async () => ({
      patientId: "p-1",
      providerEntityId: PE,
      locationId: "88888888-8888-4888-8888-888888888888",
      admissionAt: null,
      activatedAt,
      dischargedAt,
    });
  const windowsFor = async (activatedAt: string) => {
    const fake = capturing([
      [],
      [
        {
          id: SCHEDULE,
          rfaKind: "01_admission",
          windowOpensAt: new Date(),
          windowClosesAt: new Date(),
          lateDeadlineAt: new Date(),
        },
      ],
    ]);
    await regenerateSchedulesForAdmission(
      fake.db,
      { publish: async () => undefined },
      { organizationId: ORG, admissionId: ADMISSION, resolveSiting: sited(activatedAt) },
    );
    const insert = fake.writes.find((w) => w.kind === "insert");
    return JSON.stringify(insert?.values);
  };

  it("an ISO instant plans the same windows as the org-local date it falls on (it used to throw 'Invalid time value')", async () => {
    const fromDate = await windowsFor("2026-06-01");
    const fromInstant = await windowsFor("2026-06-01T20:30:00.000Z");

    expect(fromDate).not.toBe("undefined");
    expect(fromInstant).toBe(fromDate);
  });

  it("an activation date that is neither a date nor an instant is the typed 422, not a raw RangeError", async () => {
    const failure = await windowsFor("not-a-date").catch((e: unknown) => e);

    expect(failure).toMatchObject({ code: "M10_ADMISSION_PROJECTION_GAP", statusCode: 422 });
  });
});

describe("the unbound SFV completion refusal", () => {
  let warn: MockInstance;
  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    __resetSeamsForTest();
  });
  const caller = {
    organizationId: ORG,
    membershipId: MEMBERSHIP,
    admissionId: ADMISSION,
    triggeringAssessmentId: TRIGGER,
  };

  it("isSfvNoTriggerRefusal recognises exactly what requireSfvBoundToAdmission throws", () => {
    const thrown = (() => {
      try {
        requireSfvBoundToAdmission(undefined, "p-1", caller);
      } catch (error) {
        return error;
      }
      return undefined;
    })();

    expect(isSfvNoTriggerRefusal(thrown)).toBe(true);
    expect(isSfvNoTriggerRefusal(new Error("M10_SFV_NO_TRIGGER"))).toBe(false);
  });

  it("writes one denied event with ids only, on its own transaction", async () => {
    const fake = capturing([[]]);

    await auditSfvCompletionRefusal(fake.db, caller, REQUEST);

    expect(fake.auditRows()).toHaveLength(1);
    expect(fake.auditRows()[0]).toMatchObject({
      eventType: HOPE_SFV_COMPLETION_DENIED_EVENT,
      outcome: "denied",
      actorUserId: SESSION_USER,
      organizationId: ORG,
      resourceId: ADMISSION,
    });
    expect(fake.auditRows()[0]?.context).toMatchObject({
      triggeringAssessmentId: TRIGGER,
      byMembershipId: MEMBERSHIP,
    });
  });

  it("records a triggering id that is no uuid as absent, never the client's text", async () => {
    const fake = capturing([[]]);

    await auditSfvCompletionRefusal(
      fake.db,
      { ...caller, triggeringAssessmentId: "Jane Doe 123-45-6789" },
      REQUEST,
    );

    const context = fake.auditRows()[0]?.context;
    expect(context).toMatchObject({ triggeringAssessmentId: null });
    expect(JSON.stringify(fake.auditRows())).not.toContain("Jane");
  });

  it("swallows an audit failure: nothing is thrown and the log carries ids and the error class only", async () => {
    const fake = capturing([new Error("insert failed: secret bound value Jane Doe")]);

    await expect(auditSfvCompletionRefusal(fake.db, caller, REQUEST)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(line).toContain("Error");
    expect(line).toContain(ADMISSION);
    expect(line).not.toContain("Jane");
    expect(line).not.toContain("secret");
  });

  it("recordSfv audits the refusal after the transaction ended, and the caller still gets the same 409", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => ({ organizationId: ORG, patientId: "p-1" }),
    } as never);
    // The locked SFV lookup answers no row (an absent SFV), the refusal rolls back, then the audit insert runs.
    const fake = capturing([[], []]);
    const recordSfv = createSfvCompletionRecorder({
      db: fake.db,
      clock: () => new Date("2026-06-01T00:00:00.000Z"),
      emit: async () => undefined,
      auditDeadlineOverride: async () => undefined,
      toView: (row) => row as never,
    });

    const refusal = await recordSfv(ORG, MEMBERSHIP, ADMISSION, {
      triggeringAssessmentId: TRIGGER,
      targetDate: "2026-06-01T12:00:00.000-07:00",
      authorDiscipline: "RN",
      data: {},
      attestationConfirmed: true,
      request: REQUEST,
    }).catch((e: unknown) => e);

    expect(refusal).toMatchObject({ code: "M10_SFV_NO_TRIGGER", statusCode: 409 });
    expect((refusal as Error).message).toBe(
      `No SFV obligation for triggering assessment ${TRIGGER}.`,
    );
    expect(fake.auditRows()).toHaveLength(1);
    expect(fake.auditRows()[0]).toMatchObject({ eventType: HOPE_SFV_COMPLETION_DENIED_EVENT });
  });

  it("recordSfv still answers the 409 when the audit write fails", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => ({ organizationId: ORG, patientId: "p-1" }),
    } as never);
    const fake = capturing([[], new Error("audit down")]);
    const recordSfv = createSfvCompletionRecorder({
      db: fake.db,
      clock: () => new Date("2026-06-01T00:00:00.000Z"),
      emit: async () => undefined,
      auditDeadlineOverride: async () => undefined,
      toView: (row) => row as never,
    });

    const refusal = await recordSfv(ORG, MEMBERSHIP, ADMISSION, {
      triggeringAssessmentId: TRIGGER,
      targetDate: "2026-06-01T12:00:00.000-07:00",
      authorDiscipline: "RN",
      data: {},
      attestationConfirmed: true,
    }).catch((e: unknown) => e);

    expect(refusal).toMatchObject({ code: "M10_SFV_NO_TRIGGER", statusCode: 409 });
  });
});
