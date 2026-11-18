// apps/backend/__tests__/note-closure-sweep.test.ts — the visit-note closure ALERT sweep (ADR-0113 D5).
//
// The `encounter.attention` cron now emits `m8.encounter.closure_at_risk | closure_overdue | closure_escalated`. These tests cover
// (1) the pure plan: which notes alert at which stage (no time window), the off/warn/block modes, the true-stage rule and the
// inactive-author rule; (2) every emitted
// payload against the REAL alert-payload registry (never a no-op validator) and through the REAL emitter + seeded alert rules
// to the right recipients; (3) the per-org fan-out (isolation, per-alert isolation, the batched "already alerted?" pre-filter,
// aggregate failure); (4) the SQL the adapter issues (no overdue predicate, no legacy clockless draft); (5) the cron wiring. No
// database is touched.
import { type DbClient, createDbClient } from "@chartwarden/db";
import {
  type AlertEmitter,
  createAlertPayloadRegistry,
  createInMemoryAlertEmitter,
} from "@chartwarden/messaging";
import { M8_CLOSURE_ALERT_PAYLOADS } from "@chartwarden/types";
import { Value } from "@sinclair/typebox/value";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLOSURE_ALERT_DEEP_LINK,
  type ClosureSweepNote,
  type OrgClosureScan,
  planClosureAlerts,
  runNoteClosureSweep,
} from "../src/modules/08-encounters/closure/closure-sweep";
import type { ClosurePolicy } from "../src/modules/08-encounters/closure/policy-service";
import { runEncounterAttentionCron } from "../src/modules/08-encounters/jobs/cron-workers";
import type { M8WorkerDeps } from "../src/modules/08-encounters/jobs/cron-workers";

const MS_PER_HOUR = 3_600_000;
const MS_PER_MINUTE = 60_000;
const TICK_MS = 15 * MS_PER_MINUTE;
const ORG_A = "00000000-0000-4000-8000-0000000000a1";
const ORG_B = "00000000-0000-4000-8000-0000000000a2";
const ORG_C = "00000000-0000-4000-8000-0000000000a3";
const ENCOUNTER = "00000000-0000-4000-8000-0000000000e1";
const AUTHOR_USER = "00000000-0000-4000-8000-0000000000b1";
const SUPERVISOR_USER = "00000000-0000-4000-8000-0000000000b2";
const OTHER_SUPERVISOR_USER = "00000000-0000-4000-8000-0000000000b3";
const PROVIDER_ENTITY = "00000000-0000-4000-8000-0000000000d1";
const CLOCK_START = new Date("2026-03-10T12:00:00.000Z");

const WARN_24: ClosurePolicy = { mode: "warn", thresholdHours: 24, enforceFrom: null };

const hoursAfterStart = (hours: number): Date =>
  new Date(CLOCK_START.getTime() + hours * MS_PER_HOUR);

function note(overrides: Partial<ClosureSweepNote> = {}): ClosureSweepNote {
  return {
    encounterId: ENCOUNTER,
    clockStartedAt: CLOCK_START,
    authorUserId: AUTHOR_USER,
    providerEntityId: PROVIDER_ENTITY,
    ...overrides,
  };
}

/** The sweep's plan for one fixture note `elapsedHours` after its clock started. */
const planAt = (elapsedHours: number, policy: ClosurePolicy = WARN_24, n = note()) =>
  planClosureAlerts([n], policy, hoursAfterStart(elapsedHours));

