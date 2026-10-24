/**
 * GAP-091 — M30 PHI lists (incident / mortality / infection event), LIVE Postgres.
 *
 * `listIncidents` used to read the newest 200 rows and filter + paginate in memory, so older records were
 * unreachable; and no M30 PHI route applied patient scope (RLS on these tables is org-only). The reads now
 * push filters, the caseload scope and a keyset cursor into SQL.
 *
 * Everything runs as the NOBYPASSRLS `chartwarden_app` role over the production `buildDrizzleM30ReadService`
 * and the REAL M5 `CaseloadProvider` reading seeded `patient_assignment` rows. The first test proves the
 * harness bites (an un-scoped app read sees zero rows while the superuser sees all of them); the paging
 * test seeds 250 incidents (more than the old 200-row window) and pages through every one of them.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m30:phi-scope:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { NotFoundError } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCaseloadProvider,
  createDrizzleCaseloadStore,
} from "../src/modules/05-patient/index";
import {
  buildDrizzleM30ReadService,
  buildDrizzleM30WriteService,
} from "../src/modules/30-quality/index";
import {
  type M30ReadActor,
  type M30WriteActor,
  m30SystemWriteActor,
} from "../src/modules/30-quality/routes/actor";
import {
  type CaseloadLookup,
  type QualityPatientScope,
  type QualityReadSurface,
  resolveQualityPatientScope,
} from "../src/modules/30-quality/routes/patient-scope";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { seedM5Patient } from "./_m6-admit";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
];

const ORG_A = "11111111-1111-1111-1111-111111111191";
const ORG_B = "11111111-1111-1111-1111-111111111192";
const PE_A = "00000000-0000-0000-0000-000000000a91";
const PE_B = "00000000-0000-0000-0000-000000000b91";
const CLINICIAN = "00000000-0000-0000-0000-0000000c1191"; // caseload: PAT_1 only
const NO_CASELOAD = "00000000-0000-0000-0000-0000000c2291";
const PAT_1 = "00000000-0000-0000-0000-0000000e1191";
const PAT_2 = "00000000-0000-0000-0000-0000000e2291";
const PAT_B = "00000000-0000-0000-0000-0000000eb191";
const MEDICAL_DIRECTOR = "00000000-0000-0000-0000-0000000d0191"; // a real-shaped user id (the audit actor is uuid-typed)
const REPORTER = "00000000-0000-0000-0000-0000000a0191"; // a membership id (logical FK only)

const PER_PATIENT = 125; // 2 x 125 = 250 incidents for org A, above the old 200-row window
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);
const MINUTE = 60_000;

const actorOf = (userId: string, roles: readonly string[]): M30ReadActor => ({
  organizationId: ORG_A,
  userId,
  roles,
});

describe.skipIf(!DB_URL)("GAP-091 M30 PHI scope + keyset paging — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let read: ReturnType<typeof buildDrizzleM30ReadService>;
  let caseload: CaseloadLookup;

  async function applyMigrations() {
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw index stripped: no pgvector)");
      }
      await admin.query(sql);
    }
  }

  async function seedIncident(args: {
    org: string;
    pe: string;
    patient: string | null;
    at: Date;
    kind?: string;
    severity?: string;
  }): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO incident_report
         (id, organization_id, provider_entity_id, kind, kind_data, patient_id, occurred_at,
          reported_by_membership_id, severity, lifecycle)
       VALUES ($1,$2,$3,$4,'{}'::jsonb,$5,$6,$7,$8,'submitted')`,
      [
        id,
        args.org,
        args.pe,
        args.kind ?? "fall",
        args.patient,
        args.at,
        REPORTER,
        args.severity ?? "moderate",
      ],
    );
    return id;
  }

  async function seedMortality(patient: string, at: Date): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO mortality_review
         (id, organization_id, provider_entity_id, deceased_patient_id, admission_id, death_at, status,
          target_completion_at, created_via_event_idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)`,
      [
        id,
        ORG_A,
        PE_A,
        patient,
        randomUUID(),
        at,
        new Date(at.getTime() + 30 * 86_400_000),
        randomUUID(),
      ],
    );
    return id;
  }

  async function seedInfection(patient: string | null, at: Date): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO infection_surveillance_event
         (id, organization_id, provider_entity_id, patient_id, observed_at, pathogen, body_site,
          transmission_context, filed_by_membership_id)
       VALUES ($1,$2,$3,$4,$5,'norovirus','gi','facility',$6)`,
      [id, ORG_A, PE_A, patient, at, REPORTER],
    );
    return id;
  }

  const scopeFor = (
    actor: M30ReadActor,
    readSurface?: QualityReadSurface,
  ): Promise<QualityPatientScope> => resolveQualityPatientScope(actor, () => caseload, readSurface);

  /** Walk every page of the incident list and return all ids, newest first. */
  async function allIncidentIds(
    actor: M30ReadActor,
    filter: Parameters<typeof read.listIncidents>[1] = {},
    limit = 100,
    readSurface?: Parameters<typeof scopeFor>[1],
  ): Promise<string[]> {
    const scope = await scopeFor(actor, readSurface);
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await read.listIncidents(actor, filter, cursor, limit, scope);
      ids.push(...page.items.map((i) => i.incidentId));
      if (!page.hasMore || !page.nextCursor) return ids;
      cursor = page.nextCursor;
    }
    throw new Error("paging did not terminate");
  }

  let p1Incidents: string[] = []; // newest first
  let patientLessIncident = "";
  let abuseIncident = "";

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    }
    await applyMigrations();
    for (const [id, slug] of [
      [ORG_A, "org-a"],
      [ORG_B, "org-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    for (const [pe, org, n] of [
      [PE_A, ORG_A, "A"],
      [PE_B, ORG_B, "B"],
    ] as const) {
      await admin.query(
        `INSERT INTO provider_entity (id,organization_id,legal_name,ccn,npi,tax_id_encrypted,fiscal_year_end)
         VALUES ($1,$2,'PE ${n}',$3,$4,'enc','12-31')`,
        [pe, org, `12345${n === "A" ? 6 : 7}`, `123456789${n === "A" ? 3 : 4}`],
      );
    }
    // The write-audit trigger casts the actor to uuid and `audit_event.actor_user_id` is a FK to "user":
    // every actor id the service-layer cases act as must be a real user row.
    for (const u of [CLINICIAN, NO_CASELOAD, MEDICAL_DIRECTOR, REPORTER]) {
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [u, `${u}@gap091.test`]);
    }
    for (const p of [PAT_1, PAT_2]) await seedM5Patient(admin, ORG_A, p);
    await seedM5Patient(admin, ORG_B, PAT_B);
    await admin.query(
      `INSERT INTO patient_assignment
         (patient_id, organization_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,'primary_rn','2026-01-01')`,
      [PAT_1, ORG_A, CLINICIAN],
    );

    // 250 incidents: even minutes -> PAT_1, odd -> PAT_2. Every pair of neighbouring PAT_1 rows shares a
    // timestamp with the next PAT_2 row's neighbour so paging must break ties on id, not skip or repeat.
    const p1: { id: string; at: number }[] = [];
    for (let n = 0; n < PER_PATIENT * 2; n++) {
      const at = new Date(BASE + Math.floor(n / 2) * MINUTE); // two rows per minute (a tie)
      const patient = n % 2 === 0 ? PAT_1 : PAT_2;
      const id = await seedIncident({
        org: ORG_A,
        pe: PE_A,
        patient,
        at,
        severity: n % 5 === 0 ? "severe" : "moderate",
      });
      if (patient === PAT_1) p1.push({ id, at: at.getTime() });
    }
    patientLessIncident = await seedIncident({
      org: ORG_A,
      pe: PE_A,
      patient: null,
      at: new Date(BASE - MINUTE),
    });
    abuseIncident = await seedIncident({
      org: ORG_A,
      pe: PE_A,
      patient: PAT_1,
      at: new Date(BASE - 2 * MINUTE),
      kind: "allegation_of_abuse",
    });
    await seedIncident({ org: ORG_B, pe: PE_B, patient: PAT_B, at: new Date(BASE) });
    p1Incidents = p1.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1)).map((r) => r.id);

    for (let n = 0; n < 4; n++) {
      await seedMortality(n % 2 === 0 ? PAT_1 : PAT_2, new Date(BASE + n * MINUTE));
      await seedInfection(n % 2 === 0 ? PAT_1 : PAT_2, new Date(BASE + n * MINUTE));
    }
    await seedInfection(null, new Date(BASE + 10 * MINUTE)); // staff exposure: no patient

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    read = buildDrizzleM30ReadService(handle.db);
    caseload = createCaseloadProvider(createDrizzleCaseloadStore(handle.db));
  }, 300_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("harness bites: the app handle is RLS-enforced (no org context => zero rows; superuser sees all)", async () => {
    const asApp = await handle.pool.query("SELECT count(*)::int AS n FROM incident_report");
    const asSuper = await admin.query("SELECT count(*)::int AS n FROM incident_report");
    expect(asSuper.rows[0].n).toBe(PER_PATIENT * 2 + 3);
    expect(asApp.rows[0].n).toBe(0);
  });

  it("an org-wide role pages through ALL 250 incidents (past the old 200-row window), no dup, no gap", async () => {
    const ids = await allIncidentIds(actorOf(MEDICAL_DIRECTOR, ["medical_director"]), {}, 100);
    // 250 patient rows + the patient-less one; the abuse allegation is hidden without the permission.
    expect(ids).toHaveLength(PER_PATIENT * 2 + 1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(abuseIncident);
    expect(ids).toContain(patientLessIncident);
  });

  it("pages of a small size still terminate exactly and agree with one big page", async () => {
    const actor = actorOf(MEDICAL_DIRECTOR, ["medical_director"]);
    const small = await allIncidentIds(actor, {}, 7);
    const big = await allIncidentIds(actor, {}, 100);
    expect(small).toEqual(big);
  });

  it("filters are applied in SQL: an old record is reachable by date, severity narrows the whole set", async () => {
    const actor = actorOf(MEDICAL_DIRECTOR, ["medical_director"]);
    const severe = await allIncidentIds(actor, { severities: ["severe"] });
    expect(severe).toHaveLength((PER_PATIENT * 2) / 5);
    const oldest = await allIncidentIds(actor, {
      occurredBefore: new Date(BASE).toISOString(),
      occurredAfter: new Date(BASE).toISOString(),
    });
    expect(oldest).toHaveLength(2); // the two rows tied at the very oldest minute
  });

  it("RLS-ISE-03: a caseload-scoped clinician gets ONLY their caseload (+ patient-less), not the org", async () => {
    const ids = await allIncidentIds(actorOf(CLINICIAN, ["rn_case_manager"]));
    expect(ids.filter((i) => i !== patientLessIncident)).toEqual(p1Incidents);
  });

  it("an empty caseload sees no patient incident at all (fails closed)", async () => {
    const ids = await allIncidentIds(actorOf(NO_CASELOAD, ["rn_case_manager"]));
    expect(ids).toEqual([patientLessIncident]);
  });

  it("an explicit patient filter outside the caseload is a 404, not an empty page", async () => {
    const actor = actorOf(CLINICIAN, ["rn_case_manager"]);
    await expect(
      read.listIncidents(actor, { patientId: PAT_2 }, undefined, 50, await scopeFor(actor)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("incident detail outside the caseload is a 404; inside it succeeds", async () => {
    const actor = actorOf(CLINICIAN, ["rn_case_manager"]);
    const scope = await scopeFor(actor);
    const out = (await allIncidentIds(actorOf(MEDICAL_DIRECTOR, ["medical_director"]))).find(
      (id) => !p1Incidents.includes(id) && id !== patientLessIncident,
    ) as string;
    await expect(read.getIncident(actor, out, scope)).rejects.toBeInstanceOf(NotFoundError);
    const detail = await read.getIncident(actor, p1Incidents[0] as string, scope);
    expect(detail.patientId).toBe(PAT_1);
  });

  it("mortality: caseload-scoped list + detail", async () => {
    const actor = actorOf(CLINICIAN, ["rn_case_manager"]);
    const scope = await scopeFor(actor);
    const page = await read.listMortalityReviews(actor, {}, undefined, 50, scope);
    expect(page.items.map((r) => r.patientId)).toEqual([PAT_1, PAT_1]);
    const orgPage = await read.listMortalityReviews(
      actorOf(MEDICAL_DIRECTOR, ["medical_director"]),
      {},
      undefined,
      50,
      { kind: "org" },
    );
    expect(orgPage.items).toHaveLength(4);
    const other = orgPage.items.find((r) => r.patientId === PAT_2);
    await expect(
      read.getMortalityReview(actor, other?.reviewId as string, scope),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("infection events: caseload-scoped, staff-exposure (patient-less) rows stay visible, paging is exact", async () => {
    const actor = actorOf(CLINICIAN, ["rn_case_manager"]);
    const scope = await scopeFor(actor);
    const first = await read.listInfectionEvents(actor, {}, undefined, 2, scope);
    expect(first.items).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const second = await read.listInfectionEvents(
      actor,
      {},
      first.nextCursor ?? undefined,
      2,
      scope,
    );
    const all = [...first.items, ...second.items];
    expect(second.hasMore).toBe(false);
    // 2 PAT_1 events + the patient-less staff exposure; PAT_2's are hidden.
    expect(all).toHaveLength(3);
    expect(all.some((e) => e.patientId === PAT_2)).toBe(false);
  });

  // ── GAP-091 follow-up: the WRITE path is scoped at the service layer too (route predicate skipped) ──
  describe("service-layer write scope (a caller that skips the route predicate)", () => {
    const writeActor = (userId: string, roles: readonly string[]): M30WriteActor => ({
      ...actorOf(userId, roles),
      membershipId: REPORTER,
    });
    const incidentArgs = (patientId?: string) => ({
      kind: "fall" as const,
      severity: "moderate" as const,
      patientId,
      occurredAt: new Date(BASE + 999 * MINUTE).toISOString(),
      data: {},
    });
    const infectionArgs = (patientId: string) => ({
      patientId,
      pathogen: "norovirus",
      bodySite: "gi",
      observedAt: new Date(BASE + 999 * MINUTE).toISOString(),
    });
    // The REAL M5 CaseloadProvider through the production resolver, over the NOBYPASSRLS app role.
    const write = () =>
      buildDrizzleM30WriteService(handle.db, {
        providerEntity: { primaryProviderEntityId: async () => PE_A },
        patientScope: scopeFor,
      });

    it("createIncident / recordInfectionEvent for an out-of-caseload patient are 404 and write nothing", async () => {
      const before = await admin.query("SELECT count(*)::int AS n FROM incident_report");
      const rn = writeActor(CLINICIAN, ["rn_case_manager"]);
      await expect(write().createIncident(rn, incidentArgs(PAT_2))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(write().recordInfectionEvent(rn, infectionArgs(PAT_2))).rejects.toBeInstanceOf(
        NotFoundError,
      );
      const after = await admin.query("SELECT count(*)::int AS n FROM incident_report");
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it("an in-caseload patient and a patient-less incident are accepted", async () => {
      const rn = writeActor(CLINICIAN, ["rn_case_manager"]);
      const withPatient = await write().createIncident(rn, incidentArgs(PAT_1));
      expect(withPatient.patientId).toBe(PAT_1);
      const patientLess = await write().createIncident(rn, incidentArgs(undefined));
      expect(patientLess.patientId ?? null).toBeNull();
    });

    it("an empty caseload cannot author a patient-linked row (fails closed)", async () => {
      await expect(
        write().createIncident(writeActor(NO_CASELOAD, ["rn_case_manager"]), incidentArgs(PAT_1)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("an org-wide role and a typed system actor may name any patient in the org", async () => {
      const md = writeActor(MEDICAL_DIRECTOR, ["medical_director"]);
      const event = await write().recordInfectionEvent(md, infectionArgs(PAT_2));
      expect(event.patientId).toBe(PAT_2);
      const system = m30SystemWriteActor({
        organizationId: ORG_A,
        userId: REPORTER,
        membershipId: REPORTER,
      });
      const created = await write().createIncident(system, incidentArgs(PAT_2));
      expect(created.patientId).toBe(PAT_2);
    });

    it("a caseload-bound role (registered_nurse) is 404 for an out-of-caseload patient on the write path too (administrator is org-wide per ADR-0090)", async () => {
      await expect(
        write().createIncident(writeActor(NO_CASELOAD, ["registered_nurse"]), incidentArgs(PAT_2)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("mortality update/complete on an out-of-caseload review is 404 unless the actor is its assigned reviewer", async () => {
      const out = await seedMortality(PAT_2, new Date(BASE + 500 * MINUTE));
      const rn = writeActor(CLINICIAN, ["rn_case_manager"]);
      await expect(
        write().updateMortalityReview(rn, out, { dimensions: { clinical: { note: "x" } } }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await admin.query(
        "UPDATE mortality_review SET assigned_reviewer_membership_id = $2 WHERE id = $1",
        [out, REPORTER],
      );
      const updated = await write().updateMortalityReview(rn, out, {
        dimensions: { clinical: { note: "x" } },
      });
      expect(updated.reviewId).toBe(out);
    });

    it("incident lifecycle writes are caseload-scoped; the reporter / assigned investigator keep access", async () => {
      const out = await seedIncident({
        org: ORG_A,
        pe: PE_A,
        patient: PAT_2,
        at: new Date(BASE + 600 * MINUTE),
      });
      const rn = writeActor(CLINICIAN, ["rn_case_manager"]);
      // writeActor stamps membershipId REPORTER, which is the seeded reporter => own-record arm allows.
      const own = await write().updateIncident(rn, out, { severity: "severe" } as never);
      expect(own.incidentId).toBe(out);
      await admin.query("UPDATE incident_report SET reported_by_membership_id = $2 WHERE id = $1", [
        out,
        randomUUID(),
      ]);
      await expect(
        write().updateIncident(rn, out, { severity: "minor" } as never),
      ).rejects.toBeInstanceOf(NotFoundError);
      // The M30 read arm never opens a WRITE: a QAPI coordinator is still caseload-scoped for writes.
      await expect(
        write().updateIncident(writeActor(CLINICIAN, ["qapi_coordinator"]), out, {
          severity: "minor",
        } as never),
      ).rejects.toBeInstanceOf(NotFoundError);
      // An assigned investigator (sidecar assignee) is not locked out.
      await admin.query(
        `UPDATE incident_report SET kind_data = jsonb_set(kind_data, '{_m30}', jsonb_build_object('assignedToMembershipId', $2::text)) WHERE id = $1`,
        [out, REPORTER],
      );
      await expect(
        write().updateIncident(rn, out, { severity: "minor" } as never),
      ).resolves.toBeDefined();
    });
  });

  describe("M30 org-wide READ arm (spec §6.5 / §6.6 check cells)", () => {
    it("qapi_coordinator reads every incident; infection_control_lead reads incidents + infection events org-wide", async () => {
      const all = await allIncidentIds(actorOf(MEDICAL_DIRECTOR, ["medical_director"]));
      const qc = actorOf(NO_CASELOAD, ["qapi_coordinator"]);
      const icl = actorOf(NO_CASELOAD, ["infection_control_lead"]);
      // The list is capped per page (100), so walk every page with the incident-surface scope.
      expect((await allIncidentIds(qc, {}, 100, "incident")).length).toBe(all.length);
      expect((await allIncidentIds(icl, {}, 100, "incident")).length).toBe(all.length);
      const infection = await read.listInfectionEvents(
        icl,
        {},
        undefined,
        500,
        await scopeFor(icl, "infection"),
      );
      expect(infection.items.length).toBeGreaterThan(0);
    });

    it("infection_control_lead has NO mortality arm (mortality.read is not granted); qapi_coordinator does", async () => {
      const icl = actorOf(NO_CASELOAD, ["infection_control_lead"]);
      const qc = actorOf(NO_CASELOAD, ["qapi_coordinator"]);
      expect(await scopeFor(icl, "mortality")).toEqual({ kind: "caseload", patientIds: [] });
      expect(await scopeFor(qc, "mortality")).toEqual({ kind: "org" });
    });
  });
});
