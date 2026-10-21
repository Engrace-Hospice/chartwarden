/**
 * F-152 (#248) — LIVE Postgres proof that M17's three new D14/§7.5 outbox bindings actually write real
 * `visit` / `visit_state_history` rows under RLS:
 *   - `buildM17EvvCheckInConsumer` (`m18.evv.check_in_recorded` → `published → en_route`)
 *   - `buildM17EvvAtPatientAddressConsumer` (`m18.evv.at_patient_address` → `en_route → in_visit`)
 *   - `buildM17SosVisitCancellationConsumer` (`m20.safety.visit_cancellation_requested` → `* → cancelled`)
 *
 * `@chartwarden/scheduling`'s `transitionVisit` has supported an EVV-sourced `start`/`arrive`
 * (`VisitAdvanceSource: { via: "evv" }`) since the machine shipped, naming these two exact M18 events in
 * its own doc comment; nothing had ever bound either. M20's own catalog entry for
 * `visit_cancellation_requested` says "M20 never writes an M17 row — this event IS the request and M17's
 * D3 handler decides" — no such handler existed either. All three sat in
 * `scripts/outbox-deferred-consumers.ts`'s m17 `handlers-unbound` group.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m17:evv-sos-consumers:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildM17AdmissionLifecycleConsumer } from "../src/modules/17-scheduling/consumers/admission-lifecycle";
import { M17_OUTBOX_EVENTS } from "../src/modules/17-scheduling/events-by-m17";
import { buildM17EvvAtPatientAddressConsumer } from "../src/modules/17-scheduling/outbox-consumers/m18-evv-at-patient-address";
import { buildM17EvvCheckInConsumer } from "../src/modules/17-scheduling/outbox-consumers/m18-evv-check-in";
import { buildM17SosVisitCancellationConsumer } from "../src/modules/17-scheduling/outbox-consumers/m20-safety-visit-cancellation";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const M17_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000017";

describe.skipIf(!DB_URL)(
  "F-152 — M17's EVV advance + SOS cancellation consumers — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let peA: string;
    let locA: string;
    let memA: string;
    let peB: string;
    let locB: string;
    let memB: string;
    let visitSeedCounter = 0;
    let checkInConsumer: ReturnType<typeof buildM17EvvCheckInConsumer>;
    let atPatientAddressConsumer: ReturnType<typeof buildM17EvvAtPatientAddressConsumer>;
    let cancelConsumer: ReturnType<typeof buildM17SosVisitCancellationConsumer>;
    let lifecycleConsumer: ReturnType<typeof buildM17AdmissionLifecycleConsumer>;

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

    async function seedOrgFixture(orgId: string, slug: string) {
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)`,
        [orgId, slug, slug],
      );
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity
             (organization_id,ccn,legal_name,npi,tax_id_encrypted,fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [orgId, `M17-${slug}`, `Provider ${slug}`, slug === "a" ? "1200000001" : "1200000002"],
        )
      ).rows[0].id as string;
      const loc = (
        await admin.query(
          `INSERT INTO location
             (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Main','1 Main St','Portland','OR','97201','America/Los_Angeles') RETURNING id`,
          [pe],
        )
      ).rows[0].id as string;
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `m17-evv-sos-${slug}@x.test`,
        ])
      ).rows[0].id as string;
      const mem = (
        await admin.query(
          `INSERT INTO membership
             (user_id, organization_id, status, default_provider_entity_id, default_location_ids)
           VALUES ($1,$2,'active',$3,$4::jsonb) RETURNING id`,
          [user, orgId, pe, JSON.stringify([loc])],
        )
      ).rows[0].id as string;
      return { pe, loc, mem };
    }

    async function seedVisit(opts: {
      organizationId: string;
      providerEntityId: string;
      locationId: string;
      assignedMembershipId: string;
      status: "published" | "en_route" | "in_visit";
      admissionId?: string;
    }): Promise<string> {
      const patientId = crypto.randomUUID();
      const admissionId = opts.admissionId ?? crypto.randomUUID();
      // Offset each seeded visit's window so the GiST exclusion constraint (one clinician, no overlapping
      // scheduled windows) never collides across the several visits a single test seeds for one membership.
      const offsetHours = visitSeedCounter++;
      const row = await admin.query(
        `INSERT INTO visit
           (organization_id, provider_entity_id, location_id, patient_id, admission_id,
            assigned_membership_id, assigned_discipline_at_assignment, visit_purpose, visit_setting,
            scheduled_started_at, scheduled_ended_at, service_date, status)
         VALUES ($1,$2,$3,$4,$5,$6,'rn','routine_visit','patient_home',
                 now() + ($8 || ' hours')::interval, now() + ($8 || ' hours')::interval + interval '1 hour',
                 CURRENT_DATE, $7)
         RETURNING id`,
        [
          opts.organizationId,
          opts.providerEntityId,
          opts.locationId,
          patientId,
          admissionId,
          opts.assignedMembershipId,
          opts.status,
          String(offsetHours * 2),
        ],
      );
      return row.rows[0].id as string;
    }

    async function visitRow(visitId: string) {
      const { rows } = await admin.query(
        `SELECT status, version, evv_bracket_state, evv_check_in_event_id, actual_started_at,
                cancelled_by_membership_id, cancellation_reason_code
         FROM visit WHERE id = $1`,
        [visitId],
      );
      return rows[0];
    }

    async function historyRows(visitId: string) {
      const { rows } = await admin.query(
        `SELECT from_state, to_state, actor_membership_id, system_source
         FROM visit_state_history WHERE visit_id = $1 ORDER BY transitioned_at`,
        [visitId],
      );
      return rows;
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
      const a = await seedOrgFixture(ORG_A, "a");
      peA = a.pe;
      locA = a.loc;
      memA = a.mem;
      const b = await seedOrgFixture(ORG_B, "b");
      peB = b.pe;
      locB = b.loc;
      memB = b.mem;
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = new Map<string, unknown>(M17_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
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
          if (!catalog.has(input.eventName)) {
            throw new Error(`m17 test publisher: undeclared event ${input.eventName}`);
          }
          await (tx as typeof handle.db).execute(sql`
            INSERT INTO outbox_event (organization_id, event_type, aggregate_kind, aggregate_id, payload)
            VALUES (${input.organizationId}, ${input.eventName}, ${input.aggregateKind},
                    ${input.aggregateId}, ${JSON.stringify(input.payload)}::jsonb)
          `);
        },
      };

      checkInConsumer = buildM17EvvCheckInConsumer({ db: handle.db, outbox });
      atPatientAddressConsumer = buildM17EvvAtPatientAddressConsumer({ db: handle.db });
      cancelConsumer = buildM17SosVisitCancellationConsumer({ db: handle.db, outbox });
      lifecycleConsumer = buildM17AdmissionLifecycleConsumer({ db: handle.db, outbox });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("check-in advances published -> en_route, sets the bracket + event id, and publishes m17.visit.started", async () => {
      const visitId = await seedVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
        assignedMembershipId: memA,
        status: "published",
      });
      const eventId = crypto.randomUUID();
      const capturedAt = new Date().toISOString();

      await checkInConsumer.handle({
        id: crypto.randomUUID(),
        organizationId: ORG_A,
        payload: { eventId, visitId, patientId: "irrelevant", capturedAt },
      });

      const row = await visitRow(visitId);
      expect(row.status).toBe("en_route");
      expect(row.version).toBe(1);
      expect(row.evv_bracket_state).toBe("evv_present");
      expect(row.evv_check_in_event_id).toBe(eventId);
      expect(row.actual_started_at).not.toBeNull();

      const history = await historyRows(visitId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        from_state: "published",
        to_state: "en_route",
        actor_membership_id: null,
        system_source: "evv_check_in",
      });

      expect(await outboxRows(ORG_A, "m17.visit.started")).toHaveLength(1);

      // Redelivery — the visit is no longer `published`, so this must be a true no-op.
      await checkInConsumer.handle({
        id: crypto.randomUUID(),
        organizationId: ORG_A,
        payload: { eventId, visitId, patientId: "irrelevant", capturedAt },
      });
      const after = await visitRow(visitId);
      expect(after.version).toBe(1);
      expect(await historyRows(visitId)).toHaveLength(1);
    });

    it("at-patient-address advances en_route -> in_visit with no outbox emission", async () => {
      const visitId = await seedVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
        assignedMembershipId: memA,
        status: "en_route",
      });

      await atPatientAddressConsumer.handle({
        id: crypto.randomUUID(),
        organizationId: ORG_A,
        payload: { visitId, confirmedAt: new Date().toISOString() },
      });

      const row = await visitRow(visitId);
      expect(row.status).toBe("in_visit");
      expect(row.version).toBe(1);
      expect(row.evv_bracket_state).toBe("evv_present");

      const history = await historyRows(visitId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        from_state: "en_route",
        to_state: "in_visit",
        system_source: "evv_at_patient_address",
      });
    });

    it("is a no-op when the visit is in the wrong state or belongs to another org", async () => {
      const publishedVisit = await seedVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
        assignedMembershipId: memA,
        status: "published",
      });
      // arrive requires en_route — a published visit is a no-op, not a thrown ILLEGAL_VISIT_TRANSITION.
      await atPatientAddressConsumer.handle({
        id: crypto.randomUUID(),
        organizationId: ORG_A,
        payload: { visitId: publishedVisit, confirmedAt: new Date().toISOString() },
      });
      expect((await visitRow(publishedVisit)).status).toBe("published");

      const orgBVisit = await seedVisit({
        organizationId: ORG_B,
        providerEntityId: peB,
        locationId: locB,
        assignedMembershipId: memB,
        status: "published",
      });
      // org A's delivery must not see org B's visit.
      await checkInConsumer.handle({
        id: crypto.randomUUID(),
        organizationId: ORG_A,
        payload: {
          eventId: crypto.randomUUID(),
          visitId: orgBVisit,
          patientId: "irrelevant",
          capturedAt: new Date().toISOString(),
        },
      });
      expect((await visitRow(orgBVisit)).status).toBe("published");
    });

    it("SOS resolution cancels an in-flight visit, stamps the system sentinel, and publishes the pair", async () => {
      const visitId = await seedVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
        assignedMembershipId: memA,
        status: "in_visit",
      });
      const sosAlertId = crypto.randomUUID();

      await cancelConsumer.handle({
        organizationId: ORG_A,
        payload: { sosAlertId, visitId, requestedAt: new Date().toISOString() },
      });

      const row = await visitRow(visitId);
      expect(row.status).toBe("cancelled");
      expect(row.version).toBe(1);
      expect(row.cancelled_by_membership_id).toBe(M17_SYSTEM_USER_ID);
      expect(row.cancellation_reason_code).toBe("sos_alert_resolved");

      const history = await historyRows(visitId);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        from_state: "in_visit",
        to_state: "cancelled",
        actor_membership_id: M17_SYSTEM_USER_ID,
        system_source: "sos_visit_cancellation",
      });

      expect(await outboxRows(ORG_A, "m17.visit.unassigned")).toHaveLength(1);
      const cancelledEvents = await outboxRows(ORG_A, "m17.visit.cancelled");
      expect(cancelledEvents).toHaveLength(1);
      expect(cancelledEvents[0].payload).toMatchObject({
        visitId,
        cancelledBy: M17_SYSTEM_USER_ID,
        reasonCode: "sos_alert_resolved",
      });

      // Redelivery against the now-cancelled (terminal) visit is a true no-op.
      await cancelConsumer.handle({
        organizationId: ORG_A,
        payload: { sosAlertId, visitId, requestedAt: new Date().toISOString() },
      });
      expect((await visitRow(visitId)).version).toBe(1);
      expect(await historyRows(visitId)).toHaveLength(1);
    });

    it("m6.admission.discharged cancels the admission's future visits under the NULL (system) audit actor", async () => {
      // Before the fix the sentinel M17_SYSTEM_USER_ID reached `app.user_id`, and the visit UPDATE failed
      // on 23503 `audit_event_actor_user_id_user_id_fk` — it is not a `user` row.
      const admissionId = crypto.randomUUID();
      const visitId = await seedVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        locationId: locA,
        assignedMembershipId: memA,
        status: "published",
        admissionId,
      });
      const today = new Date().toISOString().slice(0, 10);

      await lifecycleConsumer.handle({
        id: crypto.randomUUID(),
        organizationId: ORG_A,
        eventType: "m6.admission.discharged",
        payload: { admissionId, aggregateId: admissionId, dischargeDate: today, reason: "death" },
      } as never);

      const row = await visitRow(visitId);
      expect(row.status).toBe("cancelled");
      expect(row.cancelled_by_membership_id).toBe(M17_SYSTEM_USER_ID);
      expect(row.cancellation_reason_code).toBe("admission_lifecycle");

      const audit = await admin.query(
        `SELECT actor_user_id FROM audit_event WHERE resource_id = $1`,
        [visitId],
      );
      expect(audit.rows.length).toBeGreaterThan(0);
      expect(audit.rows.every((r) => r.actor_user_id === null)).toBe(true);
      const cancelled = (await outboxRows(ORG_A, "m17.visit.cancelled")).filter(
        (r) => r.payload.visitId === visitId,
      );
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].payload).toMatchObject({ cancelledBy: M17_SYSTEM_USER_ID });
    });
  },
);
