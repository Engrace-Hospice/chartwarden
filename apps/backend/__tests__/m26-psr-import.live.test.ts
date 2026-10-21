/**
 * GAP-078 — M26 PS&R import → reconcile, LIVE Postgres, connected as the NOBYPASSRLS `wardenx_app` role.
 *
 * Before: `importPsr` hashed the CSV, inserted a 'queued' row and enqueued nothing — the bytes were
 * discarded, no worker existed, no `cap_psr_reconciliation` row was ever written and
 * `psr_variance_raised` was never emitted. This proves the whole path with nothing stubbed but the object
 * bytes (an in-memory object client behind the REAL DEK-envelope file store) and the job queue (a capture
 * port): import stores an ENCRYPTED file + enqueues; the reconcile job decrypts, strictly parses, diffs
 * against the real accrual ledger, writes beneficiary / agency / inpatient variance lines, flips the import
 * to `reconciled`, and publishes the event through the REAL catalog-validating outbox publisher on the same
 * tx. Re-running is a no-op; a malformed file ends `parse_failed` with a PHI-free error; org B sees nothing.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m26:psr-import:live
 */
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { capYearForDate, capYearWindow } from "@chartwarden/cap-management";
import { createDbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M26_OUTBOX_EVENTS } from "../src/modules/26-cap/index";
import { createPsrFileStore } from "../src/modules/26-cap/psr/psr-file-store";
import { reconcilePsrImport } from "../src/modules/26-cap/psr/psr-reconcile";
import { buildDrizzleM26ReadService } from "../src/modules/26-cap/routes/read-service-drizzle";
import { buildDrizzleM26WriteService } from "../src/modules/26-cap/routes/write-service-drizzle";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const P1 = "aaaaaaaa-0000-4000-8000-0000000000a1";
const P2 = "aaaaaaaa-0000-4000-8000-0000000000a2";
const P3 = "aaaaaaaa-0000-4000-8000-0000000000a3";
const MBI1 = "1EG4TE5MK73";
const MBI2 = "2AB4TE5MK74";
const MBI3 = "3CD4TE5MK75";
const MBI4 = "4EF4TE5MK76"; // PS&R-only

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
// M1 matches; M2 is $100 under; M4 is on the PS&R only; M3 is on our ledger only; inpatient days 7 vs our 5.
const VARIANCE_CSV = [
  "MBI,Paid Amount,Inpatient Days",
  `${MBI1},1000.00,3`,
  `${MBI2},400.00,2`,
  `${MBI4},200.00,2`,
].join("\r\n");

