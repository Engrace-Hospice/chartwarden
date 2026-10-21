/**
 * M25 non-response routing and MAC reopenings (hospice ADR/TPE/QIC PRD, milestone 3) - LIVE Postgres as the
 * NOBYPASSRLS `wardenx_app` role, through the real services and the real M23 claim seam.
 *
 * Proves what the pure suites cannot: a denial the routing rules send to a reopening refuses an appeal unless an
 * audited override reason is given (and an unmatched denial still appeals exactly as before), a tenant's own rule
 * outranks the built-in 56900 default, a reopening opens only for a reopening-route denial and moves the ADR it
 * answers to `denied_no_response` in the same transaction, a reopening cannot reach `submitted` without its filing
 * proof (service and database CHECK), the database freezes a filed reopening and a terminal one, the app role cannot
 * delete, a stale If-Match is a 409, and another tenant sees nothing.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:routing:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { repositories } from "@chartwarden/billing";
import { createDbClient } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { registerM23PublishedSeams } from "../src/modules/23-billing-medicare/cost-report-seams";
import { buildDrizzleAdrService } from "../src/modules/25-remittance/routes/adr-service";
import { buildDrizzleDenialRouteService } from "../src/modules/25-remittance/routes/denial-route-service";
import { buildDrizzleReopeningService } from "../src/modules/25-remittance/routes/reopening-service";
import { buildDrizzleM25WriteService } from "../src/modules/25-remittance/routes/write-service-drizzle";
import { appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";

describe.skipIf(!DB_URL)("M25 denial routing and reopenings - LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerEntityId = "";
  let claimId = "";
  let userA = "";
  let memberA = "";
  let memberB = "";
  const patient = randomUUID();

  const actorOf = (membershipId: string, organizationId = ORG) => ({
    organizationId,
    userId: userA,
    membershipId,
    roles: ["billing_manager"],
    stepUpRecent: true,
  });
  const A = () => actorOf(memberA);
  const routeSvc = () => buildDrizzleDenialRouteService(handle.db);
  const reopenSvc = () => buildDrizzleReopeningService(handle.db);
  const adrSvc = () => buildDrizzleAdrService(handle.db);
  const writeSvc = () =>
    buildDrizzleM25WriteService(handle.db, { publish: async () => undefined } as never, {});
  const daysAgo = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const refused = async (p: Promise<unknown>) =>
    p.then(
      () => null,
      (e: { code?: string; message?: string; statusCode?: number }) => e,
    );

  async function mkDenial(
    over: { org?: string; pe?: string; claim?: string } = {},
  ): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO denial_case (organization_id, provider_entity_id, claim_id, source_evv_aggregator_submission_id,
           carc_code, category, source, state, dollar_value, taxonomy_status)
         VALUES ($1,$2,$3,$4,'50','denial','evv_aggregator_rejection','open',10,'mapped') RETURNING id`,
        [over.org ?? ORG, over.pe ?? providerEntityId, over.claim ?? claimId, randomUUID()],
      )
    ).rows[0].id as string;
  }
  const dver = async (id: string) =>
    Number(
      (await admin.query("SELECT version FROM denial_case WHERE id=$1", [id])).rows[0].version,
    );
  const rver = async (id: string) =>
    Number(
      (await admin.query("SELECT version FROM reopening_case WHERE id=$1", [id])).rows[0].version,
    );
  const rrow = async (id: string) =>
    (await admin.query("SELECT * FROM reopening_case WHERE id=$1", [id])).rows[0];
  const arow = async (id: string) =>
    (await admin.query("SELECT * FROM adr_case WHERE id=$1", [id])).rows[0];

  /** A denial carrying the MAC reason code 56900, so the built-in rule sends it to a reopening. */
  async function reopeningDenial(): Promise<string> {
    const id = await mkDenial();
    await routeSvc().setMacReasonCode(A(), id, "56900", await dver(id));
    return id;
  }
  const filing = (over: Record<string, unknown> = {}) => ({
    formName: "CGS 56900 reopening request",
    channel: "mac_portal",
    confirmationRef: "PRT-90210",
    filedAt: new Date().toISOString(),
    ...over,
  });

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
      [ORG, "m25-route"],
      [ORG_B, "m25-route-b"],
    ])
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,'A','A')",
        [org, slug],
      );
    userA = (await admin.query(`INSERT INTO "user" (email) VALUES ('route-a@x.test') RETURNING id`))
      .rows[0].id as string;
    const userB = (
      await admin.query(`INSERT INTO "user" (email) VALUES ('route-b@x.test') RETURNING id`)
    ).rows[0].id as string;
    const member = async (user: string, org = ORG) =>
      (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [user, org],
        )
      ).rows[0].id as string;
    memberA = await member(userA);
    memberB = await member(userB, ORG_B);
    providerEntityId = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-ROUTE','ROUTE','NPI-ROUTE','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    claimId = (
      await withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
        new repositories.ClaimRepository(tx).create({
          organizationId: ORG,
          providerEntityId,
          patientId: patient,
          admissionId: randomUUID(),
          electionPeriodIdFrom: randomUUID(),
          electionPeriodIdTo: randomUUID(),
          patientPayerId: randomUUID(),
          tob: "811",
          serviceFrom: "2026-03-01",
          serviceTo: "2026-03-31",
          claimControlNumber: "CCN-ROUTE-0001",
          payerClaimControlNumber: null,
          macJurisdiction: "ngs_j6",
          sequestrationAppliedPct: "2.00",
          sequestrationPolicyId: randomUUID(),
          createdByMembershipId: randomUUID(),
          totalChargeCents: 100_000,
        }),
      )
    ).id;
    registerM23PublishedSeams(handle.db);
  }, 240_000);

  afterAll(async () => {
    await handle?.close?.();
    await admin?.end();
  });

  it("registers the new permission keys in the catalog", async () => {
    const keys = (
      await admin.query(
        `SELECT key FROM permission WHERE key IN ('reopening.read','reopening.manage','reopening.submit',
           'denial.route_override','denial_route.manage')`,
      )
    ).rows.map((r) => r.key as string);
    expect(keys.sort()).toEqual([
      "denial.route_override",
      "denial_route.manage",
      "reopening.manage",
      "reopening.read",
      "reopening.submit",
    ]);
  });

  it("leaves an unmatched denial appealable exactly as before", async () => {
    const id = await mkDenial();
    const view = await routeSvc().getRoute(A(), id);
    expect(view).toMatchObject({ route: "undetermined", rule: null, unverified: false });
    const appeal = await writeSvc().createAppeal(A(), id, { noticeDate: daysAgo(3) });
    expect(appeal.id).toBeTruthy();
  });

  it("routes a 56900 to a reopening out of the box, unverified, and shows which rule decided", async () => {
    const id = await reopeningDenial();
    const view = await routeSvc().getRoute(A(), id);
    expect(view).toMatchObject({ route: "reopening", unverified: true, macReasonCode: "56900" });
    expect(view.rule).toMatchObject({ origin: "platform", codeKind: "mac_reason", code: "56900" });
  });

  it("validates the MAC reason code and enforces If-Match on setting it", async () => {
    const id = await mkDenial();
    expect(
      await refused(routeSvc().setMacReasonCode(A(), id, "bad code!", await dver(id))),
    ).toMatchObject({ statusCode: 422 });
    const v = await dver(id);
    await routeSvc().setMacReasonCode(A(), id, " 5fftf ", v);
    expect((await routeSvc().getRoute(A(), id)).macReasonCode).toBe("5FFTF");
    expect(await refused(routeSvc().setMacReasonCode(A(), id, "56900", v))).toMatchObject({
      statusCode: 409,
    });
    expect(await refused(routeSvc().setMacReasonCode(A(), randomUUID(), "56900", 1))).toMatchObject(
      { statusCode: 404 },
    );
  });

  it("refuses an appeal on a reopening-route denial without an override, and records the override reason", async () => {
    const id = await reopeningDenial();
    expect(
      await refused(writeSvc().createAppeal(A(), id, { noticeDate: daysAgo(3) })),
    ).toMatchObject({ code: "ROUTE_IS_REOPENING", statusCode: 409 });
    expect(
      await refused(
        writeSvc().createAppeal(A(), id, {
          noticeDate: daysAgo(3),
          routeOverrideReason: "too short",
        }),
      ),
    ).toMatchObject({ code: "ROUTE_IS_REOPENING" });
    const appeal = await writeSvc().createAppeal(A(), id, {
      noticeDate: daysAgo(3),
      routeOverrideReason: "The MAC confirmed this is appealable",
    });
    const ev = (
      await admin.query(
        "SELECT event_payload FROM appeal_case_event WHERE appeal_case_id=$1 AND event_kind='created'",
        [appeal.id],
      )
    ).rows[0].event_payload;
    expect(ev).toMatchObject({
      routeOverrideReason: "The MAC confirmed this is appealable",
      routeRuleId: "platform:56900",
    });
  });

  it("opens a reopening only for a reopening-route denial, and only one live at a time", async () => {
    const plain = await mkDenial();
    expect(
      await refused(reopenSvc().createReopening(A(), { denialCaseId: plain, macName: "CGS" })),
    ).toMatchObject({ code: "ROUTE_NOT_REOPENING", statusCode: 409 });

    const id = await reopeningDenial();
    expect(await refused(reopenSvc().createReopening(A(), { denialCaseId: id }))).toMatchObject({
      statusCode: 422,
    });
    const created = await reopenSvc().createReopening(A(), { denialCaseId: id, macName: "CGS" });
    expect(await rrow(created.id)).toMatchObject({ state: "draft", mac_name: "CGS", due_at: null });
    expect(
      await refused(reopenSvc().createReopening(A(), { denialCaseId: id, macName: "CGS" })),
    ).toMatchObject({ code: "REOPENING_EXISTS", statusCode: 409 });
    // The database backs the service: a second live row for the same denial is a unique violation.
    await expect(
      admin.query(
        `INSERT INTO reopening_case (organization_id, provider_entity_id, claim_id, denial_case_id, mac_name)
         VALUES ($1,$2,$3,$4,'CGS')`,
        [ORG, providerEntityId, claimId, id],
      ),
    ).rejects.toThrow(/reopening_case_live_per_denial/);
    // Withdrawn is terminal, so a fresh reopening may then be opened.
    await reopenSvc().withdrawReopening(A(), created.id, await rver(created.id));
    expect(
      (await reopenSvc().createReopening(A(), { denialCaseId: id, macName: "CGS" })).id,
    ).toBeTruthy();
  });

  it("moves the ADR it answers to denied_no_response in the same transaction", async () => {
    const denial = await reopeningDenial();
    const adr = await adrSvc().createAdr(A(), {
      claimId,
      macName: "CGS",
      reviewType: "adr",
      requestedOn: daysAgo(50),
      denialCaseId: denial,
    });
    const created = await reopenSvc().createReopening(A(), {
      denialCaseId: denial,
      adrCaseId: adr.id,
    });
    expect(await rrow(created.id)).toMatchObject({ adr_case_id: adr.id, mac_name: "CGS" });
    expect(await arow(adr.id)).toMatchObject({ state: "denied_no_response", version: 2 });
    const kinds = (
      await admin.query(
        "SELECT event_kind FROM adr_case_event WHERE adr_case_id=$1 ORDER BY occurred_at",
        [adr.id],
      )
    ).rows.map((r) => r.event_kind);
    expect(kinds).toContain("denied_no_response");
  });

  it("refuses an ADR on another claim, and a denial in another tenant", async () => {
    const denial = await reopeningDenial();
    // an ADR row on a different claim, seeded directly
    const stray = (
      await admin.query(
        `INSERT INTO adr_case (organization_id, provider_entity_id, claim_id, mac_name, review_type, requested_on,
           window_days, window_source, response_due_at)
         VALUES ($1,$2,$3,'CGS','adr',CURRENT_DATE,45,'platform_default', now() + interval '10 days') RETURNING id`,
        [ORG, providerEntityId, randomUUID()],
      )
    ).rows[0].id as string;
    expect(
      await refused(reopenSvc().createReopening(A(), { denialCaseId: denial, adrCaseId: stray })),
    ).toMatchObject({ statusCode: 404 });
    expect(
      await refused(
        reopenSvc().createReopening(actorOf(memberB, ORG_B), {
          denialCaseId: denial,
          macName: "CGS",
        }),
      ),
    ).toMatchObject({ statusCode: 404 });
  });

  it("lets a tenant rule outrank the built-in default, case-insensitively", async () => {
    const id = await reopeningDenial();
    const rule = await routeSvc().upsertRule(A(), {
      codeKind: "mac_reason",
      code: "56900",
      route: "appeal",
      verifiedOn: daysAgo(1),
      sourceNote: "Confirmed with the MAC",
    });
    const again = await routeSvc().upsertRule(A(), {
      codeKind: "mac_reason",
      code: " 56900 ",
      route: "appeal",
      verifiedOn: daysAgo(1),
    });
    expect(again.id).toBe(rule.id);
    expect(again.version).toBe(2);
    const view = await routeSvc().getRoute(A(), id);
    expect(view).toMatchObject({ route: "appeal", unverified: false });
    expect(view.rule).toMatchObject({ origin: "org" });
    // the denial is appealable again without an override
    expect((await writeSvc().createAppeal(A(), id, { noticeDate: daysAgo(3) })).id).toBeTruthy();
    expect(
      await refused(routeSvc().upsertRule(A(), { codeKind: "carc", code: "", route: "appeal" })),
    ).toMatchObject({ statusCode: 422 });
    await admin.query("DELETE FROM denial_route_rule WHERE organization_id=$1", [ORG]);
  });

  it("records a filing only with its proof, in order, and freezes it in the database", async () => {
    const id = await reopeningDenial();
    const { id: rid } = await reopenSvc().createReopening(A(), {
      denialCaseId: id,
      macName: "CGS",
    });
    for (const [bad, code] of [
      [{ formName: " " }, "FORM_REQUIRED"],
      [{ channel: "esmd" }, "CHANNEL_INVALID"],
      [{ confirmationRef: " " }, "PROOF_REQUIRED"],
      [{ filedAt: new Date(Date.now() + 864e5).toISOString() }, "FILED_IN_FUTURE"],
    ] as const) {
      expect(
        await refused(reopenSvc().submitReopening(A(), rid, filing(bad), await rver(rid))),
      ).toMatchObject({ code, statusCode: 422 });
    }
    expect(await rrow(rid)).toMatchObject({ state: "draft" });
    // a decision before a filing is an illegal edge
    expect(
      await refused(reopenSvc().decideReopening(A(), rid, "granted", await rver(rid))),
    ).toMatchObject({ code: "INVALID_TRANSITION", statusCode: 409 });
    const stale = await rver(rid);
    await reopenSvc().submitReopening(A(), rid, filing(), stale);
    expect(await rrow(rid)).toMatchObject({
      state: "submitted",
      form_name: "CGS 56900 reopening request",
      filing_channel: "mac_portal",
      filing_confirmation_ref: "PRT-90210",
    });
    // a stale If-Match is a 409, and a second filing is an illegal edge
    expect(await refused(reopenSvc().submitReopening(A(), rid, filing(), stale))).toMatchObject({
      statusCode: 409,
    });
    // the database freezes the filing record
    await expect(
      admin.query("UPDATE reopening_case SET filing_confirmation_ref='CHANGED' WHERE id=$1", [rid]),
    ).rejects.toThrow(/M25_REOPENING_FILING_IMMUTABLE/);
    // a deadline can still be recorded while it is filed
    await reopenSvc().setDue(A(), rid, "2099-01-01T00:00:00.000Z", await rver(rid));
    expect((await rrow(rid)).due_at.toISOString()).toBe("2099-01-01T00:00:00.000Z");
    // decide, close, and the terminal row is frozen
    await reopenSvc().decideReopening(A(), rid, "granted", await rver(rid));
    expect(await rrow(rid)).toMatchObject({ state: "decided", outcome: "granted" });
    await reopenSvc().closeReopening(A(), rid, await rver(rid));
    expect(await rrow(rid)).toMatchObject({ state: "closed" });
    await expect(
      admin.query("UPDATE reopening_case SET due_at=NULL WHERE id=$1", [rid]),
    ).rejects.toThrow(/M25_REOPENING_TERMINAL_IMMUTABLE/);
    expect(await refused(reopenSvc().setDue(A(), rid, null, await rver(rid)))).toMatchObject({
      statusCode: 409,
    });
  });

  it("backs the proof rule with a database CHECK no code path can bypass", async () => {
    const id = await reopeningDenial();
    const { id: rid } = await reopenSvc().createReopening(A(), {
      denialCaseId: id,
      macName: "CGS",
    });
    await expect(
      admin.query("UPDATE reopening_case SET state='submitted' WHERE id=$1", [rid]),
    ).rejects.toThrow(/reopening_case_filed_has_proof/);
    // a draft cannot skip filing and the decision
    await expect(
      admin.query("UPDATE reopening_case SET state='decided' WHERE id=$1", [rid]),
    ).rejects.toThrow(/M25_REOPENING_ILLEGAL_TRANSITION/);
    // a draft carrying filing facts is refused
    await expect(
      admin.query("UPDATE reopening_case SET filed_at=now() WHERE id=$1", [rid]),
    ).rejects.toThrow(/reopening_case_draft_not_filed/);
    // once filed: a decision needs its outcome, state cannot go backwards, a recorded decision cannot change
    await reopenSvc().submitReopening(A(), rid, filing(), await rver(rid));
    await expect(
      admin.query("UPDATE reopening_case SET state='decided' WHERE id=$1", [rid]),
    ).rejects.toThrow(/reopening_case_decided_has_outcome/);
    await expect(
      admin.query("UPDATE reopening_case SET state='draft' WHERE id=$1", [rid]),
    ).rejects.toThrow(/M25_REOPENING_ILLEGAL_TRANSITION/);
    await reopenSvc().decideReopening(A(), rid, "granted", await rver(rid));
    await expect(
      admin.query("UPDATE reopening_case SET outcome='denied' WHERE id=$1", [rid]),
    ).rejects.toThrow(/M25_REOPENING_DECISION_IMMUTABLE/);
    await expect(
      admin.query("UPDATE reopening_case SET state='submitted' WHERE id=$1", [rid]),
    ).rejects.toThrow(/M25_REOPENING_ILLEGAL_TRANSITION/);
    await expect(
      admin.query("UPDATE reopening_case SET state='closed' WHERE id=$1", [rid]),
    ).rejects.toThrow(/reopening_case_closed_has_time/);
  });

  it("refuses a blank MAC name in the database", async () => {
    await expect(
      admin.query(
        `INSERT INTO denial_route_rule (organization_id, mac_name, code_kind, code, route)
         VALUES ($1,'  ','carc','50','appeal')`,
        [ORG],
      ),
    ).rejects.toThrow(/denial_route_rule_mac_name_check/);
  });

  it("locks the MAC reason code once the denial is on a reopening route, so the override cannot be dodged", async () => {
    const id = await reopeningDenial();
    for (const code of [null, "X1"]) {
      expect(
        await refused(routeSvc().setMacReasonCode(A(), id, code, await dver(id))),
      ).toMatchObject({ code: "ROUTE_LOCKED", statusCode: 409 });
    }
    // re-saving the same code is not a change
    await routeSvc().setMacReasonCode(A(), id, "56900", await dver(id));
    // and the plain appeal route is still closed
    expect(
      await refused(writeSvc().createAppeal(A(), id, { noticeDate: daysAgo(3) })),
    ).toMatchObject({ code: "ROUTE_IS_REOPENING" });
  });

  it("keeps a denial on the reopening path while a reopening is live, even if the rules flip later", async () => {
    const id = await reopeningDenial();
    const { id: rid } = await reopenSvc().createReopening(A(), {
      denialCaseId: id,
      macName: "CGS",
    });
    await routeSvc().upsertRule(A(), {
      codeKind: "mac_reason",
      code: "56900",
      route: "appeal",
      verifiedOn: daysAgo(1),
    });
    expect(
      await refused(writeSvc().createAppeal(A(), id, { noticeDate: daysAgo(3) })),
    ).toMatchObject({ code: "ROUTE_IS_REOPENING", statusCode: 409 });
    await reopenSvc().withdrawReopening(A(), rid, await rver(rid));
    await admin.query("DELETE FROM denial_route_rule WHERE organization_id=$1", [ORG]);
  });

  it("refuses a reopening while an appeal is in progress on the denial", async () => {
    const id = await reopeningDenial();
    await writeSvc().createAppeal(A(), id, {
      noticeDate: daysAgo(3),
      routeOverrideReason: "The MAC said this is appealable",
    });
    expect(
      await refused(reopenSvc().createReopening(A(), { denialCaseId: id, macName: "CGS" })),
    ).toMatchObject({ code: "APPEAL_IN_PROGRESS", statusCode: 409 });
  });

  it("does not consume an ADR tied to another denial, and takes the MAC from the denial's own ADR", async () => {
    const mine = await reopeningDenial();
    const sibling = await mkDenial();
    const siblingAdr = await adrSvc().createAdr(A(), {
      claimId,
      macName: "Palmetto",
      reviewType: "adr",
      requestedOn: daysAgo(5),
      denialCaseId: sibling,
    });
    expect(
      await refused(
        reopenSvc().createReopening(A(), { denialCaseId: mine, adrCaseId: siblingAdr.id }),
      ),
    ).toMatchObject({ statusCode: 404 });
    expect(await arow(siblingAdr.id)).toMatchObject({ state: "received" });
    // the sibling's newer ADR does not steer this denial's MAC, so a CGS-only rule still applies to it
    await adrSvc().createAdr(A(), {
      claimId,
      macName: "CGS",
      reviewType: "adr",
      requestedOn: daysAgo(6),
      denialCaseId: mine,
    });
    await adrSvc().createAdr(A(), {
      claimId,
      macName: "Palmetto",
      reviewType: "adr",
      requestedOn: daysAgo(4),
      denialCaseId: sibling,
    });
    expect((await routeSvc().getRoute(A(), mine)).macName).toBe("CGS");
  });

  it("makes exactly one of two racing creates win, the other a clean 409", async () => {
    const id = await reopeningDenial();
    const results = await Promise.all(
      [1, 2].map(() =>
        refused(reopenSvc().createReopening(A(), { denialCaseId: id, macName: "CGS" })),
      ),
    );
    const losers = results.filter((r) => r !== null);
    expect(losers).toHaveLength(1);
    expect(losers[0]).toMatchObject({ code: "REOPENING_EXISTS", statusCode: 409 });
  });

  it("moves an ADR whose version had already advanced, with exactly one event (the zero-row race itself is guarded in code, not injectable here)", async () => {
    const denial = await reopeningDenial();
    const adr = await adrSvc().createAdr(A(), {
      claimId,
      macName: "CGS",
      reviewType: "adr",
      requestedOn: daysAgo(40),
      denialCaseId: denial,
    });
    // another writer bumps the ADR version first (the service reads it, then updates where version matches)
    await admin.query("UPDATE adr_case SET version = version + 1 WHERE id=$1", [adr.id]);
    const created = await reopenSvc().createReopening(A(), {
      denialCaseId: denial,
      adrCaseId: adr.id,
    });
    // a fresh read sees the bumped version, so the move still applies once, with exactly one event
    expect(await arow(adr.id)).toMatchObject({ state: "denied_no_response", version: 3 });
    expect(
      Number(
        (
          await admin.query(
            "SELECT count(*) FROM adr_case_event WHERE adr_case_id=$1 AND event_kind='denied_no_response'",
            [adr.id],
          )
        ).rows[0].count,
      ),
    ).toBe(1);
    expect(created.id).toBeTruthy();
  });

  it("ranks a MAC reason code above a MAC-specific CARC rule, live", async () => {
    const id = await reopeningDenial();
    await routeSvc().upsertRule(A(), {
      macName: "CGS",
      codeKind: "carc",
      code: "50",
      route: "appeal",
      verifiedOn: daysAgo(1),
    });
    await adrSvc().createAdr(A(), {
      claimId,
      macName: "CGS",
      reviewType: "adr",
      requestedOn: daysAgo(2),
      denialCaseId: id,
    });
    expect((await routeSvc().getRoute(A(), id)).route).toBe("reopening");
    await admin.query("DELETE FROM denial_route_rule WHERE organization_id=$1", [ORG]);
  });

  it("keeps an append-only history and writes an audit row without the confirmation reference", async () => {
    const id = await reopeningDenial();
    const { id: rid } = await reopenSvc().createReopening(A(), {
      denialCaseId: id,
      macName: "CGS",
    });
    await reopenSvc().submitReopening(
      A(),
      rid,
      filing({ confirmationRef: "SECRET-REF-123" }),
      await rver(rid),
    );
    const detail = await reopenSvc().getReopening(A(), rid);
    expect(detail?.events.map((e) => e.eventKind)).toEqual(["created", "submitted"]);
    expect(detail?.filingConfirmationRef).toBe("SECRET-REF-123");
    const audit = (
      await admin.query(
        "SELECT after FROM audit_event WHERE resource_kind='reopening_case' AND resource_id=$1 AND event_type='reopening_case.update'",
        [rid],
      )
    ).rows;
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain("SECRET-REF-123");
  });

  it("denies the app role any DELETE and isolates tenants", async () => {
    const id = await reopeningDenial();
    const { id: rid } = await reopenSvc().createReopening(A(), {
      denialCaseId: id,
      macName: "CGS",
    });
    // drizzle wraps the driver error, so the database's own message is on the cause
    const dbMessage = async (p: Promise<unknown>): Promise<string> =>
      p.then(
        () => "",
        (e: { cause?: { message?: string }; message?: string }) =>
          e.cause?.message ?? e.message ?? "",
      );
    expect(
      await dbMessage(
        withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
          tx.execute(sql`DELETE FROM reopening_case WHERE id = ${rid}`),
        ),
      ),
    ).toMatch(/permission denied/);
    expect(
      await dbMessage(
        withOrgContext(handle.db, { organizationId: ORG, userId: "" }, (tx) =>
          tx.execute(sql`DELETE FROM reopening_case_event`),
        ),
      ),
    ).toMatch(/permission denied/);
    const other = actorOf(memberB, ORG_B);
    expect(await reopenSvc().getReopening(other, rid)).toBeNull();
    expect((await reopenSvc().listReopenings(other, {}, 50)).items).toEqual([]);
    expect(await refused(reopenSvc().withdrawReopening(other, rid, 1))).toMatchObject({
      statusCode: 404,
    });
    expect((await routeSvc().listRules(other)).items).toEqual([]);
    expect(
      (await reopenSvc().listReopenings(A(), { state: "draft" }, 50)).items.length,
    ).toBeGreaterThan(0);
  });
});
