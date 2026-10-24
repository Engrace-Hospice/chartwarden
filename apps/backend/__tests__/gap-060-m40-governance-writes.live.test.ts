/**
 * GAP-060 — M40's §7.6 merge-approval / merge-rejection / provisional-promotion writes, LIVE Postgres.
 *
 * `createDbMdmRouteService`'s three governance methods all called one helper, `governanceNotWired()`,
 * which threw a blanket 501 — behind three live, fully-enriched admin routes. And `listMergeRequests`,
 * the queue those routes act on, read `merge_request` directly on the app pool, which migration 0019
 * granted to `chartwarden_admin` alone: a `permission denied` 500 sitting next to the 501s. The dedup queue
 * could be neither seen nor acted on.
 *
 * The audit's evidence line is the sharpest part: "the only tests touching these routes run against an
 * in-memory backend... no test exercises the production DB-backed service's approve/reject/promote at
 * all." This suite is that test, as the NOBYPASSRLS `chartwarden_app` role, so a missing GRANT, a missing row
 * POLICY (the trap migration 0202 found on this very role) or a missing function fails it.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m40:governance:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbMdmRouteService } from "../src/modules/40-mdm/mdm-store-db";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG = "11111111-1111-4111-8111-1111110060a1";
const ACTOR = "22222222-2222-4222-8222-2222220060b1";
const SURVIVOR = "33333333-3333-4333-8333-3333330060c1";
const DUPLICATE = "33333333-3333-4333-8333-3333330060c2";
const THIRD = "33333333-3333-4333-8333-3333330060c3";

describe.skipIf(!DB_URL)("GAP-060 M40 §7.6 governance writes — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbMdmRouteService>;

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  /**
   * Assert a PostgreSQL RAISE from one of the §7.6 functions. Drizzle wraps the driver error as
   * "Failed query: …" and keeps the server's message on `.cause`, so matching the top-level message
   * would pass for ANY failed query — including a typo'd function name.
   */
  async function expectPgError(op: Promise<unknown>, pattern: RegExp): Promise<void> {
    const err = await op.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    const cause = (err as { cause?: { message?: string } }).cause;
    expect(`${cause?.message ?? err}`).toMatch(pattern);
  }

  const physician = async (id: string) =>
    (await admin.query("SELECT * FROM external_physician WHERE id = $1", [id])).rows[0];

  async function seedMerge(
    canonicalId: string,
    duplicateId: string,
    kind = "physician",
    status = "pending",
  ): Promise<string> {
    const r = await admin.query(
      `INSERT INTO merge_request (entity_kind, canonical_id, duplicate_id, proposed_by, evidence, status)
       VALUES ($1::mdm_entity_kind,$2,$3,'admin','{"npiMatch":true}'::jsonb,$4::mdm_merge_status)
       RETURNING id`,
      [kind, canonicalId, duplicateId, status],
    );
    return r.rows[0].id as string;
  }

  async function seedProvisional(
    entityKind: string,
    proposedFields: Record<string, unknown>,
  ): Promise<string> {
    const r = await admin.query(
      `INSERT INTO mdm_provisional (organization_id, entity_kind, proposed_fields, resolution)
       VALUES ($1,$2::mdm_entity_kind,$3::jsonb,'pending') RETURNING id`,
      [ORG, entityKind, JSON.stringify(proposedFields)],
    );
    return r.rows[0].id as string;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of [...ROLES, "mdm_canonical_writer"]) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();

    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'gap060','G','G','active')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'admin@gap060.test')`, [ACTOR]);

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    svc = createDbMdmRouteService(handle.db);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM merge_request");
    await admin.query("DELETE FROM mdm_provisional");
    // `external_physician_merged_consistency` asserts `(status = 'merged') = (merged_into_id IS NOT
    // NULL)`, so the reset must clear BOTH in one statement — nulling the redirect alone violates it.
    // (That CHECK is also why the approve function sets the pair together rather than in two updates.)
    await admin.query(
      "UPDATE external_physician SET status = 'active', merged_into_id = NULL, merged_from = '{}'",
    );
    await admin.query("DELETE FROM external_physician");
    await admin.query("DELETE FROM facility");
    await admin.query("DELETE FROM payer");
    await admin.query(
      `INSERT INTO external_physician (id, npi, first_name, last_name, status)
       VALUES ($1,'1234567893','Ada','Lovelace','active'),
              ($2,'1000015838','A.','Lovelace','active'),
              ($3,'1000158380','Grace','Hopper','active')`,
      [SURVIVOR, DUPLICATE, THIRD],
    );
  });

  // ── the queue read (the quieter half of GAP-060) ────────────────────────────────────────────────
  it("lists the open dedup queue as chartwarden_app — the read that used to be permission denied", async () => {
    const id = await seedMerge(SURVIVOR, DUPLICATE);
    const queue = await svc.listMergeRequests();
    expect(queue.map((m) => m.id)).toContain(id);
    const row = queue.find((m) => m.id === id);
    expect(row?.kind).toBe("physician");
    expect(row?.canonicalId).toBe(SURVIVOR);
    expect(row?.status).toBe("pending");
    expect(row?.evidence).toEqual({ npiMatch: true });
  });

  it("still refuses a DIRECT merge_request read from chartwarden_app (§3.6 posture unchanged)", async () => {
    // The function is the door; the table itself stays off the tenant pool entirely. If this ever
    // starts passing, someone widened the grant instead of using the writer surface.
    const err = await handle.db.execute("SELECT count(*) FROM merge_request" as never).then(
      () => null,
      (e: unknown) => e,
    );
    const cause = (err as { cause?: { message?: string } } | null)?.cause;
    expect(`${cause?.message ?? err}`).toMatch(/permission denied/i);
  });

  // ── approve ─────────────────────────────────────────────────────────────────────────────────────
  it("approves a merge: the duplicate redirects, the survivor records it, the request executes", async () => {
    const id = await seedMerge(SURVIVOR, DUPLICATE);
    const res = await svc.approveMerge(id, ACTOR);
    expect(res).toEqual({ duplicateId: DUPLICATE, canonicalId: SURVIVOR });

    const dup = await physician(DUPLICATE);
    expect(dup.status).toBe("merged");
    expect(dup.merged_into_id).toBe(SURVIVOR);
    const surv = await physician(SURVIVOR);
    expect(surv.merged_from).toEqual([DUPLICATE]);
    expect(surv.status).toBe("active"); // the survivor is untouched apart from provenance

    const merge = (await admin.query("SELECT * FROM merge_request WHERE id = $1", [id])).rows[0];
    expect(merge.status).toBe("executed");
    expect(merge.approved_by).toBe(ACTOR);
    expect(merge.executed_at).not.toBeNull();
  });

  it("refuses to approve twice — the second attempt sees a settled row", async () => {
    const id = await seedMerge(SURVIVOR, DUPLICATE);
    await svc.approveMerge(id, ACTOR);
    await expectPgError(svc.approveMerge(id, ACTOR), /MERGE_REQUEST_NOT_PENDING/);
    // And the survivor's provenance did not grow a duplicate entry.
    expect((await physician(SURVIVOR)).merged_from).toEqual([DUPLICATE]);
  });

  it("refuses to merge INTO a tombstone — a redirect chain would break one-hop resolution", async () => {
    await svc.approveMerge(await seedMerge(SURVIVOR, DUPLICATE), ACTOR);
    // DUPLICATE now redirects to SURVIVOR. Pointing THIRD at DUPLICATE would make THIRD → DUPLICATE →
    // SURVIVOR, and every reader in the system follows exactly one hop (§2.4.1).
    const chained = await seedMerge(DUPLICATE, THIRD);
    await expectPgError(svc.approveMerge(chained, ACTOR), /MERGE_SURVIVOR_ALREADY_MERGED/);
    expect((await physician(THIRD)).status).toBe("active");
  });

  it("refuses an unknown merge id and a kind with no phase-1 canonical table", async () => {
    await expectPgError(
      svc.approveMerge("99999999-9999-4999-8999-999999999999", ACTOR),
      /MERGE_REQUEST_NOT_FOUND/,
    );
    const pharmacy = await seedMerge(SURVIVOR, DUPLICATE, "pharmacy");
    // `mdm_entity_kind` declares 7 kinds; only 3 have tables. Settling this as `executed` when nothing
    // moved would be the worst outcome — the paperwork would claim a merge that never happened.
    await expectPgError(svc.approveMerge(pharmacy, ACTOR), /MERGE_KIND_UNSUPPORTED/);
    const still = (await admin.query("SELECT status FROM merge_request WHERE id=$1", [pharmacy]))
      .rows[0];
    expect(still.status).toBe("pending");
  });

  // ── reject ──────────────────────────────────────────────────────────────────────────────────────
  it("rejects an open proposal with its reason, touching no canonical", async () => {
    const id = await seedMerge(SURVIVOR, DUPLICATE);
    await svc.rejectMerge(id, "different practitioners, same surname", ACTOR);
    const merge = (await admin.query("SELECT * FROM merge_request WHERE id = $1", [id])).rows[0];
    expect(merge.status).toBe("rejected");
    expect(merge.rejection_reason).toContain("same surname");
    expect((await physician(DUPLICATE)).status).toBe("active");
  });

  it("refuses to reject an already-executed merge (404, not a silent success)", async () => {
    const id = await seedMerge(SURVIVOR, DUPLICATE);
    await svc.approveMerge(id, ACTOR);
    // Rejecting an executed merge would leave the canonical redirect in place while the paperwork said
    // the merge was refused — the worst of both records.
    await expect(
      svc.rejectMerge(id, "changed my mind after execution", ACTOR),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await physician(DUPLICATE)).status).toBe("merged");
  });

  // ── promote ─────────────────────────────────────────────────────────────────────────────────────
  it("promotes a provisional physician into a real canonical and settles the staged row", async () => {
    const provId = await seedProvisional("physician", {
      firstName: "Alan",
      lastName: "Turing",
      credentials: "MD",
      npi: "1000213813",
    });
    const { canonicalId } = await svc.promoteProvisional(provId, ACTOR);
    const canon = await physician(canonicalId);
    expect(canon.first_name).toBe("Alan");
    expect(canon.last_name).toBe("Turing");
    expect(canon.npi).toBe("1000213813");
    expect(canon.status).toBe("active");

    const prov = (await admin.query("SELECT * FROM mdm_provisional WHERE id = $1", [provId]))
      .rows[0];
    expect(prov.resolution).toBe("promoted");
    expect(prov.promoted_canonical_id).toBe(canonicalId);
    expect(prov.resolved_at).not.toBeNull();
  });

  it("promotes facility and payer provisionals too (all three phase-1 canonical kinds)", async () => {
    const fac = await svc.promoteProvisional(
      await seedProvisional("facility", { name: "Mercy Hospital", kind: "hospital" }),
      ACTOR,
    );
    const facRow = (await admin.query("SELECT * FROM facility WHERE id = $1", [fac.canonicalId]))
      .rows[0];
    expect(facRow.name).toBe("Mercy Hospital");
    expect(facRow.kind).toBe("hospital");

    const pay = await svc.promoteProvisional(
      await seedProvisional("payer", {
        name: "Oregon Medicaid",
        kind: "medicaid",
        stateCode: "OR",
      }),
      ACTOR,
    );
    const payRow = (await admin.query("SELECT * FROM payer WHERE id = $1", [pay.canonicalId]))
      .rows[0];
    expect(payRow.name).toBe("Oregon Medicaid");
    expect(payRow.state_code).toBe("OR");
  });

  it("refuses a promotion whose proposed fields are incomplete, leaving the row pending", async () => {
    // A canonical minted with an empty name is worse than a refusal a human can act on.
    const provId = await seedProvisional("physician", { firstName: "  ", lastName: "Turing" });
    await expectPgError(svc.promoteProvisional(provId, ACTOR), /PROVISIONAL_FIELDS_INCOMPLETE/);
    const prov = (await admin.query("SELECT resolution FROM mdm_provisional WHERE id=$1", [provId]))
      .rows[0];
    expect(prov.resolution).toBe("pending");
    expect((await admin.query("SELECT count(*)::int n FROM external_physician")).rows[0].n).toBe(3);
  });

  it("refuses to promote the same provisional twice", async () => {
    const provId = await seedProvisional("physician", { firstName: "Grace", lastName: "Hopper" });
    await svc.promoteProvisional(provId, ACTOR);
    await expectPgError(svc.promoteProvisional(provId, ACTOR), /PROVISIONAL_NOT_PENDING/);
  });

  // ── the privilege floor these functions exist to preserve ───────────────────────────────────────
  it("still refuses a direct canonical write from chartwarden_app (§3.6 unchanged by any of this)", async () => {
    const err = await handle.db
      .execute(`UPDATE external_physician SET status = 'merged' WHERE id = '${DUPLICATE}'` as never)
      .then(
        () => null,
        (e: unknown) => e,
      );
    const cause = (err as { cause?: { message?: string } } | null)?.cause;
    expect(`${cause?.message ?? err}`).toMatch(/permission denied/i);
  });
});
