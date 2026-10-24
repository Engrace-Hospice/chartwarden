/**
 * GAP-047 / GAP-049 — M16 early-close cosign + completion source-encounter verification, LIVE Postgres.
 *
 * Real `buildDrizzleM16WriteService` as the NOBYPASSRLS `chartwarden_app` role, real M8
 * `BereavementEncounterReader` over the real `encounter` table. Plans / contacts / outreach / encounters are
 * seeded as the admin role (the intake path has its own suite); the plan-shaped read service is a stub
 * because the real one resolves the M39 consent gate, which is not what is under test here.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m16:early-close:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerSeam } from "../src/bootstrap/index";
import { createBereavementEncounterReader } from "../src/modules/08-encounters/seams/bereavement-encounter-reader";
import {
  type M16ReadService,
  type M16WriteActor,
  buildDrizzleM16WriteService,
} from "../src/modules/16-bereavement/routes/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_OTHER = "22222222-2222-2222-2222-222222222222";
const NARRATIVE = "The family relocated out of state and asked that the program be closed early.";

const actorOf = (membershipId: string, organizationId = ORG): M16WriteActor => ({
  organizationId,
  userId: membershipId,
  membershipId,
  roles: [],
  sessionClass: "staff",
  locationIds: [],
  portalAccountId: null,
  stepUpRecent: true,
});

describe.skipIf(!DB_URL)("GAP-047/049 — M16 early-close cosign + source encounter, LIVE", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof buildDrizzleM16WriteService>;
  let providerEntityId: string;
  let counselor: string;
  let supervisor: string;
  let authorMembership: string;

  async function seedPlan(): Promise<{ planId: string; patientId: string; version: number }> {
    const patientId = randomUUID();
    const { rows } = await admin.query(
      `INSERT INTO bereavement_plan
         (organization_id, patient_id, admission_id, provider_entity_id, status, death_date,
          assigned_counselor_user_id, opened_at)
       VALUES ($1,$2,$3,$4,'active', CURRENT_DATE, $5, now()) RETURNING id, version`,
      [ORG, patientId, randomUUID(), providerEntityId, counselor],
    );
    return { planId: rows[0].id as string, patientId, version: rows[0].version as number };
  }

  async function seedOutreach(planId: string, kind: string): Promise<string> {
    const contactId = (
      await admin.query(
        `INSERT INTO bereaved_contact (organization_id, provider_entity_id, plan_id, display_name, relationship_code, status)
           VALUES ($1,$2,$3,'Jane Roe','spouse','active') RETURNING id`,
        [ORG, providerEntityId, planId],
      )
    ).rows[0].id as string;
    const { rows } = await admin.query(
      `INSERT INTO bereavement_outreach
         (organization_id, provider_entity_id, plan_id, bereaved_contact_id, kind, status,
          death_anchor_at, due_at, late_grace_until, assignee_user_id)
       VALUES ($1,$2,$3,$4,$5,'in_progress', now(), now() + interval '7 days', now() + interval '14 days', $6)
       RETURNING id`,
      [ORG, providerEntityId, planId, contactId, kind, counselor],
    );
    return rows[0].id as string;
  }

  async function seedEncounter(
    patientId: string,
    opts: { type?: string; status?: string },
  ): Promise<string> {
    const status = opts.status ?? "signed";
    const { rows } = await admin.query(
      `INSERT INTO encounter
         (organization_id, patient_id, admission_id, encounter_type, discipline,
          authored_by_membership_id, service_date, status, signed_at, vocab_version_id)
       VALUES ($1,$2,$3,$4,'msw',$5, CURRENT_DATE, $6::encounter_status,
               CASE WHEN $7::boolean THEN now() ELSE NULL END, CASE WHEN $7::boolean THEN gen_random_uuid() ELSE NULL END)
       RETURNING id`,
      [
        ORG,
        patientId,
        randomUUID(),
        opts.type ?? "bereavement_contact",
        authorMembership,
        status,
        status !== "draft",
      ],
    );
    return rows[0].id as string;
  }

  const planRow = async (planId: string) =>
    (await admin.query("SELECT * FROM bereavement_plan WHERE id=$1", [planId])).rows[0];
  const closureCount = async (planId: string) =>
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM bereavement_plan_closure WHERE plan_id=$1",
        [planId],
      )
    ).rows[0].n as number;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));

    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG, ORG_OTHER],
    );
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,'CCN-1111','Hospice A','NPI-1111','\\x00','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    const members: string[] = [];
    const userIds: string[] = [];
    for (const email of ["counselor", "supervisor", "author"]) {
      const userId = (
        await admin.query(
          `INSERT INTO "user" (id,email) VALUES (gen_random_uuid(), $1) RETURNING id`,
          [`${email}@gap047.test`],
        )
      ).rows[0].id as string;
      userIds.push(userId);
      members.push(
        (
          await admin.query(
            `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
            [userId, ORG],
          )
        ).rows[0].id as string,
      );
    }
    counselor = userIds[0] as string;
    supervisor = userIds[1] as string;
    authorMembership = members[2] as string;

    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    registerSeam("BereavementEncounterReader", createBereavementEncounterReader(handle.db));
    const readStub = { getPlan: async () => ({}) } as unknown as M16ReadService;
    svc = buildDrizzleM16WriteService(handle.db, readStub);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  describe("GAP-047 — early close is a pending request until a DIFFERENT supervisor cosigns", () => {
    it("close-early leaves the plan active, writes no closure and records the request", async () => {
      const { planId, version } = await seedPlan();
      await svc.closeEarly(actorOf(counselor), planId, {
        expectedVersion: version,
        reason: "geographic_relocation",
        narrative: NARRATIVE,
      });
      const row = await planRow(planId);
      expect(row.status).toBe("active");
      expect(row.early_close_requested_by_user_id).toBe(counselor);
      expect(row.closed_at).toBeNull();
      expect(await closureCount(planId)).toBe(0);
    });

    it("a self-cosign is 403 and changes nothing", async () => {
      const { planId, version } = await seedPlan();
      await svc.closeEarly(actorOf(counselor), planId, {
        expectedVersion: version,
        reason: "geographic_relocation",
        narrative: NARRATIVE,
      });
      const v = (await planRow(planId)).version as number;
      await expect(
        svc.cosignClose(actorOf(counselor), planId, { expectedVersion: v }),
      ).rejects.toMatchObject({ statusCode: 403 });
      expect((await planRow(planId)).status).toBe("active");
      expect(await closureCount(planId)).toBe(0);
    });

    it("a different supervisor's cosign performs the transition; the requester is closed_by, never the cosigner", async () => {
      const { planId, version } = await seedPlan();
      await svc.closeEarly(actorOf(counselor), planId, {
        expectedVersion: version,
        reason: "geographic_relocation",
        narrative: NARRATIVE,
      });
      const v = (await planRow(planId)).version as number;
      await svc.cosignClose(actorOf(supervisor), planId, { expectedVersion: v });
      const row = await planRow(planId);
      expect(row.status).toBe("closed_early");
      expect(row.early_close_reason).toBeNull();
      const { rows } = await admin.query(
        "SELECT closed_by_user_id, cosigned_by_user_id FROM bereavement_plan_closure WHERE plan_id=$1",
        [planId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].closed_by_user_id).toBe(counselor);
      expect(rows[0].cosigned_by_user_id).toBe(supervisor);
    });

    it("a cosign with no pending request is 409", async () => {
      const { planId, version } = await seedPlan();
      await expect(
        svc.cosignClose(actorOf(supervisor), planId, { expectedVersion: version }),
      ).rejects.toMatchObject({ code: "EARLY_CLOSE_NOT_REQUESTED", statusCode: 409 });
    });
  });

  describe("GAP-049 — completeOutreach verifies the kind and the M8 source encounter", () => {
    const body = (extra: Record<string, unknown>) => ({
      kind: "in_person_visit",
      outcome: "engaged" as const,
      contactResponded: true,
      ...extra,
    });

    it("rejects a kind that differs from the scheduled kind (409)", async () => {
      const { planId } = await seedPlan();
      const outreachId = await seedOutreach(planId, "in_person_visit");
      await expect(
        svc.completeOutreach(actorOf(counselor), outreachId, body({ kind: "phone_call" })),
      ).rejects.toMatchObject({ code: "OUTREACH_KIND_MISMATCH", statusCode: 409 });
    });

    it("rejects a fabricated encounter id (422)", async () => {
      const { planId } = await seedPlan();
      const outreachId = await seedOutreach(planId, "in_person_visit");
      await expect(
        svc.completeOutreach(
          actorOf(counselor),
          outreachId,
          body({ sourceEncounterId: randomUUID() }),
        ),
      ).rejects.toMatchObject({ code: "SOURCE_ENCOUNTER_INVALID", statusCode: 422 });
    });

    it.each([
      ["another patient's encounter", { other: true }],
      ["a non-bereavement encounter", { type: "routine_visit" }],
      ["an unsigned (draft) encounter", { status: "draft" }],
    ])("rejects %s (422)", async (_name, opts) => {
      const { planId, patientId } = await seedPlan();
      const outreachId = await seedOutreach(planId, "in_person_visit");
      const encounterId = await seedEncounter(
        "other" in opts ? randomUUID() : patientId,
        opts as { type?: string; status?: string },
      );
      await expect(
        svc.completeOutreach(
          actorOf(counselor),
          outreachId,
          body({ sourceEncounterId: encounterId }),
        ),
      ).rejects.toMatchObject({ code: "SOURCE_ENCOUNTER_INVALID", statusCode: 422 });
    });

    it("accepts a signed bereavement_contact encounter of the same patient", async () => {
      const { planId, patientId } = await seedPlan();
      const outreachId = await seedOutreach(planId, "in_person_visit");
      const encounterId = await seedEncounter(patientId, {});
      const view = await svc.completeOutreach(
        actorOf(counselor),
        outreachId,
        body({ sourceEncounterId: encounterId }),
      );
      expect(view.status).toBe("completed");
      expect(view.sourceEncounterId).toBe(encounterId);
    });
  });
});
