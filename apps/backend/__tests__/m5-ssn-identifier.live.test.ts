/**
 * GAP-010 — the envelope-encrypted SSN / state-id writer, the blind index and the matcher feed, against REAL Postgres
 * as the NOBYPASSRLS `chartwarden_app` role, over a REAL M34 tenant key ring (platform KEK -> wrapped DEK -> provider),
 * with the REAL catalog-validating outbox publisher. Nothing here is mocked below the HTTP layer; the route gates
 * (permission / step-up / chart scope) are proved in the unit suites (`m5-lifecycle-routes`, `patient-routes`).
 *
 * What a plausible-looking implementation would fail:
 *   • the SSN reaching ANY table in the clear: the identifier row, audit_event (before/after/context), outbox_event;
 *   • the same SSN + DOB admitted twice (matching without decrypting) and the block being invisible to compliance;
 *   • a DEK rotation breaking either the reveal of an old row or the match against it (multi-version probe);
 *   • a ciphertext copied into another tenant's row opening there;
 *   • the cryptographic shred leaving a reveal that works, or the eraser UPDATE tripping the new CHECK;
 *   • a reveal that returns the value when its audit row cannot be written;
 *   • the migration's role backfill granting a role it should not (clinical roles), or twice.
 *
 * Run against a PRIVATE container, never the shared cluster (it DROPs ROLE chartwarden_app):
 *   docker run -d --name gapc-C1-ssn-pg -p 55600:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg18
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55600/postgres \
 *     bun run test:m5:ssn-identifier:live
 */
import { Buffer } from "node:buffer";
import { createHmac, hkdfSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SSN_DEFAULT_GRANTS } from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { __resetModule34SeamsForTest } from "@chartwarden/saas-tenant-platform";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  ACTIVE_KEK_ENV,
  createPlatformKekAdapter,
  loadPlatformKekRing,
} from "../src/bootstrap/tenant-kek";
import { m34PlatformBypassAuditor } from "../src/index";
import {
  IdentifierCipherIntegrityError,
  IdentifierCipherUnboundError,
  createPatientIdentifierCipher,
  lazyIdentifierKeys,
} from "../src/modules/05-patient/identifiers/identifier-cipher";
import {
  M5_OUTBOX_EVENTS,
  createDrizzlePatientEraseStore,
  createDrizzlePatientReaderStore,
  createPatientReader,
} from "../src/modules/05-patient/index";
import { createDbPatientLifecyclePort } from "../src/modules/05-patient/patient-lifecycle-db";
import { createDbPatientRouteService } from "../src/modules/05-patient/patient-route-service-db";
import {
  getTenantKeyProvider,
  registerLiveM34Seams,
  validateModule34Seams,
} from "../src/modules/34-saas-tenant-platform/index";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "wardenx_report_writer",
  "chartwarden_destruction",
  "tenant_platform_writer",
];
const ORG_A = "aaaaaaaa-0000-4000-8000-0000000c1a01";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000c1b02";
const STAFF = "d0000000-0000-4000-8000-0000000c1001";
const APPROVER = "33333333-3333-4333-8333-3333333c1053";
const KEK = `kek-1:${Buffer.alloc(32, 0x11).toString("base64")}`;

const SSN = "123-45-6789";
const SSN_DIGITS = "123456789";
const OTHER_SSN = "987-65-4321";
const DOB = "1950-01-01";
const JANE = { lastName: "Doe", firstName: "Jane", dob: DOB, administrativeSex: "female" };

