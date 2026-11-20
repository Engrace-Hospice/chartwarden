import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import type { CarePlanElementsAudience } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
/**
 * VN-D11 - `CarePlanReader.relevantElementsAsOf` (the version in effect at an instant) proven against real Postgres
 * as the NOBYPASSRLS `chartwarden_app` role: the SQL predicate behind the in-memory slice the unit suite uses
 * (signed at or before the instant, superseded after it), draft and in-review versions never in effect, a
 * `superseded` row with no instant failing closed, admission scoping, a discharged plan still answering a late
 * entry, cross-tenant isolation, Part 2 redaction per viewer, and a mangled snapshot answering null.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m7:as-of:live
 * (no pgvector locally: CHARTWARDEN_TEST_NO_PGVECTOR=1)
 */
import { createDrizzleCarePlanReaderStore } from "../src/modules/07-care-plan/seams/drizzle-store";
import { createCarePlanReader } from "../src/modules/07-care-plan/seams/reader";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const USER = "55555555-5555-5555-5555-555555555555";

const SIGNED_V1 = "2026-03-01T09:00:00.000Z";
const SIGNED_V2 = "2026-03-10T09:00:00.000Z";
const SIGNED_V3 = "2026-03-20T09:00:00.000Z"; // the re-admission's plan

const snap = (problems: unknown[], goals: unknown[] = [], interventions: unknown[] = []) => ({
  schemaVersion: "test",
  problems,
  goals,
  interventions,
});
const problem = (id: string, description: string, sudRelated: unknown = false) => ({
  id,
  icd10Code: null,
  snomedCode: null,
  description,
  kind: "terminal",
  source: "clinical",
  sudRelated,
  status: "active",
});
const intervention = (id: string, problemId: string) => ({
  id,
  problemId,
  scopeText: `scope ${id}`,
  frequencyText: "3x/week",
  discipline: "rn",
  status: "active",
});

const P_PAIN = randomUUID();
const P_DYSPNEA = randomUUID();
const P_SUD = randomUUID();
const P_READMIT = randomUUID();
const SNAP_V1 = snap([problem(P_PAIN, "Chronic pain")], [], [intervention(randomUUID(), P_PAIN)]);
const SNAP_V2 = snap(
  [problem(P_DYSPNEA, "Dyspnea"), problem(P_SUD, "SECRET-SUD-PROBLEM-TEXT", true)],
  [],
  [intervention(randomUUID(), P_DYSPNEA), intervention(randomUUID(), P_SUD)],
);
const SNAP_V3 = snap([problem(P_READMIT, "Readmission problem")]);

