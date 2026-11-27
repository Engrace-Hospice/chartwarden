// CW-DS-01 — the seed's tombstone purge touches the append-only trigger only inside a transaction, only when the organization has rows,
// and never leaves the trigger off. A fake client records the statements; the real behaviour on Postgres is in
// apps/backend/__tests__/m22-object-destruction-tombstones.live.test.ts.
import { describe, expect, it } from "vitest";
import { purgeOrgTombstones } from "../db/lib/purge-org-tombstones";

const ORG = "11111111-1111-4111-8111-111100000001";

/** A client whose statements are scripted by prefix: a number is the rowCount, an Error is thrown. */
function fakeClient(script: Record<string, number | Error>) {
  const log: string[] = [];
  return {
    log,
    async query(text: string): Promise<{ rowCount: number }> {
      log.push(text.split("\n")[0] ?? text);
      for (const [prefix, outcome] of Object.entries(script))
        if (text.startsWith(prefix)) {
          if (outcome instanceof Error) throw outcome;
          return { rowCount: outcome };
        }
      return { rowCount: 0 };
    },
  };
}

describe("purgeOrgTombstones", () => {
  it("does nothing, and issues no ALTER, when the organization has no tombstones", async () => {
    const db = fakeClient({ "SELECT 1": 0 });
    expect(await purgeOrgTombstones(db, ORG)).toBe(0);
    expect(db.log).toHaveLength(1);
  });

  it("disables the trigger, deletes the organization's rows, re-enables it ALWAYS, inside a savepoint", async () => {
    const db = fakeClient({ "SELECT 1": 1, "DELETE FROM": 3 });
    expect(await purgeOrgTombstones(db, ORG)).toBe(3);
    expect(db.log).toEqual([
      "SELECT 1 FROM object_destruction_tombstone WHERE organization_id = $1 LIMIT 1",
      "SAVEPOINT purge_org_tombstones",
      "ALTER TABLE object_destruction_tombstone DISABLE TRIGGER trg_object_destruction_tombstone_append_only",
      "DELETE FROM object_destruction_tombstone WHERE organization_id = $1",
      "ALTER TABLE object_destruction_tombstone ENABLE ALWAYS TRIGGER trg_object_destruction_tombstone_append_only",
      "RELEASE SAVEPOINT purge_org_tombstones",
    ]);
  });

  it("refuses outside a transaction: the SAVEPOINT fails and the trigger is never touched", async () => {
    const db = fakeClient({
      "SELECT 1": 1,
      SAVEPOINT: new Error("SAVEPOINT can only be used in transaction blocks"),
    });
    await expect(purgeOrgTombstones(db, ORG)).rejects.toThrow(/transaction blocks/);
    expect(db.log.some((line) => line.startsWith("ALTER TABLE"))).toBe(false);
  });

  it("rolls back to the savepoint (undoing the DISABLE) and rethrows the DELETE's own error", async () => {
    const db = fakeClient({ "SELECT 1": 1, "DELETE FROM": new Error("delete failed") });
    await expect(purgeOrgTombstones(db, ORG)).rejects.toThrow("delete failed");
    expect(db.log.at(-1)).toBe("ROLLBACK TO SAVEPOINT purge_org_tombstones");
    expect(db.log.some((line) => line.includes("ENABLE ALWAYS"))).toBe(false);
  });

  it("rethrows the original error even when the rollback itself fails (an aborted transaction)", async () => {
    const db = fakeClient({
      "SELECT 1": 1,
      "DELETE FROM": new Error("delete failed"),
      "ROLLBACK TO": new Error("current transaction is aborted"),
    });
    await expect(purgeOrgTombstones(db, ORG)).rejects.toThrow("delete failed");
  });
});
