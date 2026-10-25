/**
 * M25 payer (commercial / Medicare Advantage) appeals, milestone 12a-1 (hospice ADR/TPE/QIC PRD) - LIVE Postgres as the
 * NOBYPASSRLS `chartwarden_app` role, through the real services and routes.
 *
 * Proves what the pure suites cannot: a commercial denial with NO claim opens a payer appeal; with no recorded path nothing
 * is computed and the absence is visible; an active, verified path yields a deadline equal to the pure function while a
 * draft path yields the same date badged unverified; a later path edit never moves an opened case's deadline (and the
 * database refuses to move it); an active path is frozen and its levels cannot change; the author cannot verify (service
 * AND database, atomically); another tenant sees nothing; a Medicare denial is refused for a payer appeal; the recorded
 * deadline and no-deadline alerts land once; and the denial-keyed case view is read-audited.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:payer-appeal:live
 * (SUPERUSER to a THROWAWAY db - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import type { DbClient } from "@chartwarden/db";
import { FormatRegistry } from "@sinclair/typebox";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFoundationSiteReader } from "../src/bootstrap/foundation-site-reader";
import { buildServer } from "../src/bootstrap/index";
import { __resetSeamsForTest } from "../src/bootstrap/seams/registry";
import { registerM23PublishedSeams } from "../src/modules/23-billing-medicare/cost-report-seams";
import {
  DEFAULT_DEADLINE_ZONE,
  derivePayerLevelDeadline,
  isKnownZone,
} from "../src/modules/25-remittance/domain";
import { runAppealDeadlineCron } from "../src/modules/25-remittance/jobs/cron-workers";
import { buildSeamAppealSourcePorts } from "../src/modules/25-remittance/routes/appeal-packet-sources";
import { buildDrizzleCaseViewService } from "../src/modules/25-remittance/routes/case-view-service";
import { registerCaseViewRoutes } from "../src/modules/25-remittance/routes/case-view.routes";
import { buildDrizzleLaterTierService } from "../src/modules/25-remittance/routes/later-tier-service";
import { buildDrizzlePayerAppealPathService } from "../src/modules/25-remittance/routes/payer-appeal-path-service";
import { registerPayerAppealPathRoutes } from "../src/modules/25-remittance/routes/payer-appeal-path.routes";
import {
  AWAITING_VERIFICATION_PROMPT,
  NO_DUE_DATE_PROMPT,
  NO_PATH_PROMPT,
  PAYER_UNRESOLVED_PROMPT,
  buildDrizzlePayerAppealService,
} from "../src/modules/25-remittance/routes/payer-appeal-service";
import { registerPayerAppealRoutes } from "../src/modules/25-remittance/routes/payer-appeal.routes";
import { type PayerSeam, buildSeamPayerSeam } from "../src/modules/25-remittance/routes/payer-seam";
import { createDbMdmStore, registerMdmSeams } from "../src/modules/40-mdm/index";
import { type M7Fixture, ORG, ORG_B, daysAgo, daysAhead, setupM7Fixture } from "./_m25-m7-fixture";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (v) => UUID_RE.test(v));
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)));
}

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("M25 payer appeals (milestone 12a-1) - LIVE Postgres", () => {
  let fx: M7Fixture;
  let userR = "";
  let memberR = "";
  const payerId = randomUUID();
  const payerId2 = randomUUID();
  const maPayerId = randomUUID();
  const known = new Map<string, { id: string; name: string; kind: string }>([
    [payerId, { id: payerId, name: "Payer One", kind: "commercial" }],
    [payerId2, { id: payerId2, name: "Payer Two", kind: "commercial" }],
    [maPayerId, { id: maPayerId, name: "Plan MA", kind: "medicare_advantage" }],
  ]);
  const payers: PayerSeam = { resolve: async (_o, id) => known.get(id) ?? null };
  const downPayers: PayerSeam = { resolve: async () => null };

  const providerZones = (tx: DbClient, pe: string) =>
    buildFoundationSiteReader().providerEntityTimezones(tx, pe);
  const pathSvc = (p: PayerSeam = payers) =>
    buildDrizzlePayerAppealPathService(fx.handle.db, { payers: p });
  const appealSvc = (p: PayerSeam = payers) =>
    buildDrizzlePayerAppealService(fx.handle.db, {
      payers: p,
      providerZones,
      sources: buildSeamAppealSourcePorts(),
    });
  const tier = () => buildDrizzleLaterTierService(fx.handle.db, { providerZones });
  const A = () => fx.actor();
  const R = () => ({ ...fx.actor(), userId: userR, membershipId: memberR });
  const B = () => fx.actor(ORG_B);

  /** A made-up fixture window for the arithmetic only: it is not any payer's rule. */
  const level = (over: Record<string, unknown> = {}) => ({
    levelKind: "internal" as const,
    levelLabel: "First level",
    whoFiles: "provider" as const,
    filingWindowDays: 10,
    anchorKind: "notice_date" as const,
    receiptPresumptionDays: null,
    dayBasis: "calendar" as const,
    roll: null,
    decisionDays: null,
    formLabel: null,
    channelNote: null,
    sourceNote: "contract p.4",
    ...over,
  });
  const pathInput = (over: Record<string, unknown> = {}) => ({
    payerId,
    program: "commercial",
    contractLabel: null,
    effectiveFrom: "2020-01-01",
    sourceNote: "contract section 4",
    levels: [level()],
    ...over,
  });
  async function activePath(over: Record<string, unknown> = {}): Promise<string> {
    const created = await pathSvc().createPath(A(), pathInput(over) as never);
    await pathSvc().verifyPath(R(), created.id, created.version);
    return created.id;
  }

  let adviceSeq = 100;
  /** A denial seeded from an 835 line of the given payer kind; a commercial one has no claim. */
  async function mkDenial(
    payerKind: "commercial" | "medicare" | "medicaid",
    over: {
      org?: string;
      pe?: string;
      payer?: string;
      claimId?: string | null;
      noAdvice?: boolean;
    } = {},
  ): Promise<string> {
    const org = over.org ?? ORG;
    const pe = over.pe ?? (org === ORG ? fx.pe1 : fx.peB);
    let lineId: string | null = null;
    if (!over.noAdvice) {
      adviceSeq += 1;
      const advice = (
        await fx.admin.query(
          `INSERT INTO remittance_advice (organization_id, provider_entity_id, payer_id, payer_kind,
             interchange_control_number, transaction_set_control_number, check_or_eft_trace_number, payment_method,
             total_payment_amount, production_date, minio_object_key, file_sha256, parse_status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'eft',0, now(),'k',$8,'partial_posted') RETURNING id, received_at`,
          [
            org,
            pe,
            over.payer ?? payerId,
            payerKind,
            `9${adviceSeq}`,
            `1${adviceSeq}`,
            `TRC${adviceSeq}`,
            "0".repeat(64),
          ],
        )
      ).rows[0];
      lineId = (
        await fx.admin.query(
          `INSERT INTO remittance_line (organization_id, remittance_advice_id, claim_id, clp07_payer_icn,
             clp02_status_code, clp03_total_charge_amount, clp04_total_payment_amount,
             clp05_patient_responsibility_amount, match_state, received_at)
           VALUES ($1,$2,$3,$4,4,100,0,0,'unmatched',$5) RETURNING id`,
          [org, advice.id, over.claimId ?? null, `ICN-${adviceSeq}`, advice.received_at],
        )
      ).rows[0].id as string;
    }
    return (
      await fx.admin.query(
        `INSERT INTO denial_case (organization_id, provider_entity_id, claim_id, remittance_line_id,
           source_evv_aggregator_submission_id, carc_code, category, source, state, dollar_value, taxonomy_status)
         VALUES ($1,$2,$3,$4,$5,'50','denial','evv_aggregator_rejection','escalated',10,'mapped') RETURNING id`,
        [org, pe, over.claimId ?? null, lineId, randomUUID()],
      )
    ).rows[0].id as string;
  }

  async function expectedDeadline(notice: string, w = level()): Promise<Date | undefined> {
    const zones = (await fx.asApp((tx) => providerZones(tx as never, fx.pe1))).filter(isKnownZone);
    return derivePayerLevelDeadline(
      {
        windowDays: w.filingWindowDays,
        anchorKind: w.anchorKind,
        receiptPresumptionDays: w.receiptPresumptionDays,
        dayBasis: w.dayBasis,
        roll: w.roll,
      },
      notice,
      zones.length > 0 ? zones : [DEFAULT_DEADLINE_ZONE],
    )?.deadlineAt;
  }

  async function cron() {
    const dispatched: { alertCode: string; payload: Record<string, unknown> }[] = [];
    await runAppealDeadlineCron({
      connection: {} as never,
      db: fx.handle.db,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      alerts: { dispatch: async (a) => void dispatched.push(a) },
      now: () => new Date(),
    });
    return dispatched;
  }

  function makeApp(keys: string[], seam: PayerSeam = payers) {
    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG,
          userId: fx.userA,
          grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
        },
      ]).store,
    );
    const app = buildServer({
      db: fx.handle.db as never,
      authenticate: (request: FastifyRequest) => {
        request.context.userId = fx.userA;
        request.context.organizationId = ORG;
        request.context.roles = ["billing_manager"];
        request.context.providerEntityIds = [fx.pe1, fx.pe2];
        request.context.attributes = { ...request.context.attributes, membershipId: fx.memberA };
      },
      security: { rateLimitEnabled: false },
    });
    registerPayerAppealPathRoutes(app, { payerAppealPathService: pathSvc(seam) });
    registerPayerAppealRoutes(app, { payerAppealService: appealSvc(seam), laterTierService: tier() });
    registerCaseViewRoutes(app, { caseViewService: buildDrizzleCaseViewService(fx.handle.db) });
    return app;
  }

  beforeAll(async () => {
    fx = await setupM7Fixture(DB_URL as string, "m25-pa");
    registerM23PublishedSeams(fx.handle.db);
    userR = (
      await fx.admin.query(`INSERT INTO "user" (email) VALUES ('m25-pa-r@x.test') RETURNING id`)
    ).rows[0].id as string;
    memberR = (
      await fx.admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userR, ORG],
      )
    ).rows[0].id as string;
  }, 300_000);

  afterAll(async () => {
    await fx?.close();
    resetAuthorizationContract();
    resetRbacEngine();
    __resetSeamsForTest();
  });

  it("registers the five keys and grants them to existing roles by migration 1209 (idempotent)", async () => {
    const keys = (
      await fx.admin.query(`SELECT key FROM permission WHERE key LIKE 'payer_appeal%' ORDER BY key`)
    ).rows
      .map((r) => r.key as string)
      .sort();
    expect(keys).toEqual(
      [
        "payer_appeal.manage",
        "payer_appeal.read",
        "payer_appeal_path.manage",
        "payer_appeal_path.read",
        "payer_appeal_path.verify",
      ].sort(),
    );
  });

  // ── no path: nothing is computed, the absence is visible ─────────────────────────────────────────────────
  it("a commercial denial with NO claim opens a payer appeal; with no path no deadline is computed and the absence is shown", async () => {
    const denial = await mkDenial("commercial");
    const before = await appealSvc().getForDenial(A(), denial);
    expect(before.refusal).toBeNull();
    expect(before.path).toBeNull();
    expect(before.pathPrompt).toBe(NO_PATH_PROMPT);
    expect(before.payerName).toBe("Payer One");

    const opened = await appealSvc().open(A(), denial, {
      levelLabel: "Provider dispute",
      levelKind: "internal",
      noticeDate: daysAgo(2),
    });
    expect(opened.deadlineSource).toBe("none");
    const c = await appealSvc().getCase(A(), opened.id);
    expect(c).toMatchObject({
      claimId: null,
      deadlineAt: null,
      deadlineState: "none",
      prompt: NO_DUE_DATE_PROMPT,
      pathId: null,
      windowVerified: false,
    });
    const d = (await fx.admin.query("SELECT state FROM denial_case WHERE id=$1", [denial])).rows[0];
    expect(d.state).toBe("appealed");
    // a second level cannot open while one is in flight
    expect(
      (await fx.refused(appealSvc().open(A(), denial, { levelLabel: "x", levelKind: "internal" })))
        ?.code,
    ).toBe("PAYER_APPEAL_IN_FLIGHT");
  });

  it("the case can be given a due date by typing it from the notice, and that alerts at the recorded boundary once", async () => {
    const denial = await mkDenial("commercial");
    const opened = await appealSvc().open(A(), denial, { levelLabel: "L1", levelKind: "internal" });
    const rec = await tier().createDeadline(
      A(),
      { kind: "payer_appeal", id: opened.id },
      { label: "Payer response", dueOn: daysAhead(7), sourceNote: "denial letter p.2" },
    );
    const c = await appealSvc().getCase(A(), opened.id);
    expect(c?.deadlineState).toBe("recorded");
    expect(c?.prompt).toBeNull();
    const first = await cron();
    const hits = first.filter(
      (a) => a.alertCode === "deadline.recorded_approaching" && a.payload.deadlineId === rec.id,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.payload).toMatchObject({ subjectKind: "payer_appeal", subjectId: opened.id });
    const second = await cron();
    expect(
      second.filter(
        (a) => a.alertCode === "deadline.recorded_approaching" && a.payload.deadlineId === rec.id,
      ),
    ).toHaveLength(0);
  });

  it("a draft with no due date of either kind raises ONE payer_appeal.no_deadline alert", async () => {
    const denial = await mkDenial("commercial");
    const opened = await appealSvc().open(A(), denial, { levelLabel: "L1", levelKind: "internal" });
    await fx.admin.query(
      "ALTER TABLE payer_appeal_case DISABLE TRIGGER trg_payer_appeal_case_guard",
    );
    await fx.admin.query(
      "UPDATE payer_appeal_case SET created_at = now() - interval '5 days' WHERE id=$1",
      [opened.id],
    );
    await fx.admin.query(
      "ALTER TABLE payer_appeal_case ENABLE TRIGGER trg_payer_appeal_case_guard",
    );
    const first = (await cron()).filter(
      (a) =>
        a.alertCode === "payer_appeal.no_deadline" && a.payload.payerAppealCaseId === opened.id,
    );
    expect(first).toHaveLength(1);
    expect(Object.keys(first[0]?.payload ?? {})).toEqual(["payerAppealCaseId"]);
    const again = (await cron()).filter(
      (a) =>
        a.alertCode === "payer_appeal.no_deadline" && a.payload.payerAppealCaseId === opened.id,
    );
    expect(again).toHaveLength(0);
  });

  // ── the path: verification, freeze, snapshot ─────────────────────────────────────────────────────────────
  it("an unresolvable payer cannot be written into a path (the seam fails closed)", async () => {
    const e = await fx.refused(pathSvc(downPayers).createPath(A(), pathInput() as never));
    expect(e?.code).toBe("PAYER_UNRESOLVED");
  });

  it("a path is born a draft, the author cannot verify it (service and database), a second person can", async () => {
    const created = await pathSvc().createPath(A(), pathInput({ payerId: payerId2 }) as never);
    const own = await fx.refused(pathSvc().verifyPath(A(), created.id, created.version));
    expect(own?.code).toBe("PATH_VERIFIER_IS_AUTHOR");
    // the database refuses it too, bypassing the service: the author tries to activate through a raw UPDATE as the app role
    const dbMsg = await fx.dbMessage(
      fx.asApp((tx) =>
        tx.execute(
          sql`UPDATE payer_appeal_path SET status='active', verified_on=CURRENT_DATE, verified_by_membership_id=${fx.memberA} WHERE id=${created.id}`,
        ),
      ),
    );
    expect(dbMsg).toMatch(/verifier_not_author|M25_PAYER_PATH_VERIFIER/);
    const ok = await pathSvc().verifyPath(R(), created.id, created.version);
    expect(ok.version).toBe(created.version + 1);
    const view = await pathSvc().getPath(A(), created.id);
    expect(view).toMatchObject({
      status: "active",
      verifiedByMembershipId: memberR,
      payerName: "Payer Two",
    });
    // a stale second verify is a conflict, not a second activation
    expect(
      (await fx.refused(pathSvc().verifyPath(R(), created.id, created.version)))?.code,
    ).toBeDefined();
  });

  it("an active path is frozen: no edit, no new level, only retire", async () => {
    const id = await activePath({
      payerId: payerId2,
      contractLabel: "freeze",
      effectiveFrom: "2020-02-01",
    });
    expect(
      await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(sql`UPDATE payer_appeal_path SET verified_on='2020-01-01' WHERE id=${id}`),
        ),
      ),
    ).toMatch(/M25_PAYER_PATH_FROZEN/);
    expect(
      await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql`INSERT INTO payer_appeal_path_level (organization_id, path_id, ordinal, level_kind, level_label, source_note) VALUES (${ORG}, ${id}, 9, 'internal', 'x', 'y')`,
          ),
        ),
      ),
    ).toMatch(/M25_PAYER_PATH_FROZEN/);
    expect(
      await fx.dbMessage(
        fx.asApp((tx) => tx.execute(sql`DELETE FROM payer_appeal_path WHERE id=${id}`)),
      ),
    ).toMatch(/permission denied/);
    const cur = await pathSvc().getPath(A(), id);
    const retired = await pathSvc().retirePath(A(), id, cur?.version ?? 0);
    expect(retired.version).toBeGreaterThan(cur?.version ?? 0);
    expect((await pathSvc().getPath(A(), id))?.status).toBe("retired");
  });

  it("a duplicate live path for the same scope and date is a conflict (case-insensitive contract label)", async () => {
    await pathSvc().createPath(
      A(),
      pathInput({ payerId: payerId2, contractLabel: "Gold", effectiveFrom: "2020-03-01" }) as never,
    );
    const e = await fx.refused(
      pathSvc().createPath(
        A(),
        pathInput({
          payerId: payerId2,
          contractLabel: " gold ",
          effectiveFrom: "2020-03-01",
        }) as never,
      ),
    );
    expect(e?.code).toBe("PATH_EXISTS");
  });

  it("an active verified path gives a computed deadline equal to the pure function; a later path edit never moves it", async () => {
    const pid = randomUUID();
    known.set(pid, { id: pid, name: "Payer Three", kind: "commercial" });
    const pathId = await activePath({ payerId: pid });
    const denial = await mkDenial("commercial", { payer: pid });
    const view = await appealSvc().getForDenial(A(), denial);
    expect(view.path).toMatchObject({ id: pathId, verified: true });
    expect(view.pathPrompt).toBeNull();

    const notice = daysAgo(3);
    const opened = await appealSvc().open(A(), denial, { noticeDate: notice });
    expect(opened.deadlineSource).toBe("path_rule");
    const c = await appealSvc().getCase(A(), opened.id);
    const expected = await expectedDeadline(notice);
    expect(c?.deadlineAt).toBe(expected?.toISOString());
    expect(c).toMatchObject({
      windowVerified: true,
      deadlineState: "computed",
      pathId,
      pathRevision: 1,
      levelOrdinal: 1,
      claimId: null,
    });
    expect(c?.derivation?.presumedReceiptOn).toBeNull();

    // the organization retires the path and writes a different window; the open case keeps its snapshot
    const cur = await pathSvc().getPath(A(), pathId);
    await pathSvc().retirePath(A(), pathId, cur?.version ?? 0);
    await activePath({
      payerId: pid,
      effectiveFrom: "2020-06-01",
      levels: [level({ filingWindowDays: 30 })],
    });
    const after = await appealSvc().getCase(A(), opened.id);
    expect(after?.deadlineAt).toBe(c?.deadlineAt);
    // and the database refuses to move it even by a direct write
    expect(
      await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql`UPDATE payer_appeal_case SET deadline_at = deadline_at + interval '9 days' WHERE id=${opened.id}`,
          ),
        ),
      ),
    ).toMatch(/M25_PAYER_APPEAL_DEADLINE_FROZEN/);
    // the alert for a computed deadline carries ids only
    const within = await appealSvc().getCase(A(), opened.id);
    expect(within?.version).toBe(opened.version);
  });

  it("a draft (unverified) path computes NO deadline: the level shows 'awaiting verification' and a typed notice date does not change that", async () => {
    const pid = randomUUID();
    known.set(pid, { id: pid, name: "Payer Four", kind: "commercial" });
    await pathSvc().createPath(A(), pathInput({ payerId: pid }) as never);
    const denial = await mkDenial("commercial", { payer: pid });
    const view = await appealSvc().getForDenial(A(), denial);
    expect(view.path).toMatchObject({ status: "draft", verified: false });
    expect(view.pathPrompt).toBe(AWAITING_VERIFICATION_PROMPT);
    const opened = await appealSvc().open(A(), denial, { noticeDate: daysAgo(1) });
    expect(opened.deadlineSource).toBe("none");
    const c = await appealSvc().getCase(A(), opened.id);
    expect(c).toMatchObject({
      deadlineAt: null,
      windowVerified: false,
      pathAwaitingVerification: true,
      prompt: AWAITING_VERIFICATION_PROMPT,
      levelLabel: "First level",
    });
    const noted = await appealSvc().recordNotice(A(), opened.id, daysAgo(2), opened.version);
    expect(noted.deadlineSource).toBe("none");
  });

  it("a payer the directory cannot resolve gets no defaulted program and no path lookup", async () => {
    const denial = await mkDenial("commercial");
    const view = await appealSvc(downPayers).getForDenial(A(), denial);
    expect(view).toMatchObject({ payerUnresolved: true, payerName: null, path: null });
    expect(view.pathPrompt).toBe(PAYER_UNRESOLVED_PROMPT);
    const e = await fx.refused(
      appealSvc(downPayers).open(A(), denial, { levelLabel: "L", levelKind: "internal" }),
    );
    expect(e?.code).toBe("PAYER_UNRESOLVED");
  });

  it("a caller-chosen program must agree with the payer's kind", async () => {
    const ma = await mkDenial("commercial", { payer: maPayerId });
    const bad = await fx.refused(
      appealSvc().open(A(), ma, { program: "commercial", levelLabel: "L", levelKind: "internal" }),
    );
    expect(bad?.code).toBe("PROGRAM_KIND_MISMATCH");
    const com = await mkDenial("commercial");
    const bad2 = await fx.refused(
      appealSvc().open(A(), com, {
        program: "medicare_advantage",
        levelLabel: "L",
        levelKind: "internal",
      }),
    );
    expect(bad2?.code).toBe("PROGRAM_KIND_MISMATCH");
  });

  it("a notice date typed later computes the deadline once, then it is frozen", async () => {
    const pid = randomUUID();
    known.set(pid, { id: pid, name: "Payer Five", kind: "commercial" });
    await activePath({ payerId: pid });
    const denial = await mkDenial("commercial", { payer: pid });
    const opened = await appealSvc().open(A(), denial, {});
    expect(opened.deadlineSource).toBe("none");
    // the path's verified state is snapshotted at opening, before any deadline exists
    expect((await appealSvc().getCase(A(), opened.id))?.windowVerified).toBe(true);
    const noted = await appealSvc().recordNotice(A(), opened.id, daysAgo(2), opened.version);
    expect(noted.deadlineSource).toBe("path_rule");
    expect(await appealSvc().getCase(A(), opened.id)).toMatchObject({
      windowVerified: true,
      deadlineState: "computed",
    });
    const e = await fx.refused(appealSvc().recordNotice(A(), opened.id, daysAgo(1), noted.version));
    expect(e?.code).toBe("DEADLINE_FROZEN");
  });

  it("an external review level carries a reviewer name; an internal one refuses it; a decision needs an outcome", async () => {
    const pid = randomUUID();
    known.set(pid, { id: pid, name: "Payer Six", kind: "commercial" });
    await activePath({
      payerId: pid,
      levels: [
        level(),
        level({
          levelKind: "external_review",
          levelLabel: "Independent review",
          filingWindowDays: null,
          anchorKind: null,
          dayBasis: null,
        }),
      ],
    });
    const denial = await mkDenial("commercial", { payer: pid });
    const first = await appealSvc().open(A(), denial, {});
    expect(
      (
        await fx.refused(
          appealSvc().move(
            A(),
            first.id,
            "submit",
            { externalReviewerName: "Someone" },
            first.version,
          ),
        )
      )?.code,
    ).toBe("REVIEWER_NOT_EXTERNAL");
    const sub = await appealSvc().move(A(), first.id, "submit", {}, first.version);
    const rev = await appealSvc().move(A(), first.id, "begin_review", {}, sub.version);
    expect(
      (await fx.refused(appealSvc().move(A(), first.id, "decide", {}, rev.version)))?.code,
    ).toBe("OUTCOME_REQUIRED");
    const decided = await appealSvc().move(
      A(),
      first.id,
      "decide",
      { outcome: "unfavorable" },
      rev.version,
    );
    // a stale version is a conflict
    expect(
      (await fx.refused(appealSvc().move(A(), first.id, "close", {}, rev.version)))?.code,
    ).toBe("VERSION_CONFLICT");
    // the next level is opened manually, after the prior one is decided
    const second = await appealSvc().open(A(), denial, { priorLevelCaseId: first.id });
    const c2 = await appealSvc().getCase(A(), second.id);
    expect(c2).toMatchObject({
      levelOrdinal: 2,
      levelKind: "external_review",
      priorLevelCaseId: first.id,
    });
    const sub2 = await appealSvc().move(
      A(),
      second.id,
      "submit",
      { externalReviewerName: "Reviewer Org" },
      second.version,
    );
    expect(sub2.version).toBeGreaterThan(second.version);
    expect((await appealSvc().getCase(A(), second.id))?.externalReviewerName).toBe("Reviewer Org");
    expect(decided.version).toBeGreaterThan(rev.version);
    // a closed level is frozen by the database
    const d1 = await appealSvc().move(A(), first.id, "close", {}, decided.version);
    expect(d1.version).toBeGreaterThan(decided.version);
    expect(
      await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(sql`UPDATE payer_appeal_case SET payer_reference='x' WHERE id=${first.id}`),
        ),
      ),
    ).toMatch(/M25_PAYER_APPEAL_TERMINAL_IMMUTABLE/);
  });

  // ── the program guard ────────────────────────────────────────────────────────────────────────────────────
  it("a Medicare denial is refused for a payer appeal; so are Medicaid and a denial with no advice", async () => {
    const med = await mkDenial("medicare", { claimId: fx.claim1 });
    expect(
      (await fx.refused(appealSvc().open(A(), med, { levelLabel: "x", levelKind: "internal" })))
        ?.code,
    ).toBe("MEDICARE_PAYER");
    expect((await appealSvc().getForDenial(A(), med)).refusal).toBe("MEDICARE_PAYER");
    const mcd = await mkDenial("medicaid");
    expect(
      (await fx.refused(appealSvc().open(A(), mcd, { levelLabel: "x", levelKind: "internal" })))
        ?.code,
    ).toBe("MEDICAID_PAYER");
    const none = await mkDenial("commercial", { noAdvice: true });
    expect(
      (await fx.refused(appealSvc().open(A(), none, { levelLabel: "x", levelKind: "internal" })))
        ?.code,
    ).toBe("NO_PAYER_ADVICE");
  });

  it("a Medicare Advantage plan's denial reads the plan's kind through the seam and shows the hint; the program is only a label", async () => {
    const denial = await mkDenial("commercial", { payer: maPayerId });
    const v = await appealSvc().getForDenial(A(), denial);
    expect(v.maHint).toBe(true);
    const opened = await appealSvc().open(A(), denial, {
      levelLabel: "Plan reconsideration",
      levelKind: "internal",
    });
    expect((await appealSvc().getCase(A(), opened.id))?.program).toBe("medicare_advantage");
  });

  // ── tenancy ──────────────────────────────────────────────────────────────────────────────────────────────
  it("another tenant sees no path, no case and no denial; a cross-tenant denial id fails closed", async () => {
    const denial = await mkDenial("commercial");
    const opened = await appealSvc().open(A(), denial, { levelLabel: "L", levelKind: "internal" });
    const pathId = await activePath({
      payerId: payerId2,
      contractLabel: "tenant",
      effectiveFrom: "2020-04-01",
    });
    expect((await pathSvc().listPaths(B(), {})).items).toEqual([]);
    expect(await pathSvc().getPath(B(), pathId)).toBeNull();
    expect(await appealSvc().getCase(B(), opened.id)).toBeNull();
    expect((await fx.refused(appealSvc().getForDenial(B(), denial)))?.statusCode).toBe(404);
    expect(
      (await fx.refused(appealSvc().open(B(), denial, { levelLabel: "L", levelKind: "internal" })))
        ?.statusCode,
    ).toBe(404);
    // the database refuses a case that names another tenant's denial even with RLS-valid org columns
    const msg = await fx.dbMessage(
      fx.asApp(
        (tx) =>
          tx.execute(
            sql`INSERT INTO payer_appeal_case (organization_id, provider_entity_id, denial_case_id, payer_id, program, level_kind, level_label) VALUES (${ORG_B}, ${fx.peB}, ${denial}, ${payerId}, 'commercial', 'internal', 'x')`,
          ),
        ORG_B,
      ),
    );
    expect(msg).toMatch(/M25_PAYER_APPEAL_PARENT/);
  });

  // ── the denial-keyed case view and its read audit ────────────────────────────────────────────────────────
  it("the denial-keyed case view shows a claim-less commercial denial's levels and recorded deadlines, and the read is audited", async () => {
    const denial = await mkDenial("commercial");
    const opened = await appealSvc().open(A(), denial, { levelLabel: "L1", levelKind: "internal" });
    await tier().createDeadline(
      A(),
      { kind: "payer_appeal", id: opened.id },
      { label: "Reply", dueOn: daysAhead(20), sourceNote: "letter" },
    );
    const app = makeApp(["appeal.read", "payer_appeal.read", "payer_appeal.manage"]);
    await fx.admin.query(
      "DELETE FROM audit_event WHERE organization_id=$1 AND event_type LIKE 'denial_case_view.%'",
      [ORG],
    );
    const res = await app.inject({ method: "GET", url: `/api/v1/denials/${denial}/case-view` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      claimId: string | null;
      items: { kind: string; id: string }[];
      nextDeadline: { kind: string } | null;
    };
    expect(body.claimId).toBeNull();
    expect(new Set(body.items.map((i) => i.kind))).toEqual(
      new Set(["payer_appeal", "recorded_deadline"]),
    );
    expect(body.nextDeadline?.kind).toBe("recorded_deadline");
    const audited = (
      await fx.admin.query(
        "SELECT resource_id::text AS rid FROM audit_event WHERE organization_id=$1 AND event_type='denial_case_view.viewed'",
        [ORG],
      )
    ).rows;
    expect(audited.map((r) => r.rid)).toContain(denial);
    // without payer_appeal.read the payer levels are left out, never widened
    const narrow = makeApp(["appeal.read"]);
    const n = (
      await narrow.inject({ method: "GET", url: `/api/v1/denials/${denial}/case-view` })
    ).json() as { items: unknown[] };
    expect(n.items).toEqual([]);
    expect(
      (await narrow.inject({ method: "GET", url: `/api/v1/payer-appeal-paths` })).statusCode,
    ).toBe(403);
    expect(
      (await narrow.inject({ method: "GET", url: `/api/v1/denials/${randomUUID()}/case-view` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await narrow.inject({ method: "GET", url: "/api/v1/denials/nope/case-view" })).statusCode,
    ).toBe(404);
    await narrow.close();
    // payer-appeal routes: opening needs the manage key and an Idempotency-Key
    const reader = makeApp(["payer_appeal.read"]);
    const d2 = await mkDenial("commercial");
    const denied = await reader.inject({
      method: "POST",
      url: `/api/v1/denials/${d2}/payer-appeals`,
      headers: { "idempotency-key": randomUUID() },
      payload: { levelLabel: "L", levelKind: "internal" },
    });
    expect(denied.statusCode).toBe(403);
    await reader.close();
    const app2 = makeApp(["appeal.read", "payer_appeal.read", "payer_appeal.manage"]);
    const noKey = await app2.inject({
      method: "POST",
      url: `/api/v1/denials/${d2}/payer-appeals`,
      payload: { levelLabel: "L", levelKind: "internal" },
    });
    expect(noKey.statusCode).toBe(400);
    const created = await app2.inject({
      method: "POST",
      url: `/api/v1/denials/${d2}/payer-appeals`,
      headers: { "idempotency-key": randomUUID() },
      payload: { levelLabel: "L", levelKind: "internal" },
    });
    expect(created.statusCode).toBe(201);
    await app.close();
    await app2.close();
  });

  it("the claim-keyed case view also lists payer levels that carry that claim", async () => {
    const denial = await mkDenial("commercial", { claimId: fx.claim1b });
    const opened = await appealSvc().open(A(), denial, { levelLabel: "L1", levelKind: "internal" });
    const view = await buildDrizzleCaseViewService(fx.handle.db).getCaseView(A(), fx.claim1b, {
      includeAdr: false,
      includeReopening: false,
      includeAudits: false,
      includePayerAppeals: true,
    });
    expect(view.items.map((i) => i.id)).toContain(opened.id);
  });

  it("separation of duties compares people: a second membership of the author's user, an inactive membership and a verification-date override are refused or ignored", async () => {
    await fx.admin.query("DROP INDEX IF EXISTS membership_active_unique_idx");
    const dup = (
      await fx.admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [fx.userA, ORG],
      )
    ).rows[0].id as string;
    const pendingUser = (
      await fx.admin.query(
        `INSERT INTO "user" (email) VALUES ('m25-pa-pending@x.test') RETURNING id`,
      )
    ).rows[0].id as string;
    const pending = (
      await fx.admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'pending') RETURNING id`,
        [pendingUser, ORG],
      )
    ).rows[0].id as string;
    const created = await pathSvc().createPath(
      A(),
      pathInput({ payerId: payerId2, contractLabel: "sod", effectiveFrom: "2020-05-01" }) as never,
    );
    const activate = (member: string, day = "CURRENT_DATE") =>
      fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql.raw(
              `UPDATE payer_appeal_path SET status='active', verified_on=${day === "CURRENT_DATE" ? day : `'${day}'`}, verified_by_membership_id='${member}' WHERE id='${created.id}'`,
            ),
          ),
        ),
      );
    // a second membership of the same person is not a second person
    expect(await activate(dup)).toMatch(/same person as the author/);
    // service-level: the same person acting through the other membership
    const viaDup = await fx.refused(
      pathSvc().verifyPath({ ...A(), membershipId: dup }, created.id, created.version),
    );
    expect(viaDup?.code).toBe("PATH_VERIFIER_IS_AUTHOR");
    // a membership that is not active cannot verify
    expect(await activate(pending)).toMatch(/not an active member/);
    // another person's active membership succeeds, and the verification day is the database's, not the caller's
    expect(await activate(memberR, "2001-01-01")).toBe("");
    const row = (
      await fx.admin.query(
        "SELECT verified_on::text AS d, CURRENT_DATE::text AS today FROM payer_appeal_path WHERE id=$1",
        [created.id],
      )
    ).rows[0];
    expect(row.d).toBe(row.today);
    // restore the one-active-membership-per-user index this test lifted
    await fx.admin.query("UPDATE membership SET status='revoked' WHERE id=$1", [dup]);
    await fx.admin.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS membership_active_unique_idx ON membership (user_id, organization_id) WHERE status != 'revoked'`,
    );
  });

  it("the payer deadline alert fires once per boundary: a second tick repeats nothing", async () => {
    const pid = randomUUID();
    known.set(pid, { id: pid, name: "Payer Seven", kind: "commercial" });
    await activePath({ payerId: pid }); // a made-up 10-day calendar window
    const denial = await mkDenial("commercial", { payer: pid });
    const opened = await appealSvc().open(A(), denial, { noticeDate: daysAgo(4) });
    const mine = (d: Awaited<ReturnType<typeof cron>>) =>
      d.filter(
        (a) =>
          a.alertCode === "payer_appeal.deadline_approaching" &&
          a.payload.payerAppealCaseId === opened.id,
      );
    const first = mine(await cron());
    expect(first).toHaveLength(1);
    expect(Object.keys(first[0]?.payload ?? {}).sort()).toEqual([
      "daysRemaining",
      "payerAppealCaseId",
    ]);
    expect(mine(await cron())).toHaveLength(0);
    expect(
      (
        await fx.admin.query(
          "SELECT count(*)::int AS n FROM payer_appeal_case_event WHERE payer_appeal_case_id=$1 AND event_kind='deadline_alerted'",
          [opened.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("two overlapping cron ticks send the payer deadline alert once", async () => {
    const pid = randomUUID();
    known.set(pid, { id: pid, name: "Payer Eight", kind: "commercial" });
    await activePath({ payerId: pid });
    const denial = await mkDenial("commercial", { payer: pid });
    const opened = await appealSvc().open(A(), denial, { noticeDate: daysAgo(4) });
    const [t1, t2] = await Promise.all([cron(), cron()]);
    const mine = [...t1, ...t2].filter(
      (a) =>
        a.alertCode === "payer_appeal.deadline_approaching" &&
        a.payload.payerAppealCaseId === opened.id,
    );
    expect(mine).toHaveLength(1);
    expect(
      (
        await fx.admin.query(
          "SELECT count(*)::int AS n FROM payer_appeal_case_event WHERE payer_appeal_case_id=$1 AND event_kind='deadline_alerted'",
          [opened.id],
        )
      ).rows[0].n,
    ).toBe(1);
  });

  it("a draft path cannot be given a verifier or a verification day without being activated", async () => {
    const created = await pathSvc().createPath(
      A(),
      pathInput({
        payerId: payerId2,
        contractLabel: "draft-edit",
        effectiveFrom: "2020-06-01",
      }) as never,
    );
    for (const set of [`verified_by_membership_id='${memberR}'`, "verified_on=CURRENT_DATE"]) {
      expect(
        await fx.dbMessage(
          fx.asApp((tx) =>
            tx.execute(sql.raw(`UPDATE payer_appeal_path SET ${set} WHERE id='${created.id}'`)),
          ),
        ),
      ).toMatch(/verification fields change only when the path is activated|verified_pair/);
    }
  });

  it("read events land on every payer-appeal read, with the claim's patient when there is one and an explicit unattributed marker when there is none", async () => {
    const claimless = await mkDenial("commercial");
    const withClaim = await mkDenial("commercial", { claimId: fx.claim1b });
    const c1 = await appealSvc().open(A(), claimless, { levelLabel: "L", levelKind: "internal" });
    const c2 = await appealSvc().open(A(), withClaim, { levelLabel: "L", levelKind: "internal" });
    const claimPatient = (
      await fx.admin.query("SELECT patient_id::text AS p FROM claim WHERE id=$1", [fx.claim1b])
    ).rows[0].p as string;
    const app = makeApp(["appeal.read", "payer_appeal.read", "payer_appeal_path.read"]);
    const events = async (kind: string, id: string) =>
      (
        await fx.admin.query(
          "SELECT context->>'patientId' AS pid FROM audit_event WHERE organization_id=$1 AND event_type=$2 AND resource_id=$3::uuid",
          [ORG, `${kind}.viewed`, id],
        )
      ).rows as { pid: string | null }[];
    const get = async (url: string) =>
      (await app.inject({ method: "GET", url })).json() as Record<string, unknown>;

    const v1 = await get(`/api/v1/denials/${claimless}/payer-appeals`);
    expect(v1).toMatchObject({ patientId: null, patientAttribution: "unattributed" });
    expect((await events("denial_case", claimless)).length).toBeGreaterThan(0);
    const v2 = await get(`/api/v1/denials/${withClaim}/payer-appeals`);
    expect(v2).toMatchObject({ patientId: claimPatient, patientAttribution: "claim" });
    expect((await events("denial_case", withClaim)).some((e) => e.pid === claimPatient)).toBe(true);

    expect(await get(`/api/v1/payer-appeals/${c1.id}`)).toMatchObject({
      patientAttribution: "unattributed",
    });
    expect((await events("payer_appeal_case", c1.id)).length).toBeGreaterThan(0);
    expect(await get(`/api/v1/payer-appeals/${c2.id}`)).toMatchObject({ patientId: claimPatient });
    expect((await events("payer_appeal_case", c2.id)).some((e) => e.pid === claimPatient)).toBe(
      true,
    );

    expect(await get(`/api/v1/payer-appeals/${c1.id}/recorded-deadlines`)).toMatchObject({
      patientAttribution: "unattributed",
    });
    expect((await events("payer_appeal_case", c1.id)).length).toBeGreaterThan(1);
    expect(await get(`/api/v1/denials/${claimless}/case-view`)).toMatchObject({
      patientAttribution: "unattributed",
    });
    expect((await events("denial_case_view", claimless)).length).toBeGreaterThan(0);
    expect(await get(`/api/v1/denials/${withClaim}/case-view`)).toMatchObject({
      patientId: claimPatient,
    });

    // the path routes surface no patient and declare a justified waiver; malformed filters are a 400, never a 500
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/payer-appeal-paths" })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/payer-appeal-paths?payerId=nope" }))
        .statusCode,
    ).toBe(422);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/payer-appeal-paths?status=bogus" }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/v1/payer-appeal-paths?payerId=${payerId}&status=draft`,
        })
      ).statusCode,
    ).toBe(200);
    await app.close();
  });

  // ── the REAL payer seam (M40 `createDbMdmStore`), not the injected fake ──────────────────────────────────
  it("resolves a real M40 payer end to end: path -> second user verifies -> level opens -> deadline only with a typed notice date", async () => {
    const realPayer = randomUUID();
    await fx.admin.query(
      "INSERT INTO payer (id, kind, name, status) VALUES ($1, 'commercial', 'Real Seam Payer', 'active')",
      [realPayer],
    );
    registerMdmSeams({ store: createDbMdmStore(fx.handle.db) });
    const realPath = buildDrizzlePayerAppealPathService(fx.handle.db, {});
    const realAppeal = buildDrizzlePayerAppealService(fx.handle.db, {
      providerZones,
      sources: buildSeamAppealSourcePorts(),
    });

    const created = await realPath.createPath(A(), pathInput({ payerId: realPayer }) as never);
    await realPath.verifyPath(R(), created.id, created.version);
    expect((await realPath.getPath(A(), created.id))?.payerName).toBe("Real Seam Payer");

    const denial = await mkDenial("commercial", { payer: realPayer });
    const view = await realAppeal.getForDenial(A(), denial);
    expect(view).toMatchObject({
      payerName: "Real Seam Payer",
      payerUnresolved: false,
      path: { id: created.id, verified: true },
    });

    // no typed notice date: the window is complete but nothing is computed
    const noNotice = await realAppeal.open(A(), denial, { levelLabel: "L1", levelKind: "internal" });
    expect(noNotice.deadlineSource).toBe("none");
    const noticeless = await realAppeal.getCase(A(), noNotice.id);
    expect(noticeless?.deadlineAt).toBeNull();

    // typed notice date under the verified path: computed, equal to the pure function
    const denial2 = await mkDenial("commercial", { payer: realPayer });
    const notice = daysAgo(3);
    const opened = await realAppeal.open(A(), denial2, { noticeDate: notice });
    expect(opened.deadlineSource).toBe("path_rule");
    const c = await realAppeal.getCase(A(), opened.id);
    expect(c?.deadlineAt).toBe((await expectedDeadline(notice))?.toISOString());
    expect(c).toMatchObject({ pathId: created.id, windowVerified: true, deadlineState: "computed" });

    // the route returns the same non-null path and payer name
    const app = makeApp(["appeal.read", "payer_appeal.read"], buildSeamPayerSeam());
    const res = await app.inject({ method: "GET", url: `/api/v1/denials/${denial2}/payer-appeals` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      payerName: "Real Seam Payer",
      payerUnresolved: false,
      path: { id: created.id },
    });
    await app.close();
  });

  it("re-applies migrations 1206-1209 idempotently", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const f of [
      "1206_m25_payer_appeal_path.sql",
      "1207_m25_payer_appeal_case.sql",
      "1208_m25_recorded_deadline_payer_appeal.sql",
      "1209_m25_m12_role_grants.sql",
    ]) {
      await fx.admin.query(readFileSync(join(fx.migrationsDir, f), "utf8"));
    }
    const n = (await fx.admin.query("SELECT count(*)::int AS n FROM payer_appeal_path")).rows[0].n;
    expect(n).toBeGreaterThan(0);
  });
});
