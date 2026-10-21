/**
 * GAP-093(a)(b)(c)(d) / GAP-011 — auditor engagements are DURABLE and the M3 `AuditorEngagementReader` is
 * real, LIVE Postgres as `wardenx_app` (NOBYPASSRLS). Proves, on a real database:
 *   1. the engagement store WRITES `auditor_engagement` (create / get / shorten / cancel / enrolment count);
 *   2. the reader says "active" only for the same org, `active` status, inside the window, and resolves
 *      what the engagement covers (explicit patients, tenant-wide) — and answers false/null for a scheduled,
 *      closed, expired or other-tenant engagement;
 *   3. org B's connection cannot read org A's engagement (RLS, not only the query predicate);
 *   4. the session store stamps `engagementId` for an `auditor` session from `session.scope` only, and reads
 *      null for a staff session carrying a stray key.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m3:auditor-engagement:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbSessionContextStore } from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDbAuditorEngagementReader,
  createDbEngagementStore,
} from "../src/modules/03-authorization/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-111111a09301";
const ORG_B = "11111111-1111-4111-8111-111111b09301";
const COMPLIANCE = "22222222-2222-4222-8222-222222a09301";
const AUDITOR = "22222222-2222-4222-8222-222222a09302";
const P1 = "33333333-3333-4333-8333-333333a09301";
const P2 = "33333333-3333-4333-8333-333333a09302";
const NOW = new Date("2026-10-05T12:00:00Z");
const iso = (d: string) => new Date(d).toISOString();

describe.skipIf(!DB_URL)("GAP-093 M3 auditor engagement store + reader — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: ReturnType<typeof createDbEngagementStore>;
  let reader: ReturnType<typeof createDbAuditorEngagementReader>;

  const asCompliance = <T>(fn: () => T): T =>
    runWithRequestContext({ organizationId: ORG_A, userId: COMPLIANCE } as never, fn);
  const create = (over: { startAt?: string; endAt?: string; scope?: unknown } = {}) =>
    asCompliance(() =>
      store.create({
        organizationId: ORG_A,
        engagementType: "cms_survey",
        auditorAgency: "CMS",
        scope: over.scope ?? { patientIds: [P1, P2] },
        startAt: over.startAt ?? iso("2026-10-01T00:00:00Z"),
        endAt: over.endAt ?? iso("2026-10-15T00:00:00Z"),
        createdByUserId: COMPLIANCE,
      }),
    );
  const query = (engagementId: string, organizationId = ORG_A) => ({
    organizationId,
    engagementId,
    auditorUserId: AUDITOR,
    at: NOW.toISOString(),
  });

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
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'g093-a','A','A','active'),($2,'g093-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'c@g093.test'),($2,'a@g093.test')`,
      [COMPLIANCE, AUDITOR],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    store = createDbEngagementStore(handle.db, () => NOW);
    reader = createDbAuditorEngagementReader(handle.db);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("create WRITES auditor_engagement (active when the window already started) and the view hides the server counter", async () => {
    const view = await create({ scope: { patientIds: [P1], enrolledAuditorCount: 99 } });
    expect(view.status).toBe("active");
    expect(view.scope).toEqual({ patientIds: [P1] });
    const { rows } = await admin.query("SELECT status, scope FROM auditor_engagement WHERE id=$1", [
      view.engagementId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].scope.enrolledAuditorCount).toBe(0); // the client's 99 was stripped
  });

  it("a future engagement is created `scheduled`", async () => {
    const view = await create({
      startAt: iso("2026-11-01T00:00:00Z"),
      endAt: iso("2026-11-15T00:00:00Z"),
    });
    expect(view.status).toBe("scheduled");
  });

  it("shortens the window, refuses to extend it, cancels, and counts enrolments atomically", async () => {
    const view = await create();
    await asCompliance(() => store.recordAuditorEnrolled(view.engagementId));
    await asCompliance(() => store.recordAuditorEnrolled(view.engagementId));
    expect((await asCompliance(() => store.summary(view.engagementId)))?.auditorsEnrolled).toBe(2);

    const shortened = await asCompliance(() =>
      store.update(view.engagementId, { endAt: iso("2026-10-10T00:00:00Z") }),
    );
    expect(shortened.endAt).toBe(iso("2026-10-10T00:00:00Z"));
    await expect(
      asCompliance(() => store.update(view.engagementId, { endAt: iso("2026-12-01T00:00:00Z") })),
    ).rejects.toThrow();

    const cancelled = await asCompliance(() => store.update(view.engagementId, { cancel: true }));
    expect(cancelled.status).toBe("cancelled");
  });

  it("the reader: active inside the window, with the covered patients; not for scheduled/closed/cancelled/expired/other-org", async () => {
    const live = await create({ scope: { patientIds: [P1, P2] } });
    expect(await reader.isEngagementActiveForAuditor(query(live.engagementId))).toBe(true);
    expect(await reader.engagementScope(query(live.engagementId))).toEqual({
      tenantWide: false,
      patientIds: [P1, P2],
    });

    const wide = await create({ scope: { tenantWide: true } });
    expect((await reader.engagementScope(query(wide.engagementId)))?.tenantWide).toBe(true);

    const scheduled = await create({
      startAt: iso("2026-11-01T00:00:00Z"),
      endAt: iso("2026-11-15T00:00:00Z"),
    });
    expect(await reader.isEngagementActiveForAuditor(query(scheduled.engagementId))).toBe(false);

    const expired = await create({
      startAt: iso("2026-09-01T00:00:00Z"),
      endAt: iso("2026-09-15T00:00:00Z"),
    });
    expect(await reader.isEngagementActiveForAuditor(query(expired.engagementId))).toBe(false);

    await admin.query("UPDATE auditor_engagement SET status='closed' WHERE id=$1", [
      live.engagementId,
    ]);
    expect(await reader.isEngagementActiveForAuditor(query(live.engagementId))).toBe(false);
    expect(await reader.engagementScope(query(live.engagementId))).toBeNull();
  });

  it("tenant isolation: org B cannot read org A's engagement, by RLS and by predicate", async () => {
    const live = await create();
    expect(await reader.isEngagementActiveForAuditor(query(live.engagementId, ORG_B))).toBe(false);
    expect(await reader.engagementScope(query(live.engagementId, ORG_B))).toBeNull();
  });

  it("an unknown or malformed engagement id is simply not active", async () => {
    expect(await reader.isEngagementActiveForAuditor(query("not-a-uuid"))).toBe(false);
    expect(
      await reader.isEngagementActiveForAuditor(query("99999999-9999-4999-8999-999999999999")),
    ).toBe(false);
  });

  it("the session store stamps engagementId for an auditor session from scope only", async () => {
    const live = await create();
    await admin.query(
      `INSERT INTO session (id,user_id,active_organization_id,token,expires_at,session_class,scope,engagement_start,engagement_end)
       VALUES ('aud-s1',$1,$2,'aud-tok-1',now()+interval '1 hour','auditor',$3::jsonb,now()-interval '1 day',now()+interval '1 day'),
              ('stf-s1',$1,$2,'stf-tok-1',now()+interval '1 hour','staff',$3::jsonb,NULL,NULL)`,
      [AUDITOR, ORG_A, JSON.stringify({ engagementId: live.engagementId })],
    );
    const sessions = createDbSessionContextStore(handle.db);
    const aud = await sessions.read({ orgId: ORG_A }, "aud-s1");
    const stf = await sessions.read({ orgId: ORG_A }, "stf-s1");
    expect(aud?.sessionClass).toBe("auditor");
    expect(aud?.engagementId).toBe(live.engagementId);
    expect(stf?.engagementId).toBeNull();
  });
});
