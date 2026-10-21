import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import {
  type M16WorkerDeps,
  runAnniversaryLookaheadCron,
  runClose13MonthsCron,
  runMissDeadlineCron,
  runUnreachableDetectorCron,
} from "../src/modules/16-bereavement/jobs/cron-workers";
/**
 * GAP-048 — M16 §4.9 cron workers (13-month auto-close, miss-deadline, anniversary lookahead, unreachable
 * detector), LIVE Postgres.
 *
 * The REAL `runClose13MonthsCron` / `runMissDeadlineCron` / `runAnniversaryLookaheadCron` /
 * `runUnreachableDetectorCron` as the NOBYPASSRLS
 * `wardenx_app` role, writing through the REAL catalog-validating tx outbox publisher (callerModule `m16`)
 * — never `NOOP_OUTBOX`. Plans / contacts / outreach / reminders are seeded as the admin role; two orgs prove
 * the fan-out is per-tenant (each org's rows land under its own `organization_id`).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m16:cron-workers:live
 */
import { unreachableProposalOf } from "../src/modules/16-bereavement/routes/read-service";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)("GAP-048 — M16 §4.9 cron workers, LIVE", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let deps: M16WorkerDeps;
  const providerEntity: Record<string, string> = {};

  async function seedPlan(
    org: string,
    deathDateSql: string,
    opts: { status?: string; legalHold?: boolean } = {},
  ): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO bereavement_plan
         (organization_id, patient_id, admission_id, provider_entity_id, status, death_date,
          assigned_counselor_user_id, opened_at, legal_hold_id, pause_kind, paused_at)
       VALUES ($1,$2,$3,$4,$5, ${deathDateSql}, $6, now(), $7,
         CASE WHEN $8::boolean THEN 'operational'::bereavement_plan_pause_kind END,
         CASE WHEN $8::boolean THEN now() END) RETURNING id`,
      [
        org,
        randomUUID(),
        randomUUID(),
        providerEntity[org],
        opts.status ?? "active",
        randomUUID(),
        opts.legalHold ? randomUUID() : null,
        opts.status === "paused",
      ],
    );
    return rows[0].id as string;
  }

  async function seedContact(org: string, planId: string): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO bereaved_contact (organization_id, provider_entity_id, plan_id, display_name, relationship_code, status)
         VALUES ($1,$2,$3,'Jane Roe','spouse','active') RETURNING id`,
      [org, providerEntity[org], planId],
    );
    return rows[0].id as string;
  }

  /** `due = death + dueDays`, `grace = due + 7d`. */
  async function seedOutreach(
    org: string,
    planId: string,
    contactId: string,
    dueDays: number,
  ): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO bereavement_outreach
         (organization_id, provider_entity_id, plan_id, bereaved_contact_id, kind, status,
          death_anchor_at, due_at, late_grace_until)
       SELECT $1,$2,p.id,$4,'phone_call','scheduled',
              p.death_date::timestamptz,
              p.death_date::timestamptz + make_interval(days => $5),
              p.death_date::timestamptz + make_interval(days => $5 + 7)
         FROM bereavement_plan p WHERE p.id=$3
       RETURNING id`,
      [org, providerEntity[org], planId, contactId, dueDays],
    );
    return rows[0].id as string;
  }

  async function seedReminder(
    org: string,
    planId: string,
    mark: string,
    targetSql: string,
    fired = false,
  ): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO bereavement_anniversary_reminder
         (organization_id, provider_entity_id, plan_id, mark, target_date, alert_fired_at)
       VALUES ($1,$2,$3,$4::bereavement_anniversary_mark, ${targetSql}, ${fired ? "now()" : "NULL"}) RETURNING id`,
      [org, providerEntity[org], planId, mark],
    );
    return rows[0].id as string;
  }

  async function seedOutreachGraceAt(
    org: string,
    planId: string,
    contactId: string,
    graceIso: string,
  ): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO bereavement_outreach
         (organization_id, provider_entity_id, plan_id, bereaved_contact_id, kind, status,
          death_anchor_at, due_at, late_grace_until)
       SELECT $1,$2,p.id,$4,'phone_call','scheduled',
              p.death_date::timestamptz, $5::timestamptz - interval '7 days', $5::timestamptz
         FROM bereavement_plan p WHERE p.id=$3
       RETURNING id`,
      [org, providerEntity[org], planId, contactId, graceIso],
    );
    return rows[0].id as string;
  }

  async function seedLog(
    org: string,
    planId: string,
    contactId: string,
    outreachId: string,
    outcome: string,
    daysAgo: number,
  ): Promise<void> {
    await admin.query(
      `INSERT INTO bereavement_contact_log
         (organization_id, provider_entity_id, plan_id, bereaved_contact_id, outreach_id,
          contact_at, kind, outcome, logged_by_user_id)
       VALUES ($1,$2,$3,$4,$5, now() - make_interval(days => $6), 'phone_call', $7::bereavement_contact_log_outcome, $8)`,
      [org, providerEntity[org], planId, contactId, outreachId, daysAgo, outcome, randomUUID()],
    );
  }

  /** A contact with one log row per `outcomes` entry, OLDEST first (the last entry is the newest strike). */
  async function seedContactWithLog(
    org: string,
    planId: string,
    outcomes: readonly string[],
    status = "active",
  ): Promise<string> {
    const contact = await seedContact(org, planId);
    if (status !== "active")
      await admin.query(
        "UPDATE bereaved_contact SET status=$2::bereaved_contact_status WHERE id=$1",
        [contact, status],
      );
    const outreach = await seedOutreach(org, planId, contact, 20);
    for (const [i, outcome] of outcomes.entries())
      await seedLog(org, planId, contact, outreach, outcome, outcomes.length - i);
    return contact;
  }

  const one = async <T = Record<string, unknown>>(sql: string, args: unknown[]): Promise<T> =>
    (await admin.query(sql, args)).rows[0] as T;
  const events = async (eventType: string, key: string, id: string) =>
    (
      await admin.query(
        `SELECT organization_id FROM outbox_event WHERE event_type=$1 AND payload->>'${key}'=$2`,
        [eventType, id],
      )
    ).rows as { organization_id: string }[];

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; BEGIN EXECUTE 'DROP ROLE ${r}'; EXCEPTION WHEN dependent_objects_still_exist THEN NULL; END; END IF; END $$;`,
      );
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG, ORG_B],
    );
    for (const [org, ccn] of [
      [ORG, "CCN-1111"],
      [ORG_B, "CCN-2222"],
    ] as const) {
      providerEntity[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,'Hospice','NPI-'||$2,'\\x00','12-31') RETURNING id`,
          [org, ccn],
        )
      ).rows[0].id as string;
    }

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M16_OUTBOX_EVENTS]));
    deps = {
      connection: {} as never, // BullMQ is not constructed here — the cron bodies are called directly.
      db: handle.db,
      outbox: {
        publish: (tx: unknown, e: Record<string, unknown>) =>
          publisher.publish(tx as never, { ...e, callerModule: "m16" } as never),
      } as never,
      activeOrgs: {
        listActiveOrgs: async () => [{ organizationId: ORG }, { organizationId: ORG_B }],
      },
    };
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  describe("m16-close-13mo", () => {
    it("closes a plan whose death was 14 months ago, once, with a closure row and the event", async () => {
      const old = await seedPlan(ORG, "CURRENT_DATE - interval '14 months'");
      const oldB = await seedPlan(ORG_B, "CURRENT_DATE - interval '14 months'");
      const fresh = await seedPlan(ORG, "CURRENT_DATE - interval '2 months'");
      const paused = await seedPlan(ORG, "CURRENT_DATE - interval '14 months'", {
        status: "paused",
      });
      const held = await seedPlan(ORG, "CURRENT_DATE - interval '14 months'", { legalHold: true });
      // death 397 days ago ⇒ window elapsed (396) while an outreach due at +400d is still in the future.
      const edge = await seedPlan(ORG, "CURRENT_DATE - 397");
      const futureOutreach = await seedOutreach(ORG, edge, await seedContact(ORG, edge), 400);

      const first = await runClose13MonthsCron(deps);
      expect(first.closed).toBeGreaterThanOrEqual(4);

      for (const id of [old, oldB, paused, edge]) {
        const row = await one<{ status: string; closed_at: Date | null; version: number }>(
          "SELECT status, closed_at, version FROM bereavement_plan WHERE id=$1",
          [id],
        );
        expect(row.status).toBe("closed_completed");
        expect(row.closed_at).not.toBeNull();
        const closure = await one<{
          reason: string;
          close_kind: string;
          closed_by_user_id: string | null;
        }>(
          "SELECT reason, close_kind, closed_by_user_id FROM bereavement_plan_closure WHERE plan_id=$1",
          [id],
        );
        expect(closure).toMatchObject({
          reason: "thirteen_month_completion",
          close_kind: "auto",
          closed_by_user_id: null,
        });
      }
      expect(
        (await events("m16.bereavement.plan_closed_completed", "planId", oldB))[0]?.organization_id,
      ).toBe(ORG_B);
      expect(
        (await one<{ status: string }>("SELECT status FROM bereavement_plan WHERE id=$1", [fresh]))
          .status,
      ).toBe("active");
      expect(
        (await one<{ status: string }>("SELECT status FROM bereavement_plan WHERE id=$1", [held]))
          .status,
      ).toBe("active");
      expect(
        (
          await one<{ status: string }>("SELECT status FROM bereavement_outreach WHERE id=$1", [
            futureOutreach,
          ])
        ).status,
      ).toBe("cancelled");

      // Idempotent: a second tick (or a BullMQ retry) writes nothing more for the already-closed plans.
      await runClose13MonthsCron(deps);
      expect(
        (
          await one<{ n: number }>(
            "SELECT count(*)::int n FROM bereavement_plan_closure WHERE plan_id=$1",
            [old],
          )
        ).n,
      ).toBe(1);
      expect(await events("m16.bereavement.plan_closed_completed", "planId", old)).toHaveLength(1);
    });
  });

  describe("m16-miss-deadline", () => {
    it("marks only outreach past its late grace as missed, with the event", async () => {
      const plan = await seedPlan(ORG, "CURRENT_DATE - interval '60 days'");
      const contact = await seedContact(ORG, plan);
      const overdue = await seedOutreach(ORG, plan, contact, 30); // grace ended 23 days ago
      const inGrace = await seedOutreach(ORG, plan, contact, 55); // due 5 days ago, grace still open
      const future = await seedOutreach(ORG, plan, contact, 90);
      const planB = await seedPlan(ORG_B, "CURRENT_DATE - interval '60 days'");
      const overdueB = await seedOutreach(ORG_B, planB, await seedContact(ORG_B, planB), 30);

      const result = await runMissDeadlineCron(deps);
      expect(result.missed).toBeGreaterThanOrEqual(2);

      const status = async (id: string) =>
        (await one<{ status: string }>("SELECT status FROM bereavement_outreach WHERE id=$1", [id]))
          .status;
      expect(await status(overdue)).toBe("missed");
      expect(await status(overdueB)).toBe("missed");
      expect(await status(inGrace)).toBe("scheduled");
      expect(await status(future)).toBe("scheduled");
      expect(
        (await events("m16.bereavement.outreach_missed", "outreachId", overdueB))[0]
          ?.organization_id,
      ).toBe(ORG_B);

      // Idempotent: the row is no longer `scheduled`, so a second tick emits nothing new.
      await runMissDeadlineCron(deps);
      expect(await events("m16.bereavement.outreach_missed", "outreachId", overdue)).toHaveLength(
        1,
      );
    });

    it("does not mark outreach of a paused plan", async () => {
      const plan = await seedPlan(ORG, "CURRENT_DATE - interval '60 days'", { status: "paused" });
      const overdue = await seedOutreach(ORG, plan, await seedContact(ORG, plan), 30);
      await runMissDeadlineCron(deps);
      expect(
        (
          await one<{ status: string }>("SELECT status FROM bereavement_outreach WHERE id=$1", [
            overdue,
          ])
        ).status,
      ).toBe("scheduled");
    });
  });

  describe("m16-anniversary-lookahead", () => {
    it("fires each unfired reminder inside the 14-day window exactly once and stamps alert_fired_at", async () => {
      const plan = await seedPlan(ORG, "CURRENT_DATE - interval '11 months'");
      const due = await seedReminder(ORG, plan, "anniversary", "CURRENT_DATE + 10");
      const far = await seedReminder(ORG, plan, "six_month", "CURRENT_DATE + 30");
      const already = await seedReminder(ORG, plan, "three_month", "CURRENT_DATE + 5", true);

      await runAnniversaryLookaheadCron(deps);

      const fired = async (id: string) =>
        (
          await one<{ alert_fired_at: Date | null }>(
            "SELECT alert_fired_at FROM bereavement_anniversary_reminder WHERE id=$1",
            [id],
          )
        ).alert_fired_at;
      expect(await fired(due)).not.toBeNull();
      expect(await fired(far)).toBeNull();
      expect(
        await events("m16.bereavement.anniversary_due_in_14_days", "anniversaryReminderId", due),
      ).toHaveLength(1);
      expect(
        await events(
          "m16.bereavement.anniversary_due_in_14_days",
          "anniversaryReminderId",
          already,
        ),
      ).toHaveLength(0);

      await runAnniversaryLookaheadCron(deps);
      expect(
        await events("m16.bereavement.anniversary_due_in_14_days", "anniversaryReminderId", due),
      ).toHaveLength(1);
    });
  });
  describe("m16-miss-deadline — late-grace boundary", () => {
    const GRACE = "2030-01-01T00:00:00.000Z";
    const status = async (id: string) =>
      (await one<{ status: string }>("SELECT status FROM bereavement_outreach WHERE id=$1", [id]))
        .status;

    it("does not miss at exactly late_grace_until, and misses one second after", async () => {
      const plan = await seedPlan(ORG, "DATE '2029-12-01'");
      const row = await seedOutreachGraceAt(ORG, plan, await seedContact(ORG, plan), GRACE);
      try {
        deps.now = () => new Date(GRACE);
        await runMissDeadlineCron(deps);
        expect(await status(row)).toBe("scheduled");

        deps.now = () => new Date(Date.parse(GRACE) + 1000);
        await runMissDeadlineCron(deps);
        expect(await status(row)).toBe("missed");
        expect(await events("m16.bereavement.outreach_missed", "outreachId", row)).toHaveLength(1);
      } finally {
        deps.now = () => new Date();
      }
    });

    it("never misses a row whose attempt was recorded at the grace end (in_progress)", async () => {
      const plan = await seedPlan(ORG, "DATE '2029-12-01'");
      const row = await seedOutreachGraceAt(ORG, plan, await seedContact(ORG, plan), GRACE);
      await admin.query(
        "UPDATE bereavement_outreach SET status='in_progress', started_at=$2 WHERE id=$1",
        [row, GRACE],
      );
      try {
        deps.now = () => new Date(Date.parse(GRACE) + 1000);
        await runMissDeadlineCron(deps);
        expect(await status(row)).toBe("in_progress");
      } finally {
        deps.now = () => new Date();
      }
    });
  });

  describe("m16-unreachable-detector", () => {
    const proposals = (id: string) =>
      events("m16.bereavement.contact_unreachable_proposed", "contactId", id);

    it("proposes at 3 consecutive no_response without changing status, once per evidence", async () => {
      const plan = await seedPlan(ORG, "CURRENT_DATE - interval '60 days'");
      const three = await seedContactWithLog(ORG, plan, [
        "no_response",
        "no_response",
        "no_response",
      ]);
      const two = await seedContactWithLog(ORG, plan, ["no_response", "no_response"]);
      const broken = await seedContactWithLog(ORG, plan, [
        "no_response",
        "no_response",
        "no_response",
        "engaged",
      ]);
      const alreadyUnreachable = await seedContactWithLog(
        ORG,
        plan,
        ["no_response", "no_response", "no_response"],
        "unreachable",
      );
      const pausedPlan = await seedPlan(ORG, "CURRENT_DATE - interval '60 days'", {
        status: "paused",
      });
      const onPaused = await seedContactWithLog(ORG, pausedPlan, [
        "no_response",
        "no_response",
        "no_response",
      ]);
      const planB = await seedPlan(ORG_B, "CURRENT_DATE - interval '60 days'");
      const threeB = await seedContactWithLog(ORG_B, planB, [
        "no_response",
        "no_response",
        "no_response",
      ]);

      const first = await runUnreachableDetectorCron(deps);
      expect(first.proposed).toBeGreaterThanOrEqual(2);

      const rowOf = (id: string) =>
        one<{ status: string; version: number; unreachable_proposed_through_at: Date | null }>(
          "SELECT status, version, unreachable_proposed_through_at FROM bereaved_contact WHERE id=$1",
          [id],
        );
      const proposed = await rowOf(three);
      expect(proposed.status).toBe("active"); // propose-only: the counselor decides
      expect(proposed.unreachable_proposed_through_at).not.toBeNull();
      expect(await proposals(three)).toHaveLength(1);
      const evt = await one<{ payload: { consecutiveNoResponseCount: number; planId: string } }>(
        "SELECT payload FROM outbox_event WHERE event_type='m16.bereavement.contact_unreachable_proposed' AND payload->>'contactId'=$1",
        [three],
      );
      expect(evt.payload).toMatchObject({ consecutiveNoResponseCount: 3, planId: plan });
      expect((await proposals(threeB))[0]?.organization_id).toBe(ORG_B);
      for (const id of [two, broken, alreadyUnreachable, onPaused])
        expect(await proposals(id)).toHaveLength(0);
      expect((await rowOf(alreadyUnreachable)).status).toBe("unreachable");

      // Idempotent: the same evidence proposes nothing more.
      await runUnreachableDetectorCron(deps);
      expect(await proposals(three)).toHaveLength(1);

      // A strictly newer strike is new evidence and re-proposes with the longer streak.
      const outreach = (
        await one<{ id: string }>(
          "SELECT id FROM bereavement_outreach WHERE bereaved_contact_id=$1 LIMIT 1",
          [three],
        )
      ).id;
      await admin.query(
        `INSERT INTO bereavement_contact_log
           (organization_id, provider_entity_id, plan_id, bereaved_contact_id, outreach_id,
            contact_at, kind, outcome, logged_by_user_id)
         SELECT organization_id, provider_entity_id, plan_id, bereaved_contact_id, outreach_id,
                now() + interval '1 minute', kind, outcome, logged_by_user_id
           FROM bereavement_contact_log WHERE bereaved_contact_id=$1 AND outreach_id=$2 LIMIT 1`,
        [three, outreach],
      );
      await runUnreachableDetectorCron(deps);
      expect(await proposals(three)).toHaveLength(2);
    });

    it("a dismissed proposal (keep trying) is not re-proposed until a strictly newer strike", async () => {
      const plan = await seedPlan(ORG, "CURRENT_DATE - interval '60 days'");
      const id = await seedContactWithLog(ORG, plan, ["no_response", "no_response", "no_response"]);
      await runUnreachableDetectorCron(deps);
      expect(await proposals(id)).toHaveLength(1);

      // Route 34 stamps the dismissal with the dismissed proposal's own stamp.
      await admin.query(
        "UPDATE bereaved_contact SET unreachable_proposal_dismissed_at = unreachable_proposed_through_at WHERE id=$1",
        [id],
      );
      const rowOf = () =>
        one<{
          status: string;
          unreachable_proposed_through_at: Date;
          unreachable_proposal_dismissed_at: Date;
        }>(
          "SELECT status, unreachable_proposed_through_at, unreachable_proposal_dismissed_at FROM bereaved_contact WHERE id=$1",
          [id],
        );
      await runUnreachableDetectorCron(deps);
      expect(await proposals(id)).toHaveLength(1);
      const dismissed = await rowOf();
      expect(
        unreachableProposalOf({
          status: dismissed.status,
          unreachableProposedThroughAt: dismissed.unreachable_proposed_through_at,
          unreachableProposalDismissedAt: dismissed.unreachable_proposal_dismissed_at,
        }).unreachableProposed,
      ).toBe(false);

      const outreach = (
        await one<{ id: string }>(
          "SELECT id FROM bereavement_outreach WHERE bereaved_contact_id=$1 LIMIT 1",
          [id],
        )
      ).id;
      await admin.query(
        `INSERT INTO bereavement_contact_log
           (organization_id, provider_entity_id, plan_id, bereaved_contact_id, outreach_id,
            contact_at, kind, outcome, logged_by_user_id)
         SELECT organization_id, provider_entity_id, plan_id, bereaved_contact_id, outreach_id,
                now() + interval '1 minute', kind, outcome, logged_by_user_id
           FROM bereavement_contact_log WHERE bereaved_contact_id=$1 AND outreach_id=$2 LIMIT 1`,
        [id, outreach],
      );
      await runUnreachableDetectorCron(deps);
      expect(await proposals(id)).toHaveLength(2);
      const again = await rowOf();
      expect(
        unreachableProposalOf({
          status: again.status,
          unreachableProposedThroughAt: again.unreachable_proposed_through_at,
          unreachableProposalDismissedAt: again.unreachable_proposal_dismissed_at,
        }).unreachableProposed,
      ).toBe(true);
    });
  });
});
