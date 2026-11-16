/**
 * M15 §7.11 / `m15.discharge.apply` — the `m6.admission.discharged` consumer. No database: the pure decider,
 * the wire parser, and an IN-MEMORY run of the real consumer (a fake tx over four in-memory tables) so the
 * sequence of writes and the replay behaviour are pinned. The fake `update` does NOT evaluate its predicate,
 * so which rows the consumer touches (admission / tenant scoping, the supersede filter, the version guard) is
 * proved by the live block "m6.admission.discharged discharges ONLY the named admission's plans" in
 * m15-idg-decision-apply.live.test.ts, over real Postgres as the NOBYPASSRLS app role.
 *
 * The defect this ends: `transitionDisciplinePlan`'s `discharge` event had NOTHING dispatching it, so plans
 * stayed active/draft_revising forever and `m15.plan.discharged` was never produced.
 */
import { schema } from "@chartwarden/db";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;
const harness = vi.hoisted(() => ({ tx: null as unknown }));
vi.mock("@chartwarden/tenancy", () => ({
  withOrgContext: async (_db: unknown, _ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn(harness.tx),
}));
vi.mock("@chartwarden/audit", () => ({ audit: vi.fn(async () => undefined) }));

import {
  M15_OUTBOX_EVENTS,
  M15_PLAN_DISCHARGE_CONSUMER,
  buildM15AdmissionDischargedConsumer,
  decideAdmissionDischarge,
  dischargeReasonOf,
  parseAdmissionDischarged,
} from "../src/modules/15-discipline-care-plans/index";

const ORG = "11111111-1111-4111-8111-111111111111";
const ADMISSION = "22222222-2222-4222-8222-222222222222";
const PE = "33333333-3333-4333-8333-333333333333";
const LOC = "44444444-4444-4444-8444-444444444444";
const AT = new Date("2026-11-10T15:00:00.000Z");

describe("dischargeReasonOf", () => {
  it("keeps the three named admission-end causes and maps the other M6 discharge reasons to discharge", () => {
    // Every `reason` M6 can put on `m6.admission.discharged`: the §4.2.7 enum plus revocation / transfer.
    expect(dischargeReasonOf("death")).toBe("death");
    expect(dischargeReasonOf("revocation")).toBe("revocation");
    expect(dischargeReasonOf("transfer")).toBe("transfer");
    for (const other of ["moved_out_of_service_area", "no_longer_terminal", "for_cause", "other"]) {
      expect(dischargeReasonOf(other)).toBe("discharge");
    }
  });
});

describe("parseAdmissionDischarged", () => {
  it("reads the M6 wire shape", () => {
    expect(
      parseAdmissionDischarged({
        admissionId: ADMISSION,
        reason: "death",
        dischargeDate: AT.toISOString(),
      }),
    ).toEqual({ admissionId: ADMISSION, reason: "death", dischargedAt: AT });
  });

  it.each([
    ["a non-object payload", null],
    ["no admissionId", { reason: "routine", dischargeDate: AT.toISOString() }],
    ["no reason", { admissionId: ADMISSION, dischargeDate: AT.toISOString() }],
    ["an unparseable date", { admissionId: ADMISSION, reason: "routine", dischargeDate: "soon" }],
  ])("throws (dead-letters visibly) on %s", (_label, payload) => {
    expect(() => parseAdmissionDischarged(payload)).toThrow(/m15\.m6-admission-discharged/);
  });
});

describe("decideAdmissionDischarge", () => {
  it("discharges every non-discharged plan, including a draft that never signed", () => {
    const steps = decideAdmissionDischarge(
      [
        { id: "p1", kind: "aide_poc", status: "active" },
        { id: "p2", kind: "msw_plan", status: "draft_revising" },
        { id: "p3", kind: "spiritual_plan", status: "draft" },
      ],
      "discharge",
      AT,
    );
    expect(steps.map((s) => [s.planId, s.transition.from, s.transition.to])).toEqual([
      ["p1", "active", "discharged"],
      ["p2", "draft_revising", "discharged"],
      ["p3", "draft", "discharged"],
    ]);
    for (const s of steps) {
      expect(s.transition.effects).toContainEqual({ kind: "outbox", event: "m15.plan.discharged" });
    }
  });

  it("skips a plan that is already discharged, so a replay has nothing to do", () => {
    expect(
      decideAdmissionDischarge([{ id: "p1", kind: "aide_poc", status: "discharged" }], "death", AT),
    ).toEqual([]);
    expect(decideAdmissionDischarge([], "death", AT)).toEqual([]);
  });
});

// ── the real consumer over an in-memory tx ────────────────────────────────────────────────────────────

const PLAN = schema.disciplineCarePlan;
const VERSION = schema.disciplineCarePlanVersion;
const GOAL = schema.disciplineGoal;
const INTERVENTION = schema.disciplineIntervention;

const planRow = (id: string, kind: string, status: string): Row => ({
  id,
  organizationId: ORG,
  patientId: "patient-1",
  admissionId: ADMISSION,
  providerEntityId: PE,
  locationId: LOC,
  kind,
  status,
  version: 3,
  dischargedAt: null,
});

function buildTables(): Record<"plan" | "version" | "goal" | "intervention", Row[]> {
  return {
    plan: [
      planRow("plan-aide", "aide_poc", "draft_revising"),
      planRow("plan-spiritual", "spiritual_plan", "draft"),
    ],
    version: [
      { id: "v1", planId: "plan-aide", sequence: 1, kind: "initial", status: "signed", version: 2 },
      {
        id: "v2",
        planId: "plan-aide",
        sequence: 2,
        kind: "idg_review",
        status: "draft",
        version: 0,
      },
    ],
    goal: [],
    intervention: [],
  };
}

/** A fake drizzle tx: dispatches on the table object, ignores predicates (the data is one admission). */
function fakeTx(tables: ReturnType<typeof buildTables>) {
  const nameOf = (t: unknown): keyof typeof tables =>
    t === PLAN ? "plan" : t === VERSION ? "version" : t === GOAL ? "goal" : "intervention";
  // A real Promise (awaiting `.where()`/`.for()` resolves to the rows) carrying the chain methods.
  const awaitable = <T>(value: T) => {
    const q = Promise.resolve(value) as Promise<T> & Record<string, unknown>;
    q.where = () => q;
    q.for = () => q;
    q.returning = () => Promise.resolve(value);
    return q;
  };
  return {
    select: (cols?: unknown) => ({
      from: (t: unknown) => {
        const rows = tables[nameOf(t)];
        if (cols === undefined) return awaitable(rows);
        const max = rows.reduce((m, r) => Math.max(m, Number(r.sequence ?? 0)), 0);
        return awaitable([{ maxSeq: max }]);
      },
    }),
    insert: (t: unknown) => ({
      values: (v: Row) => {
        const row = { id: `new-${tables[nameOf(t)].length}`, ...v };
        tables[nameOf(t)].push(row);
        return awaitable([{ id: row.id }]);
      },
    }),
    update: (t: unknown) => ({
      set: (patch: Row) => {
        const plain = Object.fromEntries(
          Object.entries(patch).filter(([, v]) => typeof v !== "object" || v instanceof Date),
        );
        // The fake cannot read the predicate: the only version UPDATE the consumer issues is "supersede the
        // plan's signed versions", and the discharge versions it inserts itself must not be hit by it.
        const hit = tables[nameOf(t)].filter((r) =>
          nameOf(t) === "version" ? r.status === "signed" && r.kind !== "discharge" : true,
        );
        for (const r of hit) Object.assign(r, plain);
        return awaitable(hit.map((r) => ({ id: r.id })));
      },
    }),
  };
}

function run() {
  const tables = buildTables();
  harness.tx = fakeTx(tables);
  const published: Array<{ eventName: string; payload: Row }> = [];
  const consumer = buildM15AdmissionDischargedConsumer({
    db: {} as never,
    outbox: { publish: async (_tx, e) => void published.push(e as never) },
  });
  const deliver = () =>
    consumer.handle({
      organizationId: ORG,
      payload: { admissionId: ADMISSION, reason: "routine", dischargeDate: AT.toISOString() },
    });
  return { tables, published, deliver };
}

describe("buildM15AdmissionDischargedConsumer (in-memory)", () => {
  it("is bound to m6.admission.discharged as an m15 consumer", () => {
    const c = buildM15AdmissionDischargedConsumer({
      db: {} as never,
      outbox: { publish: async () => {} },
    });
    expect(c.eventTypes).toEqual([M15_PLAN_DISCHARGE_CONSUMER.eventName]);
    expect(c.consumerModule).toBe("m15");
  });

  it("discharges every plan, seals a signed system `discharge` version, supersedes the signed one, retains the open draft, and announces once per plan", async () => {
    const { tables, published, deliver } = run();
    await deliver();

    expect(tables.plan.map((p) => [p.id, p.status, p.dischargedAt])).toEqual([
      ["plan-aide", "discharged", AT],
      ["plan-spiritual", "discharged", AT],
    ]);
    // v1 (signed) superseded; v2 (open draft) retained untouched.
    expect(tables.version.find((v) => v.id === "v1")?.status).toBe("superseded");
    expect(tables.version.find((v) => v.id === "v2")?.status).toBe("draft");
    // one discharge version per plan, already signed, after the existing chain, empty quorum.
    const discharge = tables.version.filter((v) => v.kind === "discharge");
    expect(discharge).toHaveLength(2);
    expect(discharge.every((v) => v.status === "signed" && v.signedAt instanceof Date)).toBe(true);
    // After the aide plan's v1/v2 (the fake's max() ignores the plan filter, so only the first is exact).
    expect(discharge[0]?.sequence).toBe(3);
    expect(discharge.every((v) => Array.isArray(v.requiredSignerSet))).toBe(true);

    // Per plan: the system-signed discharge version is announced (so M22 renders the plan's FINAL PDF, audit
    // D-6), then the discharge itself.
    expect(published.map((e) => e.eventName)).toEqual([
      "m15.plan.version_signed",
      "m15.plan.discharged",
      "m15.plan.version_signed",
      "m15.plan.discharged",
    ]);
    const discharged = published.filter((e) => e.eventName === "m15.plan.discharged");
    const signed = published.filter((e) => e.eventName === "m15.plan.version_signed");
    expect(discharged[0]?.payload).toMatchObject({
      planId: "plan-aide",
      admissionId: ADMISSION,
      kind: "aide_poc",
    });
    expect(discharged[0]?.payload.finalSnapshotVersionId).toBe(discharge[0]?.id);
    expect(signed[0]?.payload).toMatchObject({
      planId: "plan-aide",
      versionId: discharge[0]?.id,
      kind: "aide_poc",
      versionKind: "discharge",
      signers: [],
      snapshot: expect.objectContaining({ systemSigned: true, versionKind: "discharge" }),
    });
    // What the real catalog-validating publisher would enforce: each payload satisfies its declared schema.
    for (const name of ["m15.plan.discharged", "m15.plan.version_signed"]) {
      const entry = M15_OUTBOX_EVENTS.find((e) => e.eventName === name);
      expect(entry).toBeDefined();
      for (const e of published.filter((p) => p.eventName === name)) {
        expect(Value.Check(entry!.payloadSchema, e.payload)).toBe(true);
      }
    }
  });

  it("is idempotent on replay: nothing new is written or announced", async () => {
    const { tables, published, deliver } = run();
    await deliver();
    const versions = tables.version.length;
    const announced = published.length;

    await deliver();

    expect(tables.version).toHaveLength(versions);
    expect(published).toHaveLength(announced);
  });

  it("is a no-op for an admission with no discipline plans", async () => {
    const { tables, published, deliver } = run();
    tables.plan.length = 0;
    await deliver();
    expect(published).toEqual([]);
    expect(tables.version).toHaveLength(2);
  });
});
