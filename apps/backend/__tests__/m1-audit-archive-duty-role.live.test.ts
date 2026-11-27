/**
 * CW-MON-01 follow-up 2 (#1185, migration 1582) — the audit.archive functions belong to a duty role of their own, LIVE Postgres.
 *
 * `audit_archive_read_batch` returns whole rows of every tenant's closed audit month and `audit_archive_detach` takes a closed month out
 * of `audit_event`. Until 1582 the platform carrier held EXECUTE on both (the provisioner granted it), so the BYPASSRLS platform login
 * could read and detach closed months even though 1566 had taken its direct read of `audit_event` away. Proven here, on a real database:
 *   1. the duty role `chartwarden_audit_archiver` is NOLOGIN, NOBYPASSRLS, a member of nothing, and held by the archive login ALONE
 *      (not by the platform carrier or login, nor the tenant pool); the four functions are still SECURITY DEFINER with a fixed
 *      search_path ending in pg_temp, and no role but the owner and the duty role holds EXECUTE on any of them;
 *   2. the PLATFORM LOGIN cannot call any of the three (42501), cannot read the closed month directly, cannot detach it, cannot
 *      SET ROLE into the duty role, and the closed month is intact afterwards; the TENANT POOL (the real NOBYPASSRLS chartwarden_app)
 *      cannot either; the platform login keeps its other definer grants (the audit writer, partition coverage);
 *   3. the LEGITIMATE path is unchanged: the archive job's own code (`runAuditArchive` over `archiveCatalogRunner`) on the archive
 *      login's pool reads the closed month whole, verifies it back from the store, detaches it, and leaves its critical
 *      `platform.bypass_invoked` row; the duty login itself holds no table privilege;
 *   4. upgrade and drift: re-applying 1582 over a database an older provisioner had granted revokes the platform, tenant and PUBLIC
 *      grants and the membership (twice, idempotent); a provisioner re-run takes a hand-granted EXECUTE back, and REFUSES to finish
 *      while a PUBLIC grant leaves the platform login a path; the archive login can be disabled and re-enabled by the provisioner.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m1:audit-archive-duty:live
 * Use a PRIVATE chartwarden-postgres:dev container on its own port: the suite DROPs the chartwarden_* roles.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { auditPlatformEvent } from "@chartwarden/audit";
import { createDbClient } from "@chartwarden/db";
import { type PlatformBypassAuditor, resetPlatformJobRegistry } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AUDIT_ARCHIVE_JOB_ID,
  type ArchiveObjectPort,
  archiveCatalogRunner,
  runAuditArchive,
  wireAuditArchiveTenancy,
} from "../src/bootstrap/jobs/audit-archive";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const REPO_ROOT = join(__dirname, "../../..");
const MIGRATIONS_DIR = join(REPO_ROOT, "packages/db/migrations");
const DUTY_MIGRATION = "1582_m1_audit_archive_duty_role.sql";
const PLATFORM_PASSWORD = "platform-live-password-archive";
const ARCHIVE_PASSWORD = "archive-live-password-duty-role";

const ORG_A = "00000000-0000-4000-8000-0000000001a1";
const ORG_B = "00000000-0000-4000-8000-0000000001b1";
/** A month long closed whatever the clock says. */
const CLOSED_PARTITION = "audit_event_2025_01";
const CLOSED_FROM = "2025-01-01 00:00:00+00";
const CLOSED_TO = "2025-02-01 00:00:00+00";
const SECRET_MARKER = "closed-month-before-image-marker";
const ARCHIVE_FUNCTIONS = [
  "audit_archive_candidates(integer)",
  "audit_archive_read_batch(text, uuid, integer)",
  "audit_archive_detach(text, bigint, boolean)",
] as const;
const ALL_FOUR = ["audit_archive_closed_partitions()", ...ARCHIVE_FUNCTIONS] as const;
const STILL_PLATFORM_FUNCTION = "time_partition_coverage()";