describe.skipIf(!DB_URL)("GAP-078 — M26 PS&R import + reconcile — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let periodA: string;
  let periodB: string;
  const objects = new Map<string, Uint8Array>();
  const queued: { organizationId: string; importId: string }[] = [];

  const dek = randomBytes(32);
  const files = createPsrFileStore({
    keys: {
      dekForOrg: async () => ({ version: "1", key: dek }),
      dekForOrgVersion: async () => ({ version: "1", key: dek }),
    },
    objects: {
      putObject: async ({ organizationId, objectKey, bytes }) => {
        objects.set(`${organizationId}/${objectKey}`, bytes);
      },
      getObject: async ({ organizationId, objectKey }) => {
        const o = objects.get(`${organizationId}/${objectKey}`);
        if (!o) throw new Error("object missing");
        return o;
      },
    },
  });
  const outbox = buildTxOutboxPublisher(buildBootOutboxCatalog([M26_OUTBOX_EVENTS]));
  const m26Outbox = {
    publish: (
      tx: unknown,
      input: Parameters<typeof outbox.publish>[1] extends infer I ? Omit<I, "callerModule"> : never,
    ) =>
      outbox.publish(tx as Parameters<typeof outbox.publish>[0], { ...input, callerModule: "m26" }),
  };

  const actorA = { organizationId: ORG_A, userId: USER, roles: [], stepUpRecent: false };
  const actorB = { organizationId: ORG_B, userId: USER, roles: [], stepUpRecent: false };
  const importInput = (csv: string) => ({
    macRegion: "palmetto",
    psrPeriodFrom: "2026-01-01",
    psrPeriodTo: "2026-03-31",
    fileBase64: b64(csv),
  });
  const deps = () => ({ db: handle.db, files, outbox: m26Outbox });
  const write = () =>
    buildDrizzleM26WriteService(handle.db, m26Outbox, {
      files,
      enqueue: { enqueue: async (job) => void queued.push(job) },
    });

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }
  async function seedPeriod(orgId: string, capYear: string): Promise<string> {
    const w = capYearWindow(capYear);
    const { rows } = await admin.query(
      `INSERT INTO cap_period (organization_id, ccn, cap_year, starts_on, ends_on,
         aggregate_cap_amount_cents, inpatient_cap_pct, status, opened_by)
       VALUES ($1,'000000',$2,$3,$4,3446534,0.2000,'active',$5) RETURNING id`,
      [orgId, capYear, w.startsOn, w.endsOn, USER],
    );
    return rows[0].id as string;
  }
  async function seedAccrual(
    orgId: string,
    periodId: string,
    patient: string,
    mbi: string,
    paid: number,
  ) {
    await admin.query(
      `INSERT INTO cap_beneficiary_accrual (organization_id, cap_period_id, patient_id, mbi_normalized,
         paid_cents, first_election_in_period) VALUES ($1,$2,$3,$4,$5,'2025-10-01')`,
      [orgId, periodId, patient, mbi, paid],
    );
  }
  const scalar = async (sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows[0] as Record<string, unknown>;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'psr@x.test')`, [USER]);
    await admin.query(
      `INSERT INTO organization (id,slug,legal_name,display_name)
       VALUES ($1,'m26-psr-a','M26 PSR A','M26 PSR A'),($2,'m26-psr-b','M26 PSR B','M26 PSR B')`,
      [ORG_A, ORG_B],
    );
    const capYear = capYearForDate(new Date().toISOString().slice(0, 10));
    periodA = await seedPeriod(ORG_A, capYear);
    periodB = await seedPeriod(ORG_B, capYear);
    await seedAccrual(ORG_A, periodA, P1, MBI1, 100_000);
    await seedAccrual(ORG_A, periodA, P2, MBI2, 50_000);
    await seedAccrual(ORG_A, periodA, P3, MBI3, 30_000);
    await admin.query(
      `INSERT INTO cap_inpatient_accrual (organization_id, cap_period_id, gip_days, irc_days, total_patient_days)
       VALUES ($1,$2,3,2,100)`,
      [ORG_A, periodA],
    );
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
  });

  afterAll(async () => {
    await handle?.close?.();
    await admin?.end();
  });

  let importId = "";

  it("import stores the file DEK-encrypted, queues the import and enqueues the reconcile job", async () => {
    const res = await write().importPsr(actorA, periodA, importInput(VARIANCE_CSV));
    importId = res.importId;
    expect(queued).toEqual([{ organizationId: ORG_A, importId }]);
    const row = await scalar(
      "SELECT parse_status, file_storage_key FROM cap_psr_import WHERE id=$1",
      [importId],
    );
    expect(row.parse_status).toBe("queued");
    const stored = Buffer.from(objects.get(`${ORG_A}/${row.file_storage_key}`)!).toString("utf8");
    expect(stored.startsWith("v1.")).toBe(true);
    expect(stored).not.toContain(MBI1);
  });

  it("re-uploading the same file returns the same import and re-queues it (heals a lost enqueue)", async () => {
    const again = await write().importPsr(actorA, periodA, importInput(VARIANCE_CSV));
    expect(again.importId).toBe(importId);
    expect(queued).toHaveLength(2);
    expect((await scalar("SELECT count(*)::int n FROM cap_psr_import")).n).toBe(1);
  });

  it("the reconcile job writes beneficiary / agency / inpatient variance lines and flips the import", async () => {
    const out = await reconcilePsrImport(deps(), ORG_A, importId);
    expect(out).toEqual({
      status: "reconciled",
      rowsQuarantined: 0,
      lineCount: 5,
      totalVarianceCents: 60_000,
    });

    const imp = await scalar("SELECT * FROM cap_psr_import WHERE id=$1", [importId]);
    expect(imp.parse_status).toBe("reconciled");
    expect(imp.beneficiary_count_psr).toBe(3);
    expect(Number(imp.paid_total_cents_psr)).toBe(160_000);
    expect(imp.inpatient_days_psr).toBe(7);

    const { rows } = await admin.query(
      `SELECT scope, patient_id, m26_accrual_cents, psr_amount_cents, variance_cents, variance_days, variance_reason
         FROM cap_psr_reconciliation WHERE psr_import_id=$1 ORDER BY scope, variance_cents`,
      [importId],
    );
    const n = (v: unknown) => (v === null ? null : Number(v));
    expect(
      rows.map((r) => [r.scope, r.patient_id, n(r.variance_cents), n(r.variance_days)]),
    ).toEqual([
      ["beneficiary", P3, -30_000, null], // ours only → timing
      ["beneficiary", P2, -10_000, null],
      ["beneficiary", null, 20_000, null], // PS&R only → no patient link
      ["agency_aggregate", null, -20_000, null],
      ["inpatient", null, null, 2],
    ]);
    expect(rows.find((r) => r.patient_id === P3)?.variance_reason).toBe("timing");
    expect(
      rows.find((r) => r.scope === "beneficiary" && r.patient_id === null)?.variance_reason,
    ).toBe("mbi_mismatch");
  });

  it("publishes m26.cap.psr_variance_raised through the real catalog-validating publisher", async () => {
    const ev = await scalar(
      `SELECT organization_id, payload FROM outbox_event WHERE event_type='m26.cap.psr_variance_raised'`,
    );
    expect(ev.organization_id).toBe(ORG_A);
    expect(ev.payload).toMatchObject({
      organizationId: ORG_A,
      capPeriodId: periodA,
      importId,
      totalVarianceCents: 60_000,
      lineCount: 5,
    });
    expect(JSON.stringify(ev.payload)).not.toContain(MBI1);
  });

  it("re-running a reconciled import is a no-op (no duplicate lines, no second event)", async () => {
    expect(await reconcilePsrImport(deps(), ORG_A, importId)).toEqual({
      status: "already_reconciled",
    });
    expect((await scalar("SELECT count(*)::int n FROM cap_psr_reconciliation")).n).toBe(5);
    expect(
      (
        await scalar(
          "SELECT count(*)::int n FROM outbox_event WHERE event_type='m26.cap.psr_variance_raised'",
        )
      ).n,
    ).toBe(1);
  });

  it("the read routes' service surfaces the persisted lines (variance queue + import summary)", async () => {
    const read = buildDrizzleM26ReadService(handle.db);
    const readActor = { organizationId: ORG_A, userId: USER, roles: [] };
    const view = await read.getPsrImport(readActor, importId);
    expect(view).toMatchObject({
      parseStatus: "reconciled",
      beneficiaryCountPsr: 3,
      paidTotalCentsPsr: 160_000,
    });
    expect(await read.listPsrReconciliation(readActor, importId)).toHaveLength(5);
  });

  it("a malformed file ends parse_failed with a PHI-free, line-numbered error", async () => {
    const bad = `MBI,Paid Amount\n${MBI1},not-money\n`;
    const { importId: badId } = await write().importPsr(actorA, periodA, importInput(bad));
    const out = await reconcilePsrImport(deps(), ORG_A, badId);
    // every data row is bad ⇒ the file is rejected (never reconciled on nothing)
    const parseError = "all_rows_quarantined; line 2: invalid_paid_amount";
    expect(out).toEqual({ status: "parse_failed", parseError });
    const row = await scalar("SELECT parse_status, parse_error FROM cap_psr_import WHERE id=$1", [
      badId,
    ]);
    expect(row).toEqual({ parse_status: "parse_failed", parse_error: parseError });
    expect(
      (
        await scalar("SELECT count(*)::int n FROM cap_psr_reconciliation WHERE psr_import_id=$1", [
          badId,
        ])
      ).n,
    ).toBe(0);
  });

  const fillers = ["5GH4TE5MK71", "6JK4TE5MK72", "7MN4TE5MK73"].map((m) => `${m},0.00`);
  const importCsv = async (rows: string[]) => {
    const { importId: id } = await write().importPsr(
      actorA,
      periodA,
      importInput(["MBI,Paid Amount", ...rows].join("\n")),
    );
    return id;
  };
  const raised = async (id: string) =>
    (
      await admin.query(
        "SELECT scope, patient_id, variance_cents FROM cap_psr_reconciliation WHERE psr_import_id=$1 ORDER BY scope",
        [id],
      )
    ).rows.map((r) => [
      r.scope,
      r.patient_id,
      r.variance_cents === null ? null : Number(r.variance_cents),
    ]);

  it("a malformed row with a readable MBI is quarantined: file reconciles, that beneficiary is flagged, no false variance", async () => {
    // P2's row has an unparseable amount. Zero-filled it would raise a false −$500 line for P2.
    const id = await importCsv([`${MBI1},1000.00`, `${MBI2},oops`, `${MBI3},300.00`, ...fillers]);
    const out = await reconcilePsrImport(deps(), ORG_A, id);
    expect(out).toEqual({
      status: "reconciled",
      rowsQuarantined: 1,
      lineCount: 0,
      totalVarianceCents: 0,
    });
    expect(await raised(id)).toEqual([]);
    const imp = await scalar("SELECT * FROM cap_psr_import WHERE id=$1", [id]);
    expect(imp.parse_status).toBe("reconciled");
    expect(imp.rows_quarantined).toBe(1);
    expect(imp.beneficiary_count_psr).toBe(5); // the quarantined row is excluded from the totals
    expect(Number(imp.paid_total_cents_psr)).toBe(130_000);
    expect(imp.quarantine_detail).toEqual({
      lines: [{ line: 3, code: "invalid_paid_amount" }],
      truncated: false,
      flaggedBeneficiaries: 1,
      unattributableRows: 0,
    });
    expect(JSON.stringify(imp)).not.toContain(MBI2); // no PHI in the persisted quarantine summary
    const view = await buildDrizzleM26ReadService(handle.db).getPsrImport(
      { organizationId: ORG_A, userId: USER, roles: [] },
      id,
    );
    expect(view?.rowsQuarantined).toBe(1);
    expect(view?.quarantineDetail?.lines).toEqual([{ line: 3, code: "invalid_paid_amount" }]);
  });

  it("a row whose MBI is unreadable is counted only; the lines it could explain are suppressed, real mismatches still raised", async () => {
    const id = await importCsv([
      `${MBI1},900.00`,
      "NOT-AN-MBI,50.00",
      `${MBI3},300.00`,
      ...fillers,
    ]);
    const out = await reconcilePsrImport(deps(), ORG_A, id);
    expect(out).toMatchObject({ status: "reconciled", rowsQuarantined: 1, lineCount: 1 });
    // P1 is a genuine −$100; P2 (ledger-only) and the agency aggregate are NOT raised as false variances
    expect(await raised(id)).toEqual([["beneficiary", P1, -10_000]]);
    const imp = await scalar("SELECT quarantine_detail FROM cap_psr_import WHERE id=$1", [id]);
    expect(imp.quarantine_detail).toMatchObject({
      lines: [{ line: 3, code: "invalid_mbi" }],
      flaggedBeneficiaries: 0,
      unattributableRows: 1,
    });
  });

  it("over 20% of rows quarantined ends parse_failed with the count recorded and nothing reconciled", async () => {
    const id = await importCsv([
      `${MBI1},1000.00`,
      `${MBI2},x`,
      `${MBI3},y`,
      "BAD,1.00",
      ...fillers,
    ]);
    const out = await reconcilePsrImport(deps(), ORG_A, id);
    expect(out.status).toBe("parse_failed");
    const imp = await scalar("SELECT * FROM cap_psr_import WHERE id=$1", [id]);
    expect(imp.parse_status).toBe("parse_failed");
    expect(String(imp.parse_error).startsWith("quarantine_ceiling_exceeded; line 3:")).toBe(true);
    expect(String(imp.parse_error)).not.toContain(MBI2);
    expect(imp.rows_quarantined).toBe(3);
    expect(await raised(id)).toEqual([]);
  });

  it("cross-tenant: org B cannot see, reconcile or read-through org A's import (as wardenx_app)", async () => {
    const read = buildDrizzleM26ReadService(handle.db);
    const readB = { organizationId: ORG_B, userId: USER, roles: [] };
    expect(await read.getPsrImport(readB, importId)).toBeNull();
    expect(await read.listPsrReconciliation(readB, importId)).toEqual([]);
    expect(await reconcilePsrImport(deps(), ORG_B, importId)).toEqual({ status: "missing" });
    const visibleToB = await withOrgContext(handle.db, readB, (tx) =>
      tx.select({ id: schema.capPsrImport.id }).from(schema.capPsrImport),
    );
    expect(visibleToB).toEqual([]);
    // org B importing against org A's period is rejected (period not visible under B's RLS)
    await expect(write().importPsr(actorB, periodA, importInput(VARIANCE_CSV))).rejects.toThrow(
      /cap period not found/,
    );
    void periodB;
  });
  it("the existing M26 crons run audited writes as the NULL system actor (no audit_event actor FK violation)", async () => {
    // Before: the crons put a fixed worker uuid (…0e6) into app.user_id, which is not a seeded "user"; the
    // audit trigger's actor FK (audit_event_actor_user_id_user_id_fk) rejected every audited write they made.
    // Now the sentinel is stamped on authored rows (closed_by, no FK) only and orgContextFor maps it to NULL.
    const { buildStores } = await import("../src/modules/26-cap/jobs/index");
    const { M26_WORKER_SYSTEM_USER_ID } = await import("../src/modules/26-cap/system-actor");
    const stores = buildStores(handle.db);
    const stalePeriod = await seedPeriod(ORG_A, "FY2024");

    await stores.projection.recompute(ORG_A, periodA); // nightly projection: audited projection writes
    await stores.close.close(ORG_A, stalePeriod); // cap-year close: audited cap_period UPDATE

    expect((await scalar("SELECT status FROM cap_period WHERE id=$1", [stalePeriod])).status).toBe(
      "in_settlement",
    );
    expect(
      (await scalar("SELECT closed_by FROM cap_period WHERE id=$1", [stalePeriod])).closed_by,
    ).toBe(M26_WORKER_SYSTEM_USER_ID); // authored-by sentinel (logical uuid, no FK) — never the audit actor
    const audit = await scalar(
      `SELECT count(*)::int n, count(*) FILTER (WHERE actor_user_id IS NULL)::int nulls
         FROM audit_event WHERE resource_kind='cap_period' AND resource_id=$1 AND event_type='cap_period.update'`,
      [stalePeriod],
    );
    expect(audit.n).toBeGreaterThan(0);
    expect(audit.nulls).toBe(audit.n); // recorded as the NULL system actor
  });
});
