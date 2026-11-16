import type { DbClient } from "@chartwarden/db";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  type HopeSfvService,
  createHopeSfvService,
  deriveHopeJ2051TriggerState,
  hopeSfvDueAtFromJ2050B,
} from "../src/modules/10-hope/hope-sfv-service";
import { openOrOverdueSfvsForOrg, updateSfvStatus } from "../src/modules/10-hope/jobs/cron-store";

function answers(values: Record<string, string | number>) {
  return new Map(
    Object.entries(values).map(([itemCode, value]) => [
      itemCode,
      { state: "answered" as const, value },
    ]),
  );
}

describe("HOPE SFV canonical J2051 trigger", () => {
  it("treats moderate or severe J2051 as a definitive SFV trigger", () => {
    expect(
      deriveHopeJ2051TriggerState(answers({ J2050A: "1", J2050B: "2025-10-01", J2051A: "2" })),
    ).toMatchObject({
      state: "true",
      triggerFired: true,
      maxSeverity: "moderate",
      symptomImpactDate: "2025-10-01",
    });
    expect(deriveHopeJ2051TriggerState(answers({ J2050A: "1", J2051H: "3" }))).toMatchObject({
      state: "true",
      triggerFired: true,
      maxSeverity: "severe",
    });
  });

  it("treats numeric moderate or severe J2051 values as definitive SFV triggers", () => {
    expect(
      deriveHopeJ2051TriggerState(answers({ J2050A: 1, J2050B: "2026-09-09", J2051A: 2 })),
    ).toMatchObject({
      state: "true",
      triggerFired: true,
      maxSeverity: "moderate",
      symptomImpactDate: "2026-09-09",
    });
    expect(deriveHopeJ2051TriggerState(answers({ J2050A: 1, J2051H: 3 }))).toMatchObject({
      state: "true",
      triggerFired: true,
      maxSeverity: "severe",
    });
  });

  it("treats a complete 0/1/9 set as definitively false without treating 9 as skipped", () => {
    const values = Object.fromEntries(
      ["A", "B", "C", "D", "E", "F", "G", "H"].map((suffix) => [
        `J2051${suffix}`,
        suffix === "H" ? "9" : "1",
      ]),
    );

    expect(deriveHopeJ2051TriggerState(answers({ J2050A: "1", ...values }))).toMatchObject({
      state: "false",
      triggerFired: false,
      maxSeverity: "mild",
    });
  });

  it("does not convert incomplete J2051 answers into a false trigger", () => {
    expect(deriveHopeJ2051TriggerState(answers({ J2050A: "1", J2051A: "1" }))).toMatchObject({
      state: "pending",
      triggerFired: false,
      maxSeverity: "mild",
    });
  });

  it("uses J2050A=0 as a definitive no-SFV branch", () => {
    expect(deriveHopeJ2051TriggerState(answers({ J2050A: "0" }))).toMatchObject({
      state: "false",
      triggerFired: false,
      maxSeverity: "none",
    });
  });

  it("derives the operational due date from J2050B plus two calendar days", () => {
    expect(hopeSfvDueAtFromJ2050B("2025-10-01").toISOString()).toBe("2025-10-03T23:59:59.999Z");
  });
});

// R-02 — what the LIVE clock does today, pinned so a change is a conscious one. The anchor is the
// clinician-entered J2050B screening date (NOT the visit date, NOT the signature time) and the due
// instant is the end of the 2nd calendar day AFTER it, computed in UTC. ADR-0018 D1 says the visit/
// assessment date in org-local time; whether J2050B or the visit date, and UTC or org-local, is the
// open compliance question (CMS-VERIFY). The invariant ADR-0018 D1 protects (signing never extends
// the deadline) holds either way and is what the first group below guards.
type ReconcileInput = Parameters<HopeSfvService["reconcileTriggeringAssessment"]>[0];

const SFV_ANSWERS = answers({ J2050A: "1", J2050B: "2025-10-01", J2051A: "2" });
const NOW_SAME_DAY = new Date("2025-10-01T15:00:00.000Z");
const NOW_LATE_SIGNING = new Date("2025-10-20T03:30:00.000Z");

interface InsertedSfv {
  readonly dueAt: Date;
  readonly triggeredAt: Date;
}

/** A just-enough fake tx: no existing SFV row; records the one the service inserts. */
function fakeTxWithoutSfv(inserted: InsertedSfv[]): DbClient {
  return {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    insert: () => ({
      values: (row: InsertedSfv) => {
        inserted.push(row);
        return { returning: async () => [{ id: "sfv-1" }] };
      },
    }),
  } as unknown as DbClient;
}

