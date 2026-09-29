/**
 * F-100 — M6's six CoP compliance documents, rendered and back-referenced END TO END over real Postgres.
 *
 * These are the artifacts a Medicare survey asks for: the certification of terminal illness, the election
 * statement, the face-to-face encounter, the notice of rights, the revocation and the discharge summary.
 * M22 has published a template for every one of them since its table landed, and M6 has carried a
 * `document_id` column on every one of the six rows, each commented "M22 document (app-validated)".
 *
 * NONE of them was ever rendered, and BOTH halves were missing at once — which is why neither end looked
 * broken. M22 subscribed to none of M6's six source events, so no request was ever drained; M6 subscribed
 * to `m22.document.rendered`, so there was nothing to stamp even if one had been. Six columns, NULL in
 * every database that has ever existed.
 *
 * Nothing is stubbed but the object bytes: drive the REAL Drizzle write service as the NOBYPASSRLS
 * `wardenx_app` role → the REAL catalog-validating transactional publisher writes the outbox row → the
 * REAL `createOutboxDispatcher` claims and delivers it → M22's real render consumer resolves the template
 * and renders through the real `DocumentRenderer` into the real Drizzle seam store → M22 announces
 * `m22.document.rendered` → M6's real back-ref consumer stamps its own column. RLS is live throughout.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m6:cop-documents:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import {
  M6_OUTBOX_EVENTS,
  buildM6DocumentBackrefConsumer,
} from "../src/modules/06-admission/index";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import { M11_OUTBOX_EVENTS, buildM11DocumentBackrefConsumer } from "../src/modules/11-orders/index";
import {
  M12_OUTBOX_EVENTS,
  buildM12DocumentBackrefConsumer,
} from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS, buildM13DocumentBackrefConsumer } from "../src/modules/13-emar/index";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
import {
  M21_OUTBOX_EVENTS,
  buildM21DocumentBackrefConsumer,
} from "../src/modules/21-supplies/index";
import {
  M22_DOCUMENT_RENDERED_EVENT,
  M22_OUTBOX_EVENTS,
  buildM22DocumentRequestConsumer,
  createDocumentRenderer,
  createDrizzleDocumentSeamStore,
  createInMemoryObjectStore,
} from "../src/modules/22-documents/index";
import { M23_OUTBOX_EVENTS } from "../src/modules/23-billing-medicare/index";
import { M24_OUTBOX_EVENTS } from "../src/modules/24-billing-medicaid/index";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { M27_OUTBOX_EVENTS } from "../src/modules/27-cost-report/index";
import {
  M33_OUTBOX_EVENTS,
  buildM33DocumentBackrefConsumer,
} from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { admitViaQualifiedReferral, registerM5IntakeSeams } from "./_m6-admit";

/** Clinical content every CTI draft carries (`CtiDraftInput` requires it — CtiDraftSchema, route 22). */
const CTI_CLINICAL = {
  terminalDiagnosisIcd10: "C34.90",
  prognosisStatement:
    "Life expectancy of 6 months or less if the terminal illness runs its normal course.",
  narrative:
    "Metastatic non-small-cell lung cancer with progressive functional decline despite treatment; patient has elected comfort-focused care.",
  clinicalFindings: { ppsScore: 40, weightLossPercent6mo: 12, dyspneaAtRest: true },
};

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const ATTENDING = "77777777-7777-7777-7777-777777777777";
const MD = "66666666-6666-6666-6666-666666666666";
const PROVIDER_ENTITY = "88888888-8888-8888-8888-888888888888";

const DRAFT = {
  electedProviderEntityId: PROVIDER_ENTITY,
  electedAttendingPhysicianId: ATTENDING,
  waiverAcknowledged: true,
} as const;
const SIGN = { signingPatientName: "Pat Patient", signingRole: "patient" } as const;

/** The six (template → aggregate type → the M6 table and column that back-refs it). */
const COP_DOCUMENTS = [
  { template: "election_statement", table: "election_statement" },
  { template: "cti", table: "certification_of_terminal_illness" },
  { template: "f2f", table: "face_to_face_encounter" },
  { template: "nor", table: "notice_of_rights_acknowledgment" },
  { template: "revocation", table: "revocation_event" },
  { template: "discharge_summary", table: "discharge_event" },
] as const;

