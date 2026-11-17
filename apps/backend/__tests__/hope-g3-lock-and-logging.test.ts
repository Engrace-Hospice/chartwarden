import type { DbClient } from "@chartwarden/db";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import { buildHopeAbacPredicates } from "../src/modules/10-hope/abac-predicates";
import {
  lockAssessmentRow,
  lockRecordKey,
  mapLockTimeoutToBusy,
  takeBoundedLock,
} from "../src/modules/10-hope/hope-assessment-lock";
import { idForLog } from "../src/modules/10-hope/hope-log-id";
import {
  HopeSpecNotFoundForTargetDateError,
  HopeSpecVersionOverlapError,
  logSpecNotInForce,
} from "../src/modules/10-hope/hope-spec-registry";
import { scriptedDb } from "./_hope-g3-fake-db";

// Group g3: the lock helpers' canonical advisory key, the M10_RECORD_BUSY wording and its operator log line, the
// spec-not-in-force log line, and hope.scope's admission-seam log line. No database: the real waits and the real
// Postgres uuid parsing are proven live in m10-hope-g3-lock-canonical.live.test.ts.
const ORG = "11111111-1111-4111-8111-111111111111";
const ASSESSMENT = "22222222-2222-4222-8222-222222222222";
const ADMISSION = "abcdef01-2345-4678-89ab-cdef01234567";

/** The exact text the platform, spec 4.4, CHANGES.md and the OpenAPI enrichments all carry. */
const BUSY_MESSAGE =
  "The record is busy. This step was not applied (an earlier step of the same request may have been); check the current state, then send the request again.";

const pgFailure = (code: string): Error =>
  new Error("Failed query: select ... (secret bound value)", {
    cause: Object.assign(new Error("driver message"), { code }),
  });

let warn: MockInstance;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  __resetSeamsForTest();
});

const warned = (): string => warn.mock.calls.map((call) => String(call[0])).join("\n");

describe("lockRecordKey — the id goes through Postgres's uuid parser, never the caller's spelling", () => {
  it("builds the key in SQL from `$id::uuid` text so every spelling of one id hashes to one key", async () => {
    const upper = scriptedDb([]);
    const braced = scriptedDb([]);

    await lockRecordKey(upper.tx, `m10:record:${ORG}`, ADMISSION.toUpperCase(), ":01_admission");
    await lockRecordKey(braced.tx, `m10:record:${ORG}`, `{${ADMISSION}}`, ":01_admission");

    const lock = (db: typeof upper) =>
      db.statements.find((s) => s.rendered?.sql.includes("pg_advisory_xact_lock"));
    for (const [db, spelling] of [
      [upper, ADMISSION.toUpperCase()],
      [braced, `{${ADMISSION}}`],
    ] as const) {
      const rendered = lock(db)?.rendered;
      // The id is a bound parameter read by `::uuid` and written back with `::text`: Postgres, not JavaScript, spells it.
      expect(rendered?.sql).toContain("::uuid)::text");
      expect(rendered?.params).toEqual([`m10:record:${ORG}`, spelling, ":01_admission"]);
      // ... and the key text is never assembled in JavaScript from the raw id.
      expect(rendered?.params.join("")).not.toContain(`${ORG}:${spelling}`);
    }
  });

  it("without an id the key is the scope as given, under the same bound", async () => {
    const { tx, statements } = scriptedDb([]);

    await lockRecordKey(tx, "m10:record:k");

    expect(statements[0]?.rendered?.sql).toContain("lock_timeout");
    expect(statements[1]?.rendered?.sql).toContain("pg_advisory_xact_lock");
    expect(statements[1]?.rendered?.sql).not.toContain("::uuid");
    expect(statements[1]?.rendered?.params).toEqual(["m10:record:k"]);
  });

  it("answers the typed busy 409 on a timeout and logs the lock kind and the id, not the driver text", async () => {
    const tx = {
      execute: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(pgFailure("55P03")),
    } as unknown as DbClient;

    const failure = await lockRecordKey(tx, `m10:lineage:${ORG}`, ASSESSMENT).catch(
      (e: unknown) => e,
    );

    expect(failure).toMatchObject({ code: "M10_RECORD_BUSY", statusCode: 409 });
    expect(warned()).toContain(`advisory key m10:lineage:${ORG} ${ASSESSMENT}`);
    expect(warned()).not.toContain("secret bound value");
  });
});

