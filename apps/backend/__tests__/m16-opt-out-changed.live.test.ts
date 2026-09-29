/**
 * F-159 (#248) — LIVE Postgres proof that M16's §2.6 / D9 patient-level opt-out cascade
 * (`buildM16PatientOptOutChangedConsumer`, binding `m5.patient.bereavement_opt_out_changed`) actually
 * closes a `bereavement_plan` row under RLS — both the `skip` branch (plan never reached the family) and
 * the `close_early` branch (plan was live), plus the no-op branches the pure decider documents.
 *
 * `m5.patient.bereavement_opt_out_changed` already declares `declaredConsumers: ["m16"]`
 * (events-by-m5.ts) — no catalog change is needed for this pair.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m16:opt-out-changed:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  M16_OUTBOX_EVENTS,
  buildM16PatientOptOutChangedConsumer,
} from "../src/modules/16-bereavement/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "F-159 — M16's m5.patient.bereavement_opt_out_changed cascade — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let providerA: string;
    let providerB: string;
    let consumer: ReturnType<typeof buildM16PatientOptOutChangedConsumer>;

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const role of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
        );
      }
    }
    async function applyMigrations() {
      for (const file of readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      }
    }

    async function seedPlan(opts: {
      organizationId: string;
      providerEntityId: string;
      patientId: string;
      status: "eligible" | "initiating" | "active" | "paused" | "closed_completed";
    }): Promise<string> {
      const admissionId = crypto.randomUUID();
      // migration 0100's CHECK constraints, by status: active/paused need `assigned_counselor_user_id` +
      // `opened_at`; closed_completed needs `opened_at` + `closed_at` too; eligible/initiating need none
      // (they genuinely never opened — the real, honest state `skip` closes from).
      const needsCounselor = opts.status === "active" || opts.status === "paused";
      const needsOpenedAt = needsCounselor || opts.status === "closed_completed";
      const needsClosedAt = opts.status === "closed_completed";
      const row = await admin.query(
        `INSERT INTO bereavement_plan
           (organization_id, patient_id, admission_id, provider_entity_id, status, death_date,
            assigned_counselor_user_id, opened_at, closed_at)
         VALUES ($1, $2, $3, $4, $5, CURRENT_DATE - INTERVAL '10 days', $6, $7, $8)
         RETURNING id`,
        [
          opts.organizationId,
          opts.patientId,
          admissionId,
          opts.providerEntityId,
          opts.status,
          needsCounselor ? crypto.randomUUID() : null,
          needsOpenedAt ? new Date() : null,
          needsClosedAt ? new Date() : null,
        ],
      );
      return row.rows[0].id as string;
    }

    async function scheduleOutreach(planId: string, organizationId: string, providerEntityId: string) {
      // `bereavement_outreach.bereaved_contact_id` is NOT NULL — every touchpoint is per-survivor.
      const contactRow = await admin.query(
        `INSERT INTO bereaved_contact
           (organization_id, provider_entity_id, plan_id, status, display_name, relationship_code)
         VALUES ($1, $2, $3, 'active', 'Test Survivor', 'spouse')
         RETURNING id`,
        [organizationId, providerEntityId, planId],
      );
      const contactId = contactRow.rows[0].id as string;
      await admin.query(
        `INSERT INTO bereavement_outreach
           (organization_id, provider_entity_id, plan_id, bereaved_contact_id, kind, status,
            death_anchor_at, due_at, late_grace_until)
         VALUES ($1, $2, $3, $4, 'phone_call', 'scheduled',
                 CURRENT_DATE, now() + interval '7 days', now() + interval '14 days')`,
        [organizationId, providerEntityId, planId, contactId],
      );
    }

    async function planRow(planId: string) {
      const { rows } = await admin.query(
        `SELECT status, version, closed_at FROM bereavement_plan WHERE id = $1`,
        [planId],
      );
      return rows[0];
    }

    async function closureRow(planId: string) {
      const { rows } = await admin.query(
        `SELECT reason, close_kind, closed_by_user_id, cosigned_by_user_id
         FROM bereavement_plan_closure WHERE plan_id = $1`,
        [planId],
      );
      return rows[0] ?? null;
    }

    async function outreachStatuses(planId: string) {
      const { rows } = await admin.query(`SELECT status FROM bereavement_outreach WHERE plan_id = $1`, [
        planId,
      ]);
      return rows.map((r) => r.status as string);
    }

    async function outboxRows(organizationId: string, eventType: string) {
      const { rows } = await admin.query(
        `SELECT payload FROM outbox_event WHERE organization_id = $1 AND event_type = $2`,
        [organizationId, eventType],
      );
      return rows;
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'m16-opt-out-a','M16 Opt Out A','M16 Opt Out A'),
                ($2,'m16-opt-out-b','M16 Opt Out B','M16 Opt Out B')`,
        [ORG_A, ORG_B],
      );
      providerA = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M16OO-A','Opt Out Provider A','1100000021','enc','12-31') RETURNING id`,
          [ORG_A],
        )
      ).rows[0].id as string;
      providerB = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,'M16OO-B','Opt Out Provider B','1100000022','enc','12-31') RETURNING id`,
          [ORG_B],
        )
      ).rows[0].id as string;
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = new Map<string, unknown>(M16_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
      consumer = buildM16PatientOptOutChangedConsumer({
        db: handle.db,
        outbox: {
          async publish(tx, input) {
            const entry = catalog.get(input.eventName);
            if (!entry) throw new Error(`m16 test publisher: undeclared event ${input.eventName}`);
            await (tx as typeof handle.db).execute(sql`
                INSERT INTO outbox_event
                  (organization_id, event_type, aggregate_kind, aggregate_id, payload)
                VALUES (${input.organizationId}, ${input.eventName}, ${input.aggregateKind},
                        ${input.aggregateId}, ${JSON.stringify(input.payload)}::jsonb)
              `);
          },
        },
      });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("skips an eligible (never-reached-family) plan with a cosign-exempt completed close", async () => {
      const patientId = crypto.randomUUID();
      const planId = await seedPlan({
        organizationId: ORG_A,
        providerEntityId: providerA,
        patientId,
        status: "eligible",
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: { patientId, organizationId: ORG_A, optedOut: true },
      });

      const plan = await planRow(planId);
      expect(plan.status).toBe("closed_completed");
      expect(plan.closed_at).not.toBeNull();
      expect(plan.version).toBe(1);

      const closure = await closureRow(planId);
      expect(closure.reason).toBe("patient_opt_out_pre_death");
      expect(closure.close_kind).toBe("cascade");
      expect(closure.closed_by_user_id).toBeNull();
      expect(closure.cosigned_by_user_id).toBeNull();

      const events = await outboxRows(ORG_A, "m16.bereavement.plan_skipped_per_patient_opt_out");
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({ patientId });
    });

    it("closes an active plan early (cosign-exempt) and cancels future outreach", async () => {
      const patientId = crypto.randomUUID();
      const planId = await seedPlan({
        organizationId: ORG_A,
        providerEntityId: providerA,
        patientId,
        status: "active",
      });
      await scheduleOutreach(planId, ORG_A, providerA);

      await consumer.handle({
        organizationId: ORG_A,
        payload: { patientId, organizationId: ORG_A, optedOut: true },
      });

      const plan = await planRow(planId);
      expect(plan.status).toBe("closed_early");
      expect(plan.version).toBe(1);

      const closure = await closureRow(planId);
      expect(closure.reason).toBe("patient_opt_out_post_creation");
      expect(closure.close_kind).toBe("cascade");
      expect(closure.cosigned_by_user_id).toBeNull(); // D7 does not apply — §2.6 cosign-exempt

      expect(await outreachStatuses(planId)).toEqual(["cancelled"]);

      const events = await outboxRows(ORG_A, "m16.bereavement.plan_closed_early");
      expect(events).toHaveLength(1);
      expect(events[0].payload).toMatchObject({
        planId,
        reason: "patient_opt_out_post_creation",
        cosignedByUserId: null,
      });
    });

    it("is a no-op for optedOut: false", async () => {
      const patientId = crypto.randomUUID();
      const planId = await seedPlan({
        organizationId: ORG_A,
        providerEntityId: providerA,
        patientId,
        status: "active",
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: { patientId, organizationId: ORG_A, optedOut: false },
      });

      const plan = await planRow(planId);
      expect(plan.status).toBe("active");
      expect(plan.version).toBe(0);
    });

    it("is a no-op for a patient with no bereavement plan at all", async () => {
      await expect(
        consumer.handle({
          organizationId: ORG_A,
          payload: { patientId: crypto.randomUUID(), organizationId: ORG_A, optedOut: true },
        }),
      ).resolves.toBeUndefined();
    });

    it("is a redelivery no-op once the plan is already closed (idempotent)", async () => {
      const patientId = crypto.randomUUID();
      const planId = await seedPlan({
        organizationId: ORG_A,
        providerEntityId: providerA,
        patientId,
        status: "closed_completed",
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: { patientId, organizationId: ORG_A, optedOut: true },
      });

      const plan = await planRow(planId);
      expect(plan.version).toBe(0); // already_closed — untouched
      expect(await closureRow(planId)).toBeNull();
    });

    it("does not cross tenants — org B's identical patient id is invisible to org A's delivery", async () => {
      const sharedPatientId = crypto.randomUUID();
      const planB = await seedPlan({
        organizationId: ORG_B,
        providerEntityId: providerB,
        patientId: sharedPatientId,
        status: "active",
      });

      await consumer.handle({
        organizationId: ORG_A,
        payload: { patientId: sharedPatientId, organizationId: ORG_A, optedOut: true },
      });

      const plan = await planRow(planB);
      expect(plan.status).toBe("active"); // org A's delivery never touched org B's plan
    });
  },
);