describe("planClosureAlerts: which notes alert at which stage", () => {
  it("raises nothing before T-6h (17.99h)", () => {
    expect(planAt(0)).toEqual([]);
    expect(planAt(17.99)).toEqual([]);
  });

  it.each([
    [18, "at_risk", "info"],
    [19.5, "at_risk", "info"],
    [24, "overdue", "warn"],
    [25.5, "overdue", "warn"],
    [36, "escalated", "warn"],
    [37.5, "escalated", "warn"],
  ] as const)("at %sh it raises exactly one %s alert (%s)", (elapsed, stage, severity) => {
    const plan = planAt(elapsed);

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      eventType: `m8.encounter.closure_${stage}`,
      severity,
      correlationId: `m8:closure:visit_note:${ENCOUNTER}:${stage}`,
    });
    expect(plan[0]?.payload.stage).toBe(stage);
  });

  it("emits only the CURRENT stage, never the earlier ones it already passed", () => {
    expect(planAt(25).map((a) => a.payload.stage)).toEqual(["overdue"]);
    expect(planAt(36.5).map((a) => a.payload.stage)).toEqual(["escalated"]);
  });

  it("has NO time window: a stage that began long ago is still planned (the already-alerted filter, not a lookback, keeps it quiet)", () => {
    // a worker outage, a late EVV instant or a lowered threshold can all make a stage old by the time it is first seen
    expect(planAt(18 + 3).map((a) => a.payload.stage)).toEqual(["at_risk"]);
    expect(planAt(24 + 3).map((a) => a.payload.stage)).toEqual(["overdue"]);
    expect(planAt(36 + 3).map((a) => a.payload.stage)).toEqual(["escalated"]);
    expect(planAt(1000).map((a) => a.payload.stage)).toEqual(["escalated"]); // a note escalated long ago, never alerted
  });

  it("plans a lowered threshold's stage at once: a note 30h old under a new 24h threshold is overdue now", () => {
    const lowered: ClosurePolicy = {
      mode: "block",
      thresholdHours: 24,
      enforceFrom: hoursAfterStart(29),
    };
    expect(planAt(30, lowered).map((a) => a.payload.stage)).toEqual(["overdue"]);
  });

  it("never raises anything for a mode-off tenant", () => {
    const off: ClosurePolicy = { mode: "off", thresholdHours: 24, enforceFrom: null };

    for (const elapsed of [18, 24, 36]) expect(planAt(elapsed, off)).toEqual([]);
  });

  it("raises the same alerts in warn and in block mode", () => {
    const block: ClosurePolicy = { mode: "block", thresholdHours: 24, enforceFrom: null };

    for (const elapsed of [18, 24, 36]) {
      expect(planAt(elapsed, block)).toEqual(planAt(elapsed, WARN_24));
    }
  });

  it("alerts on the TRUE stage: an enforceFrom grace window delays blocking, not the alert", () => {
    const grace: ClosurePolicy = {
      mode: "block",
      thresholdHours: 24,
      enforceFrom: hoursAfterStart(30),
    };

    expect(planAt(24, grace).map((a) => a.payload.stage)).toEqual(["overdue"]);
    expect(planAt(36, grace).map((a) => a.payload.stage)).toEqual(["escalated"]);
  });

  it("re-times with the tenant threshold (12h): at_risk 6h, overdue 12h, escalated 24h", () => {
    const twelve: ClosurePolicy = { mode: "warn", thresholdHours: 12, enforceFrom: null };

    expect(planAt(5.9, twelve)).toEqual([]);
    expect(planAt(6, twelve).map((a) => a.payload.stage)).toEqual(["at_risk"]);
    expect(planAt(12, twelve).map((a) => a.payload.stage)).toEqual(["overdue"]);
    expect(planAt(24, twelve).map((a) => a.payload.stage)).toEqual(["escalated"]);
  });

  it("alerts at_risk from the clock's first instant when the threshold is under the 6h lead", () => {
    const short: ClosurePolicy = { mode: "warn", thresholdHours: 4, enforceFrom: null };

    expect(planAt(0, short).map((a) => a.payload.stage)).toEqual(["at_risk"]);
  });

  it("carries one alert per note, in the order given", () => {
    const first = note({ encounterId: "00000000-0000-4000-8000-0000000000f1" });
    const second = note({ encounterId: "00000000-0000-4000-8000-0000000000f2" });

    const plan = planClosureAlerts([first, second], WARN_24, hoursAfterStart(24.25));

    expect(plan.map((a) => a.payload.encounterId)).toEqual([first.encounterId, second.encounterId]);
  });

  it("rejects an invalid threshold with RangeError instead of guessing", () => {
    const bad: ClosurePolicy = { mode: "warn", thresholdHours: 0, enforceFrom: null };

    expect(() => planAt(24, bad)).toThrow(RangeError);
  });
});

