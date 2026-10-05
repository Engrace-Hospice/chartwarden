/**
 * GAP-085 — the M29 clinician lab observation LIST, LIVE Postgres.
 *
 * `GET /api/clinical/labs/observations` used to read every result in the org: RLS on `lab_observation` is
 * org-only and the route passed no caseload. Scope is now server-derived (`resolveLabListScope`): org-wide
 * roles read the org, everyone else reads only their M5 caseload, and an empty caseload yields an EMPTY
 * list (fail closed), never "no restriction".
 *
 * Everything runs as the NOBYPASSRLS `wardenx_app` role over the production Drizzle store
 * (`createDrizzleM29Store().listObservations`) and the REAL M5 `CaseloadProvider`
 * (`createCaseloadProvider(createDrizzleCaseloadStore(db))`) reading seeded `patient_assignment` rows —
 * not an in-memory fake. `listObservations` emits no outbox event (it is a read), so there is no publisher
 * to bind; the write-path publisher is exercised by gap-044-m29-unmatched-lab-review.live.test.ts.
 *
 * Why this harness can fail (not vacuous): the first test proves the connection is RLS-enforced (an
 * un-scoped read through the app handle sees ZERO rows while the superuser sees all of them), and the
 * scoped-list assertions are exactly the ones the pre-GAP-085 code violated — the old route called
 * `listObservations(org, {})` with no caseload, which returns every seeded patient's rows and so fails the
 * "caseload-scoped clinician sees only their patients" and "empty caseload is empty" expectations.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m29:lab-list-scope:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createCaseloadProvider,
  createDrizzleCaseloadStore,
} from "../src/modules/05-patient/index";
import { createDrizzleM29Store } from "../src/modules/29-external-interfaces/index";
import {
  type CaseloadLookup,
  decodeObservationCursor,
  resolveLabListScope,
} from "../src/modules/29-external-interfaces/routes/lab-list-scope";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { seedM5Patient } from "./_m6-admit";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111185";
const ORG_B = "11111111-1111-1111-1111-111111111186";
const PE_A = "00000000-0000-0000-0000-000000000a85";
const PE_B = "00000000-0000-0000-0000-000000000b85";
const CLINICIAN = "00000000-0000-0000-0000-0000000c1185"; // assigned to PAT_1 + PAT_2
const NO_CASELOAD = "00000000-0000-0000-0000-0000000c2285"; // no open assignment at all
const ENDED_ONLY = "00000000-0000-0000-0000-0000000c3385"; // only an UNASSIGNED row for PAT_3
const PAT_1 = "00000000-0000-0000-0000-0000000e1185";
const PAT_2 = "00000000-0000-0000-0000-0000000e2285";
const PAT_3 = "00000000-0000-0000-0000-0000000e3385";
const PAT_B = "00000000-0000-0000-0000-0000000eb185"; // other tenant's patient

/** Fixed, distinct observation ids so the tiebreak ordering is deterministic. */
const OBS = (n: number) => `00000000-0000-0000-0000-0000ab85${String(n).padStart(4, "0")}`;
const DAY = (n: number) => new Date(Date.UTC(2026, 7, n, 12, 0, 0));

interface SeedObs {
  readonly n: number;
  readonly org: string;
  readonly pe: string;
  readonly patient: string;
  readonly date: Date;
  readonly flag: string;
}