describe.skipIf(!DB_URL)("audit.archive duty role — LIVE Postgres", () => {
  let admin: Client;
  let app: Client;
  let platform: Client;
  let archive: Client;
  let archiveDb: ReturnType<typeof createDbClient>;
  let seededRows = 0;

  const urlAs = (role: string, password: string): string => {
    const url = new URL(DB_URL as string);
    url.username = role;
    url.password = password;
    return url.toString();
  };
  const provision = (extraEnv: Record<string, string> = {}) =>
    spawnSync("bun", ["run", "scripts/db/provision-runtime-roles.ts"], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PROVISION_DATABASE_URL: DB_URL,
        CHARTWARDEN_PLATFORM_PASSWORD: PLATFORM_PASSWORD,
        CHARTWARDEN_AUDIT_ARCHIVE_PASSWORD: ARCHIVE_PASSWORD,
        ...extraEnv,
      },
      encoding: "utf8",
    });
  const archiveUrl = (): string => urlAs("chartwarden_audit_archive_login", ARCHIVE_PASSWORD);
  let archiveOpen = false;
  const openArchive = async (): Promise<void> => {
    archive = new Client({ connectionString: archiveUrl() });
    await archive.connect();
    archiveOpen = true;
  };
  /**
   * A provisioner run cuts the archive login's live sessions (a rotation must: a leaked credential's connection would otherwise stay
   * usable). So close ours first and reconnect afterwards, unless the run is the one that disables the login.
   */
  const provisionReconnecting = async (extraEnv: Record<string, string> = {}) => {
    if (archiveOpen) {
      await archive.end();
      archiveOpen = false;
    }
    const result = provision(extraEnv);
    if (extraEnv.CHARTWARDEN_AUDIT_ARCHIVE_REVOKE !== "true") await openArchive();
    return result;
  };
  /** The SQLSTATE of a statement, or "ok". An error with no SQLSTATE (a dropped connection) is rethrown: it must never read as success. */
  const sqlState = async (
    client: Client,
    text: string,
    params: unknown[] = [],
  ): Promise<string> => {
    try {
      await client.query(text, params);
      return "ok";
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === undefined) throw error;
      return code;
    }
  };
  const attachedCount = async (): Promise<number> =>
    (
      await admin.query(
        `SELECT count(*)::int AS n FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
          WHERE i.inhparent = 'audit_event'::regclass AND c.relname = $1`,
        [CLOSED_PARTITION],
      )
    ).rows[0].n as number;
  const closedMonthIntact = async (): Promise<void> => {
    expect(await attachedCount()).toBe(1);
    const rows = await admin.query(`SELECT count(*)::int AS n FROM ${CLOSED_PARTITION}`);
    expect(rows.rows[0].n).toBe(seededRows);
  };
  const holders = async (signature: string): Promise<string[]> =>
    (
      await admin.query<{ grantee: string }>(
        `SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid = a.grantee) END AS grantee
           FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
          WHERE p.oid = to_regprocedure($1) AND a.privilege_type = 'EXECUTE'
          ORDER BY 1`,
        [`public.${signature}`],
      )
    ).rows.map((r) => r.grantee);

  const auditBypass: PlatformBypassAuditor<ReturnType<typeof createDbClient>["db"]> = async (
    tx,
    event,
  ) => {
    await auditPlatformEvent(tx, {
      eventType: "platform.bypass_invoked",
      resourceKind: "tenant",
      outcome: "success",
      severity: event.severity,
      correlationId: `platform-bypass:${event.jobId}`,
      context: { jobId: event.jobId, reason: event.reason },
    });
  };
  const memoryStore = (): ArchiveObjectPort & { readonly objects: Map<string, Uint8Array> } => {
    const objects = new Map<string, Uint8Array>();
    const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
    return {
      objects,
      async putObject({ objectKey, bytes }) {
        objects.set(objectKey, bytes);
        return { sha256Hex: sha(bytes) };
      },
      async inspectObject({ objectKey }) {
        const bytes = objects.get(objectKey);
        return bytes ? { byteSize: bytes.byteLength, sha256Hex: sha(bytes) } : null;
      },
    };
  };

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    }
    // Migrate, THEN provision: what a fresh database goes through. The archive login only exists because the provisioner creates it.
    const provisioned = provision();
    expect(provisioned.status, provisioned.stderr).toBe(0);

    app = new Client({ connectionString: await appRoleConnectionString(admin, DB_URL as string) });
    platform = new Client({
      connectionString: urlAs("chartwarden_platform_login", PLATFORM_PASSWORD),
    });
    await Promise.all([app.connect(), platform.connect(), openArchive()]);
    wireAuditArchiveTenancy();

    for (const [org, slug] of [
      [ORG_A, "arch-a"],
      [ORG_B, "arch-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name,status) VALUES ($1,$2,$2,$2,'active')",
        [org, slug],
      );
    }
    // A CLOSED month-partition (the migrations only pre-create the current month onwards), with both tenants' rows and a recognisable
    // before-image: the whole row is what audit_archive_read_batch returns.
    await admin.query(
      `CREATE TABLE ${CLOSED_PARTITION} PARTITION OF audit_event FOR VALUES FROM ('${CLOSED_FROM}') TO ('${CLOSED_TO}')`,
    );
    for (const [i, org] of [ORG_A, ORG_A, ORG_A, ORG_B, ORG_B].entries()) {
      await admin.query(
        `INSERT INTO audit_event (organization_id, actor_kind, event_type, resource_kind, correlation_id, outcome, severity,
                                  before, context, retention_class, created_at)
         VALUES ($1,'system','test.archive.seed','session',$2,'success','info',$3::jsonb,'{}'::jsonb,'compliance',$4::timestamptz)`,
        [org, `seed-${i}`, JSON.stringify({ note: SECRET_MARKER }), `2025-01-${10 + i}T12:00:00Z`],
      );
    }
    seededRows = 5;
  }, 300_000);

  afterAll(async () => {
    resetPlatformJobRegistry();
    await archiveDb?.close();
    await Promise.all([app?.end(), platform?.end(), archiveOpen ? archive.end() : undefined]);
    await admin?.end();
  });

  it("the duty role is NOLOGIN, NOBYPASSRLS, a member of nothing, held by the archive login alone", async () => {
    const role = await admin.query(
      `SELECT rolcanlogin, rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb, rolreplication
         FROM pg_roles WHERE rolname = 'chartwarden_audit_archiver'`,
    );
    expect(role.rows[0]).toEqual({
      rolcanlogin: false,
      rolsuper: false,
      rolbypassrls: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolreplication: false,
    });
    const memberships = await admin.query(
      `SELECT granted.rolname AS granted, member.rolname AS member
         FROM pg_auth_members m
         JOIN pg_roles granted ON granted.oid = m.roleid
         JOIN pg_roles member ON member.oid = m.member
        WHERE granted.rolname = 'chartwarden_audit_archiver' OR member.rolname = 'chartwarden_audit_archiver'`,
    );
    expect(memberships.rows).toEqual([
      { granted: "chartwarden_audit_archiver", member: "chartwarden_audit_archive_login" },
    ]);
    const login = await admin.query(
      "SELECT rolcanlogin, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'chartwarden_audit_archive_login'",
    );
    expect(login.rows[0]).toEqual({ rolcanlogin: true, rolsuper: false, rolbypassrls: false });
    for (const who of ["chartwarden_platform", "chartwarden_platform_login", "chartwarden_app"]) {
      const held = await admin.query(
        `SELECT pg_has_role($1, 'chartwarden_audit_archiver', 'MEMBER') AS member,
                pg_has_role($1, 'chartwarden_audit_archiver', 'USAGE') AS usage`,
        [who],
      );
      expect(held.rows[0], who).toEqual({ member: false, usage: false });
    }
  });

  it("the functions stay SECURITY DEFINER with a fixed search_path ending in pg_temp; only the owner and the duty role may execute", async () => {
    for (const signature of ALL_FOUR) {
      const fn = await admin.query(
        `SELECT p.prosecdef, p.proconfig, r.rolname AS owner FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
          WHERE p.oid = to_regprocedure($1)`,
        [`public.${signature}`],
      );
      expect(fn.rows[0].prosecdef, signature).toBe(true);
      const searchPath = (fn.rows[0].proconfig as string[]).find((c) =>
        c.startsWith("search_path="),
      );
      expect(searchPath, signature).toMatch(/pg_temp$/);
      const allowed = new Set([fn.rows[0].owner as string]);
      if (signature !== "audit_archive_closed_partitions()")
        allowed.add("chartwarden_audit_archiver");
      const held = await holders(signature);
      expect(
        held.every((g) => allowed.has(g)),
        `${signature}: ${held.join(",")}`,
      ).toBe(true);
    }
    // The functions resolve names through `public` first, as their owner (a superuser): that is safe only while no login can create an
    // object there (a cluster upgraded from PostgreSQL 14 or older may still grant CREATE on public to PUBLIC).
    for (const who of [
      "chartwarden_platform_login",
      "chartwarden_app",
      "chartwarden_audit_archive_login",
    ]) {
      const create = await admin.query(
        "SELECT has_schema_privilege($1, 'public', 'CREATE') AS can",
        [who],
      );
      expect(create.rows[0].can, `${who} must not create objects in public`).toBe(false);
    }
    for (const signature of ARCHIVE_FUNCTIONS) {
      expect(await holders(signature)).toContain("chartwarden_audit_archiver");
      for (const who of ["chartwarden_platform_login", "chartwarden_platform", "chartwarden_app"]) {
        const can = await admin.query(
          "SELECT has_function_privilege($1, to_regprocedure($2), 'EXECUTE') AS can",
          [who, `public.${signature}`],
        );
        expect(can.rows[0].can, `${who} ${signature}`).toBe(false);
      }
    }
  });

  it("the platform login cannot call any archive function, read the closed month, detach it or step into the duty role", async () => {
    expect(await sqlState(platform, "SELECT * FROM audit_archive_candidates(1)")).toBe("42501");
    expect(
      await sqlState(platform, "SELECT * FROM audit_archive_read_batch($1, NULL::uuid, 10)", [
        CLOSED_PARTITION,
      ]),
    ).toBe("42501");
    expect(
      await sqlState(platform, "SELECT audit_archive_detach($1, $2::bigint, true)", [
        CLOSED_PARTITION,
        seededRows,
      ]),
    ).toBe("42501");
    // The same closed month by every other road the login might try.
    expect(await sqlState(platform, `SELECT * FROM ${CLOSED_PARTITION}`)).toBe("42501");
    expect(await sqlState(platform, "SELECT before FROM audit_event")).toBe("42501");
    expect(
      await sqlState(platform, `ALTER TABLE audit_event DETACH PARTITION ${CLOSED_PARTITION}`),
    ).toBe("42501");
    expect(await sqlState(platform, "SET ROLE chartwarden_audit_archiver")).toBe("42501");
    expect(await sqlState(platform, "SET ROLE chartwarden_audit_archive_login")).toBe("42501");
    await closedMonthIntact();
  });

  it("the tenant pool (chartwarden_app) cannot call them either, and the platform login keeps its other definer grants", async () => {
    expect(await sqlState(app, "SELECT * FROM audit_archive_candidates(1)")).toBe("42501");
    expect(
      await sqlState(app, "SELECT * FROM audit_archive_read_batch($1, NULL::uuid, 10)", [
        CLOSED_PARTITION,
      ]),
    ).toBe("42501");
    expect(
      await sqlState(app, "SELECT audit_archive_detach($1, $2::bigint, true)", [
        CLOSED_PARTITION,
        seededRows,
      ]),
    ).toBe("42501");
    await closedMonthIntact();
    // What the platform login still does: partition coverage and the platform audit writer.
    expect(await sqlState(platform, `SELECT * FROM ${STILL_PLATFORM_FUNCTION}`)).toBe("ok");
    expect(
      await sqlState(
        platform,
        `SELECT audit_writer_insert_platform_event('platform.bypass_invoked','tenant',NULL,'success','info','duty-role-live',
                '{}'::jsonb,'compliance')`,
      ),
    ).toBe("ok");
  });

  it("the archive login holds no table privilege: it reaches a closed month only through the three functions", async () => {
    expect(await sqlState(archive, `SELECT * FROM ${CLOSED_PARTITION}`)).toBe("42501");
    expect(await sqlState(archive, "SELECT id FROM audit_event LIMIT 1")).toBe("42501");
    expect(await sqlState(archive, "DELETE FROM audit_event")).toBe("42501");
    expect(
      await sqlState(archive, `ALTER TABLE audit_event DETACH PARTITION ${CLOSED_PARTITION}`),
    ).toBe("42501");
    const candidates = await archive.query(
      "SELECT partition_name, row_count FROM audit_archive_candidates(1)",
    );
    expect(candidates.rows).toEqual([
      { partition_name: CLOSED_PARTITION, row_count: String(seededRows) },
    ]);
    const page = await archive.query(
      "SELECT r FROM audit_archive_read_batch($1, NULL::uuid, 100) AS r",
      [CLOSED_PARTITION],
    );
    expect(page.rows).toHaveLength(seededRows);
    expect(JSON.stringify(page.rows)).toContain(SECRET_MARKER);
    await closedMonthIntact();
  });

  it("drift: a hand-granted EXECUTE is taken back by the provisioner, and a PUBLIC grant makes it refuse to finish", async () => {
    await admin.query(
      "GRANT EXECUTE ON FUNCTION audit_archive_read_batch(text, uuid, integer) TO chartwarden_platform",
    );
    expect(
      await sqlState(platform, "SELECT * FROM audit_archive_read_batch($1, NULL::uuid, 10)", [
        CLOSED_PARTITION,
      ]),
    ).toBe("ok");
    const retaken = await provisionReconnecting();
    expect(retaken.status, retaken.stderr).toBe(0);
    expect(
      await sqlState(platform, "SELECT * FROM audit_archive_read_batch($1, NULL::uuid, 10)", [
        CLOSED_PARTITION,
      ]),
    ).toBe("42501");

    // A grant the provisioner's REVOKE cannot reach: it must fail loudly, never finish with the path open.
    await admin.query(
      "GRANT EXECUTE ON FUNCTION audit_archive_detach(text, bigint, boolean) TO PUBLIC",
    );
    const refused = await provisionReconnecting();
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("chartwarden_platform_login can still execute");
    expect(refused.stderr).toContain("audit_archive_detach(text, bigint, boolean)");
    await admin.query(
      "REVOKE EXECUTE ON FUNCTION audit_archive_detach(text, bigint, boolean) FROM PUBLIC",
    );
    const clean = await provisionReconnecting();
    expect(clean.status, clean.stderr).toBe(0);
  }, 120_000);

  it("upgrade: applying 1582 over a database the old provisioner had granted revokes platform, tenant, PUBLIC and the membership, twice", async () => {
    for (const signature of ARCHIVE_FUNCTIONS) {
      await admin.query(
        `GRANT EXECUTE ON FUNCTION public.${signature} TO chartwarden_platform, chartwarden_platform_login, chartwarden_app, PUBLIC`,
      );
    }
    await admin.query("GRANT chartwarden_audit_archiver TO chartwarden_platform");
    expect(
      await sqlState(platform, "SELECT * FROM audit_archive_candidates(1)"),
      "the old state really does let the platform login in",
    ).toBe("ok");

    const migration = readFileSync(join(MIGRATIONS_DIR, DUTY_MIGRATION), "utf8");
    await admin.query(migration);
    await admin.query(migration);

    for (const signature of ARCHIVE_FUNCTIONS) {
      expect(await holders(signature), signature).toEqual([
        "chartwarden_audit_archiver",
        "postgres",
      ]);
    }
    expect(await sqlState(platform, "SELECT * FROM audit_archive_candidates(1)")).toBe("42501");
    expect(await sqlState(app, "SELECT * FROM audit_archive_candidates(1)")).toBe("42501");
    const members = await admin.query(
      `SELECT member.rolname AS member FROM pg_auth_members m
         JOIN pg_roles granted ON granted.oid = m.roleid JOIN pg_roles member ON member.oid = m.member
        WHERE granted.rolname = 'chartwarden_audit_archiver'`,
    );
    expect(members.rows).toEqual([{ member: "chartwarden_audit_archive_login" }]);
    // The archive login still works after the re-application (the duty grant survived the revoke loop).
    expect(await sqlState(archive, "SELECT * FROM audit_archive_candidates(1)")).toBe("ok");
    await closedMonthIntact();
  });

  it("the provisioner refuses an archive password that cannot sit in a URL, before it touches the database", () => {
    // compose splices the password into DATABASE_AUDIT_ARCHIVE_URL unencoded.
    for (const password of [
      "archive/live@password:1",
      "archive-live-password#duty",
      "short",
      "REPLACE_WITH_AT_LEAST_32_CHARACTERS",
    ]) {
      const refused = provision({ CHARTWARDEN_AUDIT_ARCHIVE_PASSWORD: password });
      expect(refused.status, password).not.toBe(0);
      expect(refused.stderr, password).toMatch(/CHARTWARDEN_AUDIT_ARCHIVE_PASSWORD must be/);
    }
  });

  it("the provisioner can disable the archive login and bring it back", async () => {
    const off = await provisionReconnecting({ CHARTWARDEN_AUDIT_ARCHIVE_REVOKE: "true" });
    expect(off.status, off.stderr).toBe(0);
    const probe = new Client({ connectionString: archiveUrl() });
    await expect(probe.connect()).rejects.toThrow();
    const on = await provisionReconnecting();
    expect(on.status, on.stderr).toBe(0);
    expect(await sqlState(archive, "SELECT * FROM audit_archive_candidates(1)")).toBe("ok");
  }, 120_000);

  it("the legitimate path is unchanged: the job reads the closed month whole, verifies it, detaches it and leaves its critical bypass row", async () => {
    const store = memoryStore();
    // The job's own pool, opened after the last provisioner run (which cuts the login's sessions).
    archiveDb = createDbClient({ connectionString: archiveUrl() });
    const run = await runAuditArchive({
      withCatalog: archiveCatalogRunner({ archiveDb: archiveDb.db, auditBypass }),
      store,
      config: { bucket: "archive-test", prefix: "audit-archive", rowsPerPart: 100, detach: true },
      hotMonths: 1,
    });

    expect(run.failed).toEqual([]);
    expect(run.archived).toHaveLength(1);
    expect(run.archived[0]).toMatchObject({
      partitionName: CLOSED_PARTITION,
      rows: seededRows,
      detached: true,
    });
    // Whole rows reached the store (both tenants', before-images included): the duty path is the only one that can read them.
    const manifest = JSON.parse(
      new TextDecoder().decode(
        store.objects.get(`audit-archive/audit_event/${CLOSED_PARTITION}/manifest.json`),
      ),
    );
    expect(manifest.rowCount).toBe(seededRows);
    // The month left audit_event; the table is kept (never dropped).
    expect(await attachedCount()).toBe(0);
    expect(
      (await admin.query(`SELECT count(*)::int AS n FROM ${CLOSED_PARTITION}`)).rows[0].n,
    ).toBe(seededRows);
    // The job's cross-tenant entry is audited, critical, org-less, under its own job id.
    const bypass = await admin.query(
      `SELECT severity, organization_id, context FROM audit_event
        WHERE event_type = 'platform.bypass_invoked' AND context ->> 'jobId' = $1`,
      [AUDIT_ARCHIVE_JOB_ID],
    );
    expect(bypass.rows.length).toBeGreaterThan(0);
    expect(bypass.rows.every((r) => r.severity === "critical" && r.organization_id === null)).toBe(
      true,
    );
  }, 120_000);
});
