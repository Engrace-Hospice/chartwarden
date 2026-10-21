// apps/backend/__tests__/patient-siting-reader.test.ts — M6's PatientSitingReader seam over a fake db.
import type { DbClient } from "@chartwarden/db";
import { describe, expect, it } from "vitest";
import { createPatientSitingReader } from "../src/modules/06-admission/seams/patient-siting-reader";

function makeFakeDb(rows: readonly { locationId: string | null }[]) {
  const probe = { transactionOpened: false, setConfigCalls: [] as string[] };
  const tx = {
    async execute(q: unknown) {
      probe.setConfigCalls.push(JSON.stringify(q));
    },
    select() {
      return { from: () => ({ where: () => Promise.resolve(rows) }) };
    },
  };
  const db = {
    async transaction<R>(fn: (t: typeof tx) => Promise<R>) {
      probe.transactionOpened = true;
      return fn(tx);
    },
  };
  return { db: db as unknown as DbClient, probe };
}

describe("PatientSitingReader.getPatientLocationIds", () => {
  it("returns the distinct non-null location ids under an org context", async () => {
    const { db, probe } = makeFakeDb([
      { locationId: "l1" },
      { locationId: "l2" },
      { locationId: "l1" },
      { locationId: null },
    ]);
    const out = await createPatientSitingReader(db).getPatientLocationIds({
      organizationId: "org-9",
      patientId: "p1",
    });
    expect(out).toEqual(["l1", "l2"]);
    expect(probe.transactionOpened).toBe(true);
    expect(probe.setConfigCalls.join(" ")).toContain("org-9");
  });

  it("returns [] when the patient has no active / sited admission", async () => {
    const { db } = makeFakeDb([]);
    expect(
      await createPatientSitingReader(db).getPatientLocationIds({
        organizationId: "o",
        patientId: "p",
      }),
    ).toEqual([]);
  });

  it("returns [] when every active admission is unsited", async () => {
    const { db } = makeFakeDb([{ locationId: null }]);
    expect(
      await createPatientSitingReader(db).getPatientLocationIds({
        organizationId: "o",
        patientId: "p",
      }),
    ).toEqual([]);
  });
});
