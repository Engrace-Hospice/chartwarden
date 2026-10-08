/**
 * GAP-052 — LIVE Postgres proof of M17 §4.8 `reassignment-scan` + `caregiver-reminder`:
 *   - approving a PTO that overlaps a published visit emits `m17.reassignment_needed` (reason `pto_approved`)
 *     and `affectedPublishedVisitCount` / `conflictingVisitCount` are real, non-zero counts;
 *   - the cron backstop flags a visit published AFTER approval, and a re-run flags nothing (idempotent);
 *   - non-published / non-overlapping / past visits are never flagged;
 *   - `emitCaregiverRemindersForOrg` emits `m17.caregiver_reminder_due` once per opted-in visit ≤24h out;
 *   - cross-tenant: org A's scan/reminder never reads or writes org B's rows (real NOBYPASSRLS app role).
 * Every publish is validated against the real catalogued payload schema.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m17:reassignment-reminder:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { createDbClient } from "@wardenx/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M17_OUTBOX_EVENTS } from "../src/modules/17-scheduling/events-by-m17";
import { NO_AUTHORITY } from "../src/modules/17-scheduling/routes/own-vs-any";
import { createDbSchedulingBackend } from "../src/modules/17-scheduling/scheduling-route-service-db";
import { M17_SYSTEM_USER_ID } from "../src/modules/17-scheduling/system-actor";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const APPROVER = { ...NO_AUTHORITY, timeOffApprove: true };

interface Fixture {
  pe: string;
  loc: string;
  member: string;
  approver: string;
}

describe.skipIf(!DB_URL)("GAP-052 — M17 reassignment scan + caregiver reminder — LIVE", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbSchedulingBackend>;
  const fx: Record<string, Fixture> = {};

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
  }
  async function seedMembership(orgId: string, slug: string, tag: string, f: Partial<Fixture>) {
    const user = (
      await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
        `gap052-${slug}-${tag}@x.test`,
      ])
    ).rows[0].id as string;
    return (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status, default_provider_entity_id, default_location_ids)
         VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
        [user, orgId, f.pe, JSON.stringify([f.loc])],
      )
    ).rows[0].id as string;
  }
  async function seedOrg(orgId: string, slug: string): Promise<Fixture> {
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)`,
      [orgId, slug, slug],
    );
    const pe = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [orgId, `G52-${slug}`, `Provider ${slug}`, slug === "a" ? "1400000001" : "1400000002"],
      )
    ).rows[0].id as string;
    const loc = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Main','1 Main St','Portland','OR','97201','America/Los_Angeles') RETURNING id`,
        [pe],
      )
    ).rows[0].id as string;
    const member = await seedMembership(orgId, slug, "clin", { pe, loc });
    const approver = await seedMembership(orgId, slug, "appr", { pe, loc });
    return { pe, loc, member, approver };
  }
  async function seedVisit(
    orgId: string,
    startMs: number,
    opts: { status?: string; optIn?: boolean } = {},
  ): Promise<string> {
    const f = fx[orgId] as Fixture;
    return (
      await admin.query(
        `INSERT INTO visit
           (organization_id, provider_entity_id, location_id, patient_id, admission_id,
            assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
            scheduled_started_at, scheduled_ended_at, service_date, status, caregiver_reminder_opt_in)
         VALUES ($1,$2,$3,$4,$5,$6,'rn','routine_visit','patient_home',$7,$8,$9::date,$10,$11)
         RETURNING id`,
        [
          orgId,
          f.pe,
          f.loc,
          crypto.randomUUID(),
          crypto.randomUUID(),
          f.member,
          new Date(startMs).toISOString(),
          new Date(startMs + HOUR).toISOString(),
          new Date(startMs).toISOString().slice(0, 10),
          opts.status ?? "published",
          opts.optIn ?? false,
        ],
      )
    ).rows[0].id as string;
  }
  async function requestAndApprove(orgId: string, startMs: number, endMs: number) {
    const f = fx[orgId] as Fixture;
    const req = await svc.requestTimeOff(
      orgId,
      f.member,
      {
        membershipId: f.member,
        kind: "pto",
        startsAt: new Date(startMs).toISOString(),
        endsAt: new Date(endMs).toISOString(),
      },
      NO_AUTHORITY,
    );
    await svc.approveTimeOff(orgId, f.approver, req.id, APPROVER);
    return req.id;
  }
  async function events(orgId: string, eventType: string) {
    const { rows } = await admin.query(
      `SELECT aggregate_id, payload FROM outbox_event WHERE organization_id=$1 AND event_type=$2 ORDER BY created_at`,
      [orgId, eventType],
    );
    return rows as { aggregate_id: string; payload: Record<string, unknown> }[];
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    fx[ORG_A] = await seedOrg(ORG_A, "a");
    fx[ORG_B] = await seedOrg(ORG_B, "b");
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const catalog = new Map(M17_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
    const outbox = {
      async publish(
        tx: unknown,
        input: {
          eventName: string;
          payload: Record<string, unknown>;
          organizationId: string;
          aggregateKind: string;
          aggregateId: string;
        },
      ) {
        const entry = catalog.get(input.eventName as `m${number}.${string}.${string}`);
        if (!entry) throw new Error(`undeclared event ${input.eventName}`);
        if (!Value.Check(entry.payloadSchema, input.payload)) {
          throw new Error(`payload violates catalog schema for ${input.eventName}`);
        }
        await (tx as typeof handle.db).execute(sql`
          INSERT INTO outbox_event (organization_id, event_type, aggregate_kind, aggregate_id, payload)
          VALUES (${input.organizationId}, ${input.eventName}, ${input.aggregateKind},
                  ${input.aggregateId}, ${JSON.stringify(input.payload)}::jsonb)`);
      },
    };
    svc = createDbSchedulingBackend(handle.db, outbox);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("approving PTO flags overlapping published visits with real counts; others untouched", async () => {
    const base = Date.now() + 10 * DAY;
    const inside1 = await seedVisit(ORG_A, base + 2 * HOUR);
    const inside2 = await seedVisit(ORG_A, base + 6 * HOUR);
    const draft = await seedVisit(ORG_A, base + 4 * HOUR, { status: "proposed" });
    const outside = await seedVisit(ORG_A, base + 2 * DAY);
    const ptoId = await requestAndApprove(ORG_A, base, base + DAY);

    const flagged = (await events(ORG_A, "m17.reassignment_needed")).map((e) => e.aggregate_id);
    expect(flagged.sort()).toEqual([inside1, inside2].sort());
    expect(flagged).not.toContain(draft);
    expect(flagged).not.toContain(outside);
    const [e] = await events(ORG_A, "m17.reassignment_needed");
    expect(e?.payload).toMatchObject({
      affectedMembershipId: fx[ORG_A]?.member,
      reason: "pto_approved",
    });
    const approved = (await events(ORG_A, "m17.time_off.approved")).find(
      (x) => x.aggregate_id === ptoId,
    );
    expect(approved?.payload.affectedPublishedVisitCount).toBe(2);
    const { rows } = await admin.query(
      "SELECT reassignment_flagged_time_off_id FROM visit WHERE id=$1",
      [inside1],
    );
    expect(rows[0].reassignment_flagged_time_off_id).toBe(ptoId);
  });

  it("request reports the real conflictingVisitCount", async () => {
    const base = Date.now() + 20 * DAY;
    await seedVisit(ORG_A, base + HOUR);
    const req = await svc.requestTimeOff(
      ORG_A,
      (fx[ORG_A] as Fixture).member,
      {
        membershipId: (fx[ORG_A] as Fixture).member,
        kind: "pto",
        startsAt: new Date(base).toISOString(),
        endsAt: new Date(base + DAY).toISOString(),
      },
      NO_AUTHORITY,
    );
    const [ev] = (await events(ORG_A, "m17.time_off.requested")).filter(
      (x) => x.aggregate_id === req.id,
    );
    expect(ev?.payload.conflictingVisitCount).toBe(1);
  });

  it("cron backstop flags a later-published visit once; a re-run is a no-op; org B is untouched", async () => {
    const base = Date.now() + 40 * DAY;
    await requestAndApprove(ORG_A, base, base + DAY);
    const late = await seedVisit(ORG_A, base + 3 * HOUR); // published after the approval
    const bVisit = await seedVisit(ORG_B, base + 3 * HOUR);
    await requestAndApprove(ORG_B, base + 10 * DAY, base + 11 * DAY); // B's own PTO, no overlap

    const before = (await events(ORG_A, "m17.reassignment_needed")).length;
    const first = await svc.scanTimeOffReassignmentsForOrg(ORG_A, M17_SYSTEM_USER_ID);
    expect(first.visitsFlagged).toBe(1);
    const afterFirst = await events(ORG_A, "m17.reassignment_needed");
    expect(afterFirst).toHaveLength(before + 1);
    expect(afterFirst.at(-1)?.aggregate_id).toBe(late);

    const second = await svc.scanTimeOffReassignmentsForOrg(ORG_A, M17_SYSTEM_USER_ID);
    expect(second).toEqual({ timeOffsScanned: 0, visitsFlagged: 0 });
    expect(await events(ORG_A, "m17.reassignment_needed")).toHaveLength(before + 1);

    // cross-tenant: org B's visit was never reached by the org-A scan, and has no flag stamp.
    expect(
      (await events(ORG_B, "m17.reassignment_needed")).map((e) => e.aggregate_id),
    ).not.toContain(bVisit);
    const { rows } = await admin.query("SELECT reassignment_flagged_at FROM visit WHERE id=$1", [
      bVisit,
    ]);
    expect(rows[0].reassignment_flagged_at).toBeNull();
  });

  it("caregiver reminder: opted-in published visits ≤24h out, once, tenant-scoped", async () => {
    const now = new Date();
    const due = await seedVisit(ORG_A, now.getTime() + 6 * HOUR, { optIn: true });
    await seedVisit(ORG_A, now.getTime() + 8 * HOUR); // not opted in
    await seedVisit(ORG_A, now.getTime() + 3 * DAY, { optIn: true }); // too far out
    await seedVisit(ORG_A, now.getTime() + 5 * HOUR, { optIn: true, status: "cancelled" });
    const dueB = await seedVisit(ORG_B, now.getTime() + 6 * HOUR, { optIn: true });

    const first = await svc.emitCaregiverRemindersForOrg(ORG_A, M17_SYSTEM_USER_ID, { now });
    expect(first.remindersEmitted).toBe(1);
    const ev = await events(ORG_A, "m17.caregiver_reminder_due");
    expect(ev.map((e) => e.aggregate_id)).toEqual([due]);
    expect(ev[0]?.payload.channel).toBe("email");

    expect((await svc.emitCaregiverRemindersForOrg(ORG_A, M17_SYSTEM_USER_ID, { now })).remindersEmitted).toBe(0);
    expect(await events(ORG_A, "m17.caregiver_reminder_due")).toHaveLength(1);

    // org B was not touched by org A's run, and still gets its own when its turn comes.
    expect(await events(ORG_B, "m17.caregiver_reminder_due")).toHaveLength(0);
    expect((await svc.emitCaregiverRemindersForOrg(ORG_B, M17_SYSTEM_USER_ID, { now })).remindersEmitted).toBe(1);
    expect((await events(ORG_B, "m17.caregiver_reminder_due"))[0]?.aggregate_id).toBe(dueB);
  });

  it("stale-visit sweep flags a stuck visit once per episode, re-arms on a new episode or after the re-nag window", async () => {
    const now = new Date();
    const started = new Date(now.getTime() - 72 * HOUR);
    const stuck = await seedVisit(ORG_A, started.getTime(), { status: "in_visit" });
    await admin.query("UPDATE visit SET actual_started_at=$2 WHERE id=$1", [stuck, started]);
    const stuckB = await seedVisit(ORG_B, started.getTime(), { status: "in_visit" });
    await admin.query("UPDATE visit SET actual_started_at=$2 WHERE id=$1", [stuckB, started]);
    const stale = async (org: string) =>
      (await events(org, "m17.stale_visit_detected")).filter((e) => e.aggregate_id === stuck);

    expect((await svc.scanVisitAttentionForOrg(ORG_A, "", { now })).staleVisits).toBe(1);
    expect(await stale(ORG_A)).toHaveLength(1);
    // the next 15-minute runs (and a replay) re-emit nothing for the same stuck episode
    for (const minutes of [0, 15, 30]) {
      const later = new Date(now.getTime() + minutes * 60_000);
      expect((await svc.scanVisitAttentionForOrg(ORG_A, "", { now: later })).staleVisits).toBe(0);
    }
    expect(await stale(ORG_A)).toHaveLength(1);
    // org B's visit was never reached by org A's sweep
    expect(await events(ORG_B, "m17.stale_visit_detected")).toHaveLength(0);

    // a new stuck episode (different actual_started_at) is flagged again
    const restarted = new Date(now.getTime() - 60 * HOUR);
    await admin.query("UPDATE visit SET actual_started_at=$2 WHERE id=$1", [stuck, restarted]);
    expect((await svc.scanVisitAttentionForOrg(ORG_A, "", { now })).staleVisits).toBe(1);
    expect(await stale(ORG_A)).toHaveLength(2);

    // the same episode is re-nagged once the 7-day window elapses
    const nextWeek = new Date(now.getTime() + 8 * DAY);
    expect((await svc.scanVisitAttentionForOrg(ORG_A, "", { now: nextWeek })).staleVisits).toBe(1);
    expect(await stale(ORG_A)).toHaveLength(3);
  });
});
