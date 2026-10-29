/**
 * Over the 800-line soft ceiling on purpose: one table-driven matrix (8 stages x the adversarial cases) shares a single seeded fixture, so it stays together.
 *
 * S11 (Clinical Workflow Audit 2026-10-28, section 5) — cross-tenant, unauthorized-clinician, revoked-membership
 * and break-glass adversarial cases across EACH clinical stage, against real Postgres.
 *
 * Stages (one read + one write each, table-driven, through the REAL module route mounts):
 *   patient (M5) · admission (M6) · encounter (M8) · order (M11) · eMAR (M13) · HOPE (M10) · IDG (M14) · discharge (M6)
 *
 * What is real here, deliberately: every request is authenticated by a real Better Auth session cookie through the
 * production `createSessionAuthenticate` hook, the real session store + actor enrichment, the real DB RBAC
 * resolver (`wireModuleSeams` with a db), the real ABAC registry, the real Drizzle route services under
 * `withOrgContext`, and the real M3 break-glass routes/store. Everything runs as the NOBYPASSRLS `chartwarden_app`
 * role (`_live-app-role.ts` asserts it); the superuser connection only seeds and inspects.
 *
 * What it asserts, per stage:
 *   1. CONTROL      an authorised, in-scope clinician reaches the row (so every denial below is meaningful);
 *   2. CROSS-TENANT org A's clinician naming org B's id gets the SAME typed 404 as a never-existing id (no
 *                   existence leak) on the read and the write, and org B's row is byte-identical afterwards;
 *   3. UNAUTHORISED a same-org clinician without the permission gets 403 on read and write; row unchanged;
 *   4. REVOKED      revoking the membership refuses the very next read and write; deleting the session likewise;
 *   5. BREAK-GLASS  a clinician outside the caseload is refused (404, non-leaking), then admitted by an invoked
 *                   glass — which leaves `m3.breakglass.invoked` (actor/reason/patient) and a critical
 *                   `m3.breakglass.access` audit row; revoking/expiring the glass closes it again.
 * Plus: break-glass needs its permission AND a >=10-char justification AND a named patient; a glass is
 * org-scoped; a co-sign-required tenant's glass grants nothing until a DISTINCT co-signer approves; and an
 * auditor ENROLMENT-stage session reaches only the five enrolment routes (every clinical stage answers
 * AUDITOR_ENROLMENT_REQUIRED), while an ACTIVE auditor session is read-only.
 *
 * Seeded rows are synthetic: patients use invented names and no SSN/MBI; clinical rows are filled with a
 * schema-driven generic filler (NOT NULL columns only) under `session_replication_role = replica`.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:s11:adversarial-stages:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAuditorSessionIssuer,
  createDbActorEnrichmentReader,
  createDbAdminMembershipReader,
  createDbSessionContextStore,
  createDbSessionTimeoutEnforcer,
  createIdentityAuth,
  getIdentitySession,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer, createSessionAuthenticate, getSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { wireModuleSeams } from "../src/index";
import { createAuditorEnrolment } from "../src/modules/02-identity/auditor-enrolment";
import { createDbAuditorMagicLinkIssuer } from "../src/modules/02-identity/auditor-magic-link-store";
import { mountIdentityRoutes } from "../src/modules/02-identity/index";
import { registerAuditorEnrolmentRoutes } from "../src/modules/02-identity/routes/auditor-enrolment";
import { registerAuditorRedeemRoutes } from "../src/modules/02-identity/routes/auditor-redeem";
import { M3_OUTBOX_EVENTS, mountAuthorizationRoutes } from "../src/modules/03-authorization/index";
import { createDbAuditorAccessGrantor } from "../src/modules/03-authorization/index";
import { M5_OUTBOX_EVENTS, mountPatientRoutes } from "../src/modules/05-patient/index";
import { M6_OUTBOX_EVENTS, mountAdmissionRoutes } from "../src/modules/06-admission/index";
import { M8_OUTBOX_EVENTS, mountEncounterRoutes } from "../src/modules/08-encounters/index";
import { M10_OUTBOX_EVENTS, mountHopeRoutes } from "../src/modules/10-hope/index";
import { M11_OUTBOX_EVENTS, mountOrderRoutes } from "../src/modules/11-orders/index";
import { M13_OUTBOX_EVENTS, mountEmarRoutes } from "../src/modules/13-emar/index";
import { M14_OUTBOX_EVENTS, mountIdgRoutes } from "../src/modules/14-idg/index";
import { enrolFirstTime } from "./_auditor-enrol-helper";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;

const ORG_A = "11111111-1111-4111-8111-1111115a1101";
const ORG_B = "11111111-1111-4111-8111-1111115b1101";
const PE_A = "55555555-5555-4555-8555-5555555a1101";
const PE_B = "55555555-5555-4555-8555-5555555b1101";
const LOC_A = "66666666-6666-4666-8666-6666666a1101";
const LOC_B = "66666666-6666-4666-8666-6666666b1101";
/** A SECOND site in org A: the break-glass outsider works there, so site scope AND caseload both exclude the chart. */
const PE_A2 = "55555555-5555-4555-8555-5555555a1102";
const LOC_A2 = "66666666-6666-4666-8666-6666666a1102";
const CSRF = "s11-csrf-token-value";
const NEVER = "99999999-9999-4999-8999-999999999999";
const DAY = 24 * 3_600_000;

/** Org-wide oversight (reads every chart without a caseload row) vs an ordinary clinician vs a role holding nothing. */
const ORG_WIDE_ROLE = "medical_director";
const CLINICIAN_ROLE = "rn";
const NO_PERMS_ROLE = "chaplain";

