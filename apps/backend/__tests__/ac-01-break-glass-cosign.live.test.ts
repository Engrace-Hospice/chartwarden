/**
 * AC-01 — the break-glass co-signature is a TWO-PERSON control, LIVE Postgres.
 *
 * `BreakGlassStore.cosign(eventId, byUserId)` wrote `status='active', cosigned_by=byUserId`
 * matching on the event id ALONE. Nothing — not the route, not the store, not a constraint —
 * compared the co-signer against the event's `actor_user_id`, so a user holding
 * `breakglass.cosign` could approve their own emergency PHI grant. `breakglass.cosign` is held by
 * several people by construction (it IS the control), and a tenant only sets
 * `breakglass_cosign_required` because it wants the second person.
 *
 * The same id-only match had a second consequence: `status='active'` was set regardless of the
 * CURRENT status, so co-signing a REVOKED event silently resurrected it — and since cosign and
 * revoke share one permission, whoever ended a grant early could also un-end it, with the trail
 * recording a co-signature rather than a revival.
 *
 * Why LIVE and not just the in-memory slice: the fix has two halves that only exist against a real
 * database — the guards are conjuncts in the UPDATE's WHERE (so two concurrent co-signers cannot
 * both pass a read-then-write), and `bge_cosigner_distinct` (migration 0210) is what makes the
 * invariant survive a caller that never runs the store at all. A slice test can prove neither.
 *
 * Everything runs as the NOBYPASSRLS `wardenx_app` role, so a missing GRANT or policy fails it.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m3:break-glass:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { runWithRequestContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BreakGlassStore } from "../src/modules/03-authorization/index";
import { createDbBreakGlassStore } from "../src/modules/03-authorization/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-111111ac0101";
const USER_INVOKER = "22222222-2222-4222-8222-222222ac0101";
const USER_COSIGNER = "22222222-2222-4222-8222-222222ac0102";
const TARGET_PATIENT = "33333333-3333-4333-8333-333333ac0101";

describe.skipIf(!DB_URL)("AC-01 break-glass two-person co-signature — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: BreakGlassStore;

  /** The store's by-id methods read the org/user off the request context (RLS `app.org_id`). */
  const asUser = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
    runWithRequestContext({ organizationId: ORG_A, userId } as never, fn);

  /** Open a glass that is AWAITING a co-signature — the state the control governs. */
  const invokePending = () =>
    store.invoke({
      organizationId: ORG_A,
      actorUserId: USER_INVOKER,
      targetPatientId: TARGET_PATIENT,
      reason: "covering nurse, chest pain emergency",
      cosignRequired: true,
      ttlSeconds: 4 * 3600,
    });

  const statusOf = async (eventId: string): Promise<string> =>
    (await admin.query("SELECT status FROM break_glass_event WHERE id=$1", [eventId])).rows[0]
      ?.status;

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();

    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'ac01-a','A','A','active')",
      [ORG_A],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'inv@ac01.test'),($2,'co@ac01.test')`, [
      USER_INVOKER,
      USER_COSIGNER,
    ]);

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    store = createDbBreakGlassStore(handle.db);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM break_glass_event");
  });

  it("refuses the invoker as their own co-signer, and the grant stays shut", async () => {
    const event = await asUser(USER_INVOKER, invokePending);
    expect(event.status).toBe("cosign_pending");

    await expect(
      asUser(USER_INVOKER, () => Promise.resolve(store.cosign(event.eventId, USER_INVOKER))),
    ).rejects.toMatchObject({ kind: "self_cosign" });

    // The security property: still pending, still no co-signer, and NOT an open grant.
    const row = (
      await admin.query("SELECT status, cosigned_by FROM break_glass_event WHERE id=$1", [
        event.eventId,
      ])
    ).rows[0];
    expect(row.status).toBe("cosign_pending");
    expect(row.cosigned_by).toBeNull();
    const grant = await asUser(USER_INVOKER, () =>
      Promise.resolve(
        store.findActiveGrant(ORG_A, USER_INVOKER, TARGET_PATIENT, Date.now()),
      ),
    );
    expect(grant).toBeNull();
  });

  it("a DISTINCT co-signer opens the grant", async () => {
    const event = await asUser(USER_INVOKER, invokePending);
    const cosigned = await asUser(USER_COSIGNER, () =>
      Promise.resolve(store.cosign(event.eventId, USER_COSIGNER)),
    );
    expect(cosigned.status).toBe("active");

    const row = (
      await admin.query("SELECT cosigned_by FROM break_glass_event WHERE id=$1", [event.eventId])
    ).rows[0];
    expect(row.cosigned_by).toBe(USER_COSIGNER);
    // The §2.2 branch now finds the glass — the co-signature is what opened it.
    const grant = await asUser(USER_INVOKER, () =>
      Promise.resolve(
        store.findActiveGrant(ORG_A, USER_INVOKER, TARGET_PATIENT, Date.now()),
      ),
    );
    expect(grant?.eventId).toBe(event.eventId);
  });

  it("a co-signature cannot resurrect a REVOKED grant", async () => {
    const event = await asUser(USER_INVOKER, invokePending);
    await asUser(USER_COSIGNER, () => Promise.resolve(store.revoke(event.eventId)));
    expect(await statusOf(event.eventId)).toBe("revoked");

    await expect(
      asUser(USER_COSIGNER, () => Promise.resolve(store.cosign(event.eventId, USER_COSIGNER))),
    ).rejects.toMatchObject({ kind: "not_pending" });
    expect(await statusOf(event.eventId)).toBe("revoked");
  });

  it("a second co-signature cannot overwrite the first on an ALREADY-ACTIVE grant", async () => {
    const event = await asUser(USER_INVOKER, invokePending);
    await asUser(USER_COSIGNER, () => Promise.resolve(store.cosign(event.eventId, USER_COSIGNER)));

    await expect(
      asUser(USER_INVOKER, () => Promise.resolve(store.cosign(event.eventId, USER_INVOKER))),
    ).rejects.toMatchObject({ kind: "not_pending" });
    const row = (
      await admin.query("SELECT cosigned_by FROM break_glass_event WHERE id=$1", [event.eventId])
    ).rows[0];
    expect(row.cosigned_by).toBe(USER_COSIGNER); // the original co-signer is who is accountable
  });

  // ── the at-rest half: the constraint holds when the store is bypassed entirely ───────────────
  it("bge_cosigner_distinct rejects a self-cosign written by DIRECT SQL", async () => {
    const event = await asUser(USER_INVOKER, invokePending);
    // No store, no route, no app-layer guard — a backfill or ops script doing the obvious thing.
    await expect(
      admin.query("UPDATE break_glass_event SET status='active', cosigned_by=$2 WHERE id=$1", [
        event.eventId,
        USER_INVOKER,
      ]),
    ).rejects.toMatchObject({ constraint: "bge_cosigner_distinct" });
    expect(await statusOf(event.eventId)).toBe("cosign_pending");
  });

  it("bge_cosigner_distinct still admits a distinct co-signer and an un-cosigned row", async () => {
    const event = await asUser(USER_INVOKER, invokePending);
    await admin.query("UPDATE break_glass_event SET cosigned_by=$2 WHERE id=$1", [
      event.eventId,
      USER_COSIGNER,
    ]);
    await admin.query("UPDATE break_glass_event SET cosigned_by=NULL WHERE id=$1", [event.eventId]);
    expect(await statusOf(event.eventId)).toBe("cosign_pending");
  });
});
