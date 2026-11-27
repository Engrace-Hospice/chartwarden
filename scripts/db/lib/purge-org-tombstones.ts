// CW-DS-01 — the seed's teardown of its demo organization (scripts/db/seed.ts). `object_destruction_tombstone` is append-only for every
// role (a trigger that fires for a superuser and under session_replication_role = replica) and its organization foreign key is ON DELETE
// RESTRICT, so a demo organization that ever had a document erased could be neither purged nor deleted: the re-seed died on the
// organization DELETE. This removes THAT organization's tombstones, and nothing else, by switching the append-only trigger off for the
// delete and back on to ENABLE ALWAYS in the same call.
//
// It must run INSIDE a transaction (the seed's BEGIN ... COMMIT): there the DISABLE is invisible to every other session and is undone by
// a ROLLBACK, so the trigger can never be left off. Outside one the SAVEPOINT below fails and nothing is touched (an organization
// with no tombstones returns 0 before that point, so only a call that has something to purge is checked). The DISABLE also takes a
// SHARE ROW EXCLUSIVE lock on the table until the seed commits, so another tenant's tombstone INSERT waits for it. The seed is a local
// dev tool, but the manual `reseed-production` workflow runs it too against the demo organization (CHARTWARDEN_SEED_ALLOW_PRODUCTION),
// so a production reseed removes that organization's tombstones, unaudited, like the rest of its trail. It runs as the table owner or a
// superuser; an application or destruction role cannot ALTER the table.
export interface SqlClient {
  query(text: string, values?: unknown[]): Promise<{ rowCount?: number | null }>;
}

const APPEND_ONLY_TRIGGER = "trg_object_destruction_tombstone_append_only";
const SAVEPOINT = "purge_org_tombstones";

/** Delete one organization's tombstones; returns how many. A no-op (no ALTER) when it has none. Throws outside a transaction. */
export async function purgeOrgTombstones(db: SqlClient, orgId: string): Promise<number> {
  const found = await db.query(
    "SELECT 1 FROM object_destruction_tombstone WHERE organization_id = $1 LIMIT 1",
    [orgId],
  );
  if (!found.rowCount) return 0;
  // SAVEPOINT is only legal inside a transaction block: the check that the DISABLE below is never visible to other sessions
  await db.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    await db.query(
      `ALTER TABLE object_destruction_tombstone DISABLE TRIGGER ${APPEND_ONLY_TRIGGER}`,
    );
    const deleted =
      (
        await db.query("DELETE FROM object_destruction_tombstone WHERE organization_id = $1", [
          orgId,
        ])
      ).rowCount ?? 0;
    await db.query(
      `ALTER TABLE object_destruction_tombstone ENABLE ALWAYS TRIGGER ${APPEND_ONLY_TRIGGER}`,
    );
    await db.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return deleted;
  } catch (error) {
    // undoes the DISABLE too; the transaction stays usable for the caller's own ROLLBACK
    await db.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`).catch(() => {});
    throw error;
  }
}