describe("planClosureAlerts: payload content (ids and instants only)", () => {
  it("carries exactly the contracted fields", () => {
    const [alert] = planAt(36.5);

    expect(alert?.payload).toEqual({
      obligationKind: "visit_note",
      encounterId: ENCOUNTER,
      authorUserId: AUTHOR_USER,
      providerEntityId: PROVIDER_ENTITY,
      stage: "escalated",
      deadlineAt: hoursAfterStart(24).toISOString(),
      hoursOverdue: 12,
      deepLink: CLOSURE_ALERT_DEEP_LINK,
    });
  });

  it("reports whole hours overdue (0 for at_risk) and an in-app deep link", () => {
    expect(planAt(19)[0]?.payload.hoursOverdue).toBe(0);
    expect(planAt(25.9)[0]?.payload.hoursOverdue).toBe(1);
    expect(CLOSURE_ALERT_DEEP_LINK).toBe("/work/drafts");
  });

  it("names no patient and no note content in the payload or the correlation id", () => {
    const [alert] = planAt(24.5);
    const text = JSON.stringify(alert);

    for (const forbidden of ["patient", "admission", "narrative", "name", "dob", "ssn"]) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("passes a null provider entity through (a draft with no site)", () => {
    expect(
      planAt(24.5, WARN_24, note({ providerEntityId: null }))[0]?.payload.providerEntityId,
    ).toBe(null);
  });
});

describe("planClosureAlerts: an author who is no longer an active member", () => {
  const gone = note({ authorUserId: null });

  it.each([18.5, 24.5])(
    "raises nothing at %sh: the author-only stages have nobody to tell",
    (elapsed) => {
      expect(planAt(elapsed, WARN_24, gone)).toEqual([]);
    },
  );

  it("still raises the escalation, with no author on the payload, so the supervisors are told", () => {
    const [alert] = planAt(36.5, WARN_24, gone);
    expect(alert).toMatchObject({
      eventType: "m8.encounter.closure_escalated",
      payload: { authorUserId: null, stage: "escalated" },
    });
  });
});

describe("emitted payloads validate against the REAL alert-payload registry", () => {
  const registry = createAlertPayloadRegistry();
  registry.register(M8_CLOSURE_ALERT_PAYLOADS);
  const catalog = registry.build();

  it("registers three well-formed, collision-free m8 entries (info, warn, warn)", () => {
    expect(() => registry.assertValid()).not.toThrow();
    expect([...catalog.keys()]).toEqual([
      "m8.encounter.closure_at_risk",
      "m8.encounter.closure_overdue",
      "m8.encounter.closure_escalated",
    ]);
    expect([...catalog.values()].map((e) => e.severity)).toEqual(["INFO", "WARN", "WARN"]);
  });

  it.each([18.5, 24.5, 36.5])(
    "every payload the sweep emits at %sh passes its schema",
    (elapsed) => {
      const alerts = [
        ...planAt(elapsed),
        ...planAt(elapsed, WARN_24, note({ providerEntityId: null })),
      ];

      expect(alerts.length).toBeGreaterThan(0);
      for (const alert of alerts) {
        const entry = catalog.get(alert.eventType);
        expect(entry, `${alert.eventType} must be registered`).toBeDefined();
        expect(Value.Check(entry!.payloadSchema, alert.payload)).toBe(true);
      }
    },
  );

  it("accepts a null authorUserId (an escalation for an author who left) and still refuses an empty one", () => {
    const entry = catalog.get("m8.encounter.closure_escalated")!;
    const [alert] = planAt(36.5, WARN_24, note({ authorUserId: null }));
    expect(alert?.payload.authorUserId).toBeNull();
    expect(Value.Check(entry.payloadSchema, alert?.payload)).toBe(true);
    expect(Value.Check(entry.payloadSchema, { ...alert?.payload, authorUserId: "" })).toBe(false);
  });

  it("rejects a payload that carries an unregistered shape (the validator is not a no-op)", () => {
    const entry = catalog.get("m8.encounter.closure_overdue")!;
    const [alert] = planAt(24.5);

    expect(Value.Check(entry.payloadSchema, { ...alert?.payload, stage: "ok" })).toBe(false);
    expect(Value.Check(entry.payloadSchema, { ...alert?.payload, hoursOverdue: -1 })).toBe(false);
    expect(Value.Check(entry.payloadSchema, { ...alert?.payload, encounterId: undefined })).toBe(
      false,
    );
  });
});

describe("emitted alerts reach the right people through the REAL emitter and the seeded rules", () => {
  const roleSetCalls: (readonly string[])[] = [];
  const peScopedCalls: { roleKeys: readonly string[]; providerEntityId: string }[] = [];

  /** An in-memory emitter over the platform seed whose recipient ports are scripted. */
  function emitterWith(peSupervisors: readonly string[]) {
    roleSetCalls.length = 0;
    peScopedCalls.length = 0;
    return createInMemoryAlertEmitter({
      recipients: {
        roleSetMembers: async (_org, roleKeys) => {
          roleSetCalls.push(roleKeys);
          return roleKeys.length > 0 ? [OTHER_SUPERVISOR_USER] : [];
        },
        roleSetMembersForProviderEntity: async (_org, roleKeys, providerEntityId) => {
          peScopedCalls.push({ roleKeys, providerEntityId });
          return peSupervisors;
        },
      },
    });
  }

  const recipientsOf = (recorded: { deliveries: readonly { recipientUserId: string }[] }) => [
    ...new Set(recorded.deliveries.map((d) => d.recipientUserId)),
  ];

  async function emitFirst(elapsed: number, n: ClosureSweepNote, peSupervisors: string[]) {
    const { emitter, recorded } = emitterWith(peSupervisors);
    const [alert] = planAt(elapsed, WARN_24, n);
    await emitter.emit(ORG_A, alert!);
    return recorded[0]!;
  }

  it("at_risk reaches the author only", async () => {
    const recorded = await emitFirst(18.5, note(), [SUPERVISOR_USER]);

    expect(recipientsOf(recorded)).toEqual([AUTHOR_USER]);
    expect(recorded.severity).toBe("info");
    expect(peScopedCalls).toEqual([]);
  });

  it("overdue reaches the author only", async () => {
    const recorded = await emitFirst(24.5, note(), [SUPERVISOR_USER]);

    expect(recipientsOf(recorded)).toEqual([AUTHOR_USER]);
    expect(recorded.severity).toBe("warn");
  });

  it("escalated reaches the author plus the provider entity's supervisors", async () => {
    const recorded = await emitFirst(36.5, note(), [SUPERVISOR_USER]);

    expect(recipientsOf(recorded).sort()).toEqual([AUTHOR_USER, SUPERVISOR_USER].sort());
    expect(peScopedCalls).toEqual([
      {
        roleKeys: expect.arrayContaining([
          "clinical_supervisor",
          "director_of_nursing",
          "don",
          "clinical_lead",
        ]),
        providerEntityId: PROVIDER_ENTITY,
      },
    ]);
    expect(recorded.severity).toBe("warn"); // never critical
  });

  it("escalated for an author who left reaches the supervisors alone (nobody else, and no author id on the payload)", async () => {
    const recorded = await emitFirst(36.5, note({ authorUserId: null }), [SUPERVISOR_USER]);

    expect(recipientsOf(recorded)).toEqual([SUPERVISOR_USER]);
  });

  it("escalated falls back to the org-wide supervisors when nobody is assigned to the entity", async () => {
    const recorded = await emitFirst(36.5, note(), []);

    expect(recipientsOf(recorded).sort()).toEqual([AUTHOR_USER, OTHER_SUPERVISOR_USER].sort());
  });

  it("escalated for a draft with no provider entity still reaches the author and the org-wide supervisors", async () => {
    const recorded = await emitFirst(36.5, note({ providerEntityId: null }), [SUPERVISOR_USER]);

    expect(recipientsOf(recorded).sort()).toEqual([AUTHOR_USER, OTHER_SUPERVISOR_USER].sort());
    expect(peScopedCalls).toEqual([]);
  });
});

/** Run the sweep over `scans` (org id -> scan or error) at `now`, recording what it emitted. */
function sweepOver(
  scans: Record<string, OrgClosureScan | Error>,
  now: Date,
  options: { alreadyAlerted?: ReadonlySet<string> | "unwired" } = {},
) {
  const emits: { organizationId: string; correlationId: string; eventType: string }[] = [];
  const failingEmitOrgs = new Set<string>();
  const failingCorrelationIds = new Set<string>();
  const lookups: { organizationId: string; correlationIds: readonly string[] }[] = [];
  const run = () =>
    runNoteClosureSweep({
      listActiveOrgs: async () => Object.keys(scans).map((organizationId) => ({ organizationId })),
      scanOrg: async (organizationId) => {
        const scan = scans[organizationId];
        if (scan instanceof Error) throw scan;
        return scan!;
      },
      ...(options.alreadyAlerted === "unwired"
        ? {}
        : {
            existingCorrelations: async (
              organizationId: string,
              correlationIds: readonly string[],
            ) => {
              lookups.push({ organizationId, correlationIds });
              const alerted: ReadonlySet<string> =
                options.alreadyAlerted === undefined || options.alreadyAlerted === "unwired"
                  ? new Set<string>()
                  : options.alreadyAlerted;
              return new Set(correlationIds.filter((id) => alerted.has(id)));
            },
          }),
      emit: async (organizationId, input) => {
        if (failingEmitOrgs.has(organizationId)) throw new Error("emit failed");
        if (failingCorrelationIds.has(input.correlationId)) throw new Error("emit failed");
        emits.push({
          organizationId,
          correlationId: input.correlationId,
          eventType: input.eventType,
        });
        return { alertId: "a", resolvedRecipientCount: 1 };
      },
      now: () => now,
    });
  return { run, emits, failingEmitOrgs, failingCorrelationIds, lookups };
}

describe("runNoteClosureSweep: per-org isolation", () => {
  const overdueScan: OrgClosureScan = { policy: WARN_24, notes: [note()] };

  it("emits per organization under that organization's id and counts them", async () => {
    const { run, emits } = sweepOver(
      { [ORG_A]: overdueScan, [ORG_B]: overdueScan },
      hoursAfterStart(24.5),
    );

    await expect(run()).resolves.toEqual({ orgs: 2, emitted: 2 });
    expect(emits.map((e) => e.organizationId)).toEqual([ORG_A, ORG_B]);
  });

  it("does nothing when there are no active organizations", async () => {
    const { run, emits } = sweepOver({}, hoursAfterStart(24.5));

    await expect(run()).resolves.toEqual({ orgs: 0, emitted: 0 });
    expect(emits).toEqual([]);
  });

  it("a failing organization does not stop the others, and the job still rejects afterwards", async () => {
    const { run, emits } = sweepOver(
      { [ORG_A]: overdueScan, [ORG_B]: new Error("db down"), [ORG_C]: overdueScan },
      hoursAfterStart(24.5),
    );

    const failure = await run().catch((e: unknown) => e);

    expect(emits.map((e) => e.organizationId)).toEqual([ORG_A, ORG_C]);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toHaveLength(1);
    expect(aggregate.message).toContain(ORG_B);
    expect(aggregate.message).toContain("1 of 3");
    expect(aggregate.message).not.toContain(ORG_A);
  });

  it("a bad threshold (RangeError from the pure clock) fails that organization only", async () => {
    const bad: OrgClosureScan = {
      policy: { mode: "warn", thresholdHours: 0, enforceFrom: null },
      notes: [note()],
    };
    const { run, emits } = sweepOver({ [ORG_A]: bad, [ORG_B]: overdueScan }, hoursAfterStart(24.5));

    const failure = (await run().catch((e: unknown) => e)) as AggregateError;

    expect(emits.map((e) => e.organizationId)).toEqual([ORG_B]);
    expect(failure.errors[0]).toBeInstanceOf(RangeError);
    expect(failure.message).toContain(ORG_A);
  });

  it("an emit failure in one organization does not stop the next", async () => {
    const { run, emits, failingEmitOrgs } = sweepOver(
      { [ORG_A]: overdueScan, [ORG_B]: overdueScan },
      hoursAfterStart(24.5),
    );
    failingEmitOrgs.add(ORG_A);

    await expect(run()).rejects.toBeInstanceOf(AggregateError);
    expect(emits.map((e) => e.organizationId)).toEqual([ORG_B]);
  });

  it("raises nothing for an organization with no clocked notes or with mode off", async () => {
    const off: OrgClosureScan = { policy: { ...WARN_24, mode: "off" }, notes: [note()] };
    const { run, emits } = sweepOver(
      { [ORG_A]: { policy: WARN_24, notes: [] }, [ORG_B]: off },
      hoursAfterStart(24.5),
    );

    await expect(run()).resolves.toEqual({ orgs: 2, emitted: 0 });
    expect(emits).toEqual([]);
  });
});

describe("runNoteClosureSweep: a failing alert does not shadow the rest of its organization", () => {
  const older = note({ encounterId: "00000000-0000-4000-8000-0000000000f1" });
  const younger = note({ encounterId: "00000000-0000-4000-8000-0000000000f2" });
  const scan: OrgClosureScan = { policy: WARN_24, notes: [older, younger] };
  const overdueOf = (n: ClosureSweepNote) => `m8:closure:visit_note:${n.encounterId}:overdue`;

  it("keeps emitting after one emit throws, then rejects with every failure collected", async () => {
    const { run, emits, failingCorrelationIds } = sweepOver(
      { [ORG_A]: scan },
      hoursAfterStart(24.5),
    );
    failingCorrelationIds.add(overdueOf(older)); // the oldest note fails deterministically, every tick

    const failure = (await run().catch((e: unknown) => e)) as AggregateError;

    expect(emits.map((e) => e.correlationId)).toEqual([overdueOf(younger)]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.message).toContain(ORG_A);
    const [orgFailure] = failure.errors as AggregateError[];
    expect(orgFailure).toBeInstanceOf(AggregateError);
    expect(orgFailure?.errors).toHaveLength(1);
    expect(orgFailure?.message).toContain("1 of 2");
  });

  it("still lets the other organizations run after one organization's alerts fail", async () => {
    const { run, emits, failingEmitOrgs } = sweepOver(
      { [ORG_A]: scan, [ORG_B]: scan },
      hoursAfterStart(24.5),
    );
    failingEmitOrgs.add(ORG_A);

    await expect(run()).rejects.toBeInstanceOf(AggregateError);
    expect(emits.map((e) => e.organizationId)).toEqual([ORG_B, ORG_B]);
  });
});

describe("runNoteClosureSweep: the batched already-alerted pre-filter", () => {
  const scan: OrgClosureScan = { policy: WARN_24, notes: [note()] };
  const overdueId = `m8:closure:visit_note:${ENCOUNTER}:overdue`;

  it("asks once per organization for every candidate correlation id, and emits only the ones with no alert yet", async () => {
    const second = note({ encounterId: "00000000-0000-4000-8000-0000000000f2" });
    const { run, emits, lookups } = sweepOver(
      { [ORG_A]: { policy: WARN_24, notes: [note(), second] } },
      hoursAfterStart(24.5),
      { alreadyAlerted: new Set([overdueId]) },
    );

    await expect(run()).resolves.toEqual({ orgs: 1, emitted: 1 });

    expect(lookups).toEqual([
      {
        organizationId: ORG_A,
        correlationIds: [overdueId, `m8:closure:visit_note:${second.encounterId}:overdue`],
      },
    ]);
    expect(emits.map((e) => e.correlationId)).toEqual([
      `m8:closure:visit_note:${second.encounterId}:overdue`,
    ]);
  });

  it("emits nothing, and resolves no recipients, when every due alert already exists", async () => {
    const { run, emits } = sweepOver({ [ORG_A]: scan }, hoursAfterStart(24.5), {
      alreadyAlerted: new Set([overdueId]),
    });

    await expect(run()).resolves.toEqual({ orgs: 1, emitted: 0 });
    expect(emits).toEqual([]);
  });

  it("does not ask at all when nothing is due (an organization with no overdue notes, or mode off)", async () => {
    const off: OrgClosureScan = { policy: { ...WARN_24, mode: "off" }, notes: [note()] };
    const { run, lookups } = sweepOver({ [ORG_A]: scan, [ORG_B]: off }, hoursAfterStart(1));

    await run();

    expect(lookups).toEqual([]);
  });

  it("without the pre-filter wired it emits every due alert (the emitter's own de-duplication is then the only guard)", async () => {
    const { run, emits } = sweepOver({ [ORG_A]: scan }, hoursAfterStart(24.5), {
      alreadyAlerted: "unwired",
    });

    await expect(run()).resolves.toEqual({ orgs: 1, emitted: 1 });
    expect(emits).toHaveLength(1);
  });

  it("a failing lookup fails that organization (not silently re-emitting everything) and spares the others", async () => {
    const emits: string[] = [];
    const run = () =>
      runNoteClosureSweep({
        listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
        scanOrg: async () => scan,
        existingCorrelations: async (organizationId) => {
          if (organizationId === ORG_A) throw new Error("alert table unavailable");
          return new Set<string>();
        },
        emit: async (organizationId) => {
          emits.push(organizationId);
          return { alertId: "a", resolvedRecipientCount: 1 };
        },
        now: () => hoursAfterStart(24.5),
      });

    const failure = (await run().catch((e: unknown) => e)) as AggregateError;

    expect(failure.message).toContain(ORG_A);
    expect(emits).toEqual([ORG_B]);
  });
});

describe("a 15-minute cron with no lookback alerts every stage exactly once", () => {
  /** Tick the sweep every 15 minutes over `hours`; the alert store remembers what was emitted, as the real alert table does. */
  async function ticks(from: Date, hours: number, scan: OrgClosureScan, store: Set<string>) {
    const emitted: string[] = [];
    let lookupCount = 0;
    for (let at = from.getTime(); at <= from.getTime() + hours * MS_PER_HOUR; at += TICK_MS) {
      const { run, emits, lookups } = sweepOver({ [ORG_A]: scan }, new Date(at), {
        alreadyAlerted: store,
      });
      await run();
      lookupCount += lookups.length;
      for (const e of emits) {
        store.add(e.correlationId);
        emitted.push(e.eventType);
      }
    }
    return { emitted, lookupCount };
  }

  it("emits one distinct alert per stage across the note's whole life, none skipped and none repeated", async () => {
    const { emitted } = await ticks(
      CLOCK_START,
      60,
      { policy: WARN_24, notes: [note()] },
      new Set(),
    );

    expect(emitted).toEqual([
      "m8.encounter.closure_at_risk",
      "m8.encounter.closure_overdue",
      "m8.encounter.closure_escalated",
    ]);
  });

  it("a worker outage of 20 hours does not skip a stage: the first tick back emits the current one", async () => {
    // ticks at the note's 0h..17h (nothing due), then the worker is down until 38h: the escalation is still raised
    const store = new Set<string>();
    const scan: OrgClosureScan = { policy: WARN_24, notes: [note()] };
    await ticks(CLOCK_START, 17, scan, store);
    const { emitted } = await ticks(hoursAfterStart(38), 1, scan, store);

    expect(emitted).toEqual(["m8.encounter.closure_escalated"]);
  });

  it("a late EVV instant (the clock is first seen when the note is already 30h old) still gets its overdue alert, once", async () => {
    // the sweep never saw this note at at_risk; the stage it is in NOW is raised, and not again
    const store = new Set<string>();
    const lateClock = note({ clockStartedAt: hoursAfterStart(-30) });
    const { emitted } = await ticks(CLOCK_START, 3, { policy: WARN_24, notes: [lateClock] }, store);

    expect(emitted).toEqual(["m8.encounter.closure_overdue"]);
  });

  it("a lowered threshold alerts the notes it newly makes overdue, once", async () => {
    const store = new Set<string>();
    const lowered: OrgClosureScan = {
      policy: { mode: "block", thresholdHours: 12, enforceFrom: hoursAfterStart(20) },
      notes: [note()],
    };
    const { emitted } = await ticks(hoursAfterStart(20), 2, lowered, store);

    expect(emitted).toEqual(["m8.encounter.closure_overdue"]);
  });

  it("asks the alert table once per tick, never once per note", async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      note({ encounterId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }),
    );
    const { run, lookups } = sweepOver(
      { [ORG_A]: { policy: WARN_24, notes: many } },
      hoursAfterStart(24.5),
    );

    await run();

    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.correlationIds).toHaveLength(30);
  });
});