describe.skipIf(!DB_URL)("GAP-010 M5 SSN envelope + blind index — LIVE Postgres", () => {
  let admin: Client;
  let appHandle: ReturnType<typeof createDbClient>;
  let platformHandle: ReturnType<typeof createDbClient>;
  let destructionHandle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbPatientRouteService>;
  let lifecycle: ReturnType<typeof createDbPatientLifecyclePort>;
  const accountOf: Record<string, string> = {};
  const kek = () => {
    const ring = loadPlatformKekRing({ [ACTIVE_KEK_ENV]: KEK } as NodeJS.ProcessEnv);
    if (!ring) throw new Error("expected a KEK ring");
    return createPlatformKekAdapter(ring);
  };
  const urlAs = (role: string, password: string): string => {
    const u = new URL(DB_URL as string);
    u.username = role;
    u.password = password;
    return u.toString();
  };

  async function provisionKeyRing(org: string): Promise<void> {
    const wrapped = await kek().mintAndWrapDek({ organizationId: org });
    await platformHandle.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('app.dek_kek_wrapped_ciphertext_b64', ${wrapped.wrappedCiphertextB64}, true), set_config('app.dek_kek_id', ${wrapped.kekId}, true)`,
      );
      await tx.execute(sql`SELECT m34_provision_tenant_key_ring(${accountOf[org]})`);
    });
  }

  /** Rotate the org's DEK the way the key ring stores it: the current wrapped DEK moves to prior_dek_versions. */
  async function rotateDek(org: string): Promise<string> {
    const cur = (
      await admin.query(
        `SELECT current_dek_version AS v, encode(current_dek_kek_wrapped_ciphertext,'base64') AS w,
                current_dek_kek_id AS k, prior_dek_versions AS p
           FROM tenant_key_ring WHERE organization_id=$1`,
        [org],
      )
    ).rows[0] as { v: string; w: string; k: string; p: unknown[] };
    const next = await kek().mintAndWrapDek({ organizationId: org });
    const nextVersion = `v${Number(cur.v.slice(1)) + 1}`;
    const prior = [
      ...cur.p,
      {
        version: cur.v,
        kekWrappedCiphertext: cur.w,
        kekId: cur.k,
        rotatedAt: "2026-10-08T00:00:00.000Z",
      },
    ];
    await admin.query(
      `UPDATE tenant_key_ring
          SET current_dek_version=$1, current_dek_kek_wrapped_ciphertext=decode($2,'base64'),
              current_dek_kek_id=$3, prior_dek_versions=$4::jsonb
        WHERE organization_id=$5`,
      [nextVersion, next.wrappedCiphertextB64, next.kekId, JSON.stringify(prior), org],
    );
    return nextVersion;
  }

  const patientCount = async (org: string): Promise<number> =>
    Number(
      (await admin.query("SELECT count(*)::int AS n FROM patient WHERE organization_id=$1", [org]))
        .rows[0].n,
    );
  const identifierRow = async (patientId: string, kind = "ssn") =>
    (
      await admin.query(
        `SELECT id, value, value_encrypted, value_last4, value_blind_index, value_dek_version, effective_to
           FROM patient_identifier WHERE patient_id=$1 AND kind=$2 ORDER BY created_at DESC`,
        [patientId, kind],
      )
    ).rows;
  const admitted = (out: { outcome: string }): string => {
    expect(["created", "soft_review"]).toContain(out.outcome);
    return (out as unknown as { patientId: string }).patientId;
  };

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
    for (const [org, slug] of [
      [ORG_A, "c1ssn-a"],
      [ORG_B, "c1ssn-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [org, slug],
      );
      accountOf[org] = (
        await admin.query(
          `INSERT INTO tenant_account (organization_id, legal_business_name, billing_contact_email, breach_notification_email)
           VALUES ($1,$2,'billing@c1.example','breach@c1.example') RETURNING id`,
          [org, `${slug} Hospice LLC`],
        )
      ).rows[0].id as string;
    }
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [STAFF, "s@c1ssn.test"]);
    for (const org of [ORG_A, ORG_B]) {
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')",
        [STAFF, org],
      );
    }
    appHandle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    await admin.query("ALTER ROLE chartwarden_admin LOGIN BYPASSRLS PASSWORD 'c1_platform'");
    platformHandle = createDbClient({
      connectionString: urlAs("chartwarden_admin", "c1_platform"),
    });
    await admin.query("ALTER ROLE chartwarden_destruction LOGIN PASSWORD 'c1_destroy'");
    destructionHandle = createDbClient({
      connectionString: urlAs("chartwarden_destruction", "c1_destroy"),
    });
    await provisionKeyRing(ORG_A);
    await provisionKeyRing(ORG_B);
    __resetModule34SeamsForTest();
    registerLiveM34Seams({
      db: appHandle.db,
      auditBypass: m34PlatformBypassAuditor,
      kekUnwrap: kek(),
      keyRingDb: platformHandle.db,
    });
    validateModule34Seams();

    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M5_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: Parameters<typeof txPublisher.publish>[0], input: never) =>
        txPublisher.publish(tx, { ...(input as object), callerModule: "m5" } as never),
    };
    const identifierCipher = createPatientIdentifierCipher(
      lazyIdentifierKeys(getTenantKeyProvider),
    );
    service = createDbPatientRouteService(appHandle.db, outbox as never, { identifierCipher });
    lifecycle = createDbPatientLifecyclePort(
      appHandle.db,
      outbox as never,
      undefined,
      identifierCipher,
    );
  }, 300_000);

  afterAll(async () => {
    await appHandle?.close();
    await platformHandle?.close();
    await destructionHandle?.close();
    if (admin) await admin.end();
    __resetModule34SeamsForTest();
  });

  // ── 1. admit stores the envelope, never the digits ─────────────────────────────────────────────────
  let janeId = "";
  it("admit with an SSN stores value NULL + ciphertext + last4 + blind index + DEK version", async () => {
    janeId = admitted(await service.admit(ORG_A, { ...JANE, ssn: SSN }, STAFF));
    const [row] = await identifierRow(janeId);
    expect(row.value).toBeNull();
    expect((row.value_encrypted as Buffer).length).toBeGreaterThan(30);
    expect(row.value_last4).toBe("6789");
    expect((row.value_blind_index as Buffer).length).toBe(32);
    expect(row.value_dek_version).toBe("v1");
    expect(row.effective_to).toBeNull();
    // the raw ciphertext bytes do not contain the digits, in any encoding
    const raw = row.value_encrypted as Buffer;
    expect(raw.toString("latin1")).not.toContain(SSN_DIGITS);
    expect(raw.toString("hex")).not.toContain(Buffer.from(SSN_DIGITS).toString("hex"));
  });

  it("the SSN appears in NO audit_event row and NO outbox_event payload (the trigger scrub is the control)", async () => {
    const [row] = await identifierRow(janeId);
    const audit = await admin.query(
      `SELECT before, after, context FROM audit_event
        WHERE resource_kind='patient_identifier' AND resource_id=$1`,
      [row.id],
    );
    expect(audit.rowCount).toBeGreaterThan(0);
    const text = JSON.stringify(audit.rows).toLowerCase();
    expect(text).not.toContain(SSN_DIGITS);
    expect(text).not.toContain(SSN);
    expect(text).not.toContain((row.value_encrypted as Buffer).toString("hex"));
    expect(text).not.toContain((row.value_blind_index as Buffer).toString("hex"));
    for (const col of [
      "value_encrypted",
      "value_last4",
      "value_blind_index",
      "value_dek_version",
    ]) {
      const leaked = await admin.query(
        `SELECT count(*)::int AS n FROM audit_event
          WHERE resource_id=$1 AND after ? $2 AND after->>$2 <> '<changed>'`,
        [row.id, col],
      );
      expect(leaked.rows[0].n, `after.${col} must be scrubbed`).toBe(0);
    }
    const everywhere = await admin.query(
      `SELECT (SELECT count(*)::int FROM audit_event WHERE to_jsonb(audit_event)::text ~ '123-?45-?6789') AS audit,
              (SELECT count(*)::int FROM outbox_event WHERE to_jsonb(outbox_event)::text ~ '123-?45-?6789') AS outbox`,
    );
    expect(everywhere.rows[0]).toEqual({ audit: 0, outbox: 0 });
    const events = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at",
      [janeId],
    );
    expect(events.rows.map((r) => r.event_type)).toContain("m5.patient.created");
  });

  // ── 2. matching without decrypting ─────────────────────────────────────────────────────────────────
  it("a second admit with the same SSN + DOB (different name, no MBI) is a hard block ssn_dob, creates nothing, and is audited", async () => {
    const before = await patientCount(ORG_A);
    const out = await service.admit(
      ORG_A,
      {
        lastName: "Smith",
        firstName: "Pat",
        dob: DOB,
        administrativeSex: "female",
        ssn: "123456789",
      },
      STAFF,
    );
    expect(out).toMatchObject({
      outcome: "hard_block",
      existingPatientId: janeId,
      matchedOn: "ssn_dob",
    });
    expect(await patientCount(ORG_A)).toBe(before);
    const blocks = await admin.query(
      `SELECT outcome, severity, context FROM audit_event
        WHERE event_type='patient.create_blocked_ssn_dob' AND resource_id=$1`,
      [janeId],
    );
    expect(blocks.rows).toHaveLength(1);
    expect(blocks.rows[0]).toMatchObject({ outcome: "denied", severity: "warn" });
    expect(JSON.stringify(blocks.rows[0].context)).not.toContain(SSN_DIGITS);
  });

  it("same SSN with a DIFFERENT DOB creates (rule 2 needs both); same name+DOB with a different SSN is not an SSN hit", async () => {
    const diffDob = await service.admit(
      ORG_A,
      {
        lastName: "Other",
        firstName: "Sam",
        dob: "1961-02-02",
        administrativeSex: "male",
        ssn: SSN,
      },
      STAFF,
    );
    expect(diffDob.outcome).toBe("created");
    const diffSsn = await service.admit(ORG_A, { ...JANE, ssn: OTHER_SSN }, STAFF);
    expect(diffSsn).not.toMatchObject({ matchedOn: "ssn_dob" });
    expect(["created", "soft_review"]).toContain(diffSsn.outcome);
  });

  it("an impossible SSN is a 422 that never echoes it, before anything is written", async () => {
    const before = await patientCount(ORG_A);
    const err = await service
      .admit(ORG_A, { ...JANE, lastName: "Bad", ssn: "000-12-3456" }, STAFF)
      .catch((e: unknown) => e as { statusCode?: number; message: string });
    expect((err as { statusCode?: number }).statusCode).toBe(422);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err as object))).not.toContain("000-12");
    expect(await patientCount(ORG_A)).toBe(before);
  });

  // ── 3. reveal, audited in the same transaction ─────────────────────────────────────────────────────
  it("reveal returns the value and writes patient_identifier.reveal (warn, ids only) in the same transaction", async () => {
    const [row] = await identifierRow(janeId);
    const out = await lifecycle.revealIdentifier(ORG_A, janeId, row.id, STAFF, "corr-reveal-1");
    expect(out).toEqual({ kind: "ssn", value: SSN_DIGITS });
    const events = await admin.query(
      `SELECT severity, outcome, actor_user_id, context FROM audit_event
        WHERE event_type='patient_identifier.reveal' AND resource_id=$1`,
      [row.id],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]).toMatchObject({
      severity: "warn",
      outcome: "success",
      actor_user_id: STAFF,
    });
    expect(events.rows[0].context).toEqual({ patientId: janeId, kind: "ssn" });
  });

  it("a reveal whose audit row cannot be written returns NO value", async () => {
    const [row] = await identifierRow(janeId);
    await admin.query("REVOKE INSERT ON audit_event FROM chartwarden_app");
    try {
      await expect(
        lifecycle.revealIdentifier(ORG_A, janeId, row.id, STAFF, "corr-reveal-2"),
      ).rejects.toBeDefined();
    } finally {
      await admin.query("GRANT INSERT ON audit_event TO chartwarden_app");
    }
    const count = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE event_type='patient_identifier.reveal' AND resource_id=$1",
      [row.id],
    );
    expect(count.rows[0].n).toBe(1); // only the first, successful, reveal
  });

  it("reveal refuses another patient's identifier id, and a non-sensitive row (404)", async () => {
    const [row] = await identifierRow(janeId);
    const other = admitted(
      await service.admit(
        ORG_A,
        { lastName: "Third", firstName: "Tess", dob: "1970-03-03", administrativeSex: "female" },
        STAFF,
      ),
    );
    await expect(
      lifecycle.revealIdentifier(ORG_A, other, row.id, STAFF, "c"),
    ).rejects.toMatchObject({ statusCode: 404 });
    const mrn = (await identifierRow(other, "mrn"))[0];
    await expect(
      lifecycle.revealIdentifier(ORG_A, other, mrn.id, STAFF, "c"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // ── 4. POST identifiers: supersede, collision review, state_id ────────────────────────────────────
  it("addSensitiveIdentifier supersedes the open SSN, returns no value, and a collision with another patient's SSN + DOB opens a match review", async () => {
    const target = admitted(
      await service.admit(
        ORG_A,
        { lastName: "Late", firstName: "Lou", dob: DOB, administrativeSex: "female" },
        STAFF,
      ),
    );
    const first = await lifecycle.addSensitiveIdentifier(
      ORG_A,
      target,
      { kind: "ssn", value: "222-33-4444" },
      STAFF,
    );
    expect(first).toMatchObject({ kind: "ssn", valueLast4: "4444" });
    expect(JSON.stringify(first)).not.toMatch(/222-?33-?4444/);
    // correct a mis-keyed SSN to one that collides with Jane (same DOB)
    const second = await lifecycle.addSensitiveIdentifier(
      ORG_A,
      target,
      { kind: "ssn", value: SSN },
      STAFF,
    );
    expect(JSON.stringify(second)).not.toContain(SSN_DIGITS);
    const rows = await identifierRow(target);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.effective_to === null)).toHaveLength(1);
    const reviews = await admin.query(
      `SELECT status, candidate_existing_patient_id, feature_breakdown FROM patient_match_review
        WHERE new_patient_id=$1`,
      [target],
    );
    expect(reviews.rows).toHaveLength(1);
    expect(reviews.rows[0]).toMatchObject({
      status: "open",
      candidate_existing_patient_id: janeId,
    });
    expect(reviews.rows[0].feature_breakdown.rule).toBe("ssn_dob");
    // re-adding the same colliding SSN does not duplicate the open review
    await lifecycle.addSensitiveIdentifier(ORG_A, target, { kind: "ssn", value: SSN }, STAFF);
    const again = await admin.query(
      "SELECT count(*)::int AS n FROM patient_match_review WHERE new_patient_id=$1 AND status='open'",
      [target],
    );
    expect(again.rows[0].n).toBe(1);
  });

  it("state_id requires the issuer, is sealed WITHOUT a blind index, and reveals round-trip", async () => {
    const pid = admitted(
      await service.admit(
        ORG_A,
        { lastName: "Lic", firstName: "Dee", dob: "1980-04-04", administrativeSex: "female" },
        STAFF,
      ),
    );
    await expect(
      lifecycle.addSensitiveIdentifier(ORG_A, pid, { kind: "state_id", value: "D1234567" }, STAFF),
    ).rejects.toMatchObject({ statusCode: 422 });
    const stored = await lifecycle.addSensitiveIdentifier(
      ORG_A,
      pid,
      { kind: "state_id", value: "d-123 4567", issuer: "tx" },
      STAFF,
    );
    expect(stored).toMatchObject({ kind: "state_id", valueLast4: "4567" });
    const [row] = await identifierRow(pid, "state_id");
    expect(row.value).toBeNull();
    expect(row.value_blind_index).toBeNull();
    expect(row.value_dek_version).toBe("v1");
    expect(await lifecycle.revealIdentifier(ORG_A, pid, row.id, STAFF, "c")).toEqual({
      kind: "state_id",
      value: "D1234567",
    });
  });

  // ── 5. the PatientReader L3 lookup finally has data ───────────────────────────────────────────────
  it("PatientReader.findBySsnLast4AndDob (the REAL Drizzle store) returns the patient (W-M5-19 path)", async () => {
    const reader = createPatientReader(createDrizzlePatientReaderStore(appHandle.db));
    const hits = await reader.findBySsnLast4AndDob({
      organizationId: ORG_A,
      ssnLast4: "6789",
      dateOfBirth: DOB,
    });
    expect(hits.map((h) => h.id)).toContain(janeId);
  });

  // ── 6. tenancy ─────────────────────────────────────────────────────────────────────────────────────
  it("org B probing org A's SSN gets no hit and creates its own patient", async () => {
    const out = await service.admit(ORG_B, { ...JANE, ssn: SSN }, STAFF);
    expect(out.outcome).toBe("created");
    const [aRow] = await identifierRow(janeId);
    const bPid = (out as { patientId: string }).patientId;
    const [bRow] = await identifierRow(bPid);
    expect((aRow.value_blind_index as Buffer).equals(bRow.value_blind_index as Buffer)).toBe(false);
  });

  it("as chartwarden_app a connection scoped to another tenant (or to none) sees zero rows (RLS is forced)", async () => {
    const rowsAs = async (orgId: string): Promise<number> =>
      appHandle.db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
        const res = await tx.execute(sql`SELECT count(*)::int AS n FROM patient_identifier`);
        return Number((res.rows?.[0] as { n: number }).n);
      });
    expect(await rowsAs("00000000-0000-4000-8000-00000000dead")).toBe(0);
    expect(await rowsAs(ORG_A)).toBeGreaterThan(0);
    // with the GUC unset or empty the policy fails closed (an error or zero rows, never the data)
    const unscoped = await appHandle.db
      .execute(sql`SELECT count(*)::int AS n FROM patient_identifier`)
      .then((r) => Number((r.rows?.[0] as { n: number }).n))
      .catch(() => 0);
    expect(unscoped).toBe(0);
  });

  it("org A's ciphertext copied into an org B row does NOT open there", async () => {
    const [aRow] = await identifierRow(janeId);
    const bPid = (
      await admin.query("SELECT id FROM patient WHERE organization_id=$1 LIMIT 1", [ORG_B])
    ).rows[0].id as string;
    const planted = (
      await admin.query(
        `INSERT INTO patient_identifier
           (patient_id, organization_id, kind, value, value_encrypted, value_last4, value_blind_index, value_dek_version, effective_from)
         VALUES ($1,$2,'ssn',NULL,$3,'6789',$4,'v1','2026-10-08') RETURNING id`,
        [bPid, ORG_B, aRow.value_encrypted, aRow.value_blind_index],
      )
    ).rows[0].id as string;
    await expect(
      lifecycle.revealIdentifier(ORG_B, bPid, planted, STAFF, "c"),
    ).rejects.toBeInstanceOf(IdentifierCipherIntegrityError);
    await admin.query("DELETE FROM patient_identifier WHERE id=$1", [planted]);
  });

  // ── 7. DEK rotation: no worker needed ──────────────────────────────────────────────────────────────
  it("after a DEK rotation an old row still reveals, and the SAME SSN + DOB still blocks (multi-version probe)", async () => {
    const version = await rotateDek(ORG_A);
    expect(version).toBe("v2");
    const [oldRow] = await identifierRow(janeId);
    expect(oldRow.value_dek_version).toBe("v1");
    expect(await lifecycle.revealIdentifier(ORG_A, janeId, oldRow.id, STAFF, "c")).toEqual({
      kind: "ssn",
      value: SSN_DIGITS,
    });
    const blocked = await service.admit(
      ORG_A,
      { lastName: "After", firstName: "Rot", dob: DOB, administrativeSex: "female", ssn: SSN },
      STAFF,
    );
    expect(blocked).toMatchObject({ outcome: "hard_block", existingPatientId: janeId });
    // a NEW SSN now seals under v2 and is found alongside the v1 rows
    const v2Pid = admitted(
      await service.admit(
        ORG_A,
        {
          lastName: "Newkey",
          firstName: "Nat",
          dob: "1972-07-07",
          administrativeSex: "male",
          ssn: "555-12-3456",
        },
        STAFF,
      ),
    );
    expect((await identifierRow(v2Pid))[0].value_dek_version).toBe("v2");
    const again = await service.admit(
      ORG_A,
      {
        lastName: "Dup",
        firstName: "Nat",
        dob: "1972-07-07",
        administrativeSex: "male",
        ssn: "555123456",
      },
      STAFF,
    );
    expect(again).toMatchObject({ outcome: "hard_block", existingPatientId: v2Pid });
    const versions = await admin.query(
      "SELECT DISTINCT value_dek_version AS v FROM patient_identifier WHERE kind='ssn' AND organization_id=$1 ORDER BY 1",
      [ORG_A],
    );
    expect(versions.rows.map((r) => r.v)).toEqual(["v1", "v2"]);
  });

  // ── 7b. ChartWarden label rename, release 1: the matcher finds a blind index stored under EITHER label ──────────
  // LEGACY(wardenx->chartwarden): the writer still emits the legacy "wardenx:" label (every row above proves that); this
  // rewrites one row's index under the NEW "chartwarden:" label, exactly what the future writer flip would leave behind,
  // and proves the REAL probe (key ring -> HKDF -> `IN (...)` on Postgres) still blocks the duplicate instead of missing it.
  it("a blind index stored under the NEW chartwarden label is still found (no duplicate chart), and a different SSN is not a hit", async () => {
    const dob = "1961-01-01";
    const pid = admitted(
      await service.admit(
        ORG_A,
        {
          lastName: "Label",
          firstName: "Flip",
          dob,
          administrativeSex: "female",
          ssn: "444-55-6666",
        },
        STAFF,
      ),
    );
    const [row] = await identifierRow(pid);
    const dek = await getTenantKeyProvider().dekForOrgVersion(ORG_A, row.value_dek_version);
    const indexKey = Buffer.from(
      hkdfSync(
        "sha256",
        dek.key,
        Buffer.alloc(0),
        Buffer.from(`chartwarden:m5:ssn-blind-index:v1:${ORG_A}`),
        32,
      ),
    );
    const newLabelToken = createHmac("sha256", indexKey).update("ssn:444556666", "utf8").digest();
    expect(newLabelToken.equals(row.value_blind_index)).toBe(false);
    await admin.query("UPDATE patient_identifier SET value_blind_index=$1 WHERE id=$2", [
      newLabelToken,
      row.id,
    ]);
    const before = await patientCount(ORG_A);
    const blocked = await service.admit(
      ORG_A,
      { lastName: "Dup", firstName: "Flip", dob, administrativeSex: "female", ssn: "444556666" },
      STAFF,
    );
    expect(blocked).toMatchObject({ outcome: "hard_block", existingPatientId: pid });
    expect(await patientCount(ORG_A)).toBe(before);
    const other = await service.admit(
      ORG_A,
      { lastName: "Other", firstName: "Flip", dob, administrativeSex: "female", ssn: "444556667" },
      STAFF,
    );
    expect(other.outcome).not.toBe("hard_block");
  });

  // ── 8. the eraser and the new CHECK ────────────────────────────────────────────────────────────────
  it("the CHECK demands an index on a live SSN row; the shred sentinel (empty ciphertext, no index) satisfies it", async () => {
    const [row] = await identifierRow(janeId);
    await admin.query("BEGIN");
    try {
      await admin.query("SAVEPOINT s1");
      await expect(
        admin.query("UPDATE patient_identifier SET value_blind_index=NULL WHERE id=$1", [row.id]),
      ).rejects.toMatchObject({ code: "23514" });
      await admin.query("ROLLBACK TO SAVEPOINT s1");
      // exactly the eraser's UPDATE
      await admin.query(
        `UPDATE patient_identifier
            SET value_encrypted='\\x'::bytea, value_last4=NULL, value_blind_index=NULL, value_dek_version=NULL
          WHERE id=$1`,
        [row.id],
      );
    } finally {
      await admin.query("ROLLBACK");
    }
  });

  it("the eraser shreds an SSN patient's subtree (shred UPDATE passes the CHECK, then the rows go)", async () => {
    const pid = admitted(
      await service.admit(
        ORG_B,
        {
          lastName: "Erase",
          firstName: "Ed",
          dob: "1990-09-09",
          administrativeSex: "male",
          ssn: "444-55-6666",
        },
        STAFF,
      ),
    );
    // The delete half runs as `chartwarden_destruction` (0157); `chartwarden_app` holds DELETE on none of these tables.
    const counts = await createDrizzlePatientEraseStore(destructionHandle.db).erasePatientSubtree(
      ORG_B,
      pid,
    );
    expect(counts.identifiers).toBeGreaterThanOrEqual(2);
    expect(await identifierRow(pid)).toHaveLength(0);
  });

  // ── 9. migrations: the role backfill ───────────────────────────────────────────────────────────────
  it("migration 0801 grants the SSN keys ONLY to the named roles that exist, idempotently, never to clinical roles", async () => {
    const sqlText = readFileSync(
      join(MIGRATIONS_DIR, "0801_m5_ssn_default_role_grants.sql"),
      "utf8",
    );
    const roleId = async (key: string): Promise<string> =>
      (
        await admin.query(
          `INSERT INTO role (organization_id, key, name, category) VALUES ($1,$2,$2,'operations')
           ON CONFLICT DO NOTHING RETURNING id`,
          [ORG_A, key],
        )
      ).rows[0]?.id ??
      (await admin.query("SELECT id FROM role WHERE organization_id=$1 AND key=$2", [ORG_A, key]))
        .rows[0].id;
    const ids: Record<string, string> = {};
    for (const key of [...Object.keys(SSN_DEFAULT_GRANTS), "rn", "np"])
      ids[key] = await roleId(key);
    await admin.query(sqlText);
    await admin.query(sqlText);
    const keysOf = async (id: string) =>
      (
        await admin.query(
          "SELECT permission_key FROM role_permission WHERE role_id=$1 AND permission_key LIKE 'phi.%_ssn' ORDER BY 1",
          [id],
        )
      ).rows.map((r) => r.permission_key as string);
    for (const [role, keys] of Object.entries(SSN_DEFAULT_GRANTS)) {
      expect(await keysOf(ids[role] as string), role).toEqual([...keys].sort());
    }
    expect(await keysOf(ids.rn as string)).toEqual([]);
    expect(await keysOf(ids.np as string)).toEqual([]);
  });

  // ── 10. crypto-shred (LAST: it destroys org A's key ring) ──────────────────────────────────────────
  it("after the cryptographic shred a reveal returns an error and no value; a new SSN cannot be stored; an SSN-less admit still works", async () => {
    const [row] = await identifierRow(janeId);
    const certId = (
      await admin.query(
        `INSERT INTO destruction_certificate
           (organization_id, data_class, record_count, date_range_start, date_range_end, method, status)
         VALUES ($1,'saas_tenant_platform_class',1, now() - interval '2 years', now() - interval '1 year',
                 'crypto_erase','approved') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    await admin.query("UPDATE tenant_account SET status='destruction_pending' WHERE id=$1", [
      accountOf[ORG_A],
    ]);
    await admin.query("SELECT set_config('app.destroyed_by_membership_id',$1,false)", [APPROVER]);
    await admin.query("SELECT m34_destroy_tenant_key_ring($1,$2)", [accountOf[ORG_A], certId]);

    await expect(
      lifecycle.revealIdentifier(ORG_A, janeId, row.id, STAFF, "c"),
    ).rejects.toBeInstanceOf(IdentifierCipherUnboundError);
    await expect(
      service.admit(ORG_A, { ...JANE, lastName: "Gone", ssn: "321-54-9876" }, STAFF),
    ).rejects.toBeInstanceOf(IdentifierCipherUnboundError);
    const out = await service.admit(
      ORG_A,
      { lastName: "NoSsn", firstName: "Nel", dob: "1999-09-09", administrativeSex: "female" },
      STAFF,
    );
    expect(out.outcome).toBe("created");
    // no SSN row was created by the refused attempt
    const leftovers = await admin.query(
      `SELECT count(*)::int AS n FROM patient p WHERE p.organization_id=$1 AND p.legal_last_name='Gone'`,
      [ORG_A],
    );
    expect(leftovers.rows[0].n).toBe(0);
  });
});
