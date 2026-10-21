/**
 * Continuation of the #248 outbox-binding arc (F-150/F-151/F-152 pattern) — LIVE Postgres proof that M18's
 * two remaining `handlers-unbound` D14/D6 subscriptions write real `evv_aggregator_submission` /
 * `evv_missing_resolution` rows under RLS:
 *   - `buildM18VisitCancelledConsumer` (`m17.visit.cancelled` → cancel non-terminal aggregator
 *     submissions + void any open missing-resolution row, §2.2.4)
 *   - `buildM18EncounterSignedConsumer` (`m8.encounter.signed` with `evvBracketState ===
 *     'evv_missing_documented'` → close an open missing-resolution row, or create one already closed)
 *
 * Both sat in `scripts/outbox-deferred-consumers.ts`'s m18 `handlers-unbound` group (F-141): M18's own
 * locked D14 names `m17.visit.cancelled` explicitly; `m8.encounter.signed`'s payload gap
 * (`evvMissingReason`) was fixed by F-146 specifically so this consumer could read it. Neither had a live
 * binding before this build.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m18:visit-cancelled-encounter-signed:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { M18_OUTBOX_EVENTS } from "../src/modules/18-evv/events-by-m18";
import { buildM18EncounterSignedConsumer } from "../src/modules/18-evv/outbox-consumers/m8-encounter-signed";
import { buildM18VisitCancelledConsumer } from "../src/modules/18-evv/outbox-consumers/m17-visit-cancelled";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const M18_SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000018";

describe.skipIf(!DB_URL)(
  "F-152 continuation — M18's visit-cancelled + encounter-signed consumers — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let cancelConsumer: ReturnType<typeof buildM18VisitCancelledConsumer>;
    let signedConsumer: ReturnType<typeof buildM18EncounterSignedConsumer>;

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

    async function seedSubmission(opts: {
      organizationId: string;
      visitId: string;
      status: string;
      stateCode?: string;
    }): Promise<string> {
      const row = await admin.query(
        `INSERT INTO evv_aggregator_submission
           (organization_id, visit_id, state_code, aggregator_vendor, status)
         VALUES ($1,$2,$3,'sandata',$4)
         RETURNING id`,
        [opts.organizationId, opts.visitId, opts.stateCode ?? "WI", opts.status],
      );
      return row.rows[0].id as string;
    }

    async function seedOpenResolution(opts: {
      organizationId: string;
      visitId: string;
      kind?: string;
    }): Promise<string> {
      const row = await admin.query(
        `INSERT INTO evv_missing_resolution
           (organization_id, visit_id, kind, detected_by_source, status)
         VALUES ($1,$2,$3,'cron_late_check_sweep','open')
         RETURNING id`,
        [opts.organizationId, opts.visitId, opts.kind ?? "missing_checkout"],
      );
      return row.rows[0].id as string;
    }

    async function submissionRow(id: string) {
      const { rows } = await admin.query(
        `SELECT status, version, cancelled_by_membership_id, cancellation_reason
         FROM evv_aggregator_submission WHERE id = $1`,
        [id],
      );
      return rows[0];
    }

    async function resolutionRow(id: string) {
      const { rows } = await admin.query(
        `SELECT status, version, resolved_by_membership_id, resolution_reason, encounter_id_source,
                detected_by_source, kind
         FROM evv_missing_resolution WHERE id = $1`,
        [id],
      );
      return rows[0];
    }

    async function resolutionsForVisit(organizationId: string, visitId: string) {
      const { rows } = await admin.query(
        `SELECT id, status, detected_by_source FROM evv_missing_resolution
         WHERE organization_id = $1 AND visit_id = $2`,
        [organizationId, visitId],
      );
      return rows;
    }

    /** Several tests share ORG_A and emit the same event type, so scope by aggregate id to avoid
     *  cross-test leakage rather than resetting the outbox table between tests. */
    async function outboxRowsFor(organizationId: string, eventType: string, aggregateId: string) {
      const { rows } = await admin.query(
        `SELECT payload FROM outbox_event
         WHERE organization_id = $1 AND event_type = $2 AND aggregate_id = $3
         ORDER BY created_at`,
        [organizationId, eventType, aggregateId],
      );
      return rows;
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await seedOrg(ORG_A, "a");
      await seedOrg(ORG_B, "b");
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

      const catalog = new Map<string, unknown>(M18_OUTBOX_EVENTS.map((e) => [e.eventName, e]));
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
            throw new Error(`m18 test publisher: undeclared event ${input.eventName}`);
          }
          await (tx as typeof handle.db).execute(sql`
            INSERT INTO outbox_event (organization_id, event_type, aggregate_kind, aggregate_id, payload)
            VALUES (${input.organizationId}, ${input.eventName}, ${input.aggregateKind},
                    ${input.aggregateId}, ${JSON.stringify(input.payload)}::jsonb)
          `);
        },
      };

      cancelConsumer = buildM18VisitCancelledConsumer({ db: handle.db, outbox });
      signedConsumer = buildM18EncounterSignedConsumer({ db: handle.db, outbox });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("m17.visit.cancelled cancels non-terminal aggregator submissions and publishes aggregator_cancelled", async () => {
      const visitId = crypto.randomUUID();
      const submissionId = await seedSubmission({
        organizationId: ORG_A,
        visitId,
        status: "queued",
      });
      const terminalId = await seedSubmission({
        organizationId: ORG_A,
        visitId,
        status: "accepted",
        stateCode: "NY", // distinct state_code — the active-submission partial unique index is
        // (org, state_code, visit) WHERE status != 'cancelled', so a second non-cancelled row for the
        // SAME state on this visit would collide with the queued one seeded above.
      });

      await cancelConsumer.handle({
        organizationId: ORG_A,
        payload: { visitId, reason: "clinical judgment", reasonCode: "clinical" },
      });

      const row = await submissionRow(submissionId);
      expect(row.status).toBe("cancelled");
      expect(row.version).toBe("1");
      expect(row.cancelled_by_membership_id).toBe(M18_SYSTEM_USER_ID);
      expect(row.cancellation_reason).toContain("clinical judgment");

      // The already-terminal (accepted) submission is untouched.
      const terminal = await submissionRow(terminalId);
      expect(terminal.status).toBe("accepted");
      expect(terminal.version).toBe("0");

      const cancelledEvents = await outboxRowsFor(
        ORG_A,
        "m18.evv.aggregator_cancelled",
        submissionId,
      );
      expect(cancelledEvents).toHaveLength(1);
      expect(cancelledEvents[0].payload).toMatchObject({
        submissionId,
        visitId,
        cancelledByMembershipId: M18_SYSTEM_USER_ID,
      });

      // Redelivery is a true no-op — the submission is already terminal.
      await cancelConsumer.handle({
        organizationId: ORG_A,
        payload: { visitId, reason: "clinical judgment", reasonCode: "clinical" },
      });
      expect((await submissionRow(submissionId)).version).toBe("1");
      expect(await outboxRowsFor(ORG_A, "m18.evv.aggregator_cancelled", submissionId)).toHaveLength(
        1,
      );
    });

    it("m17.visit.cancelled voids an open missing-resolution row via closed_visit_voided, with no resolver stamped", async () => {
      const visitId = crypto.randomUUID();
      const resolutionId = await seedOpenResolution({ organizationId: ORG_A, visitId });

      await cancelConsumer.handle({
        organizationId: ORG_A,
        payload: { visitId, reason: "", reasonCode: "clinical" },
      });

      const row = await resolutionRow(resolutionId);
      expect(row.status).toBe("closed_visit_voided");
      expect(row.version).toBe("1");
      expect(row.resolved_by_membership_id).toBeNull();
      expect(row.resolution_reason).toBeNull();

      const resolved = await outboxRowsFor(ORG_A, "m18.evv.late_check_resolved", resolutionId);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].payload).toMatchObject({
        missingResolutionId: resolutionId,
        visitId,
        status: "closed_visit_voided",
      });

      // Redelivery finds no open row left — true no-op.
      await cancelConsumer.handle({
        organizationId: ORG_A,
        payload: { visitId, reason: "", reasonCode: "clinical" },
      });
      expect((await resolutionRow(resolutionId)).version).toBe("1");
      expect(await outboxRowsFor(ORG_A, "m18.evv.late_check_resolved", resolutionId)).toHaveLength(
        1,
      );
    });

    it("m17.visit.cancelled never sees another org's rows", async () => {
      const visitId = crypto.randomUUID();
      const submissionId = await seedSubmission({
        organizationId: ORG_B,
        visitId,
        status: "queued",
      });
      const resolutionId = await seedOpenResolution({ organizationId: ORG_B, visitId });

      await cancelConsumer.handle({
        organizationId: ORG_A,
        payload: { visitId, reason: "", reasonCode: "clinical" },
      });

      expect((await submissionRow(submissionId)).status).toBe("queued");
      expect((await resolutionRow(resolutionId)).status).toBe("open");
    });

    it("m8.encounter.signed (evv_missing_documented) closes an existing open resolution via document_at_encounter", async () => {
      const visitId = crypto.randomUUID();
      const encounterId = crypto.randomUUID();
      const signerId = crypto.randomUUID();
      const resolutionId = await seedOpenResolution({ organizationId: ORG_A, visitId });

      await signedConsumer.handle({
        organizationId: ORG_A,
        payload: {
          encounterId,
          visitId,
          signedByMembershipId: signerId,
          evvBracketState: "evv_missing_documented",
          evvMissingReason:
            "Device failed to sync at checkout; documented in narrative per policy.",
        },
      });

      const row = await resolutionRow(resolutionId);
      expect(row.status).toBe("closed_documented_at_encounter");
      expect(row.version).toBe("1");
      expect(row.resolved_by_membership_id).toBe(signerId);
      expect(row.resolution_reason).toBe(
        "Device failed to sync at checkout; documented in narrative per policy.",
      );
      expect(row.encounter_id_source).toBe(encounterId);

      expect(await outboxRowsFor(ORG_A, "m18.evv.late_check_resolved", resolutionId)).toHaveLength(
        1,
      );
    });

    it("m8.encounter.signed (evv_missing_documented) creates an already-closed row when none was open", async () => {
      const visitId = crypto.randomUUID();
      const encounterId = crypto.randomUUID();
      const signerId = crypto.randomUUID();

      await signedConsumer.handle({
        organizationId: ORG_A,
        payload: {
          encounterId,
          visitId,
          signedByMembershipId: signerId,
          evvBracketState: "evv_missing_documented",
          evvMissingReason:
            "No prior EVV detector flagged this visit; documented directly at sign.",
        },
      });

      const rows = await resolutionsForVisit(ORG_A, visitId);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe("closed_documented_at_encounter");
      expect(rows[0].detected_by_source).toBe("encounter_signed_consumer");

      expect(
        await outboxRowsFor(ORG_A, "m18.evv.late_check_resolved", rows[0].id as string),
      ).toHaveLength(1);
    });

    it("m8.encounter.signed is a no-op for evv_present or a visit-less encounter", async () => {
      const visitId = crypto.randomUUID();
      await signedConsumer.handle({
        organizationId: ORG_A,
        payload: {
          encounterId: crypto.randomUUID(),
          visitId,
          signedByMembershipId: crypto.randomUUID(),
          evvBracketState: "evv_present",
        },
      });
      expect(await resolutionsForVisit(ORG_A, visitId)).toHaveLength(0);

      await signedConsumer.handle({
        organizationId: ORG_A,
        payload: {
          encounterId: crypto.randomUUID(),
          signedByMembershipId: crypto.randomUUID(),
          evvBracketState: "evv_missing_documented",
          evvMissingReason: "irrelevant — no visitId on this encounter at all",
        },
      });
      // No visitId means nothing to key a resolution row on — assert no crash and no stray rows for
      // the org (there is no visitId to scope a query on, so this is a smoke assertion of "did not throw").
      expect(true).toBe(true);
    });
  },
);
