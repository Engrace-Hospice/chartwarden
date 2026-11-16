import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { createDbHopeBackend } from "../src/modules/10-hope/hope-route-service-db";
import type { HopeWriteOutboxPort } from "../src/modules/10-hope/outbox-port";
import { SCRIPT_EXHAUSTED, scriptedDb } from "./_hope-g3-fake-db";

// Group g3: the route service's re-judging after a lock, with the database scripted (no Postgres). Each case stops the
// code under test at a known statement (the script runs out), so what is asserted is the ORDER and the PREDICATE of the
// statements it sent. The same races are written against real Postgres in m10-hope-g3-lock-canonical.live.test.ts.
const ORG = "11111111-1111-4111-8111-111111111111";
const MEMBERSHIP = "33333333-3333-4333-8333-333333333333";
const SOURCE = "ABCDEF01-2345-4678-89AB-CDEF01234567";
const ADMISSION = "FEDCBA98-7654-4321-8FED-CBA987654321";
const SUBMISSION = "55555555-5555-4555-8555-555555555555";

const outcome = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: { code?: string; statusCode?: number; message?: string }) => e,
  );

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  __resetSeamsForTest();
});
const warned = (): string => warn.mock.calls.map((call) => String(call[0])).join("\n");

function backend(outcomes: Parameters<typeof scriptedDb>[0]) {
  const fake = scriptedDb(outcomes);
  const publish = vi.fn(async () => undefined);
  const outbox: HopeWriteOutboxPort = { publish };
  return { ...fake, publish, svc: createDbHopeBackend(fake.db, outbox) };
}

const draftOriginal = {
  id: SOURCE.toLowerCase(),
  status: "draft",
  supersededById: null,
  version: 1,
};

describe("correct / inactivate — the lineage lock comes BEFORE the source record is read and judged", () => {
  const cases = [
    {
      name: "correctTimepoint",
      call: (svc: ReturnType<typeof backend>["svc"]) =>
        svc.correctTimepoint(ORG, MEMBERSHIP, SOURCE, {
          data: {},
          authorDiscipline: "RN",
          correctionReason: "typo",
          targetDate: "2026-06-01T00:00:00.000Z",
        }),
    },
    {
      name: "inactivateTimepoint",
      call: (svc: ReturnType<typeof backend>["svc"]) =>
        svc.inactivateTimepoint(ORG, MEMBERSHIP, SOURCE, {
          reason: "entered in error",
          authorDiscipline: "RN",
        } as never),
    },
  ] as const;

  for (const { name, call } of cases) {
    it(`${name}: takes the advisory lock on the canonical id, then the pending check, then reads the source`, async () => {
      // pending-draft select -> none; source select -> a DRAFT (so the status guard ends the call right there)
      const { svc, statements, indexOf } = backend([[], [draftOriginal]]);

      const failure = await outcome(call(svc));

      expect(failure).toMatchObject({ code: "M10_CORRECTION_TARGET_NOT_SIGNED", statusCode: 409 });
      const lock = indexOf("execute", "pg_advisory_xact_lock");
      const firstSelect = indexOf("select");
      expect(lock).toBeGreaterThan(-1);
      expect(lock).toBeLessThan(firstSelect); // before ANY read of the source (and before the pending check)
      const rendered = statements[lock]?.rendered;
      expect(rendered?.sql).toContain("::uuid)::text"); // the id as Postgres writes it, not as the URL spelled it
      expect(rendered?.params).toEqual([`m10:lineage:${ORG}`, SOURCE, ""]);
      // exactly two reads followed: the pending check, then the source
      expect(statements.filter((s) => s.kind === "select")).toHaveLength(2);
    });

    it(`${name}: a pending operation is refused before the source is even read`, async () => {
      const { svc, statements } = backend([[{ id: "pending-draft" }]]);

      const failure = await outcome(call(svc));

      expect(failure).toMatchObject({ statusCode: 409 });
      expect(String(failure?.message)).toContain("already has a pending regulatory operation");
      expect(statements.filter((s) => s.kind === "select")).toHaveLength(1);
    });

    it(`${name}: a lock timeout answers the typed busy 409 and never reads the source`, async () => {
      const timeout = new Error("Failed query (secret bound value)", {
        cause: Object.assign(new Error("driver"), { code: "55P03" }),
      });
      // The lock is an `execute`, not a scripted chain: reject the advisory lock statement itself.
      const fake = scriptedDb([]);
      const realExecute = fake.tx.execute.bind(fake.tx);
      let executes = 0;
      (fake.tx as unknown as { execute: unknown }).execute = async (statement: unknown) => {
        executes += 1;
        // set_config x2, SET LOCAL lock_timeout, then the advisory lock
        if (executes === 4) throw timeout;
        return realExecute(statement as never);
      };
      const svc = createDbHopeBackend(fake.db, { publish: vi.fn() });

      const failure = await outcome(call(svc));

      expect(failure).toMatchObject({ code: "M10_RECORD_BUSY", statusCode: 409 });
      expect(fake.statements.filter((s) => s.kind === "select")).toHaveLength(0);
      expect(warned()).toContain(`advisory key m10:lineage:${ORG}`);
    });
  }
});

