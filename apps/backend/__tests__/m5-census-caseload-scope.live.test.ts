/**
 * F-096 — §7.5's census half: `/api/v1/patients` narrowed to the actor's caseload, in the SQL.
 *
 * LIVE by necessity, and specifically because of PAGINATION. A behavioural test against the in-memory
 * slice cannot tell the correct implementation from the one that reads the whole tenant and filters
 * afterwards — both return the same ids for a small unpaged fixture. They differ the moment a LIMIT is
 * involved: narrowing INSIDE the WHERE clause pages over the caseload, while a post-read filter pages
 * over the TENANT and then discards, so it returns short pages, a wrong `nextCursor`, and — the part
 * that matters — it has already read every patient in the tenant into application memory. That is the
 * M12 `refillInboxWhere` lesson ("a post-read `rows.filter(...)` returns the same rows ... while still
 * reading every refill in the tenant") applied to the surface with 5,000 rows in it.
 *
 * Drives the PRODUCTION Drizzle service as the NOBYPASSRLS `chartwarden_app` role, so RLS is the backstop
 * under the narrowing rather than a substitute for it.
 *
 * CHARTWARDEN_TEST_DATABASE_URL=postgres://... bunx vitest run \
 *   apps/backend/__tests__/m5-census-caseload-scope.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbPatientRouteService } from "../src/modules/05-patient/patient-route-service-db";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "wardenx_report_writer",
];
const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";

/** Five patients whose ascending (lastName, firstName, id) order is exactly A…E. */
const NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"] as const;

describe.skipIf(!DB_URL)("F-096 census caseload narrowing — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbPatientRouteService>;
  const idsA = new Map<string, string>();
  let orgBPatientId = "";

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));

    for (const [id, slug] of [
      [ORG_A, "org-f096-a"],
      [ORG_B, "org-f096-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$3,$3)",
        [id, slug, slug],
      );
    }
    for (const last of NAMES) {
      const { rows } = await admin.query(
        `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob,
           sex_assigned_at_birth, status)
         VALUES ($1, $2, 'Pat', $3, '1950-01-01', 'female', 'active') RETURNING id`,
        [ORG_A, `mrn-${last}`, last],
      );
      idsA.set(last, rows[0].id as string);
    }
    const other = await admin.query(
      `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob,
         sex_assigned_at_birth, status)
       VALUES ($1, 'mrn-other', 'Pat', 'Alpha', '1950-01-01', 'female', 'active') RETURNING id`,
      [ORG_B],
    );
    orgBPatientId = other.rows[0].id as string;

    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    service = createDbPatientRouteService(handle.db, { publish: async () => undefined });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  const idsOf = (page: { items: { id: string }[] }) => page.items.map((p) => p.id);

  it("null scope reads the whole tenant — the org-wide oversight role is unchanged", async () => {
    const page = await service.list(ORG_A, {}, null);
    expect(idsOf(page)).toHaveLength(NAMES.length);
    expect(idsOf(page)).not.toContain(orgBPatientId);
  });

  it("a named scope returns exactly that set", async () => {
    const mine = [idsA.get("Delta")!, idsA.get("Echo")!];
    const page = await service.list(ORG_A, {}, mine);
    expect(idsOf(page).sort()).toEqual([...mine].sort());
  });

  it("an EMPTY scope returns NOTHING — not everything", async () => {
    // The fail-open shape is `if (scope.length > 0) narrow(scope)`, which turns an actor with no
    // caseload into an actor who reads the entire tenant. Under RLS this is still a same-org read, so
    // no isolation gate catches it; the only thing standing between an unassigned account and the
    // agency's whole census is this predicate.
    const page = await service.list(ORG_A, {}, []);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it("narrowing happens IN the WHERE clause, not after the LIMIT", async () => {
    // The discriminator. Delta and Echo sort LAST of the five. With `limit: 2`:
    //   - narrowing in the WHERE → the query pages over the caseload → [Delta, Echo], no next page.
    //   - filtering after the read → the first 3 rows are Alpha/Bravo/Charlie → [] and a bogus cursor,
    //     having read all five patients into memory on the way.
    // A small unpaged fixture cannot tell those apart, which is why this suite exists at all.
    const mine = [idsA.get("Delta")!, idsA.get("Echo")!];
    const page = await service.list(ORG_A, { limit: 2 }, mine);
    expect(idsOf(page)).toEqual(mine);
    expect(page.nextCursor).toBeNull();
  });

  it("pages THROUGH the caseload, not through the tenant", async () => {
    const mine = [idsA.get("Alpha")!, idsA.get("Charlie")!, idsA.get("Echo")!];
    const first = await service.list(ORG_A, { limit: 2 }, mine);
    expect(idsOf(first)).toEqual([mine[0], mine[1]]);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.list(ORG_A, { limit: 2, cursor: first.nextCursor! }, mine);
    expect(idsOf(second)).toEqual([mine[2]]);
    expect(second.nextCursor).toBeNull();
  });

  it("the q-filter cannot widen the census past the scope", async () => {
    // Every other filter the route accepts is ANDed with the narrowing, never applied instead of it —
    // otherwise the search box is the bypass.
    const page = await service.list(ORG_A, { q: "Alpha" }, [idsA.get("Echo")!]);
    expect(page.items).toEqual([]);
  });

  it("a scope naming another tenant's patient still reads nothing — RLS is under the narrowing", async () => {
    // Defence in depth, and the reason the narrowing is not a substitute for RLS: even handed an id it
    // should never have seen, the org-scoped read matches no row.
    const page = await service.list(ORG_A, {}, [orgBPatientId]);
    expect(page.items).toEqual([]);
  });
});
