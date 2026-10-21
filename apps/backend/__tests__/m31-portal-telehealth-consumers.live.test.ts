/**
 * Continuation of the #248 outbox-binding arc (F-150…F-159 pattern) — LIVE Postgres proof that three of
 * M31's own §4.10 "M31 consumes" table entries (F-139's `no-consumer-surface` group) write real
 * `telehealth_visit` rows under RLS:
 *   - `buildM31VisitCancelledTelehealthConsumer` (`m17.visit.cancelled` → force-end the room, i.e. mark it
 *     `ended_aborted` so `foldParticipantJoin` refuses any further join)
 *   - `buildM31VisitRescheduledTelehealthConsumer` (`m17.visit.rescheduled` → end the OLD visit's stale
 *     room; the NEW visit id gets its own room only once the — separately scoped, not built here —
 *     `m17.visit.published` consumer exists)
 *   - `buildM31EncounterSignedTelehealthConsumer` (`m8.encounter.signed` → reconcile an already-ended room)
 *
 * All three sat in `scripts/outbox-deferred-consumers.ts`'s m31 `no-consumer-surface` group (F-139):
 * `31-portal/` had no `consumers/`/`outbox-consumers/` directory at all before this build. No live binding
 * existed before this file.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m31:telehealth-consumers:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildM31EncounterSignedTelehealthConsumer } from "../src/modules/31-portal/outbox-consumers/m8-encounter-signed-telehealth";
import { buildM31VisitCancelledTelehealthConsumer } from "../src/modules/31-portal/outbox-consumers/m17-visit-cancelled-telehealth";
import { buildM31VisitRescheduledTelehealthConsumer } from "../src/modules/31-portal/outbox-consumers/m17-visit-rescheduled-telehealth";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "F-139 continuation — M31's three telehealth outbox consumers — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let cancelConsumer: ReturnType<typeof buildM31VisitCancelledTelehealthConsumer>;
    let rescheduledConsumer: ReturnType<typeof buildM31VisitRescheduledTelehealthConsumer>;
    let signedConsumer: ReturnType<typeof buildM31EncounterSignedTelehealthConsumer>;
    let peA: string;
    let peB: string;

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

    async function seedOrg(orgId: string, slug: string) {
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)`,
        [orgId, slug, slug],
      );
    }

    async function seedProviderEntity(orgId: string, ccn: string): Promise<string> {
      const row = await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$2,$3,'enc','12-31') RETURNING id`,
        [orgId, ccn, `NPI-${ccn}`],
      );
      return row.rows[0].id as string;
    }

    async function seedTelehealthVisit(opts: {
      organizationId: string;
      providerEntityId: string;
      m17VisitId: string;
      lifecycleState?: string;
      visitStartedAt?: Date | null;
    }): Promise<string> {
      const lifecycleState = opts.lifecycleState ?? "room_minted";
      // `telehealth_visit_ended_requires_end_reason` requires a non-null end_reason for either ended
      // state — the check the consumers themselves must satisfy on every UPDATE, so the fixture has to
      // satisfy it too when seeding a row that starts out already ended.
      const endReason =
        lifecycleState === "ended_clean" || lifecycleState === "ended_aborted" ? "clean" : null;
      const row = await admin.query(
        `INSERT INTO telehealth_visit
           (organization_id, provider_entity_id, m17_visit_id, patient_id, assigned_membership_id,
            lifecycle_state, vendor, vendor_room_id_cipher, vendor_room_url_cipher,
            scheduled_visit_setting, visit_started_at, end_reason)
         VALUES ($1,$2,$3,$4,$5,$6,'daily_co','cipher:room','cipher:url','telephonic',$7,$8)
         RETURNING id`,
        [
          opts.organizationId,
          opts.providerEntityId,
          opts.m17VisitId,
          crypto.randomUUID(),
          crypto.randomUUID(),
          lifecycleState,
          opts.visitStartedAt ?? null,
          endReason,
        ],
      );
      return row.rows[0].id as string;
    }

    async function visitRow(id: string) {
      const { rows } = await admin.query(
        `SELECT lifecycle_state, end_reason, linked_encounter_id, version, visit_ended_at, total_duration_sec
         FROM telehealth_visit WHERE id = $1`,
        [id],
      );
      return rows[0];
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await seedOrg(ORG_A, "a");
      await seedOrg(ORG_B, "b");
      peA = await seedProviderEntity(ORG_A, "CCN-M31A");
      peB = await seedProviderEntity(ORG_B, "CCN-M31B");
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      cancelConsumer = buildM31VisitCancelledTelehealthConsumer({ db: handle.db });
      rescheduledConsumer = buildM31VisitRescheduledTelehealthConsumer({ db: handle.db });
      signedConsumer = buildM31EncounterSignedTelehealthConsumer({ db: handle.db });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("m17.visit.cancelled force-ends a room minted (never joined) for the visit", async () => {
      const m17VisitId = crypto.randomUUID();
      const rowId = await seedTelehealthVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        m17VisitId,
      });

      await cancelConsumer.handle({
        organizationId: ORG_A,
        payload: {
          visitId: m17VisitId,
          cancelledBy: crypto.randomUUID(),
          reason: "patient request",
          reasonCode: "patient",
        },
      });

      const row = await visitRow(rowId);
      expect(row.lifecycle_state).toBe("ended_aborted");
      expect(row.end_reason).toBe("other");
      expect(row.version).toBe(1);
      expect(row.visit_ended_at).not.toBeNull();

      // Redelivery is a true no-op — already ended.
      await cancelConsumer.handle({
        organizationId: ORG_A,
        payload: {
          visitId: m17VisitId,
          cancelledBy: crypto.randomUUID(),
          reason: "patient request",
          reasonCode: "patient",
        },
      });
      expect((await visitRow(rowId)).version).toBe(1);
    });

    it("m17.visit.cancelled computes a duration when the room had already started", async () => {
      const m17VisitId = crypto.randomUUID();
      const startedAt = new Date(Date.now() - 5 * 60_000); // 5 minutes ago
      const rowId = await seedTelehealthVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        m17VisitId,
        lifecycleState: "in_progress",
        visitStartedAt: startedAt,
      });

      await cancelConsumer.handle({
        organizationId: ORG_A,
        payload: {
          visitId: m17VisitId,
          cancelledBy: crypto.randomUUID(),
          reason: "",
          reasonCode: "",
        },
      });

      const row = await visitRow(rowId);
      expect(row.lifecycle_state).toBe("ended_aborted");
      expect(row.total_duration_sec).toBeGreaterThanOrEqual(290);
    });

    it("m17.visit.cancelled is a no-op when the M17 visit never had a telehealth room", async () => {
      // No telehealth_visit row seeded for this visitId at all.
      await expect(
        cancelConsumer.handle({
          organizationId: ORG_A,
          payload: {
            visitId: crypto.randomUUID(),
            cancelledBy: crypto.randomUUID(),
            reason: "",
            reasonCode: "",
          },
        }),
      ).resolves.not.toThrow();
    });

    it("m17.visit.cancelled never touches another org's telehealth_visit row", async () => {
      const m17VisitId = crypto.randomUUID();
      const rowId = await seedTelehealthVisit({
        organizationId: ORG_B,
        providerEntityId: peB,
        m17VisitId,
      });

      await cancelConsumer.handle({
        organizationId: ORG_A,
        payload: {
          visitId: m17VisitId,
          cancelledBy: crypto.randomUUID(),
          reason: "",
          reasonCode: "",
        },
      });

      expect((await visitRow(rowId)).lifecycle_state).toBe("room_minted");
    });

    it("m17.visit.rescheduled ends the OLD visit's room", async () => {
      const oldVisitId = crypto.randomUUID();
      const rowId = await seedTelehealthVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        m17VisitId: oldVisitId,
        lifecycleState: "patient_joined",
      });

      await rescheduledConsumer.handle({
        organizationId: ORG_A,
        payload: {
          visitId: oldVisitId,
          rescheduledIntoVisitId: crypto.randomUUID(),
          oldStartedAt: new Date().toISOString(),
          newStartedAt: new Date(Date.now() + 86_400_000).toISOString(),
          reason: "clinician unavailable",
        },
      });

      const row = await visitRow(rowId);
      expect(row.lifecycle_state).toBe("ended_aborted");
      expect(row.end_reason).toBe("other");
      expect(row.version).toBe(1);
    });

    it("m17.visit.rescheduled is a no-op for an already-reconciled room", async () => {
      const oldVisitId = crypto.randomUUID();
      const encounterId = crypto.randomUUID();
      const rowId = await seedTelehealthVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        m17VisitId: oldVisitId,
        lifecycleState: "ended_clean",
      });
      await admin.query(
        `UPDATE telehealth_visit SET lifecycle_state = 'reconciled', linked_encounter_id = $2 WHERE id = $1`,
        [rowId, encounterId],
      );

      await rescheduledConsumer.handle({
        organizationId: ORG_A,
        payload: {
          visitId: oldVisitId,
          rescheduledIntoVisitId: crypto.randomUUID(),
          oldStartedAt: new Date().toISOString(),
          newStartedAt: new Date().toISOString(),
          reason: "",
        },
      });

      const row = await visitRow(rowId);
      expect(row.lifecycle_state).toBe("reconciled");
      expect(row.version).toBe(0); // untouched — canTransitionTelehealth(reconciled, ended_aborted) is false
    });

    it("m8.encounter.signed reconciles a room that already ended cleanly", async () => {
      const m17VisitId = crypto.randomUUID();
      const encounterId = crypto.randomUUID();
      const rowId = await seedTelehealthVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        m17VisitId,
        lifecycleState: "ended_clean",
      });

      await signedConsumer.handle({
        organizationId: ORG_A,
        payload: { encounterId, visitId: m17VisitId, patientId: crypto.randomUUID() },
      });

      const row = await visitRow(rowId);
      expect(row.lifecycle_state).toBe("reconciled");
      expect(row.linked_encounter_id).toBe(encounterId);
      expect(row.version).toBe(1);

      // Redelivery is a true no-op — reconciled is terminal.
      await signedConsumer.handle({
        organizationId: ORG_A,
        payload: {
          encounterId: crypto.randomUUID(),
          visitId: m17VisitId,
          patientId: crypto.randomUUID(),
        },
      });
      const after = await visitRow(rowId);
      expect(after.version).toBe(1);
      expect(after.linked_encounter_id).toBe(encounterId); // the second, different encounterId did NOT overwrite it
    });

    it("m8.encounter.signed does not reconcile a room that never formally ended (documented edge case)", async () => {
      const m17VisitId = crypto.randomUUID();
      const rowId = await seedTelehealthVisit({
        organizationId: ORG_A,
        providerEntityId: peA,
        m17VisitId,
        lifecycleState: "in_progress",
      });

      await signedConsumer.handle({
        organizationId: ORG_A,
        payload: {
          encounterId: crypto.randomUUID(),
          visitId: m17VisitId,
          patientId: crypto.randomUUID(),
        },
      });

      const row = await visitRow(rowId);
      expect(row.lifecycle_state).toBe("in_progress"); // left as-is, not forced to reconciled
      expect(row.linked_encounter_id).toBeNull();
      expect(row.version).toBe(0);
    });

    it("m8.encounter.signed is a no-op for an encounter with no visitId", async () => {
      await expect(
        signedConsumer.handle({
          organizationId: ORG_A,
          payload: { encounterId: crypto.randomUUID(), patientId: crypto.randomUUID() },
        }),
      ).resolves.not.toThrow();
    });

    it("m8.encounter.signed never touches another org's telehealth_visit row", async () => {
      const m17VisitId = crypto.randomUUID();
      const rowId = await seedTelehealthVisit({
        organizationId: ORG_B,
        providerEntityId: peB,
        m17VisitId,
        lifecycleState: "ended_clean",
      });

      await signedConsumer.handle({
        organizationId: ORG_A,
        payload: {
          encounterId: crypto.randomUUID(),
          visitId: m17VisitId,
          patientId: crypto.randomUUID(),
        },
      });

      expect((await visitRow(rowId)).lifecycle_state).toBe("ended_clean");
    });
  },
);
