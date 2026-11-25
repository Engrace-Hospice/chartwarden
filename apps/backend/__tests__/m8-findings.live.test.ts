/**
 * WF09 — the M8 per-visit findings (ADLs, nutrition, weight history), proven against real Postgres as the NOBYPASSRLS
 * `chartwarden_app` role.
 *
 * The unit suites assert the pure rules, the routes over an in-memory dataset and the value sets against the migration text; this
 * one proves what only a database can:
 *   1. a PUT upserts one row per encounter (UNIQUE), replacing the whole record; created_by stays, updated_by moves; the encounter's
 *      siting is copied onto the row; reads see exactly what was stored.
 *   2. RLS isolates `encounter_adl` / `encounter_nutrition` per tenant (negative control: the superuser sees both tenants), the app
 *      role cannot DELETE, and the service answers another tenant's encounter with the non-leaking 404.
 *   3. the write-audit trigger lands an `<table>.insert` then `<table>.update` row naming the acting user.
 *   4. every CHECK constraint refuses a bad value written straight to the table (the service can never be the only guard).
 *   5. a signed, cosign-pending, cosigned or void encounter refuses both PUTs with 409 IMMUTABLE_AFTER_SIGN and keeps its row; a
 *      finalized one refuses with 409 NOTE_PINNED_AT_FINALIZE (the note text is pinned); only a draft takes a record, and only when
 *      its template has a section that states it (422 FINDING_NOT_IN_NOTE otherwise).
 *   6. only the AUTHOR's first write starts a clockless draft's closure clock (`draft_opened`), once.
 *   7. weight history reads the patient's earlier SIGNED encounters (plus this visit's own weight), across tenants not at all.
 *   8. `loadRecordedFindings` hands the note facts what was stored and nothing for an empty record, and, beside this visit's ADL
 *      levels, the ADL levels of the patient's latest earlier SIGNED visit that assessed any (`priorAdl`): never a draft, finalized,
 *      void, later or same-day visit, another patient's, or another tenant's; the gate's cheap read never reads it.
 *   9. the HTTP routes behind the real guards and a DB-backed server: the read event lands with the encounter as its resource id and
 *      the PATIENT in its context; the optional If-Match refuses a stale record (409 STALE_VERSION); an AI principal is refused.
 *  11. the application role can update what a record says and nothing that says what it IS (42501 on an identity column), and the
 *      guard trigger refuses a change of identity from any role (23514).
 *  12. concurrency: two first PUTs with If-Match 0 leave exactly one winner (the loser is 409 STALE_VERSION); a PUT racing the encounter
 *      row lock waits for it, the way finalize's own lock makes it wait.
 *  10. the M8 `encounter_record` eraser deletes the ADL and nutrition records of a destroyed patient (the encounter root is only
 *      tombstoned, so the ON DELETE CASCADE never fires) and leaves another patient's alone.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m8:findings:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1. Never point this at the shared Docker cluster.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  M3_INTRINSIC_PREDICATES,
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { createDbEncounterAbacResolver } from "../src/modules/08-encounters/encounters-route-service-db";
import {
  ENCOUNTER_ERASED_REASON,
  createDrizzleEncounterEraseStore,
} from "../src/modules/08-encounters/erasers/encounter-eraser";
import {
  type FindingsService,
  PRIOR_ADL_READ_CAP,
  createDrizzleFindingsService,
  loadRecordedFindings,
  loadRecordedRecords,
  readPriorAdl,
  readWeightHistory,
  registerFindingsRoutes,
} from "../src/modules/08-encounters/findings/index";
import {
  buildEncounterAbacPredicates,
  createDbEncounterRouteService,
  registerEncounterRoutes,
} from "../src/modules/08-encounters/index";
import { noWoundReader } from "../src/modules/08-encounters/wound-reader";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
/** A past service date: `encounter_service_date_not_future` forbids the future. */
const SERVICE_DATE = "2026-03-10";
const NOW = new Date("2026-03-10T15:00:00.000Z");
const VOIDED_REASON = "voided by the findings live suite: synthetic fixture, no patient content";

type EncounterStatus = "draft" | "finalized" | "signed" | "cosign_pending" | "cosigned" | "voided";

interface Member {
  readonly userId: string;
  readonly membershipId: string;
}
interface OrgFixture {
  readonly orgId: string;
  readonly providerEntityId: string;
  readonly locationId: string;
}

