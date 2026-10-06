/**
 * F-035 (#95) — the FHIR gateway serves a REAL resource, to an authenticated partner, in one tenant only.
 *
 * The finding: `GET /fhir/r4/{resourceType}/{id}` returned `404 not-found` unconditionally — not "when
 * absent", always, including for a resource the tenant demonstrably held. Beneath that sat a worse one
 * nobody had logged: `POST /fhir/oauth2/token` answered `invalid_client` for every input, so no partner
 * could obtain a bearer at all and R4–R22 were unreachable by construction. And `resolveBearer` read
 * `fhir_client_session` with no org context, where the `app.org_id` policy predicate is NULL, so it
 * matched nothing for every token that would ever be presented.
 *
 * THIS SUITE IS LIVE BY NECESSITY. Every one of those three defects lives at the Postgres boundary:
 * RLS decides the bearer lookup, the two `SECURITY DEFINER` tenant resolvers (migration 0233) exist only
 * in the database, and the `fhir_read_disclosure` ledger's append-only posture is a GRANT. The in-memory
 * store answers all of it happily, which is why the inject suite passed throughout — and why it asserted
 * the unconditional 401 as correct behaviour.
 *
 * The suite drives the real HTTP surface end to end: mint a token at R3, present it at R4, and get a US
 * Core Patient back. Then the isolation proof — org A's bearer against org B's patient id.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m28:fhir-gateway:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createDbClient } from "@wardenx/db";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/index";
import {
  createDrizzlePatientReaderStore,
  registerPatientSeams,
} from "../src/modules/05-patient/index";
import {
  createDrizzleFhirGatewayStore,
  createDrizzleFhirPublishedSeamStore,
} from "../src/modules/28-fhir/index";
// The FHIR-spec surface only (R1-R22). The admin console needs the M3 permission + ABAC chain, which is
// not what this suite is about — `fhir-inject.test.ts` covers that end.
import { registerFhirR4Routes } from "../src/modules/28-fhir/routes/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-4111-8111-1111f0350001";
const ORG_B = "22222222-2222-4222-8222-2222f0350002";
const CLIENT_A = "33333333-3333-4333-8333-3333f0350003";
const CLIENT_B = "44444444-4444-4444-8444-4444f0350004";
const SECRET_A = "a".repeat(48);
const SECRET_B = "b".repeat(48);
const TOKEN_URL = "https://fhir.wardenx.test/fhir/oauth2/token";

describe.skipIf(!DB_URL)("F-035 M28 FHIR gateway — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let patientA = "";
  let patientB = "";
  /** Flipped per-test to prove the D3 egress gate actually gates. */
  let consentAllows = true;

  let baaActive = true;

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

  /** A registered, approved api-key client with one live credential. */
  async function seedClient(org: string, clientId: string, secret: string, name: string) {
    await admin.query(
      `INSERT INTO fhir_client
         (id,organization_id,name,type,allowed_scopes,tier,rate_limit_rps,baa_contract_reference,status)
       VALUES ($1,$2,$3,'api_key',$4::jsonb,'tier-2',10,'baa-live','active')`,
      [clientId, org, name, JSON.stringify(["system/Patient.read", "system/Encounter.read"])],
    );
    await admin.query(
      `INSERT INTO fhir_client_credential
         (organization_id,client_id,kind,secret_digest_sha256,fingerprint,status)
       VALUES ($1,$2,'api_key',$3,$4,'active')`,
      [
        org,
        clientId,
        createHash("sha256").update(secret, "utf8").digest("hex"),
        secret.slice(0, 8),
      ],
    );
  }

  async function mint(clientId: string, secret: string, scope = "system/Patient.read") {
    return app.inject({
      method: "POST",
      url: "/fhir/oauth2/token",
      payload: {
        grant_type: "client_credentials",
        scope,
        client_id: clientId,
        client_secret: secret,
      },
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
      `INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES
         ($1,'f035-a','Alpha Hospice LLC','Alpha Hospice','active'),
         ($2,'f035-b','Beta Hospice LLC','Beta Hospice','active')`,
      [ORG_A, ORG_B],
    );
    const pa = await admin.query(
      "INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status) VALUES ($1,'MRN-A-001','Ada','Alpha','1940-03-02','F','active') RETURNING id",
      [ORG_A],
    );
    const pb = await admin.query(
      "INSERT INTO patient (organization_id,mrn,legal_first_name,legal_last_name,dob,sex_assigned_at_birth,status) VALUES ($1,'MRN-B-001','Bo','Beta','1938-11-09','M','active') RETURNING id",
      [ORG_B],
    );
    patientA = pa.rows[0].id;
    patientB = pb.rows[0].id;
    await seedClient(ORG_A, CLIENT_A, SECRET_A, "Alpha Partner");
    await seedClient(ORG_B, CLIENT_B, SECRET_B, "Beta Partner");

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // The gateway reads through the M1 seam registry, so the suite binds the real M5 readers over a
    // real database — the point being that the projection is composed from another module's data, not
    // from anything M28 owns.
    __resetSeamsForTest();
    registerPatientSeams({
      db: handle.db,
      readerStore: createDrizzlePatientReaderStore(handle.db),
    });
    // M39's evaluator, stubbed so the D3 egress gate can be driven both ways. Everything else about
    // the gate is real: the projection genuinely consults it per resource before serving.
    registerSeam("ConsentEvaluator", {
      async evaluateForDisclosure() {
        return { allowed: consentAllows, redactSudContent: false };
      },
    } as never);

    app = Fastify();
    registerFhirR4Routes(app, {
      store: createDrizzleFhirGatewayStore(handle.db),
      tokenEndpointUrl: TOKEN_URL,
      // GAP-083 — the BAA gate is fail-closed when unbound, so the suite binds a drivable one.
      baa: { isBaaActive: async () => baaActive },
    });
    await app.ready();
  }, 240_000);

  afterAll(async () => {
    await app?.close();
    await handle?.close();
    await admin?.end();
  });

  beforeEach(() => {
    consentAllows = true;
    baaActive = true;
  });

  it("the two tenant resolvers answer the owning org, and null for an unknown id", async () => {
    // These are the whole reason the surface can work without a BYPASSRLS credential: one unguessable
    // uuid in, one org uuid out, nothing else. Read as `wardenx_app`, which is the role that calls them.
    const asApp = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await asApp.connect();
    const client = await asApp.query("SELECT fhir_resolve_client_org($1) AS org", [CLIENT_A]);
    expect(client.rows[0].org).toBe(ORG_A);
    const unknown = await asApp.query("SELECT fhir_resolve_client_org($1) AS org", [
      "99999999-9999-4999-8999-999999999999",
    ]);
    expect(unknown.rows[0].org).toBeNull();
    await asApp.end();
  });

  it("mints a bearer at R3 and reads a REAL Patient with it at R4", async () => {
    // The acceptance criterion, end to end. Before F-035 the first call could not succeed for any
    // input and the second returned 404 for every id in existence.
    const minted = await mint(CLIENT_A, SECRET_A);
    expect(minted.statusCode).toBe(200);
    const token = minted.json().access_token as string;

    const read = await app.inject({
      method: "GET",
      url: `/fhir/r4/Patient/${patientA}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(200);
    const resource = read.json();
    expect(resource.resourceType).toBe("Patient");
    expect(resource.id).toBe(patientA);
    expect(resource.name[0].family).toBe("Alpha");
    expect(resource.birthDate).toBe("1940-03-02");
    expect(resource.gender).toBe("female");
    // The MRN rides in the tenant's OWN identifier namespace (D9), never a shared one.
    expect(resource.identifier[0].value).toBe("MRN-A-001");
    expect(resource.identifier[0].system).toContain(ORG_A);
  });

  it("REFUSES the other tenant's patient to a validly-authenticated bearer", async () => {
    // The isolation proof. The bearer is real, the scope is held, the patient id exists — and it is in
    // another org, so RLS makes the read return nothing and the gateway answers not-found.
    const minted = await mint(CLIENT_A, SECRET_A);
    const token = minted.json().access_token as string;
    const crossTenant = await app.inject({
      method: "GET",
      url: `/fhir/r4/Patient/${patientB}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(crossTenant.statusCode).toBe(404);

    // And the converse, so this is isolation rather than one broken direction.
    const mintedB = await mint(CLIENT_B, SECRET_B);
    const tokenB = mintedB.json().access_token as string;
    const ownTenant = await app.inject({
      method: "GET",
      url: `/fhir/r4/Patient/${patientB}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(ownTenant.statusCode).toBe(200);
    expect(ownTenant.json().name[0].family).toBe("Beta");
  });

  it("writes a §164.528 accounting row that only the disclosing tenant can see", async () => {
    await admin.query("DELETE FROM fhir_read_disclosure");
    const minted = await mint(CLIENT_A, SECRET_A);
    const token = minted.json().access_token as string;
    const read = await app.inject({
      method: "GET",
      url: `/fhir/r4/Patient/${patientA}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(200);

    const rows = await admin.query(
      "SELECT organization_id, fhir_client_id, resource_type, patient_id, result_count FROM fhir_read_disclosure",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      organization_id: ORG_A,
      fhir_client_id: CLIENT_A,
      resource_type: "Patient",
      patient_id: patientA,
      result_count: 1,
    });

    // The M30 §164.528 scorecard reads the same ledger through M28's published seam. It used to return
    // a hard-coded zero, which was true only while the gateway served nothing.
    const seamStore = createDrizzleFhirPublishedSeamStore(handle.db);
    const quarter = `${new Date().getUTCFullYear()}-Q${Math.floor(new Date().getUTCMonth() / 3) + 1}`;
    const alpha = await seamStore.disclosureMetricsForOrg({ organizationId: ORG_A, quarter });
    const beta = await seamStore.disclosureMetricsForOrg({ organizationId: ORG_B, quarter });
    expect(alpha.totalDisclosures).toBe(1);
    expect(alpha.byClient[0]?.clientName).toBe("Alpha Partner");
    // Beta disclosed nothing. Under RLS it cannot even see that Alpha did.
    expect(beta.totalDisclosures).toBe(0);
  });

  it("the ledger is append-only to the application role: no UPDATE, no DELETE", async () => {
    // Append-only by GRANT, not by convention — the rows ARE the §164.528 evidence, so the code that
    // writes them must not be able to edit them away.
    const asApp = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await asApp.connect();
    await asApp.query(`SELECT set_config('app.org_id', '${ORG_A}', false)`);
    await expect(asApp.query("UPDATE fhir_read_disclosure SET result_count = 99")).rejects.toThrow(
      /permission denied/i,
    );
    await expect(asApp.query("DELETE FROM fhir_read_disclosure")).rejects.toThrow(
      /permission denied/i,
    );
    await asApp.end();
  });

  it("the D3 consent gate filters the resource, and a filtered read is NOT accounted for", async () => {
    // A read that disclosed nothing must not appear in an accounting, and the 404 must be
    // indistinguishable from absence — telling a recipient "this exists but you may not see it" is
    // itself a disclosure of the record's existence.
    await admin.query("DELETE FROM fhir_read_disclosure");
    consentAllows = false;
    const minted = await mint(CLIENT_A, SECRET_A);
    const token = minted.json().access_token as string;
    const read = await app.inject({
      method: "GET",
      url: `/fhir/r4/Patient/${patientA}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.statusCode).toBe(404);
    const rows = await admin.query("SELECT id FROM fhir_read_disclosure");
    expect(rows.rows).toHaveLength(0);
  });

  it("a revoked client's live bearer stops working on its very next request (§2.4)", async () => {
    const minted = await mint(CLIENT_A, SECRET_A);
    const token = minted.json().access_token as string;
    const before = await app.inject({
      method: "GET",
      url: `/fhir/r4/Patient/${patientA}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);

    // The cascade stamps `revoked_at` on every live session the instant the client is cut off, which is
    // why expiry alone is not the whole gate: this token is still well inside its 15-minute TTL.
    await admin.query("UPDATE fhir_client SET status='revoked' WHERE id=$1", [CLIENT_A]);
    await admin.query("UPDATE fhir_client_session SET revoked_at=now() WHERE client_id=$1", [
      CLIENT_A,
    ]);
    const after = await app.inject({
      method: "GET",
      url: `/fhir/r4/Patient/${patientA}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
    await admin.query("UPDATE fhir_client SET status='active' WHERE id=$1", [CLIENT_A]);
  });

  it("GAP-083: an IP outside the allowlist gets 401 at mint and on read; a lapsed BAA gets 401; exceeding the rate gets 429", async () => {
    // Inject peers are 127.0.0.1, so an allowlist that excludes it must refuse at the mint.
    await admin.query("UPDATE fhir_client SET ip_allowlist='[\"10.0.0.0/8\"]'::jsonb WHERE id=$1", [
      CLIENT_A,
    ]);
    expect((await mint(CLIENT_A, SECRET_A)).statusCode).toBe(401);
    await admin.query("UPDATE fhir_client SET ip_allowlist='[]'::jsonb WHERE id=$1", [CLIENT_A]);

    const token = (await mint(CLIENT_A, SECRET_A)).json().access_token as string;
    const read = () =>
      app.inject({
        method: "GET",
        url: `/fhir/r4/Patient/${patientA}`,
        headers: { authorization: `Bearer ${token}` },
      });
    await admin.query("UPDATE fhir_client SET ip_allowlist='[\"10.0.0.0/8\"]'::jsonb WHERE id=$1", [
      CLIENT_A,
    ]);
    expect((await read()).statusCode).toBe(401);
    await admin.query("UPDATE fhir_client SET ip_allowlist='[]'::jsonb WHERE id=$1", [CLIENT_A]);

    baaActive = false;
    expect((await read()).statusCode).toBe(401);
    baaActive = true;

    await admin.query("UPDATE fhir_client SET rate_limit_rps=1 WHERE id=$1", [CLIENT_A]);
    const burst = await Promise.all([read(), read(), read()]);
    const throttled = burst.find((r) => r.statusCode === 429);
    expect(throttled).toBeDefined();
    expect(Number(throttled?.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    await admin.query("UPDATE fhir_client SET rate_limit_rps=10 WHERE id=$1", [CLIENT_A]);
    // The bucket is shared by the later cases (same client id, and Valkey-backed when REDIS_URL is set): let
    // the drained one-token bucket refill at the restored 10 rps so they are not throttled by this case.
    await new Promise((resolve) => setTimeout(resolve, 1100));
  });

  it("advertises exactly what it serves, and refuses what it does not as not-supported", async () => {
    // The conformance statement is anonymous and is the first thing a partner's tooling reads. It used
    // to claim `read` + `search-type` on twelve resource types, none of which worked.
    const metadata = await app.inject({ method: "GET", url: "/fhir/r4/metadata" });
    expect(metadata.statusCode).toBe(200);
    const resources = metadata.json().rest[0].resource as {
      type: string;
      interaction: { code: string }[];
    }[];
    const advertised = Object.fromEntries(
      resources.map((r) => [r.type, r.interaction.map((i) => i.code).sort()]),
    );
    expect(advertised.Patient).toEqual(["read", "search-type"]);
    // Encounter is search-only, and the statement says so rather than promising a read with no data path.
    expect(advertised.Encounter).toEqual(["search-type"]);
    expect(advertised.Condition).toBeUndefined();

    const minted = await mint(CLIENT_A, SECRET_A, "system/Patient.read system/Encounter.read");
    const token = minted.json().access_token as string;
    const encounterRead = await app.inject({
      method: "GET",
      url: "/fhir/r4/Encounter/00000000-0000-4000-8000-000000000000",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(encounterRead.statusCode).toBe(404);
    expect(encounterRead.json().issue[0].code).toBe("not-supported");
  });

  it("resolves a patient by MRN, which is how a partner gets an id to scope with", async () => {
    const minted = await mint(CLIENT_A, SECRET_A);
    const token = minted.json().access_token as string;
    const search = await app.inject({
      method: "GET",
      url: "/fhir/r4/Patient?identifier=MRN-A-001",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().total).toBe(1);
    expect(search.json().entry[0].resource.id).toBe(patientA);

    // The other tenant's MRN is not found here, even though the string exists in the database.
    const foreign = await app.inject({
      method: "GET",
      url: "/fhir/r4/Patient?identifier=MRN-B-001",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(foreign.json().total).toBe(0);
  });
});
