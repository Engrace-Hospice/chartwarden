/**
 * GAP-057 follow-up (M19 §4.8) — the four non-Tier-1 crons, LIVE: `m19.callback-sla.cron`,
 * `m19.awaiting-callback-timeout.cron`, `m19.close-documented.cron` and `m19.escalation-sla`.
 *
 * THE FINDING. Batch 10 built only the Tier-1 crons. A caller left in `awaiting_callback` was never chased, never
 * timed out; a `documented` call never closed (`closeCall` had no caller); an escalation nobody acknowledged
 * raised no page.
 *
 * WHY LIVE. The due predicates, the per-call `FOR UPDATE` + version-guarded writes, the DB forward-transition
 * trigger (migration 0362 adds `awaiting_callback -> disposition_pending`), the `auto_timeout` history column,
 * the outbox row committed in the same org transaction and the cross-tenant isolation are statements about
 * Postgres and RLS — proven on the real NOBYPASSRLS `wardenx_app` role with the REAL catalog-validating publisher
 * (never NOOP_OUTBOX), the audited write running as the typed NULL system actor.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m19:triage-crons:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { type DbClient, createDbClient, schema } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type M19TriageCronDeps,
  M19_OUTBOX_EVENTS,
  runAwaitingCallbackTimeoutTick,
  runCallbackSlaTick,
  runCloseDocumentedTick,
  runEscalationSlaTick,
} from "../src/modules/19-oncall/index";
import { MAX_TRIAGE_ITEMS_PER_ORG_PER_TICK } from "../src/modules/19-oncall/jobs/triage-cron-common";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111b11a19c0";
const ORG_B = "22222222-2222-4222-8222-2222b11b19c0";

const NOW = new Date("2026-10-06T03:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

type Seed = { pe: string; member: string; shift: string };

describe.skipIf(!DB_URL)("GAP-057 follow-up M19 §4.8 triage crons — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  const seeded: Record<string, Seed> = {};

  const depsFor = (orgs: readonly string[]): M19TriageCronDeps => {
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M19_OUTBOX_EVENTS]));
    return {
      db: handle.db,
      activeOrgs: {
        listActiveOrgs: async () => orgs.map((organizationId) => ({ organizationId })),
      },
      outbox: { publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m19" }) },
      now: () => NOW,
    };
  };

  /** Insert a call straight into `state` (admin connection: the DB trigger guards UPDATEs, not INSERTs). */
  async function insertCall(
    org: string,
    state: string,
    opts: { documentedAt?: Date; waitingSince?: Date } = {},
  ): Promise<string> {
    const s = seeded[org] as Seed;
    const documented = state === "documented";
    const { rows } = await admin.query(
      `INSERT INTO triage_call
         (organization_id, provider_entity_id, on_call_shift_id, caller_kind, inbound_channel, state,
          disposition, documented_at, opened_at)
       VALUES ($1,$2,$3,'caregiver','phone',$4,$5,$6,$7) RETURNING id`,
      [
        org,
        s.pe,
        s.shift,
        state,
        documented ? "caregiver_education_only" : null,
        documented ? (opts.documentedAt ?? minutesAgo(31)) : null,
        minutesAgo(600),
      ],
    );
    const id = rows[0].id as string;
    if (opts.waitingSince)
      await insertHistory(org, id, "protocol_in_progress", "awaiting_callback", opts.waitingSince);
    return id;
  }

  async function insertHistory(org: string, callId: string, from: string, to: string, at: Date) {
    const s = seeded[org] as Seed;
    await admin.query(
      `INSERT INTO triage_call_state_history
         (organization_id, provider_entity_id, triage_call_id, from_state, to_state, transitioned_at, actor_membership_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [org, s.pe, callId, from, to, at, s.member],
    );
  }

  async function insertEscalation(
    org: string,
    callId: string,
    opts: {
      tier?: string;
      trigger?: string;
      escalatedAt: Date;
      acknowledgedAt?: Date | null;
      resolvedAt?: Date | null;
    },
  ): Promise<string> {
    const s = seeded[org] as Seed;
    const { rows } = await admin.query(
      `INSERT INTO triage_escalation
         (organization_id, provider_entity_id, triage_call_id, tier, trigger_kind,
          escalated_to_membership_id, escalated_at, acknowledged_at, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        org,
        s.pe,
        callId,
        opts.tier ?? "tier_1_rn_supervisor",
        opts.trigger ?? "manual",
        s.member,
        opts.escalatedAt,
        opts.acknowledgedAt ?? null,
        opts.resolvedAt ?? null,
      ],
    );
    return rows[0].id as string;
  }

  const call = async (id: string) =>
    (await admin.query("SELECT * FROM triage_call WHERE id = $1", [id])).rows[0];
  const esc = async (id: string) =>
    (await admin.query("SELECT * FROM triage_escalation WHERE id = $1", [id])).rows[0];
  const history = async (callId: string) =>
    (
      await admin.query(
        "SELECT * FROM triage_call_state_history WHERE triage_call_id = $1 ORDER BY transitioned_at, created_at",
        [callId],
      )
    ).rows;
  const outbox = async (org: string, eventType: string) =>
    (
      await admin.query(
        "SELECT payload, aggregate_id FROM outbox_event WHERE organization_id = $1 AND event_type = $2",
        [org, eventType],
      )
    ).rows;
  const setPolicy = (org: string, col: string, json: string) =>
    admin.query(`UPDATE tenant_oncall_policy SET ${col} = $2::jsonb WHERE organization_id = $1`, [
      org,
      json,
    ]);

  async function applyMigrations() {
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
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
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'b11-a','A','A','active'),($2,'b11-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    let n = 0;
    for (const org of [ORG_A, ORG_B]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `b11-${n++}@x.test`,
        ])
      ).rows[0].id as string;
      const member = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end, status)
           VALUES ($1,$2,$3,$4,'enc','12-31','active') RETURNING id`,
          [
            org,
            `CCN-B11-${org.slice(0, 4)}`,
            `B11 ${org.slice(0, 4)}`,
            `NPI-B11-${org.slice(0, 4)}`,
          ],
        )
      ).rows[0].id as string;
      await admin.query(
        `INSERT INTO tenant_oncall_policy
           (organization_id, provider_entity_id, model, escalation_tiers, callback_sla_per_severity)
         VALUES ($1,$2,'direct','{}'::jsonb,'{}'::jsonb)`,
        [org, pe],
      );
      const shift = (
        await admin.query(
          `INSERT INTO on_call_shift
             (organization_id, provider_entity_id, shift_starts_at, shift_ends_at, discipline,
              primary_on_call_membership_id, policy_snapshot, status, opened_at)
           VALUES ($1,$2,$3,$4,'clinical_rn',$5,'{"provisional":true}'::jsonb,'active',$3) RETURNING id`,
          [org, pe, minutesAgo(700), new Date(NOW.getTime() + 600 * 60_000), member],
        )
      ).rows[0].id as string;
      seeded[org] = { pe, member, shift };
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM triage_escalation");
    await admin.query("DELETE FROM triage_call_state_history");
    await admin.query("DELETE FROM triage_call");
    await admin.query("DELETE FROM outbox_event");
    await setPolicy(ORG_A, "callback_sla_per_severity", "{}");
    await setPolicy(ORG_A, "escalation_tiers", "{}");
    await setPolicy(ORG_A, "state_overrides", "{}");
  });

  describe("callback-sla", () => {
    const breaches = (org: string) => outbox(org, "m19.triage_call.callback_sla_breached");

    it("pages a call waiting past the callback target (default 30 min), once per wait", async () => {
      const due = await insertCall(ORG_A, "awaiting_callback", { waitingSince: minutesAgo(45) });
      const fresh = await insertCall(ORG_A, "awaiting_callback", { waitingSince: minutesAgo(10) });

      const first = await runCallbackSlaTick(depsFor([ORG_A]));
      expect(first.get(ORG_A)).toEqual({ acted: 1, skipped: 1 });
      const events = await breaches(ORG_A);
      expect(events).toHaveLength(1);
      expect(events[0].aggregate_id).toBe(due);
      expect(events[0].payload).toMatchObject({
        triageCallId: due,
        slaTargetMinutes: 30,
        minutesElapsed: 45,
      });
      expect((await call(due)).callback_sla_breached_at).not.toBeNull();
      expect((await call(fresh)).callback_sla_breached_at).toBeNull();

      // Idempotent: the same wait is not re-paged by a later tick.
      await runCallbackSlaTick(depsFor([ORG_A]));
      expect(await breaches(ORG_A)).toHaveLength(1);
    });

    it("uses the tenant's tightest target (clinical_urgent)", async () => {
      await setPolicy(
        ORG_A,
        "callback_sla_per_severity",
        '{"clinical_urgent":5,"clinical_routine":120}',
      );
      await insertCall(ORG_A, "awaiting_callback", { waitingSince: minutesAgo(8) });
      await runCallbackSlaTick(depsFor([ORG_A]));
      expect((await breaches(ORG_A))[0].payload).toMatchObject({ slaTargetMinutes: 5 });
    });

    it("a NEW wait of an already-paged call is judged afresh; the same wait is not re-paged", async () => {
      // Call A was paged during an earlier wait (marker -60), resumed (-50) and went on hold again (-40).
      const rewaited = await insertCall(ORG_A, "awaiting_callback", {
        waitingSince: minutesAgo(100),
      });
      await insertHistory(
        ORG_A,
        rewaited,
        "awaiting_callback",
        "protocol_in_progress",
        minutesAgo(50),
      );
      await insertHistory(
        ORG_A,
        rewaited,
        "protocol_in_progress",
        "awaiting_callback",
        minutesAgo(40),
      );
      await admin.query("UPDATE triage_call SET callback_sla_breached_at = $2 WHERE id = $1", [
        rewaited,
        minutesAgo(60),
      ]);
      // Call B was paged for its CURRENT wait (marker -30, entered -40): not paged again.
      const samewait = await insertCall(ORG_A, "awaiting_callback", {
        waitingSince: minutesAgo(40),
      });
      await admin.query("UPDATE triage_call SET callback_sla_breached_at = $2 WHERE id = $1", [
        samewait,
        minutesAgo(30),
      ]);

      await runCallbackSlaTick(depsFor([ORG_A]));

      const events = await breaches(ORG_A);
      expect(events).toHaveLength(1);
      expect(events[0].aggregate_id).toBe(rewaited);
      expect(events[0].payload).toMatchObject({ minutesElapsed: 40 });
    });

    it("failure isolation: one org's failing publish rolls that org back (no event, no marker) and does not stop the other", async () => {
      const a = await insertCall(ORG_A, "awaiting_callback", { waitingSince: minutesAgo(90) });
      const b = await insertCall(ORG_B, "awaiting_callback", { waitingSince: minutesAgo(90) });
      const base = depsFor([ORG_A, ORG_B]);
      const deps: M19TriageCronDeps = {
        ...base,
        outbox: {
          publish: async (tx, e) => {
            if (e.organizationId === ORG_A) throw new Error("boom");
            return base.outbox.publish(tx, e);
          },
        },
      };
      await expect(runCallbackSlaTick(deps)).rejects.toThrow(/M19_CALLBACK_SLA/);
      expect(await breaches(ORG_B)).toHaveLength(1);
      expect((await call(b)).callback_sla_breached_at).not.toBeNull();
      expect(await breaches(ORG_A)).toHaveLength(0);
      expect((await call(a)).callback_sla_breached_at).toBeNull();
    });

    it("ignores calls that are not awaiting a callback", async () => {
      await insertCall(ORG_A, "protocol_in_progress");
      await insertCall(ORG_A, "disposition_pending");
      await runCallbackSlaTick(depsFor([ORG_A]));
      expect(await breaches(ORG_A)).toHaveLength(0);
    });

    it("cross-tenant: a tick scoped to org A never pages (or marks) org B's call", async () => {
      const b = await insertCall(ORG_B, "awaiting_callback", { waitingSince: minutesAgo(90) });
      await runCallbackSlaTick(depsFor([ORG_A]));
      expect(await breaches(ORG_B)).toHaveLength(0);
      expect((await call(b)).callback_sla_breached_at).toBeNull();
    });
  });

  describe("awaiting-callback-timeout", () => {
    it("advances a call past the 60-min grace to disposition_pending with a system, auto_timeout history row; version bumped", async () => {
      const stale = await insertCall(ORG_A, "awaiting_callback", { waitingSince: minutesAgo(75) });
      const fresh = await insertCall(ORG_A, "awaiting_callback", { waitingSince: minutesAgo(30) });
      const before = (await call(stale)).version as number;

      const result = await runAwaitingCallbackTimeoutTick(depsFor([ORG_A]));
      expect(result.get(ORG_A)).toEqual({ acted: 1, skipped: 1 });

      const row = await call(stale);
      expect(row.state).toBe("disposition_pending");
      expect(row.version).toBe(before + 1);
      const last = (await history(stale)).at(-1);
      expect(last).toMatchObject({
        from_state: "awaiting_callback",
        to_state: "disposition_pending",
        system_actor: true,
        auto_timeout: true,
        actor_membership_id: null,
      });
      expect((await call(fresh)).state).toBe("awaiting_callback");
    });

    it("is idempotent: a re-run changes nothing and writes no second history row", async () => {
      const id = await insertCall(ORG_A, "awaiting_callback", { waitingSince: minutesAgo(75) });
      await runAwaitingCallbackTimeoutTick(depsFor([ORG_A]));
      const rows = (await history(id)).length;
      const second = await runAwaitingCallbackTimeoutTick(depsFor([ORG_A]));
      expect(second.get(ORG_A)).toEqual({ acted: 0, skipped: 0 });
      expect((await history(id)).length).toBe(rows);
    });

    it("a tenant may TIGHTEN the grace (state_overrides) but never loosen it past 60 min", async () => {
      await setPolicy(ORG_A, "state_overrides", '{"awaitingCallbackGraceMinutes":20}');
      const tight = await insertCall(ORG_A, "awaiting_callback", { waitingSince: minutesAgo(25) });
      await runAwaitingCallbackTimeoutTick(depsFor([ORG_A]));
      expect((await call(tight)).state).toBe("disposition_pending");

      await setPolicy(ORG_A, "state_overrides", '{"awaitingCallbackGraceMinutes":600}');
      const loose = await insertCall(ORG_A, "awaiting_callback", { waitingSince: minutesAgo(70) });
      await runAwaitingCallbackTimeoutTick(depsFor([ORG_A]));
      expect((await call(loose)).state).toBe("disposition_pending"); // capped at 60
    });

    it("cross-tenant: a tick scoped to org A never advances org B's stale call", async () => {
      const b = await insertCall(ORG_B, "awaiting_callback", { waitingSince: minutesAgo(200) });
      await runAwaitingCallbackTimeoutTick(depsFor([ORG_A]));
      expect((await call(b)).state).toBe("awaiting_callback");
    });
  });

  describe("close-documented", () => {
    const closed = (org: string) => outbox(org, "m19.triage_call.closed");

    it("closes a documented call past the 30-min grace: closed_at, system history row, closed event; an in-grace call is untouched", async () => {
      const due = await insertCall(ORG_A, "documented", { documentedAt: minutesAgo(31) });
      const inGrace = await insertCall(ORG_A, "documented", { documentedAt: minutesAgo(10) });

      const result = await runCloseDocumentedTick(depsFor([ORG_A]));
      expect(result.get(ORG_A)).toEqual({ acted: 1, skipped: 0 });

      const row = await call(due);
      expect(row.state).toBe("closed");
      expect(new Date(row.closed_at).toISOString()).toBe(NOW.toISOString());
      expect((await history(due)).at(-1)).toMatchObject({
        from_state: "documented",
        to_state: "closed",
        system_actor: true,
        actor_membership_id: null,
      });
      const events = await closed(ORG_A);
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        triageCallId: due,
        finalDisposition: "caregiver_education_only",
      });
      expect((await call(inGrace)).state).toBe("documented");
    });

    it("is idempotent: a re-run closes nothing and publishes nothing more", async () => {
      await insertCall(ORG_A, "documented");
      await runCloseDocumentedTick(depsFor([ORG_A]));
      const second = await runCloseDocumentedTick(depsFor([ORG_A]));
      expect(second.get(ORG_A)).toEqual({ acted: 0, skipped: 0 });
      expect(await closed(ORG_A)).toHaveLength(1);
    });

    it("never closes around an unresolved mandatory or unacknowledged escalation; resolves acknowledged non-mandatory ones with the close", async () => {
      const mandatory = await insertCall(ORG_A, "documented");
      await insertEscalation(ORG_A, mandatory, {
        trigger: "mandatory_protocol",
        escalatedAt: minutesAgo(200),
        acknowledgedAt: minutesAgo(190),
      });
      const unacked = await insertCall(ORG_A, "documented");
      await insertEscalation(ORG_A, unacked, { escalatedAt: minutesAgo(200) });
      const okCall = await insertCall(ORG_A, "documented");
      const ackedEsc = await insertEscalation(ORG_A, okCall, {
        escalatedAt: minutesAgo(200),
        acknowledgedAt: minutesAgo(190),
      });

      await runCloseDocumentedTick(depsFor([ORG_A]));

      expect((await call(mandatory)).state).toBe("documented");
      expect((await call(unacked)).state).toBe("documented");
      expect((await call(okCall)).state).toBe("closed");
      expect((await esc(ackedEsc)).resolved_at).not.toBeNull();
    });

    it("failure isolation: a failing close publish in one org rolls that call back whole and does not stop the other org", async () => {
      const a = await insertCall(ORG_A, "documented");
      const b = await insertCall(ORG_B, "documented");
      const base = depsFor([ORG_A, ORG_B]);
      const deps: M19TriageCronDeps = {
        ...base,
        outbox: {
          publish: async (tx, e) => {
            if (e.organizationId === ORG_A) throw new Error("boom");
            return base.outbox.publish(tx, e);
          },
        },
      };
      await expect(runCloseDocumentedTick(deps)).rejects.toThrow(/M19_CLOSE_DOCUMENTED/);
      expect((await call(b)).state).toBe("closed");
      expect((await call(a)).state).toBe("documented");
      expect((await history(a)).filter((h) => h.to_state === "closed")).toHaveLength(0);
    });

    it("is bounded: at most MAX_TRIAGE_ITEMS_PER_ORG_PER_TICK per org per tick, the rest drain next tick", async () => {
      const total = MAX_TRIAGE_ITEMS_PER_ORG_PER_TICK + 3;
      for (let i = 0; i < total; i++) await insertCall(ORG_A, "documented");
      const first = await runCloseDocumentedTick(depsFor([ORG_A]));
      expect(first.get(ORG_A)?.acted).toBe(MAX_TRIAGE_ITEMS_PER_ORG_PER_TICK);
      const second = await runCloseDocumentedTick(depsFor([ORG_A]));
      expect(second.get(ORG_A)?.acted).toBe(3);
    });

    it("cross-tenant: a tick scoped to org A never closes org B's documented call", async () => {
      const b = await insertCall(ORG_B, "documented");
      await runCloseDocumentedTick(depsFor([ORG_A]));
      expect((await call(b)).state).toBe("documented");
      expect(await closed(ORG_B)).toHaveLength(0);
    });
  });

  describe("escalation-sla", () => {
    const breaches = (org: string) => outbox(org, "m19.triage_call.escalation_sla_breached");

    it("pages an unacknowledged escalation past its tier SLA (tier_1 default 15 min); acknowledged/resolved/in-SLA rows are quiet", async () => {
      const c = await insertCall(ORG_A, "disposition_pending");
      const late = await insertEscalation(ORG_A, c, { escalatedAt: minutesAgo(20) });
      await insertEscalation(ORG_A, c, { escalatedAt: minutesAgo(5) });
      await insertEscalation(ORG_A, c, {
        escalatedAt: minutesAgo(60),
        acknowledgedAt: minutesAgo(50),
      });

      const result = await runEscalationSlaTick(depsFor([ORG_A]));
      expect(result.get(ORG_A)).toEqual({ acted: 1, skipped: 1 });
      const events = await breaches(ORG_A);
      expect(events).toHaveLength(1);
      expect(events[0].aggregate_id).toBe(late);
      expect(events[0].payload).toMatchObject({
        triageCallId: c,
        escalationId: late,
        tier: "tier_1_rn_supervisor",
        mandatory: false,
        slaTargetMinutes: 15,
        minutesOpen: 20,
      });
      expect((await esc(late)).sla_breached_at).not.toBeNull();
    });

    it("uses the tenant ladder's slaMinutes, and holds a mandatory (D7) row to the tightest ceiling", async () => {
      await setPolicy(
        ORG_A,
        "escalation_tiers",
        '{"tier_2_clinical_manager":{"slaMinutes":90},"tier_3_medical_director":{"slaMinutes":120}}',
      );
      const c = await insertCall(ORG_A, "disposition_pending");
      await insertEscalation(ORG_A, c, {
        tier: "tier_2_clinical_manager",
        escalatedAt: minutesAgo(60),
      });
      const mand = await insertEscalation(ORG_A, c, {
        tier: "tier_3_medical_director",
        trigger: "mandatory_protocol",
        escalatedAt: minutesAgo(20),
      });
      await runEscalationSlaTick(depsFor([ORG_A]));
      const events = await breaches(ORG_A);
      expect(events).toHaveLength(1); // the 60-min tier_2 row is inside its 90-min SLA
      expect(events[0].payload).toMatchObject({
        escalationId: mand,
        mandatory: true,
        slaTargetMinutes: 15,
      });
    });

    it("re-pages a standing breach only after the 30-min pacing window", async () => {
      const c = await insertCall(ORG_A, "disposition_pending");
      const id = await insertEscalation(ORG_A, c, { escalatedAt: minutesAgo(60) });
      await runEscalationSlaTick(depsFor([ORG_A]));
      await runEscalationSlaTick(depsFor([ORG_A]));
      expect(await breaches(ORG_A)).toHaveLength(1);
      await admin.query("UPDATE triage_escalation SET sla_breached_at = $2 WHERE id = $1", [
        id,
        minutesAgo(31),
      ]);
      await runEscalationSlaTick(depsFor([ORG_A]));
      expect(await breaches(ORG_A)).toHaveLength(2);
    });

    it("does not chase an escalation on a call that already reached a terminal state", async () => {
      const c = await insertCall(ORG_A, "abandoned");
      await insertEscalation(ORG_A, c, { escalatedAt: minutesAgo(120) });
      await runEscalationSlaTick(depsFor([ORG_A]));
      expect(await breaches(ORG_A)).toHaveLength(0);
    });

    it("cross-tenant: a tick scoped to org A never pages (or marks) org B's escalation", async () => {
      const cb = await insertCall(ORG_B, "disposition_pending");
      const b = await insertEscalation(ORG_B, cb, { escalatedAt: minutesAgo(120) });
      await runEscalationSlaTick(depsFor([ORG_A]));
      expect(await breaches(ORG_B)).toHaveLength(0);
      expect((await esc(b)).sla_breached_at).toBeNull();
      // And the app role under org A cannot even see org B's escalation (RLS).
      const visible = await withOrgContext(
        handle.db,
        { organizationId: ORG_A, userId: "", systemActor: true },
        async (tx) => (await (tx as DbClient).select().from(schema.triageEscalation)).length,
      );
      expect(visible).toBe(0);
    });

    it("failure isolation: one org's failing publish does not stop the other org's page", async () => {
      const ca = await insertCall(ORG_A, "disposition_pending");
      const ea = await insertEscalation(ORG_A, ca, { escalatedAt: minutesAgo(60) });
      const cb = await insertCall(ORG_B, "disposition_pending");
      const eb = await insertEscalation(ORG_B, cb, { escalatedAt: minutesAgo(60) });
      const base = depsFor([ORG_A, ORG_B]);
      const deps: M19TriageCronDeps = {
        ...base,
        outbox: {
          publish: async (tx, e) => {
            if (e.organizationId === ORG_A) throw new Error("boom");
            return base.outbox.publish(tx, e);
          },
        },
      };
      await expect(runEscalationSlaTick(deps)).rejects.toThrow(/M19_ESCALATION_SLA/);
      expect(await breaches(ORG_B)).toHaveLength(1); // B still paged
      expect((await esc(eb)).sla_breached_at).not.toBeNull();
      expect(await breaches(ORG_A)).toHaveLength(0); // A rolled back whole: no event, no marker
      expect((await esc(ea)).sla_breached_at).toBeNull();
    });
  });
});
