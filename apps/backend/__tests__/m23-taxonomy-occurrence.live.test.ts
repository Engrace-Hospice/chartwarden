/**
 * #248 — M23's last remaining `handlers-unbound` pair: `m25.taxonomy.unmapped_code_observed` (D13).
 *
 * `buildM23TaxonomyUnmappedCodeObservedConsumer` (`outbox-consumers/m25-taxonomy-unmapped-code-observed.ts`)
 * records one row per delivered occurrence into the new `unmapped_taxonomy_occurrence` table (migration
 * 0255), then — once the org's rolling 30-day count for that CARC code exceeds 50 — dispatches a
 * `m23.taxonomy.unmapped_taxonomy_alert` through the injected `WorkerAlertPort`. Proven here against a
 * real disposable Postgres:
 *   1. a single delivery records an occurrence and does not fire (count 1, well under the threshold);
 *   2. the 51st distinct delivery for the same (org, CARC code) fires exactly once, with the correct
 *      `occurrenceCount`, and the 50th does not;
 *   3. a redelivery of an already-recorded event (same outbox event id) is a true no-op — no second row,
 *      no re-fired alert;
 *   4. an occurrence older than the 30-day window does not count toward the threshold;
 *   5. two different CARC codes in the same org keep independent counts;
 *   6. cross-tenant isolation — org B's occurrences never count toward org A's threshold (RLS).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m23:taxonomy-occurrence:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  M23_TAXONOMY_UNMAPPED_CODE_OBSERVED_ALERT_CODE,
  M23_TAXONOMY_UNMAPPED_CODE_OBSERVED_EVENT,
  buildM23TaxonomyUnmappedCodeObservedConsumer,
} from "../src/modules/23-billing-medicare/outbox-consumers/m25-taxonomy-unmapped-code-observed";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

interface DispatchedAlert {
  readonly alertCode: string;
  readonly severity: string;
  readonly organizationId: string;
  readonly payload: Record<string, unknown>;
}

describe.skipIf(!DB_URL)("#248 — M23 unmapped-taxonomy-occurrence consumer, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 120_000);

  afterAll(async () => {
    await admin.end();
    await handle.pool.end();
  });

  /** Build a fresh consumer with its own alert-recording fake — each test gets an isolated dispatch log. */
  function buildConsumer() {
    const dispatched: DispatchedAlert[] = [];
    const consumer = buildM23TaxonomyUnmappedCodeObservedConsumer({
      db: handle.db,
      alerts: {
        async dispatch(input) {
          dispatched.push(input);
        },
      },
    });
    return { consumer, dispatched };
  }

  function occurrencePayload(overrides: { carcCode?: string; rarcCode?: string | null } = {}) {
    return {
      carcCode: overrides.carcCode ?? "B99",
      rarcCode: overrides.rarcCode ?? null,
      providerEntityId: randomUUID(),
      denialCaseId: randomUUID(),
    };
  }

  it("exposes the right event name and consumer module", () => {
    const { consumer } = buildConsumer();
    expect(consumer.eventTypes).toEqual([M23_TAXONOMY_UNMAPPED_CODE_OBSERVED_EVENT]);
    expect(consumer.consumerModule).toBe("m23");
  });

  it("a single delivery records an occurrence and does not fire the threshold alert", async () => {
    const { consumer, dispatched } = buildConsumer();
    const carcCode = `CARC-${randomUUID().slice(0, 8)}`;

    await consumer.handle({
      id: randomUUID(),
      organizationId: ORG_A,
      payload: occurrencePayload({ carcCode }),
    });

    expect(dispatched).toEqual([]);
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM unmapped_taxonomy_occurrence WHERE organization_id = $1 AND carc_code = $2`,
      [ORG_A, carcCode],
    );
    expect(rows[0].n).toBe(1);
  });

  it("fires exactly once, on the 51st occurrence, with the correct occurrenceCount", async () => {
    const { consumer, dispatched } = buildConsumer();
    const carcCode = `CARC-${randomUUID().slice(0, 8)}`;

    for (let i = 1; i <= 50; i++) {
      await consumer.handle({
        id: randomUUID(),
        organizationId: ORG_A,
        payload: occurrencePayload({ carcCode }),
      });
    }
    expect(dispatched).toEqual([]); // exactly 50 — "exceeds 50" has not yet happened

    await consumer.handle({
      id: randomUUID(),
      organizationId: ORG_A,
      payload: occurrencePayload({ carcCode }),
    });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      alertCode: M23_TAXONOMY_UNMAPPED_CODE_OBSERVED_ALERT_CODE,
      severity: "warn",
      organizationId: ORG_A,
      payload: { carcCode, occurrenceCount: 51, windowDays: 30 },
    });
  });

  it("a redelivery of the same outbox event id is a true no-op — no second row, no re-fired alert", async () => {
    const { consumer, dispatched } = buildConsumer();
    const carcCode = `CARC-${randomUUID().slice(0, 8)}`;
    const eventId = randomUUID();
    const payload = occurrencePayload({ carcCode });

    await consumer.handle({ id: eventId, organizationId: ORG_A, payload });
    await consumer.handle({ id: eventId, organizationId: ORG_A, payload }); // redelivery

    expect(dispatched).toEqual([]);
    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM unmapped_taxonomy_occurrence WHERE organization_id = $1 AND carc_code = $2`,
      [ORG_A, carcCode],
    );
    expect(rows[0].n).toBe(1);
  });

  it("an occurrence older than the 30-day window does not count toward the threshold", async () => {
    const { consumer, dispatched } = buildConsumer();
    const carcCode = `CARC-${randomUUID().slice(0, 8)}`;

    // Seed 50 occurrences directly, back-dated to 31 days ago — outside the rolling window.
    for (let i = 0; i < 50; i++) {
      await admin.query(
        `INSERT INTO unmapped_taxonomy_occurrence
           (organization_id, carc_code, provider_entity_id, denial_case_id, source_event_id, observed_at)
         VALUES ($1, $2, $3, $4, $5, now() - interval '31 days')`,
        [ORG_A, carcCode, randomUUID(), randomUUID(), randomUUID()],
      );
    }

    // A fresh, in-window delivery: the real count-in-window is 1 (the stale 50 don't count), so no fire.
    await consumer.handle({
      id: randomUUID(),
      organizationId: ORG_A,
      payload: occurrencePayload({ carcCode }),
    });
    expect(dispatched).toEqual([]);

    // Bring the org up to 51 IN-WINDOW occurrences for this CARC — now it must fire.
    for (let i = 0; i < 49; i++) {
      await consumer.handle({
        id: randomUUID(),
        organizationId: ORG_A,
        payload: occurrencePayload({ carcCode }),
      });
    }
    expect(dispatched).toEqual([]); // 50 in-window so far

    await consumer.handle({
      id: randomUUID(),
      organizationId: ORG_A,
      payload: occurrencePayload({ carcCode }),
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.payload).toMatchObject({ occurrenceCount: 51 });
  });

  it("two different CARC codes in the same org keep independent counts", async () => {
    const { consumer, dispatched } = buildConsumer();
    const carcA = `CARC-A-${randomUUID().slice(0, 8)}`;
    const carcB = `CARC-B-${randomUUID().slice(0, 8)}`;

    for (let i = 0; i < 51; i++) {
      await consumer.handle({
        id: randomUUID(),
        organizationId: ORG_A,
        payload: occurrencePayload({ carcCode: carcA }),
      });
    }
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]?.payload).toMatchObject({ carcCode: carcA });

    // carcB starts from zero — a single delivery must not fire.
    await consumer.handle({
      id: randomUUID(),
      organizationId: ORG_A,
      payload: occurrencePayload({ carcCode: carcB }),
    });
    expect(dispatched).toHaveLength(1); // unchanged — still only carcA's fire
  });

  it("never counts a sibling org's occurrences toward this org's threshold (RLS)", async () => {
    const { consumer, dispatched } = buildConsumer();
    const carcCode = `CARC-${randomUUID().slice(0, 8)}`;

    // 50 occurrences in ORG_B for the SAME carc code.
    for (let i = 0; i < 50; i++) {
      await consumer.handle({
        id: randomUUID(),
        organizationId: ORG_B,
        payload: occurrencePayload({ carcCode }),
      });
    }
    expect(dispatched).toEqual([]);

    // A single ORG_A delivery for the same carc code must see a count of 1, not 51.
    await consumer.handle({
      id: randomUUID(),
      organizationId: ORG_A,
      payload: occurrencePayload({ carcCode }),
    });
    expect(dispatched).toEqual([]);

    const { rows } = await admin.query(
      `SELECT count(*)::int AS n FROM unmapped_taxonomy_occurrence WHERE organization_id = $1 AND carc_code = $2`,
      [ORG_A, carcCode],
    );
    expect(rows[0].n).toBe(1);
  });

  it("throws on a payload missing a required field, rather than recording a malformed occurrence", async () => {
    const { consumer } = buildConsumer();
    await expect(
      consumer.handle({
        id: randomUUID(),
        organizationId: ORG_A,
        payload: { rarcCode: null, providerEntityId: randomUUID(), denialCaseId: randomUUID() },
      }),
    ).rejects.toThrow(/carcCode/);
  });
});
