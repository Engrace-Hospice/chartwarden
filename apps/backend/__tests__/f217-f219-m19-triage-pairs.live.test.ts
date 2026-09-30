/**
 * F-217 / F-218 / F-219 (#248) — the three M19 triage outbox pairs, proven over real Postgres as the
 * NOBYPASSRLS `wardenx_app` role.
 *
 *   A (F-217) `m22 <- m19.triage.summary_requested` — produced by an EXPLICIT staff action
 *     (`requestSummary`, the `POST /api/v1/triage-calls/:id/request-summary` service). The REAL M19 write
 *     service -> the REAL catalog-validating transactional publisher -> the REAL `createOutboxDispatcher` ->
 *     M22's real render consumer -> the real `DocumentRenderer` into the real Drizzle seam store. Proves:
 *     the payload carries `recipientKind`, NO free-text / answer / medication ever reaches the outbox row or
 *     the rendered bytes, one document per (call, audience), a re-request appends a version (F-168), every
 *     refusal writes nothing, a vendor actor is refused, and org B cannot request or see org A's call.
 *   B (F-218) `m14 <- m19.triage_call.care_plan_change_indicated` — a SEAM PULL
 *     (`idgTriageCarePlanChangesForOrg`): tenant-scoped, since-filtered, batched, free-text-free. The end to
 *     end packet build is proven in `m14-packet-build.live.test.ts` (the fourth flagged-event source).
 *   C (F-219) `m37 <- m19.triage_call.gip_admission_proposed` — a SEAM PULL (`gipProposalsForOrg`) that
 *     M37's `listGipProposals` serves. No `ipu_admission` row exists for a proposal.
 *   B+C also: both events, published through the real publisher, now DISPATCH (they no longer wait forever
 *     on a declared-but-unbound consumer).
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:f217-f219:m19-triage-pairs:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
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
import { M6_OUTBOX_EVENTS } from "../src/modules/06-admission/index";
import { M7_OUTBOX_EVENTS } from "../src/modules/07-care-plan/index";
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
import {
  M19_OUTBOX_EVENTS,
  buildDrizzleM19ReadService,
  buildDrizzleM19WriteService,
  gipProposalsForOrg,
  idgTriageCarePlanChangesForOrg,
} from "../src/modules/19-oncall/index";
import type { M19WriteActor } from "../src/modules/19-oncall/routes/actor";
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
import { buildDrizzleIpuRouteService } from "../src/modules/37-ipu/routes/service-drizzle";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const SENTINEL = "PHI-SENTINEL-free-text-must-not-cross";

interface Seed {
  pe: string;
  member: string;
  user: string;
  shift: string;
}

describe.skipIf(!DB_URL)("F-217/F-218/F-219 — M19 triage pairs, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let objects: ReturnType<typeof createInMemoryObjectStore>;
  let writeService: ReturnType<typeof buildDrizzleM19WriteService>;
  let catalogPublisher: ReturnType<typeof buildTxOutboxPublisher>;
  const seeded: Record<string, Seed> = {};

  const actorFor = (org: string, over: Partial<M19WriteActor> = {}): M19WriteActor => ({
    organizationId: org,
    userId: seeded[org]?.user as string,
    membershipId: seeded[org]?.member as string,
    roles: ["rn_case_manager"],
    providerEntityIds: [],
    locationIds: [],
    sessionClass: "staff",
    externalActorId: null,
    stepUpRecent: false,
    ...over,
  });

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

  /** A triage call in a chosen state/disposition (superuser insert — the state machine is not under test). */
  async function seedCall(
    org: string,
    over: {
      state?: string;
      disposition?: string | null;
      dispositionData?: Record<string, unknown> | null;
      patientId?: string | null;
      openedAt?: Date;
      documentedHistoryAt?: Date | null;
    } = {},
  ): Promise<{ id: string; patientId: string | null }> {
    const s = seeded[org] as Seed;
    const state = over.state ?? "documented_pending_encounter";
    const disposition = "disposition" in over ? over.disposition : "visit_dispatched_now";
    const patientId = "patientId" in over ? over.patientId : randomUUID();
    const { rows } = await admin.query(
      `INSERT INTO triage_call (organization_id, provider_entity_id, on_call_shift_id, patient_id, caller_kind,
         inbound_channel, source, state, disposition, disposition_data, opened_at, closed_at, chief_complaint_text)
       VALUES ($1,$2,$3,$4,'caregiver','phone','manual',$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        org,
        s.pe,
        s.shift,
        patientId ?? null,
        state,
        disposition ?? null,
        over.dispositionData ? JSON.stringify(over.dispositionData) : null,
        over.openedAt ?? new Date("2026-09-30T01:15:00Z"),
        state === "closed" ? new Date("2026-09-30T02:30:00Z") : null,
        SENTINEL,
      ],
    );
    const id = rows[0].id as string;
    if (over.documentedHistoryAt !== null && state === "documented_pending_encounter") {
      await admin.query(
        `INSERT INTO triage_call_state_history (organization_id, provider_entity_id, triage_call_id, from_state,
           to_state, transitioned_at, system_actor)
         VALUES ($1,$2,$3,'disposition_pending','documented_pending_encounter',$4,true)`,
        [org, s.pe, id, over.documentedHistoryAt ?? new Date("2026-09-30T02:00:00Z")],
      );
    }
    return { id, patientId: patientId ?? null };
  }

  const outboxRows = async (eventName: string, org: string) =>
    (
      await admin.query(
        `SELECT id, status, payload, aggregate_id, last_error FROM outbox_event
          WHERE event_type=$1 AND organization_id=$2 ORDER BY created_at`,
        [eventName, org],
      )
    ).rows as Array<{
      id: string;
      status: string;
      payload: Record<string, unknown>;
      aggregate_id: string;
      last_error: string | null;
    }>;

  async function settle(): Promise<void> {
    await dispatcher.tick();
    await dispatcher.tick();
  }

  const docsFor = async (aggregateType: string, aggregateId: string) =>
    (
      await admin.query(
        `SELECT d.id AS document_id, d.organization_id, d.patient_id, d.retention_class, d.metadata,
                v.id AS version_id, v.version_number, v.source_event_id
           FROM document d JOIN document_version v ON v.document_id = d.id
          WHERE d.aggregate_type=$1 AND d.aggregate_id=$2 ORDER BY v.version_number::int`,
        [aggregateType, aggregateId],
      )
    ).rows as Array<{
      document_id: string;
      organization_id: string;
      patient_id: string | null;
      retention_class: string;
      metadata: Record<string, unknown> | null;
      version_id: string;
      version_number: string;
      source_event_id: string | null;
    }>;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'f217-a','A','A','active'),($2,'f217-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    let n = 0;
    for (const org of [ORG_A, ORG_B]) {
      const user = (
        await admin.query(`INSERT INTO "user" (email) VALUES ($1) RETURNING id`, [
          `f217-${n++}@x.test`,
        ])
      ).rows[0].id as string;
      const member = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
      const pe = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [
            org,
            `CCN-F217-${org.slice(0, 4)}`,
            `F217 ${org.slice(0, 4)}`,
            `NPI-F217-${org.slice(0, 4)}`,
          ],
        )
      ).rows[0].id as string;
      const shift = (
        await admin.query(
          `INSERT INTO on_call_shift (organization_id, provider_entity_id, shift_starts_at, shift_ends_at,
             discipline, primary_on_call_membership_id, policy_snapshot, status, opened_at)
           VALUES ($1,$2,'2026-09-30T00:00:00Z','2026-09-30T08:00:00Z','clinical_rn',$3,'{}'::jsonb,'active','2026-09-30T00:00:00Z')
           RETURNING id`,
          [org, pe, member],
        )
      ).rows[0].id as string;
      seeded[org] = { pe, member, user, shift };
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // The M22 render consumer's `eventTypes` is the WHOLE `M22_DOCUMENT_REQUEST_EVENTS` array, and
    // `createOutboxDispatcher` validates every bound type against the catalog at construction — so the full
    // producer set is required (the F-208 precedent), now including M19.
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
    catalogPublisher = buildTxOutboxPublisher(catalog);
    const readService = buildDrizzleM19ReadService(handle.db);
    writeService = buildDrizzleM19WriteService(handle.db, readService, {
      outbox: {
        publish: (tx, e) => catalogPublisher.publish(tx as never, { ...e, callerModule: "m19" }),
      },
    });

    const store = createDrizzleDocumentSeamStore(handle.db);
    objects = createInMemoryObjectStore();
    const renderConsumer = buildM22DocumentRequestConsumer({
      store,
      renderer: () => createDocumentRenderer({ store, objects: objects.store }),
    });
    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [renderConsumer],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  // ── A — F-217 ─────────────────────────────────────────────────────────────────────────────────────

  describe("A — m19.triage.summary_requested -> M22 (explicit staff action)", () => {
    it("emits a catalog-valid event carrying recipientKind and ONLY enumerated facts, then M22 renders the caregiver document", async () => {
      const call = await seedCall(ORG_A, {
        disposition: "visit_dispatched_now",
        dispositionData: {
          disposition: "visit_dispatched_now",
          requestedDiscipline: "rn",
          requestedArrivalBy: "2026-09-30T03:00:00Z",
          reason: SENTINEL,
        },
      });
      const ack = await writeService.requestSummary(actorFor(ORG_A), call.id, {
        recipientKind: "caregiver",
      });
      expect(ack).toMatchObject({
        requested: true,
        triageCallId: call.id,
        recipientKind: "caregiver",
      });

      const rows = await outboxRows("m19.triage.summary_requested", ORG_A);
      const row = rows.find((r) => r.aggregate_id === call.id);
      expect(row).toBeDefined();
      expect(row?.payload).toMatchObject({
        recipientKind: "caregiver",
        triageCallId: call.id,
        patientId: call.patientId,
        disposition: "visit_dispatched_now",
        requestedDiscipline: "rn",
        requestedArrivalBy: "2026-09-30T03:00:00.000Z",
        requestedByMembershipId: seeded[ORG_A]?.member,
      });
      // The allowlist: no free text ever reaches the outbox row.
      expect(JSON.stringify(row?.payload)).not.toContain(SENTINEL);

      await settle();
      const docs = await docsFor("triage_summary_caregiver", call.id);
      expect(docs.map((d) => d.version_number)).toEqual(["1"]);
      expect(docs[0]?.organization_id).toBe(ORG_A);
      expect(docs[0]?.patient_id).toBe(call.patientId);
      expect(docs[0]?.retention_class).toBe("clinical_record");
      // Not flagged SUD-class: the content carries no SUD-class fact by construction (no consent gate fired).
      expect(docs[0]?.metadata?.sudRedacted).toBeFalsy();
      // The attending variant does not exist until it is requested.
      expect(await docsFor("triage_summary_attending", call.id)).toHaveLength(0);

      // The rendered bytes: a real PDF, and the free-text / chief-complaint sentinels never reached them.
      const all = [...objects.objects.values()].map((b) => Buffer.from(b).toString("latin1"));
      expect(all.length).toBeGreaterThan(0);
      for (const text of all) expect(text).not.toContain(SENTINEL);
      expect(all.some((t) => t.startsWith("%PDF-"))).toBe(true);
    });

    it("a second request for the same audience APPENDS a version; the other audience is its own document (F-168)", async () => {
      const call = await seedCall(ORG_A, {
        disposition: "caregiver_education_only",
        dispositionData: { disposition: "caregiver_education_only", educationSummary: SENTINEL },
        state: "documented",
        documentedHistoryAt: null,
      });
      await writeService.requestSummary(actorFor(ORG_A), call.id, { recipientKind: "caregiver" });
      await settle();
      await writeService.requestSummary(actorFor(ORG_A), call.id, { recipientKind: "caregiver" });
      await settle();
      const caregiver = await docsFor("triage_summary_caregiver", call.id);
      expect(caregiver.map((d) => d.version_number)).toEqual(["1", "2"]);
      expect(new Set(caregiver.map((d) => d.document_id)).size).toBe(1);
      expect(new Set(caregiver.map((d) => d.source_event_id)).size).toBe(2);
      // `caregiver_education_only` stores the clinician's own words (`educationSummary`); none of it may
      // ride the outbox payload of either request.
      const mine = (await outboxRows("m19.triage.summary_requested", ORG_A)).filter(
        (r) => r.aggregate_id === call.id,
      );
      expect(mine).toHaveLength(2);
      for (const r of mine) expect(JSON.stringify(r.payload)).not.toContain(SENTINEL);

      await writeService.requestSummary(actorFor(ORG_A), call.id, { recipientKind: "attending" });
      await settle();
      const attending = await docsFor("triage_summary_attending", call.id);
      expect(attending.map((d) => d.version_number)).toEqual(["1"]);
      expect(attending[0]?.document_id).not.toBe(caregiver[0]?.document_id);
      for (const text of [...objects.objects.values()].map((b) =>
        Buffer.from(b).toString("latin1"),
      )) {
        expect(text).not.toContain(SENTINEL);
      }
    });

    it("refuses — and writes NOTHING to the outbox — for a call with no deliverable outcome", async () => {
      const before = (await outboxRows("m19.triage.summary_requested", ORG_A)).length;
      const refusals: Array<[string, Awaited<ReturnType<typeof seedCall>>]> = [
        ["open call, no disposition", await seedCall(ORG_A, { state: "open", disposition: null })],
        [
          "abandoned",
          await seedCall(ORG_A, {
            state: "abandoned",
            disposition: "abandoned",
            dispositionData: { disposition: "abandoned", reason: SENTINEL, callbackAttempts: 1 },
            documentedHistoryAt: null,
          }),
        ],
        [
          "escalated_unresolved",
          await seedCall(ORG_A, {
            state: "escalated_unresolved",
            disposition: "escalated_unresolved",
            documentedHistoryAt: null,
          }),
        ],
        // The disposition guard is independent of the state guard: a documented call whose stored
        // disposition is one of the two non-outcomes (the CHECK constraints admit it) still has nothing to tell.
        [
          "documented but disposition abandoned",
          await seedCall(ORG_A, {
            state: "documented",
            disposition: "abandoned",
            documentedHistoryAt: null,
          }),
        ],
        [
          "closed but disposition escalated_unresolved",
          await seedCall(ORG_A, {
            state: "closed",
            disposition: "escalated_unresolved",
            documentedHistoryAt: null,
          }),
        ],
        ["no patient identified", await seedCall(ORG_A, { patientId: null })],
      ];
      for (const [label, call] of refusals) {
        await expect(
          writeService.requestSummary(actorFor(ORG_A), call.id, { recipientKind: "caregiver" }),
          label,
        ).rejects.toMatchObject({ code: "TRIAGE_SUMMARY_NOT_AVAILABLE" });
      }
      expect((await outboxRows("m19.triage.summary_requested", ORG_A)).length).toBe(before);
    });

    it("refuses an external-vendor session (an in-agency disclosure) before touching the call", async () => {
      const call = await seedCall(ORG_A);
      const before = (await outboxRows("m19.triage.summary_requested", ORG_A)).length;
      await expect(
        writeService.requestSummary(
          actorFor(ORG_A, {
            sessionClass: "external_triage_vendor",
            externalActorId: randomUUID(),
          }),
          call.id,
          { recipientKind: "caregiver" },
        ),
      ).rejects.toMatchObject({ code: "TRIAGE_SUMMARY_ACTOR_FORBIDDEN" });
      expect((await outboxRows("m19.triage.summary_requested", ORG_A)).length).toBe(before);
    });

    it("cross-tenant: org B cannot request a summary for org A's call, and never sees its document", async () => {
      const call = await seedCall(ORG_A);
      await writeService.requestSummary(actorFor(ORG_A), call.id, { recipientKind: "attending" });
      await settle();
      expect((await docsFor("triage_summary_attending", call.id)).length).toBe(1);
      await expect(
        writeService.requestSummary(actorFor(ORG_B), call.id, { recipientKind: "attending" }),
      ).rejects.toMatchObject({ code: "TRIAGE_CALL_NOT_FOUND" });
      expect(
        (await outboxRows("m19.triage.summary_requested", ORG_B)).filter(
          (r) => r.aggregate_id === call.id,
        ),
      ).toHaveLength(0);
      const { rows } = await admin.query(
        `SELECT 1 FROM document WHERE aggregate_id=$1 AND organization_id=$2`,
        [call.id, ORG_B],
      );
      expect(rows).toHaveLength(0);
    });

    it("the REAL catalog refuses a summary payload with no recipientKind (the fixed payload is enforced, not documented)", async () => {
      const call = await seedCall(ORG_A);
      const before = (await outboxRows("m19.triage.summary_requested", ORG_A)).length;
      await expect(
        withOrgContext(
          handle.db,
          { organizationId: ORG_A, userId: seeded[ORG_A]?.user as string },
          async (tx) => {
            await catalogPublisher.publish(
              tx as never,
              {
                eventName: "m19.triage.summary_requested",
                callerModule: "m19",
                organizationId: ORG_A,
                aggregateKind: "triage_call",
                aggregateId: call.id,
                payload: {
                  orgId: ORG_A,
                  providerEntityId: seeded[ORG_A]?.pe,
                  triageCallId: call.id,
                  occurredAt: new Date().toISOString(),
                },
              } as never,
            );
          },
        ),
      ).rejects.toThrow(/recipientKind|payload|validation/i);
      expect((await outboxRows("m19.triage.summary_requested", ORG_A)).length).toBe(before);
    });
  });

  // ── B + C — F-218 / F-219 ─────────────────────────────────────────────────────────────────────────

  describe("B/C — the GIP-proposal read (seam pull) shared by M14 and M37", () => {
    const gipData = (extra: Record<string, unknown> = {}) => ({
      disposition: "gip_admission_proposed",
      gipCriteriaSummary: SENTINEL,
      preferredFacility: "Sunrise Inpatient Hospice",
      ...extra,
    });

    it("gipProposalsForOrg returns only GIP-proposed calls with a patient, PHI-minimal, newest first", async () => {
      const older = await seedCall(ORG_A, {
        disposition: "gip_admission_proposed",
        dispositionData: gipData(),
        documentedHistoryAt: new Date("2026-09-29T02:00:00Z"),
      });
      const newer = await seedCall(ORG_A, {
        disposition: "gip_admission_proposed",
        dispositionData: gipData({ preferredFacility: null }),
        state: "documented",
        documentedHistoryAt: null, // no history row: falls back to updated_at
      });
      // Distractors: another disposition, and a GIP call with no identified patient.
      const otherDisposition = await seedCall(ORG_A, { disposition: "visit_dispatched_now" });
      const noPatient = await seedCall(ORG_A, {
        disposition: "gip_admission_proposed",
        dispositionData: gipData(),
        patientId: null,
      });

      const proposals = await gipProposalsForOrg(handle.db, ORG_A);
      const ids = proposals.map((p) => p.triageCallId);
      expect(ids).not.toContain(otherDisposition.id);
      expect(ids).not.toContain(noPatient.id);
      expect(ids).toContain(older.id);
      expect(ids).toContain(newer.id);
      expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id)); // newest first
      for (const p of proposals) expect(p.patientId).not.toBeNull();
      const o = proposals.find((p) => p.triageCallId === older.id);
      expect(o).toMatchObject({
        patientId: older.patientId,
        proposedAt: "2026-09-29T02:00:00.000Z",
        preferredFacility: "Sunrise Inpatient Hospice",
        callState: "documented_pending_encounter",
      });
      expect(JSON.stringify(proposals)).not.toContain(SENTINEL); // the clinical free text never crosses
      expect(Object.keys(o as object).sort()).toEqual(
        [
          "admissionId",
          "callState",
          "locationId",
          "patientId",
          "preferredFacility",
          "proposedAt",
          "providerEntityId",
          "triageCallId",
        ].sort(),
      );
    });

    it("is tenant-scoped under the real NOBYPASSRLS role: each org sees only its own proposals", async () => {
      const a = await seedCall(ORG_A, {
        disposition: "gip_admission_proposed",
        dispositionData: gipData(),
      });
      const b = await seedCall(ORG_B, {
        disposition: "gip_admission_proposed",
        dispositionData: gipData(),
      });
      const fromA = (await gipProposalsForOrg(handle.db, ORG_A)).map((p) => p.triageCallId);
      const fromB = (await gipProposalsForOrg(handle.db, ORG_B)).map((p) => p.triageCallId);
      expect(fromA).toContain(a.id);
      expect(fromA).not.toContain(b.id);
      expect(fromB).toContain(b.id);
      expect(fromB).not.toContain(a.id);
      // Sanity: the rows exist — the exclusion above is RLS + the predicate, not missing data.
      const { rows } = await admin.query(
        `SELECT count(*)::int AS n FROM triage_call WHERE id IN ($1,$2)`,
        [a.id, b.id],
      );
      expect(rows[0].n).toBe(2);
    });

    it("F-218: idgTriageCarePlanChangesForOrg batches by patient, applies the since cursor, and is tenant-scoped", async () => {
      const p1 = await seedCall(ORG_A, {
        disposition: "gip_admission_proposed",
        dispositionData: gipData(),
        documentedHistoryAt: new Date("2026-09-20T00:00:00Z"),
      });
      const p1Later = await seedCall(ORG_A, {
        disposition: "gip_admission_proposed",
        dispositionData: gipData(),
        patientId: p1.patientId,
        documentedHistoryAt: new Date("2026-09-25T00:00:00Z"),
      });
      const p2 = await seedCall(ORG_A, {
        disposition: "gip_admission_proposed",
        dispositionData: gipData(),
        documentedHistoryAt: new Date("2026-08-01T00:00:00Z"),
      });
      const since = "2026-09-01T00:00:00.000Z";
      const out = await idgTriageCarePlanChangesForOrg(
        handle.db,
        ORG_A,
        [p1.patientId as string, p2.patientId as string],
        since,
      );
      expect(
        out
          .get(p1.patientId as string)
          ?.map((e) => e.sourceId)
          .sort(),
      ).toEqual([p1.id, p1Later.id].sort());
      expect(out.has(p2.patientId as string)).toBe(false); // before the cursor
      for (const e of out.get(p1.patientId as string) ?? []) {
        expect(e).toMatchObject({ kind: "triage_care_plan_change", severity: "attention" });
      }
      expect(JSON.stringify([...out.values()])).not.toContain(SENTINEL);
      // Org B asking for org A's patient gets nothing.
      expect(
        (await idgTriageCarePlanChangesForOrg(handle.db, ORG_B, [p1.patientId as string], since))
          .size,
      ).toBe(0);
      // The cap is a caller-bug guard, not a silent truncation.
      await expect(
        idgTriageCarePlanChangesForOrg(
          handle.db,
          ORG_A,
          Array.from({ length: 501 }, () => randomUUID()),
          since,
        ),
      ).rejects.toThrow(/exceeds the 500 cap/);
    });

    it("F-219: M37's listGipProposals serves the proposals through the injected M19 read — and writes no ipu_admission", async () => {
      const call = await seedCall(ORG_A, {
        disposition: "gip_admission_proposed",
        dispositionData: gipData(),
      });
      const ipuBefore = (await admin.query("SELECT count(*)::int AS n FROM ipu_admission")).rows[0]
        .n;
      const svc = buildDrizzleIpuRouteService(handle.db, {
        gipProposals: { proposalsForOrg: (org) => gipProposalsForOrg(handle.db, org) },
      });
      const actor = {
        organizationId: ORG_A,
        userId: seeded[ORG_A]?.user,
        membershipId: seeded[ORG_A]?.member,
        roles: [],
      } as never;
      const list = await svc.listGipProposals(actor);
      expect(list.map((p) => p.triageCallId)).toContain(call.id);
      const other = await svc.listGipProposals({
        ...(actor as object),
        organizationId: ORG_B,
      } as never);
      expect(other.map((p) => p.triageCallId)).not.toContain(call.id);
      expect(JSON.stringify(list)).not.toContain(SENTINEL);
      const ipuAfter = (await admin.query("SELECT count(*)::int AS n FROM ipu_admission")).rows[0]
        .n;
      expect(ipuAfter).toBe(ipuBefore); // a proposal is a READ, never an admission row
    });

    it("both events, published through the REAL publisher, DISPATCH — no declared-but-unbound consumer keeps them pending forever", async () => {
      const call = await seedCall(ORG_A, {
        disposition: "gip_admission_proposed",
        dispositionData: gipData(),
      });
      const base = {
        orgId: ORG_A,
        providerEntityId: seeded[ORG_A]?.pe,
        triageCallId: call.id,
        occurredAt: new Date().toISOString(),
        patientId: call.patientId,
      };
      await withOrgContext(
        handle.db,
        { organizationId: ORG_A, userId: seeded[ORG_A]?.user as string },
        async (tx) => {
          await catalogPublisher.publish(
            tx as never,
            {
              eventName: "m19.triage_call.gip_admission_proposed",
              callerModule: "m19",
              organizationId: ORG_A,
              aggregateKind: "triage_call",
              aggregateId: call.id,
              payload: { ...base, gipCriteriaSummary: null, preferredFacility: null },
            } as never,
          );
          await catalogPublisher.publish(
            tx as never,
            {
              eventName: "m19.triage_call.care_plan_change_indicated",
              callerModule: "m19",
              organizationId: ORG_A,
              aggregateKind: "triage_call",
              aggregateId: call.id,
              payload: { ...base, changeKind: "level_of_care_gip_proposed" },
            } as never,
          );
        },
      );
      await settle();
      for (const name of [
        "m19.triage_call.gip_admission_proposed",
        "m19.triage_call.care_plan_change_indicated",
      ]) {
        const rows = (await outboxRows(name, ORG_A)).filter((r) => r.aggregate_id === call.id);
        expect(rows, name).toHaveLength(1);
        expect(rows[0]?.status, `${name}: ${rows[0]?.last_error}`).toBe("dispatched");
      }
    });
  });
});