describe("retrySubmission — the UPDATE re-judges the row it waited for", () => {
  const rejectedRow = { id: SUBMISSION, status: "rejected", providerEntityId: "pe", itemCount: 2 };

  it("a second click whose UPDATE matches no row (the first already queued it) is a 409 and emits NOTHING", async () => {
    const { svc, publish, statements } = backend([[rejectedRow], []]);

    const failure = await outcome(svc.retrySubmission(ORG, SUBMISSION));

    expect(failure).toMatchObject({ code: "M10_SUBMISSION_RETRY_NOT_REJECTED", statusCode: 409 });
    expect(publish).not.toHaveBeenCalled();
    // The predicate that makes the zero rows possible: the UPDATE names the status it needs.
    const update = statements.find((s) => s.kind === "update");
    expect(update?.rendered?.sql).toContain('"status"');
    expect(update?.rendered?.params).toContain("rejected");
  });

  it("the first click queues the batch and emits submission_queued exactly once", async () => {
    const queued = { ...rejectedRow, status: "queued" };
    const { svc, publish } = backend([[rejectedRow], [queued]]);

    await svc.retrySubmission(ORG, SUBMISSION).catch(() => undefined);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ eventName: "m10.hope.submission_queued", aggregateId: SUBMISSION }),
    );
  });

  it("a batch that is not rejected is still refused up front, as before", async () => {
    const { svc, publish, statements } = backend([[{ ...rejectedRow, status: "packaged" }]]);

    const failure = await outcome(svc.retrySubmission(ORG, SUBMISSION));

    expect(failure).toMatchObject({ code: "M10_SUBMISSION_RETRY_NOT_REJECTED" });
    expect(statements.some((s) => s.kind === "update")).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("spec initialisation of a legacy draft (workspace open) — the UPDATE re-judges status and spec", () => {
  const legacyDraft = {
    id: "66666666-6666-4666-8666-666666666666",
    status: "draft",
    rfaKind: "01_admission",
    targetDate: new Date("2026-06-01T00:00:00.000Z"),
    specVersionId: null,
    isc: null,
    providerEntityId: null,
    locationId: null,
  };
  const signedNow = { ...legacyDraft, status: "signed", specVersionId: "spec-1", isc: "HA" };
  // resolveVersionForTargetDate, then requireAllowedValue(A0050) and (A0250): an item and an option each.
  const initScript = [
    [{ id: "spec-1", code: "v1" }],
    [{ id: "item-a0050" }],
    [{ id: "opt-1" }],
    [{ id: "item-a0250" }],
    [{ id: "opt-2" }],
  ] as const;

  it("a draft signed (spec frozen) since the unlocked read: the UPDATE matches no row, the row is re-read, and NO control answers are written onto it", async () => {
    const { svc, statements } = backend([[legacyDraft], ...initScript, [], [signedNow]]);

    const failure = await outcome(svc.getAssessmentWorkspace(ORG, legacyDraft.id));

    // The script ran out AFTER the ensure step handed back the signed row (nothing past it was asked for the spec).
    expect(failure?.message).toBe(SCRIPT_EXHAUSTED);
    expect(statements.some((s) => s.kind === "insert")).toBe(false); // writeDerivedControlAnswers inserts
    const update = statements.find((s) => s.kind === "update");
    expect(update?.rendered?.sql).toContain('"status"');
    expect(update?.rendered?.sql).toMatch(/"spec_version_id" is null/i);
    expect(update?.rendered?.sql).toMatch(/"isc" is null/i);
    expect(update?.rendered?.params).toContain("draft");
  });

  it("a missing spec is a 422 that is also LOGGED, with the ids and never the target date", async () => {
    const { svc, statements } = backend([[legacyDraft], []]); // loadA, then no spec version in force

    const failure = await outcome(svc.getAssessmentWorkspace(ORG, legacyDraft.id));

    expect(failure).toMatchObject({ code: "M10_SPEC_NOT_IN_FORCE", statusCode: 422 });
    expect(statements.some((s) => s.kind === "update")).toBe(false);
    expect(warned()).toContain(`assessment ${legacyDraft.id} (org ${ORG})`);
    expect(warned()).toContain("M10_SPEC_NOT_IN_FORCE");
    expect(warned()).not.toContain("2026");
  });
});

describe("recordTimepoint", () => {
  const args = {
    rfaKind: "01_admission" as const,
    targetDate: "2026-06-01T00:00:00.000Z",
    authorDiscipline: "RN",
    data: {},
  };
  const summary = {
    organizationId: ORG,
    admissionId: ADMISSION.toLowerCase(),
    patientId: "44444444-4444-4444-8444-444444444444",
    providerEntityId: null,
    locationId: null,
    admissionAt: "2026-06-01T00:00:00.000Z",
    dischargedAt: null,
  };
  beforeEach(() => {
    registerSeam("AdmissionStatusReader", { getAdmissionSummary: async () => summary } as never);
  });

  it("a missing spec is a 422 that is also LOGGED with the org and admission, never the target date", async () => {
    const { svc } = backend([[]]); // no spec version in force

    const failure = await outcome(svc.recordTimepoint(ORG, MEMBERSHIP, ADMISSION, args));

    expect(failure).toMatchObject({ code: "M10_SPEC_NOT_IN_FORCE", statusCode: 422 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()).toContain(`admission ${ADMISSION} (org ${ORG})`);
    expect(warned()).not.toContain("2026");
  });

  it("takes the one-draft advisory lock on the admission id as Postgres reads it, however the URL spelled it", async () => {
    const { svc, statements, indexOf } = backend([
      [{ id: "spec-1", code: "v1" }],
      [{ id: "item-a0050" }],
      [{ id: "opt-1" }],
      [{ id: "item-a0250" }],
      [{ id: "opt-2" }],
      [], // the schedule lookup: none
    ]); // the existing-draft read that follows the lock is past the script

    const failure = await outcome(svc.recordTimepoint(ORG, MEMBERSHIP, ADMISSION, args));

    expect(failure?.message).toBe(SCRIPT_EXHAUSTED);
    const rendered = statements[indexOf("execute", "pg_advisory_xact_lock")]?.rendered;
    expect(rendered?.sql).toContain("::uuid)::text");
    expect(rendered?.params).toEqual([`m10:record:${ORG}`, ADMISSION, ":01_admission"]);
  });
});

describe("getAssessmentReview — a completed SFV the heal cannot rebuild leaves a trace", () => {
  const specFrozenDraft = {
    id: "77777777-7777-4777-8777-777777777777",
    status: "draft",
    rfaKind: "01_admission",
    specVersionId: "spec-1",
    isc: "HA",
  };
  const completedSfv = {
    id: "sfv-1",
    status: "completed",
    completedAt: new Date("2026-06-02T00:00:00.000Z"),
    completingAssessmentId: "88888888-8888-4888-8888-888888888888",
  };

  it("warns with the assessment id and the reason code only when the completion has no J2053 to rebuild from", async () => {
    const completion = {
      rfaKind: "04_sfv",
      status: "signed",
      data: { J: {} },
      targetDate: new Date("2026-06-02T00:00:00.000Z"),
    };
    const { svc } = backend([[specFrozenDraft], [completedSfv], [completion]]);

    const failure = await outcome(svc.getAssessmentReview(ORG, specFrozenDraft.id));

    expect(failure?.message).toBe(SCRIPT_EXHAUSTED); // the readiness read after the heal is past the script
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()).toContain(`assessment ${specFrozenDraft.id} (org ${ORG})`);
    expect(warned()).toContain("missing_j2053");
  });

  it("stays quiet for the ordinary reasons (no completed SFV)", async () => {
    const { svc } = backend([[specFrozenDraft], []]);

    const failure = await outcome(svc.getAssessmentReview(ORG, specFrozenDraft.id));

    expect(failure?.message).toBe(SCRIPT_EXHAUSTED);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("seam failures the service answers around are logged, not swallowed", () => {
  const PATIENT = "44444444-4444-4444-8444-444444444444";
  const specFrozenDraft = {
    id: "99999999-9999-4999-8999-999999999999",
    status: "draft",
    rfaKind: "01_admission",
    specVersionId: "spec-1",
    isc: "HA",
    patientId: PATIENT,
    admissionId: ADMISSION.toLowerCase(),
  };
  const down = (name: string) => async () => {
    throw Object.assign(new Error("connection string with a secret"), { name });
  };

  it("sign: an M9 outage (no D8 snapshot) and an M6 outage (no siting) each leave one line with the class, never the message", async () => {
    registerSeam("LatestAssessmentProvider", { latestBatch: down("M9DownError") } as never);
    registerSeam("AdmissionStatusReader", { getAdmissionSummary: down("M6DownError") } as never);
    const { svc } = backend([[specFrozenDraft]]); // the write transaction's lock read is past the script

    const failure = await outcome(
      svc.signTimepoint(ORG, MEMBERSHIP, specFrozenDraft.id, { attestationConfirmed: true }),
    );

    expect(failure?.message).toBe(SCRIPT_EXHAUSTED);
    expect(warned()).toMatch(
      new RegExp(`M9DownError reading the D8 snapshot for patient ${PATIENT}`),
    );
    expect(warned()).toContain(
      `M6DownError resolving the siting of admission ${ADMISSION.toLowerCase()}`,
    );
    expect(warned()).not.toContain("secret");
  });

  it("workflow state: an admission the seam cannot read is answered without it, and says why", async () => {
    registerSeam("AdmissionStatusReader", { getAdmissionSummary: down("M6DownError") } as never);
    const { svc } = backend([]);

    const failure = await outcome(svc.getWorkflowState(ORG, ADMISSION.toLowerCase()));

    expect(failure?.message).toBe(SCRIPT_EXHAUSTED); // the schedule read that follows is past the script
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()).toContain(
      `M6DownError reading admission ${ADMISSION.toLowerCase()} (org ${ORG})`,
    );
    expect(warned()).not.toContain("secret");
  });
});
