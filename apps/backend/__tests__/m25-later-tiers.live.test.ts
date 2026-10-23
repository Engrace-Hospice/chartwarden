/**
 * M25 later tiers, milestone 7a-1 (hospice ADR/TPE/QIC PRD) - LIVE Postgres as the NOBYPASSRLS `chartwarden_app` role,
 * through the real services, routes and nightly cron.
 *
 * Proves what the pure suites cannot: an ALJ case opened by QIC escalation accepts later-tier detail and a deadline
 * typed from a notice, and its already-past tier instant raises no alert; a recorded deadline alerts exactly once per
 * boundary and never for a past or satisfied date; the stored amount in controversy is never compared to anything; an
 * unfavorable ALJ decision still spawns the next tier (a draft carrying the unconfirmed-window flag on the case view)
 * while federal court is record-only (a packet render is refused and nothing is published); the tier guard, the
 * counsel/hearing CHECKs and the satisfied-deadline freeze hold in the database; another tenant sees nothing; the
 * one case view audits its read and honours the read key; free text stays out of the audit trail; and migration 1173
 * grants the new keys to existing roles.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:later-tiers:live
 * (SUPERUSER to a THROWAWAY db - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
import { buildServer, registerSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  createDocumentReader,
  createDrizzleDocumentReaderStore,
} from "../src/modules/22-documents/index";
import { registerM23PublishedSeams } from "../src/modules/23-billing-medicare/cost-report-seams";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { runAppealDeadlineCron } from "../src/modules/25-remittance/jobs/cron-workers";
import { buildSeamAppealSourcePorts } from "../src/modules/25-remittance/routes/appeal-packet-sources";
import { buildDrizzleCaseViewService } from "../src/modules/25-remittance/routes/case-view-service";
import { registerCaseViewRoutes } from "../src/modules/25-remittance/routes/case-view.routes";
import { buildDrizzleLaterTierService } from "../src/modules/25-remittance/routes/later-tier-service";
import { registerLaterTierRoutes } from "../src/modules/25-remittance/routes/later-tier.routes";
import { buildDrizzleM25WriteService } from "../src/modules/25-remittance/routes/write-service-drizzle";
import { type M7Fixture, ORG, ORG_B, daysAgo, daysAhead, setupM7Fixture } from "./_m25-m7-fixture";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (v) => UUID_RE.test(v));
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)));
}

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const NEW_TABLES = ["appeal_tier_detail", "recorded_deadline"];

describe.skipIf(!DB_URL)("M25 later tiers (milestone 7a-1) - LIVE Postgres", () => {
  let fx: M7Fixture;

  const outbox = buildTxOutboxPublisher(buildBootOutboxCatalog([M25_OUTBOX_EVENTS]));
  const m25Outbox = {
    publish: (
      tx: unknown,
      input: Parameters<typeof outbox.publish>[1] extends infer I ? Omit<I, "callerModule"> : never,
    ) =>
      outbox.publish(tx as Parameters<typeof outbox.publish>[0], { ...input, callerModule: "m25" }),
  };
  const providerZones = (tx: DbClient, pe: string) =>
    buildFoundationSiteReader().providerEntityTimezones(tx, pe);
  const tier = () =>
    buildDrizzleLaterTierService(fx.handle.db, {
      providerZones,
      sources: buildSeamAppealSourcePorts(),
    });
  const write = () =>
    buildDrizzleM25WriteService(fx.handle.db, m25Outbox, {
      appealSources: buildSeamAppealSourcePorts(),
      providerZones,
    });
  const A = () => fx.actor();
  const B = () => fx.actor(ORG_B);

  async function cron(now: () => Date = () => new Date()) {
    const dispatched: { alertCode: string; payload: Record<string, unknown> }[] = [];
    await runAppealDeadlineCron({
      connection: {} as never,
      db: fx.handle.db,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG }] },
      alerts: { dispatch: async (a) => void dispatched.push(a) },
      now,
    });
    return dispatched;
  }
  const recordedAlerts = (d: Awaited<ReturnType<typeof cron>>, deadlineId: string) =>
    d.filter(
      (a) => a.alertCode === "deadline.recorded_approaching" && a.payload.deadlineId === deadlineId,
    );

  /** An ALJ case opened by a QIC escalation: submitted, filed by escalation, its tier instant already past. */
  async function escalatedAlj(claimId = fx.claim1, pe = fx.pe1): Promise<string> {
    const recon = await fx.mkAppeal({
      claimId,
      pe,
      tier: "reconsideration",
      state: "under_review",
    });
    return fx.mkAppeal({
      claimId,
      pe,
      tier: "alj",
      state: "submitted",
      deadline: new Date(Date.now() - 864e5).toISOString(),
      prior: recon,
      escalated: true,
    });
  }

  function makeApp(keys: string[], opts: { role?: string; scope?: string[]; user?: string } = {}) {
    const user = opts.user ?? fx.userA;
    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore([
        {
          orgId: ORG,
          userId: user,
          grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys: keys }],
        },
      ]).store,
    );
    const app = buildServer({
      db: fx.handle.db as never,
      authenticate: (request: FastifyRequest) => {
        request.context.userId = user;
        request.context.organizationId = ORG;
        request.context.roles = [opts.role ?? "billing_manager"];
        request.context.providerEntityIds = opts.scope ?? [fx.pe1, fx.pe2];
        request.context.attributes = { ...request.context.attributes, membershipId: fx.memberA };
      },
      security: { rateLimitEnabled: false },
    });
    registerLaterTierRoutes(app, { laterTierService: tier() });
    registerCaseViewRoutes(app, {
      caseViewService: buildDrizzleCaseViewService(fx.handle.db),
    });
    return app;
  }
  const WRITE = (version?: number) => ({
    "idempotency-key": randomUUID(),
    ...(version === undefined ? {} : { "if-match": String(version) }),
  });

  beforeAll(async () => {
    fx = await setupM7Fixture(DB_URL as string, "m25-lt");
    registerM23PublishedSeams(fx.handle.db);
    registerSeam(
      "DocumentReader",
      createDocumentReader(createDrizzleDocumentReaderStore(fx.handle.db)),
    );
  }, 300_000);

  afterAll(async () => {
    await fx?.close();
    resetAuthorizationContract();
    resetRbacEngine();
  });

  // ── schema posture ───────────────────────────────────────────────────────────────────────────────────────
  it("registers the new key and grants it to existing roles by migration 1173 (idempotent; the appeal ABAC override is not copied onto the audit keys)", async () => {
    const keys = (
      await fx.admin.query(
        `SELECT key FROM permission WHERE key IN ('appeal.tier_record','audit_request.read','audit_request.manage')`,
      )
    ).rows.map((r) => r.key as string);
    expect(keys.sort()).toEqual([
      "appeal.tier_record",
      "audit_request.manage",
      "audit_request.read",
    ]);
    const roleId = (
      await fx.admin.query(
        `INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'m7-billing','Billing','billing_finance',true) RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    for (const [key, abac] of [
      ["appeal.read", "narrowed_predicate"],
      ["appeal.create", null],
    ]) {
      await fx.admin.query(
        `INSERT INTO role_permission (organization_id, role_id, permission_key, abac_override) VALUES ($1,$2,$3,$4)`,
        [ORG, roleId, key, abac],
      );
    }
    const migration = readFileSync(join(fx.migrationsDir, "1173_m25_m7_role_grants.sql"), "utf8");
    await fx.admin.query(migration);
    await fx.admin.query(migration);
    const granted = (
      await fx.admin.query(
        `SELECT permission_key, abac_override FROM role_permission WHERE role_id=$1 AND (permission_key LIKE 'audit_request%' OR permission_key='appeal.tier_record') ORDER BY permission_key`,
        [roleId],
      )
    ).rows;
    expect(granted).toEqual([
      { permission_key: "appeal.tier_record", abac_override: null },
      { permission_key: "audit_request.manage", abac_override: null },
      { permission_key: "audit_request.read", abac_override: null },
    ]);
  });

  it("forces RLS on both tables and gives the app role no DELETE", async () => {
    const forced = (
      await fx.admin.query(
        `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity ORDER BY relname`,
        [NEW_TABLES],
      )
    ).rows.map((r) => r.relname);
    expect(forced).toEqual([...NEW_TABLES].sort());
    for (const table of NEW_TABLES) {
      const msg = await fx.dbMessage(fx.asApp((tx) => tx.execute(sql.raw(`DELETE FROM ${table}`))));
      expect(msg, table).toMatch(/permission denied/i);
    }
  });

  // ── an escalated ALJ case: detail, deadline, no alert from its past tier instant ─────────────────────────
  describe("an ALJ case opened by escalation", () => {
    it("accepts later-tier detail (create at version 0, then update) and stores the amount untouched", async () => {
      const id = await escalatedAlj();
      const created = await tier().putTierDetail(
        A(),
        id,
        {
          authorityReference: "OMHA-REF-123",
          amountInControversyCents: 12_345_678,
          hearingOn: daysAhead(40),
          hearingFormatNote: "telephone",
        },
        0,
      );
      expect(created.version).toBe(1);
      const updated = await tier().putTierDetail(
        A(),
        id,
        {
          authorityReference: "OMHA-REF-123",
          amountInControversyCents: 5,
          dispositionKind: "remand",
          dispositionNote: "back to the QIC",
        },
        created.version,
      );
      expect(updated.version).toBe(2);
      const view = await tier().getLaterTier(A(), id);
      expect(view).toMatchObject({
        tier: "alj",
        filedByEscalation: true,
        windowUnconfirmed: true,
        canPacketRender: true,
        needsManualReview: true,
        detail: { amountInControversyCents: 5, dispositionKind: "remand" },
      });
      // a stale or wrong version never overwrites
      expect((await fx.refused(tier().putTierDetail(A(), id, {}, 1)))?.code).toBe(
        "VERSION_CONFLICT",
      );
      expect((await fx.refused(tier().putTierDetail(A(), id, {}, 0)))?.code).toBe(
        "VERSION_CONFLICT",
      );
      // a remand records a label only: nothing spawned, the case outcome is untouched
      const spawned = await fx.admin.query(
        "SELECT count(*)::int AS n FROM appeal_case WHERE prior_tier_appeal_case_id=$1",
        [id],
      );
      expect(spawned.rows[0].n).toBe(0);
    });

    it("raises no deadline alert from its past tier instant", async () => {
      const id = await escalatedAlj();
      const dispatched = await cron();
      expect(
        dispatched.filter(
          (d) => d.alertCode === "appeal.deadline_approaching" && d.payload.appealCaseId === id,
        ),
      ).toEqual([]);
    });

    it("refuses what a tier may not hold, in the service and in the database", async () => {
      const alj = await escalatedAlj();
      expect(
        (await fx.refused(tier().putTierDetail(A(), alj, { docketReference: "1:26-cv-1" }, 0)))
          ?.code,
      ).toBe("TIER_DETAIL_FEDERAL_ONLY_FIELD");
      expect(
        (await fx.refused(tier().putTierDetail(A(), alj, { amountInControversyCents: -1 }, 0)))
          ?.code,
      ).toBe("TIER_DETAIL_AMOUNT_INVALID");
      const court = await fx.mkAppeal({
        claimId: fx.claim1,
        pe: fx.pe1,
        tier: "federal_court",
        state: "submitted",
      });
      expect(
        (await fx.refused(tier().putTierDetail(A(), court, { hearingOn: daysAhead(5) }, 0)))?.code,
      ).toBe("TIER_DETAIL_HEARING_NOT_RECORDED");
      const recon = await fx.mkAppeal({ claimId: fx.claim1, pe: fx.pe1, tier: "reconsideration" });
      expect((await fx.refused(tier().putTierDetail(A(), recon, {}, 0)))?.statusCode).toBe(404);
      expect(await tier().getLaterTier(A(), recon)).toBeNull();
      // the tier column must equal the case's tier, whatever the caller writes
      const msg = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql`INSERT INTO appeal_tier_detail (organization_id, provider_entity_id, appeal_case_id, tier)
                VALUES (${ORG}, ${fx.pe1}, ${recon}, 'alj')`,
          ),
        ),
      );
      expect(msg).toMatch(/M25_TIER_DETAIL_TIER/);
      // the CHECKs hold against a writer that skips the service
      const bad = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql`INSERT INTO appeal_tier_detail (organization_id, provider_entity_id, appeal_case_id, tier, docket_reference)
                VALUES (${ORG}, ${fx.pe1}, ${alj}, 'alj', 'x')`,
          ),
        ),
      );
      expect(bad).toMatch(/appeal_tier_detail_counsel_federal_only/);
    });

    it("freezes the detail once the case is closed", async () => {
      const id = await escalatedAlj();
      await tier().putTierDetail(A(), id, { authorityReference: "OMHA-9" }, 0);
      await fx.admin.query("UPDATE appeal_case SET state='closed', closed_at=now() WHERE id=$1", [
        id,
      ]);
      expect(
        (await fx.refused(tier().putTierDetail(A(), id, { authorityReference: "OMHA-10" }, 1)))
          ?.code,
      ).toBe("TIER_DETAIL_FROZEN");
    });
  });

  // ── recorded deadlines ───────────────────────────────────────────────────────────────────────────────────
  describe("recorded deadlines", () => {
    it("requires a source note and a real date, and stamps the zone", async () => {
      const id = await escalatedAlj();
      const blank = await fx.refused(
        tier().createDeadline(
          A(),
          { kind: "appeal", id },
          { label: "Hearing", dueOn: daysAhead(20), sourceNote: "  " },
        ),
      );
      expect(blank?.code).toBe("DEADLINE_SOURCE_NOTE_REQUIRED");
      const badDate = await fx.refused(
        tier().createDeadline(
          A(),
          { kind: "appeal", id },
          { label: "Hearing", dueOn: "2026-02-30", sourceNote: "notice p2" },
        ),
      );
      expect(badDate?.code).toBe("DEADLINE_DUE_DATE_INVALID");
      const ok = await tier().createDeadline(
        A(),
        { kind: "appeal", id },
        { label: "Hearing", dueOn: daysAhead(20), sourceNote: "OMHA notice p2" },
      );
      const { items } = await tier().listDeadlines(A(), { kind: "appeal", id });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        id: ok.id,
        status: "open",
        subjectKind: "appeal",
        subjectId: id,
      });
      expect(items[0]?.zone).toMatch(/\//);
      // the database refuses a blank note even from a writer that skips the service
      const msg = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql`INSERT INTO recorded_deadline (organization_id, provider_entity_id, appeal_case_id, label, due_on, zone, source_note)
                VALUES (${ORG}, ${fx.pe1}, ${id}, 'x', CURRENT_DATE, 'America/New_York', ' ')`,
          ),
        ),
      );
      expect(msg).toMatch(/source_note/);
    });

    it("alerts exactly once per boundary, restarts the ladder when the date moves, and never for past or satisfied dates", async () => {
      const id = await escalatedAlj();
      const soon = await tier().createDeadline(
        A(),
        { kind: "appeal", id },
        { label: "Response", dueOn: daysAhead(6), sourceNote: "notice" },
      );
      const far = await tier().createDeadline(
        A(),
        { kind: "appeal", id },
        { label: "Far", dueOn: daysAhead(90), sourceNote: "notice" },
      );
      const past = await tier().createDeadline(
        A(),
        { kind: "appeal", id },
        { label: "Past", dueOn: daysAgo(0), sourceNote: "notice" },
      );
      await fx.admin.query("UPDATE recorded_deadline SET due_on = CURRENT_DATE - 3 WHERE id=$1", [
        past.id,
      ]);
      const done = await tier().createDeadline(
        A(),
        { kind: "appeal", id },
        { label: "Done", dueOn: daysAhead(5), sourceNote: "notice" },
      );
      await tier().satisfyDeadline(A(), { kind: "appeal", id }, done.id, undefined, done.version);

      const first = await cron();
      expect(recordedAlerts(first, soon.id)).toHaveLength(1);
      expect(recordedAlerts(first, soon.id)[0]?.payload).toEqual({
        deadlineId: soon.id,
        subjectKind: "appeal",
        subjectId: id,
        daysRemaining: 7,
      });
      expect(recordedAlerts(first, far.id)).toEqual([]);
      expect(recordedAlerts(first, past.id)).toEqual([]);
      expect(recordedAlerts(first, done.id)).toEqual([]);
      // a second tick on the same day repeats nothing
      expect(recordedAlerts(await cron(), soon.id)).toEqual([]);
      // six days on, the next boundary (1 day) fires once
      const later = () => new Date(Date.now() + 6 * 864e5);
      expect(
        recordedAlerts(await cron(later), soon.id).map((a) => a.payload.daysRemaining),
      ).toEqual([1]);
      expect(recordedAlerts(await cron(later), soon.id)).toEqual([]);
      // moving the date restarts the ladder
      const cur = (await tier().listDeadlines(A(), { kind: "appeal", id })).items.find(
        (d) => d.id === soon.id,
      );
      await tier().updateDeadline(
        A(),
        { kind: "appeal", id },
        soon.id,
        { dueOn: daysAhead(13) },
        cur?.version as number,
      );
      expect(recordedAlerts(await cron(), soon.id).map((a) => a.payload.daysRemaining)).toEqual([
        14,
      ]);
    });

    it("freezes a satisfied deadline in the database and the service", async () => {
      const id = await escalatedAlj();
      const d = await tier().createDeadline(
        A(),
        { kind: "appeal", id },
        { label: "Brief", dueOn: daysAhead(10), sourceNote: "notice" },
      );
      const s = await tier().satisfyDeadline(
        A(),
        { kind: "appeal", id },
        d.id,
        daysAgo(0),
        d.version,
      );
      expect(
        (
          await fx.refused(
            tier().updateDeadline(A(), { kind: "appeal", id }, d.id, { label: "x" }, s.version),
          )
        )?.code,
      ).toBe("DEADLINE_SATISFIED");
      const msg = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(sql`UPDATE recorded_deadline SET label='changed' WHERE id=${d.id}`),
        ),
      );
      expect(msg).toMatch(/M25_RECORDED_DEADLINE_FROZEN/);
    });

    it("takes a notice document only after the document seam validates it", async () => {
      const id = await escalatedAlj();
      const patient = (
        await fx.admin.query("SELECT patient_id FROM claim WHERE id=$1", [fx.claim1])
      ).rows[0].patient_id as string;
      const doc = async (
        org: string,
        patientId: string | null,
        over: { retentionClass?: string } = {},
      ) =>
        (
          await fx.admin.query(
            `INSERT INTO document (organization_id, patient_id, retention_class, source_kind, aggregate_type, title, status, created_by_membership_id)
             VALUES ($1,$2,$3,'user_upload','encounter','Hearing notice','active',$4) RETURNING id`,
            [org, patientId, over.retentionClass ?? "clinical_record", fx.memberA],
          )
        ).rows[0].id as string;
      const make = (documentId: string) =>
        tier().createDeadline(
          A(),
          { kind: "appeal", id },
          { label: "Notice", dueOn: daysAhead(10), sourceNote: "n", noticeDocumentId: documentId },
        );
      for (const bad of [
        randomUUID(),
        await doc(ORG, randomUUID()),
        await doc(ORG, patient, { retentionClass: "compliance_42cfr_part2" }),
        await doc(ORG_B, null),
      ]) {
        expect((await fx.refused(make(bad)))?.code).toBe("APPEAL_DOCUMENT_NOT_ATTACHABLE");
      }
      const good = await doc(ORG, patient);
      const ok = await make(good);
      const stored = (await tier().listDeadlines(A(), { kind: "appeal", id })).items.find(
        (d) => d.id === ok.id,
      );
      expect(stored?.noticeDocumentId).toBe(good);
    });
  });

  // ── unfavorable decisions, remand/dismissal and federal court ────────────────────────────────────────────
  describe("next tiers", () => {
    it("an unfavorable ALJ decision still spawns a Council draft, flagged unconfirmed on the case view", async () => {
      const claim = fx.claim1b;
      const alj = await escalatedAlj(claim, fx.pe1);
      await write().ackAppeal(A(), alj, await fx.ver("appeal_case", alj));
      await write().decideAppeal(
        A(),
        alj,
        {
          outcome: "unfavorable",
          decidedAt: new Date().toISOString(),
          reason: "ALJ decision on the record.",
        },
        await fx.ver("appeal_case", alj),
      );
      const spawned = (
        await fx.admin.query(
          "SELECT id, tier, state FROM appeal_case WHERE prior_tier_appeal_case_id=$1",
          [alj],
        )
      ).rows;
      expect(spawned).toEqual([{ id: spawned[0].id, tier: "council", state: "draft" }]);
      const view = await buildDrizzleCaseViewService(fx.handle.db).getCaseView(A(), claim, {
        includeAdr: true,
        includeReopening: true,
        includeAudits: true,
      });
      const council = view.items.find((i) => i.id === spawned[0].id);
      expect(council).toMatchObject({
        kind: "appeal",
        tier: "council",
        windowConfirmed: false,
        deadlineSource: "computed",
      });
      expect(view.nextDeadline?.id).toBe(spawned[0].id);
    });

    it("a remand or dismissal label spawns nothing and changes no outcome", async () => {
      const id = await escalatedAlj(fx.claim2, fx.pe2);
      await tier().putTierDetail(
        A(),
        id,
        { dispositionKind: "dismissal", dispositionNote: "dismissed by order" },
        0,
      );
      const row = (
        await fx.admin.query("SELECT state, decision_outcome FROM appeal_case WHERE id=$1", [id])
      ).rows[0];
      expect(row).toEqual({ state: "submitted", decision_outcome: null });
      expect(
        Number(
          (
            await fx.admin.query(
              "SELECT count(*) FROM appeal_case WHERE prior_tier_appeal_case_id=$1",
              [id],
            )
          ).rows[0].count,
        ),
      ).toBe(0);
    });

    it("federal court is record-only: a packet render is refused and nothing is published", async () => {
      const court = await fx.mkAppeal({
        claimId: fx.claim1,
        pe: fx.pe1,
        tier: "federal_court",
        state: "draft",
      });
      const before = Number(
        (
          await fx.admin.query(
            "SELECT count(*) FROM outbox_event WHERE event_type='m25.appeal_packet.render_requested'",
          )
        ).rows[0].count,
      );
      const r = await fx.refused(
        write().submitAppeal(
          A(),
          court,
          { appealNarrative: "n".repeat(60), attachedDocumentIds: [] } as never,
          await fx.ver("appeal_case", court),
        ),
      );
      expect(r?.code).toBe("FEDERAL_COURT_RECORD_ONLY");
      const after = Number(
        (
          await fx.admin.query(
            "SELECT count(*) FROM outbox_event WHERE event_type='m25.appeal_packet.render_requested'",
          )
        ).rows[0].count,
      );
      expect(after).toBe(before);
      expect(
        (await fx.admin.query("SELECT state FROM appeal_case WHERE id=$1", [court])).rows[0].state,
      ).toBe("draft");
      // what it may do: record that counsel filed
      await tier().putTierDetail(
        A(),
        court,
        { filedByCounselOn: daysAgo(2), docketReference: "1:26-cv-4242" },
        0,
      );
      expect((await tier().getLaterTier(A(), court))?.canPacketRender).toBe(false);
    });
  });

  // ── finished subjects, late good cause, attribution ──────────────────────────────────────────────────────
  describe("review hardening", () => {
    it("stops alerting for a closed or withdrawn subject and refuses to change its deadlines", async () => {
      const closed = await escalatedAlj();
      const open = await escalatedAlj();
      const dClosed = await tier().createDeadline(
        A(),
        { kind: "appeal", id: closed },
        { label: "Brief", dueOn: daysAhead(6), sourceNote: "n" },
      );
      const dOpen = await tier().createDeadline(
        A(),
        { kind: "appeal", id: open },
        { label: "Brief", dueOn: daysAhead(6), sourceNote: "n" },
      );
      await fx.admin.query("UPDATE appeal_case SET state='closed', closed_at=now() WHERE id=$1", [
        closed,
      ]);
      const dispatched = await cron();
      expect(recordedAlerts(dispatched, dClosed.id)).toEqual([]);
      expect(recordedAlerts(dispatched, dOpen.id)).toHaveLength(1);
      expect(
        (
          await fx.refused(
            tier().updateDeadline(
              A(),
              { kind: "appeal", id: closed },
              dClosed.id,
              { label: "x" },
              dClosed.version,
            ),
          )
        )?.code,
      ).toBe("DEADLINE_SUBJECT_FINISHED");
      expect(
        (
          await fx.refused(
            tier().satisfyDeadline(
              A(),
              { kind: "appeal", id: closed },
              dClosed.id,
              undefined,
              dClosed.version,
            ),
          )
        )?.code,
      ).toBe("DEADLINE_SUBJECT_FINISHED");
    });

    it("advances the alerted boundary monotonically and never back to a wider one", async () => {
      const id = await escalatedAlj();
      const d = await tier().createDeadline(
        A(),
        { kind: "appeal", id },
        { label: "Brief", dueOn: daysAhead(6), sourceNote: "n" },
      );
      await cron();
      const row = async () =>
        (
          await fx.admin.query("SELECT last_alerted_boundary FROM recorded_deadline WHERE id=$1", [
            d.id,
          ])
        ).rows[0].last_alerted_boundary;
      expect(await row()).toBe(7);
      // a later tick (boundary 1) advances it from 7; it never goes back to a wider boundary
      await cron(() => new Date(Date.now() + 6 * 864e5));
      expect(await row()).toBe(1);
      await cron();
      expect(await row()).toBe(1);
    });

    it("refuses a late good-cause federal-court filing too, and leaves no submission attempt", async () => {
      const court = await fx.mkAppeal({
        claimId: fx.claim1,
        pe: fx.pe1,
        tier: "federal_court",
        state: "draft",
        deadline: new Date(Date.now() - 864e5).toISOString(),
      });
      const r = await fx.refused(
        write().submitAppealLateGoodCause(
          A(),
          court,
          {
            appealNarrative: "n".repeat(60),
            attachedDocumentIds: [],
            goodCauseJustification: "j".repeat(60),
          } as never,
          await fx.ver("appeal_case", court),
        ),
      );
      expect(r?.code).toBe("FEDERAL_COURT_RECORD_ONLY");
      // attempts are created only by the submit paths, which refuse federal court: none can exist for it
      const attempts = await fx.admin.query(
        "SELECT count(*)::int AS n FROM submission_attempt WHERE appeal_case_id=$1",
        [court],
      );
      expect(attempts.rows[0].n).toBe(0);
    });

    it("attributes the reads to the claim's patient, in the payload and the read-audit trail", async () => {
      const id = await escalatedAlj();
      await tier().createDeadline(
        A(),
        { kind: "appeal", id },
        { label: "Brief", dueOn: daysAhead(9), sourceNote: "n" },
      );
      const patient = (
        await fx.admin.query("SELECT patient_id FROM claim WHERE id=$1", [fx.claim1])
      ).rows[0].patient_id as string;
      expect((await tier().getLaterTier(A(), id))?.patientId).toBe(patient);
      expect((await tier().listDeadlines(A(), { kind: "appeal", id })).patientId).toBe(patient);
      const view = await buildDrizzleCaseViewService(fx.handle.db).getCaseView(A(), fx.claim1, {
        includeAdr: false,
        includeReopening: false,
        includeAudits: false,
      });
      expect(view.patientId).toBe(patient);
      const app = makeApp(["appeal.read"]);
      await fx.admin.query(
        "DELETE FROM audit_event WHERE organization_id=$1 AND event_type='appeal_case.viewed'",
        [ORG],
      );
      expect(
        (await app.inject({ method: "GET", url: `/api/v1/appeals/${id}/later-tier` })).statusCode,
      ).toBe(200);
      await app.close();
      const logged = (
        await fx.admin.query(
          "SELECT context->>'patientId' AS pid FROM audit_event WHERE organization_id=$1 AND event_type='appeal_case.viewed'",
          [ORG],
        )
      ).rows;
      expect(logged.map((r) => r.pid)).toEqual([patient]);
    });
  });

  // ── tenancy ──────────────────────────────────────────────────────────────────────────────────────────────
  describe("another tenant", () => {
    it("sees none of it, through the service or as the app role, and cannot attach a deadline to it", async () => {
      const id = await escalatedAlj();
      await tier().putTierDetail(A(), id, { authorityReference: "OMHA-SECRET" }, 0);
      const d = await tier().createDeadline(
        A(),
        { kind: "appeal", id },
        { label: "Hearing", dueOn: daysAhead(9), sourceNote: "n" },
      );
      expect(
        (await fx.refused(tier().listDeadlines(B(), { kind: "appeal", id })))?.statusCode,
      ).toBe(404);
      expect(await tier().getLaterTier(B(), id)).toBeNull();
      expect(
        (
          await fx.refused(
            tier().createDeadline(
              B(),
              { kind: "appeal", id },
              { label: "x", dueOn: daysAhead(9), sourceNote: "n" },
            ),
          )
        )?.statusCode,
      ).toBe(404);
      for (const table of NEW_TABLES) {
        const rows = await fx.asApp((tx) => tx.execute(sql.raw(`SELECT id FROM ${table}`)), ORG_B);
        expect(
          (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown[]),
          table,
        ).toHaveLength(0);
      }
      // a writer that skips the service still cannot point at another tenant's case
      const msg = await fx.dbMessage(
        fx.asApp(
          (tx) =>
            tx.execute(
              sql`INSERT INTO recorded_deadline (organization_id, provider_entity_id, appeal_case_id, label, due_on, zone, source_note)
                  VALUES (${ORG_B}, ${fx.peB}, ${id}, 'x', CURRENT_DATE, 'America/New_York', 'n')`,
            ),
          ORG_B,
        ),
      );
      expect(msg).toMatch(/M25_RECORDED_DEADLINE_PARENT/);
      expect(d.id).toBeTruthy();
    });
  });

  // ── the audit trail ──────────────────────────────────────────────────────────────────────────────────────
  it("keeps free text out of the audit trail while recording the writes", async () => {
    const id = await escalatedAlj();
    await tier().putTierDetail(
      A(),
      id,
      { authorityReference: "SECRET-AUTH-REF", hearingFormatNote: "SECRET-HEARING-NOTE" },
      0,
    );
    await tier().createDeadline(
      A(),
      { kind: "appeal", id },
      { label: "SECRET-LABEL", dueOn: daysAhead(9), sourceNote: "SECRET-SOURCE" },
    );
    const kinds = (
      await fx.admin.query(
        "SELECT DISTINCT resource_kind FROM audit_event WHERE organization_id=$1 AND resource_kind IN ('appeal_tier_detail','recorded_deadline')",
        [ORG],
      )
    ).rows.map((r) => r.resource_kind as string);
    expect(kinds.sort()).toEqual(["appeal_tier_detail", "recorded_deadline"]);
    const all = JSON.stringify(
      (
        await fx.admin.query(
          "SELECT before, after FROM audit_event WHERE organization_id=$1 AND resource_kind IN ('appeal_tier_detail','recorded_deadline')",
          [ORG],
        )
      ).rows,
    );
    for (const secret of [
      "SECRET-AUTH-REF",
      "SECRET-HEARING-NOTE",
      "SECRET-LABEL",
      "SECRET-SOURCE",
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  // ── routes: gates, the case view, read audit ─────────────────────────────────────────────────────────────
  describe("routes", () => {
    it("gates the later-tier reads on appeal.read and its writes on appeal.tier_record", async () => {
      const id = await escalatedAlj();
      const reader = makeApp(["appeal.read"]);
      expect(
        (await reader.inject({ method: "GET", url: `/api/v1/appeals/${id}/later-tier` }))
          .statusCode,
      ).toBe(200);
      const denied = await reader.inject({
        method: "PUT",
        url: `/api/v1/appeals/${id}/later-tier/detail`,
        headers: WRITE(0),
        payload: { authorityReference: "x" },
      });
      expect(denied.statusCode).toBe(403);
      await reader.close();
      const writer = makeApp(["appeal.read", "appeal.tier_record"]);
      const put = await writer.inject({
        method: "PUT",
        url: `/api/v1/appeals/${id}/later-tier/detail`,
        headers: WRITE(0),
        payload: { authorityReference: "OMHA-ROUTE", amountInControversyCents: 100 },
      });
      expect(put.statusCode).toBe(200);
      const created = await writer.inject({
        method: "POST",
        url: `/api/v1/appeals/${id}/recorded-deadlines`,
        headers: WRITE(),
        payload: { label: "Hearing", dueOn: daysAhead(12), sourceNote: "OMHA notice" },
      });
      expect(created.statusCode).toBe(201);
      const noNote = await writer.inject({
        method: "POST",
        url: `/api/v1/appeals/${id}/recorded-deadlines`,
        headers: WRITE(),
        payload: { label: "Hearing", dueOn: daysAhead(12) },
      });
      expect(noNote.statusCode).toBe(422);
      const noKey = await writer.inject({
        method: "POST",
        url: `/api/v1/appeals/${id}/recorded-deadlines`,
        payload: { label: "Hearing", dueOn: daysAhead(12), sourceNote: "n" },
      });
      expect(noKey.statusCode).toBe(400);
      expect(
        (await writer.inject({ method: "GET", url: "/api/v1/appeals/not-a-uuid/later-tier" }))
          .statusCode,
      ).toBe(404);
      await writer.close();
    });

    it("serves the one case view, keyed on the claim, honouring the read keys and the provider scope", async () => {
      const claim = fx.claim2;
      const prior = await fx.mkAppeal({
        claimId: claim,
        pe: fx.pe2,
        tier: "reconsideration",
        state: "under_review",
      });
      const alj = await fx.mkAppeal({
        claimId: claim,
        pe: fx.pe2,
        tier: "alj",
        state: "submitted",
        prior,
        escalated: true,
      });
      await tier().createDeadline(
        A(),
        { kind: "appeal", id: alj },
        { label: "Position paper", dueOn: daysAhead(15), sourceNote: "notice" },
      );
      await fx.admin.query(
        `INSERT INTO adr_case (organization_id, provider_entity_id, claim_id, mac_name, review_type, requested_on,
           window_days, window_source, response_due_at)
         VALUES ($1,$2,$3,'CGS','adr',CURRENT_DATE,45,'org_rule', now() + interval '30 days')`,
        [ORG, fx.pe2, claim],
      );
      await fx.admin.query(
        `INSERT INTO audit_request (organization_id, provider_entity_id, authority_kind, received_on) VALUES ($1,$2,'upic',CURRENT_DATE) RETURNING id`,
        [ORG, fx.pe2],
      );
      const arId = (
        await fx.admin.query("SELECT id FROM audit_request ORDER BY created_at DESC LIMIT 1")
      ).rows[0].id as string;
      await fx.admin.query(
        `INSERT INTO audit_request_claim (organization_id, audit_request_id, claim_id) VALUES ($1,$2,$3)`,
        [ORG, arId, claim],
      );
      const full = makeApp(["appeal.read", "adr.read", "reopening.read", "audit_request.read"]);
      await fx.admin.query(
        "DELETE FROM audit_event WHERE organization_id=$1 AND event_type LIKE 'claim_case_view.%'",
        [ORG],
      );
      const res = await full.inject({ method: "GET", url: `/api/v1/claims/${claim}/case-view` });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        items: { kind: string; id: string }[];
        nextDeadline: { kind: string; label: string } | null;
      };
      const kinds = new Set(body.items.map((i) => i.kind));
      for (const k of ["appeal", "adr", "audit_request", "recorded_deadline"])
        expect(kinds.has(k)).toBe(true);
      expect(body.nextDeadline).not.toBeNull();
      await full.close();
      const audited = (
        await fx.admin.query(
          "SELECT resource_id::text AS rid FROM audit_event WHERE organization_id=$1 AND event_type='claim_case_view.viewed'",
          [ORG],
        )
      ).rows;
      expect(audited.map((r) => r.rid)).toContain(claim);

      // appeal.read alone: the ADR and audit sections are left out, never widened
      const narrow = makeApp(["appeal.read"]);
      const n = (
        await narrow.inject({ method: "GET", url: `/api/v1/claims/${claim}/case-view` })
      ).json() as { items: { kind: string }[] };
      expect(new Set(n.items.map((i) => i.kind)).has("adr")).toBe(false);
      expect(new Set(n.items.map((i) => i.kind)).has("audit_request")).toBe(false);
      await narrow.close();

      // outside the actor's provider entities the claim reads as absent (404), and no read audit names its patient
      await fx.admin.query(
        "DELETE FROM audit_event WHERE organization_id=$1 AND event_type LIKE 'claim_case_view.%'",
        [ORG],
      );
      const scoped = makeApp(["appeal.read"], { role: "biller", scope: [fx.pe1] });
      expect(
        (await scoped.inject({ method: "GET", url: `/api/v1/claims/${claim}/case-view` }))
          .statusCode,
      ).toBe(404);
      const leaked = await fx.admin.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND event_type='claim_case_view.viewed' AND context->>'patientId' IS NOT NULL",
        [ORG],
      );
      expect(leaked.rows[0].n).toBe(0);
      await scoped.close();
      // an unknown claim and another tenant's claim are 404; a real claim with nothing on it yet is an empty 200
      const open = makeApp(["appeal.read"]);
      expect(
        (await open.inject({ method: "GET", url: `/api/v1/claims/${randomUUID()}/case-view` }))
          .statusCode,
      ).toBe(404);
      expect(
        (await open.inject({ method: "GET", url: `/api/v1/claims/${fx.claimB}/case-view` }))
          .statusCode,
      ).toBe(404);
      const fresh = await open.inject({
        method: "GET",
        url: `/api/v1/claims/${fx.claim2}/case-view`,
      });
      expect(fresh.statusCode).toBe(200);
      await open.close();
      const none = makeApp([]);
      expect(
        (await none.inject({ method: "GET", url: `/api/v1/claims/${claim}/case-view` })).statusCode,
      ).toBe(403);
      expect(
        (await none.inject({ method: "GET", url: "/api/v1/claims/nope/case-view" })).statusCode,
      ).toBe(403);
      await none.close();
    });
  });
});