/** A never-connected drizzle handle: enough to RENDER the sweep's SQL without a database. */
const renderDb = createDbClient({ connectionString: "postgres://render-only/none" })
  .db as unknown as DbClient;

type Chain = { [method: string]: (...args: unknown[]) => Chain } & PromiseLike<unknown>;

/** A fake transaction that records each select's rendered SQL and answers it from `answers` in order. */
function recordingDb(answers: unknown[][]) {
  const statements: string[] = [];
  const wrap = (builder: { toSQL(): { sql: string } }): Chain =>
    new Proxy({} as Chain, {
      get: (_target, prop: string) => {
        if (prop === "then") {
          return (resolve: (rows: unknown) => unknown) => {
            statements.push(builder.toSQL().sql);
            return Promise.resolve(answers.shift() ?? []).then(resolve);
          };
        }
        return (...args: unknown[]) =>
          wrap((builder as unknown as Record<string, (...a: unknown[]) => never>)[prop]!(...args));
      },
    });
  const tx = {
    execute: async () => [],
    select: (fields: never) =>
      wrap((renderDb as unknown as { select(f: never): never }).select(fields)),
  };
  const db = { transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { db: db as unknown as DbClient, statements };
}

// The cron-wiring suite below mocks `scanOrgClosureState` for the whole file, so the SQL suite loads the real adapter explicitly.
const actualSweep = () =>
  vi.importActual<typeof import("../src/modules/08-encounters/closure/closure-sweep")>(
    "../src/modules/08-encounters/closure/closure-sweep",
  );

describe("scanOrgClosureState: the SQL the sweep issues", () => {
  it("selects clocked open notes joined to the author's membership, with no overdue predicate", async () => {
    const { db, statements } = recordingDb([
      [], // no policy row -> the warn / 24 default
      [
        {
          encounterId: ENCOUNTER,
          clockStartedAt: CLOCK_START,
          authorUserId: AUTHOR_USER,
          authorStatus: "active",
          providerEntityId: PROVIDER_ENTITY,
        },
      ],
    ]);

    const scan = await (await actualSweep()).scanOrgClosureState(db, ORG_A);

    expect(scan.policy).toEqual({ mode: "warn", thresholdHours: 24, enforceFrom: null });
    expect(scan.notes).toEqual([
      {
        encounterId: ENCOUNTER,
        clockStartedAt: CLOCK_START,
        authorUserId: AUTHOR_USER,
        providerEntityId: PROVIDER_ENTITY,
      },
    ]);
    const notesSql = statements[1]!.toLowerCase();
    expect(notesSql).toContain("\"encounter\".\"status\" in ('draft', 'finalized')");
    expect(notesSql).toContain('"encounter"."clock_started_at" is not null');
    expect(notesSql).toContain('inner join "membership"');
    expect(notesSql).toContain('"membership"."user_id"');
    expect(notesSql).toContain('"membership"."status"');
    expect(notesSql).toContain('"encounter"."organization_id" =');
    // The pure clock decides; the SQL carries no time bound at all.
    expect(notesSql).not.toContain("now()");
    expect(notesSql).not.toContain("interval");
    expect(notesSql).not.toMatch(/clock_started_at"\s*(<|>|<=|>=)/);
  });

  it.each(["suspended", "departed", "invited"])(
    "reports a %s author as no recipient (null user id) but keeps the note, so its escalation can still reach the supervisors",
    async (authorStatus) => {
      const { db } = recordingDb([
        [],
        [
          {
            encounterId: ENCOUNTER,
            clockStartedAt: CLOCK_START,
            authorUserId: AUTHOR_USER,
            authorStatus,
            providerEntityId: PROVIDER_ENTITY,
          },
        ],
      ]);

      const scan = await (await actualSweep()).scanOrgClosureState(db, ORG_A);

      expect(scan.notes).toEqual([
        {
          encounterId: ENCOUNTER,
          clockStartedAt: CLOCK_START,
          authorUserId: null,
          providerEntityId: PROVIDER_ENTITY,
        },
      ]);
    },
  );

  it("reads no notes at all for a mode-off tenant", async () => {
    const { db, statements } = recordingDb([
      [{ mode: "off", thresholdHours: 24, enforceFrom: null }],
    ]);

    const scan = await (await actualSweep()).scanOrgClosureState(db, ORG_A);

    expect(scan).toEqual({
      policy: { mode: "off", thresholdHours: 24, enforceFrom: null },
      notes: [],
    });
    expect(statements).toHaveLength(1);
  });

  it("drops a row with a null clock instead of alerting on it (defence in depth)", async () => {
    const { db } = recordingDb([
      [],
      [
        {
          encounterId: ENCOUNTER,
          clockStartedAt: null,
          authorUserId: AUTHOR_USER,
          authorStatus: "active",
          providerEntityId: null,
        },
      ],
    ]);

    await expect((await actualSweep()).scanOrgClosureState(db, ORG_A)).resolves.toMatchObject({
      notes: [],
    });
  });
});

const scanMock = vi.hoisted(() => vi.fn());
vi.mock("../src/modules/08-encounters/closure/closure-sweep", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/modules/08-encounters/closure/closure-sweep")>()),
  scanOrgClosureState: scanMock,
}));