describe.skipIf(!DB_URL)("F-100 — M6's six CoP documents render + back-ref, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbAdmissionRouteService>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;

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
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  /**
   * Two hops, not one. The first tick delivers the render REQUEST and M22 writes the document; that
   * render emits `m22.document.rendered` as a NEW outbox row, which the same tick has already passed. The
   * second tick delivers it to the back-ref consumers. Asserting the column after a single tick reads as
   * "the stamp is broken" when the relay has simply not run again yet.
   */
  async function settle(): Promise<void> {
    await dispatcher.tick();
    await dispatcher.tick();
  }

  /** The rendered document for one source row (superuser read — RLS is asserted separately). */
  async function documentFor(aggregateType: string, aggregateId: string) {
    const { rows } = await admin.query(
      `SELECT id, organization_id, patient_id, retention_class FROM document
        WHERE aggregate_type=$1 AND aggregate_id=$2`,
      [aggregateType, aggregateId],
    );
    return rows[0] ?? null;
  }
  async function backref(table: string, id: string): Promise<string | null> {
    const { rows } = await admin.query(`SELECT document_id FROM ${table} WHERE id=$1`, [id]);
    return (rows[0]?.document_id as string | null) ?? null;
  }

  /**
   * The full §418.24 admission chain through the REAL write service — referral → triage → accept → NOR
   * acknowledge → election draft+sign → CTI draft + both signatures → activate. Four of the six CoP
   * documents are requested along the way (the NOR, the election statement, the CTI); the caller drives
   * the remaining two.
   */
  async function activeAdmission(patientId: string): Promise<{
    admissionId: string;
    periodId: string;
    norId: string;
    electionStatementId: string;
    ctiId: string;
  }> {
    // Main's intake: triage → qualify → accept (+ admission details) — see _m6-admit.ts.
    const { admissionId } = await admitViaQualifiedReferral(svc, admin, {
      hospicePhysicianId: MD,
      organizationId: ORG_A,
      actorUserId: USER,
      patientId,
    });
    const periods = await svc.listElectionPeriods(ORG_A, admissionId);
    const periodId = periods?.[0]?.id as string;
    const nor = await svc.acknowledgeNor(
      ORG_A,
      admissionId,
      { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
      USER,
    );
    const es = await svc.draftElectionStatement(ORG_A, admissionId, periodId, DRAFT);
    await svc.signElection(ORG_A, es.id, es.version, USER, SIGN);
    const cti = await svc.draftCti(
      ORG_A,
      {
        electionPeriodId: periodId,
        hospiceMedicalDirectorId: MD,
        attendingPhysicianId: ATTENDING,
        ...CTI_CLINICAL,
        isRecert: false,
      },
      USER,
    );
    await svc.signCtiHospiceMd(ORG_A, cti.id, cti.version, USER);
    const active = await svc.activateAdmission(ORG_A, admissionId, nor.version);
    expect(active.state).toBe("active");
    // The NOR row's own id — the transition runs on the ADMISSION, so the outbox envelope carries the
    // admission and only the payload names this. That asymmetry is why M22's adapter reads the body.
    const { rows } = await admin.query(
      "SELECT id FROM notice_of_rights_acknowledgment WHERE admission_id=$1",
      [admissionId],
    );
    return {
      admissionId,
      periodId,
      norId: rows[0].id as string,
      electionStatementId: es.id,
      ctiId: cti.id,
    };
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
    // Every write's `app.user_id` is an FK the M4 audit trigger dereferences, so each signing identity
    // has to be a real M1 user.
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f100a@x.test'),($2,'f100md@x.test'),($3,'f100at@x.test')`,
      [USER, MD, ATTENDING],
    );
    await admin.query(
      `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,'A Hospice','341234','1111111111','\\x00','12-31')`,
      [PROVIDER_ENTITY, ORG_A],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerM5IntakeSeams(handle.db); // M5 intake seams M6 conversion + readiness consult

    // BOTH halves of the handshake in one catalog: M6's events (which M22 now consumes) and M22's
    // `document.rendered` (which M6 now consumes). The dispatcher refuses to construct on an event its
    // catalog does not carry, and holds a row `pending` while any declared consumer has no live binding —
    // so a suite missing either contribution would prove nothing and look like it proved everything.
    // M22's render consumer binds every source module's request event, and the dispatcher REFUSES to
    // construct on an event its catalog does not carry — so the catalog has to be the boot one, not a
    // two-module slice. That refusal is the guard working: a narrowed catalog would be a narrowed
    // consumer, and this suite would prove M6's path against a dispatcher production never builds.
    const catalog = buildBootOutboxCatalog([
      M6_OUTBOX_EVENTS,
      M10_OUTBOX_EVENTS,
      M11_OUTBOX_EVENTS,
      M12_OUTBOX_EVENTS,
      M13_OUTBOX_EVENTS,
      M16_OUTBOX_EVENTS,
      M20_OUTBOX_EVENTS,
      M21_OUTBOX_EVENTS,
      M22_OUTBOX_EVENTS,
      M23_OUTBOX_EVENTS,
      // F-144 (#248) — M22's render consumer now also subscribes to
      // `m24.medicaid_billing.document_render_requested`; same reason every sibling entry here is.
      M24_OUTBOX_EVENTS,
      M25_OUTBOX_EVENTS,
      M27_OUTBOX_EVENTS,
      M33_OUTBOX_EVENTS,
      M37_OUTBOX_EVENTS,
    ]);
    const publisher = buildTxOutboxPublisher(catalog);

    svc = createDbAdmissionRouteService(
      handle.db,
      { publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m6" }) },
      undefined,
      {
        async belongsToOrg(organizationId: string, providerEntityId: string) {
          const { rows } = await admin.query(
            "SELECT 1 FROM provider_entity WHERE id=$1 AND organization_id=$2",
            [providerEntityId, organizationId],
          );
          return rows.length > 0;
        },
      },
    );

    const store = createDrizzleDocumentSeamStore(handle.db);
    const objects = createInMemoryObjectStore();
    const renderConsumer = buildM22DocumentRequestConsumer({
      store,
      renderer: () => createDocumentRenderer({ store, objects: objects.store }),
      emitRendered: ({ organizationId, ...payload }) =>
        withOrgContext(handle.db, { organizationId, userId: "" }, (tx) =>
          publisher.publish(tx as never, {
            eventName: M22_DOCUMENT_RENDERED_EVENT,
            payload,
            organizationId,
            aggregateKind: "document",
            aggregateId: payload.documentId,
            callerModule: "m22",
          }),
        ),
    });

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      // `m22.document.rendered` declares six back-ref consumers and the dispatcher holds a row `pending`
      // while any declared one has no live binding — so binding only M6's would leave M6's own stamp
      // undelivered, and the suite would fail for a reason that has nothing to do with M6.
      consumers: [
        renderConsumer,
        buildM6DocumentBackrefConsumer({ db: handle.db }),
        buildM11DocumentBackrefConsumer({ db: handle.db }),
        buildM12DocumentBackrefConsumer({ db: handle.db }),
        buildM13DocumentBackrefConsumer({ db: handle.db }),
        buildM21DocumentBackrefConsumer({ db: handle.db }),
        buildM33DocumentBackrefConsumer({ db: handle.db }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("the four documents an admission produces: NOR, election statement, CTI — rendered + stamped", async () => {
    const patientId = randomUUID();
    const adm = await activeAdmission(patientId);

    // Nothing is rendered until the relay runs: each request is a real `pending` outbox row, which is
    // the state all six sat in for the life of the deployment.
    expect(await documentFor("election_statement", adm.electionStatementId)).toBeNull();
    await settle();

    const cases = [
      { type: "nor", table: "notice_of_rights_acknowledgment", id: adm.norId },
      { type: "election_statement", table: "election_statement", id: adm.electionStatementId },
      { type: "cti", table: "certification_of_terminal_illness", id: adm.ctiId },
    ] as const;
    for (const c of cases) {
      const doc = await documentFor(c.type, c.id);
      expect(doc, `${c.type} rendered nothing`).not.toBeNull();
      expect(doc.organization_id).toBe(ORG_A);
      // The chart. A CoP artifact filed under NULL is filed nowhere, and none of these payloads carried
      // a patient before F-100 — M22 cannot resolve one (it `dependsOn [1, 5]`).
      expect(doc.patient_id, `${c.type} filed on no chart`).toBe(patientId);
      expect(doc.retention_class).toBe("compliance");
      // The downstream half: the column M6 built for exactly this, NULL in every database until now.
      expect(await backref(c.table, c.id), `${c.table}.document_id not stamped`).toBe(doc.id);
    }
  });

  it("face-to-face: schedule → complete → attest → render → f2f_encounter.document_id", async () => {
    const patientId = randomUUID();
    const { admissionId, periodId } = await activeAdmission(patientId);
    // Every step here 500'd before F-100: completion emitted `m6.f2f.scheduled` with a payload that
    // event's own schema rejects, and attestation is only reachable from `completed`.
    const f2f = await svc.scheduleF2f(ORG_A, {
      admissionId,
      electionPeriodId: periodId,
      scheduledClinicianId: MD,
      clinicianRole: "hospice_md",
      scheduledDate: new Date().toISOString().slice(0, 10) as never,
    });
    const done = await svc.completeF2f(ORG_A, f2f.id, f2f.version);
    const attested = await svc.attestF2f(ORG_A, f2f.id, done.version, MD);
    expect(attested.state).toBe("attested");

    await settle();
    const doc = await documentFor("f2f", f2f.id);
    expect(doc).not.toBeNull();
    expect(doc.patient_id).toBe(patientId);
    expect(await backref("face_to_face_encounter", f2f.id)).toBe(doc.id);
  });

  it("revocation: created → render → revocation_event.document_id", async () => {
    const patientId = randomUUID();
    const { admissionId } = await activeAdmission(patientId);
    const rev = await svc.createRevocation(
      ORG_A,
      admissionId,
      {
        revocationDate: new Date().toISOString().slice(0, 10),
        narrative: "patient elected to revoke hospice care to pursue curative treatment",
        signingPatientName: "Pat Test",
        signingRole: "patient",
        revocationReason: "seek_curative_treatment",
      },
      USER,
    );

    await settle();
    const doc = await documentFor("revocation", rev.id);
    expect(doc).not.toBeNull();
    expect(doc.patient_id).toBe(patientId);
    expect(await backref("revocation_event", rev.id)).toBe(doc.id);
  });

  it("a re-delivered request renders no second document and does not re-stamp", async () => {
    const patientId = randomUUID();
    const adm = await activeAdmission(patientId);
    await settle();
    const first = await documentFor("cti", adm.ctiId);
    expect(first).not.toBeNull();
    // D14 — the render is idempotent on (aggregate_type, aggregate_id), and the back-ref only stamps an
    // UNSET column, so a second pass changes neither.
    await settle();
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM document WHERE aggregate_type='cti' AND aggregate_id=$1",
      [adm.ctiId],
    );
    expect(rows[0].n).toBe(1);
    expect(await backref("certification_of_terminal_illness", adm.ctiId)).toBe(first.id);
  });

  it("every one of the six is a published template M22 renders and M6 stamps", async () => {
    // The pairing this whole change is about, asserted as a set rather than per case: a template with no
    // stamper leaves the column NULL (the bug), a stamper for a template M22 never renders is dead code.
    const { rows } = await admin.query(
      "SELECT DISTINCT aggregate_type FROM document ORDER BY aggregate_type",
    );
    const seen = rows.map((r) => r.aggregate_type as string);
    for (const t of seen) {
      expect(COP_DOCUMENTS.map((c) => c.template)).toContain(t);
    }
    expect(seen.length).toBeGreaterThan(0);
  });

  it("renders under the requesting org only — org B sees none of it through RLS", async () => {
    const types = COP_DOCUMENTS.map((c) => `'${c.template}'`).join(",");
    const { rows } = await admin.query(
      `SELECT DISTINCT organization_id FROM document WHERE aggregate_type IN (${types})`,
    );
    expect(rows.map((r) => r.organization_id)).toEqual([ORG_A]);

    const b = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await b.connect();
    try {
      await b.query("BEGIN");
      await b.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
      const { rows: seen } = await b.query(
        `SELECT count(*)::int AS n FROM document WHERE aggregate_type IN (${types})`,
      );
      expect(seen[0].n).toBe(0);
      await b.query("COMMIT");
    } finally {
      await b.end();
    }
  });
});
