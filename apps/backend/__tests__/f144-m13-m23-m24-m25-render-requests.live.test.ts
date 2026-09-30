/**
 * F-144 (#248) — four §4.11 render-request events that were catalogued, spec-named by their producing
 * module's own document-request table, and had NO EMITTER anywhere in the codebase, END TO END over
 * real Postgres.
 *
 *   · `m13.administration_record.document_requested` — the pure `@wardenx/emar` machine has declared
 *     this as a `commit`-time effect on `perAdministrationPdfRequired` since M13-T03; the DB write
 *     service (`emar-route-service-db.ts`) reimplements `commit` inline rather than calling
 *     `transitionAdministration` (the M11/M12 convention this module follows) and never read the effect
 *     list — so the request was computed and thrown away. Fixed by reading the tenant PDF-policy flag
 *     directly and emitting at `commit`.
 *   · `m23.billing.document_render_requested` — M23's own §4.10 table names this as the SOLE M22
 *     handshake for all four of its document kinds (`consumers/document-render.ts`'s four typed
 *     builders had every payload shape and no caller). Co-emitted at NOE/NOTR `submit`
 *     (`noe-notr-state-service.ts`) and at claim `ack_277ca_accepted` / `ack_277ca_rejected`
 *     (`claim-state-service.ts`), in the SAME transaction as the fact each announces.
 *   · `m24.medicaid_billing.document_render_requested` — the identical shape one module over. Co-emitted
 *     at the Medicaid claim's ACK_ACCEPTED transition (`jobs/submission-jobs.ts`), the one M24 document
 *     kind the module's own transition table names as document-relevant today.
 *   · `m25.denial_resolution_letter.render_requested` — co-emitted at `resolveDenial` (the manual,
 *     no-appeal resolution transition; `routes/write-service-drizzle.ts`).
 *
 * All four ALSO needed the M22 side of the handshake wired for the first time: `M22_DOCUMENT_REQUEST_
 * EVENTS` did not name any of them (three were never named anywhere; the fourth sat in
 * `M22_ANTICIPATED_DOCUMENT_REQUEST_EVENTS`), `REQUEST_SHAPES` had no adapter for any of them, and
 * `PLATFORM_TEMPLATE_TABLE` had no descriptor for six of the seven templates behind them (mig 0251 adds
 * the `document_aggregate_type` values). M22's own render consumer's `eventTypes` is `[...
 * M22_DOCUMENT_REQUEST_EVENTS]`, so the SAME already-registered live binding now also drains these —
 * this suite proves that end to end rather than trusting it from the source diff.
 *
 * Nothing is stubbed on the M22 side: the real catalog-validating transactional publisher writes the
 * row, the real `createOutboxDispatcher` claims and delivers it, M22's real render consumer resolves the
 * template, renders through the real `DocumentRenderer`, and the real Drizzle seam store writes
 * `document` + `document_version`, under RLS, as the NOBYPASSRLS `wardenx_app` role. The M13/M23/M25
 * PRODUCER calls are driven through the real production write services. M24's producer
 * (`runClaimSubmit`) is driven directly against a minimal fake `MedicaidAdapter` — the wire mechanics
 * this worker exists to drive (a real MMIS endpoint) are out of scope for any test in this repo (see
 * `submission-jobs.ts`'s own header) — everything on THIS side of that boundary (the claim-state
 * transition, the two outbox emissions, the render) is real.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:f144:render-requests:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import type { MedicaidAdapter, MedicaidAdapterRegistry } from "@wardenx/medicaid-adapters";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/index";
import { M7_OUTBOX_EVENTS } from "../src/modules/07-care-plan/index";
import { M8_OUTBOX_EVENTS } from "../src/modules/08-encounters/index";
import { M9_OUTBOX_EVENTS } from "../src/modules/09-assessments/index";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import { M15_OUTBOX_EVENTS } from "../src/modules/15-discipline-care-plans/index";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import { M17_OUTBOX_EVENTS } from "../src/modules/17-scheduling/index";
import { M18_OUTBOX_EVENTS } from "../src/modules/18-evv/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
import { M21_OUTBOX_EVENTS } from "../src/modules/21-supplies/index";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { M24_OUTBOX_EVENTS } from "../src/modules/24-billing-medicaid/index";
import {
  type CredentialResolverPort,
  type M24SubmissionWorkerDeps,
  type WorkerOutboxPort,
  runClaimSubmit,
} from "../src/modules/24-billing-medicaid/jobs/submission-jobs";
import {
  M22_OUTBOX_EVENTS,
  buildM22DocumentRequestConsumer,
  createDocumentRenderer,
  createDrizzleDocumentSeamStore,
  createInMemoryObjectStore,
} from "../src/modules/22-documents/index";
import {
  type EmarMedicationOrderPort,
  type EmarWriteOutboxPort,
  createDbEmarBackend,
} from "../src/modules/13-emar/emar-route-service-db";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/index";
import {
  type BillingWriteActor,
  buildClaimStateService,
} from "../src/modules/23-billing-medicare/services/claim-state-service";
import { buildNoeNotrStateService } from "../src/modules/23-billing-medicare/services/noe-notr-state-service";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { buildDrizzleM25WriteService } from "../src/modules/25-remittance/routes/write-service-drizzle";
import type { M25WriteActor } from "../src/modules/25-remittance/routes/actor";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const MED_ORDER = "66666666-6666-6666-6666-666666666666";
const ELECTION_PERIOD = "77777777-7777-4777-8777-777777777777";

describe.skipIf(!DB_URL)("F-144 — M13/M23/M24/M25 render-request producers, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let objects: ReturnType<typeof createInMemoryObjectStore>;
  let emar: ReturnType<typeof createDbEmarBackend>;
  let claims: ReturnType<typeof buildClaimStateService>;
  let notices: ReturnType<typeof buildNoeNotrStateService>;
  let denials: ReturnType<typeof buildDrizzleM25WriteService>;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
  const memberOf: Record<string, string> = {};
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};
  const renderedKeys: string[] = [];

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
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
  async function outboxFor(aggregateId: string): Promise<{ type: string; status: string }[]> {
    const { rows } = await admin.query(
      "SELECT event_type, status FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => ({ type: r.event_type as string, status: r.status as string }));
  }
  async function documentsFor(aggregateId: string) {
    const { rows } = await admin.query(
      `SELECT d.id, d.organization_id, d.aggregate_type, d.patient_id, d.retention_class, d.title,
              v.mime_type, v.byte_size
         FROM document d JOIN document_version v ON v.document_id = d.id
        WHERE d.aggregate_id=$1 ORDER BY v.version_number`,
      [aggregateId],
    );
    return rows;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f144@x.test')`, [USER]);
    for (const org of [ORG_A, ORG_B]) {
      memberOf[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;
      providerOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-F144-${org.slice(0, 4)}`, `F144 ${org.slice(0, 4)}`, `NPI-F144-${org.slice(0, 4)}`],
        )
      ).rows[0].id as string;
      locationOf[org] = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerOf[org]],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // M22's ONE render consumer's `eventTypes` is `[...M22_DOCUMENT_REQUEST_EVENTS]`, which spans every
    // producing module — the dispatcher refuses to CONSTRUCT when a bound consumer names an event its
    // own catalog does not carry (`assertBindableAgainstCatalog`), so all of them must be present here
    // even though this suite only drives the M13/M23/M24/M25 producers (the gap-023 precedent).
    // F-166 (#248) — widened to add M7/M8/M14/M15/M17/M18: the shared M22 render consumer's
    // `eventTypes` spans every producing module in the whole `M22_DOCUMENT_REQUEST_EVENTS` list, and
    // `assertBindableAgainstCatalog` validates that FULL list against the catalog at dispatcher
    // CONSTRUCTION time — every module the list has ever grown to reference must be present or the
    // dispatcher refuses to build, regardless of which events this suite actually publishes. This
    // suite predates F-161's/F-166's additions and was never backfilled (the same pre-existing gap
    // fixed in f161-m7-m17-render-requests.live.test.ts's own catalog list).
    const catalog = buildBootOutboxCatalog([
      M6_OUTBOX_EVENTS,
      M7_OUTBOX_EVENTS,
      M8_OUTBOX_EVENTS,
      M9_OUTBOX_EVENTS,
      M10_OUTBOX_EVENTS,
      M11_OUTBOX_EVENTS,
      M12_OUTBOX_EVENTS,
      M13_OUTBOX_EVENTS,
      M14_OUTBOX_EVENTS,
      M15_OUTBOX_EVENTS,
      M16_OUTBOX_EVENTS,
      M17_OUTBOX_EVENTS,
      M18_OUTBOX_EVENTS,
      M20_OUTBOX_EVENTS,
      M21_OUTBOX_EVENTS,
      M22_OUTBOX_EVENTS,
      M23_OUTBOX_EVENTS,
      M24_OUTBOX_EVENTS,
      M25_OUTBOX_EVENTS,
      M27_OUTBOX_EVENTS,
      M33_OUTBOX_EVENTS,
      M37_OUTBOX_EVENTS,
    ]);
    publisher = buildTxOutboxPublisher(catalog);

    // ── M13 ──────────────────────────────────────────────────────────────────────────────────────────
    const m13Outbox: EmarWriteOutboxPort = {
      publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m13" }),
    };
    const medicationOrder: EmarMedicationOrderPort = {
      async administrationIdentity({ medicationOrderId }) {
        if (medicationOrderId !== MED_ORDER) return null;
        return {
          patientId: PATIENT,
          admissionId: ADMISSION,
          drugName: "Morphine Sulfate Oral Solution",
          route: "oral",
          ivContinuousPolicy: null,
          allowAdministration: true,
          blockedReasons: [],
        };
      },
    };
    emar = createDbEmarBackend(handle.db, m13Outbox, undefined, () => medicationOrder);

    // ── M23 ──────────────────────────────────────────────────────────────────────────────────────────
    const m23Outbox = {
      publish: (tx: unknown, e: { eventName: string; payload: Record<string, unknown>; organizationId: string; aggregateKind: string; aggregateId: string }) =>
        publisher.publish(tx as never, { ...e, callerModule: "m23" }),
    };
    claims = buildClaimStateService(handle.db as never, { outbox: m23Outbox });
    notices = buildNoeNotrStateService(handle.db as never, { outbox: m23Outbox });

    // ── M25 ──────────────────────────────────────────────────────────────────────────────────────────
    const m25Outbox = {
      publish: (tx: unknown, e: { eventName: string; payload: Record<string, unknown>; organizationId: string; aggregateKind: string; aggregateId: string }) =>
        publisher.publish(tx as never, { ...e, callerModule: "m25" }),
    };
    denials = buildDrizzleM25WriteService(handle.db, m25Outbox);

    // ── M22 — the real render path ──────────────────────────────────────────────────────────────────
    objects = createInMemoryObjectStore();
    const store = createDrizzleDocumentSeamStore(handle.db);
    const renderer = createDocumentRenderer({ store, objects: objects.store });
    const m22Consumer = buildM22DocumentRequestConsumer({
      store,
      renderer: () => ({
        render: (scope, templateKey, payload) => {
          renderedKeys.push(templateKey);
          return renderer.render(scope, templateKey, payload);
        },
      }),
    });

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [m22Consumer],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  const actorFor = (org: string): BillingWriteActor => ({
    organizationId: org,
    userId: USER,
    roles: ["billing_clerk"],
    membershipId: memberOf[org]!,
    stepUpRecent: true,
    actorKind: "user",
  });

  // ── M13 — administration_record.document_requested ──────────────────────────────────────────────────

  it("a recorded administration with the tenant PDF policy ON requests + renders its eMAR PDF", async () => {
    await admin.query(
      `INSERT INTO administration_policy (organization_id, emar_per_administration_pdf_enabled)
       VALUES ($1, true)`,
      [ORG_A],
    );
    const view = await emar.recordAdministration(ORG_A, memberOf[ORG_A]!, {
      medicationOrderId: MED_ORDER,
      medClass: "standard",
      mode: "single_dose",
      administeredAt: new Date().toISOString(),
      route: "oral",
      doseAmount: 5,
      doseUnit: "mg",
    });

    const emitted = await outboxFor(view.id);
    expect(emitted.map((e) => e.type)).toContain("m13.administration_record.document_requested");
    expect(await documentsFor(view.id)).toHaveLength(0);

    await dispatcher.tick();

    const docs = await documentsFor(view.id);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("medication_administration_record");
    expect(docs[0].patient_id).toBe(PATIENT);
    expect(docs[0].organization_id).toBe(ORG_A);
    expect(
      (await outboxFor(view.id)).find(
        (e) => e.type === "m13.administration_record.document_requested",
      )?.status,
    ).toBe("dispatched");
  });

  it("a recorded administration with the tenant PDF policy OFF requests nothing", async () => {
    await admin.query(
      `UPDATE administration_policy SET emar_per_administration_pdf_enabled = false WHERE organization_id=$1`,
      [ORG_A],
    );
    const view = await emar.recordAdministration(ORG_A, memberOf[ORG_A]!, {
      medicationOrderId: MED_ORDER,
      medClass: "standard",
      mode: "single_dose",
      administeredAt: new Date().toISOString(),
      route: "oral",
      doseAmount: 5,
      doseUnit: "mg",
    });
    const emitted = await outboxFor(view.id);
    expect(emitted.map((e) => e.type)).not.toContain(
      "m13.administration_record.document_requested",
    );
  });

  // ── M23 — noe/notr confirmation receipts ─────────────────────────────────────────────────────────────

  async function seedNoe(): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO noe_record
           (organization_id, provider_entity_id, patient_id, admission_id, election_period_id, state,
            election_effective_date, window_target_at, noe_control_number)
         VALUES ($1,$2,$3,$4,$5,'READY', now()::date, now()::date + interval '5 days', 'NOE-CTL-1')
         RETURNING id`,
        [ORG_A, providerOf[ORG_A], PATIENT, ADMISSION, ELECTION_PERIOD],
      )
    ).rows[0].id as string;
  }
  async function seedNotr(): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO notr_record
           (organization_id, provider_entity_id, patient_id, admission_id, trigger_kind, discharge_event_id,
            state, effective_end_date, window_target_at, notr_control_number)
         VALUES ($1,$2,$3,$4,'discharge',$5,'READY', now()::date, now()::date + interval '5 days', 'NOTR-CTL-1')
         RETURNING id`,
        [ORG_A, providerOf[ORG_A], PATIENT, ADMISSION, randomUUID()],
      )
    ).rows[0].id as string;
  }

  it("a submitted NOE requests + renders its confirmation receipt", async () => {
    const noeId = await seedNoe();
    const result = await notices.transition(actorFor(ORG_A), {
      kind: "noe",
      noticeId: noeId,
      expectedVersion: 0,
      event: "submit",
      extra: { submissionId: randomUUID(), submittedAt: new Date().toISOString() },
    });
    expect(result.emittedEvents).toContain("m23.billing.document_render_requested");

    await dispatcher.tick();
    const docs = await documentsFor(noeId);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("noe_confirmation_receipt");
    expect(docs[0].patient_id).toBe(PATIENT);
  });

  it("a submitted NOTR requests + renders its confirmation receipt", async () => {
    const notrId = await seedNotr();
    const result = await notices.transition(actorFor(ORG_A), {
      kind: "notr",
      noticeId: notrId,
      expectedVersion: 0,
      event: "submit",
      extra: { submissionId: randomUUID(), submittedAt: new Date().toISOString() },
    });
    expect(result.emittedEvents).toContain("m23.billing.document_render_requested");

    await dispatcher.tick();
    const docs = await documentsFor(notrId);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("notr_confirmation_receipt");
    expect(docs[0].patient_id).toBe(PATIENT);
  });

  // ── M23 — claim acknowledgment letter / denial-appeal cover letter ──────────────────────────────────

  // F-158's own live-suite fixture bug, one file over: `claim_active_by_range_uidx` is a partial unique
  // index on (provider_entity_id, patient_id, service_from, service_to), so every seeded claim in this
  // suite needs its OWN service period — a fixed literal collides the moment a second test seeds one.
  async function seedClaim(state: string, ccn: string, serviceFrom: string, serviceTo: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO claim (
           id, organization_id, provider_entity_id, patient_id, admission_id,
           election_period_id_from, election_period_id_to, patient_payer_id,
           tob, service_from, service_to, claim_control_number,
           mac_jurisdiction, state, total_charge_cents, sequestration_applied_pct,
           sequestration_policy_id, created_by_membership_id
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$6,$7,'811',$8,$9,$10,'ngs_j6',$11,50000,'2.00',$12,$13
         ) RETURNING id`,
        [
          randomUUID(),
          ORG_A,
          providerOf[ORG_A],
          PATIENT,
          ADMISSION,
          ELECTION_PERIOD,
          randomUUID(),
          serviceFrom,
          serviceTo,
          ccn,
          state,
          randomUUID(),
          memberOf[ORG_A],
        ],
      )
    ).rows[0].id as string;
  }

  it("a claim ack_277ca_accepted requests + renders the claim acknowledgment letter", async () => {
    const claimId = await seedClaim("ACK_PENDING", "CLM-CTL-ACK-1", "2026-09-01", "2026-09-30");
    const result = await claims.transition(actorFor(ORG_A), {
      claimId,
      expectedVersion: 0,
      event: "ack_277ca_accepted",
      extra: { acknowledgmentId: randomUUID(), payerClaimControlNumber: "PAYER-CTL-1" },
    });
    expect(result.emittedEvents).toContain("m23.billing.document_render_requested");

    await dispatcher.tick();
    const docs = await documentsFor(claimId);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("claim_acknowledgment_letter");
    expect(docs[0].patient_id).toBe(PATIENT);
  });

  it("a claim ack_277ca_rejected requests + renders the denial-appeal cover letter", async () => {
    const claimId = await seedClaim("ACK_PENDING", "CLM-CTL-REJ-1", "2026-10-01", "2026-10-31");
    const result = await claims.transition(actorFor(ORG_A), {
      claimId,
      expectedVersion: 0,
      event: "ack_277ca_rejected",
      extra: { acknowledgmentId: randomUUID(), rejectionCodes: ["A7"] },
    });
    expect(result.emittedEvents).toContain("m23.billing.document_render_requested");

    await dispatcher.tick();
    const docs = await documentsFor(claimId);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("denial_appeal_cover_letter");
    expect(docs[0].patient_id).toBe(PATIENT);
  });

  // ── M24 — Medicaid claim acknowledgment letter ───────────────────────────────────────────────────────

  it("a Medicaid claim ACK_ACCEPTED requests + renders its acknowledgment letter", async () => {
    const claimId = randomUUID();
    const submissionId = randomUUID();
    await admin.query(
      `INSERT INTO medicaid_claim (
         id, organization_id, provider_entity_id, patient_id, patient_payer_id, admission_id,
         service_state, kind, tob, service_from, service_to, state_plan_code_id,
         state_plan_code_snapshot, medicaid_claim_control_number, state,
         created_by_membership_id, updated_by_membership_id
       ) VALUES (
         $1,$2,$3,$4,$5,$6,'OR','hospice_only','811','2026-09-01','2026-09-30',$7,
         'PLAN-1','MCD-CTL-1','SUBMITTED',$8,$8
       )`,
      [claimId, ORG_A, providerOf[ORG_A], PATIENT, randomUUID(), ADMISSION, randomUUID(), memberOf[ORG_A]],
    );
    await admin.query(
      `INSERT INTO medicaid_submission (
         id, organization_id, medicaid_claim_id, provider_entity_id, service_state, channel,
         medicaid_claim_control_number, adapter_vendor, adapter_version, result
       ) VALUES ($1,$2,$3,$4,'OR','direct_mmis','MCD-CTL-1','pending','0.0.0','pending')`,
      [submissionId, ORG_A, claimId, providerOf[ORG_A]],
    );

    const fakeAdapter: MedicaidAdapter = {
      state: "OR",
      vendor: "fake-mmis",
      version: "1.0.0",
      metadata: {
        acceptsDocumentedMissingEvv: false,
        combinesHospiceAndRb: false,
        hasNoeEquivalent: false,
        supportedChannels: ["direct_mmis"],
        ackMode: "sync",
        supportedTobs: ["811"],
      },
      replacementTob: (t) => t,
      voidTob: (t) => t,
      eligibilityCheck: async () => {
        throw new Error("not used in this test");
      },
      assembleSubmissionPayload: async () => ({
        body: new Uint8Array(),
        idempotencyKey: "idem-1",
        channel: "direct_mmis",
        mcoId: null,
      }),
      submit: async () => ({
        result: "accepted_sync",
        vendorTransactionId: "vendor-tx-1",
        ack277ca: { kind: "sync_277ca", outcome: "accepted", payerClaimControlNumber: "PAYER-MCD-1" },
      }),
      poll: async () => {
        throw new Error("not used in this test");
      },
      parseAcknowledgment: async () => {
        throw new Error("not used in this test");
      },
      parseRemittance: async () => {
        throw new Error("not used in this test");
      },
      rateLookup: async () => {
        throw new Error("not used in this test");
      },
      healthy: async () => ({ ok: true, lastChecked: new Date().toISOString(), latencyMs: 1, channelStatus: {} }),
    };
    const adapters: MedicaidAdapterRegistry = {
      adapterForState: (state: string) => (state === "OR" ? fakeAdapter : null),
      requireAdapterForState: (state: string) => {
        if (state !== "OR") throw new Error("unsupported state");
        return fakeAdapter;
      },
    } as never;
    const credentials: CredentialResolverPort = {
      async resolve() {
        return {
          providerEntityId: providerOf[ORG_A]!,
          serviceState: "OR",
          channel: "direct_mmis",
          mcoId: null,
          tradingPartnerId: "TP-1",
          clientId: null,
          clientSecret: null,
          sftpHost: null,
          sftpUser: null,
          sftpKey: null,
          portalUrl: null,
          additionalConfig: null,
        };
      },
    };
    const outbox: WorkerOutboxPort = {
      publish: (tx, e) =>
        publisher.publish(tx as never, {
          ...e,
          organizationId: ORG_A,
          aggregateKind: "medicaid_claim",
          aggregateId: claimId,
          callerModule: "m24",
        }),
    };
    const deps: M24SubmissionWorkerDeps = {
      connection: {} as never,
      db: handle.db,
      outbox,
      adapters,
      credentials,
    };

    await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      runClaimSubmit(tx as never, deps, { organizationId: ORG_A, claimId, submissionId }),
    );

    const emitted = await outboxFor(claimId);
    expect(emitted.map((e) => e.type)).toContain("m24.medicaid_billing.document_render_requested");

    await dispatcher.tick();
    const docs = await documentsFor(claimId);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("medicaid_claim_acknowledgment_letter");
    expect(docs[0].patient_id).toBe(PATIENT);
  });

  // ── M25 — denial resolution letter ───────────────────────────────────────────────────────────────────

  // `denial_case_has_subject` (mig 0081) requires at least one of claim_id / remittance_line_id /
  // source_evv_aggregator_submission_id — a claim-less denial (the D9 pre-835 EVV-aggregator seed
  // shape, F-099's own "honest null, not fabricated" precedent) still needs a subject to satisfy it.
  async function seedDenial(claimId: string | null): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO denial_case
           (organization_id, provider_entity_id, claim_id, source_evv_aggregator_submission_id,
            carc_code, category, source, state, dollar_value, taxonomy_status)
         VALUES ($1,$2,$3,$4,'50','denial','claim_rejection_277ca','in_progress','100.00','mapped')
         RETURNING id`,
        [ORG_A, providerOf[ORG_A], claimId, claimId ? null : randomUUID()],
      )
    ).rows[0].id as string;
  }

  it("resolving a denial with a claim requests + renders the resolution letter, patientId resolved from M23", async () => {
    const claimId = await seedClaim("PAID", "CLM-CTL-DEN-1", "2026-11-01", "2026-11-30");
    const denialId = await seedDenial(claimId);
    const result = await denials.resolveDenial(actorFor2(ORG_A), denialId, { reason: "resolved" }, 1);
    expect(result.id).toBe(denialId);

    const emitted = await outboxFor(denialId);
    expect(emitted.map((e) => e.type)).toContain("m25.denial_resolution_letter.render_requested");

    await dispatcher.tick();
    const docs = await documentsFor(denialId);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("denial_resolution_letter");
    expect(docs[0].patient_id).toBe(PATIENT);
  });

  it("resolving a denial with NO claim renders honestly with no patient (F-099)", async () => {
    const denialId = await seedDenial(null);
    await denials.resolveDenial(actorFor2(ORG_A), denialId, { reason: "resolved" }, 1);

    await dispatcher.tick();
    const docs = await documentsFor(denialId);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("denial_resolution_letter");
    expect(docs[0].patient_id).toBeNull();
  });

  function actorFor2(org: string): M25WriteActor {
    return {
      organizationId: org,
      userId: USER,
      roles: ["billing_clerk"],
      membershipId: memberOf[org]!,
      stepUpRecent: true,
    };
  }

  // ── tenancy ──────────────────────────────────────────────────────────────────────────────────────────

  it("renders under the requesting org only — org B never sees org A's F-144 documents", async () => {
    const { rows } = await admin.query(
      `SELECT DISTINCT organization_id FROM document WHERE aggregate_type IN (
         'medication_administration_record','noe_confirmation_receipt','notr_confirmation_receipt',
         'claim_acknowledgment_letter','denial_appeal_cover_letter',
         'medicaid_claim_acknowledgment_letter','denial_resolution_letter')`,
    );
    expect(rows.map((r) => r.organization_id)).toEqual([ORG_A]);

    const b = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await b.connect();
    try {
      await b.query("BEGIN");
      await b.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
      const { rows: seen } = await b.query(
        `SELECT count(*)::int AS n FROM document WHERE aggregate_type IN (
           'medication_administration_record','noe_confirmation_receipt','notr_confirmation_receipt',
           'claim_acknowledgment_letter','denial_appeal_cover_letter',
           'medicaid_claim_acknowledgment_letter','denial_resolution_letter')`,
      );
      expect(seen[0].n).toBe(0);
      await b.query("COMMIT");
    } finally {
      await b.end();
    }
  });
});
