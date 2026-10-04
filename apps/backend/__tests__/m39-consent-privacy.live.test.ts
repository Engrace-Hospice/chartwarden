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
 * Also the M5 Privacy Officer service (§4.2 resync / §5.1 "Privacy flags") over its REAL ports — M39's
 * `consent_record` reader, M22's intake-batch reader, M4's audit query — as the NOBYPASSRLS app role:
 * origin attribution, the DocLens batch facts (ids/dates/counts, never the evidence), a resync that
 * re-derives from M39 and emits through the real publisher, a resync that never lifts a DocLens flag,
 * the officer-attributed audit timeline, cross-tenant 404, and the queue's origin filter.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m5:consent-privacy:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbAuditQuery } from "@wardenx/audit";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
// Imported by exact file path, not the module barrel: the coordinator wires the barrel export
// (`apps/backend/src/modules/05-patient/index.ts`) centrally after independently verifying this file.
import type { M5OutboxPort } from "../src/modules/05-patient/deceased-db";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/events-by-m5";
import { rebuildPrivacySnapshotsForOrg } from "../src/modules/05-patient/jobs/snapshot-rebuild";
import { buildM5ConsentPrivacyConsumer } from "../src/modules/05-patient/outbox-consumers/m39-consent-privacy";
import { createDbPrivacyOfficerService } from "../src/modules/05-patient/privacy/officer-db";
import { buildIntakeSudBatchReader } from "../src/modules/22-documents/extraction/privacy-sud-batches";
import { buildPart2ConsentStateReader } from "../src/modules/39-consent/part2-consent-state-reader";
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
      // The Privacy Officer the resync cases act as (the M4 trigger's actor FK needs a real user row).
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'privacy-officer@m5.test')`, [
        "33333333-3333-4333-8333-333333333333",
      ]);
      // M39's platform-floor catalog row the Privacy Officer cases' Part 2 consents FK to.
      await admin.query(
        `INSERT INTO consent_type_catalog (type_key, display_name_en, scope_discriminator,
           default_expiration_seconds, max_term_seconds, capture_method_floor,
           reminder_cadence_floor, revocation_cascade_kind, is_per_recipient, is_per_named_agent,
           is_post_mortem_eligible, requires_jurisdiction_code, cfr_42_part_2_compliant,
           hipaa_164_508_compliant, body_text_template_key, m22_template_version)
         VALUES ('42_cfr_part_2_release','42 CFR Part 2 SUD Records Release','per_recipient',31536000,
           31536000,ARRAY['typed_signature_in_app']::text[],ARRAY['30_days']::text[],'immediate',
           true,false,false,false,true,false,'42_cfr_part_2_release_v1','1.0.0')
         ON CONFLICT DO NOTHING`,
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
      await admin.query(
        "TRUNCATE patient_privacy_flag_snapshot, patient, classified_page, intake_upload_batch, consent_record RESTART IDENTITY CASCADE",
      );
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

    // ── M5 Privacy Officer (§4.2 resync / §5.1 "Privacy flags") ─────────────────────────────────────
    const OFFICER = "33333333-3333-4333-8333-333333333333";
    function officerService() {
      const auditQuery = createDbAuditQuery(handle.db);
      return createDbPrivacyOfficerService(handle.db, outbox, {
        consent: buildPart2ConsentStateReader(handle.db),
        intake: buildIntakeSudBatchReader(handle.db),
        history: {
          async snapshotHistory(organizationId, patientId) {
            const page = await auditQuery.searchEvents(organizationId, {
              resourceKind: "patient_privacy_flag_snapshot",
              resourceId: patientId,
              limit: 100,
            });
            return page.items.map((e) => ({
              at: e.createdAt,
              actorUserId: e.actorUserId,
              eventType: e.eventType,
              before: e.before,
              after: e.after,
            }));
          },
        },
      });
    }
    async function seedSudBatch(
      organizationId: string,
      patientId: string,
      sudStatus: "detected" | "confirmed" | "rejected",
      opts: { discarded?: boolean; pages?: number } = {},
    ): Promise<string> {
      const id = (
        await admin.query(
          `INSERT INTO intake_upload_batch (organization_id, patient_id, initial_document_id, source_channel,
             uploaded_by_membership_id, correlation_id, status, disposition_at, sud_status,
             sud_evidence_cipher, sud_resolution_reason, sud_resolved_at, sud_resolved_by_membership_id)
           VALUES ($1,$2,gen_random_uuid(),'fax',gen_random_uuid(),'officer-live',$3,$4,$5::intake_batch_sud_status,
             'EVIDENCE-CIPHER-SECRET','REVIEWER-REASON-SECRET',
             CASE WHEN $5::intake_batch_sud_status = 'detected' THEN NULL ELSE now() END,
             CASE WHEN $5::intake_batch_sud_status = 'detected' THEN NULL ELSE gen_random_uuid() END) RETURNING id`,
          [
            organizationId,
            patientId,
            opts.discarded ? "discarded" : "in_review",
            opts.discarded ? new Date() : null,
            sudStatus,
          ],
        )
      ).rows[0].id as string;
      if (opts.pages) {
        await admin.query(
          `INSERT INTO classified_page (organization_id, intake_upload_batch_id, source_document_id,
             page_range_start, page_range_end, document_type, confidence, classifier_model_version_ref,
             document_title)
           VALUES ($1,$2,gen_random_uuid(),1,$3,'discharge_summary',0.97,'cls@test','METHADONE CLINIC')`,
          [organizationId, id, opts.pages],
        );
      }
      return id;
    }
    async function seedPart2Consent(
      organizationId: string,
      patientId: string,
      status: "active" | "expired",
    ): Promise<string> {
      return (
        await admin.query(
          `INSERT INTO consent_record (organization_id,patient_id,type_key,scope_descriptor,grantor_kind,
             effective_at,status,capture_method,capture_evidence_jsonb,created_by_id,version,
             signed_at,signed_by_id)
           VALUES ($1,$2,'42_cfr_part_2_release','{}'::jsonb,'patient_self',now() - interval '2 days',$3,
             'typed_signature_in_app','{}'::jsonb,$4,1,now() - interval '2 days',$4) RETURNING id`,
          [organizationId, patientId, status, OFFICER],
        )
      ).rows[0].id as string;
    }
    async function seedDocLensSnapshot(organizationId: string, patientId: string, origin: string) {
      await admin.query(
        `INSERT INTO patient_privacy_flag_snapshot (patient_id, organization_id, flags, captured_at, sud_flag_origin)
         VALUES ($1, $2, ARRAY['sud'], now(), $3)`,
        [patientId, organizationId, origin],
      );
    }

    it("officer view: DocLens origin, contributing batches (ids/dates/counts only), no evidence leaks", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedDocLensSnapshot(ORG_A, patientId, "m22_intake_unconfirmed");
      const live = await seedSudBatch(ORG_A, patientId, "detected", { pages: 3 });
      const discarded = await seedSudBatch(ORG_A, patientId, "detected", { discarded: true });
      const rejected = await seedSudBatch(ORG_A, patientId, "rejected");

      const view = await officerService().getPatientPrivacy(ORG_A, patientId);
      expect(view?.restrictions).toEqual([
        expect.objectContaining({ flag: "sud", origin: "intake_unconfirmed" }),
      ]);
      expect(view?.part2Consent.state).toBe("none");
      const byId = new Map(view?.intakeDetections.map((b) => [b.batchId, b]));
      expect(byId.get(live)).toMatchObject({
        sudStatus: "detected",
        contributes: true,
        pageCount: 3,
      });
      expect(byId.get(discarded)).toMatchObject({ contributes: false });
      expect(byId.get(rejected)).toMatchObject({ sudStatus: "rejected", contributes: false });
      const json = JSON.stringify(view);
      expect(json).not.toContain("EVIDENCE-CIPHER-SECRET");
      expect(json).not.toContain("REVIEWER-REASON-SECRET");
      expect(json).not.toContain("METHADONE");
    });

    it("resync with M39 silent never lifts a DocLens flag and emits nothing when the set is unchanged", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedDocLensSnapshot(ORG_A, patientId, "m22_intake_unconfirmed");
      await seedSudBatch(ORG_A, patientId, "rejected");

      const out = await officerService().resync(ORG_A, patientId, OFFICER);
      expect(out).toMatchObject({ flagsAfter: ["sud"], flagsChanged: false, eventEmitted: false });
      expect(await snapshotFlags(patientId)).toEqual(["sud"]);
      expect(await privacyFlagChangedRows(patientId)).toEqual([]);
    });

    it("resync re-derives sud from an inactive M39 Part 2 release, emits, and the timeline names the officer", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedSnapshot(ORG_A, patientId, ["hiv"]);
      const consentId = await seedPart2Consent(ORG_A, patientId, "expired");

      const svc = officerService();
      const out = await svc.resync(ORG_A, patientId, OFFICER);
      expect(out).toMatchObject({
        flagsBefore: ["hiv"],
        flagsAfter: ["hiv", "sud"],
        sourceConsentVersion: consentId,
        eventEmitted: true,
      });
      expect(await privacyFlagChangedRows(patientId)).toEqual([
        { patientId, organizationId: ORG_A, flags: ["hiv", "sud"] },
      ]);

      const view = await svc.getPatientPrivacy(ORG_A, patientId);
      expect(view?.part2Consent).toMatchObject({ state: "inactive", consentRecordId: consentId });
      const sud = view?.restrictions.find((r) => r.flag === "sud");
      expect(sud).toMatchObject({ origin: "consent", sinceFromHistory: true });
      expect(view?.history[0]).toMatchObject({
        actorUserId: OFFICER,
        action: "update",
        flagsAfter: ["hiv", "sud"],
      });
      expect(view?.drift).toEqual([]);
    });

    it("resync with an active M39 Part 2 release lifts a DocLens-confirmed flag (M39 is the source of truth)", async () => {
      const patientId = await seedPatient(ORG_A);
      await seedDocLensSnapshot(ORG_A, patientId, "m22_intake_confirmed");
      await seedSudBatch(ORG_A, patientId, "confirmed");
      await seedPart2Consent(ORG_A, patientId, "active");

      const out = await officerService().resync(ORG_A, patientId, OFFICER);
      expect(out).toMatchObject({ flagsAfter: [], sudOriginAfter: null, eventEmitted: true });
      expect(await snapshotFlags(patientId)).toEqual([]);
    });

    it("another tenant's patient is invisible to the officer view and to resync", async () => {
      const patientB = await seedPatient(ORG_B);
      await seedSnapshot(ORG_B, patientB, ["sud"]);
      const svc = officerService();
      expect(await svc.getPatientPrivacy(ORG_A, patientB)).toBeNull();
      expect(await svc.resync(ORG_A, patientB, OFFICER)).toBeNull();
      expect(await snapshotFlags(patientB)).toEqual(["sud"]);
      expect(await privacyFlagChangedRows(patientB)).toEqual([]);
    });

    it("the restricted-patients queue filters by origin and stays in its tenant", async () => {
      const unconfirmed = await seedPatient(ORG_A);
      await seedDocLensSnapshot(ORG_A, unconfirmed, "m22_intake_unconfirmed");
      const other = await seedPatient(ORG_A);
      await seedSnapshot(ORG_A, other, ["hiv"]);
      const clear = await seedPatient(ORG_A);
      await seedSnapshot(ORG_A, clear, []);
      const foreign = await seedPatient(ORG_B);
      await seedDocLensSnapshot(ORG_B, foreign, "m22_intake_unconfirmed");

      const svc = officerService();
      const all = await svc.listRestricted(ORG_A, {});
      expect(all.items.map((i) => i.patientId).sort()).toEqual([unconfirmed, other].sort());
      expect(all.counts).toMatchObject({ total: 2, intake_unconfirmed: 1, unattributed: 1 });
      const queue = await svc.listRestricted(ORG_A, { origin: "intake_unconfirmed" });
      expect(queue.items).toEqual([
        expect.objectContaining({
          patientId: unconfirmed,
          origin: "intake_unconfirmed",
          flags: ["sud"],
        }),
      ]);
    });

    // ── M5 §4.5 `patient.snapshot_rebuild` — the quarterly full rebuild (same derivation as the resync) ──
    function rebuild(organizationId: string, pageSize?: number) {
      return rebuildPrivacySnapshotsForOrg(handle.db, organizationId, {
        outbox,
        ports: {
          consent: buildPart2ConsentStateReader(handle.db),
          intake: buildIntakeSudBatchReader(handle.db),
        },
        pageSize,
      });
    }
    async function snapshotRow(patientId: string) {
      const { rows } = await admin.query(
        `SELECT flags, sud_flag_origin, source_consent_version, captured_at, invalidated_at
           FROM patient_privacy_flag_snapshot WHERE patient_id = $1`,
        [patientId],
      );
      return rows[0] ?? null;
    }

    it("rebuild reconciles drift org-wide: stale cleared, consent-lifted flag lifted, DocLens flag kept, missed consent applied", async () => {
      // Stale snapshot, flags already right: rewritten (invalidated_at cleared), no event.
      const stale = await seedPatient(ORG_A);
      await seedSnapshot(ORG_A, stale, ["hiv"]);
      await admin.query(
        "UPDATE patient_privacy_flag_snapshot SET invalidated_at = now() WHERE patient_id = $1",
        [stale],
      );
      // Consent-derived `sud` whose Part 2 release is now in force (a missed `signed` delivery): lifted.
      const lifted = await seedPatient(ORG_A);
      await seedSnapshot(ORG_A, lifted, ["sud"]);
      await admin.query(
        "UPDATE patient_privacy_flag_snapshot SET source_consent_version = gen_random_uuid() WHERE patient_id = $1",
        [lifted],
      );
      const liftedConsent = await seedPart2Consent(ORG_A, lifted, "active");
      // DocLens interim flag, M39 silent, detection rejected: KEPT, untouched (no write, no event).
      const docLens = await seedPatient(ORG_A);
      await seedDocLensSnapshot(ORG_A, docLens, "m22_intake_unconfirmed");
      await seedSudBatch(ORG_A, docLens, "rejected");
      const docLensBefore = await snapshotRow(docLens);
      // No row at all, but M39 holds an expired release (a missed `expired` delivery): restricted.
      const missed = await seedPatient(ORG_A);
      await seedPart2Consent(ORG_A, missed, "expired");
      // Nothing anywhere: still no row.
      const clean = await seedPatient(ORG_A);

      const summary = await rebuild(ORG_A);
      expect(summary).toEqual({
        organizationId: ORG_A,
        patients: 5,
        rewritten: 3,
        flagsChanged: 2,
        staleCleared: 1,
        unchanged: 2,
        failed: 0,
      });

      expect(await snapshotRow(stale)).toMatchObject({ flags: ["hiv"], invalidated_at: null });
      expect(await privacyFlagChangedRows(stale)).toEqual([]);

      expect(await snapshotRow(lifted)).toMatchObject({
        flags: [],
        source_consent_version: liftedConsent,
      });
      expect(await privacyFlagChangedRows(lifted)).toEqual([
        { patientId: lifted, organizationId: ORG_A, flags: [] },
      ]);

      expect(await snapshotRow(docLens)).toEqual(docLensBefore);
      expect(await privacyFlagChangedRows(docLens)).toEqual([]);

      expect(await snapshotRow(missed)).toMatchObject({ flags: ["sud"], sud_flag_origin: null });
      expect(await privacyFlagChangedRows(missed)).toEqual([
        { patientId: missed, organizationId: ORG_A, flags: ["sud"] },
      ]);

      expect(await snapshotRow(clean)).toBeNull();

      // The job writes as the SYSTEM: the M4 trail of the rewritten row names no acting user.
      const view = await officerService().getPatientPrivacy(ORG_A, lifted);
      expect(view?.history[0]).toMatchObject({ actorUserId: null, flagsAfter: [] });
    });

    it("rebuild is idempotent — a second run writes nothing and emits nothing", async () => {
      const a = await seedPatient(ORG_A);
      await seedPart2Consent(ORG_A, a, "expired");
      const b = await seedPatient(ORG_A);
      await seedDocLensSnapshot(ORG_A, b, "m22_intake_unconfirmed");
      await seedSudBatch(ORG_A, b, "detected");

      expect(await rebuild(ORG_A)).toMatchObject({ rewritten: 1, flagsChanged: 1 });
      const rowA = await snapshotRow(a);
      const events = (await privacyFlagChangedRows(a)).length;
      expect(await rebuild(ORG_A)).toMatchObject({ patients: 2, rewritten: 0, unchanged: 2 });
      expect(await snapshotRow(a)).toEqual(rowA);
      expect(await privacyFlagChangedRows(a)).toHaveLength(events);
      expect(await privacyFlagChangedRows(b)).toEqual([]);
    });

    it("rebuild pages through a large org (one transaction per patient) and never touches another tenant", async () => {
      const mine: string[] = [];
      for (let i = 0; i < 5; i++) {
        const id = await seedPatient(ORG_A);
        await seedPart2Consent(ORG_A, id, "expired");
        mine.push(id);
      }
      // ORG_B: drifted (expired release, no row) and stale — an ORG_A run must leave both alone.
      const foreign = await seedPatient(ORG_B);
      await seedPart2Consent(ORG_B, foreign, "expired");
      const foreignStale = await seedPatient(ORG_B);
      await seedSnapshot(ORG_B, foreignStale, ["sud"]);
      await admin.query(
        "UPDATE patient_privacy_flag_snapshot SET invalidated_at = now() WHERE patient_id = $1",
        [foreignStale],
      );

      const summary = await rebuild(ORG_A, 2);
      expect(summary).toMatchObject({ patients: 5, rewritten: 5, flagsChanged: 5, failed: 0 });
      for (const id of mine) expect(await snapshotFlags(id)).toEqual(["sud"]);

      expect(await snapshotRow(foreign)).toBeNull();
      expect(await privacyFlagChangedRows(foreign)).toEqual([]);
      expect((await snapshotRow(foreignStale))?.invalidated_at).not.toBeNull();

      // ORG_B's own run reconciles ORG_B only.
      expect(await rebuild(ORG_B)).toMatchObject({ patients: 2, rewritten: 2, staleCleared: 1 });
      expect(await snapshotFlags(foreign)).toEqual(["sud"]);
    });
  },
);
