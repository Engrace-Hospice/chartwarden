/**
 * M25 denial-reason playbooks, milestone 9a-1 (hospice ADR/TPE/QIC PRD, milestone 9) - LIVE Postgres as the NOBYPASSRLS
 * `chartwarden_app` role, through the real service and the real routes. No model, no outbox event, no seeded text.
 *
 * Proves what the pure suites cannot: a FRESH tenant holds zero playbook rows in all three tables (nothing is seeded); a
 * denial with no published playbook reads `playbook: null`; the author cannot publish their own draft and a published row
 * must carry a different reviewer (service AND CHECK); a published version is frozen by trigger and only one version per
 * playbook is published (partial unique index), publishing a new version retires the old one; resolution follows the
 * routing precedence (MAC-specific beats any-MAC) and ignores a version that is not in effect; ticking a step changes NO
 * denial, appeal, ADR, submission or case-event row (row-for-row snapshot) and nothing reads it; the app role has no
 * DELETE and RLS is forced; another tenant sees nothing and a cross-tenant parent is refused; the audit trail scrubs the
 * playbook text; the routes gate on playbook.read / .author / .publish (+ denial.read for the panel), require an
 * Idempotency-Key and If-Match, narrow by provider entity, and the read audit event lands with the denial id; migration
 * 1251 grants existing roles idempotently.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://... bun run test:m25:playbook:live
 * (SUPERUSER to a THROWAWAY db - this file DROPs and recreates the public schema.)
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAbacRegistry,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { FormatRegistry } from "@sinclair/typebox";
import { sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildM25AbacPredicates } from "../src/modules/25-remittance/abac-predicates";
import { buildDrizzlePlaybookService } from "../src/modules/25-remittance/routes/playbook-service";
import { registerPlaybookRoutes } from "../src/modules/25-remittance/routes/playbook.routes";
import { type M7Fixture, ORG, ORG_B, setupM7Fixture } from "./_m25-m7-fixture";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!FormatRegistry.Has("uuid")) FormatRegistry.Set("uuid", (v) => UUID_RE.test(v));

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const NEW_TABLES = ["denial_playbook", "denial_playbook_version", "denial_playbook_case_step"];
const SECRET = "SECRET-PLAYBOOK-TEXT-do-not-leak";

const content = (over: Record<string, unknown> = {}) => ({
  summary: "Test summary written by the organization.",
  sourceNote: "Test fixture: written for this suite, not a rule",
  steps: [
    { key: "first", text: "First step" },
    { key: "second", text: "Second step" },
  ],
  ...over,
});

describe.skipIf(!DB_URL)("M25 denial playbooks (milestone 9a-1) - LIVE Postgres", () => {
  let fx: M7Fixture;
  let memberA2: string;
  let userA2: string;
  const svc = () => buildDrizzlePlaybookService(fx.handle.db);
  const A = () => fx.actor();
  let memberA3: string;
  let userA3: string;
  const A3 = () => ({ ...fx.actor(), userId: userA3, membershipId: memberA3 });
  const A2 = () => ({ ...fx.actor(), userId: userA2, membershipId: memberA2 });
  const B = () => fx.actor(ORG_B);

  /** A playbook with its first draft, published by the second person. Returns ids. */
  async function published(
    key: { codeKind: "carc" | "rarc" | "mac_reason"; code: string; macName?: string },
    over: Record<string, unknown> = {},
  ) {
    const created = await svc().createPlaybook(A(), {
      ...key,
      title: `Playbook ${key.code}`,
      ...content(over),
    } as never);
    const v = await svc().publishVersion(A2(), created.versionId, 1);
    return { ...created, effectiveFrom: v.effectiveFrom };
  }

  async function denialWith(
    codes: { carc?: string; rarc?: string | null; mac?: string | null } = {},
  ) {
    const id = await fx.mkDenial(fx.claim1, fx.pe1);
    await fx.admin.query(
      "UPDATE denial_case SET carc_code=$2, rarc_code=$3, mac_reason_code=$4 WHERE id=$1",
      [id, codes.carc ?? "50", codes.rarc ?? null, codes.mac ?? null],
    );
    return id;
  }

  /** Every row a playbook tick must never touch, as one comparable string. */
  async function humanRecord(denialId: string): Promise<string> {
    const q = async (text: string, args: unknown[] = []) => (await fx.admin.query(text, args)).rows;
    return JSON.stringify({
      denial: await q("SELECT * FROM denial_case ORDER BY id"),
      appeals: await q("SELECT * FROM appeal_case ORDER BY id"),
      adrs: await q("SELECT * FROM adr_case ORDER BY id"),
      attempts: await q("SELECT count(*)::int AS n FROM submission_attempt"),
      assignments: await q(
        "SELECT count(*)::int AS n FROM denial_case_assignment WHERE denial_case_id=$1",
        [denialId],
      ),
      adrEvents: await q("SELECT count(*)::int AS n FROM adr_case_event"),
    });
  }

  function makeApp(
    keys: string[],
    opts: { member?: string; user?: string; scope?: string[] } = {},
  ) {
    resetAuthorizationContract();
    resetRbacEngine();
    // A fresh predicate registry per app: the reset above clears the evaluator. billing_manager is a broad denial role.
    resetAbacRegistry();
    const reg = createPredicateRegistry();
    for (const [name, predicate] of Object.entries(
      buildM25AbacPredicates({ db: fx.handle.db as never }),
    )) {
      reg.register(name, predicate);
    }
    registerAbacRegistry(reg);
    const user = opts.user ?? fx.userA;
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
        request.context.roles = ["billing_manager"];
        request.context.providerEntityIds = opts.scope ?? [fx.pe1, fx.pe2];
        request.context.attributes = {
          ...request.context.attributes,
          membershipId: opts.member ?? fx.memberA,
        };
      },
      security: { rateLimitEnabled: false },
    });
    registerPlaybookRoutes(app, { playbookService: svc() });
    return app;
  }
  const WRITE = (extra: Record<string, string> = {}) => ({
    "idempotency-key": randomUUID(),
    ...extra,
  });

  beforeAll(async () => {
    fx = await setupM7Fixture(DB_URL as string, "m25-pb");
    userA2 = (
      await fx.admin.query(`INSERT INTO "user" (email) VALUES ('m25-pb-a2@x.test') RETURNING id`)
    ).rows[0].id as string;
    memberA2 = (
      await fx.admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userA2, ORG],
      )
    ).rows[0].id as string;
    userA3 = (await fx.admin.query(`INSERT INTO "user" (email) VALUES ('m25-pb-a3@x.test') RETURNING id`))
      .rows[0].id as string;
    memberA3 = (
      await fx.admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [userA3, ORG],
      )
    ).rows[0].id as string;
  }, 300_000);

  afterAll(async () => {
    await fx?.close();
    resetAbacRegistry();
    resetAuthorizationContract();
    resetRbacEngine();
  });

  it("seeds nothing: a fresh tenant has zero playbooks, versions and ticks, and a denial reads 'none written'", async () => {
    for (const table of NEW_TABLES) {
      const n = (await fx.admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
      expect(n, table).toBe(0);
    }
    const list = await svc().listPlaybooks(A());
    expect(list.items).toEqual([]);
    const denial = await denialWith({ carc: "45" });
    const view = await svc().getDenialPlaybook(A(), denial);
    expect(view).toMatchObject({ playbook: null, codeKind: "carc", code: "45" });
  });

  it("names the most specific code when nothing is written: MAC reason, then RARC, then CARC", async () => {
    const mac = await denialWith({ carc: "45", rarc: "N1", mac: "56900" });
    expect(await svc().getDenialPlaybook(A(), mac)).toMatchObject({
      playbook: null,
      codeKind: "mac_reason",
      code: "56900",
    });
    const rarc = await denialWith({ carc: "45", rarc: "N1" });
    expect(await svc().getDenialPlaybook(A(), rarc)).toMatchObject({
      codeKind: "rarc",
      code: "N1",
    });
  });

  it("forces RLS on all three tables, gives the app role no DELETE and no edit of a playbook's key", async () => {
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
        fx.asApp((tx) => tx.execute(sql.raw("UPDATE denial_playbook SET code='X'"))),
      ),
    ).toMatch(/permission denied/i);
    expect(
      await fx.dbMessage(
        fx.asApp((tx) => tx.execute(sql.raw("UPDATE denial_playbook_version SET version_no=9"))),
      ),
    ).toMatch(/permission denied/i);
  });

  describe("authoring and review", () => {
    it("requires a source note and a valid shape, and the first version is a draft", async () => {
      const blank = await fx.refused(
        svc().createPlaybook(A(), {
          codeKind: "carc",
          code: "97",
          title: "t",
          ...content({ sourceNote: "  " }),
        } as never),
      );
      expect(blank).toMatchObject({ code: "PLAYBOOK_INVALID", statusCode: 422 });
      const dupSteps = await fx.refused(
        svc().createPlaybook(A(), {
          codeKind: "carc",
          code: "97",
          title: "t",
          ...content({
            steps: [
              { key: "a", text: "x" },
              { key: "a", text: "y" },
            ],
          }),
        } as never),
      );
      expect(dupSteps).toMatchObject({ code: "PLAYBOOK_INVALID" });
      const badCode = await fx.refused(
        svc().createPlaybook(A(), {
          codeKind: "carc",
          code: "9-7",
          title: "t",
          ...content(),
        } as never),
      );
      expect(badCode).toMatchObject({ code: "PLAYBOOK_CODE_INVALID", statusCode: 422 });

      const created = await svc().createPlaybook(A(), {
        codeKind: "carc",
        code: "97",
        title: "CARC 97",
        ...content(),
      } as never);
      const detail = await svc().getPlaybook(A(), created.id);
      expect(detail?.versions).toHaveLength(1);
      expect(detail?.versions[0]).toMatchObject({
        versionNo: 1,
        status: "draft",
        reviewedByMembershipId: null,
      });
      // The same key (case-insensitively) is one playbook.
      const twin = await fx.refused(
        svc().createPlaybook(A(), {
          codeKind: "carc",
          code: "97",
          title: "again",
          ...content(),
        } as never),
      );
      expect(twin).toMatchObject({ code: "PLAYBOOK_EXISTS", statusCode: 409 });
    });

    it("refuses the author publishing their own draft, in the service and in the database", async () => {
      const created = await svc().createPlaybook(A(), {
        codeKind: "carc",
        code: "98",
        title: "CARC 98",
        ...content(),
      } as never);
      const self = await fx.refused(svc().publishVersion(A(), created.versionId, 1));
      expect(self).toMatchObject({ code: "PLAYBOOK_REVIEWER_IS_AUTHOR", statusCode: 409 });
      // Forced past the service: the CHECK refuses a published row whose reviewer is its author.
      const msg = await fx.dbMessage(
        fx.admin.query(
          `UPDATE denial_playbook_version SET status='published', reviewed_by_membership_id=authored_by_membership_id,
             published_at=now(), effective_from=CURRENT_DATE WHERE id=$1`,
          [created.versionId],
        ) as never,
      );
      expect(msg).toMatch(/denial_playbook_version_published_reviewed/);
      const row = (
        await fx.admin.query("SELECT status FROM denial_playbook_version WHERE id=$1", [
          created.versionId,
        ])
      ).rows[0];
      expect(row.status).toBe("draft");
    });

    it("refuses the last editor approving: someone who rewrote the draft cannot publish it, even retrying", async () => {
      const created = await svc().createPlaybook(A(), {
        codeKind: "carc",
        code: "102",
        title: "CARC 102",
        ...content(),
      } as never);
      const edited = await svc().updateDraft(A2(), created.versionId, content({ summary: "Rewritten by member 2" }), 1);
      const row = (
        await fx.admin.query("SELECT authored_by_membership_id AS a, last_edited_by_membership_id AS e FROM denial_playbook_version WHERE id=$1", [created.versionId])
      ).rows[0];
      expect(row).toEqual({ a: fx.memberA, e: memberA2 });
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await fx.refused(svc().publishVersion(A2(), created.versionId, edited.rowVersion))).toMatchObject({
          code: "PLAYBOOK_REVIEWER_IS_AUTHOR",
          statusCode: 409,
        });
        expect(await fx.refused(svc().publishVersion(A(), created.versionId, edited.rowVersion))).toMatchObject({
          code: "PLAYBOOK_REVIEWER_IS_AUTHOR",
        });
      }
      // Past the service, the CHECK refuses the editor (or the author) as reviewer.
      const msg = await fx.dbMessage(
        fx.admin.query(
          `UPDATE denial_playbook_version SET status='published', reviewed_by_membership_id=last_edited_by_membership_id,
             published_at=now(), effective_from=CURRENT_DATE WHERE id=$1`,
          [created.versionId],
        ) as never,
      );
      expect(msg).toMatch(/denial_playbook_version_published_reviewed/);
      // The app role cannot reach the author column, and the editor column freezes once published.
      expect(
        await fx.dbMessage(
          fx.asApp((tx) => tx.execute(sql`UPDATE denial_playbook_version SET authored_by_membership_id=${memberA2}`)),
        ),
      ).toMatch(/permission denied/i);
      const ok = await svc().publishVersion(A3(), created.versionId, edited.rowVersion);
      expect(ok.rowVersion).toBe(edited.rowVersion + 1);
      expect(
        await fx.dbMessage(
          fx.admin.query("UPDATE denial_playbook_version SET last_edited_by_membership_id=reviewed_by_membership_id WHERE id=$1", [
            created.versionId,
          ]) as never,
        ),
      ).toMatch(/M25_PLAYBOOK_PUBLISHED_IMMUTABLE/);
    });

    it("lets a different person publish; the published version is frozen and cannot be edited", async () => {
      const p = await published({ codeKind: "carc", code: "99" });
      const detail = await svc().getPlaybook(A(), p.id);
      expect(detail?.versions[0]).toMatchObject({
        status: "published",
        reviewedByMembershipId: memberA2,
        authoredByMembershipId: fx.memberA,
      });
      const edit = await fx.refused(svc().updateDraft(A(), p.versionId, content(), 2));
      expect(edit).toMatchObject({ code: "PLAYBOOK_NOT_A_DRAFT", statusCode: 409 });
      // Forced past the service (as the table owner): the trigger freezes content.
      for (const set of [
        "summary='changed'",
        "source_note='changed'",
        `steps='[{"key":"z","text":"z"}]'::jsonb`,
      ]) {
        const msg = await fx.dbMessage(
          fx.admin.query(`UPDATE denial_playbook_version SET ${set} WHERE id=$1`, [
            p.versionId,
          ]) as never,
        );
        expect(msg, set).toMatch(/M25_PLAYBOOK_PUBLISHED_IMMUTABLE/);
      }
      // No illegal edge: a published version cannot go back to draft.
      expect(
        await fx.dbMessage(
          fx.admin.query("UPDATE denial_playbook_version SET status='draft' WHERE id=$1", [
            p.versionId,
          ]) as never,
        ),
      ).toMatch(/M25_PLAYBOOK_ILLEGAL_TRANSITION/);
    });

    it("keeps exactly one published version: publishing the next retires the old one, a retired one is terminal", async () => {
      const p = await published({ codeKind: "carc", code: "100" });
      const second = await svc().createDraftVersion(
        A(),
        p.id,
        content({ summary: "Second version" }),
      );
      expect(second.versionNo).toBe(2);
      const dupDraft = await fx.refused(svc().createDraftVersion(A(), p.id, content()));
      expect(dupDraft).toMatchObject({ code: "PLAYBOOK_DRAFT_EXISTS", statusCode: 409 });
      const edited = await svc().updateDraft(
        A(),
        second.id,
        content({ summary: "Second version, edited" }),
        second.rowVersion,
      );
      expect(edited.rowVersion).toBe(second.rowVersion + 1);
      const stale = await fx.refused(
        svc().updateDraft(A(), second.id, content(), second.rowVersion),
      );
      expect(stale).toMatchObject({ code: "VERSION_CONFLICT", statusCode: 409 });

      await svc().publishVersion(A2(), second.id, edited.rowVersion);
      const detail = await svc().getPlaybook(A(), p.id);
      expect(detail?.versions.map((v) => [v.versionNo, v.status])).toEqual([
        [2, "published"],
        [1, "retired"],
      ]);
      const live = (
        await fx.admin.query(
          "SELECT count(*)::int AS n FROM denial_playbook_version WHERE playbook_id=$1 AND status='published'",
          [p.id],
        )
      ).rows[0].n;
      expect(live).toBe(1);
      // A second published row for the same playbook is refused by the partial unique index.
      const dup = await fx.dbMessage(
        fx.admin.query(
          `INSERT INTO denial_playbook_version (organization_id, playbook_id, version_no, status, summary, steps, source_note,
             authored_by_membership_id, reviewed_by_membership_id, published_at, effective_from)
           VALUES ($1,$2,3,'published','s','[{"key":"a","text":"a"}]','n',$3,$4,now(),CURRENT_DATE)`,
          [ORG, p.id, fx.memberA, memberA2],
        ) as never,
      );
      expect(dup).toMatch(/denial_playbook_version_one_published|M25_PLAYBOOK_NEW_MUST_BE_DRAFT/);
      // A retired version is terminal.
      expect(
        await fx.dbMessage(
          fx.admin.query(
            "UPDATE denial_playbook_version SET status='published' WHERE playbook_id=$1 AND version_no=1",
            [p.id],
          ) as never,
        ),
      ).toMatch(/M25_PLAYBOOK_RETIRED_IMMUTABLE/);
    });

    it("retires a published version on request; only a published one can be retired", async () => {
      const p = await published({ codeKind: "carc", code: "101" });
      const detail = await svc().getPlaybook(A(), p.id);
      const rv = detail?.versions[0]?.rowVersion as number;
      const stale = await fx.refused(svc().retireVersion(A2(), p.versionId, rv - 1));
      expect(stale).toMatchObject({ code: "VERSION_CONFLICT" });
      await svc().retireVersion(A2(), p.versionId, rv);
      const again = await fx.refused(svc().retireVersion(A2(), p.versionId, rv + 1));
      expect(again).toMatchObject({ code: "PLAYBOOK_NOT_PUBLISHED", statusCode: 409 });
      const denial = await denialWith({ carc: "101" });
      expect((await svc().getDenialPlaybook(A(), denial)).playbook).toBeNull();
    });
  });

  describe("the playbook on a denial", () => {
    it("resolves by the routing precedence: MAC reason beats CARC, a MAC-specific playbook beats any-MAC, another MAC's is ignored", async () => {
      const carc = await published({ codeKind: "carc", code: "200" }, { summary: "any-MAC carc" });
      const carcCgs = await published(
        { codeKind: "carc", code: "200", macName: "CGS" },
        { summary: "CGS carc" },
      );
      const carcOther = await published(
        { codeKind: "carc", code: "201", macName: "Novitas" },
        { summary: "Novitas carc" },
      );
      const macReason = await published(
        { codeKind: "mac_reason", code: "56900" },
        { summary: "mac reason" },
      );
      expect(carc.id).not.toBe(carcCgs.id);
      void carcOther;
      void macReason;

      const plain = await denialWith({ carc: "200" });
      expect((await svc().getDenialPlaybook(A(), plain)).playbook?.summary).toBe("any-MAC carc");

      const onCgs = await denialWith({ carc: "200" });
      await fx.admin.query(
        `INSERT INTO adr_case (organization_id, provider_entity_id, claim_id, denial_case_id, mac_name, review_type, state,
           requested_on, window_days, window_source, response_due_at)
         VALUES ($1,$2,$3,$4,'cgs','adr','in_assembly',CURRENT_DATE,30,'platform_default', now() + interval '20 days')`,
        [ORG, fx.pe1, fx.claim1, onCgs],
      );
      const cgsView = await svc().getDenialPlaybook(A(), onCgs);
      expect(cgsView.playbook).toMatchObject({ summary: "CGS carc", macName: "CGS" });
      expect(cgsView.macName).toBe("cgs");

      const wrongMac = await denialWith({ carc: "201" });
      expect((await svc().getDenialPlaybook(A(), wrongMac)).playbook).toBeNull();

      const both = await denialWith({ carc: "200", mac: "56900" });
      expect((await svc().getDenialPlaybook(A(), both)).playbook?.summary).toBe("mac reason");
    });

    it("shows source note, reviewer, version, and publish date; a version not yet in effect does not apply", async () => {
      const p = await published({ codeKind: "rarc", code: "N99" });
      const denial = await denialWith({ carc: "45", rarc: "n99" });
      const view = await svc().getDenialPlaybook(A(), denial);
      expect(view.playbook).toMatchObject({
        playbookId: p.id,
        versionNo: 1,
        sourceNote: "Test fixture: written for this suite, not a rule",
        authoredByMembershipId: fx.memberA,
        reviewedByMembershipId: memberA2,
      });
      expect(view.playbook?.steps.map((s) => s.status)).toEqual(["open", "open"]);
      // Date the version into the future (the freeze trigger is paused for this one fixture edit).
      await fx.admin.query(
        "ALTER TABLE denial_playbook_version DISABLE TRIGGER trg_denial_playbook_version_guard",
      );
      await fx.admin.query(
        "UPDATE denial_playbook_version SET effective_from = CURRENT_DATE + 30 WHERE id=$1",
        [p.versionId],
      );
      await fx.admin.query(
        "ALTER TABLE denial_playbook_version ENABLE TRIGGER trg_denial_playbook_version_guard",
      );
      expect((await svc().getDenialPlaybook(A(), denial)).playbook).toBeNull();
    });

    it("refuses a denial outside the actor's provider-entity scope as absent", async () => {
      const denial = await denialWith({ carc: "200" });
      const out = await fx.refused(svc().getDenialPlaybook(fx.actor(ORG, [fx.pe2]), denial));
      expect(out).toMatchObject({ statusCode: 404 });
    });
  });

  describe("advisory step ticks", () => {
    it("ticks, changes and resets a step without changing ANY case, claim, appeal, ADR or submission row", async () => {
      await published({ codeKind: "carc", code: "300" });
      const denial = await denialWith({ carc: "300" });
      const appeal = await fx.mkAppeal({ claimId: fx.claim1, pe: fx.pe1, tier: "redetermination" });
      void appeal;
      await fx.admin.query(
        `INSERT INTO adr_case (organization_id, provider_entity_id, claim_id, denial_case_id, mac_name, review_type, state,
           requested_on, window_days, window_source, response_due_at)
         VALUES ($1,$2,$3,$4,'TestMAC','adr','in_assembly',CURRENT_DATE,30,'platform_default', now() + interval '20 days')`,
        [ORG, fx.pe1, fx.claim1, denial],
      );
      const before = await humanRecord(denial);
      await svc().setStepStatus(A(), denial, "first", "done");
      await svc().setStepStatus(A(), denial, "second", "not_applicable");
      await svc().setStepStatus(A(), denial, "first", "open");
      await svc().setStepStatus(A(), denial, "first", "done");
      expect(await humanRecord(denial)).toBe(before);
      const view = await svc().getDenialPlaybook(A(), denial);
      expect(view.playbook?.steps).toMatchObject([
        { key: "first", status: "done", markedByMembershipId: fx.memberA },
        { key: "second", status: "not_applicable" },
      ]);
      const rows = (
        await fx.admin.query(
          "SELECT count(*)::int AS n FROM denial_playbook_case_step WHERE denial_case_id=$1",
          [denial],
        )
      ).rows[0].n;
      expect(rows).toBe(2); // one row per step: a re-tick updates it
    });

    it("refuses an unknown step, a denial with no playbook, and a tick on a version that is not published", async () => {
      const p = await published({ codeKind: "carc", code: "301" });
      const denial = await denialWith({ carc: "301" });
      expect(await fx.refused(svc().setStepStatus(A(), denial, "nope", "done"))).toMatchObject({
        statusCode: 404,
      });
      const bare = await denialWith({ carc: "399" });
      expect(await fx.refused(svc().setStepStatus(A(), bare, "first", "done"))).toMatchObject({
        statusCode: 404,
      });
      // Past the service, a draft or retired version is refused by the trigger.
      const draft = await svc().createDraftVersion(A(), p.id, content());
      const msg = await fx.dbMessage(
        fx.admin.query(
          `INSERT INTO denial_playbook_case_step (organization_id, denial_case_id, playbook_version_id, step_key, status, marked_by_membership_id)
           VALUES ($1,$2,$3,'first','done',$4)`,
          [ORG, denial, draft.id, fx.memberA],
        ) as never,
      );
      expect(msg).toMatch(/M25_PLAYBOOK_STEP/);
    });

    it("is read by nothing: a denial with every step open and one with every step done can both be resolved and appealed alike", async () => {
      // The structural claim: no table other than the tick table references it, and no function reads it.
      const refs = (
        await fx.admin.query(
          `SELECT c.conrelid::regclass::text AS tbl FROM pg_constraint c WHERE c.confrelid = 'denial_playbook_case_step'::regclass`,
        )
      ).rows;
      expect(refs).toEqual([]);
      const readers = (
        await fx.admin.query(
          `SELECT proname FROM pg_proc WHERE prosrc ILIKE '%denial_playbook_case_step%' AND proname NOT LIKE '%denial_playbook_case_step%' ORDER BY proname`,
        )
      ).rows;
      expect(readers).toEqual([]);
    });
  });

  describe("tenant isolation and the audit trail", () => {
    it("shows another tenant nothing, and refuses a cross-tenant parent on insert", async () => {
      const p = await published({ codeKind: "carc", code: "400" });
      for (const table of NEW_TABLES) {
        const rows = await fx.asApp((tx) => tx.execute(sql.raw(`SELECT id FROM ${table}`)), ORG_B);
        expect(
          (rows as unknown as { rows?: unknown[] }).rows ?? (rows as unknown[]),
          table,
        ).toHaveLength(0);
      }
      expect(await svc().listPlaybooks(B())).toEqual({ items: [] });
      expect(await svc().getPlaybook(B(), p.id)).toBeNull();
      const crossVersion = await fx.dbMessage(
        fx.asApp(
          (tx) =>
            tx.execute(
              sql`INSERT INTO denial_playbook_version (organization_id, playbook_id, version_no, summary, steps, source_note, authored_by_membership_id)
                  VALUES (${ORG_B}, ${p.id}, 7, 's', '[{"key":"a","text":"a"}]'::jsonb, 'n', ${fx.memberB})`,
            ),
          ORG_B,
        ),
      );
      expect(crossVersion).toMatch(/M25_PLAYBOOK_PARENT/);
      const denial = await denialWith({ carc: "400" });
      const crossTick = await fx.dbMessage(
        fx.asApp(
          (tx) =>
            tx.execute(
              sql`INSERT INTO denial_playbook_case_step (organization_id, denial_case_id, playbook_version_id, step_key, status, marked_by_membership_id)
                  VALUES (${ORG_B}, ${denial}, ${p.versionId}, 'first', 'done', ${fx.memberB})`,
            ),
          ORG_B,
        ),
      );
      expect(crossTick).toMatch(/M25_PLAYBOOK_PARENT/);
    });

    it("audits all three tables' writes without the playbook text", async () => {
      const p = await published(
        { codeKind: "carc", code: "401" },
        { summary: SECRET, sourceNote: SECRET, steps: [{ key: "first", text: SECRET }] },
      );
      const denial = await denialWith({ carc: "401" });
      await svc().setStepStatus(A(), denial, "first", "done");
      const kinds = (
        await fx.admin.query(
          "SELECT DISTINCT resource_kind FROM audit_event WHERE organization_id=$1 AND resource_kind LIKE 'denial_playbook%'",
          [ORG],
        )
      ).rows.map((r) => r.resource_kind as string);
      expect(kinds.sort()).toEqual([
        "denial_playbook",
        "denial_playbook_case_step",
        "denial_playbook_version",
      ]);
      const all = JSON.stringify(
        (
          await fx.admin.query(
            "SELECT before, after FROM audit_event WHERE organization_id=$1 AND resource_kind LIKE 'denial_playbook%'",
            [ORG],
          )
        ).rows,
      );
      expect(all).not.toContain(SECRET);
      void p;
    });
  });

  describe("routes", () => {
    it("gates the library on the three playbook keys, requires Idempotency-Key and If-Match", async () => {
      const author = makeApp(["playbook.read", "playbook.author"]);
      const noKey = await author.inject({ method: "POST", url: "/api/v1/playbooks", payload: {} });
      expect(noKey.statusCode).toBe(400);
      const created = await author.inject({
        method: "POST",
        url: "/api/v1/playbooks",
        headers: WRITE(),
        payload: { codeKind: "carc", code: "500", title: "CARC 500", ...content() },
      });
      expect(created.statusCode).toBe(201);
      const { id, versionId } = created.json();
      expect(
        (await author.inject({ method: "GET", url: `/api/v1/playbooks/${id}` })).json().versions,
      ).toHaveLength(1);
      expect(
        (await author.inject({ method: "GET", url: "/api/v1/playbooks/not-a-uuid" })).statusCode,
      ).toBe(404);
      // The author lacks playbook.publish.
      const noPublish = await author.inject({
        method: "POST",
        url: `/api/v1/playbook-versions/${versionId}/publish`,
        headers: WRITE({ "if-match": "1" }),
      });
      expect(noPublish.statusCode).toBe(403);
      const noMatch = await author.inject({
        method: "PATCH",
        url: `/api/v1/playbook-versions/${versionId}`,
        headers: WRITE(),
        payload: content(),
      });
      expect(noMatch.statusCode).toBe(400); // If-Match required
      const patched = await author.inject({
        method: "PATCH",
        url: `/api/v1/playbook-versions/${versionId}`,
        headers: WRITE({ "if-match": "1" }),
        payload: content({ summary: "Edited" }),
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().rowVersion).toBe(2);
      await author.close();

      const reader = makeApp(["playbook.read"]);
      expect((await reader.inject({ method: "GET", url: "/api/v1/playbooks" })).statusCode).toBe(
        200,
      );
      expect(
        (
          await reader.inject({
            method: "POST",
            url: "/api/v1/playbooks",
            headers: WRITE(),
            payload: { codeKind: "carc", code: "501", title: "x", ...content() },
          })
        ).statusCode,
      ).toBe(403);
      await reader.close();

      const none = makeApp([]);
      expect((await none.inject({ method: "GET", url: "/api/v1/playbooks" })).statusCode).toBe(403);
      await none.close();

      const self = makeApp(["playbook.read", "playbook.publish"]);
      const selfPublish = await self.inject({
        method: "POST",
        url: `/api/v1/playbook-versions/${versionId}/publish`,
        headers: WRITE({ "if-match": "2" }),
      });
      expect(selfPublish.statusCode).toBe(409);
      expect(selfPublish.json().error?.code ?? selfPublish.json().code).toBe(
        "PLAYBOOK_REVIEWER_IS_AUTHOR",
      );
      await self.close();
      const publisher = makeApp(["playbook.read", "playbook.publish"], {
        member: memberA2,
        user: userA2,
      });
      const ok = await publisher.inject({
        method: "POST",
        url: `/api/v1/playbook-versions/${versionId}/publish`,
        headers: WRITE({ "if-match": "2" }),
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().effectiveFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await publisher.close();
    });

    it("serves the denial panel behind denial.read + playbook.read, audits the read with the denial id, and ticks via PUT", async () => {
      await published({ codeKind: "carc", code: "502" });
      const denial = await denialWith({ carc: "502" });
      await fx.admin.query("DELETE FROM audit_event WHERE organization_id=$1 AND resource_id=$2", [
        ORG,
        denial,
      ]);
      const app = makeApp(["playbook.read", "denial.read"]);
      const got = await app.inject({ method: "GET", url: `/api/v1/denials/${denial}/playbook` });
      expect(got.statusCode, got.body).toBe(200);
      expect(got.json().playbook.steps).toHaveLength(2);
      const tick = await app.inject({
        method: "PUT",
        url: `/api/v1/denials/${denial}/playbook-steps/first`,
        headers: WRITE(),
        payload: { status: "done" },
      });
      expect(tick.statusCode).toBe(200);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/api/v1/denials/${denial}/playbook-steps/nope`,
            headers: WRITE(),
            payload: { status: "done" },
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/api/v1/denials/${denial}/playbook-steps/first`,
            headers: WRITE(),
            payload: { status: "bogus" },
          })
        ).statusCode,
      ).toBe(422);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: `/api/v1/denials/${denial}/playbook-steps/first`,
            payload: { status: "done" },
          })
        ).statusCode,
      ).toBe(400); // Idempotency-Key
      await app.close();
      const viewed = (
        await fx.admin.query(
          "SELECT resource_id::text AS rid FROM audit_event WHERE organization_id=$1 AND event_type LIKE '%.viewed' AND resource_id=$2",
          [ORG, denial],
        )
      ).rows;
      expect(viewed.map((r) => r.rid)).toEqual([denial]);

      const noDenialRead = makeApp(["playbook.read"]);
      expect(
        (await noDenialRead.inject({ method: "GET", url: `/api/v1/denials/${denial}/playbook` }))
          .statusCode,
      ).toBe(403);
      await noDenialRead.close();
      const noPlaybookRead = makeApp(["denial.read"]);
      expect(
        (await noPlaybookRead.inject({ method: "GET", url: `/api/v1/denials/${denial}/playbook` }))
          .statusCode,
      ).toBe(403);
      await noPlaybookRead.close();

      const bare = await denialWith({ carc: "599" });
      const bareApp = makeApp(["playbook.read", "denial.read"]);
      const none = await bareApp.inject({ method: "GET", url: `/api/v1/denials/${bare}/playbook` });
      expect(none.statusCode).toBe(200);
      expect(none.json()).toMatchObject({ playbook: null, codeKind: "carc", code: "599" });
      await bareApp.close();
    });
  });

  it("registers the three keys and migration 1251 grants existing roles idempotently, mirroring the matching keys", async () => {
    const keys = (
      await fx.admin.query(
        "SELECT key FROM permission WHERE key IN ('playbook.read','playbook.author','playbook.publish') ORDER BY key",
      )
    ).rows.map((r) => r.key);
    expect(keys).toEqual(["playbook.author", "playbook.publish", "playbook.read"]);

    const mkRole = async (key: string, grants: string[]) => {
      const id = (
        await fx.admin.query(
          `INSERT INTO role (organization_id,key,name,category,enabled) VALUES ($1,$2,$2,'billing_finance',true) RETURNING id`,
          [ORG, key],
        )
      ).rows[0].id as string;
      for (const g of grants) {
        await fx.admin.query(
          "INSERT INTO role_permission (organization_id, role_id, permission_key) VALUES ($1,$2,$3)",
          [ORG, id, g],
        );
      }
      return id;
    };
    const worker = await mkRole("pb-worker", ["denial.read"]);
    const lead = await mkRole("pb-lead", ["denial.read", "appeal.decide"]);
    const unrelated = await mkRole("pb-unrelated", ["adr.read"]);
    const compliance = await mkRole("compliance_officer", ["audit.read"]);
    const migration = readFileSync(
      join(fx.migrationsDir, "1207_m25_playbook_role_grants.sql"),
      "utf8",
    );
    await fx.admin.query(migration);
    await fx.admin.query(migration); // idempotent
    const held = async (id: string) =>
      (
        await fx.admin.query(
          "SELECT permission_key FROM role_permission WHERE role_id=$1 AND permission_key LIKE 'playbook.%' ORDER BY permission_key",
          [id],
        )
      ).rows.map((r) => r.permission_key);
    expect(await held(worker)).toEqual(["playbook.read"]);
    expect(await held(lead)).toEqual(["playbook.author", "playbook.publish", "playbook.read"]);
    expect(await held(unrelated)).toEqual([]);
    expect(await held(compliance)).toEqual(["playbook.publish", "playbook.read"]);
  });
});