describe("runEncounterAttentionCron: wiring", () => {
  beforeEach(() => scanMock.mockReset());

  function cronDeps(alerts: AlertEmitter | undefined, orgs: string[]): M8WorkerDeps {
    return {
      connection: {},
      db: {},
      outbox: { publish: async () => undefined },
      activeOrgs: {
        listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })),
      },
      ...(alerts ? { alerts } : {}),
      now: () => hoursAfterStart(24.5),
    } as unknown as M8WorkerDeps;
  }

  it("keeps its signature and emits the closure alerts through the injected emitter", async () => {
    scanMock.mockResolvedValue({ policy: WARN_24, notes: [note()] });
    const emitted: unknown[] = [];
    const alerts: AlertEmitter = {
      emit: async (orgId, input) => {
        emitted.push({ orgId, ...input });
        return { alertId: "a", resolvedRecipientCount: 1 };
      },
    };

    await runEncounterAttentionCron(cronDeps(alerts, [ORG_A]));

    expect(scanMock).toHaveBeenCalledWith(expect.anything(), ORG_A);
    expect(emitted).toEqual([
      expect.objectContaining({
        orgId: ORG_A,
        eventType: "m8.encounter.closure_overdue",
        severity: "warn",
        correlationId: `m8:closure:visit_note:${ENCOUNTER}:overdue`,
      }),
    ]);
  });

  it("runs every org and rejects after the last one when a scan fails", async () => {
    scanMock.mockImplementation(async (_db: unknown, orgId: string) => {
      if (orgId === ORG_A) throw new Error("boom");
      return { policy: WARN_24, notes: [note()] };
    });
    const emitted: string[] = [];
    const alerts: AlertEmitter = {
      emit: async (orgId) => {
        emitted.push(orgId);
        return { alertId: "a", resolvedRecipientCount: 1 };
      },
    };

    await expect(runEncounterAttentionCron(cronDeps(alerts, [ORG_A, ORG_B]))).rejects.toThrow(
      /M8_CLOSURE_SWEEP: 1 of 2/,
    );
    expect(emitted).toEqual([ORG_B]);
  });
});
