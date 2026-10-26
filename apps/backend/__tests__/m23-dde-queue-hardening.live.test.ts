/**
 * M23 DDE work queue, HARDENING proofs (ADR-0052; security + code review of the first pass), LIVE Postgres as the
 * NOBYPASSRLS `chartwarden_app` role through the real routes, resolver and catalog-validating publisher.
 *
 *   - an ACCEPTED outcome needs step-up and refuses a date before the election / termination date or in the future;
 *     NOE and NOTR end to end; a `ready` / `submitted` / `ack_pending` notice takes 3 / 2 / 1 edges; a draft is a 409;
 *     an already-accepted notice is left untouched and the item takes its date;
 *   - rollback atomicity (the notice walk is undone when the item write loses a version race) and concurrent writers
 *     (one success, one 412);
 *   - DCN / outcome-code / note screens, the assignee check, a non-uuid subject failing closed (4xx, never 500);
 *   - deadlines judged on the Eastern day (not UTC); the watchdog's anti-join (no starvation behind >200 served
 *     notices) and its isolation (a failure cannot undo the window warnings).
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m23:dde-queue-hardening:live
 */
import { randomUUID } from "node:crypto";
import { createDbActorEnrichmentReader } from "@chartwarden/auth";
import { withOrgContext } from "@chartwarden/tenancy";
import type { FastifyInstance } from "fastify";
import type { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildDdeAssigneeEligibility } from "../src/bootstrap/m23-dde-assignee";
import { createMembershipsHoldingPermissionReader } from "../src/modules/03-authorization/permission-holders";
import { ORG_WIDE_BILLING_SCOPE_ROLES } from "../src/modules/23-billing-medicare/abac-predicates";
import {
  type M23WorkerDeps,
  runNoeWindowWatch,
} from "../src/modules/23-billing-medicare/jobs/m23-jobs";
import {
  type DdeQueueService,
  buildDdeQueueService,
} from "../src/modules/23-billing-medicare/services/dde-queue-service";
import { buildDdeWatchdog } from "../src/modules/23-billing-medicare/services/dde-watchdog";
import {
  BASE,
  type DdeLiveDb,
  MEMBERSHIP_A,
  MEMBERSHIP_B,
  ORG_A,
  ORG_B,
  PE_A,
  USER_A,
  USER_B,
  USER_C,
  buildDdeApp,
  connectDdeLiveDb,
  seedClaimWithSubmission,
  seedNoe,
  seedNotr,
} from "./_dde-live-harness";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const DCN = "2212345678901";