interface Stage {
  readonly name: string;
  /** The table the stage's resource row lives in (seeded by the generic filler). */
  readonly table: string;
  readonly read: { url: (id: string) => string; perms: readonly string[] };
  readonly write: {
    method: "POST" | "PATCH" | "DELETE";
    url: (id: string) => string;
    body: Record<string, unknown>;
    perms: readonly string[];
  };
  /** Column that names the patient on the row (for break-glass targeting); null when the row IS the patient. */
  readonly patientColumn: string | null;
  /**
   * Does an invoked glass actually open this stage's read? Only the stages whose ABAC target carries `patientId`
   * (patient, order) consult the break-glass checker (`contract.ts` keys on `target.patientId`). The others stay
   * CLOSED under glass: fail-closed, but a clinician in an emergency cannot reach that part of the chart (S11 gap).
   */
  readonly glassOpens: boolean;
  /** A patient-keyed read for stages whose own read is not patient-scoped (IDG meeting -> the patient's IDG history). */
  readonly glassRead?: (patientId: string) => string;
  /** Discipline roles the CONTROL writer also needs (an ABAC discipline gate on top of the permission). */
  readonly writeActorRoles?: readonly string[];
  /** Extra column values the filler cannot guess (CHECKs, enum states the route cares about). */
  readonly overrides?: Record<string, unknown>;
}

const STAGES: readonly Stage[] = [
  {
    name: "patient",
    glassOpens: true,
    table: "patient",
    read: { url: (id) => `/api/v1/patients/${id}`, perms: ["patient.read"] },
    write: {
      method: "POST",
      url: (id) => `/api/v1/patients/${id}/addresses`,
      body: { line1: "1 Synthetic Way", city: "Testville", state: "NY", postalCode: "10001" },
      perms: ["patient.edit"],
    },
    patientColumn: null,
  },
  {
    name: "admission",
    glassOpens: false,
    table: "admission",
    read: { url: (id) => `/api/v1/admissions/${id}`, perms: ["admission.read"] },
    write: {
      method: "POST",
      url: (id) => `/api/v1/admissions/${id}/hold`,
      body: { reason: "synthetic hold reason", ifVersion: 1 },
      perms: ["admission.hold"],
    },
    patientColumn: "patient_id",
  },
  {
    name: "encounter",
    glassOpens: false,
    table: "encounter",
    read: { url: (id) => `/api/v1/encounters/${id}`, perms: ["encounter.read"] },
    write: {
      method: "POST",
      url: (id) => `/api/v1/encounters/${id}/void`,
      body: { reason: "synthetic void reason that is comfortably longer than forty characters" },
      perms: ["encounter.author", "encounter.administrative_override"],
    },
    patientColumn: "patient_id",
  },
  {
    name: "order",
    glassOpens: true,
    table: "order_record",
    read: { url: (id) => `/api/v1/orders/${id}`, perms: ["orders.read"] },
    write: {
      method: "POST",
      url: (id) => `/api/v1/orders/${id}/discontinue`,
      body: { reason: "clinical_judgement", effectiveAt: "2026-10-01T00:00:00.000Z" },
      perms: ["orders.discontinue"],
    },
    patientColumn: "patient_id",
  },
  {
    name: "emar",
    glassOpens: false,
    table: "administration_record",
    read: { url: (id) => `/api/v1/administrations/${id}`, perms: ["administration.read"] },
    write: {
      method: "POST",
      url: (id) => `/api/v1/administrations/${id}/void`,
      body: { reason: "synthetic void reason" },
      perms: ["administration.void"],
    },
    patientColumn: "patient_id",
  },
  {
    name: "hope",
    glassOpens: false,
    table: "hope_assessment",
    read: { url: (id) => `/api/v1/hope/assessments/${id}`, perms: ["hope.timepoint.read"] },
    write: {
      method: "PATCH",
      url: (id) => `/api/v1/hope/assessments/${id}/answers`,
      body: {},
      perms: ["hope.timepoint.write"],
    },
    patientColumn: "patient_id",
    writeActorRoles: ["rn"],
  },
  {
    name: "idg",
    glassOpens: false,
    table: "idg_meeting",
    read: { url: (id) => `/api/v1/idg/meetings/${id}`, perms: ["idg.read"] },
    write: {
      method: "POST",
      url: (id) => `/api/v1/idg/meetings/${id}/cancel`,
      body: { reason: "synthetic cancel reason" },
      perms: ["idg.schedule"],
    },
    patientColumn: null,
    glassRead: (patientId) => `/api/v1/patients/${patientId}/idg-history`,
  },
  {
    name: "discharge",
    glassOpens: false,
    table: "admission",
    read: {
      url: (id) => `/api/v1/admissions/${id}/discharge-details`,
      perms: ["admission.read"],
    },
    write: {
      method: "POST",
      url: (id) => `/api/v1/admissions/${id}/discharge`,
      body: { dischargeDate: "2026-10-01", narrative: "synthetic" },
      perms: ["discharge.create"],
    },
    patientColumn: "patient_id",
  },
];

/** Every permission any stage (or the break-glass console) needs, so the org-wide control user can do all of it. */
const ALL_STAGE_PERMS = [...new Set(STAGES.flatMap((s) => [...s.read.perms, ...s.write.perms]))];
const BREAKGLASS_PERMS = ["breakglass.invoke", "breakglass.cosign", "breakglass.read"];

interface Staff {
  readonly userId: string;
  readonly membershipId: string;
  readonly cookie: string;
  readonly org: string;
}