/** A fake tx where the SFV already exists (open) with the given due date; records any update. */
function fakeTxWithOpenSfv(existingDueAt: Date, updates: unknown[]): DbClient {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: "sfv-1", status: "open", dueAt: existingDueAt }],
        }),
      }),
    }),
    update: () => ({
      set: (patch: unknown) => {
        updates.push(patch);
        return { where: () => ({ returning: async () => [{ id: "sfv-1" }] }) };
      },
    }),
  } as unknown as DbClient;
}

interface RecordedWrite {
  readonly patch: Record<string, unknown>;
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * A fake tx that models a LOST RACE: the SFV was read as `readStatus`, but by the time the service writes,
 * another transaction has completed it, so a status-guarded UPDATE matches no row (`returning` is empty).
 * Each write's WHERE is rendered to SQL so a test can assert the status predicate is really there: an
 * unguarded `WHERE id = $1` would have overwritten the completed row.
 */
function fakeTxLosingRace(
  readStatus: string,
  existingDueAt: Date,
  writes: RecordedWrite[],
): DbClient {
  const dialect = new PgDialect();
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ id: "sfv-1", status: readStatus, dueAt: existingDueAt }],
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (condition: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          const { sql, params } = dialect.sqlToQuery(condition);
          writes.push({ patch, sql, params });
          return { returning: async () => [] };
        },
      }),
    }),
  } as unknown as DbClient;
}

function admissionHuAssessment(signedAt: Date | null): ReconcileInput["assessment"] {
  return {
    id: "assessment-1",
    rfaKind: "01_admission",
    providerEntityId: "provider-1",
    locationId: "location-1",
    patientId: "patient-1",
    admissionId: "admission-1",
    signedAt,
  } as unknown as ReconcileInput["assessment"];
}

