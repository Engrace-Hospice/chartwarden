/**
 * GAP-073 — M25 manual match + adjustment override, proven against real Postgres + RLS as the NOBYPASSRLS
 * app role: a random claim id is a 404 and writes nothing; a claim on another provider entity is the same
 * 404; a valid match binds + posts the line, emits `claim_paid` through the real catalog-validating
 * publisher and records the rationale in the audit trail; a replay is a no-op; an override of a flagged
 * adjustment takes effect (write-off / PR ledger / denial case) exactly once.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bunx vitest run apps/backend/__tests__/m25-manual-match.live.test.ts
 * (SUPERUSER to a THROWAWAY db — this file DROPs and recreates the public schema.)
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repositories } from "@chartwarden/billing";
import { type DbClient, createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import type { M25WriteActor } from "../src/modules/25-remittance/routes/actor";
import type { WriteOutboxPort } from "../src/modules/25-remittance/routes/write-service";
import { buildDrizzleM25WriteService } from "../src/modules/25-remittance/routes/write-service-drizzle";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "packages", "db", "migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const REASON = "Matched by hand against the payer portal claim number and the DOS range.";
const LONG_REASON = `${REASON} Reviewed the OA adjustment and the remark codes before reclassifying.`;

describe.skipIf(!DB_URL)("M25 manual match + adjustment override — LIVE Postgres (GAP-073)", () => {
  let admin: Client;
  let handle: { db: DbClient; close: () => Promise<void> };
  let pe = "";
  let peOther = "";
  let member = "";
  let userId = "";
  let claimIndex = 0;

  const actor = (scope?: readonly string[]): M25WriteActor => ({
    organizationId: ORG,
    userId,
    roles: ["billing_manager"],
    membershipId: member,
    stepUpRecent: true,
    providerEntityScope: scope,
  });

  const service = () => {
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M25_OUTBOX_EVENTS]));
    const outbox: WriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m25" }),
    };
    return buildDrizzleM25WriteService(handle.db, outbox);
  };

  async function seedClaim(providerEntityId: string): Promise<string> {
    const month = 1 + claimIndex++;
    const claim = await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
      new repositories.ClaimRepository(tx).create({
        organizationId: ORG,
        providerEntityId,
        patientId: PATIENT,
        admissionId: ADMISSION,
        electionPeriodIdFrom: crypto.randomUUID(),
        electionPeriodIdTo: crypto.randomUUID(),
        patientPayerId: crypto.randomUUID(),
        tob: "812",
        serviceFrom: `2026-${String(month).padStart(2, "0")}-01`,
        serviceTo: `2026-${String(month).padStart(2, "0")}-28`,
        claimControlNumber: `CCN-M73-${month}`,
        payerClaimControlNumber: null,
        macJurisdiction: "ngs_j6",
        sequestrationAppliedPct: "2.00",
        sequestrationPolicyId: crypto.randomUUID(),
        createdByMembershipId: crypto.randomUUID(),
      }),
    );
    return claim.id;
  }

  /** One advice + one unmatched line (+ one flagged OA adjustment on it). */
  async function seedLine(opts: { charge: string; paid: string }) {
    const n = claimIndex++;
    const advice = (
      await admin.query(
        `INSERT INTO remittance_advice (organization_id, provider_entity_id, payer_id, payer_kind,
           interchange_control_number, transaction_set_control_number, payment_method, total_payment_amount,
           production_date, minio_object_key, file_sha256, parse_status)
         VALUES ($1,$2,$3,'medicare',$4,$5,'eft',$6, now(),'k',$7,'partial_posted') RETURNING id, received_at`,
        [
          ORG,
          pe,
          crypto.randomUUID(),
          `${900000000 + n}`,
          `${100000 + n}`,
          opts.paid,
          `${n}`.padStart(64, "0"),
        ],
      )
    ).rows[0];
    const line = (
      await admin.query(
        `INSERT INTO remittance_line (organization_id, remittance_advice_id, clp02_status_code,
           clp03_total_charge_amount, clp04_total_payment_amount, match_state, received_at)
         VALUES ($1,$2,1,$3,$4,'unmatched',$5) RETURNING id`,
        [ORG, advice.id, opts.charge, opts.paid, advice.received_at],
      )
    ).rows[0].id as string;
    const adjustment = (
      await admin.query(
        `INSERT INTO remittance_adjustment (organization_id, remittance_line_id, cas_group_code,
           cas_reason_code, adjustment_amount, post_action, taxonomy_status, received_at)
         VALUES ($1,$2,'OA','23',25.00,'flagged_review','mapped',$3) RETURNING id`,
        [ORG, line, advice.received_at],
      )
    ).rows[0].id as string;
    return { adviceId: advice.id as string, lineId: line, adjustmentId: adjustment };
  }

  const lineRow = async (id: string) =>
    (
      await admin.query(
        "SELECT match_state, match_strategy, claim_id FROM remittance_line WHERE id=$1",
        [id],
      )
    ).rows[0];
  const events = async (aggregateId: string) =>
    (
      await admin.query(
        "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
        [aggregateId],
      )
    ).rows.map((r) => r.event_type as string);

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
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    userId = (await admin.query(`INSERT INTO "user" (email) VALUES ('m73@x.test') RETURNING id`))
      .rows[0].id as string;
    member = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userId, ORG],
      )
    ).rows[0].id as string;
    const mkPe = async (tag: string) =>
      (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [ORG, `CCN-M73-${tag}`, `M73 ${tag}`, `NPI-M73-${tag}`],
        )
      ).rows[0].id as string;
    pe = await mkPe("A");
    peOther = await mkPe("B");
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
  }, 180_000);

  afterAll(async () => {
    if (handle) await handle.close();
    if (admin) await admin.end();
  });

  it("a random claim id is a 404 and the line stays unmatched", async () => {
    const { lineId } = await seedLine({ charge: "100.00", paid: "100.00" });
    await expect(
      service().manualMatch(actor(), lineId, {
        proposedClaimId: crypto.randomUUID(),
        reason: REASON,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await lineRow(lineId)).match_state).toBe("unmatched");
    expect(await events(lineId)).toEqual([]);
  });

  it("a claim on another provider entity is the same 404", async () => {
    const { lineId } = await seedLine({ charge: "100.00", paid: "100.00" });
    const foreign = await seedClaim(peOther);
    await expect(
      service().manualMatch(actor(), lineId, { proposedClaimId: foreign, reason: REASON }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect((await lineRow(lineId)).match_state).toBe("unmatched");
  });

  it("an actor scoped to another provider entity cannot see the line", async () => {
    const { lineId } = await seedLine({ charge: "100.00", paid: "100.00" });
    const claimId = await seedClaim(pe);
    await expect(
      service().manualMatch(actor([peOther]), lineId, { proposedClaimId: claimId, reason: REASON }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("a valid match binds + posts the line, emits claim_paid, audits the rationale, and replays as a no-op", async () => {
    const { lineId, adviceId } = await seedLine({ charge: "100.00", paid: "100.00" });
    const claimId = await seedClaim(pe);
    const svc = service();
    const first = await svc.manualMatch(actor(), lineId, {
      proposedClaimId: claimId,
      reason: REASON,
    });
    expect(first.matchState).toBe("posted");
    expect(await lineRow(lineId)).toMatchObject({
      match_state: "posted",
      match_strategy: "manual",
      claim_id: claimId,
    });
    expect(await events(lineId)).toEqual([
      "m25.remittance.claim_paid",
      "m25.remittance.manual_match_recorded",
    ]);
    const audit = await admin.query(
      "SELECT context FROM audit_event WHERE event_type='m25.remittance.manual_match' AND resource_id=$1",
      [lineId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].context.reason).toBe(REASON);
    const advice = await admin.query("SELECT parse_status FROM remittance_advice WHERE id=$1", [
      adviceId,
    ]);
    expect(advice.rows[0].parse_status).toBe("posted");

    const replay = await svc.manualMatch(actor(), lineId, {
      proposedClaimId: claimId,
      reason: REASON,
    });
    expect(replay.matchState).toBe("posted");
    expect(await events(lineId)).toHaveLength(2);
  });

  it("override: write-off, PR ledger and denial seed each take effect once, with the reason audited", async () => {
    const svc = service();
    const a = await seedLine({ charge: "100.00", paid: "75.00" });
    await svc.overrideAdjustment(actor(), a.adjustmentId, {
      newPostAction: "auto_posted",
      reason: LONG_REASON,
    });
    expect(
      (
        await admin.query("SELECT post_action FROM remittance_adjustment WHERE id=$1", [
          a.adjustmentId,
        ])
      ).rows[0].post_action,
    ).toBe("auto_posted");

    const b = await seedLine({ charge: "100.00", paid: "75.00" });
    await expect(
      svc.overrideAdjustment(actor(), b.adjustmentId, {
        newPostAction: "ledger_recorded",
        reason: LONG_REASON,
      }),
    ).rejects.toMatchObject({ statusCode: 409 }); // unmatched line: no resolvable patient
    await svc.manualMatch(actor(), b.lineId, {
      proposedClaimId: await seedClaim(pe),
      reason: REASON,
    });
    await svc.overrideAdjustment(actor(), b.adjustmentId, {
      newPostAction: "ledger_recorded",
      reason: LONG_REASON,
    });
    await svc.overrideAdjustment(actor(), b.adjustmentId, {
      newPostAction: "ledger_recorded",
      reason: LONG_REASON,
    });
    const ledger = await admin.query(
      "SELECT patient_id, pr_amount FROM patient_responsibility_ledger WHERE remittance_adjustment_id=$1",
      [b.adjustmentId],
    );
    expect(ledger.rows).toHaveLength(1);
    expect(ledger.rows[0].patient_id).toBe(PATIENT);

    const c = await seedLine({ charge: "100.00", paid: "75.00" });
    await svc.overrideAdjustment(actor(), c.adjustmentId, {
      newPostAction: "denial_seeded",
      reason: LONG_REASON,
    });
    const denials = await admin.query(
      "SELECT id FROM denial_case WHERE remittance_adjustment_id=$1",
      [c.adjustmentId],
    );
    expect(denials.rows).toHaveLength(1);
    const audits = await admin.query(
      "SELECT context FROM audit_event WHERE event_type='m25.remittance.adjustment_override' AND resource_id=$1",
      [c.adjustmentId],
    );
    expect(audits.rows[0].context.reason).toBe(LONG_REASON);
  });
});