describe.skipIf(!DB_URL)("S11 adversarial cases across clinical stages — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let auth: ReturnType<typeof createIdentityAuth>;
  let seq = 0;
  const roleIds = new Map<string, string>();

  // ── plumbing ───────────────────────────────────────────────────────────────────────────────────────
  const cookieOf = (setCookie: string | string[] | undefined | null): string => {
    const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
    const hit = list
      .flatMap((c) => c.split(/,(?=\s*better-auth)/))
      .find((c) => c.trim().startsWith("better-auth.session_token="));
    if (!hit) throw new Error(`no session cookie in ${JSON.stringify(list)}`);
    return (hit.split(";")[0] as string).trim();
  };

  const http = (
    server: FastifyInstance,
    cookie: string | null,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: Record<string, unknown>,
  ): Promise<LightMyRequestResponse> =>
    server.inject({
      method,
      url,
      headers: cookie
        ? { cookie: `${cookie}; chartwarden_csrf=${CSRF}`, "x-csrf-token": CSRF }
        : { cookie: `chartwarden_csrf=${CSRF}`, "x-csrf-token": CSRF },
      ...(payload !== undefined ? { payload } : {}),
    });
  const call = (
    who: Staff | null,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: Record<string, unknown>,
  ) => http(app, who?.cookie ?? null, method, url, payload);

  const errCode = (res: LightMyRequestResponse): string | undefined => {
    const body = res.json() as { error?: { code?: string }; code?: string };
    return body.error?.code ?? body.code;
  };
  /** Body of a response with every uuid blanked: two refusals that differ only in the id are the same refusal. */
  const shape = (res: LightMyRequestResponse): string =>
    JSON.stringify(res.json()).replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      "<id>",
    );

  async function ensurePermissions(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      await admin.query(
        `INSERT INTO permission (key,resource,action,category) VALUES ($1,$2,'x','clinical') ON CONFLICT (key) DO NOTHING`,
        [key, key.split(".")[0]],
      );
    }
  }

  async function roleFor(org: string, key: string, perms: readonly string[]): Promise<string> {
    const cacheKey = `${org}:${key}:${perms.join(",")}`;
    const cached = roleIds.get(cacheKey);
    if (cached) return cached;
    await ensurePermissions(perms);
    const unique = `${key}`;
    const existing = await admin.query("SELECT id FROM role WHERE organization_id=$1 AND key=$2", [
      org,
      unique,
    ]);
    let id: string;
    if (existing.rowCount) {
      id = existing.rows[0].id;
    } else {
      id = (
        await admin.query(
          `INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,$2,$2,'clinical_staff',true) RETURNING id`,
          [org, unique],
        )
      ).rows[0].id;
    }
    for (const perm of perms) {
      await admin.query(
        `INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [org, id, perm],
      );
    }
    roleIds.set(cacheKey, id);
    return id;
  }

  /** A real Better Auth user with an ACTIVE membership + role in `org`, and a session bound to it. */
  async function staff(
    org: string,
    role: string,
    perms: readonly string[],
    pe: string = org === ORG_A ? PE_A : PE_B,
    loc: string = org === ORG_A ? LOC_A : LOC_B,
    extraRoles: readonly string[] = [],
  ): Promise<Staff> {
    const email = `s11-${++seq}-${randomUUID().slice(0, 8)}@s11.test`;
    const password = `Wx9$${randomUUID().replace(/-/g, "")}Qz!`;
    const res = (await auth.api.signUpEmail({
      body: { email, password, name: "S11 Synthetic" },
      asResponse: true,
    })) as Response;
    const cookie = cookieOf(res.headers.get("set-cookie"));
    const userId = (await admin.query('SELECT id FROM "user" WHERE email=$1', [email])).rows[0]
      .id as string;
    const membershipId = (
      await admin.query(
        `INSERT INTO membership (user_id,organization_id,status,default_provider_entity_id,default_location_ids)
         VALUES ($1,$2,'active',$3,$4) RETURNING id`,
        [userId, org, pe, JSON.stringify([loc])],
      )
    ).rows[0].id as string;
    const roleId = await roleFor(org, role, perms);
    await admin.query(
      "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
      [org, membershipId, roleId],
    );
    for (const extra of extraRoles) {
      await admin.query(
        "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
        [org, membershipId, await roleFor(org, extra, perms)],
      );
    }
    // Bound to the org, with a fresh second factor on file so step-up-gated writes reach their real guard.
    await admin.query(
      "UPDATE session SET active_organization_id=$2, last_step_up_at=now(), last_step_up_factor='totp' WHERE user_id=$1",
      [userId, org],
    );
    return { userId, membershipId, cookie, org };
  }

  // ── schema-driven generic row filler (NOT NULL columns only) ──────────────────────────────────────
  async function fillRow(table: string, values: Record<string, unknown>): Promise<string> {
    const cols = (
      await admin.query(
        `SELECT column_name, data_type, udt_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name=$1 AND is_nullable='NO' AND column_default IS NULL
            AND is_generated='NEVER' AND is_identity='NO'`,
        [table],
      )
    ).rows as { column_name: string; data_type: string; udt_name: string }[];
    const names: string[] = [];
    const exprs: string[] = [];
    const params: unknown[] = [];
    const add = (name: string, expr: string) => {
      names.push(`"${name}"`);
      exprs.push(expr);
    };
    for (const [name, value] of Object.entries(values)) {
      params.push(value);
      add(name, `$${params.length}`);
    }
    for (const c of cols) {
      if (name_in(values, c.column_name)) continue;
      if (c.data_type === "uuid") add(c.column_name, "gen_random_uuid()");
      else if (c.data_type === "USER-DEFINED") {
        const label = (
          await admin.query(
            `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname=$1 ORDER BY e.enumsortorder LIMIT 1`,
            [c.udt_name],
          )
        ).rows[0]?.enumlabel;
        add(c.column_name, label ? `'${label}'::"${c.udt_name}"` : "'s11'");
      } else if (/timestamp/.test(c.data_type)) add(c.column_name, "now()");
      else if (c.data_type === "date") add(c.column_name, "current_date");
      else if (/int|numeric|double|real/.test(c.data_type)) add(c.column_name, "1");
      else if (c.data_type === "boolean") add(c.column_name, "false");
      else if (/json/.test(c.data_type)) add(c.column_name, "'{}'::jsonb");
      else if (c.data_type === "bytea") add(c.column_name, "'\\x00'::bytea");
      else if (c.data_type === "ARRAY") add(c.column_name, "'{}'");
      else add(c.column_name, "'s11'");
    }
    const id = (values.id as string | undefined) ?? randomUUID();
    if (!("id" in values)) {
      params.push(id);
      names.push('"id"');
      exprs.push(`$${params.length}`);
    }
    await admin.query(
      `INSERT INTO "${table}" (${names.join(",")}) VALUES (${exprs.join(",")})`,
      params,
    );
    return id;
  }
  const name_in = (v: Record<string, unknown>, k: string) => k in v;

  const rowHash = async (table: string, id: string): Promise<string> => {
    const { rows } = await admin.query(`SELECT to_jsonb(t) AS j FROM "${table}" t WHERE id=$1`, [
      id,
    ]);
    return createHash("sha256")
      .update(JSON.stringify(rows[0]?.j ?? null))
      .digest("hex");
  };

  interface Seeded {
    readonly rowA: string;
    readonly rowB: string;
    readonly patientA: string;
    readonly patientB: string;
  }
  const seeded = new Map<string, Seeded>();

  async function seedPatient(org: string): Promise<string> {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status)
       VALUES ($1,$2,$3,'Synthia','Testpatient','1950-01-01','F','active')`,
      [id, org, `MRN-S11-${id.slice(0, 8)}`],
    );
    return id;
  }

  async function seedStage(stage: Stage): Promise<Seeded> {
    const make = async (org: string, pe: string, loc: string) => {
      const patientId = await seedPatient(org);
      if (stage.table === "patient") return { row: patientId, patientId };
      const base: Record<string, unknown> = {
        organization_id: org,
        provider_entity_id: pe,
        location_id: loc,
        ...(stage.patientColumn ? { [stage.patientColumn]: patientId } : {}),
        ...(stage.overrides ?? {}),
      };
      const cols = new Set(
        (
          await admin.query(
            "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1",
            [stage.table],
          )
        ).rows.map((r) => r.column_name as string),
      );
      const filtered = Object.fromEntries(Object.entries(base).filter(([k]) => cols.has(k)));
      return { row: await fillRow(stage.table, filtered), patientId };
    };
    const a = await make(ORG_A, PE_A, LOC_A);
    const b = await make(ORG_B, PE_B, LOC_B);
    return { rowA: a.row, rowB: b.row, patientA: a.patientId, patientB: b.patientId };
  }

  const isDenied = (status: number) => status === 401 || status === 403 || status === 404;

  // ── boot ───────────────────────────────────────────────────────────────────────────────────────────
  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= "test-secret-at-least-32-characters-long-xx";
    process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
    process.env.TWO_FACTOR_ENCRYPTION_KEY ??= "Y2ktMmZhLXRlc3Qta2V5LTAxMjM0NTY3ODlhYmNkZWY=";
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
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (stripVector)
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "vector".*$/m, "-- (vector stripped)");
      await admin.query(sql);
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,'s11-a','A','A','active'),($2,'s11-b','B','B','active')",
      [ORG_A, ORG_B],
    );
    for (const [org, pe, loc, npi] of [
      [ORG_A, PE_A, LOC_A, "1234567893"],
      [ORG_A, PE_A2, LOC_A2, "1000000004"],
      [ORG_B, PE_B, LOC_B, "1245319599"],
    ] as const) {
      await admin.query(
        `INSERT INTO provider_entity (id, organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,$2,$3,'S11 Hospice',$4,'x','12-31')`,
        [pe, org, `10${npi.slice(4, 8)}`, npi],
      );
      await admin.query(
        `INSERT INTO location (id, provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'Main','1 Synthetic Way','Testville','NY','10001','America/New_York')`,
        [loc, pe],
      );
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    // Prove the handle is the unprivileged role — a superuser would make every cross-tenant assertion vacuous.
    const probe = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await probe.connect();
    const who = await probe.query(
      "SELECT current_user, r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname=current_user",
    );
    await probe.end();
    expect(who.rows[0]).toMatchObject({
      current_user: "chartwarden_app",
      rolsuper: false,
      rolbypassrls: false,
    });

    auth = createIdentityAuth(handle.db as never);
    const catalog = buildBootOutboxCatalog([
      M3_OUTBOX_EVENTS,
      M5_OUTBOX_EVENTS,
      M6_OUTBOX_EVENTS,
      M8_OUTBOX_EVENTS,
      M10_OUTBOX_EVENTS,
      M11_OUTBOX_EVENTS,
      M13_OUTBOX_EVENTS,
      M14_OUTBOX_EVENTS,
    ]);
    const tx = buildTxOutboxPublisher(catalog);
    const bind = (callerModule: string) => ({
      publish: (txn: never, input: never) =>
        (tx as { publish: (t: never, i: unknown) => Promise<void> }).publish(txn, {
          ...(input as object),
          callerModule,
        }),
    });
    const sessionStore = createDbSessionContextStore(
      handle.db,
      createDbActorEnrichmentReader(handle.db),
    );
    const authenticate = createSessionAuthenticate({
      getSnapshot: (request) => getIdentitySession(auth, request.raw.headers),
      getResolver: () => getSeam("SessionContextResolver"),
      sessionTimeout: createDbSessionTimeoutEnforcer(handle.db),
    });
    app = buildServer({
      authenticate,
      db: handle.db,
      security: { rateLimitEnabled: false },
      registerModuleSeams: () =>
        wireModuleSeams({
          sessionContextStore: sessionStore,
          db: handle.db,
          outboxPublisher: tx,
        }),
      registerModuleRoutes: (instance) => {
        const db = handle.db;
        mountAuthorizationRoutes(instance, db, undefined, bind("m3") as never);
        mountIdentityRoutes(instance, db, createDbAdminMembershipReader(db), {});
        mountPatientRoutes(instance, db, bind("m5") as never, {} as never, {});
        mountAdmissionRoutes(instance, db, bind("m6") as never);
        mountEncounterRoutes(instance, db, bind("m8") as never);
        mountHopeRoutes(instance, db, bind("m10") as never);
        mountOrderRoutes(instance, db, bind("m11") as never);
        mountEmarRoutes(instance, db, bind("m13") as never);
        mountIdgRoutes(instance, db, bind("m14") as never);
        const access = createDbAuditorAccessGrantor();
        registerAuditorRedeemRoutes(instance, {
          redemption: { db, sessions: createAuditorSessionIssuer(auth), access },
        });
        registerAuditorEnrolmentRoutes(instance, {
          enrolment: createAuditorEnrolment({ db, access }),
        });
      },
    });
    await app.ready();
    // The generic filler writes parent-less rows (patient_id/admission_id carry no FK in most tables, but
    // provider-entity FKs and friends are satisfied above). Superuser only; the app role is unaffected.
    await admin.query("SET session_replication_role = replica");
    for (const stage of STAGES) seeded.set(stage.name, await seedStage(stage));
  }, 600_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  // ── table-driven stage cases ───────────────────────────────────────────────────────────────────────
  describe.each(STAGES.map((s) => [s.name, s] as const))("stage: %s", (_name, stage) => {
    const rows = () => seeded.get(stage.name) as Seeded;
    const perms = [...stage.read.perms, ...stage.write.perms];

    it("CONTROL: an authorised org-wide clinician reaches the row (read 200, write not auth-denied)", async () => {
      const director = await staff(
        ORG_A,
        ORG_WIDE_ROLE,
        ALL_STAGE_PERMS,
        PE_A,
        LOC_A,
        stage.writeActorRoles ?? [],
      );
      const read = await call(director, "GET", stage.read.url(rows().rowA));
      expect(read.statusCode, read.body).toBe(200);
      const write = await call(
        director,
        stage.write.method,
        stage.write.url(rows().rowA),
        stage.write.body,
      );
      expect(
        isDenied(write.statusCode),
        `control write was auth-denied: ${write.statusCode} ${write.body}`,
      ).toBe(false);
    });

    it("CROSS-TENANT: org B's id is a typed 404 identical to a never-existing id, read and write, row untouched", async () => {
      const director = await staff(ORG_A, ORG_WIDE_ROLE, ALL_STAGE_PERMS);
      const before = await rowHash(stage.table, rows().rowB);

      const foreignRead = await call(director, "GET", stage.read.url(rows().rowB));
      const missingRead = await call(director, "GET", stage.read.url(NEVER));
      expect([403, 404], foreignRead.body).toContain(foreignRead.statusCode);
      expect(foreignRead.statusCode).toBe(missingRead.statusCode);
      expect(shape(foreignRead)).toBe(shape(missingRead));

      const foreignWrite = await call(
        director,
        stage.write.method,
        stage.write.url(rows().rowB),
        stage.write.body,
      );
      const missingWrite = await call(
        director,
        stage.write.method,
        stage.write.url(NEVER),
        stage.write.body,
      );
      expect([403, 404], foreignWrite.body).toContain(foreignWrite.statusCode);
      expect(foreignWrite.statusCode).toBe(missingWrite.statusCode);
      expect(shape(foreignWrite)).toBe(shape(missingWrite));
      expect(await rowHash(stage.table, rows().rowB)).toBe(before);
    });

    it("UNAUTHORISED: a same-org clinician without the permission is 403 on read and write; row untouched", async () => {
      const chaplain = await staff(ORG_A, NO_PERMS_ROLE, []);
      const before = await rowHash(stage.table, rows().rowA);
      const read = await call(chaplain, "GET", stage.read.url(rows().rowA));
      expect(read.statusCode, read.body).toBe(403);
      const write = await call(
        chaplain,
        stage.write.method,
        stage.write.url(rows().rowA),
        stage.write.body,
      );
      expect(write.statusCode, write.body).toBe(403);
      expect(await rowHash(stage.table, rows().rowA)).toBe(before);
      // permission is per-key, not per-module: holding only the OTHER half is not enough either
      const readOnly = await staff(ORG_A, `${stage.name}-reader`, stage.read.perms);
      const crossWrite = await call(
        readOnly,
        stage.write.method,
        stage.write.url(rows().rowA),
        stage.write.body,
      );
      expect(crossWrite.statusCode, crossWrite.body).toBe(403);
    });

    /** Both halves of "refused": the read and the write answer 401/403 and the row is byte-identical. */
    const expectRefused = async (who: Staff, label: string) => {
      const before = await rowHash(stage.table, rows().rowA);
      const read = await call(who, "GET", stage.read.url(rows().rowA));
      expect([401, 403], `${label} read: ${read.body}`).toContain(read.statusCode);
      const write = await call(
        who,
        stage.write.method,
        stage.write.url(rows().rowA),
        stage.write.body,
      );
      expect([401, 403], `${label} write: ${write.body}`).toContain(write.statusCode);
      expect(await rowHash(stage.table, rows().rowA)).toBe(before);
    };

    it("REVOKED (real DELETE route): the member's session ends and the very next read and write are 401", async () => {
      const victim = await staff(ORG_A, ORG_WIDE_ROLE, ALL_STAGE_PERMS);
      expect((await call(victim, "GET", stage.read.url(rows().rowA))).statusCode).toBe(200);
      const hr = await staff(ORG_A, "hr_admin", ["member.manage"]);
      const del = await call(
        hr,
        "DELETE" as never,
        `/api/v1/orgs/${ORG_A}/members/${victim.membershipId}`,
      );
      expect(del.statusCode, del.body).toBe(200);
      await expectRefused(victim, "after DELETE member");
    });

    it("REVOKED (real DELETE route) ends only the sessions bound to THIS org; the user's session in another org survives", async () => {
      const victim = await staff(ORG_A, ORG_WIDE_ROLE, ALL_STAGE_PERMS);
      const otherOrgSessionId = randomUUID();
      await admin.query(
        `INSERT INTO session (id, user_id, active_organization_id, token, expires_at)
         VALUES ($1,$2,$3,$4, now() + interval '1 hour')`,
        [otherOrgSessionId, victim.userId, ORG_B, randomUUID()],
      );
      const hr = await staff(ORG_A, "hr_admin", ["member.manage"]);
      const del = await call(
        hr,
        "DELETE" as never,
        `/api/v1/orgs/${ORG_A}/members/${victim.membershipId}`,
      );
      expect(del.statusCode, del.body).toBe(200);
      const left = await admin.query(
        "SELECT id, active_organization_id FROM session WHERE user_id=$1",
        [victim.userId],
      );
      expect(left.rows).toEqual([{ id: otherOrgSessionId, active_organization_id: ORG_B }]);
      const trail = await admin.query(
        `SELECT actor_user_id FROM audit_event
          WHERE organization_id=$1 AND event_type='m2.membership.revoked' AND resource_id=$2`,
        [ORG_A, victim.membershipId],
      );
      expect(trail.rows, "the revoke leaves its audit row").toEqual([{ actor_user_id: hr.userId }]);
    });

    it("SUSPENDED (real PATCH route): a suspended member's live session is refused on the very next read and write", async () => {
      const victim = await staff(ORG_A, ORG_WIDE_ROLE, ALL_STAGE_PERMS);
      expect((await call(victim, "GET", stage.read.url(rows().rowA))).statusCode).toBe(200);
      const hr = await staff(ORG_A, "hr_admin", ["member.manage"]);
      const patch = await call(
        hr,
        "PATCH",
        `/api/v1/orgs/${ORG_A}/members/${victim.membershipId}`,
        { status: "suspended" },
      );
      expect(patch.statusCode, patch.body).toBe(200);
      await expectRefused(victim, "after PATCH suspend");
    });

    it("REVOKED (status flipped, permission cache WARM): the very next read and write are refused", async () => {
      const warm = await staff(ORG_A, ORG_WIDE_ROLE, ALL_STAGE_PERMS);
      expect((await call(warm, "GET", stage.read.url(rows().rowA))).statusCode).toBe(200);
      await admin.query("UPDATE membership SET status='revoked', revoked_at=now() WHERE id=$1", [
        warm.membershipId,
      ]);
      await expectRefused(warm, "warm cache, status flipped");
    });

    it("REVOKED (status flipped before any request, permission cache COLD): refused", async () => {
      const cold = await staff(ORG_A, ORG_WIDE_ROLE, ALL_STAGE_PERMS);
      await admin.query("UPDATE membership SET status='revoked', revoked_at=now() WHERE id=$1", [
        cold.membershipId,
      ]);
      await expectRefused(cold, "cold cache, status flipped");
    });

    it("REVOKED SESSION: deleting the session row makes the next read and write 401", async () => {
      const gone = await staff(ORG_A, ORG_WIDE_ROLE, ALL_STAGE_PERMS);
      expect((await call(gone, "GET", stage.read.url(rows().rowA))).statusCode).toBe(200);
      await admin.query("DELETE FROM session WHERE user_id=$1", [gone.userId]);
      const read = await call(gone, "GET", stage.read.url(rows().rowA));
      expect(read.statusCode, read.body).toBe(401);
      const write = await call(
        gone,
        stage.write.method,
        stage.write.url(rows().rowA),
        stage.write.body,
      );
      expect(write.statusCode, write.body).toBe(401);
    });

    it("SESSION BOUND TO A FOREIGN ORG: a user with no membership in org B cannot read org B by re-pointing the session", async () => {
      const intruder = await staff(ORG_A, ORG_WIDE_ROLE, ALL_STAGE_PERMS);
      await admin.query("UPDATE session SET active_organization_id=$2 WHERE user_id=$1", [
        intruder.userId,
        ORG_B,
      ]);
      const read = await call(intruder, "GET", stage.read.url(rows().rowB));
      expect([401, 403, 404], read.body).toContain(read.statusCode);
      expect(read.statusCode).not.toBe(200);
      const write = await call(
        intruder,
        stage.write.method,
        stage.write.url(rows().rowB),
        stage.write.body,
      );
      expect(isDenied(write.statusCode), write.body).toBe(true);
    });

    it("BREAK-GLASS: refused outside the caseload/site, admitted by an invoked glass with a critical audit trail, closed on revoke", async () => {
      const patientId = stage.table === "patient" ? rows().rowA : rows().patientA;
      const readUrl = stage.glassRead ? stage.glassRead(patientId) : stage.read.url(rows().rowA);
      const clinician = await staff(
        ORG_A,
        CLINICIAN_ROLE,
        [...perms, ...BREAKGLASS_PERMS],
        PE_A2,
        LOC_A2,
      );
      const outside = await call(clinician, "GET", readUrl);
      expect(outside.statusCode, outside.body).toBe(404);

      const reason = `synthetic emergency cover for ${stage.name}`;
      const invoke = await call(clinician, "POST", "/api/v1/breakglass", {
        reason,
        targetPatientId: patientId,
      });
      expect(invoke.statusCode, invoke.body).toBe(201);
      const glassId = invoke.json().breakGlassId as string;

      const inside = await call(clinician, "GET", readUrl);
      const ev = (
        await admin.query(
          "SELECT actor_user_id, reason, target_patient_id FROM break_glass_event WHERE id=$1",
          [glassId],
        )
      ).rows[0];
      expect(ev).toMatchObject({
        actor_user_id: clinician.userId,
        reason,
        target_patient_id: patientId,
      });
      const audit = (
        await admin.query(
          `SELECT event_type, actor_user_id, resource_id::text AS rid, context, after FROM audit_event
            WHERE organization_id=$1 AND actor_user_id=$2 AND event_type IN ('m3.breakglass.invoked','m3.breakglass.access')`,
          [ORG_A, clinician.userId],
        )
      ).rows;
      const types = audit.map((r) => r.event_type as string);
      expect(types).toContain("m3.breakglass.invoked");
      const invoked = audit.find((r) => r.event_type === "m3.breakglass.invoked");
      expect(invoked?.actor_user_id).toBe(clinician.userId);
      expect(invoked?.after).toMatchObject({ reason, targetPatientId: patientId });
      if (stage.glassOpens) {
        expect(inside.statusCode, inside.body).toBe(200);
        // every chart view under glass is its own critical audit row: actor, the patient, and the glass it rode
        const access = audit.find((r) => r.event_type === "m3.breakglass.access");
        expect(access?.actor_user_id).toBe(clinician.userId);
        expect(access?.rid).toBe(patientId);
        expect(access?.context).toMatchObject({ breakGlassEventId: glassId });
      } else {
        // KNOWN GAP (fail-closed): this stage never consults the glass. Flip glassOpens when it does.
        expect(inside.statusCode, inside.body).toBe(404);
        expect(types).not.toContain("m3.breakglass.access");
      }

      // closing it closes the door again
      const reviewer = await staff(ORG_A, "compliance_officer", BREAKGLASS_PERMS);
      const revoke = await call(reviewer, "POST", `/api/v1/breakglass/${glassId}/revoke`, {});
      expect(revoke.statusCode, revoke.body).toBe(200);
      // Only meaningful where the glass opened the door; a KNOWN-GAP stage was 404 before the revoke too.
      if (stage.glassOpens) {
        const after = await call(clinician, "GET", readUrl);
        expect(after.statusCode, after.body).toBe(404);
      }
    });

    it("AUDITOR: an enrolment-stage session cannot reach this stage's read or write (AUDITOR_ENROLMENT_REQUIRED)", async () => {
      const cookie = await auditorEnrolmentSession();
      const read = await http(app, cookie, "GET", stage.read.url(rows().rowA));
      expect(read.statusCode).toBe(403);
      expect(errCode(read)).toBe("AUDITOR_ENROLMENT_REQUIRED");
      const write = await http(
        app,
        cookie,
        stage.write.method,
        stage.write.url(rows().rowA),
        stage.write.body,
      );
      expect(write.statusCode).toBe(403);
      expect(errCode(write)).toBe("AUDITOR_ENROLMENT_REQUIRED");
    });
  });

  // ── auditor enrolment ──────────────────────────────────────────────────────────────────────────────
  async function auditorEnrolmentSession(org: string = ORG_A, active = false): Promise<string> {
    const start = new Date(Date.now() - 3_600_000);
    const end = new Date(Date.now() + 3 * DAY);
    const eng = (
      await admin.query(
        `INSERT INTO auditor_engagement (organization_id, engagement_type, auditor_agency, scope, status, start_at, end_at, reason)
         VALUES ($1,'cms_survey','CMS','{}'::jsonb,'active',$2,$3,'s11') RETURNING id`,
        [org, start, end],
      )
    ).rows[0].id as string;
    const { magicLinkToken } = await createDbAuditorMagicLinkIssuer(handle.db).issue({
      organizationId: org,
      engagementId: eng,
      identity: {
        name: "Ada Auditor",
        email: `aud-${++seq}-${randomUUID().slice(0, 6)}@survey.test`,
      },
      window: { start, end },
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auditors/redeem",
      payload: { organizationId: org, token: magicLinkToken },
    });
    expect(res.statusCode, res.body).toBe(200);
    const cookie = cookieOf(res.headers["set-cookie"]);
    if (active) await enrolFirstTime(app, cookie);
    return cookie;
  }

  describe("auditor sessions", () => {
    const ENROLMENT = "/api/v1/auditors/enrolment";
    it("an enrolment-stage session reaches ONLY the five enrolment routes; every other route (and any write) is refused", async () => {
      const cookie = await auditorEnrolmentSession();
      const reachable: [string, string, Record<string, unknown> | undefined][] = [
        ["GET", `${ENROLMENT}/state`, undefined],
        [
          "POST",
          `${ENROLMENT}/baa`,
          { termsVersion: "v", termsSha256: "0".repeat(64), acceptedName: "Ada" },
        ],
        ["POST", `${ENROLMENT}/totp/begin`, {}],
        ["POST", `${ENROLMENT}/totp/confirm`, { code: "123456" }],
        ["POST", `${ENROLMENT}/verify`, { totpCode: "123456" }],
      ];
      for (const [method, url, body] of reachable) {
        const res = await http(app, cookie, method as "GET" | "POST", url, body);
        expect(errCode(res), `${method} ${url}`).not.toBe("AUDITOR_ENROLMENT_REQUIRED");
      }
      const closed: [string, string][] = [
        ["GET", "/api/v1/patients"],
        ["GET", `/api/v1/patients/${seeded.get("patient")?.rowA}`],
        ["GET", "/api/v1/breakglass"],
        ["POST", "/api/v1/breakglass"],
        ["POST", `/api/v1/patients/${seeded.get("patient")?.rowA}/addresses`],
        ["GET", `${ENROLMENT}/not-a-route`],
      ];
      for (const [method, url] of closed) {
        const res = await http(
          app,
          cookie,
          method as "GET" | "POST",
          url,
          method === "POST" ? {} : undefined,
        );
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(errCode(res), `${method} ${url}`).toBe("AUDITOR_ENROLMENT_REQUIRED");
      }
    });

    it("an ACTIVE auditor session is read-only: every clinical write is AUDITOR_READ_ONLY and no clinical read is granted", async () => {
      const cookie = await auditorEnrolmentSession(ORG_A, true);
      for (const stage of STAGES) {
        const w = await http(
          app,
          cookie,
          stage.write.method,
          stage.write.url(seeded.get(stage.name)?.rowA as string),
          stage.write.body,
        );
        expect(w.statusCode, `${stage.name} write`).toBe(403);
        expect(errCode(w), `${stage.name} write`).toBe("AUDITOR_READ_ONLY");
        const r = await http(
          app,
          cookie,
          "GET",
          stage.read.url(seeded.get(stage.name)?.rowA as string),
        );
        expect(r.statusCode, `${stage.name} read: ${r.body}`).not.toBe(200);
        expect(isDenied(r.statusCode), `${stage.name} read`).toBe(true);
      }
    });

    it("an enrolment session is org-bound: redeemed in org A it cannot read org B's chart either", async () => {
      const cookie = await auditorEnrolmentSession(ORG_A);
      const res = await http(app, cookie, "GET", `/api/v1/patients/${seeded.get("patient")?.rowB}`);
      expect(res.statusCode).toBe(403);
    });
  });

  // ── break-glass contract ───────────────────────────────────────────────────────────────────────────
  describe("break-glass contract", () => {
    it("requires breakglass.invoke: a clinician without it is 403 and no glass or audit row exists", async () => {
      const patientId = seeded.get("patient")?.rowA as string;
      const nurse = await staff(ORG_A, "rn-no-glass", ["patient.read"]);
      const before = Number(
        (
          await admin.query(
            "SELECT count(*)::int n FROM break_glass_event WHERE actor_user_id=$1",
            [nurse.userId],
          )
        ).rows[0].n,
      );
      const res = await call(nurse, "POST", "/api/v1/breakglass", {
        reason: "synthetic emergency cover",
        targetPatientId: patientId,
      });
      expect(res.statusCode, res.body).toBe(403);
      const after = Number(
        (
          await admin.query(
            "SELECT count(*)::int n FROM break_glass_event WHERE actor_user_id=$1",
            [nurse.userId],
          )
        ).rows[0].n,
      );
      expect(after).toBe(before);
    });

    it("requires a justification (>=10 chars) and a named patient; nothing is written on a 422", async () => {
      const patientId = seeded.get("patient")?.rowA as string;
      const nurse = await staff(ORG_A, "rn-glass", BREAKGLASS_PERMS);
      for (const body of [
        { targetPatientId: patientId },
        { reason: "short", targetPatientId: patientId },
        { reason: "synthetic emergency cover" },
        { reason: "synthetic emergency cover", targetPatientId: patientId, cosignRequired: false },
      ]) {
        const res = await call(
          nurse,
          "POST",
          "/api/v1/breakglass",
          body as Record<string, unknown>,
        );
        expect(res.statusCode, JSON.stringify(body)).toBe(422);
      }
      const n = Number(
        (
          await admin.query(
            "SELECT count(*)::int n FROM break_glass_event WHERE actor_user_id=$1",
            [nurse.userId],
          )
        ).rows[0].n,
      );
      expect(n).toBe(0);
    });

    it("is org-scoped: a glass over org B's patient, invoked by org A's clinician, opens nothing in org B", async () => {
      const foreignPatient = seeded.get("patient")?.rowB as string;
      const nurse = await staff(ORG_A, CLINICIAN_ROLE, ["patient.read", ...BREAKGLASS_PERMS]);
      await call(nurse, "POST", "/api/v1/breakglass", {
        reason: "synthetic emergency cover",
        targetPatientId: foreignPatient,
      });
      const read = await call(nurse, "GET", `/api/v1/patients/${foreignPatient}`);
      expect(read.statusCode, read.body).toBe(404);
    });

    it("an expired glass grants nothing", async () => {
      const patientId = seeded.get("patient")?.rowA as string;
      const nurse = await staff(ORG_A, CLINICIAN_ROLE, ["patient.read", ...BREAKGLASS_PERMS]);
      const invoke = await call(nurse, "POST", "/api/v1/breakglass", {
        reason: "synthetic emergency cover",
        targetPatientId: patientId,
      });
      expect(invoke.statusCode, invoke.body).toBe(201);
      expect((await call(nurse, "GET", `/api/v1/patients/${patientId}`)).statusCode).toBe(200);
      await admin.query(
        "UPDATE break_glass_event SET expires_at = now() - interval '1 minute' WHERE id=$1",
        [invoke.json().breakGlassId],
      );
      expect((await call(nurse, "GET", `/api/v1/patients/${patientId}`)).statusCode).toBe(404);
    });

    it("a glass invoked by one clinician does not open the chart for a colleague", async () => {
      const patientId = seeded.get("patient")?.rowA as string;
      const invoker = await staff(ORG_A, CLINICIAN_ROLE, ["patient.read", ...BREAKGLASS_PERMS]);
      const colleague = await staff(ORG_A, CLINICIAN_ROLE, ["patient.read"]);
      expect(
        (
          await call(invoker, "POST", "/api/v1/breakglass", {
            reason: "synthetic emergency cover",
            targetPatientId: patientId,
          })
        ).statusCode,
      ).toBe(201);
      expect((await call(colleague, "GET", `/api/v1/patients/${patientId}`)).statusCode).toBe(404);
    });

    it("a glass covers ONLY its named patient, not the next chart", async () => {
      const invoker = await staff(ORG_A, CLINICIAN_ROLE, ["patient.read", ...BREAKGLASS_PERMS]);
      const named = await seedPatient(ORG_A);
      const other = await seedPatient(ORG_A);
      expect(
        (
          await call(invoker, "POST", "/api/v1/breakglass", {
            reason: "synthetic emergency cover",
            targetPatientId: named,
          })
        ).statusCode,
      ).toBe(201);
      expect((await call(invoker, "GET", `/api/v1/patients/${named}`)).statusCode).toBe(200);
      expect((await call(invoker, "GET", `/api/v1/patients/${other}`)).statusCode).toBe(404);
    });

    it("a revoked membership loses its glass immediately", async () => {
      const patientId = seeded.get("patient")?.rowA as string;
      const nurse = await staff(ORG_A, CLINICIAN_ROLE, ["patient.read", ...BREAKGLASS_PERMS]);
      expect(
        (
          await call(nurse, "POST", "/api/v1/breakglass", {
            reason: "synthetic emergency cover",
            targetPatientId: patientId,
          })
        ).statusCode,
      ).toBe(201);
      expect((await call(nurse, "GET", `/api/v1/patients/${patientId}`)).statusCode).toBe(200);
      await admin.query("UPDATE membership SET status='revoked', revoked_at=now() WHERE id=$1", [
        nurse.membershipId,
      ]);
      const res = await call(nurse, "GET", `/api/v1/patients/${patientId}`);
      expect([401, 403]).toContain(res.statusCode);
    });

    it("co-sign-required tenant: the glass is cosign_pending and grants NOTHING until a DISTINCT co-signer approves", async () => {
      const patientId = seeded.get("patient")?.rowA as string;
      const nurse = await staff(ORG_A, CLINICIAN_ROLE, ["patient.read", ...BREAKGLASS_PERMS]);
      await admin.query(
        `UPDATE organization SET settings = COALESCE(settings,'{}'::jsonb) || '{"breakglass_cosign_required": true}'::jsonb WHERE id=$1`,
        [ORG_A],
      );
      try {
        const invoke = await call(nurse, "POST", "/api/v1/breakglass", {
          reason: "synthetic emergency cover",
          targetPatientId: patientId,
        });
        expect(invoke.statusCode, invoke.body).toBe(201);
        expect(invoke.json().status).toBe("cosign_pending");
        const glassId = invoke.json().breakGlassId as string;
        expect((await call(nurse, "GET", `/api/v1/patients/${patientId}`)).statusCode).toBe(404);
        const self = await call(nurse, "POST", `/api/v1/breakglass/${glassId}/cosign`, {});
        expect(self.statusCode, self.body).toBe(409); // two-person control: the invoker cannot co-sign
        expect(errCode(self)).toBe("BREAKGLASS_SELF_COSIGN");
        expect((await call(nurse, "GET", `/api/v1/patients/${patientId}`)).statusCode).toBe(404);
        const other = await staff(ORG_A, "compliance_officer", BREAKGLASS_PERMS);
        const ok = await call(other, "POST", `/api/v1/breakglass/${glassId}/cosign`, {});
        expect(ok.statusCode, ok.body).toBe(200);
        expect((await call(nurse, "GET", `/api/v1/patients/${patientId}`)).statusCode).toBe(200);
      } finally {
        await admin.query(
          `UPDATE organization SET settings = settings - 'breakglass_cosign_required' WHERE id=$1`,
          [ORG_A],
        );
      }
    });
  });
});
