/**
 * GAP-022 — M13's §2.9 D10 RN-case-manager review of caregiver-attested doses, LIVE Postgres.
 *
 * `loadCaregiverReviewFacts()` returned `actorIsRnCaseManager: false` unconditionally, with a TODO saying
 * the fact "needs the M5 CaseloadProvider (patient → RN case manager), outside M13's tables → fail closed
 * until wired". The predicate is `requiresRnReview && actorIsRnCaseManager`, so with the second operand
 * pinned false it could never be true, and BOTH review routes — `POST /administrations/:id/
 * acknowledge-caregiver` and `.../dispute-caregiver` — refused every caller in every tenant. A
 * caregiver-attested dose entered `pending_caregiver_review` and had no reachable way out.
 *
 * The in-memory route suite (`emar-routes.test.ts`) covers these two routes and PASSES, because its
 * backend's fact loader is real — which is exactly why this suite exists and why the audit's remediation
 * note says to cover it with a DB-backed test. The production resolver was the only one that denied.
 *
 * What is asserted here is the DISCRIMINATION, not just the happy path: an aide who is genuinely on the
 * patient's care team is still refused, because D10 names the case manager specifically. `careTeamMembers`
 * would have said yes to that aide — which is why `primaryRnUserId` had to be its own seam method rather
 * than a filter over the roster.
 *
 * Runs as the NOBYPASSRLS `wardenx_app` role.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m13:rn-case-manager:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createCareTeamProvider } from "../src/modules/05-patient/seams/care-team-provider";
import { createDrizzleCareTeamStore } from "../src/modules/05-patient/seams/drizzle-stores";
import { buildEmarAbacPredicates } from "../src/modules/13-emar/abac-predicates";
import { createDbEmarBackend } from "../src/modules/13-emar/emar-route-service-db";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111110022a1";
const ORG_B = "11111111-1111-4111-8111-1111110022a2";
/** The patient's RN case manager (the open `primary_rn` assignment). */
const USER_RN = "22222222-2222-4222-8222-2222220022b1";
/** On the care team as an `aide` — a real team member who is NOT the case manager. */
const USER_AIDE = "22222222-2222-4222-8222-2222220022b2";
/** Not on the care team at all. */
const USER_OUTSIDER = "22222222-2222-4222-8222-2222220022b3";
/** Org B's case manager for its own patient — the cross-tenant probe. */
const USER_RN_B = "22222222-2222-4222-8222-2222220022b4";

const PATIENT_A = "33333333-3333-4333-8333-3333330022c1";
/** Has NO open assignments at all — the "unassigned patient" branch. */
const PATIENT_UNASSIGNED = "33333333-3333-4333-8333-3333330022c2";
const PATIENT_B = "33333333-3333-4333-8333-3333330022c3";
const MED_ORDER = "44444444-4444-4444-8444-4444440022d1";

