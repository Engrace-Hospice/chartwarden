/**
 * M25 TPE program tracker (hospice ADR/TPE/QIC PRD, milestone 5) - LIVE Postgres as the NOBYPASSRLS `chartwarden_app`
 * role, through the real service, the real M23 claim seam and the real route plugin.
 *
 * Proves what the pure suites cannot: no threshold exists until the organization records one and a round keeps the
 * threshold in force when its results were recorded (a later rule edit never rewrites it); the database refuses a 4th
 * round, a closed program's changes, an illegal edge, a rewritten outcome and an UPDATE of the anchor columns; a
 * sampled claim or ADR from another tenant, another provider entity or another claim is a 404; FORCEd RLS isolates
 * tenants and the app role cannot delete; migration 1119 grants the new keys to existing roles; every write and the
 * detail read leave an audit row; and the routes gate on the new permission keys.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:tpe:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { repositories } from "@chartwarden/billing";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { buildServer } from "../src/bootstrap/index";
import { buildDrizzleTpeService } from "../src/modules/25-remittance/routes/tpe-service";
import { registerTpeRoutes } from "../src/modules/25-remittance/routes/tpe.routes";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const TPE_TABLES = ["tpe_mac_rule", "tpe_program", "tpe_round", "tpe_round_claim"];
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

describe.skipIf(!DB_URL)("M25 TPE program tracker - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let pe1 = "";
  let pe2 = "";
  let peB = "";
  let claim1 = "";
  let claim1b = "";
  let claim2 = "";
  let claimB = "";
  let userA = "";
  let memberA = "";
  let macSeq = 0;

  const actorOf = (organizationId = ORG, scope?: readonly string[]) => ({
    organizationId,
    userId: userA,
    membershipId: memberA,
    roles: ["billing_manager"],
    stepUpRecent: true,
    ...(scope ? { providerEntityScope: scope } : {}),
  });
  const A = () => actorOf();
  const svc = () =>
    buildDrizzleTpeService(handle.db, {
      providerEntityExists: async (tx, organizationId, providerEntityId) =>
        (await buildFoundationSiteReader().providerEntityIdentifiers(
          tx as never,
          organizationId,
          providerEntityId,
        )) !== null,
    });
  const refused = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; message?: string; statusCode?: number }) => e,
    );
  // drizzle wraps the driver error, so the database's own message is on the cause
  const dbMessage = async (p: Promise<unknown>): Promise<string> =>
    p.then(
      () => "",
      (e: { cause?: { message?: string }; message?: string }) =>
        e.cause?.message ?? e.message ?? "",
    );
  const asApp = <T>(fn: (tx: Parameters<Parameters<typeof withOrgContext>[2]>[0]) => Promise<T>) =>
    withOrgContext(handle.db, { organizationId: ORG, userId: userA }, fn as never) as Promise<T>;
  const pver = async (id: string) =>
    Number(
      (await admin.query("SELECT version FROM tpe_program WHERE id=$1", [id])).rows[0].version,
    );
  const rver = async (id: string) =>
    Number((await admin.query("SELECT version FROM tpe_round WHERE id=$1", [id])).rows[0].version);
  const prow = async (id: string) =>
    (await admin.query("SELECT * FROM tpe_program WHERE id=$1", [id])).rows[0];
  const rrow = async (id: string) =>
    (await admin.query("SELECT * FROM tpe_round WHERE id=$1", [id])).rows[0];

  async function mkClaim(org: string, providerEntityId: string, ccn: string): Promise<string> {
    return (
      await withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
        new repositories.ClaimRepository(tx).create({
          organizationId: org,
          providerEntityId,
          patientId: randomUUID(),
          admissionId: randomUUID(),
          electionPeriodIdFrom: randomUUID(),
          electionPeriodIdTo: randomUUID(),
          patientPayerId: randomUUID(),
          tob: "811",
          serviceFrom: "2026-03-01",
          serviceTo: "2026-03-31",
          claimControlNumber: ccn,
          payerClaimControlNumber: null,
          macJurisdiction: "ngs_j6",
          sequestrationAppliedPct: "2.00",
          sequestrationPolicyId: randomUUID(),
          createdByMembershipId: randomUUID(),
          totalChargeCents: 100_000,
        }),
      )
    ).id;
  }
  async function mkAdr(org: string, peId: string, claimId: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO adr_case (organization_id, provider_entity_id, claim_id, mac_name, review_type, requested_on,
           window_days, window_source, response_due_at)
         VALUES ($1,$2,$3,'CGS','adr',CURRENT_DATE,45,'org_rule', now() + interval '30 days') RETURNING id`,
        [org, peId, claimId],
      )
    ).rows[0].id as string;
  }
  /** A fresh active program on its own MAC (one active program per provider entity and MAC). */
  async function newProgram(peId = pe1, openedOn = daysAgo(200)) {
    const macName = `MAC-${++macSeq}`;
    const { id } = await svc().createProgram(A(), {
      providerEntityId: peId,
      macName,
      openedOn,
    });
    return { id, macName };
  }
  /** Round `n` recorded with results and education, so the next round may start. */
  async function completeRound(
    programId: string,
    noticeOn: string,
    resultsOn: string,
    edu: string,
    rate = 30,
  ) {
    const r = await svc().createRound(A(), programId, noticeOn, await pver(programId));
    await svc().setResults(
      A(),
      r.id,
      { resultsOn, macErrorRatePct: rate, macResult: "non_compliant" },
      await rver(r.id),
    );
    await svc().setEducation(A(), r.id, { educationOn: edu }, await rver(r.id));
    return r;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    for (const [org, slug] of [
      [ORG, "m25-tpe"],
      [ORG_B, "m25-tpe-b"],
    ])
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'A','A')",
        [org, slug],
      );
    userA = (await admin.query(`INSERT INTO "user" (email) VALUES ('tpe-a@x.test') RETURNING id`))
      .rows[0].id as string;
    memberA = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userA, ORG],
      )
    ).rows[0].id as string;
    const mkPe = async (org: string, tag: string) =>
      (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$2,$3,'enc','12-31') RETURNING id`,
          [org, `CCN-${tag}`, `NPI-${tag}`],
        )
      ).rows[0].id as string;
    pe1 = await mkPe(ORG, "TPE1");
    pe2 = await mkPe(ORG, "TPE2");
    peB = await mkPe(ORG_B, "TPEB");
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    claim1 = await mkClaim(ORG, pe1, "CCN-TPE-0001");
    claim1b = await mkClaim(ORG, pe1, "CCN-TPE-0002");
    claim2 = await mkClaim(ORG, pe2, "CCN-TPE-0003");
    claimB = await mkClaim(ORG_B, peB, "CCN-TPE-0004");
  }, 240_000);

  afterAll(async () => {
    await handle?.close?.();
    await admin?.end();
  });

  it("registers the three permission keys and grants them to existing roles by migration 1119", async () => {
    const keys = (
      await admin.query(
        `SELECT key FROM permission WHERE key IN ('tpe.read','tpe.manage','tpe_rule.manage')`,
      )
    ).rows.map((r) => r.key as string);
    expect(keys.sort()).toEqual(["tpe.manage", "tpe.read", "tpe_rule.manage"]);

    // 1119 ran on an empty tenant set; seed a role holding the appeal keys, then replay it.
    const roleId = (
      await admin.query(
        `INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'tpe-billing','Billing','billing_finance',true) RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    for (const [key, abac] of [
      ["appeal.read", "narrowed_predicate"],
      ["appeal.create", null],
      ["appeal.decide", "other_predicate"],
    ])
      await admin.query(
        `INSERT INTO role_permission (organization_id, role_id, permission_key, abac_override) VALUES ($1,$2,$3,$4)`,
        [ORG, roleId, key, abac],
      );
    const migration = readFileSync(join(MIGRATIONS_DIR, "1119_m25_tpe_role_grants.sql"), "utf8");
    await admin.query(migration);
    await admin.query(migration); // idempotent
    const granted = (
      await admin.query(
        `SELECT permission_key, abac_override FROM role_permission WHERE role_id=$1 AND permission_key LIKE 'tpe%' ORDER BY permission_key`,
        [roleId],
      )
    ).rows;
    expect(granted).toEqual([
      { permission_key: "tpe.manage", abac_override: null },
      { permission_key: "tpe.read", abac_override: "narrowed_predicate" },
      { permission_key: "tpe_rule.manage", abac_override: null },
    ]);
  });

  it("forces RLS on all four tables and gives the app role no DELETE", async () => {
    const forced = (
      await admin.query(
        `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity ORDER BY relname`,
        [TPE_TABLES],
      )
    ).rows.map((r) => r.relname);
    expect(forced).toEqual([...TPE_TABLES].sort());
    const { id } = await newProgram();
    for (const table of TPE_TABLES) {
      const msg = await dbMessage(asApp((tx) => tx.execute(sql.raw(`DELETE FROM ${table}`))));
      expect(msg, table).toMatch(/permission denied/i);
    }
    expect(await prow(id)).toBeTruthy();
  });

  it("seeds no threshold: a MAC with no rule resolves to none, and nothing is assumed", async () => {
    expect(Number((await admin.query("SELECT count(*) FROM tpe_mac_rule")).rows[0].count)).toBe(0);
    const { id } = await newProgram();
    const r = await completeRound(id, daysAgo(100), daysAgo(80), daysAgo(75), 30);
    const detail = await svc().getProgram(A(), id);
    expect(detail?.threshold).toEqual({ pct: null, source: "none", verified: false });
    expect(detail?.aboveThreshold).toBeNull();
    expect(detail?.latestRound?.macErrorRatePct).toBe(30);
    expect((await rrow(r.id)).threshold_source).toBe("none");
  });

  it("snapshots the threshold when results are first recorded and keeps it after a rule edit", async () => {
    const { id, macName } = await newProgram();
    await svc().upsertRule(A(), {
      macName,
      exitErrorRatePct: 20,
      sourceNote: "MAC letter 2026-03",
      effectiveFrom: daysAgo(300),
    });
    const r = await completeRound(id, daysAgo(100), daysAgo(80), daysAgo(75), 30);
    expect(Number((await rrow(r.id)).threshold_pct)).toBe(20);
    expect((await rrow(r.id)).threshold_verified).toBe(false);
    // a lower-case spelling edits the same rule; the round keeps what it saw
    await svc().upsertRule(A(), {
      macName: macName.toLowerCase(),
      exitErrorRatePct: 10,
      verifiedOn: daysAgo(1),
      effectiveFrom: daysAgo(300),
    });
    expect(
      Number(
        (
          await admin.query("SELECT count(*) FROM tpe_mac_rule WHERE lower(mac_name)=$1", [
            macName.toLowerCase(),
          ])
        ).rows[0].count,
      ),
    ).toBe(1);
    const detail = await svc().getProgram(A(), id);
    expect(detail?.rounds[0]?.threshold).toEqual({ pct: 20, source: "org_rule", verified: false });
    expect(detail?.aboveThreshold).toBe(true);
    // correcting the results does not re-snapshot a round that already holds a rule's threshold
    await svc().setResults(
      A(),
      r.id,
      { resultsOn: daysAgo(80), macErrorRatePct: 15, macResult: "compliant" },
      await rver(r.id),
    );
    expect(Number((await rrow(r.id)).threshold_pct)).toBe(20);
    expect((await svc().getProgram(A(), id))?.aboveThreshold).toBe(false);
    const rules = (await svc().listRules(A())).items.filter((x) => x.macName === macName);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.exitErrorRatePct).toBe(10);
    // an update may carry the version it read; a stale one is a 409, and a new rule needs none
    const rule = rules[0] as { version: number };
    const edit = { macName, exitErrorRatePct: 12, effectiveFrom: daysAgo(300) };
    await svc().upsertRule(A(), edit, rule.version);
    expect((await refused(svc().upsertRule(A(), edit, rule.version)))?.code).toBe(
      "VERSION_CONFLICT",
    );
  });

  it("resolves a re-recorded 'none' threshold as of the letter's date, not today", async () => {
    const { id, macName } = await newProgram();
    const r = await completeRound(id, daysAgo(100), daysAgo(80), daysAgo(75), 30);
    expect((await rrow(r.id)).threshold_source).toBe("none");
    const again = async () =>
      svc().setResults(
        A(),
        r.id,
        { resultsOn: daysAgo(80), macErrorRatePct: 30, macResult: "non_compliant" },
        await rver(r.id),
      );
    // a rule that took effect AFTER the letter does not apply to it
    await svc().upsertRule(A(), { macName, exitErrorRatePct: 5, effectiveFrom: daysAgo(10) });
    await again();
    expect((await rrow(r.id)).threshold_source).toBe("none");
    // one in force on the letter's date does
    await svc().upsertRule(A(), { macName, exitErrorRatePct: 25, effectiveFrom: daysAgo(90) });
    await again();
    expect(Number((await rrow(r.id)).threshold_pct)).toBe(25);
  });

  it("validates round and outcome dates against the program and the previous round", async () => {
    const { id } = await newProgram(pe1, daysAgo(100));
    expect((await refused(svc().createRound(A(), id, daysAgo(101), await pver(id))))?.code).toBe(
      "NOTICE_BEFORE_PROGRAM",
    );
    const r1 = await svc().createRound(A(), id, daysAgo(60), await pver(id));
    await svc().setResults(
      A(),
      r1.id,
      { resultsOn: daysAgo(50), macErrorRatePct: 10, macResult: "compliant" },
      await rver(r1.id),
    );
    expect((await refused(svc().createRound(A(), id, daysAgo(70), await pver(id))))?.code).toBe(
      "NOTICE_BEFORE_PREVIOUS_ROUND",
    );
    const out = { kind: "compliant" as const, outcomeOn: daysAgo(101) };
    expect((await refused(svc().recordOutcome(A(), id, out, await pver(id))))?.code).toBe(
      "OUTCOME_BEFORE_PROGRAM",
    );
  });

  it("takes no round writes once an outcome is recorded", async () => {
    const { id } = await newProgram();
    const r = await svc().createRound(A(), id, daysAgo(30), await pver(id));
    await svc().recordOutcome(
      A(),
      id,
      { kind: "compliant", outcomeOn: daysAgo(2) },
      await pver(id),
    );
    const code = async (p: Promise<unknown>) => (await refused(p))?.code;
    expect(
      await code(
        svc().setResults(
          A(),
          r.id,
          { resultsOn: daysAgo(1), macErrorRatePct: 1, macResult: "compliant" },
          await rver(r.id),
        ),
      ),
    ).toBe("TPE_PROGRAM_NOT_ACTIVE");
    expect(
      await code(svc().setEducation(A(), r.id, { educationOn: daysAgo(1) }, await rver(r.id))),
    ).toBe("TPE_PROGRAM_NOT_ACTIVE");
    expect(await code(svc().upsertClaim(A(), r.id, claim1, {}, await rver(r.id)))).toBe(
      "TPE_PROGRAM_NOT_ACTIVE",
    );
    expect(await code(svc().createRound(A(), id, daysAgo(1), await pver(id)))).toBe(
      "TPE_PROGRAM_NOT_ACTIVE",
    );
  });

  it("keeps referral types to a referral and a relief date to a relief, in SQL too", async () => {
    const a = await newProgram();
    expect(
      await dbMessage(
        admin.query(
          "UPDATE tpe_program SET state='compliant', outcome_on=CURRENT_DATE, referral_kinds='{rac}' WHERE id=$1",
          [a.id],
        ),
      ),
    ).toMatch(/tpe_program_compliant_no_referral/);
    const b = await newProgram();
    expect(
      await dbMessage(
        admin.query(
          "UPDATE tpe_program SET state='referred', outcome_on=CURRENT_DATE, referral_kinds='{rac}', relief_until=CURRENT_DATE WHERE id=$1",
          [b.id],
        ),
      ),
    ).toMatch(/tpe_program_referred_no_relief/);
    // the rule key is fixed: only the threshold and its provenance are updatable by the app role
    await svc().upsertRule(A(), { macName: `KEY-${++macSeq}`, exitErrorRatePct: 1 });
    expect(
      await dbMessage(asApp((tx) => tx.execute(sql`UPDATE tpe_mac_rule SET mac_name='x'`))),
    ).toMatch(/permission denied/i);
    expect(
      await dbMessage(
        asApp((tx) => tx.execute(sql`UPDATE tpe_mac_rule SET effective_from=CURRENT_DATE`)),
      ),
    ).toMatch(/permission denied/i);
  });

  it("walks the rounds: previous round must have results, interval and sample warnings, a 4th round is refused", async () => {
    const { id } = await newProgram();
    const r1 = await svc().createRound(A(), id, daysAgo(150), await pver(id));
    expect(r1).toMatchObject({ roundNumber: 1, warnings: [] });
    const open = await refused(svc().createRound(A(), id, daysAgo(100), await pver(id)));
    expect(open?.code).toBe("TPE_PREVIOUS_ROUND_OPEN");
    await svc().setResults(
      A(),
      r1.id,
      { resultsOn: daysAgo(130), macErrorRatePct: 40, macResult: "non_compliant" },
      await rver(r1.id),
    );
    await svc().setEducation(
      A(),
      r1.id,
      { educationOn: daysAgo(125), note: "call with MAC nurse" },
      await rver(r1.id),
    );
    // 30 days after the education: a warning, not a block
    const r2 = await svc().createRound(A(), id, daysAgo(95), await pver(id));
    expect(r2.roundNumber).toBe(2);
    expect(r2.warnings.join(" ")).toMatch(/45 days/);
    await svc().setResults(
      A(),
      r2.id,
      { resultsOn: daysAgo(80), macErrorRatePct: 35, macResult: "non_compliant" },
      await rver(r2.id),
    );
    const r3 = await svc().createRound(A(), id, daysAgo(40), await pver(id));
    expect(r3.roundNumber).toBe(3);
    await svc().setResults(
      A(),
      r3.id,
      { resultsOn: daysAgo(20), macErrorRatePct: 33, macResult: "non_compliant" },
      await rver(r3.id),
    );
    const fourth = await refused(svc().createRound(A(), id, daysAgo(10), await pver(id)));
    expect(fourth?.code).toBe("TPE_ROUND_LIMIT");
    // the database refuses a 4th round even around the service
    const msg = await dbMessage(
      admin.query(
        `INSERT INTO tpe_round (organization_id, tpe_program_id, round_number, notice_on) VALUES ($1,$2,4,CURRENT_DATE)`,
        [ORG, id],
      ),
    );
    expect(msg).toMatch(/round_number|check/i);
    const detail = await svc().getProgram(A(), id);
    expect(detail).toMatchObject({
      currentRound: 3,
      roundsRecorded: 3,
      maxRounds: 3,
      risk: "high",
    });
    expect(detail?.nextRoundEarliest).toBeNull();
    expect(detail?.rounds[1]?.warnings.some((w) => /45 days/.test(w))).toBe(true);
    // an empty sample is not warned about; only a started sample outside 20 to 40 is
    expect(detail?.rounds[0]?.warnings.some((w) => /claims sampled/.test(w))).toBe(false);
    expect(detail?.rounds[0]?.educationNote).toBe("call with MAC nurse");
  });

  it("derives the earliest next round from the education date and rejects bad dates", async () => {
    const { id } = await newProgram(pe1, "2025-11-01");
    const r1 = await svc().createRound(A(), id, "2025-12-01", await pver(id));
    await svc().setResults(
      A(),
      r1.id,
      { resultsOn: "2025-12-15", macErrorRatePct: null, macResult: "compliant" },
      await rver(r1.id),
    );
    expect((await svc().getProgram(A(), id))?.nextRoundEarliest).toBeNull();
    await svc().setEducation(A(), r1.id, { educationOn: "2026-01-01" }, await rver(r1.id));
    const detail = await svc().getProgram(A(), id);
    expect(detail?.nextRoundEarliest).toBe("2026-02-15");
    expect(detail?.risk).toBe("low");
    expect((await refused(svc().createRound(A(), id, "2026-02-30", await pver(id))))?.code).toBe(
      "INVALID_NOTICE_DATE",
    );
    expect(
      (
        await refused(
          svc().setResults(
            A(),
            r1.id,
            { resultsOn: "2025-11-01", macErrorRatePct: 5, macResult: "compliant" },
            await rver(r1.id),
          ),
        )
      )?.code,
    ).toBe("RESULTS_BEFORE_NOTICE");
    expect(
      (
        await refused(
          svc().setResults(
            A(),
            r1.id,
            { resultsOn: "2025-12-15", macErrorRatePct: 12.345, macResult: "compliant" },
            await rver(r1.id),
          ),
        )
      )?.code,
    ).toBe("INVALID_ERROR_RATE");
  });

  it("refuses a second active program for the same provider entity and MAC, case-insensitively", async () => {
    const { macName } = await newProgram();
    const dup = await refused(
      svc().createProgram(A(), {
        providerEntityId: pe1,
        macName: ` ${macName.toLowerCase()} `,
        openedOn: daysAgo(5),
      }),
    );
    expect(dup?.code).toBe("TPE_PROGRAM_ACTIVE");
    // another provider entity is a separate program
    await svc().createProgram(A(), { providerEntityId: pe2, macName, openedOn: daysAgo(5) });
  });

  it("links sampled claims and ADRs only inside the tenant, the provider entity and the claim", async () => {
    const { id } = await newProgram();
    const r = await svc().createRound(A(), id, daysAgo(30), await pver(id));
    const adrOk = await mkAdr(ORG, pe1, claim1);
    const adrOtherClaim = await mkAdr(ORG, pe1, claim1b);
    const adrOtherPe = await mkAdr(ORG, pe2, claim2);
    const adrForeign = await mkAdr(ORG_B, peB, claimB);
    const put = async (claimId: string, input: Record<string, unknown>) =>
      svc().upsertClaim(A(), r.id, claimId, input as never, await rver(r.id));

    expect((await refused(put(claim2, {})))?.code).toBe("NOT_FOUND"); // another provider entity's claim
    expect((await refused(put(claimB, {})))?.statusCode).toBe(404); // another tenant's claim (RLS)
    expect((await refused(put(randomUUID(), {})))?.statusCode).toBe(404);
    expect((await refused(put(claim1, { adrCaseId: adrOtherClaim })))?.statusCode).toBe(404);
    expect((await refused(put(claim1, { adrCaseId: adrOtherPe })))?.statusCode).toBe(404);
    expect((await refused(put(claim1, { adrCaseId: adrForeign })))?.statusCode).toBe(404);
    expect(
      Number(
        (await admin.query("SELECT count(*) FROM tpe_round_claim WHERE tpe_round_id=$1", [r.id]))
          .rows[0].count,
      ),
    ).toBe(0);

    await put(claim1, { adrCaseId: adrOk, result: "error" });
    await put(claim1b, { result: "no_error" });
    await put(claim1b, { result: "error" }); // an upsert, not a second row
    const detail = await svc().getProgram(A(), id);
    expect(detail?.rounds[0]?.claims.map((c) => [c.claimId, c.result, c.adrState])).toEqual([
      [claim1, "error", "received"],
      [claim1b, "error", null],
    ]);
    expect(detail?.claimCountRate).toEqual({ reviewed: 2, errors: 2, pct: 100 });
    expect(detail?.rounds[0]?.warnings.some((w) => /2 claims sampled/.test(w))).toBe(true);
    await put(claim1, { adrCaseId: null }); // unlink
    expect((await svc().getProgram(A(), id))?.rounds[0]?.claims[0]?.adrCaseId).toBeNull();
  });

  it("limits a narrowed actor to its provider entities and hides other tenants' programs", async () => {
    const { id } = await newProgram(pe1);
    const onPe2 = await newProgram(pe2);
    const scoped = actorOf(ORG, [pe2]);
    expect(
      (
        await refused(
          svc().createProgram(scoped, {
            providerEntityId: pe1,
            macName: "X",
            openedOn: daysAgo(3),
          }),
        )
      )?.statusCode,
    ).toBe(404);
    expect(await svc().getProgram(scoped, id)).toBeNull();
    expect(await svc().getProgram(scoped, onPe2.id)).not.toBeNull();
    expect(
      (await svc().listPrograms(scoped, {}, 200)).items.every((p) => p.providerEntityId === pe2),
    ).toBe(true);
    expect(
      (await refused(svc().createRound(scoped, id, daysAgo(3), await pver(id))))?.statusCode,
    ).toBe(404);
    // another tenant sees and changes nothing, and cannot point a program at this tenant's provider entity
    const other = actorOf(ORG_B);
    expect(await svc().getProgram(other, id)).toBeNull();
    expect((await svc().listPrograms(other, {}, 200)).items).toEqual([]);
    expect(
      (await refused(svc().createRound(other, id, daysAgo(3), await pver(id))))?.statusCode,
    ).toBe(404);
    expect(
      (
        await refused(
          svc().createProgram(other, { providerEntityId: pe1, macName: "Y", openedOn: daysAgo(3) }),
        )
      )?.statusCode,
    ).toBe(404);
    expect((await svc().listRules(other)).items).toEqual([]);
  });

  it("records an outcome with its facts, then freezes it", async () => {
    const referred = await newProgram();
    expect(
      (
        await refused(
          svc().recordOutcome(
            A(),
            referred.id,
            { kind: "referred", outcomeOn: daysAgo(2) },
            await pver(referred.id),
          ),
        )
      )?.code,
    ).toBe("REFERRAL_KIND_REQUIRED");
    expect(
      (
        await refused(
          svc().recordOutcome(
            A(),
            referred.id,
            {
              kind: "referred",
              outcomeOn: daysAgo(2),
              referralKinds: ["rac"],
              reliefUntil: daysAgo(-300),
            },
            await pver(referred.id),
          ),
        )
      )?.code,
    ).toBe("RELIEF_ON_REFERRAL");
    expect(
      (
        await refused(
          svc().recordOutcome(
            A(),
            referred.id,
            { kind: "compliant", outcomeOn: daysAgo(2), referralKinds: ["rac"] },
            await pver(referred.id),
          ),
        )
      )?.code,
    ).toBe("REFERRAL_ON_COMPLIANT");
    await svc().recordOutcome(
      A(),
      referred.id,
      {
        kind: "referred",
        outcomeOn: daysAgo(2),
        referralKinds: ["prepay_review", "extrapolation", "prepay_review"],
      },
      await pver(referred.id),
    );
    let detail = await svc().getProgram(A(), referred.id);
    expect(detail).toMatchObject({
      state: "referred",
      risk: "referred",
      referralKinds: ["prepay_review", "extrapolation"],
    });
    // a recorded outcome cannot be rewritten, in the service or in SQL
    expect(
      (
        await refused(
          svc().recordOutcome(
            A(),
            referred.id,
            { kind: "compliant", outcomeOn: daysAgo(1) },
            await pver(referred.id),
          ),
        )
      )?.code,
    ).toBe("INVALID_TRANSITION");
    expect(
      await dbMessage(
        admin.query("UPDATE tpe_program SET referral_kinds='{rac}' WHERE id=$1", [referred.id]),
      ),
    ).toMatch(/M25_TPE_OUTCOME_IMMUTABLE/);
    expect(
      await dbMessage(
        admin.query("UPDATE tpe_program SET state='compliant' WHERE id=$1", [referred.id]),
      ),
    ).toMatch(/M25_TPE_ILLEGAL_TRANSITION/);

    const relief = await newProgram();
    await svc().recordOutcome(
      A(),
      relief.id,
      { kind: "compliant", outcomeOn: daysAgo(3), reliefUntil: daysAgo(-362) },
      await pver(relief.id),
    );
    detail = await svc().getProgram(A(), relief.id);
    expect(detail).toMatchObject({
      state: "compliant",
      risk: "relief",
      reliefUntil: daysAgo(-362),
    });
    // the CHECKs hold even for SQL that skips the service
    const bare = await newProgram();
    expect(
      await dbMessage(
        admin.query(
          "UPDATE tpe_program SET state='referred', outcome_on=CURRENT_DATE WHERE id=$1",
          [bare.id],
        ),
      ),
    ).toMatch(/tpe_program_referred_has_outcome/);
    expect(
      await dbMessage(
        admin.query("UPDATE tpe_program SET state='compliant' WHERE id=$1", [bare.id]),
      ),
    ).toMatch(/tpe_program_compliant_has_outcome/);
  });

  it("freezes a closed program in the service and in the database", async () => {
    const { id, macName } = await newProgram();
    const r = await svc().createRound(A(), id, daysAgo(30), await pver(id));
    await svc().upsertClaim(A(), r.id, claim1, {}, await rver(r.id));
    await svc().closeProgram(A(), id, await pver(id));
    const closed = (fn: () => Promise<unknown>) => refused(fn());
    expect((await closed(async () => svc().closeProgram(A(), id, await pver(id))))?.code).toBe(
      "TPE_PROGRAM_CLOSED",
    );
    expect(
      (await closed(async () => svc().createRound(A(), id, daysAgo(2), await pver(id))))?.code,
    ).toBe("TPE_PROGRAM_CLOSED");
    expect(
      (
        await closed(async () =>
          svc().setEducation(A(), r.id, { educationOn: daysAgo(1) }, await rver(r.id)),
        )
      )?.code,
    ).toBe("TPE_PROGRAM_CLOSED");
    expect(
      (
        await closed(async () =>
          svc().setResults(
            A(),
            r.id,
            { resultsOn: daysAgo(1), macErrorRatePct: 1, macResult: "compliant" },
            await rver(r.id),
          ),
        )
      )?.code,
    ).toBe("TPE_PROGRAM_CLOSED");
    expect(
      (await closed(async () => svc().upsertClaim(A(), r.id, claim1b, {}, await rver(r.id))))?.code,
    ).toBe("TPE_PROGRAM_CLOSED");
    expect(
      (
        await closed(async () =>
          svc().recordOutcome(
            A(),
            id,
            { kind: "compliant", outcomeOn: daysAgo(1) },
            await pver(id),
          ),
        )
      )?.code,
    ).toBe("TPE_PROGRAM_CLOSED");
    expect(
      await dbMessage(
        asApp((tx) => tx.execute(sql`UPDATE tpe_program SET state='active' WHERE id=${id}`)),
      ),
    ).toMatch(/M25_TPE_PROGRAM_CLOSED/);
    expect(
      await dbMessage(
        asApp((tx) =>
          tx.execute(sql`UPDATE tpe_round SET education_on=CURRENT_DATE WHERE id=${r.id}`),
        ),
      ),
    ).toMatch(/M25_TPE_PROGRAM_CLOSED/);
    expect(
      await dbMessage(
        admin.query(
          `INSERT INTO tpe_round (organization_id, tpe_program_id, round_number, notice_on) VALUES ($1,$2,2,CURRENT_DATE)`,
          [ORG, id],
        ),
      ),
    ).toMatch(/M25_TPE_PROGRAM_CLOSED/);
    expect(
      await dbMessage(
        admin.query(
          `INSERT INTO tpe_round_claim (organization_id, tpe_round_id, claim_id) VALUES ($1,$2,$3)`,
          [ORG, r.id, randomUUID()],
        ),
      ),
    ).toMatch(/M25_TPE_PROGRAM_CLOSED/);
    // a closed program frees its MAC for a new one
    const next = await svc().createProgram(A(), {
      providerEntityId: pe1,
      macName,
      openedOn: daysAgo(1),
    });
    expect(next.id).not.toBe(id);
  });

  it("refuses an UPDATE of the anchor columns and a stale If-Match", async () => {
    const { id } = await newProgram();
    const r = await svc().createRound(A(), id, daysAgo(30), await pver(id));
    expect(
      await dbMessage(
        asApp((tx) => tx.execute(sql`UPDATE tpe_program SET mac_name='Other' WHERE id=${id}`)),
      ),
    ).toMatch(/permission denied/i);
    expect(
      await dbMessage(
        asApp((tx) =>
          tx.execute(sql`UPDATE tpe_program SET provider_entity_id=${pe2} WHERE id=${id}`),
        ),
      ),
    ).toMatch(/permission denied/i);
    expect(
      await dbMessage(
        asApp((tx) => tx.execute(sql`UPDATE tpe_round SET round_number=2 WHERE id=${r.id}`)),
      ),
    ).toMatch(/permission denied/i);
    expect(
      await dbMessage(
        asApp((tx) =>
          tx.execute(sql`UPDATE tpe_round SET notice_on=CURRENT_DATE WHERE id=${r.id}`),
        ),
      ),
    ).toMatch(/permission denied/i);
    const stale = await rver(r.id);
    await svc().setEducation(A(), r.id, { educationOn: daysAgo(5) }, stale);
    expect(
      (await refused(svc().setEducation(A(), r.id, { educationOn: daysAgo(4) }, stale)))?.code,
    ).toBe("VERSION_CONFLICT");
    const staleProgram = await pver(id);
    await svc().closeProgram(A(), id, staleProgram);
    expect((await refused(svc().closeProgram(A(), id, staleProgram)))?.statusCode).toBe(409);
  });

  it("writes an audit row for every write and scrubs the free-text notes", async () => {
    const { id, macName } = await newProgram();
    await svc().upsertRule(A(), { macName, exitErrorRatePct: 18, sourceNote: "SECRET-RULE-NOTE" });
    const r = await svc().createRound(A(), id, daysAgo(30), await pver(id));
    await svc().setEducation(
      A(),
      r.id,
      { educationOn: daysAgo(10), note: "SECRET-EDU-NOTE" },
      await rver(r.id),
    );
    await svc().upsertClaim(A(), r.id, claim1, { result: "error" }, await rver(r.id));
    for (const [kind, rid, event] of [
      ["tpe_program", id, "tpe_program.insert"],
      ["tpe_round", r.id, "tpe_round.insert"],
      ["tpe_round", r.id, "tpe_round.update"],
    ] as const) {
      const n = (
        await admin.query(
          "SELECT count(*) FROM audit_event WHERE resource_kind=$1 AND resource_id=$2 AND event_type=$3",
          [kind, rid, event],
        )
      ).rows[0].count;
      expect(Number(n), event).toBeGreaterThan(0);
    }
    expect(
      Number(
        (
          await admin.query(
            "SELECT count(*) FROM audit_event WHERE resource_kind='tpe_round_claim' AND organization_id=$1",
            [ORG],
          )
        ).rows[0].count,
      ),
    ).toBeGreaterThan(0);
    expect(
      Number(
        (
          await admin.query(
            "SELECT count(*) FROM audit_event WHERE resource_kind='tpe_mac_rule' AND organization_id=$1",
            [ORG],
          )
        ).rows[0].count,
      ),
    ).toBeGreaterThan(0);
    const all = JSON.stringify(
      (
        await admin.query(
          "SELECT before, after FROM audit_event WHERE resource_kind IN ('tpe_round','tpe_mac_rule') AND organization_id=$1",
          [ORG],
        )
      ).rows,
    );
    expect(all).not.toContain("SECRET-EDU-NOTE");
    expect(all).not.toContain("SECRET-RULE-NOTE");
  });

  describe("routes", () => {
    function makeApp(keys: string[], role = "billing_manager", scope: string[] = [pe1, pe2]) {
      resetAuthorizationContract();
      resetRbacEngine();
      registerEffectivePermissionResolver(
        createInMemoryEffectivePermissionStore([
          {
            orgId: ORG,
            userId: userA,
            grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
          },
        ]).store,
      );
      const app = buildServer({
        db: handle.db,
        authenticate: (request: FastifyRequest) => {
          request.context.userId = userA;
          request.context.organizationId = ORG;
          request.context.roles = [role];
          request.context.providerEntityIds = scope;
          request.context.attributes = { ...request.context.attributes, membershipId: memberA };
        },
        security: { rateLimitEnabled: false },
      });
      registerTpeRoutes(app, { tpeService: svc() });
      return app;
    }
    const WRITE_HEADERS = (version?: number) => ({
      "idempotency-key": randomUUID(),
      ...(version === undefined ? {} : { "if-match": String(version) }),
    });

    it("gates reads on tpe.read, writes on tpe.manage and thresholds on tpe_rule.manage", async () => {
      const reader = makeApp(["tpe.read"]);
      const { id } = await newProgram();
      expect((await reader.inject({ method: "GET", url: "/api/v1/tpe-programs" })).statusCode).toBe(
        200,
      );
      expect((await reader.inject({ method: "GET", url: "/api/v1/tpe-rules" })).statusCode).toBe(
        200,
      );
      const denied = await reader.inject({
        method: "POST",
        url: `/api/v1/tpe-programs/${id}/close`,
        headers: WRITE_HEADERS(await pver(id)),
      });
      expect(denied.statusCode).toBe(403);
      const rule = await reader.inject({
        method: "PUT",
        url: "/api/v1/tpe-rules",
        headers: WRITE_HEADERS(),
        payload: { macName: "ZZ", exitErrorRatePct: 10 },
      });
      expect(rule.statusCode).toBe(403);
      await reader.close();
      const none = makeApp([]);
      expect((await none.inject({ method: "GET", url: "/api/v1/tpe-programs" })).statusCode).toBe(
        403,
      );
      await none.close();
    });

    it("validates ids, headers and bodies, and writes through the full route stack", async () => {
      const app = makeApp(["tpe.read", "tpe.manage", "tpe_rule.manage"]);
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/tpe-programs/not-a-uuid" })).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: "GET", url: `/api/v1/tpe-programs/${randomUUID()}` }))
          .statusCode,
      ).toBe(404);
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/tpe-programs",
        headers: WRITE_HEADERS(),
        payload: { providerEntityId: pe1, macName: `HTTP-${++macSeq}`, openedOn: daysAgo(20) },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().id as string;
      const noKey = await app.inject({
        method: "POST",
        url: `/api/v1/tpe-programs/${id}/rounds`,
        payload: { noticeOn: daysAgo(5) },
      });
      expect(noKey.statusCode).toBe(400);
      const noMatch = await app.inject({
        method: "POST",
        url: `/api/v1/tpe-programs/${id}/rounds`,
        headers: WRITE_HEADERS(),
        payload: { noticeOn: daysAgo(5) },
      });
      expect(noMatch.statusCode).toBe(400);
      const round = await app.inject({
        method: "POST",
        url: `/api/v1/tpe-programs/${id}/rounds`,
        headers: WRITE_HEADERS(await pver(id)),
        payload: { noticeOn: daysAgo(5) },
      });
      expect(round.statusCode).toBe(201);
      expect(round.json()).toMatchObject({ roundNumber: 1, warnings: [] });
      const badClaim = await app.inject({
        method: "PUT",
        url: `/api/v1/tpe-rounds/${round.json().id}/claims/not-a-uuid`,
        headers: WRITE_HEADERS(1),
        payload: {},
      });
      expect(badClaim.statusCode).toBe(404);
      const badBody = await app.inject({
        method: "PUT",
        url: `/api/v1/tpe-rounds/${round.json().id}/results`,
        headers: WRITE_HEADERS(1),
        payload: { resultsOn: daysAgo(1), macErrorRatePct: 150, macResult: "compliant" },
      });
      expect(badBody.statusCode).toBe(422);
      const claimPut = await app.inject({
        method: "PUT",
        url: `/api/v1/tpe-rounds/${round.json().id}/claims/${claim1}`,
        headers: WRITE_HEADERS(1),
        payload: { result: "pending" },
      });
      expect(claimPut.statusCode).toBe(200);
      const stale = await app.inject({
        method: "PUT",
        url: `/api/v1/tpe-rounds/${round.json().id}/claims/${claim1}`,
        headers: WRITE_HEADERS(1),
        payload: { result: "error" },
      });
      expect(stale.statusCode).toBe(409);
      const ruleBody = {
        macName: `HTTP-RULE-${macSeq}`,
        exitErrorRatePct: 9,
        effectiveFrom: daysAgo(30),
      };
      const created1 = await app.inject({
        method: "PUT",
        url: "/api/v1/tpe-rules",
        headers: WRITE_HEADERS(),
        payload: ruleBody,
      });
      expect(created1.statusCode, created1.body).toBe(200);
      const v = created1.json().version as number;
      const edited = await app.inject({
        method: "PUT",
        url: "/api/v1/tpe-rules",
        headers: WRITE_HEADERS(v),
        payload: { ...ruleBody, exitErrorRatePct: 8 },
      });
      expect(edited.statusCode).toBe(200);
      const staleRule = await app.inject({
        method: "PUT",
        url: "/api/v1/tpe-rules",
        headers: WRITE_HEADERS(v),
        payload: { ...ruleBody, exitErrorRatePct: 7 },
      });
      expect(staleRule.statusCode).toBe(409);
      await app.close();
    });

    it("lands a read-audit row for the detail read and for the list read", async () => {
      const app = makeApp(["tpe.read"]);
      const { id } = await newProgram();
      await admin.query(
        "DELETE FROM audit_event WHERE organization_id=$1 AND event_type LIKE 'tpe_program.%viewed'",
        [ORG],
      );
      expect(
        (await app.inject({ method: "GET", url: `/api/v1/tpe-programs/${id}` })).statusCode,
      ).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/tpe-programs" })).statusCode).toBe(
        200,
      );
      await app.close();
      const rows = (
        await admin.query(
          "SELECT event_type, resource_id::text FROM audit_event WHERE organization_id=$1 AND event_type LIKE 'tpe_program.%viewed' ORDER BY event_type",
          [ORG],
        )
      ).rows;
      expect(rows.map((r) => r.event_type)).toEqual([
        "tpe_program.list_viewed",
        "tpe_program.viewed",
      ]);
      expect(rows.find((r) => r.event_type === "tpe_program.viewed")?.resource_id).toBe(id);
    });

    it("hides a program outside the caller's provider entities behind a 404", async () => {
      const { id } = await newProgram(pe1);
      const app = makeApp(["tpe.read"], "tpe_scoped", [pe2]);
      expect(
        (await app.inject({ method: "GET", url: `/api/v1/tpe-programs/${id}` })).statusCode,
      ).toBe(404);
      const list = await app.inject({ method: "GET", url: "/api/v1/tpe-programs" });
      expect(
        list.json().items.every((p: { providerEntityId: string }) => p.providerEntityId === pe2),
      ).toBe(true);
      await app.close();
    });
  });
});