describe.skipIf(!DB_URL)("M23 DDE work queue hardening, LIVE Postgres (ADR-0052)", () => {
  let live: DdeLiveDb;
  let admin: Client;
  let app: FastifyInstance;
  let counter = 0;
  const asA = (extra: Record<string, string> = {}) => ({
    "x-test-user": USER_A,
    "idempotency-key": `dde-hard-${++counter}`,
    ...extra,
  });
  const stepUp = { "x-test-step-up": "1" };
  const post = (path: string, headers: Record<string, string>, payload: unknown) =>
    app.inject({ method: "POST", url: `${BASE}${path}`, headers, payload: payload as never });
  const get = (path: string) =>
    app.inject({ method: "GET", url: `${BASE}${path}`, headers: asA() });

  /** Create + claim + start + record-submission; returns the item id and the version to accept against. */
  async function submitted(kind: "noe" | "notr", subjectId: string): Promise<[string, number]> {
    const item = (await post("", asA(), { itemType: kind, subjectId })).json();
    const id = item.ddeWorkItemId as string;
    await post(`/${id}/claim`, asA(), { expectedVersion: 0 });
    await post(`/${id}/start`, asA(), { expectedVersion: 1 });
    expect(
      (await post(`/${id}/record-submission`, asA(stepUp), { expectedVersion: 2 })).statusCode,
    ).toBe(200);
    return [id, 3];
  }
  const accept = (
    id: string,
    version: number,
    body: Record<string, unknown>,
    headers = asA(stepUp),
  ) => post(`/${id}/record-acceptance`, headers, { expectedVersion: version, ...body });
  const noeRow = async (id: string) =>
    (
      await admin.query(
        "SELECT state, payer_status_date::text AS d, payer_status_date_source AS s FROM noe_record WHERE id=$1",
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    live = await connectDdeLiveDb(DB_URL as string);
    admin = live.admin;
  }, 300_000);
  afterAll(async () => {
    await app?.close();
    await live?.handle.close();
    await admin?.end();
  });
  beforeEach(async () => {
    await app?.close();
    app = await buildDdeApp(live, {
      assigneeCanWork: async (_org, membershipId) => membershipId === MEMBERSHIP_B,
    });
  });

  describe("accepted outcomes", () => {
    it("needs a recent step-up, writes nothing without it, and refuses an early or future date", async () => {
      const noe = await seedNoe(admin, { electionDate: "2026-01-15", windowTarget: "2026-01-20" });
      const [id, v] = await submitted("noe", noe);

      expect((await accept(id, v, { macAcceptedOn: "2026-01-18" }, asA())).statusCode).toBe(403);
      expect((await noeRow(noe)).state).toBe("READY");

      const early = await accept(id, v, { macAcceptedOn: "2026-01-10" });
      expect(early.statusCode).toBe(422);
      expect(JSON.stringify(early.json())).toContain("BEFORE_EFFECTIVE_DATE");
      const future = await accept(id, v, { macAcceptedOn: "2999-01-01" });
      expect(future.statusCode).toBe(422);
      expect(JSON.stringify(future.json())).toContain("FUTURE_DATE");
      expect((await noeRow(noe)).state).toBe("READY");

      const ok = await accept(id, v, { macAcceptedOn: "2026-01-18", outcomeCode: "accepted" });
      expect(ok.statusCode).toBe(200);
      expect(await noeRow(noe)).toEqual({
        state: "ACK_ACCEPTED",
        d: "2026-01-18",
        s: "dde_manual",
      });
    });

    it("takes the NOTR to ack_accepted too, and refuses a date before the termination date", async () => {
      const notr = await seedNotr(admin, { endDate: "2026-01-15", windowTarget: "2026-01-20" });
      const [id, v] = await submitted("notr", notr);
      expect((await accept(id, v, { macAcceptedOn: "2026-01-10" })).statusCode).toBe(422);
      expect((await accept(id, v, { macAcceptedOn: "2026-01-16" })).statusCode).toBe(200);
      const row = (
        await admin.query(
          "SELECT state, payer_status_date::text AS d, payer_status_date_source AS s FROM notr_record WHERE id=$1",
          [notr],
        )
      ).rows[0];
      expect(row).toEqual({ state: "ACK_ACCEPTED", d: "2026-01-16", s: "dde_manual" });
    });

    it.each([
      ["SUBMITTED", "submitted"],
      ["ACK_PENDING", "ack_pending"],
    ])("applies only the edges a %s notice has not taken", async (dbState) => {
      const noe = await seedNoe(admin, { state: dbState });
      const [id, v] = await submitted("noe", noe);
      expect((await accept(id, v, { macAcceptedOn: "2026-01-18" })).statusCode).toBe(200);
      expect((await noeRow(noe)).state).toBe("ACK_ACCEPTED");
    });

    it("refuses a DRAFT notice (409) and leaves it unchanged", async () => {
      const noe = await seedNoe(admin, { state: "READY" });
      const [id, v] = await submitted("noe", noe);
      await admin.query("UPDATE noe_record SET state='DRAFT' WHERE id=$1", [noe]);
      expect((await accept(id, v, { macAcceptedOn: "2026-01-18" })).statusCode).toBe(409);
      expect((await noeRow(noe)).state).toBe("DRAFT");
    });

    it("leaves an already-accepted notice untouched; the item records the notice's own date", async () => {
      const noe = await seedNoe(admin, { state: "READY" });
      const [id, v] = await submitted("noe", noe);
      await admin.query(
        "UPDATE noe_record SET state='ACK_ACCEPTED', payer_status_date='2026-01-17', payer_status_date_source='277ca_stc02' WHERE id=$1",
        [noe],
      );
      const res = await accept(id, v, { macAcceptedOn: "2026-01-18" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ state: "accepted", macAcceptedOn: "2026-01-17" });
      expect(await noeRow(noe)).toEqual({
        state: "ACK_ACCEPTED",
        d: "2026-01-17",
        s: "277ca_stc02",
      });
    });

    it("rolls the notice back when the item write loses a version race (atomicity)", async () => {
      const noe = await seedNoe(admin);
      const [id] = await submitted("noe", noe);
      const stale = await accept(id, 1, { macAcceptedOn: "2026-01-18" });
      expect(stale.statusCode).toBe(412);
      expect((await noeRow(noe)).state).toBe("READY");
      expect((await get(`/${id}`)).json().state).toBe("submitted");
    });

    it("records the acting membership in the history detail", async () => {
      const noe = await seedNoe(admin);
      const [id, v] = await submitted("noe", noe);
      await accept(id, v, { macAcceptedOn: "2026-01-18" });
      const events = (await get(`/${id}`)).json().events as {
        event: string;
        detail: Record<string, unknown>;
      }[];
      for (const e of events) expect(e.detail.actorMembershipId).toBe(MEMBERSHIP_A);
    });
  });

  describe("concurrent writers", () => {
    it("resolves two parallel starts to one success and one 412/409", async () => {
      const noe = await seedNoe(admin);
      const id = (await post("", asA(), { itemType: "noe", subjectId: noe })).json().ddeWorkItemId;
      await post(`/${id}/claim`, asA(), { expectedVersion: 0 });
      const res = await Promise.all([
        post(`/${id}/start`, asA(), { expectedVersion: 1 }),
        post(`/${id}/start`, asA(), { expectedVersion: 1 }),
      ]);
      const codes = res.map((r) => r.statusCode).sort();
      expect(codes[0]).toBe(200);
      expect([409, 412]).toContain(codes[1]);
    });

    it("resolves two parallel record-submissions to one success and one 412/409", async () => {
      const noe = await seedNoe(admin);
      const id = (await post("", asA(), { itemType: "noe", subjectId: noe })).json().ddeWorkItemId;
      await post(`/${id}/claim`, asA(), { expectedVersion: 0 });
      await post(`/${id}/start`, asA(), { expectedVersion: 1 });
      const res = await Promise.all([
        post(`/${id}/record-submission`, asA(stepUp), { expectedVersion: 2 }),
        post(`/${id}/record-submission`, asA(stepUp), { expectedVersion: 2 }),
      ]);
      const codes = res.map((r) => r.statusCode).sort();
      expect(codes[0]).toBe(200);
      expect([409, 412]).toContain(codes[1]);
    });
  });

  describe("an assigned item belongs to its assignee", () => {
    const asC = () => ({
      "x-test-user": USER_C,
      "idempotency-key": `dde-hard-${++counter}`,
    });

    it("refuses another worker on every work action (403, nothing changes), while the assignee and an admin proceed", async () => {
      const noe = await seedNoe(admin);
      const id = (await post("", asA(), { itemType: "noe", subjectId: noe })).json().ddeWorkItemId;
      await post(`/${id}/claim`, asA(), { expectedVersion: 0 });
      const version = async () => (await get(`/${id}`)).json().version as number;

      // C holds work + mark_submitted but is not the assignee and not an admin.
      const v1 = await version();
      expect((await post(`/${id}/start`, asC(), { expectedVersion: v1 })).statusCode).toBe(403);
      expect((await post(`/${id}/cancel`, asC(), { expectedVersion: v1 })).statusCode).toBe(403);
      expect(await version()).toBe(v1);

      // The assignee starts; C still cannot key, return, accept or close it.
      expect((await post(`/${id}/start`, asA(), { expectedVersion: v1 })).statusCode).toBe(200);
      const v2 = await version();
      expect(
        (await post(`/${id}/record-submission`, { ...asC(), ...stepUp }, { expectedVersion: v2 }))
          .statusCode,
      ).toBe(403);
      expect(await version()).toBe(v2);
    });

    it("lets a DDE admin step in on another member's item, and an unassigned item has no owner", async () => {
      const noe = await seedNoe(admin);
      const id = (await post("", asA(), { itemType: "noe", subjectId: noe })).json().ddeWorkItemId;
      // C claims it: C owns it now. USER_A (admin) can still start it.
      expect((await post(`/${id}/claim`, asC(), { expectedVersion: 0 })).statusCode).toBe(200);
      expect((await post(`/${id}/start`, asA(), { expectedVersion: 1 })).statusCode).toBe(200);
      // An unassigned (queued) item can be cancelled by any worker.
      const noe2 = await seedNoe(admin);
      const id2 = (await post("", asA(), { itemType: "noe", subjectId: noe2 })).json()
        .ddeWorkItemId;
      expect((await post(`/${id2}/cancel`, asC(), { expectedVersion: 0 })).statusCode).toBe(200);
    });
  });

  describe("code, note and assignee screens", () => {
    it("refuses an 11-character DCN, a free-form outcome code and MBI-shaped notes (4xx, nothing stored)", async () => {
      const noe = await seedNoe(admin);
      const id = (await post("", asA(), { itemType: "noe", subjectId: noe })).json().ddeWorkItemId;
      await post(`/${id}/claim`, asA(), { expectedVersion: 0 });
      await post(`/${id}/start`, asA(), { expectedVersion: 1 });
      for (const body of [
        { dcn: "1EG4TE5MK73" },
        { dcn: "X1EG4TE5MK73ZZZ" },
        { notes: "1EG4.TE5.MK73" },
        { notes: "id 1EG4 TE5 MK73 ok" },
      ]) {
        const res = await post(`/${id}/record-submission`, asA(stepUp), {
          expectedVersion: 2,
          ...body,
        });
        expect(res.statusCode, JSON.stringify(body)).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
      }
      const bad = await post(`/${id}/record-outcome`, asA(), {
        expectedVersion: 2,
        outcome: "returned",
        rtpReasonCode: "1EG4TE5MK73",
      });
      expect(bad.statusCode).toBeGreaterThanOrEqual(400);
      const row = (
        await admin.query("SELECT dcn, notes, state FROM dde_work_item WHERE id=$1", [id])
      ).rows[0];
      expect(row).toEqual({ dcn: null, notes: null, state: "in_progress" });
      // and the database itself refuses an 11-character DCN or an unknown outcome code
      await expect(
        admin.query("UPDATE dde_work_item SET dcn='1EG4TE5MK73' WHERE id=$1", [id]),
      ).rejects.toThrow(/dcn_chk/);
      await expect(
        admin.query("UPDATE dde_work_item SET outcome_code='free text' WHERE id=$1", [id]),
      ).rejects.toThrow(/outcome_code_chk/);
    });

    it("assigns only to a member who can work DDE items", async () => {
      const noe = await seedNoe(admin);
      const id = (await post("", asA(), { itemType: "noe", subjectId: noe })).json().ddeWorkItemId;
      const nobody = await post(`/${id}/assign`, asA(), {
        expectedVersion: 0,
        assigneeMembershipId: randomUUID(),
      });
      expect(nobody.statusCode).toBe(422);
      const ok = await post(`/${id}/assign`, asA(), {
        expectedVersion: 0,
        assigneeMembershipId: MEMBERSHIP_B,
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().assigneeMembershipId).toBe(MEMBERSHIP_B);
    });

    it("refuses adjust / cancel / RTP for a claim in the wrong state (409 DDE_CLAIM_STATE_NOT_ELIGIBLE)", async () => {
      const pending = (await seedClaimWithSubmission(admin)).claimId; // ACK_PENDING
      for (const itemType of ["adjustment", "cancel", "rtp_correction"]) {
        const res = await post("", asA(), { itemType, subjectId: pending });
        expect(res.statusCode).toBe(409);
        expect(res.json().error.code).toBe("DDE_CLAIM_STATE_NOT_ELIGIBLE");
      }
      const paid = (await seedClaimWithSubmission(admin, { state: "PAID" })).claimId;
      const wrong = await post("", asA(), { itemType: "rtp_correction", subjectId: paid });
      expect(wrong.statusCode).toBe(409);
      const ok = await post("", asA(), { itemType: "cancel", subjectId: paid });
      expect(ok.statusCode).toBe(201);
    });

    it("fails closed (4xx, never 500) on a non-uuid subject or item id against the real resolver", async () => {
      for (const res of [
        await post("", asA(), { itemType: "noe", subjectId: "not-a-uuid" }),
        await post("", asA(), { itemType: "adjustment", subjectId: "not-a-uuid" }),
        await get("/not-a-uuid"),
        await post("/not-a-uuid/claim", asA(), { expectedVersion: 0 }),
      ]) {
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
      }
    });
  });

  describe("closed outcome codes and real dates", () => {
    it("refuses an accepted code on a return, a returned code on an acceptance, and a code the state forbids", async () => {
      const noe = await seedNoe(admin);
      const [id, v] = await submitted("noe", noe);
      const wrongOnReturn = await post(`/${id}/record-outcome`, asA(), {
        expectedVersion: v,
        outcome: "returned",
        rtpReasonCode: "37001",
        outcomeCode: "accepted",
      });
      expect(wrongOnReturn.statusCode).toBeGreaterThanOrEqual(400);
      expect(wrongOnReturn.statusCode).toBeLessThan(500);
      const wrongOnAccept = await accept(id, v, {
        macAcceptedOn: "2026-01-18",
        outcomeCode: "rtp",
      });
      expect(wrongOnAccept.statusCode).toBeGreaterThanOrEqual(400);
      expect(wrongOnAccept.statusCode).toBeLessThan(500);
      expect((await noeRow(noe)).state).toBe("READY");
      await expect(
        admin.query(
          "UPDATE dde_work_item SET state='returned', outcome_code='accepted' WHERE id=$1",
          [id],
        ),
      ).rejects.toThrow(/outcome_state_chk/);
    });

    it("clears the outcome code when a returned item is reopened", async () => {
      const noe = await seedNoe(admin);
      const [id, v] = await submitted("noe", noe);
      const returned = await post(`/${id}/record-outcome`, asA(), {
        expectedVersion: v,
        outcome: "returned",
        rtpReasonCode: "37001",
        outcomeCode: "rtp",
      });
      expect(returned.json().outcomeCode).toBe("rtp");
      const retried = await post(`/${id}/retry`, asA(), { expectedVersion: v + 1 });
      expect(retried.json()).toMatchObject({ state: "in_progress", outcomeCode: null });
    });

    it("refuses year 0000 (Postgres has no year 0) for both dates with a 422, not a 500", async () => {
      const noe = await seedNoe(admin);
      const [id, v] = await submitted("noe", noe);
      expect((await accept(id, v, { macAcceptedOn: "0000-01-01" })).statusCode).toBe(422);
      const svc = buildDdeQueueService(live.handle.db as never);
      await expect(
        svc.create(
          {
            organizationId: ORG_A,
            userId: USER_A,
            roles: [],
            membershipId: MEMBERSHIP_A,
            stepUpRecent: false,
            actorKind: "user",
          },
          { itemType: "adjustment", subjectId: randomUUID(), deadlineAt: "0000-01-01" },
        ),
      ).rejects.toMatchObject({ statusCode: 422 });
    });

    it("refuses an impossible calendar date with a 422 (never a 500)", async () => {
      const noe = await seedNoe(admin);
      const [id, v] = await submitted("noe", noe);
      const res = await accept(id, v, { macAcceptedOn: "2026-02-31" });
      expect(res.statusCode).toBe(422);
      expect((await noeRow(noe)).state).toBe("READY");
    });
  });

  describe("the lookup index behind the watchdog's anti-join", () => {
    // A PROXY for index usability, not a performance guarantee: with seq scans disabled the planner can only use the
    // index if it matches the probe's columns. It proves the index fits the query; real-table cost is not measured.
    it("is used by the NOT EXISTS probe (planner with seq scans disabled, as it would be on a large table)", async () => {
      await seedNoe(admin);
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL enable_seqscan = off");
        const plan = (
          await admin.query(
            `EXPLAIN SELECT 1 FROM noe_record n WHERE NOT EXISTS (
               SELECT 1 FROM dde_work_item d
                WHERE d.subject_kind = 'noe_record' AND d.subject_id = n.id AND d.item_type = 'noe')`,
          )
        ).rows
          .map((r) => r["QUERY PLAN"])
          .join("\n");
        expect(plan).toContain("dde_work_item_subject_idx");
      } finally {
        await admin.query("ROLLBACK");
      }
    });
  });

  describe("assignee eligibility through the REAL wiring (M3 holders + M2 status + provider reach)", () => {
    const userIds = {
      ok: randomUUID(),
      suspended: randomUUID(),
      revoked: randomUUID(),
      outOfReach: randomUUID(),
      orgWide: randomUUID(),
      otherOrg: randomUUID(),
    };
    const members: Record<string, string> = {};
    let realApp: FastifyInstance;

    beforeAll(async () => {
      const role = (
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'dde-worker','DDE worker','clinical_staff',true) RETURNING id",
          [ORG_A],
        )
      ).rows[0].id;
      await admin.query(
        "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'billing.dde.work')",
        [ORG_A, role],
      );
      // An org-wide billing role (org_admin) reaches every provider entity whatever the membership's own default.
      const orgWideRole = (
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'org_admin','Org admin','admin_executive',true) RETURNING id",
          [ORG_A],
        )
      ).rows[0].id;
      await admin.query(
        "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'billing.dde.work')",
        [ORG_A, orgWideRole],
      );
      // A perfectly eligible member of ANOTHER organization.
      const otherRole = (
        await admin.query(
          "INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,'dde-worker','DDE worker','clinical_staff',true) RETURNING id",
          [ORG_B],
        )
      ).rows[0].id;
      await admin.query(
        "INSERT INTO role_permission (organization_id,role_id,permission_key) VALUES ($1,$2,'billing.dde.work')",
        [ORG_B, otherRole],
      );
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'otherorg@dde.test')`, [
        userIds.otherOrg,
      ]);
      const otherMember = (
        await admin.query(
          "INSERT INTO membership (user_id,organization_id,status,default_provider_entity_id) VALUES ($1,$2,'active',$3) RETURNING id",
          [userIds.otherOrg, ORG_B, PE_A],
        )
      ).rows[0].id;
      members.otherOrg = otherMember;
      await admin.query(
        "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
        [ORG_B, otherMember, otherRole],
      );
      const plan: [keyof typeof userIds, string, string][] = [
        ["ok", "active", PE_A],
        ["suspended", "suspended", PE_A],
        ["revoked", "revoked", PE_A],
        ["outOfReach", "active", randomUUID()],
        ["orgWide", "active", randomUUID()],
      ];
      for (const [k, status, pe] of plan) {
        await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [
          userIds[k],
          `${k}@dde.test`,
        ]);
        const m = (
          await admin.query(
            "INSERT INTO membership (user_id,organization_id,status,default_provider_entity_id) VALUES ($1,$2,$3,$4) RETURNING id",
            [userIds[k], ORG_A, status, pe],
          )
        ).rows[0].id;
        members[k] = m;
        await admin.query(
          "INSERT INTO membership_role (organization_id,membership_id,role_id) VALUES ($1,$2,$3)",
          [ORG_A, m, k === "orgWide" ? orgWideRole : role],
        );
      }
      realApp = await buildDdeApp(live, {
        assigneeCanWork: buildDdeAssigneeEligibility(
          live.handle.db as never,
          createMembershipsHoldingPermissionReader(live.handle.db as never),
          createDbActorEnrichmentReader(live.handle.db as never),
          ORG_WIDE_BILLING_SCOPE_ROLES,
        ),
      });
    });

    const freshItem = async (): Promise<string> => {
      const noe = await seedNoe(admin);
      return (
        await realApp.inject({
          method: "POST",
          url: BASE,
          headers: asA(),
          payload: { itemType: "noe", subjectId: noe },
        })
      ).json().ddeWorkItemId;
    };
    const assignTo = (id: string, membership: string) =>
      realApp.inject({
        method: "POST",
        url: `${BASE}/${id}/assign`,
        headers: asA(),
        payload: { expectedVersion: 0, assigneeMembershipId: membership },
      });

    it("accepts a member with an org-wide billing role even when their default entity differs", async () => {
      const res = await assignTo(await freshItem(), members.orgWide as string);
      expect(res.statusCode).toBe(200);
    });

    it("refuses an eligible member of ANOTHER organization", async () => {
      const res = await assignTo(await freshItem(), members.otherOrg as string);
      expect(res.statusCode).toBe(422);
    });

    it("assigns an active member of the entity who holds billing.dde.work, and nobody else", async () => {
      const noe = await seedNoe(admin);
      const id = (
        await realApp.inject({
          method: "POST",
          url: BASE,
          headers: asA(),
          payload: { itemType: "noe", subjectId: noe },
        })
      ).json().ddeWorkItemId;
      const assign = (m: string, version: number) =>
        realApp.inject({
          method: "POST",
          url: `${BASE}/${id}/assign`,
          headers: asA(),
          payload: { expectedVersion: version, assigneeMembershipId: m },
        });
      // a suspended or revoked member with a lingering role row, and one whose reach excludes the entity: 422
      expect((await assign(members.suspended as string, 0)).statusCode).toBe(422);
      expect((await assign(members.revoked as string, 0)).statusCode).toBe(422);
      expect((await assign(members.outOfReach as string, 0)).statusCode).toBe(422);
      expect((await assign(randomUUID(), 0)).statusCode).toBe(422);
      const ok = await assign(members.ok as string, 0);
      expect(ok.statusCode).toBe(200);
      expect(ok.json().assigneeMembershipId).toBe(members.ok);
    });
  });

  describe("deadlines are judged on the Eastern day", () => {
    const viewAt = async (iso: string, id: string) => {
      const svc: DdeQueueService = buildDdeQueueService(live.handle.db as never, {
        now: () => new Date(iso),
      });
      return svc.get({ organizationId: ORG_A, userId: USER_A }, id);
    };
    it("is still at risk (not overdue) at 23:00 and 01:00 UTC on the day after an Eastern-day-20 deadline", async () => {
      const noe = await seedNoe(admin, { windowTarget: "2026-01-20" });
      const id = (await post("", asA(), { itemType: "noe", subjectId: noe })).json().ddeWorkItemId;
      // 23:00 UTC Jan 20 = 18:00 ET Jan 20; 01:00 UTC Jan 21 = 20:00 ET Jan 20 (UTC would already say Jan 21)
      expect((await viewAt("2026-01-20T23:00:00Z", id)).deadlineStatus).toBe("at_risk");
      expect((await viewAt("2026-01-21T01:00:00Z", id)).deadlineStatus).toBe("at_risk");
      // 06:00 UTC Jan 21 = 01:00 ET Jan 21: now it is overdue
      expect((await viewAt("2026-01-21T06:00:00Z", id)).deadlineStatus).toBe("overdue");
    });
  });

  describe("the window-watch cron", () => {
    const depsAt = (iso: string, over: Partial<M23WorkerDeps> = {}) =>
      ({
        connection: {},
        db: live.handle.db as never,
        now: () => new Date(iso),
        outbox: live.bound("m23"),
        activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
        noticeWindow: { recordBreach: async () => undefined },
        alerts: { dispatch: async () => undefined },
        ddeWatchdog: buildDdeWatchdog({ outbox: live.bound("m23") }),
        ...over,
      }) as unknown as M23WorkerDeps;
    const itemFor = async (noe: string) =>
      (await admin.query("SELECT 1 FROM dde_work_item WHERE subject_id=$1", [noe])).rowCount;

    it("counts its 3-day look-ahead from the Eastern day, not the UTC date", async () => {
      // 01:00 UTC Feb 11 = 20:00 ET Feb 10: look-ahead runs through Feb 13 (UTC would say Feb 14)
      const inside = await seedNoe(admin, { windowTarget: "2026-02-13" });
      const outside = await seedNoe(admin, { windowTarget: "2026-02-14" });
      await runNoeWindowWatch(depsAt("2026-02-11T01:00:00Z"));
      expect(await itemFor(inside)).toBe(1);
      expect(await itemFor(outside)).toBe(0);
    });

    it("still queues a newer at-risk notice when more than 200 older notices already have items", async () => {
      await admin.query(`
        WITH n AS (
          INSERT INTO noe_record (id, organization_id, provider_entity_id, patient_id, admission_id, election_period_id,
            state, election_effective_date, window_target_at, noe_control_number)
          SELECT gen_random_uuid(), '${ORG_A}', gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
                 'READY', '2025-01-01', date '2025-01-06' + g, 'BULK' || g || substr(md5(random()::text), 1, 8)
            FROM generate_series(1, 230) g
          RETURNING id, provider_entity_id, patient_id)
        INSERT INTO dde_work_item (organization_id, provider_entity_id, patient_id, item_type, subject_kind, subject_id, source)
        SELECT '${ORG_A}', provider_entity_id, patient_id, 'noe', 'noe_record', id, 'watchdog' FROM n`);
      const newer = await seedNoe(admin, { windowTarget: "2026-03-02" });
      await runNoeWindowWatch(depsAt("2026-03-01T15:00:00Z"));
      expect(await itemFor(newer)).toBe(1);
    });

    it("contains a poison notice: the notices after it still get items, and the failure is reported", async () => {
      const poison = await seedNoe(admin, { windowTarget: "2026-05-01" });
      const fine = await seedNoe(admin, { windowTarget: "2026-05-02" });
      const real = buildDdeWatchdog({ outbox: live.bound("m23") });
      const logged: Record<string, unknown>[] = [];
      const deps = depsAt("2026-05-01T15:00:00Z", {
        ddeWatchdog: {
          ensureNoticeItem: async (tx, notice) => {
            if (notice.noticeId === poison) throw new Error("poison");
            return real.ensureNoticeItem(tx, notice);
          },
          ensureClaimRtpItem: real.ensureClaimRtpItem,
          supersedeForSubject: real.supersedeForSubject,
        },
        logger: { error: (fields) => void logged.push(fields) },
      });
      const err = await runNoeWindowWatch(deps).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AggregateError);
      expect((err as AggregateError).errors.map((e: Error) => e.message)).toContain("poison");
      expect(await itemFor(fine)).toBe(1);
      expect(await itemFor(poison)).toBe(0);
      const mine = logged.filter((l) => l.organizationId === ORG_A);
      expect(mine.length).toBeGreaterThan(0);
      // the message only, never the error object (a database error can embed bound parameters)
      expect(mine[0]).toMatchObject({ error: "poison" });
      expect(mine[0]).not.toHaveProperty("err");
    });

    it("reports the failures of every org together (an AggregateError), not just the first", async () => {
      await seedNoe(admin, { windowTarget: "2026-06-01" });
      await seedNoe(admin, { windowTarget: "2026-06-01", orgId: ORG_B });
      const deps = depsAt("2026-06-01T15:00:00Z", {
        activeOrgs: {
          listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
        },
        ddeWatchdog: {
          ensureNoticeItem: async () => {
            throw new Error("down");
          },
          ensureClaimRtpItem: async () => ({ created: false }),
          supersedeForSubject: async () => ({ closed: 0 }),
        },
      });
      const err = (await runNoeWindowWatch(deps).then(
        () => null,
        (e: unknown) => e,
      )) as AggregateError;
      expect(err).toBeInstanceOf(AggregateError);
      expect(err.message).toContain(ORG_A);
      expect(err.message).toContain(ORG_B);
      expect(err.errors.length).toBeGreaterThanOrEqual(2);
    });

    it("keeps the window warning when the DDE step fails (own transaction), then reports the failure", async () => {
      const noe = await seedNoe(admin, { windowTarget: "2026-04-01" });
      const failing = depsAt("2026-04-01T15:00:00Z", {
        ddeWatchdog: {
          ensureNoticeItem: async () => {
            throw new Error("dde watchdog down");
          },
          ensureClaimRtpItem: async () => ({ created: false }),
          supersedeForSubject: async () => ({ closed: 0 }),
        },
      });
      const failed = (await runNoeWindowWatch(failing).then(
        () => null,
        (e: unknown) => e,
      )) as AggregateError;
      expect(failed).toBeInstanceOf(AggregateError);
      expect(failed.errors.map((e: Error) => e.message)).toContain("dde watchdog down");
      const warned = await admin.query(
        "SELECT 1 FROM outbox_event WHERE event_type='m23.noe.window_warning' AND payload->>'noeId'=$1",
        [noe],
      );
      expect(warned.rowCount).toBe(1);
      expect(await itemFor(noe)).toBe(0);
    });
  });

  describe("keying sheet and payer-acceptance supersede (ADR-0052 amendment)", () => {
    const watchdog = () => buildDdeWatchdog({ outbox: live.bound("m23") });
    const supersede = (org: string, subjectKind: "claim" | "noe_record", subjectId: string) =>
      withOrgContext(live.handle.db as never, { organizationId: org, userId: USER_A }, (tx) =>
        watchdog().supersedeForSubject(tx as never, {
          organizationId: org,
          subjectKind,
          subjectId,
        }),
      );

    it("the detail route carries the NOE keying sheet (TOB, election date, deadline), never an MBI", async () => {
      const noe = await seedNoe(admin, { electionDate: "2026-07-01", windowTarget: "2026-07-06" });
      const item = (await post("", asA(), { itemType: "noe", subjectId: noe })).json();
      const detail = (await get(`/${item.ddeWorkItemId}`)).json();
      const fields = Object.fromEntries(
        detail.keying.fields.map((f: { label: string; value: string }) => [f.label, f.value]),
      );
      expect(fields["Type of bill"]).toBe("81A");
      expect(fields["Election / admission date"]).toBe("2026-07-01");
      expect(fields["Filing deadline (MAC acceptance)"]).toBe("2026-07-06");
      expect(detail.keying.screenHint).toContain("81A");
      expect(JSON.stringify(detail.keying)).not.toMatch(/mbi/i);
    });

    it("the detail route carries the claim keying sheet for an RTP correction", async () => {
      const { claimId } = await seedClaimWithSubmission(admin, { state: "ACK_REJECTED" });
      const item = (
        await post("", asA(), { itemType: "rtp_correction", subjectId: claimId })
      ).json();
      const detail = (await get(`/${item.ddeWorkItemId}`)).json();
      const labels = detail.keying.fields.map((f: { label: string }) => f.label);
      expect(labels).toEqual(
        expect.arrayContaining(["Type of bill", "Statement from", "Statement through"]),
      );
      expect(detail.keying.screenHint).toContain("B9997");
    });

    it("supersede closes the open item with a system history row and a catalog-valid event; a replay closes nothing", async () => {
      const noe = await seedNoe(admin);
      const item = (await post("", asA(), { itemType: "noe", subjectId: noe })).json();
      const id = item.ddeWorkItemId as string;

      expect(await supersede(ORG_A, "noe_record", noe)).toEqual({ closed: 1 });
      expect(await supersede(ORG_A, "noe_record", noe)).toEqual({ closed: 0 });

      const row = (await admin.query("SELECT state FROM dde_work_item WHERE id=$1", [id])).rows[0];
      expect(row.state).toBe("closed");
      const ev = (
        await admin.query(
          "SELECT event, actor_kind, actor_membership_id, detail FROM dde_work_event WHERE work_item_id=$1 ORDER BY occurred_at DESC, id DESC LIMIT 1",
          [id],
        )
      ).rows[0];
      expect(ev).toMatchObject({ event: "close", actor_kind: "system", actor_membership_id: null });
      expect(ev.detail).toMatchObject({ trigger: "payer_accepted" });
      const out = await admin.query(
        "SELECT payload FROM outbox_event WHERE event_type='m23.dde_item.state_changed' AND payload->>'ddeItemId'=$1 AND payload->>'toState'='closed'",
        [id],
      );
      expect(out.rowCount).toBe(1);
    });

    it("a claim acceptance closes the RTP item but leaves an open adjustment on the same claim", async () => {
      const { claimId } = await seedClaimWithSubmission(admin, { state: "ACK_REJECTED" });
      const rtp = (
        await post("", asA(), { itemType: "rtp_correction", subjectId: claimId })
      ).json();
      await admin.query("UPDATE claim SET state='PAID' WHERE id=$1", [claimId]);
      const adj = (await post("", asA(), { itemType: "adjustment", subjectId: claimId })).json();
      expect(await supersede(ORG_A, "claim", claimId)).toEqual({ closed: 1 });
      const states = await admin.query(
        "SELECT id, state FROM dde_work_item WHERE id = ANY($1::uuid[])",
        [[rtp.ddeWorkItemId, adj.ddeWorkItemId]],
      );
      const byId = Object.fromEntries(states.rows.map((r) => [r.id, r.state]));
      expect(byId[rtp.ddeWorkItemId]).toBe("closed");
      expect(byId[adj.ddeWorkItemId]).toBe("queued");
    });

    it("supersede leaves a finished (accepted / cancelled) item alone", async () => {
      const noe = await seedNoe(admin);
      const item = (await post("", asA(), { itemType: "noe", subjectId: noe })).json();
      await post(`/${item.ddeWorkItemId}/cancel`, asA(), { expectedVersion: 0 });
      expect(await supersede(ORG_A, "noe_record", noe)).toEqual({ closed: 0 });
      const row = (
        await admin.query("SELECT state FROM dde_work_item WHERE id=$1", [item.ddeWorkItemId])
      ).rows[0];
      expect(row.state).toBe("cancelled");
    });

    it("tenant isolation (as chartwarden_app): another org's acceptance cannot close this org's item, and cannot read its keying sheet", async () => {
      const noe = await seedNoe(admin);
      const item = (await post("", asA(), { itemType: "noe", subjectId: noe })).json();
      expect(await supersede(ORG_B, "noe_record", noe)).toEqual({ closed: 0 });
      const row = (
        await admin.query("SELECT state FROM dde_work_item WHERE id=$1", [item.ddeWorkItemId])
      ).rows[0];
      expect(row.state).toBe("queued");
      const asB = await app.inject({
        method: "GET",
        url: `${BASE}/${item.ddeWorkItemId}`,
        headers: { "x-test-user": USER_B },
      });
      expect(asB.statusCode).toBe(404);
    });
  });
});
