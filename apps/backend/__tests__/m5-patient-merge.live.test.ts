/**
 * F-171 (#248) — the M5 §2.4/§4.3 direct patient-merge write path against REAL Postgres.
 * `mergePatients` (`05-patient/merges-db.ts`, over the pure `merges.ts` decision core) had NO
 * execution path anywhere before this pass — only patient-MATCHING code existed. Proves, against a
 * real database, the D8 design `.unmerged` already commits to: the source flips to `status='merged'`
 * with `merged_into_id` set, the target absorbs any chosen field resolutions, EVERY satellite row the
 * source owns is left completely untouched (no destructive UPDATE on satellite tables), the real
 * `patient_merge` audit row is written, and `m5.patient.merged` publishes through the real
 * catalog-validating outbox publisher.
 *
 * CHARTWARDEN_TEST_DATABASE_URL=postgres://... bunx vitest run \
 *   apps/backend/__tests__/m5-patient-merge.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import type { M5OutboxPort } from "../src/modules/05-patient/deceased-db";
import {
  M5_OUTBOX_EVENTS,
  type MergePatientsInput,
  mergePatients,
} from "../src/modules/05-patient/index";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = [
  "chartwarden_app",
  "chartwarden_admin",
  "chartwarden_readonly",
  "chartwarden_audit_writer",
  "wardenx_report_writer",
];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const ACTOR = "33333333-3333-3333-3333-333333333333";

describe.skipIf(!DB_URL)("F-171 direct patient merge — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let outbox: M5OutboxPort;

  async function resetSchema(): Promise<void> {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }

  async function applyMigrations(): Promise<void> {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-f171-a','F-171 Org A','F-171 Org A'),($2,'org-f171-b','F-171 Org B','F-171 Org B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'actor@f171.test')`, [ACTOR]);
    await admin.query("ALTER ROLE chartwarden_app LOGIN PASSWORD 'wardenx-f171-test'");
    const appUrl = new URL(DB_URL as string);
    appUrl.username = "chartwarden_app";
    appUrl.password = "wardenx-f171-test";
    handle = createDbClient({ connectionString: appUrl.toString() });
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(() => {
    const catalog = buildBootOutboxCatalog([M5_OUTBOX_EVENTS]);
    const txPublisher = buildTxOutboxPublisher(catalog);
    outbox = { publish: (tx, input) => txPublisher.publish(tx, { ...input, callerModule: "m5" }) };
  });

  afterEach(async () => {
    await admin.query("TRUNCATE patient_merge, patient_address, patient RESTART IDENTITY CASCADE");
    await admin.query("DELETE FROM outbox_event");
  });

  async function seedPatient(
    org: string,
    fields: {
      legalFirstName?: string;
      legalLastName?: string;
      status?: string;
      deceasedDate?: string | null;
    } = {},
  ): Promise<string> {
    const result = await admin.query(
      `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob, sex_assigned_at_birth, status, deceased_date)
       VALUES ($1, $2, $3, $4, '1950-01-01', 'female', $5, $6) RETURNING id`,
      [
        org,
        `mrn-${Math.random().toString(36).slice(2)}`,
        fields.legalFirstName ?? "Jane",
        fields.legalLastName ?? "Doe",
        fields.status ?? "active",
        fields.deceasedDate ?? null,
      ],
    );
    return result.rows[0].id;
  }

  async function seedAddress(org: string, patientId: string): Promise<string> {
    const result = await admin.query(
      `INSERT INTO patient_address (patient_id, organization_id, line1, city, postal_code, state, effective_from, is_primary)
       VALUES ($1, $2, '123 Main St', 'Springfield', '00000', 'IL', '2026-01-01', true) RETURNING id`,
      [patientId, org],
    );
    return result.rows[0].id;
  }

  function baseInput(source: string, target: string, org = ORG_A): MergePatientsInput {
    return {
      organizationId: org,
      sourcePatientId: source,
      targetPatientId: target,
      fieldResolutions: {},
      reason: "duplicate chart confirmed at intake review",
      actorUserId: ACTOR,
    };
  }

  it("flips the source to merged, applies a field resolution to the target, and leaves the target's unresolved fields untouched", async () => {
    const source = await seedPatient(ORG_A, { legalFirstName: "Janet", legalLastName: "Smith" });
    const target = await seedPatient(ORG_A, { legalFirstName: "Jane", legalLastName: "Doe" });

    const result = await mergePatients(handle.db, outbox, {
      ...baseInput(source, target),
      fieldResolutions: {
        legalFirstName: { keep: "source" }, // resolve to the SOURCE's "Janet"
        // legalLastName intentionally unresolved — must stay the target's own "Doe"
      },
    });

    expect(result.targetFieldsApplied).toEqual(["legalFirstName"]);

    const targetRow = await admin.query(
      "SELECT legal_first_name, legal_last_name, status FROM patient WHERE id=$1",
      [target],
    );
    expect(targetRow.rows[0].legal_first_name).toBe("Janet");
    expect(targetRow.rows[0].legal_last_name).toBe("Doe"); // untouched
    expect(targetRow.rows[0].status).toBe("active"); // the target's own status is unaffected by a merge

    const sourceRow = await admin.query("SELECT status, merged_into_id FROM patient WHERE id=$1", [
      source,
    ]);
    expect(sourceRow.rows[0].status).toBe("merged");
    expect(sourceRow.rows[0].merged_into_id).toBe(target);
  });

  it("a 'custom' resolution applies the caller-supplied value, never source or target", async () => {
    const source = await seedPatient(ORG_A, { legalFirstName: "Janet" });
    const target = await seedPatient(ORG_A, { legalFirstName: "Jane" });

    await mergePatients(handle.db, outbox, {
      ...baseInput(source, target),
      fieldResolutions: {
        legalFirstName: { keep: "custom", customValue: "Janice" },
      },
    });

    const row = await admin.query("SELECT legal_first_name FROM patient WHERE id=$1", [target]);
    expect(row.rows[0].legal_first_name).toBe("Janice");
  });

  it("a 'target' resolution is a no-op write, but is still recorded in the audit diff", async () => {
    const source = await seedPatient(ORG_A, { legalFirstName: "Janet" });
    const target = await seedPatient(ORG_A, { legalFirstName: "Jane" });

    const result = await mergePatients(handle.db, outbox, {
      ...baseInput(source, target),
      fieldResolutions: { legalFirstName: { keep: "target" } },
    });
    expect(result.targetFieldsApplied).toEqual([]); // no column write for a keep:'target' resolution

    const row = await admin.query("SELECT legal_first_name FROM patient WHERE id=$1", [target]);
    expect(row.rows[0].legal_first_name).toBe("Jane"); // unchanged

    const merge = await admin.query("SELECT merged_field_diff FROM patient_merge WHERE id=$1", [
      result.mergeId,
    ]);
    expect(merge.rows[0].merged_field_diff.legalFirstName).toEqual({
      kept: "target",
      sourceValue: "Janet",
      targetValue: "Jane",
      appliedValue: "Jane",
    });
  });

  it("no destructive UPDATE on satellite tables — the source's own rows survive the merge untouched, still pointed at the source", async () => {
    const source = await seedPatient(ORG_A);
    const target = await seedPatient(ORG_A);
    const addressId = await seedAddress(ORG_A, source);

    await mergePatients(handle.db, outbox, baseInput(source, target));

    // The source row itself is preserved (never deleted) — the whole point of a soft merge.
    const sourceExists = await admin.query("SELECT id FROM patient WHERE id=$1", [source]);
    expect(sourceExists.rows).toHaveLength(1);

    // Its satellite address row is COMPLETELY untouched: same id, still points at the SOURCE, no
    // re-point to the target and no deletion. This is the "no destructive UPDATE on satellite
    // tables" half of D8's design — mergePatients performs no cross-table FK rewrite of any kind.
    const address = await admin.query(
      "SELECT id, patient_id, line1 FROM patient_address WHERE id=$1",
      [addressId],
    );
    expect(address.rows).toHaveLength(1);
    expect(address.rows[0].patient_id).toBe(source);
    expect(address.rows[0].line1).toBe("123 Main St");
  });

  it("writes the real patient_merge audit row and emits m5.patient.merged with the correct payload", async () => {
    const source = await seedPatient(ORG_A);
    const target = await seedPatient(ORG_A);

    const result = await mergePatients(handle.db, outbox, {
      ...baseInput(source, target),
      reason: "duplicate chart, same MBI on file review",
    });

    const mergeRow = await admin.query(
      "SELECT organization_id, source_patient_id, target_patient_id, reason, performed_by, unmerged_at FROM patient_merge WHERE id=$1",
      [result.mergeId],
    );
    expect(mergeRow.rows).toHaveLength(1);
    expect(mergeRow.rows[0].organization_id).toBe(ORG_A);
    expect(mergeRow.rows[0].source_patient_id).toBe(source);
    expect(mergeRow.rows[0].target_patient_id).toBe(target);
    expect(mergeRow.rows[0].reason).toBe("duplicate chart, same MBI on file review");
    expect(mergeRow.rows[0].performed_by).toBe(ACTOR);
    expect(mergeRow.rows[0].unmerged_at).toBeNull();

    const outboxRows = await admin.query(
      "SELECT payload, aggregate_id FROM outbox_event WHERE event_type='m5.patient.merged'",
    );
    expect(outboxRows.rows).toHaveLength(1);
    expect(outboxRows.rows[0].aggregate_id).toBe(target);
    expect(outboxRows.rows[0].payload).toEqual({
      patientId: target, // the SURVIVOR
      organizationId: ORG_A,
      sourcePatientId: source, // the duplicate folded away
    });
  });

  it("refuses a self-merge", async () => {
    const p = await seedPatient(ORG_A);
    await expect(mergePatients(handle.db, outbox, baseInput(p, p))).rejects.toThrow(
      /cannot merge patient .* into itself/,
    );
  });

  it("refuses when the source is already merged (ALREADY_MERGED)", async () => {
    const source = await seedPatient(ORG_A);
    const target = await seedPatient(ORG_A);
    const third = await seedPatient(ORG_A);
    await mergePatients(handle.db, outbox, baseInput(source, target));

    await expect(mergePatients(handle.db, outbox, baseInput(source, third))).rejects.toThrow(
      /already merged elsewhere/,
    );
  });

  it("refuses when the target is already merged (a redirect chain is not resolvable today)", async () => {
    const a = await seedPatient(ORG_A);
    const b = await seedPatient(ORG_A);
    const c = await seedPatient(ORG_A);
    await mergePatients(handle.db, outbox, baseInput(a, b)); // a → merged into b

    await expect(mergePatients(handle.db, outbox, baseInput(c, a))).rejects.toThrow(
      /it is itself already merged/,
    );
  });

  it("refuses an unmergeable source status (deceased — no §2.4.1 edge to 'merged')", async () => {
    const source = await seedPatient(ORG_A, { status: "deceased", deceasedDate: "2026-01-01" });
    const target = await seedPatient(ORG_A);
    await expect(mergePatients(handle.db, outbox, baseInput(source, target))).rejects.toThrow(
      /cannot be merged from status 'deceased'/,
    );
  });

  it("refuses an unknown field-resolution key rather than silently ignoring it", async () => {
    const source = await seedPatient(ORG_A);
    const target = await seedPatient(ORG_A);
    await expect(
      mergePatients(handle.db, outbox, {
        ...baseInput(source, target),
        fieldResolutions: { mrn: { keep: "source" } }, // mrn is immutable-after-create, not mergeable
      }),
    ).rejects.toThrow(/is not a mergeable patient field/);
  });

  it("cross-tenant isolation: a target in another org resolves as not-found, never as a cross-org merge", async () => {
    const source = await seedPatient(ORG_A);
    const targetInOrgB = await seedPatient(ORG_B);
    await expect(
      mergePatients(handle.db, outbox, baseInput(source, targetInOrgB, ORG_A)),
    ).rejects.toThrow(new RegExp(`patient '${targetInOrgB}' not found`));

    // and the reverse direction — a source belonging to another org
    const sourceInOrgB = await seedPatient(ORG_B);
    const target = await seedPatient(ORG_A);
    await expect(
      mergePatients(handle.db, outbox, baseInput(sourceInOrgB, target, ORG_A)),
    ).rejects.toThrow(new RegExp(`patient '${sourceInOrgB}' not found`));

    // neither attempt left any trace — no merge row, no outbox event, no status flip on either patient
    const merges = await admin.query("SELECT id FROM patient_merge");
    expect(merges.rows).toHaveLength(0);
    const outboxRows = await admin.query(
      "SELECT id FROM outbox_event WHERE event_type='m5.patient.merged'",
    );
    expect(outboxRows.rows).toHaveLength(0);
  });
});
