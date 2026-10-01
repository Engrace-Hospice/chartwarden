/**
 * F-167 (#248) — LIVE Postgres proof that M5's `m39.consent.{signed,revoked,supersedes,renewed}`
 * binding (`buildM5ConsentPrivacyConsumer`) recomputes the real `patient_privacy_flag_snapshot` row
 * (§7.6/D10), through the real catalog-validating outbox publisher for the `m5.patient
 * .privacy_flag_changed` emit — not a stub.
 *
 * `privacy/index.ts`'s pure engine (`recomputePrivacyFlags`/`applyConsentChanged`) existed since
 * M5-T10 with no caller anywhere; this consumer is the first live binding. Proves: a
 * `42_cfr_part_2_release` sign lifts the `sud` restriction, a revoke re-imposes it, a supersede/renewal
 * of a revoked Part-2 consent re-lifts it, a non-tracked consent type (`portal_access`) is a no-op, a
 * pre-existing unrelated flag on the snapshot survives an unrelated sign/revoke untouched (the
 * merge-not-overwrite proof `mergeConsentSignal` exists for), a cross-tenant patient id is a silent
 * no-op, and a redelivery converges idempotently.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m5:consent-privacy:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
// Imported by exact file path, not the module barrel: the coordinator wires the barrel export
// (`apps/backend/src/modules/05-patient/index.ts`) centrally after independently verifying this file.
import type { M5OutboxPort } from "../src/modules/05-patient/deceased-db";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/events-by-m5";
import { buildM5ConsentPrivacyConsumer } from "../src/modules/05-patient/outbox-consumers/m39-consent-privacy";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)(
  "F-167 — M5's m39.consent.* privacy-flag-snapshot recompute — LIVE Postgres",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let outbox: M5OutboxPort;
    let consumer: ReturnType<typeof buildM5ConsentPrivacyConsumer>;

    async function resetSchema(): Promise<void> {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const role of ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
        );
      }
    }
    async function applyMigrations(): Promise<void> {
      for (const file of readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith(".sql"))
        .sort()) {
        await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      }
    }

    async function seedPatient(organizationId: string): Promise<string> {
      const row = await admin.query(
        `INSERT INTO patient
           (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth)
         VALUES ($1, $2, 'Test', 'Patient', '1950-01-01', 'female')
         RETURNING id`,
        [organizationId, `MRN-${Math.random().toString(36).slice(2, 10)}`],
      );
      return row.rows[0].id as string;
    }

    async function seedSnapshot(
      organizationId: string,
      patientId: string,
      flags: readonly string[],
    ): Promise<void> {
      await admin.query(
        `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags, captured_at)
         VALUES ($1, $2, $3, now())`,
        [patientId, organizationId, flags],
      );
    }

    async function snapshotFlags(patientId: string): Promise<string[] | null> {
      const { rows } = await admin.query(
        `SELECT flags FROM patient_privacy_flag_snapshot WHERE patient_id = $1`,
        [patientId],
      );
      return rows[0] ? (rows[0].flags as string[]) : null;
    }

    async function privacyFlagChangedRows(patientId: string): Promise<unknown[]> {
      const { rows } = await admin.query(
        `SELECT payload FROM outbox_event
         WHERE event_type = 'm5.patient.privacy_flag_changed' AND aggregate_id = $1
         ORDER BY created_at`,
        [patientId],
      );
      return rows.map((r) => r.payload);
    }

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        `INSERT INTO organization (id,slug,legal_name,display_name)
         VALUES ($1,'m39-consent-privacy-a','M39 Privacy A','M39 Privacy A'),
                ($2,'m39-consent-privacy-b','M39 Privacy B','M39 Privacy B')`,
        [ORG_A, ORG_B],
      );
      await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    }, 120_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    beforeEach(() => {
      const catalog = buildBootOutboxCatalog([M5_OUTBOX_EVENTS]);
      const txPublisher = buildTxOutboxPublisher(catalog);
      outbox = {
        publish: (tx, input) => txPublisher.publish(tx, { ...input, callerModule: "m5" }),
      };
      consumer = buildM5ConsentPrivacyConsumer({ db: handle.db, outbox });
    });

    afterEach(async () => {
      await admin.query("TRUNCATE patient_privacy_flag_snapshot, patient RESTART IDENTITY CASCADE");
      await admin.query("DELETE FROM outbox_event");
    });

    function signedPayload(organizationId: string, patientId: string, typeKey: string) {
      return {
        organizationId,
        patientId,
        consentRecordId: randomUUID(),
        typeKey,
        signedAt: new Date().toISOString(),
        signedBy: "user-1",
        captureMethod: "typed_signature_in_app",
      };
    }
    function revokedPayload(organizationId: string, patientId: string, typeKey: string) {
      return {
        organizationId,
        patientId,
        consentRecordId: randomUUID(),
        revocationId: `rev-${Math.random().toString(36).slice(2)}`,
        typeKey,
        revokedAt: new Date().toISOString(),
        revokedByKind: "patient_self_via_portal",
        cascadeKind: "immediate",
      };
    }
    function supersedesPayload(organizationId: string, patientId: string, typeKey: string) {
      return {
        organizationId,
        patientId,
        newConsentRecordId: randomUUID(),
        supersededConsentRecordId: randomUUID(),
        typeKey,
        supersededAt: new Date().toISOString(),
      };
    }
    function renewedPayload(organizationId: string, patientId: string, typeKey: string) {
      return {
        organizationId,
        patientId,
        newConsentRecordId: randomUUID(),
        renewedFromConsentRecordId: randomUUID(),
        typeKey,
        signedAt: new Date().toISOString(),
      };
    }

    function dispatchEvent(
      organizationId: string,
      eventType: string,
      patientId: string,
      payload: Record<string, unknown>,
    ) {
      return {
        id: randomUUID(),
        organizationId,
        eventType,
        aggregateKind: "consent_record",
        aggregateId: patientId,
        payload,
        attemptCount: 1,
        createdAt: new Date(),
      };
    }

    it("a 42_cfr_part_2_release sign lifts the sud restriction (flags stays empty)", async () => {
      const patientId = await seedPatient(ORG_A);
      await consumer.handle(
        dispatchEvent(
          ORG_A,
          "m39.consent.signed",
          patientId,
          signedPayload(ORG_A, patientId, "42_cfr_part_2_release"),
        ),
      );

      expect(await snapshotFlags(patientId)).toEqual([]);
      const emitted = await privacyFlagChangedRows(patientId);
      expect(emitted).toEqual([{ patientId, organizationId: ORG_A, flags: [] }]);
    });

    it("a 42_cfr_part_2_release revoke re-imposes the sud restriction", async () => {
      const patientId = await seedPatient(ORG_A);
      await consumer.handle(
        dispatchEvent(
          ORG_A,
          "m39.consent.revoked",
          patientId,
          revokedPayload(ORG_A, patientId, "42_cfr_part_2_release"),
        ),
      );

      expect(await snapshotFlags(patientId)).toEqual(["sud"]);
    });

    it("supersedes and renewed both re-lift the restriction like a fresh sign", async () => {
      const patientId1 = await seedPatient(ORG_A);
      await seedSnapshot(ORG_A, patientId1, ["sud"]);
      await consumer.handle(
        dispatchEvent(
          ORG_A,
          "m39.consent.supersedes",
          patientId1,
          supersedesPayload(ORG_A, patientId1, "42_cfr_part_2_release"),
        ),
      );
      expect(await snapshotFlags(patientId1)).toEqual([]);

      const patientId2 = await seedPatient(ORG_A);
      await seedSnapshot(ORG_A, patientId2, ["sud"]);
      await consumer.handle(
        dispatchEvent(
          ORG_A,
          "m39.consent.renewed",
          patientId2,
          renewedPayload(ORG_A, patientId2, "42_cfr_part_2_release"),
        ),
      );
      expect(await snapshotFlags(patientId2)).toEqual([]);
    });

    it("a consent type M39 does not authoritatively map (e.g. portal_access) is a no-op", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedSnapshot(ORG_A, patientId, ["sud"]);
      await consumer.handle(
        dispatchEvent(
          ORG_A,
          "m39.consent.signed",
          patientId,
          signedPayload(ORG_A, patientId, "portal_access"),
        ),
      );

      // Untouched — no write, no emit.
      expect(await snapshotFlags(patientId)).toEqual(["sud"]);
      expect(await privacyFlagChangedRows(patientId)).toEqual([]);
    });

    it("a pre-existing unrelated flag survives a sign/revoke of the tracked type untouched (merge, not overwrite)", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedSnapshot(ORG_A, patientId, ["hiv"]);

      await consumer.handle(
        dispatchEvent(
          ORG_A,
          "m39.consent.revoked",
          patientId,
          revokedPayload(ORG_A, patientId, "42_cfr_part_2_release"),
        ),
      );
      expect(await snapshotFlags(patientId)).toEqual(["hiv", "sud"]);

      await consumer.handle(
        dispatchEvent(
          ORG_A,
          "m39.consent.signed",
          patientId,
          signedPayload(ORG_A, patientId, "42_cfr_part_2_release"),
        ),
      );
      expect(await snapshotFlags(patientId)).toEqual(["hiv"]);
    });

    it("is a no-op for a patient id invisible under this org's cross-tenant read", async () => {
      const patientB = await seedPatient(ORG_B);

      await expect(
        consumer.handle(
          dispatchEvent(
            ORG_A,
            "m39.consent.revoked",
            patientB,
            revokedPayload(ORG_A, patientB, "42_cfr_part_2_release"),
          ),
        ),
      ).resolves.toBeUndefined();

      // Org B's own patient row is untouched by the org-A-scoped delivery above.
      expect(await snapshotFlags(patientB)).toBeNull();
    });

    it("converges idempotently on redelivery", async () => {
      const patientId = await seedPatient(ORG_A);
      const payload = revokedPayload(ORG_A, patientId, "42_cfr_part_2_release");

      await consumer.handle(dispatchEvent(ORG_A, "m39.consent.revoked", patientId, payload));
      await consumer.handle(dispatchEvent(ORG_A, "m39.consent.revoked", patientId, payload));

      expect(await snapshotFlags(patientId)).toEqual(["sud"]);
      // Two deliveries → two recompute-and-emit cycles (the outbox dispatcher's own receipt table is
      // what dedupes a true redelivery of the SAME event id; this consumer's own idempotency claim is
      // about the RESULTING STATE converging, not about emitting only once).
      expect(await privacyFlagChangedRows(patientId)).toHaveLength(2);
    });
  },
);