function one<T>(rows: readonly T[]): T {
  const [first, ...rest] = rows;
  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one row, got ${rows.length}`);
  }
  return first;
}

const GOOD_ADL = {
  items: { bathing: "limited_assist", dressing: "supervision", eating: "independent" },
  bladder: "occasionally_incontinent",
  bowel: "continent",
  devices: ["walker", "hospital_bed"],
} as const;
const GOOD_NUTRITION = {
  appetite: "poor",
  mealIntakePercent: 25,
  fluidIntake: "decreased",
  swallowing: "difficulty_solids",
  support: "oral_supplements",
} as const;

describe.skipIf(!DB_URL)("M8 findings (ADLs, nutrition, weight history) — LIVE Postgres", () => {
  let admin: Client;
  let appPg: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: FindingsService;
  const orgs = {} as Record<"A" | "B", OrgFixture>;
  let authorA: Member;
  let otherA: Member;
  let authorB: Member;

  // ---------------------------------------------------------------------------------------------------------------
  // fixtures
  // ---------------------------------------------------------------------------------------------------------------
  async function seedOrg(orgId: string, slug: string, npi: string): Promise<OrgFixture> {
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
      [orgId, `findings-${slug}`],
    );
    const pe = await admin.query<{ id: string }>(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
      [orgId, `FD-${slug}`, `PE ${slug}`, npi],
    );
    const providerEntityId = one(pe.rows).id;
    const loc = await admin.query<{ id: string }>(
      `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1,'Site','1 Main St','Town','NY','10001','America/New_York') RETURNING id`,
      [providerEntityId],
    );
    return { orgId, providerEntityId, locationId: one(loc.rows).id };
  }

  async function seedMember(org: OrgFixture, label: string): Promise<Member> {
    const user = await admin.query<{ id: string }>(
      `INSERT INTO "user" (email) VALUES ($1) RETURNING id`,
      [`${label}-${randomUUID().slice(0, 8)}@findings.test`],
    );
    const userId = one(user.rows).id;
    const membership = await admin.query<{ id: string }>(
      `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
      [userId, org.orgId],
    );
    return { userId, membershipId: one(membership.rows).id };
  }

  interface EncounterSeed {
    readonly org: OrgFixture;
    readonly author: Member;
    readonly status?: EncounterStatus;
    readonly serviceDate?: string;
    readonly patientId?: string;
    readonly clockStartedAt?: Date | null;
    /** The note template's pair; a routine RN visit when omitted. */
    readonly encounterType?: string;
    readonly discipline?: string;
  }

  async function seedEncounter(seed: EncounterSeed): Promise<string> {
    const status = seed.status ?? "draft";
    const clock = seed.clockStartedAt ?? null;
    const sealed = status === "signed" || status === "cosign_pending" || status === "cosigned";
    const voided = status === "voided";
    const stamp = new Date("2026-03-11T00:00:00.000Z");
    const result = await admin.query<{ id: string }>(
      `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id, admission_id,
         encounter_type, discipline, authored_by_membership_id, service_date, status, vocab_version_id, signed_at,
         voided_at, voided_by, voided_reason, clock_started_at, clock_start_source)
       VALUES ($1,$2,$3,$4,$5,$16,$17,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [
        seed.org.orgId,
        seed.org.providerEntityId,
        seed.org.locationId,
        seed.patientId ?? randomUUID(),
        randomUUID(),
        seed.author.membershipId,
        seed.serviceDate ?? SERVICE_DATE,
        status,
        status === "draft" ? null : randomUUID(),
        sealed ? stamp : null,
        voided ? stamp : null,
        voided ? seed.author.membershipId : null,
        voided ? VOIDED_REASON : null,
        clock,
        clock ? "draft_created" : null,
        seed.encounterType ?? "routine_visit",
        seed.discipline ?? "rn",
      ],
    );
    return one(result.rows).id;
  }

  const setStatus = async (encounterId: string, status: EncounterStatus): Promise<void> => {
    const sealed = status === "signed" || status === "cosign_pending" || status === "cosigned";
    const voided = status === "voided";
    await admin.query(
      `UPDATE encounter SET status=$2, vocab_version_id=$3, signed_at=$4, voided_at=$5, voided_by=$6, voided_reason=$7
        WHERE id=$1`,
      [
        encounterId,
        status,
        status === "draft" ? null : randomUUID(),
        sealed ? new Date("2026-03-11T00:00:00.000Z") : null,
        voided ? new Date("2026-03-11T00:00:00.000Z") : null,
        voided ? authorA.membershipId : null,
        voided ? VOIDED_REASON : null,
      ],
    );
  };

  async function seedVitalsWeight(
    org: OrgFixture,
    encounterId: string,
    weight: string | null,
    unit: "lb" | "kg" | null,
    capturedAt: string,
  ): Promise<void> {
    await admin.query(
      `INSERT INTO vitals (organization_id, encounter_id, captured_at, weight, weight_unit)
       VALUES ($1,$2,$3,$4,$5)`,
      [org.orgId, encounterId, capturedAt, weight, unit],
    );
  }

  /** One transaction as `chartwarden_app` on a raw pg connection, with the GUCs `withOrgContext` sets (or none). */
  async function asApp<T>(
    org: string | null,
    userId: string,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    await appPg.query("BEGIN");
    try {
      if (org !== null) {
        await appPg.query(
          "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)",
          [org, userId],
        );
      }
      const result = await fn(appPg);
      await appPg.query("COMMIT");
      return result;
    } catch (error) {
      await appPg.query("ROLLBACK");
      throw error;
    }
  }

  async function sqlFailure(
    run: Promise<unknown>,
  ): Promise<{ code?: string; constraint?: string }> {
    try {
      await run;
    } catch (error) {
      return error as { code?: string; constraint?: string };
    }
    throw new Error("expected the statement to fail, but it succeeded");
  }

  const countRows = async (table: string, where = "true"): Promise<number> =>
    one(
      (await admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))
        .rows,
    ).n;

  const encounterRow = async (id: string) =>
    one((await admin.query("SELECT * FROM encounter WHERE id=$1", [id])).rows);

  const rowOf = async (table: string, encounterId: string) =>
    one((await admin.query(`SELECT * FROM ${table} WHERE encounter_id=$1`, [encounterId])).rows);

  const inOrg = <T>(orgId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(handle.db, { organizationId: orgId, userId: "" }, (tx) =>
      fn(tx as unknown as DbClient),
    );

  const errorCodeOf = async (run: Promise<unknown>): Promise<string> => {
    try {
      await run;
    } catch (error) {
      if (error instanceof ChartWardenError) return error.code;
      throw error;
    }
    return "no error";
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (stripVector) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
    orgs.A = await seedOrg(ORG_A, "a", "1400000001");
    orgs.B = await seedOrg(ORG_B, "b", "1400000002");
    authorA = await seedMember(orgs.A, "author-a");
    otherA = await seedMember(orgs.A, "other-a");
    authorB = await seedMember(orgs.B, "author-b");

    const appUrl = await appRoleConnectionString(admin, DB_URL as string);
    appPg = new Client({ connectionString: appUrl });
    await appPg.connect();
    handle = createDbClient({ connectionString: appUrl });
    svc = createDrizzleFindingsService({ db: handle.db, clock: () => NOW });
  }, 600_000);

  afterAll(async () => {
    await handle?.close();
    if (appPg) await appPg.end();
    if (admin) await admin.end();
  });

  // ===============================================================================================================
  // 1. the record: one row per encounter, replaced whole
  // ===============================================================================================================
  describe.each([
    ["encounter_adl", GOOD_ADL, { items: { bathing: "total_dependence" }, devices: ["cane"] }],
    ["encounter_nutrition", GOOD_NUTRITION, { appetite: "good" }],
  ] as const)("1. %s: one row per encounter, replaced whole", (table, first, second) => {
    const isAdl = table === "encounter_adl";
    const get = (id: string) => (isAdl ? svc.getAdl(ORG_A, id) : svc.getNutrition(ORG_A, id));
    const put = (id: string, body: object, by: Member) =>
      isAdl
        ? svc.putAdl(ORG_A, id, body, by.membershipId)
        : svc.putNutrition(ORG_A, id, body, by.membershipId);
    let encounterId: string;

    beforeAll(async () => {
      encounterId = await seedEncounter({ org: orgs.A, author: authorA });
    });

    it("reads null before anything was recorded", async () => {
      expect(await get(encounterId)).toBeNull();
    });

    it("stores the record, stamps its author and copies the encounter's siting", async () => {
      const view = await put(encounterId, first, authorA);
      const row = await rowOf(table, encounterId);

      expect(view.encounterId).toBe(encounterId);
      expect(await get(encounterId)).toEqual(view);
      expect(row.organization_id).toBe(ORG_A);
      expect(row.provider_entity_id).toBe(orgs.A.providerEntityId);
      expect(row.location_id).toBe(orgs.A.locationId);
      expect(row.created_by_membership_id).toBe(authorA.membershipId);
      expect(row.updated_by_membership_id).toBe(authorA.membershipId);
    });

    it("replaces the whole record on a second PUT: one row, what the body omits is cleared, updated_by moves", async () => {
      const view = await put(encounterId, second, otherA);
      const row = await rowOf(table, encounterId);

      expect(await countRows(table, `encounter_id='${encounterId}'`)).toBe(1);
      expect(row.created_by_membership_id).toBe(authorA.membershipId);
      expect(row.updated_by_membership_id).toBe(otherA.membershipId);
      expect(await get(encounterId)).toEqual(view);
      if (isAdl) {
        expect(row).toMatchObject({ bathing: "total_dependence", dressing: null, eating: null });
        expect(row.bladder).toBeNull();
        expect(row.devices).toEqual(["cane"]);
      } else {
        expect(row).toMatchObject({ appetite: "good", meal_intake_percent: null, support: null });
      }
    });

    it("is idempotent: the same body twice leaves the same record", async () => {
      const a = await put(encounterId, second, otherA);
      const b = await put(encounterId, second, otherA);
      expect(b).toEqual(a);
      expect(await countRows(table, `encounter_id='${encounterId}'`)).toBe(1);
    });

    it("answers a missing encounter, and another tenant's, with the non-leaking 404", async () => {
      const foreign = await seedEncounter({ org: orgs.B, author: authorB });
      expect(await errorCodeOf(get(randomUUID()))).toBe("NOT_FOUND");
      expect(await errorCodeOf(get(foreign))).toBe("NOT_FOUND");
      expect(await errorCodeOf(put(foreign, first, authorA))).toBe("NOT_FOUND");
      expect(await countRows(table, `encounter_id='${foreign}'`)).toBe(0);
    });

    it("rejects a bad value with a 422 and writes nothing", async () => {
      const fresh = await seedEncounter({ org: orgs.A, author: authorA });
      const bad = isAdl ? { items: { bathing: "mostly" } } : { mealIntakePercent: 101 };
      expect(await errorCodeOf(put(fresh, bad, authorA))).toBe("VALIDATION_FAILED");
      expect(await countRows(table, `encounter_id='${fresh}'`)).toBe(0);
    });
  });

  it("stores the 0 and 100 percent meal-intake edges", async () => {
    for (const percent of [0, 100]) {
      const id = await seedEncounter({ org: orgs.A, author: authorA });
      await svc.putNutrition(ORG_A, id, { mealIntakePercent: percent }, authorA.membershipId);
      expect((await rowOf("encounter_nutrition", id)).meal_intake_percent).toBe(percent);
    }
  });

  // ===============================================================================================================
  // 2. tenant isolation (RLS, as chartwarden_app)
  // ===============================================================================================================
  describe("2. cross-tenant isolation of the two tables", () => {
    const tables = ["encounter_adl", "encounter_nutrition"] as const;
    let encounterA: string;
    let encounterB: string;

    beforeAll(async () => {
      encounterA = await seedEncounter({ org: orgs.A, author: authorA });
      encounterB = await seedEncounter({ org: orgs.B, author: authorB });
      await svc.putAdl(ORG_A, encounterA, GOOD_ADL, authorA.membershipId);
      await svc.putNutrition(ORG_A, encounterA, GOOD_NUTRITION, authorA.membershipId);
      await svc.putAdl(ORG_B, encounterB, GOOD_ADL, authorB.membershipId);
      await svc.putNutrition(ORG_B, encounterB, GOOD_NUTRITION, authorB.membershipId);
    });

    const countAs = (org: string | null, table: string, where = "true") =>
      asApp(
        org,
        authorA.userId,
        async (c) =>
          one(
            (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`))
              .rows,
          ).n,
      );

    it("each tenant reads only its own rows and a session with no org context reads none", async () => {
      for (const table of tables) {
        const own = await countAs(ORG_B, table, `organization_id='${ORG_B}'`);
        expect(own, `${table} own rows as B`).toBeGreaterThanOrEqual(1);
        expect(await countAs(ORG_B, table, `organization_id='${ORG_A}'`)).toBe(0);
        expect(await countAs(ORG_A, table, `organization_id='${ORG_B}'`)).toBe(0);
        expect(await countAs(ORG_B, table, `encounter_id='${encounterA}'`)).toBe(0);
        expect(await countAs(null, table), `${table} with no GUC`).toBe(0);
      }
    });

    it("negative control: the superuser sees both tenants, so the zero above is the policy and not an empty table", async () => {
      for (const table of tables) {
        expect(await countRows(table, `organization_id='${ORG_A}'`)).toBeGreaterThanOrEqual(1);
        expect(await countRows(table, `organization_id='${ORG_B}'`)).toBeGreaterThanOrEqual(1);
      }
    });

    it("org B cannot write org A's rows: an insert hits the WITH CHECK, an update touches nothing", async () => {
      const insert = await sqlFailure(
        asApp(ORG_B, authorB.userId, (c) =>
          c.query(
            `INSERT INTO encounter_adl (organization_id, encounter_id, created_by_membership_id, updated_by_membership_id)
             VALUES ($1,$2,$3,$3)`,
            [ORG_A, randomUUID(), authorB.membershipId],
          ),
        ),
      );
      expect(insert.code).toBe("42501");
      for (const table of tables) {
        const updated = await asApp(ORG_B, authorB.userId, (c) =>
          c.query(`UPDATE ${table} SET updated_at = now() WHERE encounter_id=$1`, [encounterA]),
        );
        expect(updated.rowCount, `${table} update across tenants`).toBe(0);
      }
    });

    it("the application role cannot delete a record", async () => {
      for (const table of tables) {
        const failure = await sqlFailure(
          asApp(ORG_A, authorA.userId, (c) => c.query(`DELETE FROM ${table}`)),
        );
        expect(failure.code, `${table} delete`).toBe("42501");
      }
    });
  });

  // ===============================================================================================================
  // 3. the write-audit trigger
  // ===============================================================================================================
  describe("3. the write-audit trigger lands insert then update, naming the acting user", () => {
    it.each([
      ["encounter_adl", "putAdl", GOOD_ADL, { bowel: "incontinent" }],
      ["encounter_nutrition", "putNutrition", GOOD_NUTRITION, { support: "tube_feeding" }],
    ] as const)("%s", async (table, method, first, second) => {
      const encounterId = await seedEncounter({ org: orgs.A, author: authorA });
      const write = (body: object) =>
        runWithRequestContext({ organizationId: ORG_A, userId: authorA.userId }, () =>
          svc[method](ORG_A, encounterId, body, authorA.membershipId),
        );
      await write(first);
      await write(second);
      const rowId = (await rowOf(table, encounterId)).id as string;

      const events = (
        await admin.query(
          `SELECT event_type, actor_user_id::text AS actor, organization_id::text AS org, before, after
             FROM audit_event WHERE resource_kind=$1 AND resource_id=$2 ORDER BY created_at, id`,
          [table, rowId],
        )
      ).rows;

      expect(events.map((e) => e.event_type)).toEqual([`${table}.insert`, `${table}.update`]);
      for (const e of events) {
        expect(e.actor).toBe(authorA.userId);
        expect(e.org).toBe(ORG_A);
      }
      expect(events[0]?.before).toBeNull();
      expect(events[1]?.before).not.toBeNull();
      expect(Object.values(events[1]?.after as Record<string, unknown>)).toContain(
        Object.values(second)[0],
      );
    });
  });

  // ===============================================================================================================
  // 4. CHECK constraints refuse a bad value straight to the table; 5. one row per encounter in the catalog
  // ===============================================================================================================
  describe("4. the CHECK constraints and the unique encounter, as chartwarden_app writing the table directly", () => {
    let encounterId: string;

    beforeAll(async () => {
      encounterId = await seedEncounter({ org: orgs.A, author: authorA });
    });

    const insertAs = (
      table: string,
      column: string,
      value: unknown,
      encounter: string = randomUUID(),
    ) =>
      sqlFailure(
        asApp(ORG_A, authorA.userId, (c) =>
          c.query(
            `INSERT INTO ${table} (organization_id, encounter_id, created_by_membership_id, updated_by_membership_id, ${column})
             VALUES ($1,$2,$3,$3,$4)`,
            [ORG_A, encounter, authorA.membershipId, value],
          ),
        ),
      );

    it.each([
      ["encounter_adl", "bathing", "mostly", "encounter_adl_bathing_level"],
      ["encounter_adl", "dressing", "continent", "encounter_adl_dressing_level"],
      ["encounter_adl", "grooming", "x", "encounter_adl_grooming_level"],
      ["encounter_adl", "toileting", "x", "encounter_adl_toileting_level"],
      ["encounter_adl", "transferring", "x", "encounter_adl_transferring_level"],
      ["encounter_adl", "ambulation", "x", "encounter_adl_ambulation_level"],
      ["encounter_adl", "eating", "x", "encounter_adl_eating_level"],
      ["encounter_adl", "bladder", "independent", "encounter_adl_bladder_level"],
      ["encounter_adl", "bowel", "leaky", "encounter_adl_bowel_level"],
      ["encounter_adl", "devices", ["cane", "jetpack"], "encounter_adl_devices_known"],
      ["encounter_nutrition", "appetite", "ravenous", "encounter_nutrition_appetite_level"],
      ["encounter_nutrition", "fluid_intake", "flood", "encounter_nutrition_fluid_intake_level"],
      ["encounter_nutrition", "swallowing", "fine", "encounter_nutrition_swallowing_level"],
      ["encounter_nutrition", "support", "magic", "encounter_nutrition_support_level"],
      [
        "encounter_nutrition",
        "meal_intake_percent",
        101,
        "encounter_nutrition_meal_intake_percent_range",
      ],
      [
        "encounter_nutrition",
        "meal_intake_percent",
        -1,
        "encounter_nutrition_meal_intake_percent_range",
      ],
    ] as const)("%s.%s = %j is refused by %s", async (table, column, value, constraint) => {
      const failure = await insertAs(table, column, value);
      expect(failure.code).toBe("23514");
      expect(failure.constraint).toBe(constraint);
    });

    it("accepts a value of every set, so the refusals above are the constraint and not the fixture", async () => {
      for (const [table, column, value] of [
        ["encounter_adl", "bathing", "independent"],
        ["encounter_adl", "devices", ["cane", "walker"]],
        ["encounter_nutrition", "meal_intake_percent", 100],
      ] as const) {
        await asApp(ORG_A, authorA.userId, (c) =>
          c.query(
            `INSERT INTO ${table} (organization_id, encounter_id, created_by_membership_id, updated_by_membership_id, ${column})
             VALUES ($1,$2,$3,$3,$4)`,
            [ORG_A, encounterId, authorA.membershipId, value],
          ),
        );
        await admin.query(`DELETE FROM ${table} WHERE encounter_id=$1`, [encounterId]);
      }
    });

    it("refuses a second row for the same encounter", async () => {
      await svc.putAdl(ORG_A, encounterId, GOOD_ADL, authorA.membershipId);
      const failure = await insertAs("encounter_adl", "bathing", "independent", encounterId);
      expect(failure.code).toBe("23505");
      expect(failure.constraint).toBe("encounter_adl_encounter_id_unique");
    });
  });

  // ===============================================================================================================
  // 5. the immutability rule
  // ===============================================================================================================
  describe("5. an encounter past editing refuses both PUTs and keeps its record", () => {
    it.each(["signed", "cosign_pending", "cosigned", "voided"] as const)(
      "%s: 409 IMMUTABLE_AFTER_SIGN, the stored record untouched, reads still work",
      async (status) => {
        const encounterId = await seedEncounter({ org: orgs.A, author: authorA });
        await svc.putAdl(ORG_A, encounterId, GOOD_ADL, authorA.membershipId);
        await svc.putNutrition(ORG_A, encounterId, GOOD_NUTRITION, authorA.membershipId);
        const before = {
          adl: await rowOf("encounter_adl", encounterId),
          nutrition: await rowOf("encounter_nutrition", encounterId),
        };
        await setStatus(encounterId, status);

        expect(await errorCodeOf(svc.putAdl(ORG_A, encounterId, {}, authorA.membershipId))).toBe(
          "IMMUTABLE_AFTER_SIGN",
        );
        expect(
          await errorCodeOf(svc.putNutrition(ORG_A, encounterId, {}, authorA.membershipId)),
        ).toBe("IMMUTABLE_AFTER_SIGN");

        expect(await rowOf("encounter_adl", encounterId)).toEqual(before.adl);
        expect(await rowOf("encounter_nutrition", encounterId)).toEqual(before.nutrition);
        expect(await svc.getAdl(ORG_A, encounterId)).not.toBeNull();
        expect(await svc.getNutrition(ORG_A, encounterId)).not.toBeNull();
      },
    );

    it("a signed encounter with no record yet cannot gain one", async () => {
      const encounterId = await seedEncounter({ org: orgs.A, author: authorA, status: "signed" });
      expect(
        await errorCodeOf(svc.putAdl(ORG_A, encounterId, GOOD_ADL, authorA.membershipId)),
      ).toBe("IMMUTABLE_AFTER_SIGN");
      expect(await countRows("encounter_adl", `encounter_id='${encounterId}'`)).toBe(0);
    });

    it("a finalized (not yet signed) encounter refuses both PUTs with 409 NOTE_PINNED_AT_FINALIZE and keeps its record", async () => {
      // Finalize pins the note text, ADLs and nutrition included: a record changed afterwards would disagree with the signed note.
      const encounterId = await seedEncounter({ org: orgs.A, author: authorA });
      await svc.putAdl(ORG_A, encounterId, GOOD_ADL, authorA.membershipId);
      await svc.putNutrition(ORG_A, encounterId, GOOD_NUTRITION, authorA.membershipId);
      const before = {
        adl: await rowOf("encounter_adl", encounterId),
        nutrition: await rowOf("encounter_nutrition", encounterId),
      };
      await setStatus(encounterId, "finalized");
      expect(await errorCodeOf(svc.putAdl(ORG_A, encounterId, {}, authorA.membershipId))).toBe(
        "NOTE_PINNED_AT_FINALIZE",
      );
      expect(
        await errorCodeOf(svc.putNutrition(ORG_A, encounterId, {}, authorA.membershipId)),
      ).toBe("NOTE_PINNED_AT_FINALIZE");
      expect(await rowOf("encounter_adl", encounterId)).toEqual(before.adl);
      expect(await rowOf("encounter_nutrition", encounterId)).toEqual(before.nutrition);
      expect(await svc.getAdl(ORG_A, encounterId)).not.toBeNull(); // reads are unaffected
    });

    it("a draft whose template has no section for the record refuses it (422 FINDING_NOT_IN_NOTE) and stores nothing", async () => {
      // An SLP note states nutrition but not ADLs; a PT note states ADLs but not nutrition; a chaplain note states neither.
      const slp = await seedEncounter({
        org: orgs.A,
        author: authorA,
        encounterType: "slp_visit",
        discipline: "slp",
      });
      const pt = await seedEncounter({
        org: orgs.A,
        author: authorA,
        encounterType: "pt_visit",
        discipline: "pt",
      });
      expect(await errorCodeOf(svc.putAdl(ORG_A, slp, GOOD_ADL, authorA.membershipId))).toBe(
        "FINDING_NOT_IN_NOTE",
      );
      expect(
        await errorCodeOf(svc.putNutrition(ORG_A, pt, GOOD_NUTRITION, authorA.membershipId)),
      ).toBe("FINDING_NOT_IN_NOTE");
      expect(await countRows("encounter_adl", `encounter_id='${slp}'`)).toBe(0);
      expect(await countRows("encounter_nutrition", `encounter_id='${pt}'`)).toBe(0);
      // ...and the pairs that DO state them take them.
      await svc.putNutrition(ORG_A, slp, GOOD_NUTRITION, authorA.membershipId);
      await svc.putAdl(ORG_A, pt, GOOD_ADL, authorA.membershipId);
      expect(await countRows("encounter_nutrition", `encounter_id='${slp}'`)).toBe(1);
      expect(await countRows("encounter_adl", `encounter_id='${pt}'`)).toBe(1);
    });
  });

  // ===============================================================================================================
  // 6. the closure clock
  // ===============================================================================================================
  describe("6. the author's first write starts a clockless draft's closure clock, once", () => {
    const clockOf = async (id: string) =>
      one(
        (
          await admin.query(
            "SELECT clock_started_at, clock_start_source FROM encounter WHERE id=$1",
            [id],
          )
        ).rows,
      );

    it("is stamped `draft_opened` by the author, not by anyone else, and never moved by a later write", async () => {
      const mine = await seedEncounter({ org: orgs.A, author: authorA });
      const theirs = await seedEncounter({ org: orgs.A, author: authorA });

      await svc.putAdl(ORG_A, theirs, GOOD_ADL, otherA.membershipId);
      expect((await clockOf(theirs)).clock_started_at).toBeNull();

      await svc.putAdl(ORG_A, mine, GOOD_ADL, authorA.membershipId);
      const stamped = await clockOf(mine);
      expect(stamped.clock_start_source).toBe("draft_opened");
      expect(new Date(stamped.clock_started_at as string).toISOString()).toBe(NOW.toISOString());

      const later = createDrizzleFindingsService({
        db: handle.db,
        clock: () => new Date("2026-03-12T00:00:00.000Z"),
      });
      await later.putNutrition(ORG_A, mine, GOOD_NUTRITION, authorA.membershipId);
      expect(await clockOf(mine)).toEqual(stamped);
    });
  });

  // ===============================================================================================================
  // 7. weight history
  // ===============================================================================================================
  describe("7. weight history reads the patient's earlier SIGNED encounters, plus this visit's own weight", () => {
    const PATIENT = randomUUID();
    let current: string;
    let earlier: string;
    let earliest: string;

    beforeAll(async () => {
      earliest = await seedEncounter({
        org: orgs.A,
        author: authorA,
        patientId: PATIENT,
        status: "signed",
        serviceDate: "2026-02-24",
      });
      earlier = await seedEncounter({
        org: orgs.A,
        author: authorA,
        patientId: PATIENT,
        status: "signed",
        serviceDate: "2026-03-03",
      });
      current = await seedEncounter({
        org: orgs.A,
        author: authorA,
        patientId: PATIENT,
        serviceDate: "2026-03-10",
      });
      await seedVitalsWeight(orgs.A, earliest, "154", "lb", "2026-02-24T15:00:00Z");
      // two sets on the earlier visit: the later capture is the visit's weight
      await seedVitalsWeight(orgs.A, earlier, "151", "lb", "2026-03-03T15:00:00Z");
      await seedVitalsWeight(orgs.A, earlier, "152", "lb", "2026-03-03T16:00:00Z");
      await seedVitalsWeight(orgs.A, current, "150.5", "lb", "2026-03-10T15:00:00Z");

      // what must NOT count: a void visit, an earlier visit still a DRAFT or only FINALIZED (another clinician's unsigned weight is not
      // theirs to pin into this note's legal text), a LATER visit, another visit the SAME day, a weight with no unit, an unusable
      // weight, another patient, and another tenant's patient carrying the same id
      const earlierDraft = await seedEncounter({
        org: orgs.A,
        author: otherA,
        patientId: PATIENT,
        serviceDate: "2026-03-05",
      });
      await seedVitalsWeight(orgs.A, earlierDraft, "148", "lb", "2026-03-05T15:00:00Z");
      const earlierFinalized = await seedEncounter({
        org: orgs.A,
        author: otherA,
        patientId: PATIENT,
        status: "finalized",
        serviceDate: "2026-03-06",
      });
      await seedVitalsWeight(orgs.A, earlierFinalized, "147", "lb", "2026-03-06T15:00:00Z");
      const voided = await seedEncounter({
        org: orgs.A,
        author: authorA,
        patientId: PATIENT,
        status: "voided",
        serviceDate: "2026-03-08",
      });
      await seedVitalsWeight(orgs.A, voided, "100", "lb", "2026-03-08T15:00:00Z");
      const later = await seedEncounter({
        org: orgs.A,
        author: authorA,
        patientId: PATIENT,
        serviceDate: "2026-03-12",
      });
      await seedVitalsWeight(orgs.A, later, "90", "lb", "2026-03-12T15:00:00Z");
      const sameDay = await seedEncounter({
        org: orgs.A,
        author: authorA,
        patientId: PATIENT,
        serviceDate: "2026-03-10",
      });
      await seedVitalsWeight(orgs.A, sameDay, "95", "lb", "2026-03-10T18:00:00Z");
      const noUnit = await seedEncounter({
        org: orgs.A,
        author: authorA,
        patientId: PATIENT,
        status: "signed",
        serviceDate: "2026-03-09",
      });
      await seedVitalsWeight(orgs.A, noUnit, "149", null, "2026-03-09T15:00:00Z");
      const unusable = await seedEncounter({
        org: orgs.A,
        author: authorA,
        patientId: PATIENT,
        status: "signed",
        serviceDate: "2026-03-09",
      });
      await seedVitalsWeight(orgs.A, unusable, "0", "lb", "2026-03-09T16:00:00Z");
      const otherPatient = await seedEncounter({
        org: orgs.A,
        author: authorA,
        status: "signed",
        serviceDate: "2026-03-09",
      });
      await seedVitalsWeight(orgs.A, otherPatient, "70", "kg", "2026-03-09T17:00:00Z");
      const foreign = await seedEncounter({
        org: orgs.B,
        author: authorB,
        patientId: PATIENT,
        status: "signed",
        serviceDate: "2026-03-09",
      });
      await seedVitalsWeight(orgs.B, foreign, "60", "kg", "2026-03-09T18:00:00Z");
    });

    it("answers this visit's weight, the previous visit's and the history, newest first", async () => {
      expect(await svc.getWeightHistory(ORG_A, current)).toEqual({
        patientId: PATIENT,
        weightUnitMissing: false,
        current: { value: "150.5", unit: "lb", on: "2026-03-10" },
        prior: { value: "152", unit: "lb", on: "2026-03-03" },
        history: [
          { value: "150.5", unit: "lb", on: "2026-03-10" },
          { value: "152", unit: "lb", on: "2026-03-03" },
          { value: "154", unit: "lb", on: "2026-02-24" },
        ],
      });
    });

    it("has no prior for the patient's first visit, and a prior but no current for a visit with no weight", async () => {
      expect((await svc.getWeightHistory(ORG_A, earliest)).prior).toBeNull();
      const noWeight = await seedEncounter({
        org: orgs.A,
        author: authorA,
        patientId: PATIENT,
        serviceDate: "2026-03-20",
      });
      const result = await svc.getWeightHistory(ORG_A, noWeight);
      expect(result.current).toBeNull();
      // the latest earlier, SIGNED, unit-bearing weight is the 2026-03-03 visit's: the later drafts and the finalized visit are not
      // signed, the void one never happened, and the 2026-03-09 visits carry no usable weight
      expect(result.prior).toEqual({ value: "152", unit: "lb", on: "2026-03-03" });
    });

    it("answers another tenant's encounter, and a missing one, with the 404", async () => {
      const foreignEncounter = await seedEncounter({ org: orgs.B, author: authorB });
      expect(await errorCodeOf(svc.getWeightHistory(ORG_A, foreignEncounter))).toBe("NOT_FOUND");
      expect(await errorCodeOf(svc.getWeightHistory(ORG_A, randomUUID()))).toBe("NOT_FOUND");
      await expect(svc.getWeightHistory(ORG_A, randomUUID())).rejects.toBeInstanceOf(NotFoundError);
    });

    it("reports a legacy weight with no usable unit as weightUnitMissing, and leaves it out of the history", async () => {
      const patient = randomUUID();
      const signedBefore = await seedEncounter({
        org: orgs.A,
        author: authorA,
        patientId: patient,
        status: "signed",
        serviceDate: "2026-03-01",
      });
      await seedVitalsWeight(orgs.A, signedBefore, "130", "lb", "2026-03-01T15:00:00Z");
      const head = await seedEncounter({
        org: orgs.A,
        author: authorA,
        patientId: patient,
        serviceDate: "2026-03-05",
      });
      // `vitals.weight_unit` is nullable with no CHECK, so rows like this exist: a weight the note cannot state without guessing a unit.
      await seedVitalsWeight(orgs.A, head, "149", null, "2026-03-05T15:00:00Z");
      const before = await svc.getWeightHistory(ORG_A, head);
      expect(before.weightUnitMissing).toBe(true);
      expect(before.current).toBeNull();
      expect(before.prior).toEqual({ value: "130", unit: "lb", on: "2026-03-01" });
      // A newer set with the unit becomes the visit's weight; the old unit-less set still holds a weight that is not stated, so it
      // keeps being reported until that set is corrected. A visit with no such set reports nothing.
      await seedVitalsWeight(orgs.A, head, "149", "lb", "2026-03-05T16:00:00Z");
      const after = await svc.getWeightHistory(ORG_A, head);
      expect(after.current).toEqual({ value: "149", unit: "lb", on: "2026-03-05" });
      expect(after.weightUnitMissing).toBe(true);
      expect((await svc.getWeightHistory(ORG_A, signedBefore)).weightUnitMissing).toBe(false);
    });

    it("caps the history at six readings", async () => {
      const patient = randomUUID();
      for (let day = 1; day <= 8; day++) {
        const id = await seedEncounter({
          org: orgs.A,
          author: authorA,
          patientId: patient,
          status: "signed",
          serviceDate: `2026-02-${String(day).padStart(2, "0")}`,
        });
        await seedVitalsWeight(
          orgs.A,
          id,
          String(140 + day),
          "lb",
          `2026-02-${String(day).padStart(2, "0")}T15:00:00Z`,
        );
      }
      const head = await seedEncounter({
        org: orgs.A,
        author: authorA,
        patientId: patient,
        serviceDate: "2026-03-01",
      });
      const result = await svc.getWeightHistory(ORG_A, head);
      expect(result.history).toHaveLength(6);
      expect(result.history[0]).toEqual({ value: "148", unit: "lb", on: "2026-02-08" });
      expect(result.prior?.value).toBe("148");
    });
  });

  // ===============================================================================================================
  // 8. the note facts
  // ===============================================================================================================
  describe("8. loadRecordedFindings hands the note what was recorded", () => {
    const PATIENT = randomUUID();

    it("returns the ADL record, the nutrition record and the prior weight, null fields omitted", async () => {
      const prior = await seedEncounter({
        org: orgs.A,
        author: authorA,
        patientId: PATIENT,
        status: "signed",
        serviceDate: "2026-03-01",
      });
      await seedVitalsWeight(orgs.A, prior, "130", "lb", "2026-03-01T15:00:00Z");
      const encounterId = await seedEncounter({ org: orgs.A, author: authorA, patientId: PATIENT });
      await svc.putAdl(ORG_A, encounterId, GOOD_ADL, authorA.membershipId);
      await svc.putNutrition(
        ORG_A,
        encounterId,
        { appetite: "fair", mealIntakePercent: 0 },
        authorA.membershipId,
      );

      const facts = await inOrg(ORG_A, (tx) =>
        loadRecordedFindings(tx, { organizationId: ORG_A, encounterId }),
      );

      expect(facts).toEqual({
        adl: {
          items: { bathing: "limited_assist", dressing: "supervision", eating: "independent" },
          bladder: "occasionally_incontinent",
          bowel: "continent",
          devices: ["walker", "hospital_bed"], // the documented order, whatever order was sent
        },
        nutrition: { appetite: "fair", mealIntakePercent: 0 },
        priorWeight: { value: "130", unit: "lb", on: "2026-03-01" },
      });
    });

    it("the gate's cheap read returns the two records only, never the prior weight", async () => {
      const prior = await seedEncounter({
        org: orgs.A,
        author: authorA,
        patientId: PATIENT,
        status: "signed",
        serviceDate: "2026-03-02",
      });
      await seedVitalsWeight(orgs.A, prior, "131", "lb", "2026-03-02T15:00:00Z");
      const encounterId = await seedEncounter({ org: orgs.A, author: authorA, patientId: PATIENT });
      await svc.putAdl(ORG_A, encounterId, GOOD_ADL, authorA.membershipId);
      const records = await inOrg(ORG_A, (tx) =>
        loadRecordedRecords(tx, { organizationId: ORG_A, encounterId }),
      );
      expect(Object.keys(records)).toEqual(["adl"]);
      const full = await inOrg(ORG_A, (tx) =>
        loadRecordedFindings(tx, { organizationId: ORG_A, encounterId }),
      );
      expect(full.priorWeight).toEqual({ value: "131", unit: "lb", on: "2026-03-02" });
    });

    it("omits a finding with nothing recorded, and an empty record counts as nothing", async () => {
      const encounterId = await seedEncounter({ org: orgs.A, author: authorA });
      expect(
        await inOrg(ORG_A, (tx) =>
          loadRecordedFindings(tx, { organizationId: ORG_A, encounterId }),
        ),
      ).toEqual({});
      await svc.putAdl(ORG_A, encounterId, {}, authorA.membershipId);
      expect(
        await inOrg(ORG_A, (tx) =>
          loadRecordedFindings(tx, { organizationId: ORG_A, encounterId }),
        ),
      ).toEqual({});
    });

    it("reads nothing across tenants: org B's context cannot see org A's encounter", async () => {
      const encounterId = await seedEncounter({ org: orgs.A, author: authorA });
      await svc.putAdl(ORG_A, encounterId, GOOD_ADL, authorA.membershipId);
      await expect(
        inOrg(ORG_B, (tx) => loadRecordedFindings(tx, { organizationId: ORG_B, encounterId })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        inOrg(ORG_B, (tx) => readWeightHistory(tx, { organizationId: ORG_B, encounterId })),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        inOrg(ORG_B, (tx) => readPriorAdl(tx, { organizationId: ORG_B, encounterId })),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    describe("the previous signed visit's ADL levels (priorAdl)", () => {
      /** An encounter holding an ADL record: recorded while a draft (the only state that takes a PUT), then moved to `status`. */
      async function seedAdlVisit(
        org: OrgFixture,
        author: Member,
        patientId: string,
        serviceDate: string,
        status: EncounterStatus,
        items: Record<string, string>,
      ): Promise<string> {
        const id = await seedEncounter({ org, author, patientId, serviceDate });
        await svc.putAdl(org.orgId, id, { items } as never, author.membershipId);
        if (status !== "draft") await setStatus(id, status);
        return id;
      }
      const factsOf = (encounterId: string) =>
        inOrg(ORG_A, (tx) => loadRecordedFindings(tx, { organizationId: ORG_A, encounterId }));

      it("is the latest earlier signed visit that assessed an ADL, skipping a visit that assessed none", async () => {
        const patientId = randomUUID();
        await seedAdlVisit(orgs.A, authorA, patientId, "2026-03-01", "signed", {
          bathing: "limited_assist",
          eating: "independent",
        });
        await seedAdlVisit(orgs.A, authorA, patientId, "2026-02-20", "signed", {
          bathing: "total_dependence",
        });
        // a more recent signed visit whose only ADL did not occur says nothing about dependence
        await seedAdlVisit(orgs.A, authorA, patientId, "2026-03-05", "signed", {
          dressing: "did_not_occur",
        });
        const current = await seedAdlVisit(orgs.A, authorA, patientId, SERVICE_DATE, "draft", {
          bathing: "extensive_assist",
        });

        expect((await factsOf(current)).priorAdl).toEqual({
          on: "2026-03-01",
          items: { bathing: "limited_assist", eating: "independent" },
        });
      });

      it("counts signed, cosign-pending and cosigned visits and nothing else", async () => {
        const patientId = randomUUID();
        const current = await seedAdlVisit(orgs.A, authorA, patientId, SERVICE_DATE, "draft", {
          bathing: "limited_assist",
        });
        // none of these is a signed earlier visit of this patient in this tenant
        await seedAdlVisit(orgs.A, otherA, patientId, "2026-03-02", "draft", {
          bathing: "independent",
        });
        await seedAdlVisit(orgs.A, otherA, patientId, "2026-03-03", "finalized", {
          bathing: "independent",
        });
        await seedAdlVisit(orgs.A, authorA, patientId, "2026-03-04", "voided", {
          bathing: "independent",
        });
        await seedAdlVisit(orgs.A, authorA, patientId, "2026-03-12", "signed", {
          bathing: "independent",
        });
        await seedAdlVisit(orgs.A, authorA, patientId, SERVICE_DATE, "signed", {
          bathing: "independent",
        });
        await seedAdlVisit(orgs.A, authorA, randomUUID(), "2026-03-06", "signed", {
          bathing: "independent",
        });
        await seedAdlVisit(orgs.B, authorB, patientId, "2026-03-07", "signed", {
          bathing: "independent",
        });
        expect((await factsOf(current)).priorAdl).toBeUndefined();

        await seedAdlVisit(orgs.A, authorA, patientId, "2026-02-01", "cosigned", {
          bathing: "supervision",
        });
        expect((await factsOf(current)).priorAdl).toEqual({
          on: "2026-02-01",
          items: { bathing: "supervision" },
        });
        await seedAdlVisit(orgs.A, authorA, patientId, "2026-02-15", "cosign_pending", {
          bathing: "extensive_assist",
        });
        expect((await factsOf(current)).priorAdl).toEqual({
          on: "2026-02-15",
          items: { bathing: "extensive_assist" },
        });
      });

      it("is read only beside this visit's own ADL levels, and never by the gate's cheap read", async () => {
        const patientId = randomUUID();
        await seedAdlVisit(orgs.A, authorA, patientId, "2026-03-01", "signed", {
          bathing: "limited_assist",
        });
        // a visit that recorded only continence and devices states no dependence, so it states no prior either
        const continenceOnly = await seedEncounter({ org: orgs.A, author: authorA, patientId });
        await svc.putAdl(
          ORG_A,
          continenceOnly,
          { bladder: "continent", devices: ["cane"] },
          authorA.membershipId,
        );
        expect((await factsOf(continenceOnly)).priorAdl).toBeUndefined();

        const withItems = await seedAdlVisit(orgs.A, authorA, patientId, SERVICE_DATE, "draft", {
          bathing: "limited_assist",
        });
        expect((await factsOf(withItems)).priorAdl).toBeDefined();
        const cheap = await inOrg(ORG_A, (tx) =>
          loadRecordedRecords(tx, { organizationId: ORG_A, encounterId: withItems }),
        );
        expect(Object.keys(cheap)).toEqual(["adl"]);
      });

      it("never takes another tenant's visit of the same patient id, in either direction, and still finds its own", async () => {
        const patientId = randomUUID();
        // tenant A's signed visit is more recent than anything tenant B holds below
        await seedAdlVisit(orgs.A, authorA, patientId, "2026-03-01", "signed", {
          bathing: "independent",
        });
        const currentB = await seedAdlVisit(orgs.B, authorB, patientId, SERVICE_DATE, "draft", {
          bathing: "limited_assist",
        });
        const factsOfB = () =>
          inOrg(ORG_B, (tx) =>
            loadRecordedFindings(tx, { organizationId: ORG_B, encounterId: currentB }),
          );
        expect((await factsOfB()).priorAdl).toBeUndefined();

        await seedAdlVisit(orgs.B, authorB, patientId, "2026-02-01", "signed", {
          bathing: "supervision",
        });
        expect((await factsOfB()).priorAdl).toEqual({
          on: "2026-02-01",
          items: { bathing: "supervision" },
        });
        // tenant B's context asking about tenant A's encounter is the non-leaking 404, whatever organization it names
        const currentA = await seedAdlVisit(orgs.A, authorA, patientId, SERVICE_DATE, "draft", {
          bathing: "limited_assist",
        });
        for (const organizationId of [ORG_A, ORG_B]) {
          await expect(
            inOrg(ORG_B, (tx) => readPriorAdl(tx, { organizationId, encounterId: currentA })),
          ).rejects.toBeInstanceOf(NotFoundError);
        }
      });

      it(`reads back at most ${PRIOR_ADL_READ_CAP} earlier signed visits: one older than that many that assessed no ADL is not reached`, async () => {
        const patientId = randomUUID();
        await seedAdlVisit(orgs.A, authorA, patientId, "2025-12-01", "signed", {
          bathing: "total_dependence",
        });
        const currentVisit = await seedAdlVisit(orgs.A, authorA, patientId, SERVICE_DATE, "draft", {
          bathing: "limited_assist",
        });
        const day = (n: number) => `2026-01-${String(n).padStart(2, "0")}`;
        // PRIOR_ADL_READ_CAP - 1 newer visits whose only ADL did not occur: the older visit is the last one read
        for (let n = 1; n < PRIOR_ADL_READ_CAP; n += 1) {
          await seedAdlVisit(orgs.A, authorA, patientId, day(n), "signed", {
            dressing: "did_not_occur",
          });
        }
        expect((await factsOf(currentVisit)).priorAdl).toEqual({
          on: "2025-12-01",
          items: { bathing: "total_dependence" },
        });
        // one more empty visit pushes it past the lookback
        await seedAdlVisit(orgs.A, authorA, patientId, day(PRIOR_ADL_READ_CAP), "signed", {
          dressing: "did_not_occur",
        });
        expect((await factsOf(currentVisit)).priorAdl).toBeUndefined();
      });
    });
  });

  // ===============================================================================================================
  // 9. the HTTP routes behind the real guards, on a DB-backed server
  // ===============================================================================================================
  describe("9. the routes: guards, scope and the read event", () => {
    let app: ReturnType<typeof buildServer>;
    let encounterId: string;

    const as = (who: Member, roles: string[]) => ({
      "x-test-user": who.userId,
      "x-test-membership": who.membershipId,
      "x-test-roles": roles.join(","),
    });
    function headerAuth(request: FastifyRequest): void {
      const user = request.headers["x-test-user"];
      if (typeof user !== "string" || user.length === 0) return;
      const membership = request.headers["x-test-membership"];
      const roles = request.headers["x-test-roles"];
      const kind = request.headers["x-test-actor-kind"];
      request.context.userId = user;
      request.context.organizationId = ORG_A;
      request.context.attributes.membershipId = typeof membership === "string" ? membership : "";
      if (typeof kind === "string") request.context.attributes.actorKind = kind;
      request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
    }
    const patientOf = async (id: string): Promise<string> =>
      one(
        (
          await admin.query<{ patient_id: string }>(
            "SELECT patient_id FROM encounter WHERE id=$1",
            [id],
          )
        ).rows,
      ).patient_id;
    const readEvents = async (kind: string) =>
      (
        await admin.query(
          `SELECT event_type, resource_id::text AS resource_id, actor_user_id::text AS actor, context
             FROM audit_event WHERE organization_id=$1 AND resource_kind=$2 AND event_type LIKE '%.viewed'
            ORDER BY created_at`,
          [ORG_A, kind],
        )
      ).rows;

    beforeAll(async () => {
      encounterId = await seedEncounter({ org: orgs.A, author: authorA });
      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
      const grant = (who: Member, permissionKeys: string[]) => ({
        orgId: ORG_A,
        userId: who.userId,
        grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
      });
      registerEffectivePermissionResolver(
        createInMemoryEffectivePermissionStore([
          grant(authorA, ["encounter.read", "encounter.author", "vitals.author"]),
          grant(otherA, ["encounter.read", "vitals.author"]),
        ]).store,
      );
      const registry = createPredicateRegistry({ ...M3_INTRINSIC_PREDICATES });
      const predicates = buildEncounterAbacPredicates({
        resolver: createDbEncounterAbacResolver(handle.db),
        isInCaseload: async () => true,
      });
      for (const [name, fn] of Object.entries(predicates)) registry.register(name, fn);
      registerAbacRegistry(registry);
      app = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      registerFindingsRoutes(app, { service: createDrizzleFindingsService({ db: handle.db }) });
      // The encounter routes this suite reads through for the read-audit cases (fall incidents, the selection tree). No M30 register
      // and no M9 are wired here: an empty fall register, and no wounds stated, both by name.
      registerEncounterRoutes(app, {
        service: createDbEncounterRouteService(
          handle.db,
          undefined,
          undefined,
          () => NOW,
          {
            async recentFalls() {
              return [];
            },
          },
          noWoundReader,
        ),
      });
      await app.ready();
    }, 120_000);

    afterAll(async () => {
      await app?.close();
      resetAuthorizationContract();
      resetRbacEngine();
      resetAbacRegistry();
    });

    it("the author writes and reads back; a non-author, non-supervisor is refused and writes nothing", async () => {
      const refused = await app.inject({
        method: "PUT",
        url: `/api/v1/encounters/${encounterId}/adl`,
        headers: as(otherA, ["rn"]),
        payload: GOOD_ADL,
      });
      expect(refused.statusCode).toBe(403);
      expect(await countRows("encounter_adl", `encounter_id='${encounterId}'`)).toBe(0);

      const put = await app.inject({
        method: "PUT",
        url: `/api/v1/encounters/${encounterId}/adl`,
        headers: as(authorA, ["rn"]),
        payload: GOOD_ADL,
      });
      expect(put.statusCode).toBe(200);
      const get = await app.inject({
        method: "GET",
        url: `/api/v1/encounters/${encounterId}/adl`,
        headers: as(otherA, ["rn"]),
      });
      expect(get.statusCode).toBe(200);
      expect(JSON.parse(get.body)).toMatchObject({
        encounterId,
        bladder: "occasionally_incontinent",
      });
    });

    it("answers a bad value 422 and a signed encounter 409 IMMUTABLE_AFTER_SIGN", async () => {
      const bad = await app.inject({
        method: "PUT",
        url: `/api/v1/encounters/${encounterId}/nutrition`,
        headers: as(authorA, ["rn"]),
        payload: { mealIntakePercent: 12.5 },
      });
      expect(bad.statusCode).toBe(422);

      const signed = await seedEncounter({ org: orgs.A, author: authorA, status: "signed" });
      const refused = await app.inject({
        method: "PUT",
        url: `/api/v1/encounters/${signed}/nutrition`,
        headers: as(authorA, ["rn"]),
        payload: GOOD_NUTRITION,
      });
      expect(refused.statusCode).toBe(409);
      expect(JSON.parse(refused.body).error.code).toBe("IMMUTABLE_AFTER_SIGN");
    });

    it("another tenant's encounter id is a 404 on all three routes", async () => {
      const foreign = await seedEncounter({ org: orgs.B, author: authorB });
      for (const path of ["adl", "nutrition", "weight-history"]) {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/encounters/${foreign}/${path}`,
          headers: as(authorA, ["rn"]),
        });
        expect(res.statusCode, path).toBe(404);
      }
    });

    it("the encounter reads that disclose a patient's note content land their read event against the PATIENT too (fall incidents, the selection tree)", async () => {
      await admin.query(
        "DELETE FROM audit_event WHERE organization_id=$1 AND event_type LIKE '%.viewed'",
        [ORG_A],
      );
      const patient = await patientOf(encounterId);
      const falls = await app.inject({
        method: "GET",
        url: `/api/v1/encounters/${encounterId}/fall-incidents`,
        headers: as(authorA, ["rn"]),
      });
      expect(falls.statusCode).toBe(200);
      expect(JSON.parse(falls.body)).toEqual({
        patientId: patient,
        incidents: [],
        unavailable: false,
      });
      const tree = await app.inject({
        method: "GET",
        url: `/api/v1/encounters/${encounterId}/selections`,
        headers: as(authorA, ["rn"]),
      });
      expect(tree.statusCode).toBe(200);
      expect(JSON.parse(tree.body).patientId).toBe(patient);

      for (const kind of ["encounter", "hearthnote_selection"]) {
        const events = await readEvents(kind);
        expect(events, kind).toHaveLength(1);
        expect(events[0]?.event_type).toBe(`${kind}.viewed`);
        expect(events[0]?.resource_id).toBe(encounterId);
        expect(events[0]?.context?.patientId, kind).toBe(patient);
      }
    });

    it("an optional If-Match refuses a stale record with 409 STALE_VERSION; without it the PUT behaves as before", async () => {
      const id = await seedEncounter({ org: orgs.A, author: authorA });
      const url = `/api/v1/encounters/${id}/adl`;
      const put = (body: object, extra: Record<string, string> = {}) =>
        app.inject({
          method: "PUT",
          url,
          headers: { ...as(authorA, ["rn"]), ...extra },
          payload: body,
        });

      // No record yet: GET answers null and `ETag: "0"`; a first write conditioned on 0 succeeds and returns the new version.
      const empty = await app.inject({ method: "GET", url, headers: as(authorA, ["rn"]) });
      expect(empty.headers.etag).toBe('"0"');
      const first = await put(GOOD_ADL, { "if-match": "0" });
      expect(first.statusCode).toBe(200);
      const v1 = JSON.parse(first.body).version as number;
      expect(first.headers.etag).toBe(`"${v1}"`);
      expect(v1).toBeGreaterThan(0);

      // Writing again on the version read replaces it and moves the version on, even within the same millisecond.
      const second = await put({ bladder: "continent" }, { "if-match": `"${v1}"` });
      expect(second.statusCode).toBe(200);
      const v2 = JSON.parse(second.body).version as number;
      expect(v2).toBeGreaterThan(v1);

      // The stale version (what a second tab still holds) is refused and writes nothing.
      const stale = await put({ bladder: "incontinent" }, { "if-match": String(v1) });
      expect(stale.statusCode).toBe(409);
      expect(JSON.parse(stale.body).error.code).toBe("STALE_VERSION");
      expect(await rowOf("encounter_adl", id)).toMatchObject({ bladder: "continent" });

      // A first write conditioned on "no record" is stale once one exists; a malformed header is a 400; absent keeps the old behaviour.
      expect((await put(GOOD_ADL, { "if-match": "0" })).statusCode).toBe(409);
      expect((await put(GOOD_ADL, { "if-match": "abc" })).statusCode).toBe(400);
      expect((await put({ bladder: "occasionally_incontinent" })).statusCode).toBe(200);
      const get = await app.inject({ method: "GET", url, headers: as(authorA, ["rn"]) });
      expect(get.headers.etag).toBe(`"${JSON.parse(get.body).version}"`);
    });

    it("an AI principal cannot record ADLs or nutrition (403, nothing written)", async () => {
      const id = await seedEncounter({ org: orgs.A, author: authorA });
      for (const path of ["adl", "nutrition"]) {
        const res = await app.inject({
          method: "PUT",
          url: `/api/v1/encounters/${id}/${path}`,
          headers: { ...as(authorA, ["rn"]), "x-test-actor-kind": "ai_agent" },
          payload: path === "adl" ? GOOD_ADL : GOOD_NUTRITION,
        });
        expect(res.statusCode, path).toBe(403);
      }
      expect(await countRows("encounter_adl", `encounter_id='${id}'`)).toBe(0);
      expect(await countRows("encounter_nutrition", `encounter_id='${id}'`)).toBe(0);
    });

    it("the read events land: one per GET, against the encounter and its PATIENT, attributed to the reader, naming fields and no values", async () => {
      await admin.query(
        "DELETE FROM audit_event WHERE organization_id=$1 AND event_type LIKE '%.viewed'",
        [ORG_A],
      );
      await app.inject({
        method: "PUT",
        url: `/api/v1/encounters/${encounterId}/nutrition`,
        headers: as(authorA, ["rn"]),
        payload: GOOD_NUTRITION,
      });
      for (const path of ["adl", "nutrition", "weight-history"]) {
        const res = await app.inject({
          method: "GET",
          url: `/api/v1/encounters/${encounterId}/${path}`,
          headers: as(otherA, ["rn"]),
        });
        expect(res.statusCode, path).toBe(200);
      }

      for (const kind of ["encounter_adl", "encounter_nutrition", "vitals"]) {
        const events = await readEvents(kind);
        expect(events, kind).toHaveLength(1);
        expect(events[0]?.event_type).toBe(`${kind}.viewed`);
        expect(events[0]?.resource_id).toBe(encounterId);
        expect(events[0]?.actor).toBe(otherA.userId);
        // §164.528: the accounting by patient joins on `context.patientId`; a weight history discloses weights from the patient's
        // OTHER encounters, so it must name the patient just as the ADL and nutrition reads do.
        expect(events[0]?.context?.patientId, kind).toBe(await patientOf(encounterId));
        expect(JSON.stringify(events[0]?.context)).not.toMatch(
          /limited_assist|oral_supplements|150/,
        );
      }
    });
  });

  // ===============================================================================================================
  // 10. the destruction eraser
  // ===============================================================================================================
  describe("10. the encounter_record eraser deletes the recorded ADLs and nutrition", () => {
    it("removes them for the destroyed patient's encounters (the root is only tombstoned) and leaves another patient's alone", async () => {
      // The eraser's delete half needs DELETE, which the NOBYPASSRLS app role holds on no M8 table by design (the destruction role
      // does, in production); this suite drives it over the admin connection and proves WHAT it deletes, not who may.
      const privileged = createDbClient({ connectionString: DB_URL as string });
      try {
        const destroyed = randomUUID();
        const first = await seedEncounter({ org: orgs.A, author: authorA, patientId: destroyed });
        const second = await seedEncounter({ org: orgs.A, author: authorA, patientId: destroyed });
        // A SIGNED encounter of the destroyed patient (already pinned to a vocabulary release, and with an EVV-missing reason whose
        // minimum length the tombstone must keep satisfying): the path a real destruction takes for most of a patient's visits.
        const signed = await seedEncounter({
          org: orgs.A,
          author: authorA,
          patientId: destroyed,
          status: "signed",
        });
        await admin.query(
          `UPDATE encounter SET evv_bracket_state='evv_missing_documented', evv_missing_reason=$2 WHERE id=$1`,
          [signed, "the clinician's own words about why the visit has no EVV bracket"],
        );
        // A fall linked to a visit of the destroyed patient (migration 1517 columns): the tombstone must not keep it.
        await admin.query(
          "UPDATE encounter SET fall_incident_id=gen_random_uuid(), fall_occurred_on='2026-03-01' WHERE id=$1",
          [first],
        );
        const pinnedBefore = (await encounterRow(signed)).vocab_version_id as string;
        const survivor = await seedEncounter({ org: orgs.A, author: authorA });
        await svc.putAdl(ORG_A, first, GOOD_ADL, authorA.membershipId);
        await svc.putNutrition(ORG_A, first, GOOD_NUTRITION, authorA.membershipId);
        await svc.putAdl(ORG_A, second, GOOD_ADL, authorA.membershipId);
        await svc.putAdl(ORG_A, survivor, GOOD_ADL, authorA.membershipId);
        await svc.putNutrition(ORG_A, survivor, GOOD_NUTRITION, authorA.membershipId);
        const ids = `'${first}','${second}'`;
        const allIds = `'${first}','${second}','${signed}'`;
        expect(await countRows("encounter_adl", `encounter_id IN (${ids})`)).toBe(2);
        expect(await countRows("encounter_nutrition", `encounter_id IN (${ids})`)).toBe(1);

        const store = createDrizzleEncounterEraseStore(privileged.db);
        const counts = await store.eraseEncounterSubtree(ORG_A, destroyed);
        await store.tombstoneEncounters(ORG_A, destroyed);

        expect(counts.adlRecords).toBe(2);
        expect(counts.nutritionRecords).toBe(1);
        expect(await countRows("encounter_adl", `encounter_id IN (${ids})`)).toBe(0);
        expect(await countRows("encounter_nutrition", `encounter_id IN (${ids})`)).toBe(0);
        // The root survives as a tombstone (that is why no cascade could have removed the rows above) ...
        expect(await countRows("encounter", `id IN (${allIds}) AND status='voided'`)).toBe(3);
        // ... satisfying the table's own CHECKs for a draft (which had no vocabulary pin) and a signed row alike, holding none of the
        // clinician's words: a reason that existed is the one fixed scrub sentence, one that did not stays null.
        for (const id of [first, second, signed]) {
          const row = await encounterRow(id);
          expect(row.voided_reason, id).toBe(ENCOUNTER_ERASED_REASON);
          expect(row.voided_at, id).not.toBeNull();
          expect(row.voided_by, id).not.toBeNull();
          expect(row.vocab_version_id, id).not.toBeNull();
        }
        expect((await encounterRow(signed)).vocab_version_id).toBe(pinnedBefore);
        expect((await encounterRow(signed)).evv_missing_reason).toBe(ENCOUNTER_ERASED_REASON);
        expect((await encounterRow(first)).evv_missing_reason).toBeNull();
        for (const id of [first, second, signed]) {
          const row = await encounterRow(id);
          expect(row.fall_incident_id, id).toBeNull();
          expect(row.fall_occurred_on, id).toBeNull();
        }
        // ... and another patient's records are untouched.
        expect(await countRows("encounter_adl", `encounter_id='${survivor}'`)).toBe(1);
        expect(await countRows("encounter_nutrition", `encounter_id='${survivor}'`)).toBe(1);
      } finally {
        await privileged.close();
      }
    });
  });

  // ===============================================================================================================
  // 11. identity columns
  // ===============================================================================================================
  describe.each([
    ["encounter_adl", "bathing", "'independent'", GOOD_ADL],
    ["encounter_nutrition", "appetite", "'good'", GOOD_NUTRITION],
  ] as const)(
    "11. %s: the application role cannot rewrite what a record IS",
    (table, valueColumn, value, body) => {
      let encounterId: string;
      let otherEncounterId: string;

      beforeAll(async () => {
        encounterId = await seedEncounter({ org: orgs.A, author: authorA });
        otherEncounterId = await seedEncounter({ org: orgs.A, author: authorA });
        if (table === "encounter_adl")
          await svc.putAdl(ORG_A, encounterId, body, authorA.membershipId);
        else await svc.putNutrition(ORG_A, encounterId, body, authorA.membershipId);
      });

      const updateAsApp = (set: string, params: unknown[] = []) =>
        asApp(ORG_A, authorA.userId, (c) =>
          c.query(`UPDATE ${table} SET ${set} WHERE encounter_id='${encounterId}'`, params),
        );

      it("may update a value column and the update stamps", async () => {
        const result = await updateAsApp(
          `${valueColumn}=${value}, updated_by_membership_id=$1, updated_at=now()`,
          [otherA.membershipId],
        );
        expect(result.rowCount).toBe(1);
      });

      it.each([
        ["encounter_id", `'${randomUUID()}'`],
        ["organization_id", `'${ORG_B}'`],
        ["created_by_membership_id", `'${randomUUID()}'`],
        ["created_at", "now() - interval '1 day'"],
        ["id", "gen_random_uuid()"],
      ])("is refused 42501 (permission denied) on %s", async (column, expression) => {
        const failure = await sqlFailure(updateAsApp(`${column}=${expression}`));
        expect(failure.code).toBe("42501");
      });

      it("the guard trigger refuses a change of identity from any role, a superuser included (23514), and leaves the row alone", async () => {
        const before = await rowOf(table, encounterId);
        for (const set of [
          `encounter_id='${otherEncounterId}'`,
          "created_at=now() - interval '1 day'",
          `created_by_membership_id='${otherA.membershipId}'`,
        ]) {
          const failure = await sqlFailure(
            admin.query(`UPDATE ${table} SET ${set} WHERE encounter_id='${encounterId}'`),
          );
          expect(failure.code, set).toBe("23514");
        }
        expect(await rowOf(table, encounterId)).toEqual(before);
      });
    },
  );

  // ===============================================================================================================
  // 12. concurrency
  // ===============================================================================================================
  describe("12. concurrent writes on one encounter serialise", () => {
    it("two first PUTs with If-Match 0 leave exactly one winner: the loser is 409 STALE_VERSION and the winner's record stands", async () => {
      for (let round = 0; round < 6; round++) {
        const encounterId = await seedEncounter({ org: orgs.A, author: authorA });
        const bodies = [GOOD_ADL, { bladder: "continent" }] as const;
        const settled = await Promise.allSettled(
          bodies.map((body) => svc.putAdl(ORG_A, encounterId, body, authorA.membershipId, 0)),
        );
        const won = settled.filter((r) => r.status === "fulfilled");
        const lost = settled.filter((r) => r.status === "rejected");
        expect(won, `round ${round}`).toHaveLength(1);
        expect((lost[0] as PromiseRejectedResult).reason).toMatchObject({
          code: "STALE_VERSION",
          statusCode: 409,
        });
        // One row, and it is the winner's body, not a blend or the loser's overwrite.
        const winner = bodies[
          settled.findIndex((r) => r.status === "fulfilled")
        ] as (typeof bodies)[number];
        const stored = await svc.getAdl(ORG_A, encounterId);
        expect(stored?.bladder).toBe("bladder" in winner ? winner.bladder : null);
        expect(await countRows("encounter_adl", `encounter_id='${encounterId}'`)).toBe(1);
      }
    });

    it("the same for nutrition", async () => {
      const encounterId = await seedEncounter({ org: orgs.A, author: authorA });
      const settled = await Promise.allSettled([
        svc.putNutrition(ORG_A, encounterId, GOOD_NUTRITION, authorA.membershipId, 0),
        svc.putNutrition(ORG_A, encounterId, { appetite: "good" }, authorA.membershipId, 0),
      ]);
      expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (settled.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
      ).toMatchObject({ code: "STALE_VERSION" });
      expect(await countRows("encounter_nutrition", `encounter_id='${encounterId}'`)).toBe(1);
    });

    it("a PUT waits for another writer's lock on the encounter row, then lands (it does not read a stale status)", async () => {
      // The same row lock finalize takes before it reads the findings: while it is held, the PUT is parked, and only when it is
      // released does the PUT read the status and write. (Finalize versus a PUT is driven in the m8-encounters-write suite.)
      const encounterId = await seedEncounter({ org: orgs.A, author: authorA });
      const holder = new Client({ connectionString: DB_URL });
      await holder.connect();
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT id FROM encounter WHERE id=$1 FOR NO KEY UPDATE", [encounterId]);
        let settled = false;
        const put = svc.putAdl(ORG_A, encounterId, GOOD_ADL, authorA.membershipId).finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(settled, "the PUT is parked on the encounter row lock").toBe(false);
        expect(await countRows("encounter_adl", `encounter_id='${encounterId}'`)).toBe(0);
        await holder.query("COMMIT");
        await put;
        expect(await countRows("encounter_adl", `encounter_id='${encounterId}'`)).toBe(1);
      } finally {
        await holder.query("ROLLBACK").catch(() => undefined);
        await holder.end();
      }
    });
  });
});
