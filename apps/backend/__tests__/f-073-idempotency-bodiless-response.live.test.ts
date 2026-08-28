/**
 * F-073 (#182) — a COMPLETE idempotency record may have no response BODY.
 *
 * 24 backend routes answer `code(204)`, and `packages/ui/src/core/api/client.ts` attaches an
 * `Idempotency-Key` to EVERY mutating request (POST/PUT/PATCH/DELETE alike), so all 24 ran the
 * completion path with `body: undefined`. Drizzle omits undefined keys from a `.set()`, so
 * `response_body` was never named in the UPDATE, stayed SQL NULL, and tripped
 * `idempotency_key_complete_has_response` — which `0121` wrote for exactly two shapes ("claimed,
 * still running" and "finished with a JSON body") and never for the third the platform serves.
 *
 * The failure lands in `onSend`, AFTER the handler committed: the client got a 500 for a write that
 * had already happened, and the key was left `pending`, answering 409 to every retry for its whole
 * 24h TTL. Observed on a live stack while building #91's M22 tag row — `document_tag` was empty and
 * the UI said the action could not be completed.
 *
 * THIS SUITE IS LIVE BY NECESSITY, not by preference. `createInMemoryIdempotencyStore` — the slice
 * and test default — is a `Map` with no constraint, so it accepts `undefined` happily and every unit,
 * DOM and inject test passed throughout. The two stores disagree only under Postgres, which is where
 * the CHECK lives.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:f073:idempotency-bodiless:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import type { IdempotencyStore } from "@wardenx/shared";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f0730001";
const ORG_B = "22222222-2222-4222-8222-2222f0730002";

describe.skipIf(!DB_URL)("F-073 bodiless idempotent responses — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: IdempotencyStore;

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
      `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES
         ($1,'f073-a','Alpha Hospice LLC','Alpha Hospice','active'),
         ($2,'f073-b','Beta Hospice LLC','Beta Hospice','active')`,
      [ORG_A, ORG_B],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    store = createDbIdempotencyStore(handle.db);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("completes a 204 — the write the CHECK constraint used to refuse", async () => {
    const key = "f073-204";
    await store.putPending(ORG_A, key, "hash-204");
    // `body: undefined` is exactly what `applyIdempotency`'s onSend builds for a bodiless reply.
    await expect(
      store.complete(ORG_A, key, { status: "204", body: undefined }),
    ).resolves.toBeUndefined();

    const { rows } = await admin.query<{ state: string; status: string; body: unknown }>(
      `SELECT state::text AS state, response_status AS status, response_body AS body
         FROM idempotency_key WHERE organization_id = $1 AND key = $2`,
      [ORG_A, key],
    );
    expect(rows[0]?.state).toBe("complete");
    expect(rows[0]?.status).toBe("204");
    // NULL, not the jsonb value `null` — the response genuinely had no body.
    expect(rows[0]?.body).toBeNull();
  });

  it("replays a 204 as bodiless, never as the JSON value null", async () => {
    const key = "f073-204-replay";
    await store.putPending(ORG_A, key, "hash-replay");
    await store.complete(ORG_A, key, { status: "204", body: undefined });

    const record = await store.load(ORG_A, key);
    expect(record?.state).toBe("complete");
    if (record?.state !== "complete") throw new Error("unreachable");
    expect(record.response.status).toBe("204");
    // `undefined` and `null` are NOT interchangeable here: `reply.send(null)` writes the four bytes
    // `null` where the original response wrote nothing at all.
    expect(record.response.body).toBeUndefined();
    expect(record.response.body).not.toBeNull();
  });

  it("still refuses a complete record with no STATUS — the half of the rule that was right", async () => {
    await expect(
      admin.query(
        `INSERT INTO idempotency_key (organization_id, key, request_hash, state, response_status,
           response_body, expires_at)
         VALUES ($1,'f073-no-status','h','complete',NULL,NULL, now() + interval '1 day')`,
        [ORG_A],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("still refuses a PENDING record that pretends to carry a response", async () => {
    await expect(
      admin.query(
        `INSERT INTO idempotency_key (organization_id, key, request_hash, state, response_status,
           response_body, expires_at)
         VALUES ($1,'f073-pending-with-body','h','pending','204',NULL, now() + interval '1 day')`,
        [ORG_A],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("a body-carrying response is unaffected — 201 still round-trips its JSON", async () => {
    const key = "f073-201";
    await store.putPending(ORG_A, key, "hash-201");
    await store.complete(ORG_A, key, { status: "201", body: { id: "abc", created: true } });
    const record = await store.load(ORG_A, key);
    if (record?.state !== "complete") throw new Error("expected a complete record");
    expect(record.response.status).toBe("201");
    expect(record.response.body).toEqual({ id: "abc", created: true });
  });

  it("RLS: a bodiless record is invisible to another tenant", async () => {
    const key = "f073-cross-tenant";
    await store.putPending(ORG_A, key, "hash-x");
    await store.complete(ORG_A, key, { status: "204", body: undefined });
    expect(await store.load(ORG_B, key)).toBeNull();
  });
});