describe("M10_RECORD_BUSY — wording and operator trace", () => {
  it("says the step was NOT APPLIED and never claims nothing was saved (an earlier step may have committed)", async () => {
    const { tx } = scriptedDb([pgFailure("55P03")]);

    const failure = (await lockAssessmentRow(tx, ORG, ASSESSMENT).catch(
      (e: unknown) => e,
    )) as Error;

    expect(failure.message).toBe(BUSY_MESSAGE);
    expect(failure.message).not.toMatch(/nothing was saved|nothing was written/i);
  });

  it("logs ONE warn per timeout naming the lock kind and ids, never the driver message or bound values", async () => {
    const { tx } = scriptedDb([pgFailure("55P03")]);

    await lockAssessmentRow(tx, ORG, ASSESSMENT).catch(() => undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()).toContain(`assessment row ${ASSESSMENT} (org ${ORG})`);
    expect(warned()).toContain("M10_RECORD_BUSY");
    expect(warned()).not.toContain("secret bound value");
    expect(warned()).not.toContain("driver message");
  });

  it("uses the caller's label for a direct takeBoundedLock, and masks an id that is not a uuid", async () => {
    const { tx } = scriptedDb([]);

    await takeBoundedLock(
      tx,
      async () => {
        throw pgFailure("55P03");
      },
      { lock: `submission row ${idForLog("not-a-uuid'; DROP TABLE x")}` },
    ).catch(() => undefined);

    expect(warned()).toContain("submission row [not-a-uuid]");
    expect(warned()).not.toContain("DROP TABLE");
  });

  it("logs a timeout raised by a LATER statement of the transaction once, and does not log it twice when a helper already mapped it", async () => {
    const later = {
      transaction: vi.fn(async () => {
        throw pgFailure("55P03");
      }),
    };
    const mapped = await mapLockTimeoutToBusy(later as unknown as DbClient)
      .transaction(async () => undefined)
      .catch((e: unknown) => e as Error);
    expect(mapped?.message).toBe(BUSY_MESSAGE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()).toContain(
      "a statement of the transaction that took no lock helper of its own",
    );

    warn.mockClear();
    const { tx } = scriptedDb([pgFailure("55P03")]);
    const already = await mapLockTimeoutToBusy({
      transaction: async () => lockAssessmentRow(tx, ORG, ASSESSMENT),
    } as unknown as DbClient)
      .transaction(async () => undefined)
      .catch((e: unknown) => e as Error);
    expect(already?.message).toBe(BUSY_MESSAGE);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("logSpecNotInForce — a missing spec is a 4xx the error handler logs at info, so it is logged here", () => {
  it("warns once with the subject and the code, never the target date, and rethrows the same error", async () => {
    const error = new HopeSpecNotFoundForTargetDateError("2031-07-04");

    const thrown = await logSpecNotInForce(`assessment ${ASSESSMENT} (org ${ORG})`, async () => {
      throw error;
    }).catch((e: unknown) => e);

    expect(thrown).toBe(error);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()).toContain(`assessment ${ASSESSMENT} (org ${ORG})`);
    expect(warned()).toContain("M10_SPEC_NOT_IN_FORCE");
    expect(warned()).not.toContain("2031");
  });

  it("is silent on success and for every other failure (the overlap fault is already a logged 500)", async () => {
    await expect(logSpecNotInForce("x", async () => 7)).resolves.toBe(7);
    const overlap = new HopeSpecVersionOverlapError("2031-07-04");
    await expect(
      logSpecNotInForce("x", async () => {
        throw overlap;
      }),
    ).rejects.toBe(overlap);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("hope.scope — the admission seam's failure leaves a trace and still fails closed", () => {
  const resolver = {
    loadAssessment: async () => null,
    loadSchedule: async () => null,
    loadSfv: async () => null,
    loadSubmission: async () => null,
  };
  const context = {
    organizationId: ORG,
    userId: "33333333-3333-4333-8333-333333333333",
    roles: ["rn"],
    providerEntityIds: [],
    attributes: {},
  } as never;

  it("denies, and logs a warn with the org, the admission and the error CLASS (not its message)", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => {
        throw Object.assign(new Error("connection string with a secret"), {
          name: "SeamDownError",
        });
      },
    } as never);
    const scope = buildHopeAbacPredicates({ resolver, isInCaseload: async () => true })[
      "hope.scope"
    ];

    await expect(scope?.(context, { admissionId: ADMISSION })).resolves.toBe(false);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warned()).toContain(`admission ${ADMISSION} (org ${ORG})`);
    expect(warned()).toContain("SeamDownError");
    expect(warned()).not.toContain("secret");
  });

  it("does not log when the seam answers (a cross-tenant answer is a plain denial)", async () => {
    registerSeam("AdmissionStatusReader", {
      getAdmissionSummary: async () => ({ organizationId: "other-org", patientId: "p" }),
    } as never);
    const scope = buildHopeAbacPredicates({ resolver, isInCaseload: async () => true })[
      "hope.scope"
    ];

    await expect(scope?.(context, { admissionId: ADMISSION })).resolves.toBe(false);

    expect(warn).not.toHaveBeenCalled();
  });
});
