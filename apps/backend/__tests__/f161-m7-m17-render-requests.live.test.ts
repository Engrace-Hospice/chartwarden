/**
 * F-161 (#248) — two of the seven events in M22's own `handlers-unbound` group that the register's prior
 * pass called "genuine, no catalog change needed", proven END TO END over real Postgres:
 *
 *   · `m7.care_plan.version_signed` — M7's own §2.4 catalog comment ("drives the M8 encounter gate + M22
 *     PDF") and its Phase-boundary note ("M7 emits a domain payload via outbox event for M22 to render")
 *     are both decisive. No `document_aggregate_type` existed for the care-plan PDF at all (mig 0252 adds
 *     `care_plan`). Driven here through the REAL M7 write service: bootstrap → author → finalize → the
 *     two-signature quorum → the real `m7.care_plan.version_signed` emission → the real M22 render.
 *   · `m17.caregiver_reminder_due` — M17's own catalog comment ("M22 renders the reminder, M36 delivers")
 *     is equally decisive, and `visit_confirmation` has been a published `document_aggregate_type` value
 *     since the enum's base definition with no descriptor and no consumer. Unlike M7, M17 has **no
 *     producer for this event anywhere in the codebase** — `jobs/cron-workers.ts` registers only
 *     `recurringMaterialize` and `visitAttention`, no caregiver-reminder cron (reported, not fixed here;
 *     out of `22-documents/` scope). This suite proves the M22-side consumer binding is real against the
 *     real catalogued payload shape by publishing the event directly through the real catalog-validating
 *     transactional publisher — the same proof shape a real cron's `outbox.publish()` call would produce.
 *
 * The other five events in that same group of seven — `m14.minutes.amended`, `m21.supply_request
 * .delivered`, and all three `m39.consent.{expired,recipient_added,recipient_removed}` events — are
 * deliberately NOT built here. Each checked out to be something other than a document render:
 * `minutes.amended` wants a re-render of an aggregate a (still-unbound) `m14.minutes.signed` would first
 * render — the same "new VERSION, not a new document" gap `m6.discharge.cosigned` is already deferred
 * for; `supply_request.delivered` wants an e-signature CAPTURE workflow M22 has never built any part of;
 * and all three M39 events want a signed-URL-revoke / disclosure-subsetter-cache-invalidation mechanism
 * that does not exist because M22's disclosure gate (`consent-gate.ts`) resolves M39's `ConsentEvaluator`
 * fresh on every mint — there is no persistent grant or cache for any of the three events to touch.
 *
 * Nothing is stubbed on the M22 side: the real catalog-validating transactional publisher writes the
 * row, the real `createOutboxDispatcher` claims and delivers it, M22's real render consumer resolves the
 * template, renders through the real `DocumentRenderer`, and the real Drizzle seam store writes
 * `document` + `document_version`, under RLS, as the NOBYPASSRLS `wardenx_app` role.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:f161:render-requests:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/index";
import {
  type CarePlanWriteOutboxPort,
  M7_OUTBOX_EVENTS,
  createDbCarePlanRouteService,
} from "../src/modules/07-care-plan/index";
import { M8_OUTBOX_EVENTS } from "../src/modules/08-encounters/index";
import { M9_OUTBOX_EVENTS } from "../src/modules/09-assessments/index";
import { M10_OUTBOX_EVENTS } from "../src/modules/10-hope/index";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { M14_OUTBOX_EVENTS } from "../src/modules/14-idg/index";
import { M15_OUTBOX_EVENTS } from "../src/modules/15-discipline-care-plans/index";
import { M16_OUTBOX_EVENTS } from "../src/modules/16-bereavement/index";
import { M17_OUTBOX_EVENTS } from "../src/modules/17-scheduling/index";
import { M18_OUTBOX_EVENTS } from "../src/modules/18-evv/index";
import { M19_OUTBOX_EVENTS } from "../src/modules/19-oncall/index";
import { M20_OUTBOX_EVENTS } from "../src/modules/20-field-safety/index";
import { M21_OUTBOX_EVENTS } from "../src/modules/21-supplies/index";
import {
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
import { M33_OUTBOX_EVENTS } from "../src/modules/33-reporting/index";
import { M37_OUTBOX_EVENTS } from "../src/modules/37-ipu/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const MEMBER = "44444444-4444-4444-4444-444444444444";

describe.skipIf(!DB_URL)("F-161 — M7/M17 render-request producers, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let objects: ReturnType<typeof createInMemoryObjectStore>;
  let carePlan: ReturnType<typeof createDbCarePlanRouteService>;
  let publisher: ReturnType<typeof buildTxOutboxPublisher>;
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
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f161@x.test')`, [USER]);
    await admin.query(
      "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')",
      [MEMBER, USER, ORG_A],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // M22's ONE render consumer's `eventTypes` is `[...M22_DOCUMENT_REQUEST_EVENTS]`, which spans every
    // producing module — the dispatcher refuses to CONSTRUCT when a bound consumer names an event its
    // own catalog does not carry (`assertBindableAgainstCatalog`), so both M7's and M17's catalogs must
    // be present even though this suite only DRIVES the M7 producer directly.
    // F-166 (#248) — widened from `[M7, M17, M22]`: the shared M22 render consumer's `eventTypes` is
    // `[...M22_DOCUMENT_REQUEST_EVENTS]`, which spans every producing module in the whole §4.11 list —
    // `assertBindableAgainstCatalog` validates that FULL list against the catalog at dispatcher
    // CONSTRUCTION time, not just the events this suite happens to publish, so every module the shared
    // list has ever grown to reference must be present or the dispatcher refuses to build at all. This
    // suite predates several of those additions (F-144/F-160 landed before it and were never backfilled
    // here) — confirmed via `git show HEAD:…decide-document-request.ts`, `m11.order.document_requested`
    // was already on the list before this pass touched anything, so the dispatcher-construction failure
    // this fixes is pre-existing, not a regression from F-166's own additions.
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
      M19_OUTBOX_EVENTS,
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

    // ── M7 — the real care-plan write service ───────────────────────────────────────────────────────
    const carePlanOutbox: CarePlanWriteOutboxPort = {
      publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m7" }),
    };
    carePlan = createDbCarePlanRouteService(handle.db, carePlanOutbox);

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

  // ── M7 — care_plan (the real write-service lifecycle) ──────────────────────────────────────────────

  async function signPlanToQuorum(patientId: string, admissionId: string) {
    const boot = (await carePlan.bootstrapCarePlan(ORG_A, patientId, admissionId)) as {
      id: string;
      initialVersionId: string;
    };
    const prob = (await carePlan.addProblem(ORG_A, boot.id, {
      description: "Dyspnea",
      kind: "terminal",
      source: "clinical",
    })) as { id: string };
    await carePlan.addGoal(
      ORG_A,
      boot.id,
      {
        problemId: prob.id,
        originalText: "I want to stay comfortable at home",
        source: "patient_stated",
      },
      false,
    );
    await carePlan.addIntervention(ORG_A, boot.id, {
      problemId: prob.id,
      scopeText: "Assess dyspnea each visit",
      frequencyText: "2x/week",
      frequencyValue: "2:visit:week",
      discipline: "rn",
    });
    await carePlan.finalizeVersion(ORG_A, boot.id, boot.initialVersionId, 1, null);
    await carePlan.signVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      2,
      "rn_case_manager",
      new Date().toISOString(),
      { userId: USER, membershipId: MEMBER, roles: ["rn_case_manager"] },
      "Patient verbalized understanding",
    );
    await carePlan.signVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      3,
      "hospice_physician",
      new Date().toISOString(),
      { userId: USER, membershipId: MEMBER, roles: ["hospice_physician"] },
    );
    return boot.initialVersionId;
  }

  it("the last required signature requests + renders the care-plan PDF", async () => {
    const patientId = randomUUID();
    const admissionId = randomUUID();
    const versionId = await signPlanToQuorum(patientId, admissionId);

    const emitted = await outboxFor(versionId);
    expect(emitted.map((e) => e.type)).toContain("m7.care_plan.version_signed");
    expect(await documentsFor(versionId)).toHaveLength(0);

    await dispatcher.tick();

    const docs = await documentsFor(versionId);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("care_plan");
    expect(docs[0].patient_id).toBe(patientId);
    expect(docs[0].organization_id).toBe(ORG_A);
    // F-166 (#248) — no overall `status: "dispatched"` check: `m7.care_plan.version_signed` declares
    // TWO consumers (`m22`/`m36`), and the row's aggregate status only advances once every declared
    // consumer bound in the dispatcher has run — this suite registers only M22's binding. The document
    // assertions above are the real proof M22's own binding ran.
  });

  it("a plan that never reaches quorum (finalize only) requests no render", async () => {
    const boot = (await carePlan.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as {
      id: string;
      initialVersionId: string;
    };
    const prob = (await carePlan.addProblem(ORG_A, boot.id, {
      description: "Pain",
      kind: "terminal",
      source: "clinical",
    })) as { id: string };
    await carePlan.addGoal(
      ORG_A,
      boot.id,
      { problemId: prob.id, originalText: "Comfort", source: "patient_stated" },
      false,
    );
    await carePlan.addIntervention(ORG_A, boot.id, {
      problemId: prob.id,
      scopeText: "Assess pain each visit",
      frequencyText: "2x/week",
      frequencyValue: "2:visit:week",
      discipline: "rn",
    });
    await carePlan.finalizeVersion(ORG_A, boot.id, boot.initialVersionId, 1, null);
    // Only one of the two required signatures — quorum not met, no version_signed emission.
    await carePlan.signVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      2,
      "rn_case_manager",
      new Date().toISOString(),
      { userId: USER, membershipId: MEMBER, roles: ["rn_case_manager"] },
      "Patient verbalized understanding",
    );

    const emitted = await outboxFor(boot.initialVersionId);
    expect(emitted.map((e) => e.type)).not.toContain("m7.care_plan.version_signed");
  });

  // ── M17 — visit_confirmation (no production producer; publish the real catalogued payload directly) ──

  it("the caregiver-reminder-due payload requests + renders the visit-confirmation reminder", async () => {
    const visitId = randomUUID();
    const patientId = randomUUID();
    await withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, (tx) =>
      publisher.publish(tx as never, {
        eventName: "m17.caregiver_reminder_due",
        organizationId: ORG_A,
        aggregateKind: "visit",
        aggregateId: visitId,
        payload: {
          visitId,
          patientId,
          channel: "sms",
          scheduledStartedAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
        },
        callerModule: "m17",
      }),
    );

    const emitted = await outboxFor(visitId);
    expect(emitted.map((e) => e.type)).toContain("m17.caregiver_reminder_due");
    expect(await documentsFor(visitId)).toHaveLength(0);

    await dispatcher.tick();

    const docs = await documentsFor(visitId);
    expect(docs).toHaveLength(1);
    expect(docs[0].aggregate_type).toBe("visit_confirmation");
    expect(docs[0].patient_id).toBe(patientId);
    expect(docs[0].organization_id).toBe(ORG_A);
    // F-166 (#248) — no overall `status: "dispatched"` check: `m17.caregiver_reminder_due` also
    // declares TWO consumers (`m22`/`m36`), the same reason as the M7 case above.
  });

  // ── tenancy ──────────────────────────────────────────────────────────────────────────────────────────

  it("renders under the requesting org only — org B never sees org A's F-161 documents", async () => {
    const { rows } = await admin.query(
      `SELECT DISTINCT organization_id FROM document WHERE aggregate_type IN ('care_plan','visit_confirmation')`,
    );
    expect(rows.map((r) => r.organization_id)).toEqual([ORG_A]);

    const b = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await b.connect();
    try {
      await b.query("BEGIN");
      await b.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
      const { rows: seen } = await b.query(
        `SELECT count(*)::int AS n FROM document WHERE aggregate_type IN ('care_plan','visit_confirmation')`,
      );
      expect(seen[0].n).toBe(0);
      await b.query("COMMIT");
    } finally {
      await b.end();
    }
  });
});