describe("HOPE SFV due date is independent of signing time", () => {
  it("does not move the due date when the assessment is signed later", async () => {
    const dueAtByNow: Date[] = [];
    for (const [now, signedAt] of [
      [NOW_SAME_DAY, new Date("2025-10-01T15:00:00.000Z")],
      [NOW_LATE_SIGNING, new Date("2025-10-20T03:30:00.000Z")],
    ] as const) {
      const inserted: InsertedSfv[] = [];
      await createHopeSfvService().reconcileTriggeringAssessment({
        tx: fakeTxWithoutSfv(inserted),
        organizationId: "org-1",
        assessment: admissionHuAssessment(signedAt),
        isc: "HA",
        answers: SFV_ANSWERS,
        now,
      });
      expect(inserted).toHaveLength(1);
      expect(inserted[0]?.triggeredAt).toEqual(now);
      dueAtByNow.push(inserted[0]?.dueAt as Date);
    }

    expect(dueAtByNow.map((d) => d.toISOString())).toEqual([
      "2025-10-03T23:59:59.999Z",
      "2025-10-03T23:59:59.999Z",
    ]);
  });

  it("does not move an existing due date when the assessment is re-reconciled at a later time", async () => {
    const updates: unknown[] = [];

    const result = await createHopeSfvService().reconcileTriggeringAssessment({
      tx: fakeTxWithOpenSfv(hopeSfvDueAtFromJ2050B("2025-10-01"), updates),
      organizationId: "org-1",
      assessment: admissionHuAssessment(NOW_LATE_SIGNING),
      isc: "HA",
      answers: SFV_ANSWERS,
      now: NOW_LATE_SIGNING,
    });

    expect(result).toMatchObject({ sfvId: "sfv-1", action: "none" });
    expect(updates).toEqual([]);
  });

  it("moves the due date only when the J2050B answer itself changes", async () => {
    const updates: { dueAt?: Date }[] = [];

    const result = await createHopeSfvService().reconcileTriggeringAssessment({
      tx: fakeTxWithOpenSfv(hopeSfvDueAtFromJ2050B("2025-10-01"), updates),
      organizationId: "org-1",
      assessment: admissionHuAssessment(null),
      isc: "HA",
      answers: answers({ J2050A: "1", J2050B: "2025-10-02", J2051A: "2" }),
      now: NOW_SAME_DAY,
    });

    expect(result.action).toBe("updated_due_at");
    expect(updates[0]?.dueAt?.toISOString()).toBe("2025-10-04T23:59:59.999Z");
  });

  it("returns the same due date whatever the system clock says", () => {
    const before = hopeSfvDueAtFromJ2050B("2025-10-01").toISOString();

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-01T00:00:00.000Z"));
      expect(hopeSfvDueAtFromJ2050B("2025-10-01").toISOString()).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HOPE SFV due date current basis: UTC end of the 2nd day after J2050B (CMS-VERIFY)", () => {
  it("is the UTC end of day, not the org-local end of day (an org-local change must update this test)", () => {
    // 23:59:59.999 UTC. For a Pacific org (UTC-7 in October) the org-local end of 2025-10-03 would
    // be 2025-10-04T06:59:59.999Z, the ADR-0018 D1 shape the in-memory planner already produces.
    const dueAt = hopeSfvDueAtFromJ2050B("2025-10-01");

    expect(dueAt.toISOString()).toBe("2025-10-03T23:59:59.999Z");
  });

  it.each([
    ["2025-10-30", "2025-11-01T23:59:59.999Z"],
    ["2025-12-30", "2026-01-01T23:59:59.999Z"],
    ["2024-02-28", "2024-03-01T23:59:59.999Z"],
  ])("rolls J2050B %s over month, year and leap-day boundaries to %s", (j2050b, expected) => {
    expect(hopeSfvDueAtFromJ2050B(j2050b).toISOString()).toBe(expected);
  });

  it("rejects a J2050B value that is not a calendar date", () => {
    expect(() => hopeSfvDueAtFromJ2050B("not-a-date")).toThrow(/Invalid HOPE J2050B date/);
  });
});

// The writers that decay or reconcile an SFV carry no lock on it, so each can hold a STALE status. A
// write keyed on the id alone would then overwrite a completion that committed in between (an RFA-04 the
// clinician signed, silently reverted to `withdrawn`/`overdue`/`missed`). Every such UPDATE must carry the
// status it read, and a miss is a benign lost race, not an error.
describe("HOPE SFV status writers never overwrite a SFV that completed in the meantime", () => {
  const STALE_DUE = hopeSfvDueAtFromJ2050B("2025-10-01");
  const reconcile = (tx: DbClient, over: Partial<ReconcileInput> = {}) =>
    createHopeSfvService().reconcileTriggeringAssessment({
      tx,
      organizationId: "org-1",
      assessment: admissionHuAssessment(null),
      isc: "HA",
      answers: SFV_ANSWERS,
      now: NOW_SAME_DAY,
      ...over,
    });

  // The operational statuses a clinician-facing edit may follow: the cron tick flips `open` -> `overdue` with no
  // lock, so a write that read `open` can meet an `overdue` row (and a write that read `overdue` an `open` one is
  // impossible, but the guard is symmetric anyway). A write guarded on the exact status it read would answer `none`
  // there and leave the SFV overdue (it can then decay to `missed`), so the guard is the status FAMILY.
  const OPERATIONAL = ["open", "overdue"] as const;
  it.each([
    [
      "withdraws an open SFV (the trigger no longer fires)",
      "open",
      answers({ J2050A: "0" }),
      OPERATIONAL,
    ],
    [
      "withdraws an overdue SFV (the trigger no longer fires)",
      "overdue",
      answers({ J2050A: "0" }),
      OPERATIONAL,
    ],
    ["reopens a withdrawn SFV", "withdrawn", SFV_ANSWERS, ["withdrawn"]],
    [
      "moves the due date of an open SFV",
      "open",
      answers({ J2050A: "1", J2050B: "2025-10-02", J2051A: "2" }),
      OPERATIONAL,
    ],
    [
      "moves the due date of an overdue SFV",
      "overdue",
      answers({ J2050A: "1", J2050B: "2025-10-02", J2051A: "2" }),
      OPERATIONAL,
    ],
  ])(
    "reconcile %s only while the SFV is still in the status family it read",
    async (_label, status, input, family) => {
      const writes: RecordedWrite[] = [];

      const result = await reconcile(fakeTxLosingRace(status, STALE_DUE, writes), {
        answers: input,
      });

      expect(writes).toHaveLength(1);
      // The guard names the whole family the write may legitimately start from, and never a terminal status.
      expect(writes[0]?.sql).toMatch(/"status" in \(\$\d+(, \$\d+)*\)/);
      expect(
        writes[0]?.params.filter((p) => typeof p === "string" && p !== "sfv-1" && p !== "org-1"),
      ).toEqual([...family]);
      // ... and names the tenant beside the id, on top of RLS.
      expect(writes[0]?.sql).toMatch(/"organization_id" = \$\d+/);
      expect(writes[0]?.params).toContain("org-1");
      // The race was lost: nothing changed, so nothing is reported as changed (and nothing throws).
      expect(result).toMatchObject({ sfvId: "sfv-1", action: "none" });
    },
  );

  it("the watchdog's status flip is keyed on the EXACT status it planned from, and reports a lost race as false", async () => {
    // Two overlapping ticks can both plan open -> overdue from the same snapshot. A guard on the status FAMILY
    // (open|overdue) would let the second one match the row the first just flipped and republish `sfv_overdue`.
    const writes: RecordedWrite[] = [];
    const tx = fakeTxLosingRace("open", STALE_DUE, writes);

    await expect(
      updateSfvStatus(tx, {
        organizationId: "org-1",
        sfvId: "sfv-1",
        from: "open",
        to: "overdue",
        snapshotDueAt: STALE_DUE.toISOString(),
      }),
    ).resolves.toBe(false);

    expect(writes[0]?.sql).toMatch(/"status" = \$\d+/);
    expect(writes[0]?.sql).not.toMatch(/"status" in/);
    expect(writes[0]?.params).toContain("open");
    expect(writes[0]?.params).not.toContain("completed");
  });

  it.each([
    ["open", "overdue"],
    ["overdue", "missed"],
  ] as const)(
    "the flip %s -> %s only matches a row still in its planned status",
    async (from, to) => {
      const writes: RecordedWrite[] = [];

      await updateSfvStatus(fakeTxLosingRace(from, STALE_DUE, writes), {
        organizationId: "org-1",
        sfvId: "sfv-1",
        from,
        to,
        snapshotDueAt: STALE_DUE.toISOString(),
      });

      // The guard names the planned `from`; the new status is only the SET value.
      expect(writes[0]?.params.filter((p) => p === from)).toHaveLength(1);
      expect(writes[0]?.patch.status).toBe(to);
    },
  );

  it("the watchdog's status flip names the tenant beside the id, on top of RLS", async () => {
    const writes: RecordedWrite[] = [];

    await updateSfvStatus(fakeTxLosingRace("open", STALE_DUE, writes), {
      organizationId: "org-9",
      sfvId: "sfv-1",
      from: "open",
      to: "overdue",
      snapshotDueAt: STALE_DUE.toISOString(),
    });

    expect(writes[0]?.sql).toMatch(/"symptom_follow_up_visit"\."organization_id" = \$\d+/);
    expect(writes[0]?.params).toContain("org-9");
  });

  it("the watchdog's status flip is also keyed on the due date its decision was planned from", async () => {
    // A reconcile can move `due_at` later between the watchdog's snapshot and its UPDATE. Judged against
    // the snapshot's due date the SFV is overdue; against the moved one it is not, so the flip must miss.
    const writes: RecordedWrite[] = [];
    const tx = fakeTxLosingRace("open", STALE_DUE, writes);

    await updateSfvStatus(tx, {
      organizationId: "org-1",
      sfvId: "sfv-1",
      from: "open",
      to: "overdue",
      snapshotDueAt: STALE_DUE.toISOString(),
    });

    expect(writes[0]?.sql).toMatch(
      /date_trunc\('milliseconds', "symptom_follow_up_visit"\."due_at"\) = \$\d+::timestamptz/,
    );
    expect(writes[0]?.params).toContain(STALE_DUE.toISOString());
  });
});

describe("the SFV watchdog's snapshot read", () => {
  it("orders its rows by id, so concurrent ticks flip (and lock) SFV rows in one order", async () => {
    // Two overlapping watchdog ticks that each lock rows in a different order can deadlock against each other
    // and against `recordSfv` / `patchAnswers`; a fixed order makes the lock acquisition order identical.
    const dialect = new PgDialect();
    const ordering: string[] = [];
    const rows = [
      {
        id: "sfv-1",
        patientId: "p-1",
        triggeringAssessmentId: "a-1",
        admissionId: "adm-1",
        status: "open",
        dueAt: new Date("2025-10-03T23:59:59.999Z"),
      },
    ];
    const tx = {
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: () => ({
              orderBy: async (...order: Parameters<typeof dialect.sqlToQuery>[0][]) => {
                ordering.push(...order.map((o) => dialect.sqlToQuery(o).sql));
                return rows;
              },
            }),
          }),
        }),
      }),
    } as unknown as DbClient;

    const snapshot = await openOrOverdueSfvsForOrg(tx, "org-1");

    expect(ordering).toEqual(['"symptom_follow_up_visit"."id" asc']);
    expect(snapshot.map((s) => s.sfvId)).toEqual(["sfv-1"]);
  });
});
