/**
 * M25 advisory ADR documentation readiness, milestone 8a-1 (hospice ADR/TPE/QIC PRD) - LIVE Postgres as the NOBYPASSRLS
 * `chartwarden_app` role, through the real service, the real catalog-validating outbox publisher and the real routes.
 * NO model is involved: the default assistant is the deny-stub, and the "available" cases inject a fake port.
 *
 * Proves what the pure suites cannot: the deterministic gap view needs no review and no AI; with the assistant off a
 * request is recorded as unavailable and nothing else changes; a fake assistant's findings are filtered (a hallucinated
 * citation, a presence claim on a gap, an invented checklist item are dropped and counted); a malformed or throwing
 * assistant is a failed review, never an error to the caller; NO review or disposition alters the ADR case row, its
 * version, its documents, its checklist, its event history or any submission attempt (row-for-row snapshot); the review
 * is immutable and a finding takes only its disposition; the per-case rate limit and the case-state rule hold; another
 * tenant (and another provider entity) sees nothing; the events carry ids and counts, never the note; the audit trail
 * scrubs the note; the routes gate on adr.readiness_read / _request / _dispose and the read audit event lands with the
 * case id.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:adr-readiness:live
 * (SUPERUSER to a THROWAWAY db - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { FormatRegistry } from "@sinclair/typebox";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import type { AdrReadinessAssistPort } from "../src/modules/25-remittance/ai/adr-readiness-capability";
import { ADR_CHECKLIST_KEYS } from "../src/modules/25-remittance/domain";
import { M25_OUTBOX_EVENTS } from "../src/modules/25-remittance/index";
import { buildDrizzleAdrReadinessService } from "../src/modules/25-remittance/routes/adr-readiness-service";
import { registerAdrReadinessRoutes } from "../src/modules/25-remittance/routes/adr-readiness.routes";
import { type M7Fixture, ORG, ORG_B, setupM7Fixture } from "./_m25-m7-fixture";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (v) => UUID_RE.test(v));
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)));
}

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const NEW_TABLES = ["adr_readiness_review", "adr_readiness_finding"];
const SECRET_NOTE = "SECRET-FINDING-NOTE-do-not-leak";

describe.skipIf(!DB_URL)("M25 ADR documentation readiness (milestone 8a-1) - LIVE Postgres", () => {
  let fx: M7Fixture;

  const outbox = buildTxOutboxPublisher(buildBootOutboxCatalog([M25_OUTBOX_EVENTS]));
  const m25Outbox = {
    publish: (
      tx: unknown,
      input: Parameters<typeof outbox.publish>[1] extends infer I ? Omit<I, "callerModule"> : never,
    ) =>
      outbox.publish(tx as Parameters<typeof outbox.publish>[0], { ...input, callerModule: "m25" }),
  };
  const assistErrors: { errorClass: string; adrCaseId: string }[] = [];
  const svc = (assist?: AdrReadinessAssistPort) =>
    buildDrizzleAdrReadinessService(fx.handle.db, {
      outbox: m25Outbox,
      onAssistantError: (e) => void assistErrors.push(e),
      ...(assist ? { assist } : {}),
    });
  const A = () => fx.actor();
  const B = () => fx.actor(ORG_B);

  const fakeAssist = (findings: unknown): AdrReadinessAssistPort => ({
    review: async () => ({
      available: true,
      findings,
      invocationId: randomUUID(),
      modelVersionPin: "fake-model-pin",
      promptTemplateVersion: "fake-template-v1",
    }),
  });

  /** An ADR on provider entity 1 with the given state; docs are attached straight in the table (the packet is not under test). */
  async function mkAdr(state = "in_assembly", pe = fx.pe1, org = ORG): Promise<string> {
    return (
      await fx.admin.query(
        `INSERT INTO adr_case (organization_id, provider_entity_id, claim_id, mac_name, review_type, state, requested_on,
           window_days, window_source, response_due_at, packet_manifest, filed_at)
         VALUES ($1,$2,$3,'TestMAC','adr',$4,CURRENT_DATE,30,'platform_default', now() + interval '20 days',
           CASE WHEN $4 = 'submitted' THEN '{}'::jsonb END, CASE WHEN $4 = 'submitted' THEN now() END) RETURNING id`,
        [org, pe, org === ORG ? fx.claim1 : fx.claimB, state],
      )
    ).rows[0].id as string;
  }
  async function attach(adrId: string, checklistKey: string | null, org = ORG): Promise<string> {
    const documentId = randomUUID();
    await fx.admin.query(
      "INSERT INTO adr_case_document (organization_id, adr_case_id, document_id, checklist_key) VALUES ($1,$2,$3,$4)",
      [org, adrId, documentId, checklistKey],
    );
    return documentId;
  }
  /** Everything a readiness review must never touch, as one comparable string. */
  async function humanRecord(adrId: string): Promise<string> {
    const q = async (text: string) => (await fx.admin.query(text, [adrId])).rows;
    return JSON.stringify({
      adr: await q("SELECT * FROM adr_case WHERE id=$1"),
      documents: await q("SELECT * FROM adr_case_document WHERE adr_case_id=$1 ORDER BY id"),
      events: await q("SELECT * FROM adr_case_event WHERE adr_case_id=$1 ORDER BY id"),
      attempts: (await fx.admin.query("SELECT count(*)::int AS n FROM submission_attempt")).rows,
    });
  }
  /** The per-case rate limit is a clock: age the stored reviews instead of sleeping. */
  const ageReviews = () =>
    fx.admin.query("UPDATE adr_readiness_review SET created_at = created_at - interval '1 hour'");

  function makeApp(keys: string[]) {
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
    registerAdrReadinessRoutes(app, { adrReadinessService: svc() });
    return app;
  }
  const WRITE = () => ({ "idempotency-key": randomUUID() });

  beforeAll(async () => {
    fx = await setupM7Fixture(DB_URL as string, "m25-rd");
  }, 300_000);

  afterAll(async () => {
    await fx?.close();
    resetAuthorizationContract();
    resetRbacEngine();
  });

  it("forces RLS on both tables, gives the app role no DELETE, and makes a review immutable", async () => {
    const forced = (
      await fx.admin.query(
        `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relrowsecurity AND relforcerowsecurity ORDER BY relname`,
        [NEW_TABLES],
      )
    ).rows.map((r) => r.relname);
    expect(forced).toEqual([...NEW_TABLES].sort());
    for (const table of NEW_TABLES) {
      expect(
        await fx.dbMessage(fx.asApp((tx) => tx.execute(sql.raw(`DELETE FROM ${table}`)))),
        table,
      ).toMatch(/permission denied/i);
    }
    expect(
      await fx.dbMessage(
        fx.asApp((tx) => tx.execute(sql.raw("UPDATE adr_readiness_review SET status='ready'"))),
      ),
    ).toMatch(/permission denied/i);
    expect(
      await fx.dbMessage(
        fx.asApp((tx) => tx.execute(sql.raw("UPDATE adr_readiness_finding SET note='x'"))),
      ),
    ).toMatch(/permission denied/i);
  });

  describe("the deterministic baseline (no model)", () => {
    it("shows every checklist key as a gap on an empty packet, with no review", async () => {
      const adr = await mkAdr();
      const view = await svc().getAdrReadiness(A(), adr);
      expect(view.review).toBeNull();
      expect(view.gaps.keys.map((k) => k.checklistKey)).toEqual([...ADR_CHECKLIST_KEYS]);
      expect(view.gaps.keys.every((k) => k.isGap)).toBe(true);
    });

    it("maps attached documents to their key, lists unmapped ones, and ignores a ticked checklist as evidence", async () => {
      const adr = await mkAdr();
      const doc = await attach(adr, "plan_of_care");
      const unmapped = await attach(adr, null);
      await fx.admin.query(
        `UPDATE adr_case SET checklist = '{"election_statement":"ready","visit_notes":"not_applicable"}' WHERE id=$1`,
        [adr],
      );
      const view = await svc().getAdrReadiness(A(), adr);
      const byKey = Object.fromEntries(view.gaps.keys.map((k) => [k.checklistKey, k]));
      expect(byKey.plan_of_care).toMatchObject({
        status: "documents_attached",
        documentIds: [doc],
        isGap: false,
      });
      expect(byKey.election_statement?.isGap).toBe(true); // ticked "ready" does not clear a missing document
      expect(byKey.visit_notes).toMatchObject({ status: "marked_not_applicable", isGap: false });
      expect(view.gaps.unmappedDocumentIds).toEqual([unmapped]);
    });
  });

  describe("with the assistant off (the Phase 1 default)", () => {
    it("records the request as unavailable, stores no finding, and changes nothing about the case", async () => {
      const adr = await mkAdr();
      await attach(adr, "plan_of_care");
      const before = await humanRecord(adr);
      const result = await svc().requestAdrReadiness(A(), adr);
      expect(result).toMatchObject({
        status: "unavailable",
        source: "deterministic",
        findingCount: 0,
      });
      const view = await svc().getAdrReadiness(A(), adr);
      expect(view.review).toMatchObject({
        status: "unavailable",
        source: "deterministic",
        unavailableReason: "capability_unavailable",
        stale: false,
        findings: [],
      });
      expect(view.gaps.keys.some((k) => k.isGap)).toBe(true); // the manual view is still there
      expect(await humanRecord(adr)).toBe(before);
    });

    it("emits requested and unavailable events carrying ids only", async () => {
      const adr = await mkAdr();
      await svc().requestAdrReadiness(A(), adr);
      const rows = (
        await fx.admin.query(
          "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1 AND event_type LIKE 'm25.adr_readiness.%' ORDER BY event_type",
          [adr],
        )
      ).rows;
      expect(rows.map((r) => r.event_type)).toEqual([
        "m25.adr_readiness.requested",
        "m25.adr_readiness.unavailable",
      ]);
      expect(rows[1]?.payload).toMatchObject({ adrCaseId: adr, reason: "capability_unavailable" });
    });
  });

  describe("with a fake assistant (nothing is called; the port is injected)", () => {
    it("keeps cited findings, drops hallucinated citations, presence-on-a-gap and invented items, and counts the drops", async () => {
      const adr = await mkAdr();
      const doc = await attach(adr, "plan_of_care");
      const before = await humanRecord(adr);
      const good = {
        checklistKey: "plan_of_care",
        status: "looks_present",
        citedDocumentIds: [doc],
        note: SECRET_NOTE,
      };
      const gapNote = {
        checklistKey: "election_statement",
        status: "possibly_missing",
        citedDocumentIds: [],
        note: "n2",
      };
      const result = await svc(
        fakeAssist([
          good,
          gapNote,
          {
            checklistKey: "physician_orders",
            status: "looks_present",
            citedDocumentIds: [doc],
            note: "n",
          },
          {
            checklistKey: "visit_notes",
            status: "looks_present",
            citedDocumentIds: [randomUUID()],
            note: "n",
          },
          { checklistKey: "invented_item", status: "cannot_tell", citedDocumentIds: [], note: "n" },
        ]),
      ).requestAdrReadiness(A(), adr);
      expect(result).toMatchObject({ status: "ready", source: "ai", findingCount: 2 });
      const view = await svc().getAdrReadiness(A(), adr);
      expect(view.review).toMatchObject({
        status: "ready",
        source: "ai",
        droppedFindingCount: 3,
        modelVersionPin: "fake-model-pin",
        promptTemplateVersion: "fake-template-v1",
        allDisposed: false,
      });
      expect(view.review?.findings.map((f) => f.checklistKey).sort()).toEqual([
        "election_statement",
        "plan_of_care",
      ]);
      // the deterministic gap on election_statement is untouched by an AI "possibly missing"
      expect(view.gaps.keys.find((k) => k.checklistKey === "election_statement")?.isGap).toBe(true);
      expect(await humanRecord(adr)).toBe(before);
      const events = (
        await fx.admin.query(
          "SELECT event_type, payload FROM outbox_event WHERE aggregate_id=$1 AND event_type LIKE 'm25.adr_readiness.%'",
          [adr],
        )
      ).rows;
      expect(events.map((e) => e.event_type).sort()).toEqual([
        "m25.adr_readiness.completed",
        "m25.adr_readiness.requested",
      ]);
      expect(JSON.stringify(events)).not.toContain(SECRET_NOTE);
    });

    it("stores an AI review only with its invocation id (a DB check), and a presence claim only with a citation", async () => {
      const adr = await mkAdr();
      const noInvocation = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql`INSERT INTO adr_readiness_review (organization_id, adr_case_id, requested_by_membership_id, status, source, case_version)
                VALUES (${ORG}, ${adr}, ${fx.memberA}, 'ready', 'ai', 1)`,
          ),
        ),
      );
      expect(noInvocation).toMatch(/adr_readiness_review_ai_has_invocation/);
      const review = (
        await fx.admin.query(
          `INSERT INTO adr_readiness_review (organization_id, adr_case_id, requested_by_membership_id, status, source, case_version)
           VALUES ($1,$2,$3,'unavailable','deterministic',1) RETURNING id`,
          [ORG, adr, fx.memberA],
        )
      ).rows[0].id as string;
      const uncited = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql`INSERT INTO adr_readiness_finding (organization_id, review_id, adr_case_id, checklist_key, status, note)
                VALUES (${ORG}, ${review}, ${adr}, 'plan_of_care', 'looks_present', 'n')`,
          ),
        ),
      );
      expect(uncited).toMatch(/adr_readiness_finding_presence_is_cited/);
    });

    it("treats a malformed answer as a failed review and a throwing assistant as a failed review, not an error", async () => {
      const adr = await mkAdr();
      const malformed = await svc(fakeAssist("not a list")).requestAdrReadiness(A(), adr);
      expect(malformed).toMatchObject({ status: "failed", source: "ai", findingCount: 0 });
      expect(
        (
          await fx.admin.query("SELECT unavailable_reason FROM adr_readiness_review WHERE id=$1", [
            malformed.reviewId,
          ])
        ).rows[0].unavailable_reason,
      ).toBe("schema_invalid");
      await ageReviews();
      const thrower: AdrReadinessAssistPort = {
        review: async () => {
          throw new Error("boom");
        },
      };
      const thrown = await svc(thrower).requestAdrReadiness(A(), adr);
      expect(thrown).toMatchObject({ status: "failed", source: "deterministic", findingCount: 0 });
      const reason = (
        await fx.admin.query("SELECT unavailable_reason FROM adr_readiness_review WHERE id=$1", [
          thrown.reviewId,
        ])
      ).rows[0];
      expect(reason.unavailable_reason).toBe("assistant_error");
      // logged by class only, never the message
      expect(assistErrors.at(-1)).toEqual({ errorClass: "Error", adrCaseId: adr });
      const bad = await fx.dbMessage(
        fx.admin.query(
          "UPDATE adr_readiness_review SET unavailable_reason='free text' WHERE id=$1",
          [thrown.reviewId],
        ),
      );
      expect(bad).toMatch(/unavailable_reason/);
    });

    it("drops a presence claim that cites a packet document attached to a different item", async () => {
      const adr = await mkAdr();
      await attach(adr, "plan_of_care");
      const other = await attach(adr, "visit_notes");
      const out = await svc(
        fakeAssist([
          {
            checklistKey: "plan_of_care",
            status: "looks_present",
            citedDocumentIds: [other],
            note: "n",
          },
        ]),
      ).requestAdrReadiness(A(), adr);
      expect(out).toMatchObject({ status: "ready", findingCount: 0 });
    });

    it("stores a normalized note", async () => {
      const adr = await mkAdr();
      await svc(
        fakeAssist([
          {
            checklistKey: "physician_orders",
            status: "cannot_tell",
            citedDocumentIds: [],
            note: " a\u202Eb\nc ",
          },
        ]),
      ).requestAdrReadiness(A(), adr);
      expect((await svc().getAdrReadiness(A(), adr)).review?.findings[0]?.note).toBe("a b c");
    });

    it("makes a disposition final, names who recorded it, and refuses one on a stale review", async () => {
      const gap = {
        checklistKey: "election_statement",
        status: "possibly_missing",
        citedDocumentIds: [],
        note: "n",
      };
      const adr = await mkAdr();
      await svc(fakeAssist([gap])).requestAdrReadiness(A(), adr);
      const finding = (await svc().getAdrReadiness(A(), adr)).review?.findings[0]?.id as string;
      await svc().disposeReadinessFinding(A(), adr, finding, "acknowledged");
      expect(
        await fx.refused(svc().disposeReadinessFinding(A(), adr, finding, "dismissed")),
      ).toMatchObject({
        code: "READINESS_ALREADY_DISPOSED",
        statusCode: 409,
      });
      expect((await svc().getAdrReadiness(A(), adr)).review?.findings[0]).toMatchObject({
        disposition: "acknowledged",
        disposedByMembershipId: fx.memberA,
      });
      const adr2 = await mkAdr();
      await svc(fakeAssist([gap])).requestAdrReadiness(A(), adr2);
      const f2 = (await svc().getAdrReadiness(A(), adr2)).review?.findings[0]?.id as string;
      await fx.admin.query("UPDATE adr_case SET version = version + 1 WHERE id=$1", [adr2]);
      expect(
        await fx.refused(svc().disposeReadinessFinding(A(), adr2, f2, "dismissed")),
      ).toMatchObject({
        code: "READINESS_REVIEW_STALE",
        statusCode: 409,
      });
    });

    it("flags a review stale once the packet version moves, and a disposition changes nothing but the finding", async () => {
      const adr = await mkAdr();
      const doc = await attach(adr, "plan_of_care");
      await svc(
        fakeAssist([
          {
            checklistKey: "plan_of_care",
            status: "looks_present",
            citedDocumentIds: [doc],
            note: "n",
          },
        ]),
      ).requestAdrReadiness(A(), adr);
      const fresh = await svc().getAdrReadiness(A(), adr);
      expect(fresh.review?.stale).toBe(false);
      const finding = fresh.review?.findings[0];
      const before = await humanRecord(adr);
      const out = await svc().disposeReadinessFinding(A(), adr, finding?.id as string, "disputed");
      expect(out).toEqual({ id: finding?.id, disposition: "disputed" });
      expect(await humanRecord(adr)).toBe(before);
      const after = await svc().getAdrReadiness(A(), adr);
      expect(after.review?.findings[0]).toMatchObject({ disposition: "disputed" });
      expect(after.review?.allDisposed).toBe(true);
      await fx.admin.query("UPDATE adr_case SET version = version + 1 WHERE id=$1", [adr]);
      expect((await svc().getAdrReadiness(A(), adr)).review?.stale).toBe(true);
      const disposedEvent = await fx.admin.query(
        "SELECT payload FROM outbox_event WHERE aggregate_id=$1 AND event_type='m25.adr_readiness.finding_disposed'",
        [adr],
      );
      expect(disposedEvent.rows[0]?.payload).toMatchObject({
        disposition: "disputed",
        findingId: finding?.id,
      });
    });
  });

  describe("rules around the request", () => {
    it("rate-limits a second request on the same case within the interval, then allows it", async () => {
      const adr = await mkAdr();
      await svc().requestAdrReadiness(A(), adr);
      const limited = await fx.refused(svc().requestAdrReadiness(A(), adr));
      expect(limited).toMatchObject({ code: "READINESS_RATE_LIMITED", statusCode: 429 });
      await ageReviews();
      expect((await svc().requestAdrReadiness(A(), adr)).status).toBe("unavailable");
    });

    it("lets only one of several concurrent requests through (advisory lock + re-check)", async () => {
      const adr = await mkAdr();
      const results = await Promise.all(
        [1, 2, 3].map(() => fx.refused(svc().requestAdrReadiness(A(), adr))),
      );
      expect(results.filter((r) => r === null)).toHaveLength(1);
      expect(results.filter((r) => r?.code === "READINESS_RATE_LIMITED")).toHaveLength(2);
      const n = (
        await fx.admin.query(
          "SELECT count(*)::int AS n FROM adr_readiness_review WHERE adr_case_id=$1",
          [adr],
        )
      ).rows[0].n;
      expect(n).toBe(1);
    });

    it("refuses a review on a case that is not in assembly or review, and reads as absent for an unknown case", async () => {
      for (const state of ["received", "submitted", "withdrawn", "denied_no_response"]) {
        const adr = await mkAdr(state);
        expect((await fx.refused(svc().requestAdrReadiness(A(), adr)))?.code, state).toBe(
          "ADR_WRONG_STATE",
        );
        expect((await svc().getAdrReadiness(A(), adr)).gaps.keys).toHaveLength(
          ADR_CHECKLIST_KEYS.length,
        ); // reads stay open
      }
      expect((await fx.refused(svc().getAdrReadiness(A(), randomUUID())))?.statusCode).toBe(404);
    });

    it("reads an out-of-scope provider entity's case as absent, and another tenant's case as absent", async () => {
      const adr = await mkAdr("in_assembly", fx.pe1);
      expect(
        (await fx.refused(svc().getAdrReadiness(fx.actor(ORG, [fx.pe2]), adr)))?.statusCode,
      ).toBe(404);
      expect(
        (await fx.refused(svc().requestAdrReadiness(fx.actor(ORG, [fx.pe2]), adr)))?.statusCode,
      ).toBe(404);
      expect((await fx.refused(svc().getAdrReadiness(B(), adr)))?.statusCode).toBe(404);
      expect((await fx.refused(svc().requestAdrReadiness(B(), adr)))?.statusCode).toBe(404);
    });
  });

  describe("tenant isolation and the audit trail", () => {
    it("shows another tenant no review or finding, and refuses a cross-tenant parent on insert", async () => {
      const adr = await mkAdr();
      await svc(
        fakeAssist([
          {
            checklistKey: "election_statement",
            status: "cannot_tell",
            citedDocumentIds: [],
            note: "n",
          },
        ]),
      ).requestAdrReadiness(A(), adr);
      for (const table of NEW_TABLES) {
        const rows = await fx.asApp((tx) => tx.execute(sql.raw(`SELECT id FROM ${table}`)), ORG_B);
        expect(
          (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown[]),
          table,
        ).toHaveLength(0);
      }
      const crossInsert = await fx.dbMessage(
        fx.asApp(
          (tx) =>
            tx.execute(
              sql`INSERT INTO adr_readiness_review (organization_id, adr_case_id, requested_by_membership_id, status, source, case_version)
                  VALUES (${ORG_B}, ${adr}, ${fx.memberB}, 'unavailable', 'deterministic', 1)`,
            ),
          ORG_B,
        ),
      );
      expect(crossInsert).toMatch(/M25_READINESS_PARENT/);
    });

    it("audits both tables' writes without the finding note", async () => {
      const adr = await mkAdr();
      await svc(
        fakeAssist([
          {
            checklistKey: "election_statement",
            status: "cannot_tell",
            citedDocumentIds: [],
            note: SECRET_NOTE,
          },
        ]),
      ).requestAdrReadiness(A(), adr);
      const kinds = (
        await fx.admin.query(
          "SELECT DISTINCT resource_kind FROM audit_event WHERE organization_id=$1 AND resource_kind IN ('adr_readiness_review','adr_readiness_finding')",
          [ORG],
        )
      ).rows.map((r) => r.resource_kind as string);
      expect(kinds.sort()).toEqual(["adr_readiness_finding", "adr_readiness_review"]);
      const all = JSON.stringify(
        (
          await fx.admin.query(
            "SELECT before, after FROM audit_event WHERE organization_id=$1 AND resource_kind LIKE 'adr_readiness%'",
            [ORG],
          )
        ).rows,
      );
      expect(all).not.toContain(SECRET_NOTE);
    });
  });

  describe("routes", () => {
    it("gates on the three readiness keys, requires an Idempotency-Key, and audits the read with the case id", async () => {
      const adr = await mkAdr();
      const reader = makeApp(["adr.readiness_read"]);
      await fx.admin.query(
        "DELETE FROM audit_event WHERE organization_id=$1 AND event_type LIKE 'adr_readiness.%'",
        [ORG],
      );
      const got = await reader.inject({ method: "GET", url: `/api/v1/adrs/${adr}/readiness` });
      expect(got.statusCode).toBe(200);
      expect(got.json().gaps.keys).toHaveLength(ADR_CHECKLIST_KEYS.length);
      expect(
        (
          await reader.inject({
            method: "POST",
            url: `/api/v1/adrs/${adr}/readiness/reviews`,
            headers: WRITE(),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await reader.inject({ method: "GET", url: "/api/v1/adrs/not-a-uuid/readiness" }))
          .statusCode,
      ).toBe(404);
      await reader.close();
      const viewed = (
        await fx.admin.query(
          "SELECT resource_id::text AS rid FROM audit_event WHERE organization_id=$1 AND event_type='adr_readiness.viewed'",
          [ORG],
        )
      ).rows;
      expect(viewed.map((r) => r.rid)).toEqual([adr]);

      const none = makeApp([]);
      expect(
        (await none.inject({ method: "GET", url: `/api/v1/adrs/${adr}/readiness` })).statusCode,
      ).toBe(403);
      await none.close();

      const app = makeApp(["adr.readiness_read", "adr.readiness_request", "adr.readiness_dispose"]);
      const noKey = await app.inject({
        method: "POST",
        url: `/api/v1/adrs/${adr}/readiness/reviews`,
      });
      expect(noKey.statusCode).toBe(400);
      const requested = await app.inject({
        method: "POST",
        url: `/api/v1/adrs/${adr}/readiness/reviews`,
        headers: WRITE(),
      });
      expect(requested.statusCode).toBe(201);
      expect(requested.json()).toMatchObject({ status: "unavailable", source: "deterministic" });
      await app.close();
    });

    it("disposes a finding through the route, validating the disposition and the ids", async () => {
      const adr = await mkAdr();
      await attach(adr, "plan_of_care");
      await svc(
        fakeAssist([
          {
            checklistKey: "election_statement",
            status: "possibly_missing",
            citedDocumentIds: [],
            note: "n",
          },
        ]),
      ).requestAdrReadiness(A(), adr);
      const findingId = (await svc().getAdrReadiness(A(), adr)).review?.findings[0]?.id as string;
      const app = makeApp(["adr.readiness_read", "adr.readiness_dispose"]);
      const url = `/api/v1/adrs/${adr}/readiness/findings/${findingId}/disposition`;
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers: WRITE(),
            payload: { disposition: "approved" },
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/api/v1/adrs/${adr}/readiness/findings/${randomUUID()}/disposition`,
            headers: WRITE(),
            payload: { disposition: "dismissed" },
          })
        ).statusCode,
      ).toBe(404);
      const ok = await app.inject({
        method: "POST",
        url,
        headers: WRITE(),
        payload: { disposition: "acknowledged" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ id: findingId, disposition: "acknowledged" });
      await app.close();
    });
  });
});
