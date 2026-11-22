import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import type { DisciplinePlanKind } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
/**
 * ADR-0114 S4 (VN-D11, VN-D46, VN-D49) - `DisciplinePlanReader.planElementsAsOf` (the social-work or spiritual plan in the signed version in
 * effect at an instant) proven against real Postgres as the NOBYPASSRLS `chartwarden_app` role: the SQL predicate behind the in-memory slice the
 * unit suite uses, and above all the ONE way M15 differs from M7: M15 stamps `superseded_at` only at discharge, never when a later version is
 * signed, so several versions are `signed` at once and the LATEST `signed_at` is the one in effect. Also: draft and in-review versions never in
 * effect, a `superseded` row with no instant failing closed, a tie on `signed_at` settled by `sequence`, admission and plan-kind scoping, a
 * discharged plan still answering a late entry, a spiritual-care declination, cross-tenant isolation, Part 2 per viewer through M15's own
 * disclosure rule (the M39 verdict is a fake port with call counters), and a mangled snapshot answering null.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m15:plan-as-of:live
 * (no pgvector locally: CHARTWARDEN_TEST_NO_PGVECTOR=1; never point this at the shared Docker cluster)
 */
import {
  createDisciplinePlanReader,
  createDrizzleDisciplinePlanSeamStore,
} from "../src/modules/15-discipline-care-plans/index";
import type { DisclosurePort } from "../src/modules/15-discipline-care-plans/routes/disclosure";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const USER = "55555555-5555-5555-5555-555555555555";

const SIGNED_V1 = "2026-03-01T09:00:00.000Z";
const SIGNED_V2 = "2026-03-10T09:00:00.000Z";
const DISCHARGED = "2026-04-01T09:00:00.000Z";

const goal = (id: string, text: string, over: Record<string, unknown> = {}) => ({
  goalId: id,
  parentProblemId: null,
  parentGoalId: null,
  source: "clinical",
  status: "in_progress",
  originalText: text,
  revisedText: null,
  measurableOutcome: "an outcome nobody may state",
  targetAt: null,
  frequencyText: null,
  frequencyValue: null,
  modalityText: null,
  sudRelated: false,
  addedByDiscipline: "msw",
  addedAt: SIGNED_V1,
  version: 1,
  ...over,
});
const intervention = (id: string, scopeText: string, over: Record<string, unknown> = {}) => ({
  interventionId: id,
  parentInterventionId: null,
  goalRefs: [] as string[],
  scopeText,
  frequencyText: "weekly",
  frequencyValue: 1,
  discipline: "msw",
  responsibleRoles: ["msw"],
  status: "active",
  discontinuationReason: null,
  addedByDiscipline: "msw",
  addedAt: SIGNED_V1,
  version: 1,
  ...over,
});
const snap = (goals: unknown[], interventions: unknown[] = []) => ({
  sealedAt: SIGNED_V1,
  planKind: "msw_plan",
  versionKind: "initial",
  volunteerOutOfScopeAcknowledged: false,
  goals,
  interventions,
});

const G_V1 = randomUUID();
const G_V2 = randomUUID();
const G_SUD = randomUUID();
const G_FINAL = randomUUID();
const G_SPIRIT = randomUUID();
const G_READMIT = randomUUID();
const IV_SUD = randomUUID();
const SNAP_V1 = snap(
  [goal(G_V1, "Name two ways to cope")],
  [intervention(randomUUID(), "Counselling")],
);
const SNAP_V2 = snap(
  [goal(G_V2, "Plan the memorial"), goal(G_SUD, "SECRET-SUD-GOAL-TEXT", { sudRelated: true })],
  [
    intervention(randomUUID(), "Legacy work"),
    intervention(IV_SUD, "SECRET-SUD-INTERVENTION", { goalRefs: [G_SUD.toUpperCase()] }),
  ],
);
const SNAP_FINAL = snap([goal(G_FINAL, "Final state at discharge")]);

type Verdict = { allowed: boolean; restrictedToNamedWorkforce: boolean };

