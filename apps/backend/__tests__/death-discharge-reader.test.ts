// apps/backend/__tests__/death-discharge-reader.test.ts — the §4.11 DeathDischargeReader Drizzle impl
// (the M30 HVLDL measure denominator). A fake scoped db drives `transaction → tx` with a select chain that
// returns seeded death rows; the test asserts the reader (1) opens its OWN withOrgContext envelope (sets the
// per-request org/user GUC via set_config on this connection — HARD RULE 3), and (2) maps each row to a
// DeathDischargeRow with the §4.11-limited constant source + undefined cosign status.
import type { DbClient } from "@wardenx/db";
import { describe, expect, it } from "vitest";
import { createDeathDischargeReader } from "../src/modules/06-admission/index";

/** A row shape the fake `.where()` resolves to (the three columns the reader selects). */
interface FakeRow {
  patientId: string;
  admissionId: string;
  deathAt: Date | null;
}

/** Records the set_config calls + the final query predicate so the test can assert the org envelope opened. */
interface FakeDbProbe {
  transactionOpened: boolean;
  setConfigCalls: string[];
  joined: boolean;
}

/**
 * A fake `DbClient` whose `transaction(fn)` runs `fn` with a tx that (a) records `set_config(...)` executes and
 * (b) returns the seeded rows from the `select().from().innerJoin().where()` chain. Structurally compatible with
 * the reader's use of withOrgContext (transaction + execute) + Drizzle's thenable query builder.
 */
function makeFakeDb(rows: readonly FakeRow[]): { db: DbClient; probe: FakeDbProbe } {
  const probe: FakeDbProbe = { transactionOpened: false, setConfigCalls: [], joined: false };
  const tx = {
    async execute(query: unknown) {
      // The Drizzle `sql` fragment stringifies to its template; record enough to prove both GUCs were set.
      probe.setConfigCalls.push(JSON.stringify(query));
      return undefined;
    },
    select() {
      return {
        from() {
          return {
            innerJoin() {
              probe.joined = true;
              return {
                where() {
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
  };
  const db = {
    async transaction<R>(fn: (t: typeof tx) => Promise<R>): Promise<R> {
      probe.transactionOpened = true;
      return fn(tx);
    },
  };
  return { db: db as unknown as DbClient, probe };
}

describe("DeathDischargeReader (§4.11 — M30 HVLDL denominator)", () => {
  const period = { from: "2026-01-01T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z" };

  it("opens a withOrgContext envelope (sets both GUCs) and maps death rows to DeathDischargeRow", async () => {
    const deathAt = new Date("2026-02-14T10:30:00.000Z");
    const { db, probe } = makeFakeDb([
      { patientId: "pat-1", admissionId: "adm-1", deathAt },
      { patientId: "pat-2", admissionId: "adm-2", deathAt: new Date("2026-03-01T08:00:00.000Z") },
    ]);

    const reader = createDeathDischargeReader(db);
    const out = await reader.listDeathDischargesInPeriod("org-7", period);

    // (1) self-scoped: the reader opened its own transaction + set BOTH the org and user GUCs.
    expect(probe.transactionOpened).toBe(true);
    expect(probe.joined).toBe(true);
    expect(probe.setConfigCalls.length).toBe(2);
    expect(probe.setConfigCalls.join(" ")).toContain("org-7");

    // (2) every row maps to the leaf DeathDischargeRow with the §4.11-limited constant source + no cosign.
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      patientId: "pat-1",
      admissionId: "adm-1",
      deathAt: "2026-02-14T10:30:00.000Z",
      source: "internal_clinician_recorded",
    });
    expect(out[0]?.cosignStatus).toBeUndefined();
    expect(out[1]?.source).toBe("internal_clinician_recorded");
  });

  it("skips a defensively-null death timestamp rather than fabricate an instant", async () => {
    const { db } = makeFakeDb([
      { patientId: "pat-3", admissionId: "adm-3", deathAt: null },
      { patientId: "pat-4", admissionId: "adm-4", deathAt: new Date("2026-02-20T00:00:00.000Z") },
    ]);

    const reader = createDeathDischargeReader(db);
    const out = await reader.listDeathDischargesInPeriod("org-7", period);

    expect(out).toHaveLength(1);
    expect(out[0]?.patientId).toBe("pat-4");
  });

  it("returns an empty census when the period has no decedents", async () => {
    const { db, probe } = makeFakeDb([]);
    const reader = createDeathDischargeReader(db);
    const out = await reader.listDeathDischargesInPeriod("org-7", period);
    expect(out).toEqual([]);
    expect(probe.transactionOpened).toBe(true);
  });
});
