// apps/backend/__tests__/admission-onset-reader.test.ts — the M6 AdmissionOnsetReader Drizzle impl
// (M30 opioid_on_admission_rate's denominator). Mirrors death-discharge-reader.test.ts's fake-db pattern.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { createAdmissionOnsetReader } from "../src/modules/06-admission/index";

interface FakeRow {
  id: string;
  admissionAt: Date | null;
}

interface FakeDbProbe {
  transactionOpened: boolean;
  setConfigCalls: string[];
}

function makeFakeDb(rows: readonly FakeRow[]): { db: DbClient; probe: FakeDbProbe } {
  const probe: FakeDbProbe = { transactionOpened: false, setConfigCalls: [] };
  const tx = {
    async execute(query: unknown) {
      probe.setConfigCalls.push(JSON.stringify(query));
      return undefined;
    },
    select() {
      return {
        from() {
          return { where: () => Promise.resolve(rows) };
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

describe("AdmissionOnsetReader (M30 opioid_on_admission_rate denominator)", () => {
  const period = { from: "2026-01-01T00:00:00.000Z", to: "2026-04-01T00:00:00.000Z" };

  it("opens a withOrgContext envelope and maps rows to AdmissionOnsetRow", async () => {
    const admissionAt = new Date("2026-02-14T10:30:00.000Z");
    const { db, probe } = makeFakeDb([
      { id: "adm-1", admissionAt },
      { id: "adm-2", admissionAt: new Date("2026-03-01T08:00:00.000Z") },
    ]);

    const reader = createAdmissionOnsetReader(db);
    const out = await reader.listAdmissionsStartedInPeriod("org-7", period);

    expect(probe.transactionOpened).toBe(true);
    expect(probe.setConfigCalls.length).toBe(2);
    expect(probe.setConfigCalls.join(" ")).toContain("org-7");
    expect(out).toEqual([
      { admissionId: "adm-1", admissionAt: "2026-02-14T10:30:00.000Z" },
      { admissionId: "adm-2", admissionAt: "2026-03-01T08:00:00.000Z" },
    ]);
  });

  it("skips a defensively-null admissionAt rather than fabricate an instant", async () => {
    const { db } = makeFakeDb([
      { id: "adm-3", admissionAt: null },
      { id: "adm-4", admissionAt: new Date("2026-02-20T00:00:00.000Z") },
    ]);
    const out = await createAdmissionOnsetReader(db).listAdmissionsStartedInPeriod("org-7", period);
    expect(out).toHaveLength(1);
    expect(out[0]?.admissionId).toBe("adm-4");
  });

  it("returns an empty census when no admissions started in the period", async () => {
    const { db, probe } = makeFakeDb([]);
    const out = await createAdmissionOnsetReader(db).listAdmissionsStartedInPeriod("org-7", period);
    expect(out).toEqual([]);
    expect(probe.transactionOpened).toBe(true);
  });
});