describe.skipIf(!DB_URL)(
  "M15 DisciplinePlanReader.planElementsAsOf - LIVE Postgres as chartwarden_app",
  () => {
    let admin: Client;
    let handle: ReturnType<typeof createDbClient>;
    let verdict: Verdict = { allowed: false, restrictedToNamedWorkforce: false };
    let verdictFails = false;
    let verdictAsks = 0;
    let reader: ReturnType<typeof createDisciplinePlanReader>;
    const adm = {
      chain: randomUUID(), // two signed versions, never superseded by M15's own signing
      discharged: randomUUID(), // a chain a discharge superseded, with its discharge version
      dischargeOnly: randomUUID(), // a plan with nothing but the system-built discharge version
      orphan: randomUUID(),
      mangled: randomUUID(),
      readmit: randomUUID(),
      tie: randomUUID(),
      spiritual: randomUUID(),
      declined: randomUUID(),
    };
    const ids = {} as Record<"peA" | "locA" | "peB" | "locB", string>;

    const port: DisclosurePort = {
      part2ReleaseActive: async () => {
        verdictAsks += 1;
        if (verdictFails) throw new Error("M39 down");
        return verdict;
      },
      familyViolenceRedacted: async () => true,
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

    async function seedOrg(orgId: string, slug: string, n: number): Promise<[string, string]> {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [orgId, `plan-as-of-${slug}`],
      );
      const pe = await admin.query<{ id: string }>(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
        [orgId, `PA-${slug}`, `PE ${slug}`, String(1_700_000_000 + n)],
      );
      const peId = pe.rows[0]?.id as string;
      const loc = await admin.query<{ id: string }>(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Site one','1 Main St','Town','NY','10001','America/New_York') RETURNING id`,
        [peId],
      );
      return [peId, loc.rows[0]?.id as string];
    }

    async function seedPlan(
      admission: string,
      kind: DisciplinePlanKind,
      over: { declinedAt?: string | null; status?: string } = {},
    ): Promise<string> {
      const { rows } = await admin.query(
        `INSERT INTO discipline_care_plan (organization_id, patient_id, admission_id, provider_entity_id, location_id, kind, status,
           spiritual_care_declined, spiritual_care_declined_at)
         VALUES ($1,$2,$3,$4,$5,$6::discipline_plan_kind,$7::discipline_plan_status,$8,$9) RETURNING id`,
        [
          ORG_A,
          PATIENT,
          admission,
          ids.peA,
          ids.locA,
          kind,
          over.status ?? "active",
          over.declinedAt ? "declined" : null,
          over.declinedAt ?? null,
        ],
      );
      return rows[0].id as string;
    }

    async function seedVersion(
      planId: string,
      sequence: number,
      v: {
        status: string;
        signedAt: string | null;
        supersededAt?: string | null;
        snapshot: unknown;
        kind?: string;
      },
    ) {
      await admin.query(
        `INSERT INTO discipline_care_plan_version (organization_id, provider_entity_id, location_id, plan_id, sequence, status, kind,
           state_snapshot, required_signer_set, signed_at, superseded_at)
         VALUES ($1,$2,$3,$4,$5,$6::discipline_plan_version_status,$7::discipline_plan_version_kind,$8,'[]'::jsonb,$9,$10)`,
        [
          ORG_A,
          ids.peA,
          ids.locA,
          planId,
          sequence,
          v.status,
          v.kind ?? "initial",
          JSON.stringify(v.snapshot),
          v.signedAt,
          v.supersededAt ?? null,
        ],
      );
    }

    /** Ask as `org` (RLS pins the tenant from the request context) for the plan of `kind` as of `asOf`. */
    const ask = (
      asOf: string,
      admission: string,
      over: { org?: string; kind?: DisciplinePlanKind; roles?: string[] } = {},
    ) =>
      runWithRequestContext({ organizationId: over.org ?? ORG_A, userId: USER } as never, () =>
        reader.planElementsAsOf(
          over.org ?? ORG_A,
          PATIENT as never,
          admission as never,
          over.kind ?? "msw_plan",
          { roles: over.roles ?? ["msw"], membershipId: "membership-1" },
          asOf as never,
        ),
      );
    const goalIds = (out: Awaited<ReturnType<typeof ask>>) =>
      (out?.goals ?? []).map((g) => g.goalId);

    beforeAll(async () => {
      admin = new Client({ connectionString: DB_URL });
      await admin.connect();
      await resetSchema();
      await applyMigrations();
      [ids.peA, ids.locA] = await seedOrg(ORG_A, "a", 1);
      [ids.peB, ids.locB] = await seedOrg(ORG_B, "b", 2);

      // M15 signs a later version WITHOUT superseding the earlier one: both stay `signed` with no `superseded_at`.
      const chain = await seedPlan(adm.chain, "msw_plan");
      await seedVersion(chain, 1, { status: "signed", signedAt: SIGNED_V1, snapshot: SNAP_V1 });
      await seedVersion(chain, 2, { status: "signed", signedAt: SIGNED_V2, snapshot: SNAP_V2 });
      await seedVersion(chain, 3, { status: "in_review", signedAt: null, snapshot: SNAP_FINAL });

      // A discharge supersedes every signed version at the discharge instant and adds a system-signed `discharge` version.
      const discharged = await seedPlan(adm.discharged, "msw_plan", { status: "discharged" });
      await seedVersion(discharged, 1, {
        status: "superseded",
        signedAt: SIGNED_V1,
        supersededAt: DISCHARGED,
        snapshot: SNAP_V1,
      });
      await seedVersion(discharged, 2, {
        status: "superseded",
        signedAt: SIGNED_V2,
        supersededAt: DISCHARGED,
        snapshot: SNAP_V2,
      });
      await seedVersion(discharged, 3, {
        status: "signed",
        signedAt: DISCHARGED,
        snapshot: SNAP_FINAL,
        kind: "discharge",
      });

      // A plan whose only version is the system-built discharge version: nothing the clinicians signed.
      const dischargeOnly = await seedPlan(adm.dischargeOnly, "msw_plan", { status: "discharged" });
      await seedVersion(dischargeOnly, 1, {
        status: "signed",
        signedAt: DISCHARGED,
        snapshot: SNAP_FINAL,
        kind: "discharge",
      });

      // A superseded version that carries no instant: in effect at no instant.
      const orphan = await seedPlan(adm.orphan, "msw_plan");
      await seedVersion(orphan, 1, {
        status: "superseded",
        signedAt: SIGNED_V1,
        snapshot: SNAP_V1,
      });

      // A signed version whose snapshot is not of the expected shape.
      const mangled = await seedPlan(adm.mangled, "msw_plan");
      await seedVersion(mangled, 1, {
        status: "signed",
        signedAt: SIGNED_V1,
        snapshot: { goals: "not-a-list", interventions: [] },
      });

      // The re-admission's own plan, signed later.
      const readmit = await seedPlan(adm.readmit, "msw_plan");
      await seedVersion(readmit, 1, {
        status: "signed",
        signedAt: "2026-03-20T09:00:00.000Z",
        snapshot: snap([goal(G_READMIT, "Readmission goal")]),
      });

      // Two signed versions with the same `signed_at`: the higher sequence is in effect.
      const tie = await seedPlan(adm.tie, "msw_plan");
      await seedVersion(tie, 1, { status: "signed", signedAt: SIGNED_V1, snapshot: SNAP_V1 });
      await seedVersion(tie, 2, { status: "signed", signedAt: SIGNED_V1, snapshot: SNAP_V2 });

      // The same admission's spiritual plan, kept apart from its social-work plan, and one the patient declined.
      const spiritual = await seedPlan(adm.spiritual, "spiritual_plan");
      await seedVersion(spiritual, 1, {
        status: "signed",
        signedAt: SIGNED_V1,
        snapshot: snap([goal(G_SPIRIT, "Spiritual goal", { addedByDiscipline: "chaplain" })]),
      });
      const mswOfSpiritual = await seedPlan(adm.spiritual, "msw_plan");
      await seedVersion(mswOfSpiritual, 1, {
        status: "signed",
        signedAt: SIGNED_V1,
        snapshot: SNAP_V1,
      });
      const declined = await seedPlan(adm.declined, "spiritual_plan", {
        declinedAt: "2026-03-05T00:00:00.000Z",
      });
      await seedVersion(declined, 1, {
        status: "signed",
        signedAt: SIGNED_V1,
        snapshot: snap([goal(G_SPIRIT, "Spiritual goal")]),
      });

      await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
      handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
      reader = createDisciplinePlanReader(createDrizzleDisciplinePlanSeamStore(handle.db), port);
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

    it("reads the latest signed version at or before the instant when M15 never superseded the earlier one", async () => {
      expect(goalIds(await ask("2026-03-05T00:00:00.000Z", adm.chain))).toEqual([G_V1]);
      expect(goalIds(await ask("2026-03-10T08:59:59.999Z", adm.chain))).toEqual([G_V1]);
      expect(goalIds(await ask(SIGNED_V2, adm.chain))).toEqual([G_V2]);
      expect(goalIds(await ask("2027-01-01T00:00:00.000Z", adm.chain))).toEqual([G_V2]);
    });

    it("includes the signing instant and answers null one millisecond before it", async () => {
      expect(goalIds(await ask(SIGNED_V1, adm.chain))).toEqual([G_V1]);
      expect(await ask("2026-03-01T08:59:59.999Z", adm.chain)).toBeNull();
    });

    it("never reads a version that was only in review, however late the instant", async () => {
      expect(goalIds(await ask("2030-01-01T00:00:00.000Z", adm.chain))).not.toContain(G_FINAL);
    });

    it("settles two signed versions with the same signed_at by sequence", async () => {
      expect(goalIds(await ask("2026-03-05T00:00:00.000Z", adm.tie))).toEqual([G_V2]);
    });

    // The discharge consumer builds the `discharge` version from every CURRENT goal and intervention row (here G_FINAL, an edit nobody signed) and
    // stamps it signed itself: a visit on or after the discharge must read the last version the clinicians signed, never that one.
    it("reads the versions a discharge superseded, and after the discharge still the last signed one, never the system-built discharge version", async () => {
      expect(goalIds(await ask("2026-03-05T00:00:00.000Z", adm.discharged))).toEqual([G_V1]);
      expect(goalIds(await ask("2026-03-20T00:00:00.000Z", adm.discharged))).toEqual([G_V2]);
      expect(goalIds(await ask("2026-03-31T23:59:59.999Z", adm.discharged))).toEqual([G_V2]);
      expect(goalIds(await ask(DISCHARGED, adm.discharged))).toEqual([G_V2]);
      expect(goalIds(await ask("2026-04-02T00:00:00.000Z", adm.discharged))).toEqual([G_V2]);
      expect(JSON.stringify(await ask("2030-01-01T00:00:00.000Z", adm.discharged))).not.toContain(
        G_FINAL,
      );
    });

    it("answers null for a plan whose only version is the discharge version", async () => {
      expect(await ask("2026-04-02T00:00:00.000Z", adm.dischargeOnly)).toBeNull();
    });

    it("still answers a late entry for a visit before the plan was discharged", async () => {
      // the plan is `discharged` today; the visit was while it was live.
      expect(await ask("2026-03-12T00:00:00.000Z", adm.discharged)).not.toBeNull();
    });

    it("fails closed on a superseded version that carries no superseded_at", async () => {
      expect(await ask("2026-03-05T00:00:00.000Z", adm.orphan)).toBeNull();
    });

    it("answers null for a snapshot that is not of the expected shape", async () => {
      expect(await ask("2026-03-05T00:00:00.000Z", adm.mangled)).toBeNull();
    });

    it("keeps a re-admission's plan apart through the admission id", async () => {
      expect(goalIds(await ask("2026-03-25T00:00:00.000Z", adm.readmit))).toEqual([G_READMIT]);
      expect(await ask("2026-03-15T00:00:00.000Z", adm.readmit)).toBeNull();
      expect(await ask("2026-03-25T00:00:00.000Z", randomUUID())).toBeNull();
    });

    it("keeps the social-work plan and the spiritual plan of one admission apart", async () => {
      expect(goalIds(await ask("2026-03-05T00:00:00.000Z", adm.spiritual))).toEqual([G_V1]);
      expect(
        goalIds(await ask("2026-03-05T00:00:00.000Z", adm.spiritual, { kind: "spiritual_plan" })),
      ).toEqual([G_SPIRIT]);
    });

    it("answers null for a spiritual plan the patient had declined, and reads it for a visit before the declination", async () => {
      expect(
        await ask("2026-03-06T00:00:00.000Z", adm.declined, { kind: "spiritual_plan" }),
      ).toBeNull();
      expect(
        goalIds(await ask("2026-03-02T00:00:00.000Z", adm.declined, { kind: "spiritual_plan" })),
      ).toEqual([G_SPIRIT]);
    });

    it("returns nothing across tenants", async () => {
      expect(await ask(SIGNED_V2, adm.chain, { org: ORG_B })).toBeNull();
    });

    it("reads nothing when the tenant it is asked for is not the session's, in either direction", async () => {
      const asked = (sessionOrg: string, askedOrg: string) =>
        runWithRequestContext({ organizationId: sessionOrg, userId: USER } as never, () =>
          reader.planElementsAsOf(
            askedOrg,
            PATIENT as never,
            adm.chain as never,
            "msw_plan",
            { roles: ["msw"], membershipId: "membership-1" },
            SIGNED_V2 as never,
          ),
        );

      expect(await asked(ORG_A, ORG_B)).toBeNull();
      expect(await asked(ORG_B, ORG_A)).toBeNull();
      expect(await asked(ORG_A, ORG_A)).not.toBeNull();
    });

    it("rejects an asOf that is not an instant", async () => {
      await expect(ask("not-a-date", adm.chain)).rejects.toThrow(/asOf/);
    });

    it("withholds the Part 2 goal, its intervention and their text from a viewer without disclosure", async () => {
      verdict = { allowed: false, restrictedToNamedWorkforce: false };
      const out = await ask(SIGNED_V2, adm.chain);
      const text = JSON.stringify(out);

      expect(out?.redacted).toBe(true);
      expect(goalIds(out)).toEqual([G_V2]);
      expect(text).not.toContain("SECRET-SUD-GOAL-TEXT");
      expect(text).not.toContain("SECRET-SUD-INTERVENTION");
      expect(text).not.toContain(G_SUD);
      expect(text).not.toContain(IV_SUD);
    });

    it("shows them, flagged, to a viewer M39 clears", async () => {
      verdict = { allowed: true, restrictedToNamedWorkforce: false };
      const out = await ask(SIGNED_V2, adm.chain);

      expect(out?.redacted).toBe(false);
      expect(out?.goals.find((g) => g.goalId === G_SUD)).toMatchObject({ sudRelated: true });
      expect(out?.interventions.find((i) => i.interventionId === IV_SUD)).toMatchObject({
        sudRelated: true,
      });
    });

    it("lets an RN case manager through where no release names others, and not where one does", async () => {
      verdict = { allowed: false, restrictedToNamedWorkforce: false };
      const open = await ask(SIGNED_V2, adm.chain, { roles: ["rn_case_manager"] });
      verdict = { allowed: false, restrictedToNamedWorkforce: true };
      const restricted = await ask(SIGNED_V2, adm.chain, { roles: ["rn_case_manager"] });

      expect(open?.redacted).toBe(false);
      expect(restricted?.redacted).toBe(true);
      expect(JSON.stringify(restricted)).not.toContain("SECRET-SUD-GOAL-TEXT");
    });

    it("redacts, never discloses, when the consent evaluator fails", async () => {
      verdictFails = true;
      try {
        const out = await ask(SIGNED_V2, adm.chain, { roles: ["rn_case_manager"] });
        expect(out?.redacted).toBe(true);
        expect(JSON.stringify(out)).not.toContain("SECRET-SUD-GOAL-TEXT");
      } finally {
        verdictFails = false;
      }
    });

    it("does not ask M39 for a version that holds no Part 2 content", async () => {
      const before = verdictAsks;
      await ask("2026-03-05T00:00:00.000Z", adm.chain);

      expect(verdictAsks).toBe(before);
    });
  },
);