describe.skipIf(!DB_URL)(
  "M7 CarePlanReader.relevantElementsAsOf - LIVE Postgres as chartwarden_app",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let reader: ReturnType<typeof createCarePlanReader>;
    const adm = {
      first: randomUUID(),
      readmit: randomUUID(),
      orphan: randomUUID(),
      mangled: randomUUID(),
    };

    async function resetSchema() {
      await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
      await admin.query("CREATE SCHEMA public");
      for (const r of LIVE_DROP_ROLES) {
        await admin.query(
          `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
            `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
        );
      }
    }

    async function applyMigrations() {
      const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
      for (const f of readdirSync(MIGRATIONS_DIR)
        .filter((x) => x.endsWith(".sql"))
        .sort()) {
        let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
        if (stripVector) {
          sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
          sql = sql.replace(/\bvector\(\d+\)/g, "text");
          sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
        }
        await admin.query(sql);
      }
    }

    async function seedPlan(org: string, admission: string, status: string): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO care_plan (organization_id, patient_id, admission_id, initial_due_at, status)
       VALUES ($1,$2,$3, now() + interval '5 days', $4) RETURNING id`,
        [org, PATIENT, admission, status],
      );
      return rows[0].id as string;
    }

    async function seedVersion(
      org: string,
      planId: string,
      sequence: number,
      v: {
        status: string;
        signedAt: string | null;
        supersededAt: string | null;
        snapshot: unknown;
      },
    ) {
      await admin.query(
        `INSERT INTO care_plan_version (organization_id, care_plan_id, sequence, status, kind,
         state_snapshot, required_signer_set, signed_at, superseded_at)
       VALUES ($1,$2,$3,$4,'initial',$5,'[]'::jsonb,$6,$7)`,
        [org, planId, sequence, v.status, JSON.stringify(v.snapshot), v.signedAt, v.supersededAt],
      );
    }

    /** Ask as `org` (RLS pins the tenant from the request context) for the RN picker as of `asOf`. */
    const ask = (
      asOf: string,
      over: { org?: string; admission?: string; viewer?: CarePlanElementsAudience } = {},
    ) =>
      runWithRequestContext({ organizationId: over.org ?? ORG_A, userId: USER } as never, () =>
        reader.relevantElementsAsOf(
          PATIENT as never,
          "routine_visit",
          "rn",
          over.admission,
          over.viewer ?? { sudDisclosureAllowed: true },
          asOf,
        ),
      );
    const problemIds = (out: Awaited<ReturnType<typeof ask>>) =>
      (out?.problems ?? []).map((p) => p.problemId);

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
        [ORG_A, ORG_B],
      );
      // admission 1: a plan since DISCHARGED, signed twice (v1 superseded by v2), plus a draft and an in-review
      // version that were never signed. admission 2: the re-admission's live plan.
      const plan1 = await seedPlan(ORG_A, adm.first, "discharged");
      await seedVersion(ORG_A, plan1, 1, {
        status: "superseded",
        signedAt: SIGNED_V1,
        supersededAt: SIGNED_V2,
        snapshot: SNAP_V1,
      });
      await seedVersion(ORG_A, plan1, 2, {
        status: "signed",
        signedAt: SIGNED_V2,
        supersededAt: null,
        snapshot: SNAP_V2,
      });
      await seedVersion(ORG_A, plan1, 3, {
        status: "in_review",
        signedAt: null,
        supersededAt: null,
        snapshot: SNAP_V3,
      });
      const plan2 = await seedPlan(ORG_A, adm.readmit, "active");
      await seedVersion(ORG_A, plan2, 1, {
        status: "signed",
        signedAt: SIGNED_V3,
        supersededAt: null,
        snapshot: SNAP_V3,
      });
      // a superseded version that carries no instant: in effect at no instant
      const plan3 = await seedPlan(ORG_A, adm.orphan, "active");
      await seedVersion(ORG_A, plan3, 1, {
        status: "superseded",
        signedAt: SIGNED_V1,
        supersededAt: null,
        snapshot: SNAP_V1,
      });
      // a signed version whose snapshot is not of the expected shape
      const plan4 = await seedPlan(ORG_A, adm.mangled, "active");
      await seedVersion(ORG_A, plan4, 1, {
        status: "signed",
        signedAt: SIGNED_V1,
        supersededAt: null,
        snapshot: { problems: "not-a-list", goals: [], interventions: [] },
      });
      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      reader = createCarePlanReader(createDrizzleCarePlanReaderStore(handle.db));
    }, 180_000);

    afterAll(async () => {
      await handle?.close();
      if (admin) await admin.end();
    });

    it("proves the connection is the NOBYPASSRLS app role", async () => {
      const probe = new Client({ connectionString: appRoleUrl(DB_URL as string) });
      await probe.connect();
      const { rows } = await probe.query(
        "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user",
      );
      await probe.end();
      expect(rows[0]).toMatchObject({
        current_user: "chartwarden_app",
        rolsuper: false,
        rolbypassrls: false,
      });
    });

    it("reads the version in effect: v1 while it was current, v2 from the instant it superseded v1", async () => {
      expect(problemIds(await ask("2026-03-05T00:00:00.000Z", { admission: adm.first }))).toEqual([
        P_PAIN,
      ]);
      expect(problemIds(await ask("2026-03-10T08:59:59.999Z", { admission: adm.first }))).toEqual([
        P_PAIN,
      ]);
      expect(problemIds(await ask(SIGNED_V2, { admission: adm.first })).sort()).toEqual(
        [P_DYSPNEA, P_SUD].sort(),
      );
      expect(
        problemIds(await ask("2027-01-01T00:00:00.000Z", { admission: adm.first })).sort(),
      ).toEqual([P_DYSPNEA, P_SUD].sort());
    });

    it("includes the signing instant and answers null one millisecond before it", async () => {
      expect(problemIds(await ask(SIGNED_V1, { admission: adm.first }))).toEqual([P_PAIN]);
      expect(await ask("2026-03-01T08:59:59.999Z", { admission: adm.first })).toBeNull();
    });

    it("never reads a version that was only in review, however late the instant", async () => {
      const out = await ask("2030-01-01T00:00:00.000Z", { admission: adm.first });

      expect(problemIds(out)).not.toContain(P_READMIT);
    });

    it("still answers a late entry for a visit before the plan was discharged", async () => {
      // plan 1 is `discharged` today; the visit was while it was live.
      const out = await ask("2026-03-12T00:00:00.000Z", { admission: adm.first });

      expect(out).not.toBeNull();
    });

    it("keeps a re-admission's plan apart through admissionId", async () => {
      expect(problemIds(await ask("2026-03-25T00:00:00.000Z", { admission: adm.readmit }))).toEqual(
        [P_READMIT],
      );
      expect(await ask("2026-03-15T00:00:00.000Z", { admission: adm.readmit })).toBeNull();
    });

    it("fails closed on a superseded version that carries no superseded_at", async () => {
      expect(await ask("2026-03-05T00:00:00.000Z", { admission: adm.orphan })).toBeNull();
    });

    it("answers null for a snapshot that is not of the expected shape", async () => {
      expect(await ask("2026-03-05T00:00:00.000Z", { admission: adm.mangled })).toBeNull();
    });

    it("returns nothing across tenants", async () => {
      expect(
        await ask("2026-03-12T00:00:00.000Z", { org: ORG_B, admission: adm.first }),
      ).toBeNull();
      expect(await ask("2026-03-12T00:00:00.000Z", { org: ORG_B })).toBeNull();
    });

    it("withholds the Part 2 problem and its text from a viewer without disclosure", async () => {
      const out = await ask(SIGNED_V2, {
        admission: adm.first,
        viewer: { sudDisclosureAllowed: false },
      });

      expect(out?.redacted).toBe(true);
      expect(problemIds(out)).toEqual([P_DYSPNEA]);
      expect(JSON.stringify(out)).not.toContain("SECRET-SUD-PROBLEM-TEXT");
    });

    it("shows it, flagged, to a viewer with disclosure", async () => {
      const out = await ask(SIGNED_V2, {
        admission: adm.first,
        viewer: { sudDisclosureAllowed: true },
      });

      expect(out?.redacted).toBe(false);
      expect(out?.problems.find((p) => p.problemId === P_SUD)).toMatchObject({ sudRelated: true });
    });

    it("redacts for a caller with no human actor when no consent evaluator answers (fail closed)", async () => {
      const out = await ask(SIGNED_V2, { admission: adm.first, viewer: "patient_level" });

      expect(out?.redacted).toBe(true);
      expect(JSON.stringify(out)).not.toContain("SECRET-SUD-PROBLEM-TEXT");
    });
  },
);