describe.skipIf(!DB_URL)("GAP-022 M13 RN case-manager review gate — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let backend: ReturnType<typeof createDbEmarBackend>;
  let predicates: ReturnType<typeof buildEmarAbacPredicates>;
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};
  const memberOf: Record<string, string> = {};

  async function applyMigrations() {
    const stripVector = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
  }

  /** An ABAC context shaped like the one `requireAbac` assembles from the request (userId = a USER id). */
  const ctx = (organizationId: string, userId: string) => ({
    organizationId,
    userId,
    roles: [] as readonly string[],
    providerEntityIds: [] as readonly string[],
    locationIds: [] as readonly string[],
    attributes: {} as Record<string, unknown>,
  });

  /** Capture a caregiver-attested dose → `pending_caregiver_review` with `requires_rn_review = true`. */
  async function caregiverAttested(orgId: string, patientId: string) {
    return backend.recordCaregiverAttested(orgId, {
      patientId,
      medicationOrderId: MED_ORDER,
      administeredAt: new Date().toISOString(),
      caregiverSessionId: "55555555-5555-4555-8555-5555550022e1",
      route: "oral",
      doseAmount: 5,
      doseUnit: "mg",
    });
  }

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

    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'gap022-a','A','A','active'),($2,'gap022-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'rn@gap022.test'),($2,'aide@gap022.test'),($3,'out@gap022.test'),($4,'rnb@gap022.test')`,
      [USER_RN, USER_AIDE, USER_OUTSIDER, USER_RN_B],
    );
    for (const [org, users] of [
      [ORG_A, [USER_RN, USER_AIDE, USER_OUTSIDER]],
      [ORG_B, [USER_RN_B]],
    ] as const) {
      // `provider_entity.npi` is globally unique (not per-org), so the two orgs need distinct numbers.
      const pe = await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1, $2, 'PE', $3, 'x', '12-31') RETURNING id`,
        [org, org === ORG_A ? "221001" : "221002", org === ORG_A ? "1234567893" : "1000015838"],
      );
      providerOf[org] = pe.rows[0].id;
      const loc = await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,'Main','1 Elm','Portland','OR','97201','America/Los_Angeles') RETURNING id`,
        [providerOf[org]],
      );
      locationOf[org] = loc.rows[0].id;
      for (const u of users) {
        const m = await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [u, org],
        );
        memberOf[`${org}:${u}`] = m.rows[0].id;
      }
    }
    for (const [org, patients] of [
      [ORG_A, [PATIENT_A, PATIENT_UNASSIGNED]],
      [ORG_B, [PATIENT_B]],
    ] as const) {
      for (const p of patients) {
        await admin.query(
          `INSERT INTO patient (id, organization_id, provider_entity_id, location_id, mrn,
                                legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
           VALUES ($1,$2,$3,$4,$5,'Test','Patient','1950-01-01','F','active')`,
          [p, org, providerOf[org], locationOf[org], `MRN-${p.slice(-6)}`],
        );
      }
    }

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    const publisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M13_OUTBOX_EVENTS]));
    // The composition root's private `bindCallerModule` pins the callerModule the catalog's namespace
    // check needs; reproduced here so the caregiver-capture write's own emit validates like boot's does.
    const outbox = {
      publish: (tx: Parameters<typeof publisher.publish>[0], input: Record<string, unknown>) =>
        publisher.publish(tx, {
          ...(input as unknown as Parameters<typeof publisher.publish>[1]),
          callerModule: "m13",
        }),
    };
    // THE WIRING UNDER TEST: the real M5 Drizzle care-team store behind the real CareTeamProvider,
    // handed to M13 as the thunk `mountEmarRoutes` binds in production.
    const careTeam = createCareTeamProvider(createDrizzleCareTeamStore(handle.db));
    backend = createDbEmarBackend(handle.db, outbox as never, () => careTeam);
    predicates = buildEmarAbacPredicates({ resolver: backend });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM patient_assignment");
    // ORG_A / PATIENT_A: one OPEN primary_rn (the case manager) + one OPEN aide (a team member who is not).
    await admin.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, provider_entity_id, location_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,$4,$5,'primary_rn',CURRENT_DATE), ($1,$2,$3,$4,$6,'aide',CURRENT_DATE)`,
      [PATIENT_A, ORG_A, providerOf[ORG_A], locationOf[ORG_A], USER_RN, USER_AIDE],
    );
    // ORG_B / PATIENT_B: its own case manager, so the cross-tenant probe is a real assignment elsewhere
    // rather than an absent one (an absent row would deny for the wrong reason).
    await admin.query(
      `INSERT INTO patient_assignment (patient_id, organization_id, provider_entity_id, location_id, clinician_user_id, role, assigned_at)
       VALUES ($1,$2,$3,$4,$5,'primary_rn',CURRENT_DATE)`,
      [PATIENT_B, ORG_B, providerOf[ORG_B], locationOf[ORG_B], USER_RN_B],
    );
  });

  // ── the seam method itself ───────────────────────────────────────────────────────────────────────
  it("resolves the patient's RN case manager, and only the primary_rn (not the aide)", async () => {
    const careTeam = createCareTeamProvider(createDrizzleCareTeamStore(handle.db));
    expect(await careTeam.primaryRnUserId({ organizationId: ORG_A, patientId: PATIENT_A })).toBe(
      USER_RN,
    );
    // The aide IS on the roster — proving the two questions are genuinely different.
    const roster = await careTeam.careTeamMembers({ organizationId: ORG_A, patientId: PATIENT_A });
    expect([...roster].sort()).toEqual([USER_RN, USER_AIDE].sort());
  });

  it("returns null for an unassigned patient and for a CLOSED primary_rn assignment", async () => {
    const careTeam = createCareTeamProvider(createDrizzleCareTeamStore(handle.db));
    expect(
      await careTeam.primaryRnUserId({ organizationId: ORG_A, patientId: PATIENT_UNASSIGNED }),
    ).toBeNull();
    await admin.query(
      "UPDATE patient_assignment SET unassigned_at = CURRENT_DATE WHERE patient_id = $1 AND role = 'primary_rn'",
      [PATIENT_A],
    );
    expect(
      await careTeam.primaryRnUserId({ organizationId: ORG_A, patientId: PATIENT_A }),
    ).toBeNull();
  });

  // ── the membership half (#124) — what M8 routes a cosignature to ─────────────────────────────────

  it("resolves the case manager's ACTIVE membership id, not their user id", async () => {
    const careTeam = createCareTeamProvider(createDrizzleCareTeamStore(handle.db));
    const membershipId = await careTeam.primaryRnMembershipId({
      organizationId: ORG_A,
      patientId: PATIENT_A,
    });
    expect(membershipId).toBe(memberOf[`${ORG_A}:${USER_RN}`]);
    // Different id spaces, both real: `patient_assignment` stores the USER, `cosignature_request`
    // references the MEMBERSHIP. A test that only asserted non-null would pass on either.
    expect(membershipId).not.toBe(USER_RN);
  });

  it("answers null when the case manager's membership is no longer active", async () => {
    const careTeam = createCareTeamProvider(createDrizzleCareTeamStore(handle.db));
    await admin.query(
      "UPDATE membership SET status='revoked' WHERE user_id=$1 AND organization_id=$2",
      [USER_RN, ORG_A],
    );
    try {
      // The ASSIGNMENT is still open — the user-id half still answers, so this is specifically the
      // membership rule and not the assignment being gone.
      expect(await careTeam.primaryRnUserId({ organizationId: ORG_A, patientId: PATIENT_A })).toBe(
        USER_RN,
      );
      expect(
        await careTeam.primaryRnMembershipId({ organizationId: ORG_A, patientId: PATIENT_A }),
      ).toBeNull();
    } finally {
      await admin.query(
        "UPDATE membership SET status='active' WHERE user_id=$1 AND organization_id=$2",
        [USER_RN, ORG_A],
      );
    }
  });

  it("answers null for an unassigned patient and across tenants", async () => {
    const careTeam = createCareTeamProvider(createDrizzleCareTeamStore(handle.db));
    expect(
      await careTeam.primaryRnMembershipId({
        organizationId: ORG_A,
        patientId: PATIENT_UNASSIGNED,
      }),
    ).toBeNull();
    // ORG_B's patient HAS a case manager; asking as ORG_A must still be null.
    expect(
      await careTeam.primaryRnMembershipId({ organizationId: ORG_A, patientId: PATIENT_B }),
    ).toBeNull();
  });

  it("does not resolve another tenant's case manager (RLS + the org predicate)", async () => {
    const careTeam = createCareTeamProvider(createDrizzleCareTeamStore(handle.db));
    // Asking ORG_A for ORG_B's patient must be empty even though the assignment row exists.
    expect(
      await careTeam.primaryRnUserId({ organizationId: ORG_A, patientId: PATIENT_B }),
    ).toBeNull();
  });

  // ── the M13 fact loader ─────────────────────────────────────────────────────────────────────────
  it("reports actorIsRnCaseManager TRUE for the case manager on a review-pending row", async () => {
    const cg = await caregiverAttested(ORG_A, PATIENT_A);
    expect(cg.requiresRnReview).toBe(true);
    const facts = await backend.loadCaregiverReviewFacts(ORG_A, cg.id, USER_RN);
    expect(facts).toEqual({ requiresRnReview: true, actorIsRnCaseManager: true });
  });

  it("reports FALSE for the aide, the outsider, and an unassigned patient's row", async () => {
    const cg = await caregiverAttested(ORG_A, PATIENT_A);
    expect(
      (await backend.loadCaregiverReviewFacts(ORG_A, cg.id, USER_AIDE))?.actorIsRnCaseManager,
    ).toBe(false);
    expect(
      (await backend.loadCaregiverReviewFacts(ORG_A, cg.id, USER_OUTSIDER))?.actorIsRnCaseManager,
    ).toBe(false);

    const orphan = await caregiverAttested(ORG_A, PATIENT_UNASSIGNED);
    expect(
      (await backend.loadCaregiverReviewFacts(ORG_A, orphan.id, USER_RN))?.actorIsRnCaseManager,
    ).toBe(false);
  });

  it("returns null facts for an unknown administration id (fail-closed, not a fabricated row)", async () => {
    expect(
      await backend.loadCaregiverReviewFacts(
        ORG_A,
        "99999999-9999-4999-8999-999999999999",
        USER_RN,
      ),
    ).toBeNull();
  });

  // ── the composed predicate (what the two routes actually gate on) ────────────────────────────────
  it("caregiver_attested_review_required allows the case manager and refuses everyone else", async () => {
    const cg = await caregiverAttested(ORG_A, PATIENT_A);
    const predicate = predicates.caregiver_attested_review_required;
    expect(predicate).toBeDefined();
    expect(await predicate?.(ctx(ORG_A, USER_RN), { id: cg.id })).toBe(true);
    expect(await predicate?.(ctx(ORG_A, USER_AIDE), { id: cg.id })).toBe(false);
    expect(await predicate?.(ctx(ORG_A, USER_OUTSIDER), { id: cg.id })).toBe(false);
    // No row named → deny (the routes pass `:id` via requireAbac's default `request.params` target).
    expect(await predicate?.(ctx(ORG_A, USER_RN), {})).toBe(false);
  });

  it("refuses once the review is already cleared (requiresRnReview flips false on acknowledge)", async () => {
    const cg = await caregiverAttested(ORG_A, PATIENT_A);
    const predicate = predicates.caregiver_attested_review_required;
    expect(await predicate?.(ctx(ORG_A, USER_RN), { id: cg.id })).toBe(true);
    const ack = await backend.acknowledgeCaregiver(ORG_A, memberOf[`${ORG_A}:${USER_RN}`], cg.id);
    expect(ack.requiresRnReview).toBe(false);
    // Both operands matter: still the case manager, but there is no longer a review to clear.
    expect(await predicate?.(ctx(ORG_A, USER_RN), { id: cg.id })).toBe(false);
  });

  it("refuses another tenant's case manager on this tenant's row", async () => {
    const cg = await caregiverAttested(ORG_A, PATIENT_A);
    const predicate = predicates.caregiver_attested_review_required;
    // ORG_B context cannot even see the row (RLS) → null facts → deny.
    expect(await predicate?.(ctx(ORG_B, USER_RN_B), { id: cg.id })).toBe(false);
    // ORG_A context with ORG_B's clinician: the row resolves, the case manager does not match.
    expect(await predicate?.(ctx(ORG_A, USER_RN_B), { id: cg.id })).toBe(false);
  });
});
