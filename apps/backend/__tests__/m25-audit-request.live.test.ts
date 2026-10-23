/**
 * M25 audit requests, milestone 7a-1 (hospice ADR/TPE/QIC PRD) - LIVE Postgres as the NOBYPASSRLS `chartwarden_app`
 * role, through the real services, routes and nightly cron.
 *
 * Proves what the pure suites cannot: a RAC / UPIC / SMRC / other request is logged for one or many claims of one
 * provider entity (another tenant's claim, ADR or denial reads as absent; a mixed entity is refused); no due date is
 * computed - a request with none reads "no deadline recorded" and raises exactly one alert after two days, and a typed
 * deadline (source note required; a notice document only after the document seam validates it) clears it; the state machine moves forward only and a
 * withdrawn or closed request is frozen in the database (its claims too); a claim is soft-removed, never deleted, and
 * appears once; the audit trail records the writes without the free text; another tenant sees nothing; the routes
 * gate on audit_request.read / audit_request.manage.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:audit-request:live
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
import { registerM23PublishedSeams } from "../src/modules/23-billing-medicare/cost-report-seams";
import { runAppealDeadlineCron } from "../src/modules/25-remittance/jobs/cron-workers";
import { buildSeamAppealSourcePorts } from "../src/modules/25-remittance/routes/appeal-packet-sources";
import { buildDrizzleAuditRequestService } from "../src/modules/25-remittance/routes/audit-request-service";
import { registerAuditRequestRoutes } from "../src/modules/25-remittance/routes/audit-request.routes";
import { buildDrizzleLaterTierService } from "../src/modules/25-remittance/routes/later-tier-service";
import { type M7Fixture, ORG, ORG_B, daysAgo, daysAhead, setupM7Fixture } from "./_m25-m7-fixture";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (v) => UUID_RE.test(v));
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set("date-time", (v) => !Number.isNaN(Date.parse(v)));
}

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const NEW_TABLES = ["audit_request", "audit_request_claim", "audit_request_event"];

describe.skipIf(!DB_URL)("M25 audit requests (milestone 7a-1) - LIVE Postgres", () => {
  let fx: M7Fixture;

  const providerZones = (tx: DbClient, pe: string) =>
    buildFoundationSiteReader().providerEntityTimezones(tx, pe);
  const audit = () =>
    buildDrizzleAuditRequestService(fx.handle.db, {
      sources: buildSeamAppealSourcePorts(),
      providerEntityExists: async (tx, organizationId, providerEntityId) =>
        (await buildFoundationSiteReader().providerEntityIdentifiers(
          tx as never,
          organizationId,
          providerEntityId,
        )) !== null,
    });
  const tier = () => buildDrizzleLaterTierService(fx.handle.db, { providerZones });
  const A = () => fx.actor();
  const B = () => fx.actor(ORG_B);
  const intake = (over: Record<string, unknown> = {}) => ({
    authorityKind: "upic",
    receivedOn: daysAgo(1),
    claimIds: [fx.claim1],
    ...over,
  });

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
  const noDeadlineAlerts = (d: Awaited<ReturnType<typeof cron>>, id: string) =>
    d.filter(
      (a) => a.alertCode === "audit.no_deadline_recorded" && a.payload.auditRequestId === id,
    );

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
    registerAuditRequestRoutes(app, { auditRequestService: audit(), laterTierService: tier() });
    return app;
  }
  const WRITE = (version?: number) => ({
    "idempotency-key": randomUUID(),
    ...(version === undefined ? {} : { "if-match": String(version) }),
  });

  beforeAll(async () => {
    fx = await setupM7Fixture(DB_URL as string, "m25-ar");
    registerM23PublishedSeams(fx.handle.db);
  }, 300_000);

  afterAll(async () => {
    await fx?.close();
    resetAuthorizationContract();
    resetRbacEngine();
  });

  it("forces RLS on all three tables and gives the app role no DELETE", async () => {
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

  describe("intake", () => {
    it("logs a request for many claims of one provider entity, with the authority as a label only", async () => {
      const created = await audit().createAuditRequest(
        A(),
        intake({ claimIds: [fx.claim1, fx.claim1b, fx.claim1], scopeNote: "records for 2025 Q3" }),
      );
      const detail = await audit().getAuditRequest(A(), created.id);
      expect(detail).toMatchObject({
        authorityKind: "upic",
        state: "received",
        claimCount: 2,
        dueState: "no_deadline_recorded",
        nextDueAt: null,
        providerEntityId: fx.pe1,
      });
      expect(detail?.claims.map((c) => c.claimId).sort()).toEqual([fx.claim1, fx.claim1b].sort());
      const control = (
        await fx.admin.query("SELECT claim_control_number AS n FROM claim WHERE id=$1", [fx.claim1])
      ).rows[0].n;
      expect(detail?.claims.find((c) => c.claimId === fx.claim1)?.claimControlNumber).toBe(control);
      expect(detail?.events.map((e) => e.eventKind)).toEqual(["received"]);
    });

    it("needs a name for 'other', real dates, and a letter not dated after receipt", async () => {
      expect(
        (await fx.refused(audit().createAuditRequest(A(), intake({ authorityKind: "other" }))))
          ?.code,
      ).toBe("AUDIT_AUTHORITY_NAME_REQUIRED");
      expect(
        (await fx.refused(audit().createAuditRequest(A(), intake({ authorityKind: "cert" }))))
          ?.code,
      ).toBe("AUDIT_AUTHORITY_KIND_INVALID");
      expect(
        (await fx.refused(audit().createAuditRequest(A(), intake({ receivedOn: daysAhead(2) }))))
          ?.code,
      ).toBe("AUDIT_RECEIVED_IN_FUTURE");
      expect(
        (
          await fx.refused(
            audit().createAuditRequest(
              A(),
              intake({ requestDatedOn: daysAhead(0), receivedOn: daysAgo(3) }),
            ),
          )
        )?.code,
      ).toBe("AUDIT_DATED_AFTER_RECEIVED");
      const named = await audit().createAuditRequest(
        A(),
        intake({ authorityKind: "other", authorityName: "State auditor" }),
      );
      expect(named.id).toBeTruthy();
    });

    it("refuses another tenant's claim, ADR and denial as absent, and a mix of provider entities", async () => {
      expect(
        (await fx.refused(audit().createAuditRequest(A(), intake({ claimIds: [fx.claimB] }))))
          ?.statusCode,
      ).toBe(404);
      const orgBAdr = (
        await fx.admin.query(
          `INSERT INTO adr_case (organization_id, provider_entity_id, claim_id, mac_name, review_type, requested_on,
             window_days, window_source, response_due_at)
           VALUES ($1,$2,$3,'CGS','adr',CURRENT_DATE,45,'org_rule', now() + interval '30 days') RETURNING id`,
          [ORG_B, fx.peB, fx.claimB],
        )
      ).rows[0].id as string;
      expect(
        (await fx.refused(audit().createAuditRequest(A(), intake({ adrCaseId: orgBAdr }))))
          ?.statusCode,
      ).toBe(404);
      const orgBDenial = await fx.mkDenial(fx.claimB, fx.peB, ORG_B);
      expect(
        (await fx.refused(audit().createAuditRequest(A(), intake({ denialCaseId: orgBDenial }))))
          ?.statusCode,
      ).toBe(404);
      expect(
        (
          await fx.refused(
            audit().createAuditRequest(A(), intake({ claimIds: [fx.claim1, fx.claim2] })),
          )
        )?.code,
      ).toBe("AUDIT_MIXED_PROVIDER_ENTITY");
      // a claim outside the actor's provider entities reads as absent
      expect(
        (
          await fx.refused(
            audit().createAuditRequest(fx.actor(ORG, [fx.pe1]), intake({ claimIds: [fx.claim2] })),
          )
        )?.statusCode,
      ).toBe(404);
      const ownAdr = (
        await fx.admin.query(
          `INSERT INTO adr_case (organization_id, provider_entity_id, claim_id, mac_name, review_type, requested_on,
             window_days, window_source, response_due_at)
           VALUES ($1,$2,$3,'CGS','adr',CURRENT_DATE,45,'org_rule', now() + interval '30 days') RETURNING id`,
          [ORG, fx.pe1, fx.claim1],
        )
      ).rows[0].id as string;
      const linked = await audit().createAuditRequest(A(), intake({ adrCaseId: ownAdr }));
      expect((await audit().getAuditRequest(A(), linked.id))?.adrCaseId).toBe(ownAdr);
    });

    it("takes a provider entity instead of claims, only when it exists in the org and the actor's scope", async () => {
      const ok = await audit().createAuditRequest(A(), {
        authorityKind: "rac",
        receivedOn: daysAgo(1),
        providerEntityId: fx.pe2,
      });
      expect((await audit().getAuditRequest(A(), ok.id))?.claimCount).toBe(0);
      expect(
        (
          await fx.refused(
            audit().createAuditRequest(A(), { authorityKind: "rac", receivedOn: daysAgo(1) }),
          )
        )?.code,
      ).toBe("AUDIT_PROVIDER_ENTITY_REQUIRED");
      expect(
        (
          await fx.refused(
            audit().createAuditRequest(A(), {
              authorityKind: "rac",
              receivedOn: daysAgo(1),
              providerEntityId: fx.peB,
            }),
          )
        )?.statusCode,
      ).toBe(404);
    });
  });

  describe("no clock, only a typed deadline", () => {
    it("alerts once after two days with no recorded deadline, and a typed deadline clears the state", async () => {
      const { id } = await audit().createAuditRequest(A(), intake());
      expect(noDeadlineAlerts(await cron(), id)).toEqual([]);
      await fx.admin.query(
        "UPDATE audit_request SET created_at = now() - interval '3 days' WHERE id=$1",
        [id],
      );
      const first = noDeadlineAlerts(await cron(), id);
      expect(first).toHaveLength(1);
      expect(first[0]?.payload).toEqual({ auditRequestId: id, daysOpen: 3 });
      expect(noDeadlineAlerts(await cron(), id)).toEqual([]);

      const blank = await fx.refused(
        tier().createDeadline(
          A(),
          { kind: "audit_request", id },
          { label: "Response due", dueOn: daysAhead(30), sourceNote: " " },
        ),
      );
      expect(blank?.code).toBe("DEADLINE_SOURCE_NOTE_REQUIRED");
      const withDoc = await fx.refused(
        tier().createDeadline(
          A(),
          { kind: "audit_request", id },
          {
            label: "Response due",
            dueOn: daysAhead(30),
            sourceNote: "letter p1",
            noticeDocumentId: randomUUID(),
          },
        ),
      );
      // 7a-2: a notice document is accepted on an audit deadline, but only after the document seam validates it
      // (this service has no source port bound, so it is refused rather than linked unchecked).
      expect(withDoc?.code).toBe("NOTICE_DOCUMENT_UNAVAILABLE");
      const d = await tier().createDeadline(
        A(),
        { kind: "audit_request", id },
        { label: "Response due", dueOn: daysAhead(30), sourceNote: "UPIC letter p1" },
      );
      const detail = await audit().getAuditRequest(A(), id);
      expect(detail?.dueState).toBe("open");
      expect(detail?.nextDueAt).toBe(detail?.deadlines[0]?.dueAt);
      expect(detail?.events.map((e) => e.eventKind)).toContain("deadline_recorded");
      // satisfied -> no open deadline again
      await tier().satisfyDeadline(A(), { kind: "audit_request", id }, d.id, undefined, d.version);
      expect((await audit().getAuditRequest(A(), id))?.dueState).toBe("no_deadline_recorded");
    });

    it("alerts a typed audit deadline at its boundary through the same recorded-deadline watch", async () => {
      const { id } = await audit().createAuditRequest(A(), intake());
      const d = await tier().createDeadline(
        A(),
        { kind: "audit_request", id },
        { label: "Records due", dueOn: daysAhead(6), sourceNote: "letter" },
      );
      const alerts = (await cron()).filter(
        (a) => a.alertCode === "deadline.recorded_approaching" && a.payload.deadlineId === d.id,
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.payload).toMatchObject({
        subjectKind: "audit_request",
        subjectId: id,
        daysRemaining: 7,
      });
    });

    it("never alerts for a request that is over", async () => {
      const { id } = await audit().createAuditRequest(A(), intake());
      await fx.admin.query(
        "UPDATE audit_request SET created_at = now() - interval '5 days' WHERE id=$1",
        [id],
      );
      await audit().moveAuditRequest(A(), id, "withdrawn", 1);
      expect(noDeadlineAlerts(await cron(), id)).toEqual([]);
    });
  });

  describe("state machine and freeze", () => {
    it("moves forward only, refuses a bare move to responded, and freezes a withdrawn request in the database", async () => {
      const { id } = await audit().createAuditRequest(A(), intake());
      const v = () => fx.ver("audit_request", id);
      expect(
        (await fx.refused(audit().moveAuditRequest(A(), id, "responded", await v())))?.code,
      ).toBe("INVALID_TRANSITION");
      await audit().moveAuditRequest(A(), id, "in_assembly", await v());
      await audit().moveAuditRequest(A(), id, "in_review", await v());
      // Milestone 7a-2: a response is recorded by filing a signed-off packet with its proof, never by a bare move.
      expect(
        (await fx.refused(audit().moveAuditRequest(A(), id, "responded", await v())))?.code,
      ).toBe("AUDIT_RESPONSE_REQUIRES_FILING");
      expect((await fx.refused(audit().moveAuditRequest(A(), id, "in_review", 1)))?.code).toBeTruthy();
      await audit().moveAuditRequest(A(), id, "withdrawn", await v());
      const row = (
        await fx.admin.query(
          "SELECT state, responded_at, closed_at FROM audit_request WHERE id=$1",
          [id],
        )
      ).rows[0];
      expect(row.state).toBe("withdrawn");
      expect(row.responded_at).toBeNull();
      expect(row.closed_at).not.toBeNull();
      const msg = await fx.dbMessage(
        fx.asApp((tx) => tx.execute(sql`UPDATE audit_request SET scope_note='x' WHERE id=${id}`)),
      );
      expect(msg).toMatch(/M25_AUDIT_FROZEN/);
      expect(
        (await fx.refused(audit().addClaim(A(), id, { claimId: fx.claim1b }, await v())))?.code,
      ).toBe("AUDIT_FROZEN");
      expect((await fx.refused(audit().removeClaim(A(), id, fx.claim1, await v())))?.code).toBe(
        "AUDIT_FROZEN",
      );
      expect(
        (await fx.refused(audit().updateAuditRequest(A(), id, { scopeNote: "y" }, await v())))
          ?.code,
      ).toBe("AUDIT_FROZEN");
      expect((await audit().getAuditRequest(A(), id))?.dueState).toBe("not_applicable");
    });

    it("refuses an illegal edge even from a writer that skips the service", async () => {
      const { id } = await audit().createAuditRequest(A(), intake());
      const msg = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(sql`UPDATE audit_request SET state='in_review' WHERE id=${id}`),
        ),
      );
      expect(msg).toMatch(/M25_AUDIT_ILLEGAL_TRANSITION/);
    });

    it("an If-Match that is stale loses with a 409", async () => {
      const { id } = await audit().createAuditRequest(A(), intake());
      await audit().updateAuditRequest(A(), id, { scopeNote: "one" }, 1);
      expect(
        (await fx.refused(audit().updateAuditRequest(A(), id, { scopeNote: "two" }, 1)))?.code,
      ).toBe("VERSION_CONFLICT");
    });
  });

  describe("claims", () => {
    it("adds, soft-removes and re-adds a claim, once at a time, of the same provider entity", async () => {
      const { id } = await audit().createAuditRequest(A(), intake());
      const v = () => fx.ver("audit_request", id);
      await audit().addClaim(
        A(),
        id,
        { claimId: fx.claim1b, dateOfServiceNote: "March" },
        await v(),
      );
      expect(
        (await fx.refused(audit().addClaim(A(), id, { claimId: fx.claim1b }, await v())))?.code,
      ).toBe("AUDIT_CLAIM_EXISTS");
      expect(
        (await fx.refused(audit().addClaim(A(), id, { claimId: fx.claim2 }, await v())))?.code,
      ).toBe("AUDIT_MIXED_PROVIDER_ENTITY");
      expect(
        (await fx.refused(audit().addClaim(A(), id, { claimId: fx.claimB }, await v())))
          ?.statusCode,
      ).toBe(404);
      await audit().removeClaim(A(), id, fx.claim1b, await v());
      expect(
        (await fx.refused(audit().removeClaim(A(), id, fx.claim1b, await v())))?.statusCode,
      ).toBe(404);
      expect((await audit().getAuditRequest(A(), id))?.claimCount).toBe(1);
      await audit().addClaim(A(), id, { claimId: fx.claim1b }, await v());
      expect((await audit().getAuditRequest(A(), id))?.claimCount).toBe(2);
      const rows = await fx.admin.query(
        "SELECT removed_at FROM audit_request_claim WHERE audit_request_id=$1 AND claim_id=$2 ORDER BY created_at",
        [id, fx.claim1b],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows[0].removed_at).not.toBeNull();
      expect(rows.rows[1].removed_at).toBeNull();
    });

    it("detects concurrent claim-set edits: each edit bumps the version and a stale If-Match loses", async () => {
      const { id } = await audit().createAuditRequest(A(), intake());
      const v1 = await fx.ver("audit_request", id);
      const added = await audit().addClaim(A(), id, { claimId: fx.claim1b }, v1);
      expect(added.version).toBe(v1 + 1);
      expect((await fx.refused(audit().removeClaim(A(), id, fx.claim1b, v1)))?.code).toBe(
        "VERSION_CONFLICT",
      );
      // the refused edit changed nothing: the claim is still on the request
      expect((await audit().getAuditRequest(A(), id))?.claimCount).toBe(2);
    });

    it("names a patient for the read audit only when the request covers exactly one claim", async () => {
      const one = await audit().createAuditRequest(A(), intake());
      const many = await audit().createAuditRequest(
        A(),
        intake({ claimIds: [fx.claim1, fx.claim1b] }),
      );
      const none = await audit().createAuditRequest(A(), {
        authorityKind: "rac",
        receivedOn: daysAgo(1),
        providerEntityId: fx.pe1,
      });
      const patientOf = (
        await fx.admin.query("SELECT patient_id FROM claim WHERE id=$1", [fx.claim1])
      ).rows[0].patient_id as string;
      expect((await audit().getAuditRequest(A(), one.id))?.patientId).toBe(patientOf);
      expect((await audit().getAuditRequest(A(), many.id))?.patientId).toBeNull();
      expect((await audit().getAuditRequest(A(), none.id))?.patientId).toBeNull();
    });

    it("takes no claim from a finished request (database guard), nor a cross-tenant parent", async () => {
      const { id } = await audit().createAuditRequest(
        A(),
        intake({ claimIds: [], providerEntityId: fx.pe1 }),
      );
      await audit().moveAuditRequest(A(), id, "withdrawn", 1);
      const frozen = await fx.dbMessage(
        fx.asApp((tx) =>
          tx.execute(
            sql`INSERT INTO audit_request_claim (organization_id, audit_request_id, claim_id) VALUES (${ORG}, ${id}, ${fx.claim1})`,
          ),
        ),
      );
      expect(frozen).toMatch(/M25_AUDIT_FROZEN/);
      const cross = await fx.dbMessage(
        fx.asApp(
          (tx) =>
            tx.execute(
              sql`INSERT INTO audit_request_claim (organization_id, audit_request_id, claim_id) VALUES (${ORG_B}, ${id}, ${fx.claimB})`,
            ),
          ORG_B,
        ),
      );
      expect(cross).toMatch(/M25_AUDIT_CLAIM_PARENT/);
    });
  });

  describe("tenancy and the audit trail", () => {
    it("hides a request from another tenant and from an actor outside its provider entity", async () => {
      const { id } = await audit().createAuditRequest(
        A(),
        intake({ scopeNote: "SECRET-SCOPE-NOTE", requestReference: "SECRET-REQ-REF" }),
      );
      expect(await audit().getAuditRequest(B(), id)).toBeNull();
      expect((await audit().listAuditRequests(B(), {}, 50)).items).toEqual([]);
      expect(await audit().getAuditRequest(fx.actor(ORG, [fx.pe2]), id)).toBeNull();
      expect(
        (await fx.refused(tier().listDeadlines(B(), { kind: "audit_request", id })))?.statusCode,
      ).toBe(404);
      for (const table of NEW_TABLES) {
        const rows = await fx.asApp((tx) => tx.execute(sql.raw(`SELECT id FROM ${table}`)), ORG_B);
        expect(
          (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown[]),
          table,
        ).toHaveLength(0);
      }
      const kinds = (
        await fx.admin.query(
          "SELECT DISTINCT resource_kind FROM audit_event WHERE organization_id=$1 AND resource_kind IN ('audit_request','audit_request_claim','audit_request_event')",
          [ORG],
        )
      ).rows.map((r) => r.resource_kind as string);
      expect(kinds.sort()).toEqual(["audit_request", "audit_request_claim", "audit_request_event"]);
      const all = JSON.stringify(
        (
          await fx.admin.query(
            "SELECT before, after FROM audit_event WHERE organization_id=$1 AND resource_kind LIKE 'audit_request%'",
            [ORG],
          )
        ).rows,
      );
      expect(all).not.toContain("SECRET-SCOPE-NOTE");
      expect(all).not.toContain("SECRET-REQ-REF");
    });
  });

  describe("routes", () => {
    it("gates reads on audit_request.read and writes on audit_request.manage, and audits the reads", async () => {
      const reader = makeApp(["audit_request.read"]);
      const { id } = await audit().createAuditRequest(A(), intake());
      await fx.admin.query(
        "DELETE FROM audit_event WHERE organization_id=$1 AND event_type LIKE 'audit_request.%viewed'",
        [ORG],
      );
      expect(
        (await reader.inject({ method: "GET", url: "/api/v1/audit-requests" })).statusCode,
      ).toBe(200);
      expect(
        (await reader.inject({ method: "GET", url: `/api/v1/audit-requests/${id}` })).statusCode,
      ).toBe(200);
      const denied = await reader.inject({
        method: "POST",
        url: "/api/v1/audit-requests",
        headers: WRITE(),
        payload: { authorityKind: "rac", receivedOn: daysAgo(1), providerEntityId: fx.pe1 },
      });
      expect(denied.statusCode).toBe(403);
      await reader.close();
      const viewed = (
        await fx.admin.query(
          "SELECT event_type, resource_id::text AS rid FROM audit_event WHERE organization_id=$1 AND event_type LIKE 'audit_request.%viewed' ORDER BY event_type",
          [ORG],
        )
      ).rows;
      expect(viewed.map((r) => r.event_type)).toEqual([
        "audit_request.list_viewed",
        "audit_request.viewed",
      ]);
      expect(viewed.find((r) => r.event_type === "audit_request.viewed")?.rid).toBe(id);
      const none = makeApp([]);
      expect((await none.inject({ method: "GET", url: "/api/v1/audit-requests" })).statusCode).toBe(
        403,
      );
      await none.close();
    });

    it("writes through the full route stack: validation, idempotency key, If-Match, claims and deadlines", async () => {
      const app = makeApp(["audit_request.read", "audit_request.manage"]);
      expect(
        (await app.inject({ method: "GET", url: "/api/v1/audit-requests/not-a-uuid" })).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: "GET", url: `/api/v1/audit-requests/${randomUUID()}` }))
          .statusCode,
      ).toBe(404);
      const bad = await app.inject({
        method: "POST",
        url: "/api/v1/audit-requests",
        headers: WRITE(),
        payload: { authorityKind: "nope", receivedOn: daysAgo(1) },
      });
      expect(bad.statusCode).toBe(422);
      const noKey = await app.inject({
        method: "POST",
        url: "/api/v1/audit-requests",
        payload: { authorityKind: "rac", receivedOn: daysAgo(1), providerEntityId: fx.pe1 },
      });
      expect(noKey.statusCode).toBe(400);
      const created = await app.inject({
        method: "POST",
        url: "/api/v1/audit-requests",
        headers: WRITE(),
        payload: { authorityKind: "smrc", receivedOn: daysAgo(1), claimIds: [fx.claim1] },
      });
      expect(created.statusCode).toBe(201);
      const { id, version } = created.json() as { id: string; version: number };
      const noMatch = await app.inject({
        method: "PATCH",
        url: `/api/v1/audit-requests/${id}`,
        headers: WRITE(),
        payload: { scopeNote: "x" },
      });
      expect(noMatch.statusCode).toBe(400);
      const patched = await app.inject({
        method: "PATCH",
        url: `/api/v1/audit-requests/${id}`,
        headers: WRITE(version),
        payload: { scopeNote: "x" },
      });
      expect(patched.statusCode).toBe(200);
      const addClaim = await app.inject({
        method: "POST",
        url: `/api/v1/audit-requests/${id}/claims`,
        headers: WRITE(await fx.ver("audit_request", id)),
        payload: { claimId: fx.claim1b },
      });
      expect(addClaim.statusCode).toBe(201);
      const delClaim = await app.inject({
        method: "DELETE",
        url: `/api/v1/audit-requests/${id}/claims/${fx.claim1b}`,
        headers: WRITE(await fx.ver("audit_request", id)),
      });
      expect(delClaim.statusCode).toBe(200);
      const noNote = await app.inject({
        method: "POST",
        url: `/api/v1/audit-requests/${id}/recorded-deadlines`,
        headers: WRITE(),
        payload: { label: "Due", dueOn: daysAhead(20) },
      });
      expect(noNote.statusCode).toBe(422);
      const dl = await app.inject({
        method: "POST",
        url: `/api/v1/audit-requests/${id}/recorded-deadlines`,
        headers: WRITE(),
        payload: { label: "Due", dueOn: daysAhead(20), sourceNote: "letter p1" },
      });
      expect(dl.statusCode).toBe(201);
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/audit-requests/${id}/recorded-deadlines`,
      });
      expect((list.json() as { items: unknown[] }).items).toHaveLength(1);
      const move = await app.inject({
        method: "POST",
        url: `/api/v1/audit-requests/${id}/state`,
        headers: WRITE(await fx.ver("audit_request", id)),
        payload: { to: "in_assembly" },
      });
      expect(move.statusCode).toBe(200);
      const stale = await app.inject({
        method: "POST",
        url: `/api/v1/audit-requests/${id}/state`,
        headers: WRITE(1),
        payload: { to: "in_review" },
      });
      expect(stale.statusCode).toBe(409);
      await app.close();
    });
  });
});