describe.skipIf(!DB_URL)("GAP-085 M29 lab list scope — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let store: ReturnType<typeof createDrizzleM29Store>;
  let caseload: CaseloadLookup;

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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

  async function seedObservation(o: SeedObs): Promise<void> {
    await admin.query(
      `INSERT INTO lab_observation
         (id, organization_id, provider_entity_id, patient_id, source_message_id, observation_date,
          result_status, loinc_code, loinc_display_text, terminology_validation, abnormal_summary)
       VALUES ($1,$2,$3,$4,gen_random_uuid(),$5,'final','718-7','Hemoglobin','valid','no_flags')`,
      [OBS(o.n), o.org, o.pe, o.patient, o.date],
    );
    await admin.query(
      `INSERT INTO lab_observation_value
         (organization_id, observation_id, obx_set_id, loinc_code, loinc_display_text,
          terminology_validation, value_type, numeric_value, units, abnormal_flag)
       VALUES ($1,$2,1,'718-7','Hemoglobin','valid','NM',9.1,'g/dL',$3)`,
      [o.org, OBS(o.n), o.flag],
    );
  }

  const idsOf = (page: { items: readonly { id: string }[] }) => page.items.map((i) => i.id);

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
    for (const u of [CLINICIAN, NO_CASELOAD, ENDED_ONLY]) {
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [u, `${u}@gap085.test`]);
    }
    for (const p of [PAT_1, PAT_2, PAT_3]) await seedM5Patient(admin, ORG_A, p);
    await seedM5Patient(admin, ORG_B, PAT_B);

    // M5 caseload: CLINICIAN has two OPEN assignments; ENDED_ONLY's only row is unassigned (closed).
    for (const [user, patient, unassigned] of [
      [CLINICIAN, PAT_1, null],
      [CLINICIAN, PAT_2, null],
      [ENDED_ONLY, PAT_3, "2026-07-01"],
    ] as const) {
      await admin.query(
        `INSERT INTO patient_assignment
           (patient_id, organization_id, clinician_user_id, role, assigned_at, unassigned_at)
         VALUES ($1,$2,$3,'primary_rn','2026-06-01',$4)`,
        [patient, ORG_A, user, unassigned],
      );
    }

    // Org A: PAT_1 x3 (one HH), PAT_2 x2 (one tie-date pair), PAT_3 x1 (HH). Org B: PAT_B x1 (HH).
    const rows: SeedObs[] = [
      { n: 1, org: ORG_A, pe: PE_A, patient: PAT_1, date: DAY(1), flag: "N" },
      { n: 2, org: ORG_A, pe: PE_A, patient: PAT_1, date: DAY(2), flag: "HH" },
      { n: 3, org: ORG_A, pe: PE_A, patient: PAT_1, date: DAY(3), flag: "N" },
      // n=4 and n=5 share an observation_date: paging must break the tie on id, not skip or repeat.
      { n: 4, org: ORG_A, pe: PE_A, patient: PAT_2, date: DAY(4), flag: "N" },
      { n: 5, org: ORG_A, pe: PE_A, patient: PAT_2, date: DAY(4), flag: "N" },
      { n: 6, org: ORG_A, pe: PE_A, patient: PAT_3, date: DAY(5), flag: "HH" },
      { n: 7, org: ORG_B, pe: PE_B, patient: PAT_B, date: DAY(6), flag: "HH" },
    ];
    for (const r of rows) await seedObservation(r);
    // A foreign-org value row that REFERENCES org A's n=1 observation and is flagged HH. The EXISTS
    // filter must not match it (org predicate + RLS), or n=1 would leak into the HH result.
    await admin.query(
      `INSERT INTO lab_observation_value
         (organization_id, observation_id, obx_set_id, loinc_code, loinc_display_text,
          terminology_validation, value_type, numeric_value, units, abnormal_flag)
       VALUES ($1,$2,9,'718-7','Hemoglobin','valid','NM',1,'g/dL','HH')`,
      [ORG_B, OBS(1)],
    );

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    store = createDrizzleM29Store(handle.db);
    caseload = createCaseloadProvider(createDrizzleCaseloadStore(handle.db));
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  const clinician = (userId: string, roles: readonly string[] = ["rn_case_manager"]) => ({
    organizationId: ORG_A,
    userId,
    roles,
  });

  async function listAs(
    actor: ReturnType<typeof clinician>,
    extra: Parameters<typeof store.listObservations>[1] = {},
  ) {
    const scope = await resolveLabListScope(actor, caseload);
    return store.listObservations(actor.organizationId, { ...scope, ...extra });
  }

  it("harness bites: the app handle is RLS-enforced (no org context ⇒ zero rows; superuser sees all)", async () => {
    const asApp = await handle.pool.query("SELECT count(*)::int AS n FROM lab_observation");
    const asSuper = await admin.query("SELECT count(*)::int AS n FROM lab_observation");
    expect(asSuper.rows[0].n).toBe(7);
    expect(asApp.rows[0].n).toBe(0);
  });

  it("org-wide role (medical_director) reads every org-A observation and none of org B's", async () => {
    const page = await listAs(clinician(NO_CASELOAD, ["medical_director"]));
    expect(idsOf(page).sort()).toEqual([OBS(1), OBS(2), OBS(3), OBS(4), OBS(5), OBS(6)].sort());
    expect(idsOf(page)).not.toContain(OBS(7));
  });

  it("cross-tenant: org B's store read never returns org A's rows, and the reverse", async () => {
    const asB = await store.listObservations(ORG_B, {});
    expect(idsOf(asB)).toEqual([OBS(7)]);
    expect(idsOf(asB)).not.toContain(OBS(1));
    // Even a caseload list naming org A's patient ids returns nothing under org B's context.
    const forged = await store.listObservations(ORG_B, { caseloadPatientIds: [PAT_1, PAT_2] });
    expect(forged.items).toEqual([]);
    // And org A asking for org B's patient by id gets nothing.
    const reverse = await store.listObservations(ORG_A, { patientId: PAT_B });
    expect(reverse.items).toEqual([]);
  });

  it("caseload-scoped clinician sees ONLY their assigned patients' observations", async () => {
    const page = await listAs(clinician(CLINICIAN));
    expect(idsOf(page).sort()).toEqual([OBS(1), OBS(2), OBS(3), OBS(4), OBS(5)].sort());
    expect(idsOf(page)).not.toContain(OBS(6)); // PAT_3: not on their caseload
  });

  it("a patientId filter cannot widen a caseload-scoped clinician beyond their caseload", async () => {
    const page = await listAs(clinician(CLINICIAN), { patientId: PAT_3 });
    expect(page.items).toEqual([]);
  });

  it("empty caseload (no assignment at all) fails closed to an empty list, not an org-wide one", async () => {
    const scope = await resolveLabListScope(clinician(NO_CASELOAD), caseload);
    expect(scope.caseloadPatientIds).toEqual([]);
    expect((await listAs(clinician(NO_CASELOAD))).items).toEqual([]);
  });

  it("an ended (unassigned_at set) assignment does not put the patient on the caseload", async () => {
    expect((await listAs(clinician(ENDED_ONLY))).items).toEqual([]);
  });

  it("a caseload lookup failure fails closed to an empty list", async () => {
    const broken: CaseloadLookup = {
      async caseloadPatientIds() {
        throw new Error("seam down");
      },
    };
    const scope = await resolveLabListScope(clinician(CLINICIAN), broken);
    expect(scope.caseloadPatientIds).toEqual([]);
    const page = await store.listObservations(ORG_A, scope);
    expect(page.items).toEqual([]);
  });

  it("abnormalFlag filters through the value-row EXISTS, per org and per caseload", async () => {
    const orgWide = await listAs(clinician(NO_CASELOAD, ["medical_director"]), {
      abnormalFlag: "HH",
    });
    // n=2 and n=6 carry HH in org A. n=1 must NOT match via org B's foreign HH value row; n=7 is org B's.
    expect(idsOf(orgWide).sort()).toEqual([OBS(2), OBS(6)].sort());

    const scoped = await listAs(clinician(CLINICIAN), { abnormalFlag: "HH" });
    expect(idsOf(scoped)).toEqual([OBS(2)]);

    const none = await listAs(clinician(CLINICIAN), { abnormalFlag: "LL" });
    expect(none.items).toEqual([]);
  });

  it("keyset cursor paging walks the scoped set newest-first with no gap, repeat, or tie skip", async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await listAs(clinician(CLINICIAN), { limit: 2, cursor });
      expect(page.items.length).toBeLessThanOrEqual(2);
      seen.push(...idsOf(page));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(pages).toBe(3); // 5 rows at 2/page: 2 + 2 + 1
    expect(cursor).toBeUndefined();
    expect(new Set(seen).size).toBe(seen.length); // no repeat
    // Newest first; the DAY(4) tie (n=4, n=5) orders by id DESC, so n=5 precedes n=4.
    expect(seen).toEqual([OBS(5), OBS(4), OBS(3), OBS(2), OBS(1)]);
  });

  it("the cursor emitted on a page splits exactly at the row it names (tie boundary)", async () => {
    // limit 1 forces the cursor to land BETWEEN the two same-date rows.
    const first = await listAs(clinician(CLINICIAN), { limit: 1 });
    expect(idsOf(first)).toEqual([OBS(5)]);
    const decoded = decodeObservationCursor(first.nextCursor);
    expect(decoded?.id).toBe(OBS(5));
    const second = await listAs(clinician(CLINICIAN), { limit: 1, cursor: first.nextCursor });
    expect(idsOf(second)).toEqual([OBS(4)]);
  });

  it("a cursor minted for one scope cannot be replayed to widen another actor's result", async () => {
    // A medical director's cursor (mid-list) handed to the no-caseload clinician is still scoped.
    const dir = await listAs(clinician(NO_CASELOAD, ["medical_director"]), { limit: 1 });
    const replay = await listAs(clinician(NO_CASELOAD), { cursor: dir.nextCursor });
    expect(replay.items).toEqual([]);
  });
});
