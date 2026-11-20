import { randomUUID } from "node:crypto";
/**
 * WF09 — the plan-of-care CHANGE PROPOSALS a visit records, proven against real Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * A clinician records plan changes while documenting a visit (draft); the visit's finalization releases them (the `m8.encounter.finalized`
 * consumer) onto the plan's review list (pending); the case manager or a supervisor accepts — through the very service operation the manual
 * Care Plans route runs — or dismisses. A visit never edits the signed plan.
 *
 * Proves: cross-tenant isolation (service + raw RLS); drafts invisible to everyone but their proposer; the finalized consumer releases only that
 * visit's drafts and the voided one withdraws only drafts; accept creates / changes the real element with the same `m7.*` event and
 * `added_by`; accept is idempotent; VERSION_IN_REVIEW and a discipline refusal roll the accept back and leave it pending; a vanished or
 * finished target is a clear 409; Part 2 proposals are invisible without disclosure; write audit lands with the free text scrubbed, read audit
 * lands over HTTP; the eraser removes the rows; the table's CHECKs refuse malformed rows; the visit a draft is recorded in is the caller's own
 * open note for the plan's patient (M8's `EncounterDraftReader`, faked through the seam registry); re-flagging a problem proposal re-flags its
 * goals; dismissing it dismisses them; the application role cannot rewrite a proposal's identity.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m7:change-proposals:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  createPredicateRegistry,
  registerAbacRegistry,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext, withOrgContext } from "@chartwarden/tenancy";
import type { EncounterDraftFacts, EncounterDraftReader } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { __resetSeamsForTest, registerSeam } from "../src/bootstrap/seams/registry";
import { createDrizzleCarePlanEraseStore } from "../src/modules/07-care-plan/erasers/care-plan-eraser";
import {
  type CarePlanWriteOutboxPort,
  M7_OUTBOX_EVENTS,
  type ProposalAcceptor,
  type ProposalCaller,
  buildCarePlanAbacPredicates,
  buildM7EncounterFinalizedConsumer,
  buildM7EncounterVoidedConsumer,
  createDbCarePlanAbacResolver,
  createDbCarePlanRouteService,
  createDbChangeProposalService,
  mountCarePlanRoutes,
  registerChangeProposalRoutes,
} from "../src/modules/07-care-plan/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";

interface Person {
  readonly userId: string;
  readonly membershipId: string;
  readonly org: string;
  readonly name: string;
  readonly roles: string;
}
const person = (n: number, org: string, name: string, roles: string): Person => ({
  userId: `a0000000-0000-4000-8000-00000000000${n}`,
  membershipId: `b0000000-0000-4000-8000-00000000000${n}`,
  org,
  name,
  roles,
});
/** The field RN who writes the visit note: holds only care_plan.read by default (CARE_PLAN_DEFAULT_GRANTS). */
const FIELD_RN = person(1, ORG_A, "Rae Fieldnurse (synthetic)", "rn");
/** The RN case manager: author, accepts. */
const CM = person(2, ORG_A, "Casey Manager (synthetic)", "rn,rn_case_manager");
/** A director of nursing: author, but no discipline token of their own. */
const DON = person(3, ORG_A, "Dana Supervisor (synthetic)", "director_of_nursing");
/** A second field RN, to prove a draft belongs to its proposer alone. */
const OTHER_RN = person(4, ORG_A, "Oakley Other (synthetic)", "rn");
const ORG_B_USER = person(5, ORG_B, "Bo Elsewhere (synthetic)", "rn_case_manager");
const PEOPLE = [FIELD_RN, CM, DON, OTHER_RN, ORG_B_USER];

const AUTHOR_KEYS = ["care_plan.read", "care_plan.author"];
const GRANTS: Record<string, string[]> = {
  [FIELD_RN.userId]: ["care_plan.read"],
  [OTHER_RN.userId]: ["care_plan.read"],
  [CM.userId]: AUTHOR_KEYS,
  [DON.userId]: AUTHOR_KEYS,
  [ORG_B_USER.userId]: AUTHOR_KEYS,
};

type Boot = { id: string; initialVersionId: string };
type Element = { id: string; status: string; version: number };
type Change = Record<string, unknown>;
type View = {
  id: string;
  status: string;
  kind: string;
  sudRelated: boolean;
  proposedBy: { membershipId: string; displayName: string | null };
  target: { type: string; id: string | null; label: string | null } | null;
  resultElementId: string | null;
};

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  const who = PEOPLE.find((p) => p.userId === user);
  request.context.userId = user;
  request.context.organizationId = who?.org ?? "";
  request.context.roles = who ? who.roles.split(",") : [];
  request.context.attributes.membershipId = who?.membershipId;
  const kind = request.headers["x-test-actor-kind"];
  if (typeof kind === "string") request.context.attributes.actorKind = kind;
}

describe.skipIf(!DB_URL)("M7 change proposals — LIVE Postgres (WF09)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let adminHandle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbCarePlanRouteService>;
  let proposals: ReturnType<typeof createDbChangeProposalService>;
  let outbox: CarePlanWriteOutboxPort;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
  }
  async function applyMigrations() {
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    for (const p of PEOPLE) {
      await admin.query(`INSERT INTO "user" (id,email,name) VALUES ($1,$2,$3)`, [
        p.userId,
        `${p.membershipId}@wf09.test`,
        p.name,
      ]);
      await admin.query(
        "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')",
        [p.membershipId, p.userId, p.org],
      );
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    adminHandle = createDbClient({ connectionString: DB_URL as string });
    // The REAL catalog-validating transactional publisher, pinned to caller-module `m7`, as the composition root binds it.
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M7_OUTBOX_EVENTS]));
    outbox = { publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m7" }) };
    svc = createDbCarePlanRouteService(handle.db, outbox);
    proposals = createDbChangeProposalService(handle.db, outbox);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await adminHandle?.close();
    if (admin) await admin.end();
  });

  // M8's visit facts, faked through the seam registry the service resolves per call (the registry is reset after every test, so it is re-registered
  // before each one). A test opens the visits it records in; `release` closes them the way M8's finalize does.
  const visits = new Map<string, EncounterDraftFacts>();
  const fakeVisits: EncounterDraftReader = {
    draftOf: async ({ organizationId, encounterId }) =>
      organizationId === ORG_A ? (visits.get(encounterId) ?? null) : null,
  };
  beforeEach(() => {
    visits.clear();
    registerSeam("EncounterDraftReader", fakeVisits);
  });
  afterEach(() => {
    resetAuthorizationContract();
    resetRbacEngine();
    __resetSeamsForTest();
  });

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────
  /** Run as `who` inside a request scope, so the element services' own actor GUC matches the caller (as in a real request). */
  const as = <T>(who: Person, fn: () => Promise<T>): Promise<T> =>
    runWithRequestContext({ organizationId: who.org, userId: who.userId }, fn);
  const caller = (who: Person, sud = false): ProposalCaller => ({
    userId: who.userId,
    membershipId: who.membershipId,
    sudDisclosureAllowed: sud,
  });
  const acceptor = (
    who: Person,
    opts: { sud?: boolean; disciplines?: string[]; idg?: boolean } = {},
  ): ProposalAcceptor => ({
    ...caller(who, opts.sud),
    disciplineScope: {
      disciplines: (opts.disciplines ?? ["rn"]) as never,
      isIdgCoordinator: opts.idg ?? false,
    },
  });

  async function newPlan(patientId: string = randomUUID()) {
    const boot = (await svc.bootstrapCarePlan(ORG_A, patientId, randomUUID())) as Boot;
    const terminal = (await svc.addProblem(ORG_A, boot.id, {
      description: "Terminal illness (synthetic)",
      kind: "terminal",
      source: "clinical",
    })) as Element;
    return {
      planId: boot.id,
      versionId: boot.initialVersionId,
      patientId,
      terminalId: terminal.id,
    };
  }
  /** M8 knows this visit: `who`'s own open note for the plan's patient (a visit already opened is left as it is). */
  async function openVisit(planId: string, encounterId: string, who: Person = FIELD_RN) {
    if (visits.has(encounterId)) return;
    const plan = await row("SELECT patient_id FROM care_plan WHERE id=$1", [planId]);
    visits.set(encounterId, {
      patientId: plan.patient_id as string,
      status: "draft",
      authoredByMembershipId: who.membershipId,
      templateStatesWounds: true, // M9's concern: M7 does not read it
    });
  }
  const create = async (
    planId: string,
    encounterId: string,
    change: Change,
    who: Person = FIELD_RN,
    sud = false,
  ): Promise<View> => {
    await openVisit(planId, encounterId, who);
    return as(who, () =>
      proposals.create(
        ORG_A,
        planId,
        { ...change, sourceEncounterId: encounterId } as never,
        caller(who, sud),
      ),
    ) as Promise<View>;
  };

  const finalizedEvent = (encounterId: string, extra: Record<string, unknown> = {}) => ({
    id: randomUUID(),
    organizationId: ORG_A,
    eventType: "m8.encounter.finalized",
    aggregateKind: "encounter",
    aggregateId: encounterId,
    attemptCount: 0,
    createdAt: new Date(),
    payload: {
      encounterId,
      vocabVersionId: "v1",
      layer2Involved: false,
      lateEntryTier: "none",
      ...extra,
    },
  });
  const voidedEvent = (encounterId: string) => ({
    ...finalizedEvent(encounterId),
    eventType: "m8.encounter.voided",
    payload: { encounterId, voidedBy: "x" },
  });
  /** The visit is finalized: M8 closes the note, then emits the event naming the visit's patient (a test may override or drop it via `extra`). */
  const release = (encounterId: string, extra: Record<string, unknown> = {}) => {
    const visit = visits.get(encounterId);
    if (visit) visits.set(encounterId, { ...visit, status: "finalized" });
    return buildM7EncounterFinalizedConsumer({ db: handle.db }).handle(
      finalizedEvent(encounterId, { patientId: visit?.patientId, ...extra }),
    );
  };

  /** Record a change in its own visit and finalize that visit: the proposal is `pending` on the plan. */
  async function pending(planId: string, change: Change, who: Person = FIELD_RN, sud = false) {
    const encounterId = randomUUID();
    const proposal = await create(planId, encounterId, change, who, sud);
    await release(encounterId);
    return proposal;
  }
  const accept = (planId: string, proposalId: string, who: Person = CM, opts = {}) =>
    as(who, () => proposals.accept(ORG_A, planId, proposalId, acceptor(who, opts)));

  const row = async (sql: string, params: unknown[]) => (await admin.query(sql, params)).rows[0];
  const proposalRow = (id: string) =>
    row("SELECT * FROM care_plan_change_proposal WHERE id=$1", [id]);
  const eventsFor = async (aggregateId: string): Promise<string[]> =>
    (
      await admin.query(
        "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
        [aggregateId],
      )
    ).rows.map((r) => r.event_type as string);
  const reviewList = (planId: string, sud = false) =>
    proposals.listForPlan(ORG_A, planId, { sudDisclosureAllowed: sud });
  const visitList = (patientId: string, encounterId: string, who: Person) =>
    proposals.listForPatient(ORG_A, patientId, {
      sourceEncounterId: encounterId,
      membershipId: who.membershipId,
      sudDisclosureAllowed: false,
    });

  const PROBLEM_ADD = {
    kind: "problem_add",
    description: "Dysphagia with weight loss (synthetic)",
    problemKind: "related",
    icd10Code: "R13.10",
  };

  // ── draft ──────────────────────────────────────────────────────────────────────────────────────
  describe("draft", () => {
    it("is invisible to the plan's review list and to every clinician but its proposer", async () => {
      const { planId, patientId } = await newPlan();
      const enc = randomUUID();
      const p = await create(planId, enc, PROBLEM_ADD);
      expect(p.status).toBe("draft");
      expect(p.proposedBy).toEqual({
        membershipId: FIELD_RN.membershipId,
        displayName: FIELD_RN.name,
      });

      expect((await visitList(patientId, enc, FIELD_RN)).proposals.map((x) => x.id)).toEqual([
        p.id,
      ]);
      expect((await visitList(patientId, enc, OTHER_RN)).proposals).toEqual([]);
      expect((await visitList(patientId, enc, CM)).proposals).toEqual([]);
      expect((await reviewList(planId)).proposals).toEqual([]);
      const pendingForPatient = await proposals.listForPatient(ORG_A, patientId, {
        membershipId: CM.membershipId,
        sudDisclosureAllowed: false,
      });
      expect(pendingForPatient.proposals).toEqual([]);
      // Not even a deciding supervisor can accept or dismiss a visit still being written: for them it does not exist.
      await expect(accept(planId, p.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        as(CM, () => proposals.dismiss(ORG_A, planId, p.id, {}, caller(CM))),
      ).rejects.toMatchObject({ statusCode: 404 });
      // And only the proposer may change or discard it.
      await expect(
        as(OTHER_RN, () => proposals.withdraw(ORG_A, planId, p.id, caller(OTHER_RN))),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        as(OTHER_RN, () =>
          proposals.replace(ORG_A, planId, p.id, PROBLEM_ADD as never, caller(OTHER_RN)),
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("is replaced wholesale (a new kind clears the old kind's columns) and withdrawn idempotently", async () => {
      const { planId, terminalId } = await newPlan();
      const p = await create(planId, randomUUID(), PROBLEM_ADD);
      const replaced = (await as(FIELD_RN, () =>
        proposals.replace(
          ORG_A,
          planId,
          p.id,
          {
            kind: "problem_resolve",
            problemId: terminalId,
            resolutionNote: "Resolved (synthetic)",
          } as never,
          caller(FIELD_RN),
        ),
      )) as View;
      expect(replaced).toMatchObject({
        id: p.id,
        kind: "problem_resolve",
        target: { type: "problem", id: terminalId, label: "Terminal illness (synthetic)" },
      });
      const r = await proposalRow(p.id);
      expect(r).toMatchObject({
        kind: "problem_resolve",
        target_element_id: terminalId,
        resolution_note: "Resolved (synthetic)",
        description: null,
        icd10_code: null,
        problem_kind: null,
        status: "draft",
      });

      const gone = await as(FIELD_RN, () =>
        proposals.withdraw(ORG_A, planId, p.id, caller(FIELD_RN)),
      );
      const again = await as(FIELD_RN, () =>
        proposals.withdraw(ORG_A, planId, p.id, caller(FIELD_RN)),
      );
      expect(gone).toEqual({ proposalId: p.id, status: "withdrawn" });
      expect(again).toEqual(gone);
      expect((await proposalRow(p.id)).status).toBe("withdrawn");
    });

    it("refuses an element of another plan, a missing one and a parent from another visit", async () => {
      const one = await newPlan();
      const two = await newPlan();
      const enc = randomUUID();
      // A foreign key bypasses RLS, so a uuid of another plan's problem must be refused by the application.
      await expect(
        create(one.planId, enc, { kind: "goal_add", problemId: two.terminalId, originalText: "x" }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        create(one.planId, enc, {
          kind: "problem_resolve",
          problemId: randomUUID(),
          resolutionNote: "x",
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      const parent = await create(one.planId, randomUUID(), PROBLEM_ADD);
      await expect(
        create(one.planId, enc, {
          kind: "goal_add",
          parentProposalId: parent.id,
          originalText: "x",
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      await expect(
        create(one.planId, enc, {
          kind: "goal_add",
          originalText: "x",
          problemId: one.terminalId,
          parentProposalId: parent.id,
        }),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    });

    it("withdrawing a problem proposal withdraws the goals that hang off it, and one with dependents cannot change kind", async () => {
      const { planId, terminalId } = await newPlan();
      const enc = randomUUID();
      const parent = await create(planId, enc, PROBLEM_ADD);
      const goal = await create(planId, enc, {
        kind: "goal_add",
        parentProposalId: parent.id,
        originalText: "Eat without coughing (synthetic)",
      });
      expect(goal.target).toMatchObject({
        type: "problem",
        id: null,
        label: PROBLEM_ADD.description,
      });
      await expect(
        as(FIELD_RN, () =>
          proposals.replace(
            ORG_A,
            planId,
            parent.id,
            { kind: "problem_resolve", problemId: terminalId, resolutionNote: "x" } as never,
            caller(FIELD_RN),
          ),
        ),
      ).rejects.toMatchObject({ code: "PROPOSAL_HAS_DEPENDENTS" });
      await as(FIELD_RN, () => proposals.withdraw(ORG_A, planId, parent.id, caller(FIELD_RN)));
      expect((await proposalRow(goal.id)).status).toBe("withdrawn");
    });

    it("a visit holds at most 50 live proposals", async () => {
      const { planId } = await newPlan();
      const enc = randomUUID();
      for (let i = 0; i < 50; i++) await create(planId, enc, PROBLEM_ADD);
      await expect(create(planId, enc, PROBLEM_ADD)).rejects.toMatchObject({
        code: "TOO_MANY_PROPOSALS",
        statusCode: 409,
      });
    });
  });

  // ── the visit a draft is bound to ──────────────────────────────────────────────────────────────
  describe("the visit a draft is bound to (M8's EncounterDraftReader)", () => {
    const attempt = (planId: string, encounterId: string, who: Person = FIELD_RN) =>
      as(who, () =>
        proposals.create(
          ORG_A,
          planId,
          { ...PROBLEM_ADD, sourceEncounterId: encounterId } as never,
          caller(who),
        ),
      );
    const countFor = async (planId: string): Promise<number> =>
      (
        await row(
          "SELECT count(*)::int AS n FROM care_plan_change_proposal WHERE care_plan_id=$1",
          [planId],
        )
      ).n;

    it("binds a draft only to the caller's own, still-open note for the plan's patient", async () => {
      const { planId, patientId } = await newPlan();
      const elsewhere = await newPlan();
      const mine = randomUUID();
      const colleagues = randomUUID();
      const otherPatients = randomUUID();
      visits.set(mine, {
        patientId,
        status: "draft",
        authoredByMembershipId: FIELD_RN.membershipId,
        templateStatesWounds: true,
      });
      visits.set(colleagues, {
        patientId,
        status: "draft",
        authoredByMembershipId: OTHER_RN.membershipId,
        templateStatesWounds: true,
      });
      visits.set(otherPatients, {
        patientId: elsewhere.patientId,
        status: "draft",
        authoredByMembershipId: FIELD_RN.membershipId,
        templateStatesWounds: true,
      });

      expect(await attempt(planId, mine)).toMatchObject({
        status: "draft",
        sourceEncounterId: mine,
      });
      // Someone else's note, another patient's note and a note M8 has never heard of all answer the same 404, and write nothing.
      for (const refused of [colleagues, otherPatients, randomUUID()]) {
        await expect(attempt(planId, refused)).rejects.toMatchObject({ statusCode: 404 });
      }
      expect(await countFor(planId)).toBe(1);
    });

    it("answers 409 ENCOUNTER_NOT_DRAFT to a POST after the visit was finalized, instead of stranding a draft", async () => {
      const { planId } = await newPlan();
      const enc = randomUUID();
      await create(planId, enc, PROBLEM_ADD);
      await release(enc); // M8 closes the note and the event is consumed
      await expect(attempt(planId, enc)).rejects.toMatchObject({
        code: "ENCOUNTER_NOT_DRAFT",
        statusCode: 409,
      });
      expect(await countFor(planId)).toBe(1);
      expect(
        (await row("SELECT status FROM care_plan_change_proposal WHERE care_plan_id=$1", [planId]))
          .status,
      ).toBe("pending");
    });

    it("re-checks the visit on a replace, so a draft whose note closed cannot be rewritten", async () => {
      const { planId } = await newPlan();
      const enc = randomUUID();
      const p = await create(planId, enc, PROBLEM_ADD);
      const replace = () =>
        as(FIELD_RN, () =>
          proposals.replace(
            ORG_A,
            planId,
            p.id,
            { ...PROBLEM_ADD, description: "Rewritten (synthetic)" } as never,
            caller(FIELD_RN),
          ),
        );
      await expect(replace()).resolves.toMatchObject({ id: p.id });
      const open = visits.get(enc) as EncounterDraftFacts;
      visits.set(enc, { ...open, status: "finalized" });
      await expect(replace()).rejects.toMatchObject({ code: "ENCOUNTER_NOT_DRAFT" });
      // A note that is not (or no longer) the caller's own is the same 404 as on create.
      visits.set(enc, { ...open, authoredByMembershipId: OTHER_RN.membershipId });
      await expect(replace()).rejects.toMatchObject({ statusCode: 404 });
    });

    it("counts a visit's room per plan and proposer: another clinician's rows cannot fill the author's", async () => {
      const { planId, patientId } = await newPlan();
      const enc = randomUUID();
      // 50 live proposals of OTHER_RN under this visit's id (written straight: the visit check would refuse them today).
      await admin.query(
        `INSERT INTO care_plan_change_proposal (organization_id, care_plan_id, patient_id, source_encounter_id, proposed_by_membership_id, kind, description, problem_kind, problem_source)
         SELECT $1,$2,$3,$4,$5,'problem_add','Filler '||n,'related','clinical' FROM generate_series(1,50) n`,
        [ORG_A, planId, patientId, enc, OTHER_RN.membershipId],
      );
      await expect(create(planId, enc, PROBLEM_ADD)).resolves.toMatchObject({ status: "draft" });
    });

    /** A reader whose answer for the visit changes after the first ask: the check passes, the note closes before the recheck. */
    const closesAfterTheCheck = (
      patientId: string,
      who: Person,
      closed: EncounterDraftFacts["status"],
    ): EncounterDraftReader => {
      let asked = 0;
      return {
        draftOf: async () => ({
          patientId,
          status: asked++ === 0 ? "draft" : closed,
          authoredByMembershipId: who.membershipId,
          templateStatesWounds: true,
        }),
      };
    };

    it.each([
      ["finalized", "pending"],
      ["voided", "withdrawn"],
    ] as const)(
      "moves a draft the way the lifecycle consumer would when its note was %s while it was being saved (create: %s)",
      async (closed, expected) => {
        const { planId, patientId } = await newPlan();
        registerSeam("EncounterDraftReader", closesAfterTheCheck(patientId, FIELD_RN, closed));
        const enc = randomUUID();
        const view = await as(FIELD_RN, () =>
          proposals.create(
            ORG_A,
            planId,
            { ...PROBLEM_ADD, sourceEncounterId: enc } as never,
            caller(FIELD_RN),
          ),
        );
        // Committed and already settled: the response says what the row is, and nothing is left a draft of a closed note.
        expect(view.status).toBe(expected);
        const stored = await proposalRow(view.id);
        expect(stored.status).toBe(expected);
        expect(stored.released_at === null).toBe(expected === "withdrawn");
        // The consumer's own redelivery then finds nothing left to move.
        expect(await proposals.releaseForEncounter(ORG_A, enc, { patientId })).toBe(0);
      },
    );

    it("settles a replace the same way", async () => {
      const { planId, patientId } = await newPlan();
      const enc = randomUUID();
      const p = await create(planId, enc, PROBLEM_ADD);
      registerSeam("EncounterDraftReader", closesAfterTheCheck(patientId, FIELD_RN, "finalized"));
      const replaced = await as(FIELD_RN, () =>
        proposals.replace(
          ORG_A,
          planId,
          p.id,
          { ...PROBLEM_ADD, description: "Rewritten while finalizing (synthetic)" } as never,
          caller(FIELD_RN),
        ),
      );
      expect(replaced.status).toBe("pending");
      expect(await proposalRow(p.id)).toMatchObject({
        status: "pending",
        description: "Rewritten while finalizing (synthetic)",
      });
    });

    it("leaves a draft whose consumer already ran as the consumer left it", async () => {
      const { planId, patientId } = await newPlan();
      const enc = randomUUID();
      // The consumer releases between the commit and the recheck: the recheck finds the draft already pending and reports it so.
      const reader: EncounterDraftReader = {
        draftOf: (() => {
          let asked = 0;
          return async () => {
            if (asked++ === 1) {
              await proposals.releaseForEncounter(ORG_A, enc, { patientId });
            }
            return {
              patientId,
              status: asked === 1 ? "draft" : "finalized",
              authoredByMembershipId: FIELD_RN.membershipId,
              templateStatesWounds: true,
            } as EncounterDraftFacts;
          };
        })(),
      };
      registerSeam("EncounterDraftReader", reader);
      const view = await as(FIELD_RN, () =>
        proposals.create(
          ORG_A,
          planId,
          { ...PROBLEM_ADD, sourceEncounterId: enc } as never,
          caller(FIELD_RN),
        ),
      );
      expect(view.status).toBe("pending");
      expect((await proposalRow(view.id)).status).toBe("pending");
    });

    it("serialises creates racing the cap: of several creates for the last free place, one lands and the rest are a 409", async () => {
      const { planId, patientId } = await newPlan();
      const enc = randomUUID();
      await openVisit(planId, enc, FIELD_RN);
      // 49 of the 50 places are taken (written straight, as the same proposer).
      await admin.query(
        `INSERT INTO care_plan_change_proposal (organization_id, care_plan_id, patient_id, source_encounter_id, proposed_by_membership_id, kind, description, problem_kind, problem_source)
         SELECT $1,$2,$3,$4,$5,'problem_add','Filler '||n,'related','clinical' FROM generate_series(1,49) n`,
        [ORG_A, planId, patientId, enc, FIELD_RN.membershipId],
      );
      const race = () =>
        as(FIELD_RN, () =>
          proposals.create(
            ORG_A,
            planId,
            { ...PROBLEM_ADD, sourceEncounterId: enc } as never,
            caller(FIELD_RN),
          ),
        );
      const outcomes = await Promise.allSettled([race(), race(), race(), race(), race()]);
      expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
      for (const o of outcomes.filter((x): x is PromiseRejectedResult => x.status === "rejected")) {
        expect(o.reason).toMatchObject({ code: "TOO_MANY_PROPOSALS", statusCode: 409 });
      }
      expect(
        (
          await row(
            "SELECT count(*)::int AS n FROM care_plan_change_proposal WHERE care_plan_id=$1 AND source_encounter_id=$2",
            [planId, enc],
          )
        ).n,
      ).toBe(50);
    });

    it("takes a (plan, proposer, visit) advisory lock before it counts: a create waits behind a holder of that lock", async () => {
      const { planId } = await newPlan();
      const enc = randomUUID();
      await openVisit(planId, enc, FIELD_RN);
      const key = `m7-change-proposal:${planId}:${FIELD_RN.membershipId}:${enc}`;
      await admin.query("BEGIN");
      try {
        await admin.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
        let settled = false;
        const attempt = as(FIELD_RN, () =>
          proposals.create(
            ORG_A,
            planId,
            { ...PROBLEM_ADD, sourceEncounterId: enc } as never,
            caller(FIELD_RN),
          ),
        ).finally(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(settled).toBe(false); // blocked behind the lock, not yet counting
        await admin.query("COMMIT");
        await expect(attempt).resolves.toMatchObject({ status: "draft" });
      } finally {
        await admin.query("ROLLBACK").catch(() => undefined);
      }
    });

    it("cannot make a proposal its own parent by replacing it", async () => {
      const { planId } = await newPlan();
      const p = await create(planId, randomUUID(), PROBLEM_ADD);
      await expect(
        as(FIELD_RN, () =>
          proposals.replace(
            ORG_A,
            planId,
            p.id,
            { kind: "goal_add", parentProposalId: p.id, originalText: "x" } as never,
            caller(FIELD_RN),
          ),
        ),
      ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
      expect((await proposalRow(p.id)).kind).toBe("problem_add");
    });
  });

  // ── release / withdraw by the visit's lifecycle ───────────────────────────────────────────────
  describe("the visit's lifecycle", () => {
    it("finalizing a visit releases only THAT visit's drafts, and a redelivery releases nothing more", async () => {
      const { planId, patientId } = await newPlan();
      const other = await newPlan();
      const e1 = randomUUID();
      const e2 = randomUUID();
      const a = await create(planId, e1, PROBLEM_ADD);
      const b = await create(planId, e1, { ...PROBLEM_ADD, description: "Second (synthetic)" });
      const elsewhere = await create(planId, e2, PROBLEM_ADD);
      // A draft recorded against ANOTHER patient's plan under this visit's id. The visit check refuses one today (proven below), so it is
      // written straight, as a row from before the check existed would be.
      const bogus = await row(
        `INSERT INTO care_plan_change_proposal (organization_id, care_plan_id, patient_id, source_encounter_id, proposed_by_membership_id, kind, description, problem_kind, problem_source)
         VALUES ($1,$2,$3,$4,$5,'problem_add','Bogus (synthetic)','related','clinical') RETURNING id`,
        [ORG_A, other.planId, other.patientId, e1, FIELD_RN.membershipId],
      );

      // The finalized event names the patient when it can: the release is bound to it.
      await release(e1, { patientId });
      expect((await proposalRow(a.id)).status).toBe("pending");
      expect((await proposalRow(b.id)).status).toBe("pending");
      expect((await proposalRow(a.id)).released_at).not.toBeNull();
      expect((await proposalRow(elsewhere.id)).status).toBe("draft");
      expect((await proposalRow(bogus.id)).status).toBe("draft");

      // Both pending proposals reach the review list — with the clinician and the target resolved to names.
      const review = await reviewList(planId);
      expect(review.proposals.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
      expect(review.proposals[0]).toMatchObject({
        sourceEncounterId: e1,
        proposedBy: { displayName: FIELD_RN.name },
        status: "pending",
      });

      await release(e1, { patientId });
      expect((await reviewList(planId)).proposals).toHaveLength(2);
      // An event emitted before the catalog required the patient names none: M8 is asked who the visit's patient is and the release is narrowed
      // to it, never made on the visit id alone, so the other patient's draft under the same visit id stays a draft.
      await release(e1, { patientId: undefined });
      expect((await proposalRow(bogus.id)).status).toBe("draft");
      expect((await reviewList(planId)).proposals).toHaveLength(2);
    });

    it("refuses (to retry, into the DLQ) a finalized event that names no patient for a visit M8 does not know, and releases nothing", async () => {
      const { planId } = await newPlan();
      const enc = randomUUID();
      const p = await create(planId, enc, PROBLEM_ADD);
      visits.delete(enc); // M8 cannot answer for it
      await expect(release(enc, { patientId: undefined })).rejects.toThrow(
        /M8 does not know visit/,
      );
      expect((await proposalRow(p.id)).status).toBe("draft");
    });

    it("never moves a decided proposal, and the voided event withdraws drafts only", async () => {
      const { planId } = await newPlan();
      const accepted = await pending(planId, PROBLEM_ADD);
      await accept(planId, accepted.id);
      const dismissed = await pending(planId, { ...PROBLEM_ADD, description: "Other (synthetic)" });
      await as(CM, () =>
        proposals.dismiss(ORG_A, planId, dismissed.id, { reason: "duplicate" }, caller(CM)),
      );
      const stillPending = await pending(planId, {
        ...PROBLEM_ADD,
        description: "Third (synthetic)",
      });

      const encDraft = randomUUID();
      const draft = await create(planId, encDraft, PROBLEM_ADD);
      await buildM7EncounterVoidedConsumer({ db: handle.db }).handle(voidedEvent(encDraft));
      expect((await proposalRow(draft.id)).status).toBe("withdrawn");

      // A void naming a visit whose proposals were already released and decided changes none of them.
      for (const p of [accepted, dismissed, stillPending]) {
        await buildM7EncounterVoidedConsumer({ db: handle.db }).handle(
          voidedEvent((await proposalRow(p.id)).source_encounter_id),
        );
        await release((await proposalRow(p.id)).source_encounter_id);
      }
      expect((await proposalRow(accepted.id)).status).toBe("accepted");
      expect((await proposalRow(dismissed.id)).status).toBe("dismissed");
      expect((await proposalRow(stillPending.id)).status).toBe("pending");
    });
  });

  // ── accept applies the change through the manual route's own operation ───────────────────────
  describe("accept", () => {
    it("problem_add creates the real problem (author = the accepter, m7.problem.added) once, however often it is accepted", async () => {
      const { planId } = await newPlan();
      const p = await pending(planId, { ...PROBLEM_ADD, onsetAt: "2026-11-01T00:00:00.000Z" });
      const first = await accept(planId, p.id);
      expect(first).toMatchObject({ status: "accepted", resultElementType: "problem" });

      const problem = await row("SELECT * FROM problem WHERE id=$1", [first.resultElementId]);
      expect(problem).toMatchObject({
        care_plan_id: planId,
        description: PROBLEM_ADD.description,
        kind: "related",
        source: "clinical",
        status: "active",
        icd10_code: "R13.10",
        added_by_membership_id: CM.membershipId,
        sud_related: false,
      });
      expect(await eventsFor(first.resultElementId)).toEqual(["m7.problem.added"]);
      const stamped = await proposalRow(p.id);
      expect(stamped).toMatchObject({
        status: "accepted",
        result_element_id: first.resultElementId,
        decided_by_membership_id: CM.membershipId,
      });

      // Idempotent: the same body, no second problem, no second event — from the same or a different reviewer.
      expect(await accept(planId, p.id)).toEqual(first);
      expect(await accept(planId, p.id, DON, { disciplines: [] })).toEqual(first);
      const n = await row(
        "SELECT count(*)::int AS n FROM problem WHERE care_plan_id=$1 AND description=$2",
        [planId, PROBLEM_ADD.description],
      );
      expect(n.n).toBe(1);
      expect(await eventsFor(first.resultElementId)).toEqual(["m7.problem.added"]);
      // The accepted proposal is on the history list, not the pending one.
      expect((await reviewList(planId)).proposals.map((x) => x.id)).not.toContain(p.id);
      expect(
        (
          await proposals.listForPlan(ORG_A, planId, {
            status: "accepted",
            sudDisclosureAllowed: false,
          })
        ).proposals,
      ).toMatchObject([
        { id: p.id, decidedBy: { displayName: CM.name }, resultElementId: first.resultElementId },
      ]);
    });

    it("problem_resolve, goal_add, goal_update, intervention_add and intervention_discontinue change the plan like the manual routes", async () => {
      const { planId, terminalId } = await newPlan();
      const related = (await svc.addProblem(ORG_A, planId, {
        description: "Constipation (synthetic)",
        kind: "related",
        source: "clinical",
      })) as Element;

      // goal_add (existing problem) → goal_update → goal status moved through the §2.2.3 machine
      const goalAdd = await pending(planId, {
        kind: "goal_add",
        problemId: terminalId,
        originalText: "Stay comfortable at home (synthetic)",
        goalSource: "patient_stated",
        measurableOutcome: "Pain 3 or below (synthetic)",
      });
      const g = await accept(planId, goalAdd.id);
      expect(g.resultElementType).toBe("goal");
      const goal = await row("SELECT * FROM goal WHERE id=$1", [g.resultElementId]);
      expect(goal).toMatchObject({
        problem_id: terminalId,
        original_text: "Stay comfortable at home (synthetic)",
        source: "patient_stated",
        status: "not_started",
        measurable_outcome: "Pain 3 or below (synthetic)",
        added_by_membership_id: CM.membershipId,
      });
      expect(await eventsFor(g.resultElementId)).toEqual(["m7.goal.added"]);

      const goalUpdate = await pending(planId, {
        kind: "goal_update",
        goalId: g.resultElementId,
        goalStatus: "in_progress",
        revisedText: "Stay comfortable at home and eat daily (synthetic)",
      });
      expect(goalUpdate.target).toMatchObject({
        type: "goal",
        label: "Stay comfortable at home (synthetic)",
      });
      await accept(planId, goalUpdate.id);
      expect(
        await row("SELECT status,revised_text FROM goal WHERE id=$1", [g.resultElementId]),
      ).toEqual({
        status: "in_progress",
        revised_text: "Stay comfortable at home and eat daily (synthetic)",
      });
      expect(await eventsFor(g.resultElementId)).toContain("m7.goal.updated");

      // intervention_add → intervention_discontinue
      const intAdd = await pending(planId, {
        kind: "intervention_add",
        problemId: related.id,
        goalRefs: [g.resultElementId],
        scopeText: "Bowel regimen review (synthetic)",
        frequencyText: "weekly",
        frequencyValue: "1:visit:week",
        discipline: "rn",
      });
      const i = await accept(planId, intAdd.id);
      expect(i.resultElementType).toBe("intervention");
      expect(
        await row(
          "SELECT problem_id,discipline,status,goal_refs,added_by_membership_id FROM intervention WHERE id=$1",
          [i.resultElementId],
        ),
      ).toEqual({
        problem_id: related.id,
        discipline: "rn",
        status: "active",
        goal_refs: [g.resultElementId],
        added_by_membership_id: CM.membershipId,
      });
      expect(await eventsFor(i.resultElementId)).toEqual(["m7.intervention.added"]);

      const stop = await pending(planId, {
        kind: "intervention_discontinue",
        interventionId: i.resultElementId,
        reason: "Resolved with diet change (synthetic)",
      });
      await accept(planId, stop.id);
      expect(
        await row("SELECT status,discontinue_reason FROM intervention WHERE id=$1", [
          i.resultElementId,
        ]),
      ).toEqual({
        status: "discontinued",
        discontinue_reason: "Resolved with diet change (synthetic)",
      });
      expect(await eventsFor(i.resultElementId)).toContain("m7.intervention.discontinued");

      // problem_resolve
      const resolve = await pending(planId, {
        kind: "problem_resolve",
        problemId: related.id,
        resolutionNote: "Bowels regular (synthetic)",
      });
      const rr = await accept(planId, resolve.id);
      expect(rr).toMatchObject({ resultElementType: "problem", resultElementId: related.id });
      expect(
        await row("SELECT status,resolution_note FROM problem WHERE id=$1", [related.id]),
      ).toEqual({ status: "resolved", resolution_note: "Bowels regular (synthetic)" });
      expect(await eventsFor(related.id)).toContain("m7.problem.resolved");
    });

    it("a goal and an intervention on a problem proposed in the same visit wait for that problem to be accepted", async () => {
      const { planId } = await newPlan();
      const enc = randomUUID();
      const parent = await create(planId, enc, PROBLEM_ADD);
      const goal = await create(planId, enc, {
        kind: "goal_add",
        parentProposalId: parent.id,
        originalText: "Eat without coughing (synthetic)",
      });
      await release(enc);

      await expect(accept(planId, goal.id)).rejects.toMatchObject({
        code: "PROPOSAL_PARENT_NOT_ACCEPTED",
        statusCode: 409,
      });
      expect((await proposalRow(goal.id)).status).toBe("pending");

      const problem = await accept(planId, parent.id);
      const accepted = await accept(planId, goal.id);
      expect(
        (await row("SELECT problem_id FROM goal WHERE id=$1", [accepted.resultElementId]))
          .problem_id,
      ).toBe(problem.resultElementId);
    });

    it("runs under the accepter's own discipline scope: a refusal rolls the accept back and leaves it pending", async () => {
      const { planId, terminalId } = await newPlan();
      const p = await pending(planId, {
        kind: "intervention_add",
        problemId: terminalId,
        scopeText: "Grief counselling (synthetic)",
        frequencyText: "weekly",
        frequencyValue: "1:visit:week",
        discipline: "msw",
      });
      await expect(accept(planId, p.id, CM, { disciplines: ["rn"] })).rejects.toMatchObject({
        code: "DISCIPLINE_SCOPE_VIOLATION",
        statusCode: 403,
      });
      expect(await proposalRow(p.id)).toMatchObject({
        status: "pending",
        decided_at: null,
        result_element_id: null,
      });
      expect(
        (await row("SELECT count(*)::int AS n FROM intervention WHERE care_plan_id=$1", [planId]))
          .n,
      ).toBe(0);
      // The IDG coordinator is the lone cross-discipline exception, exactly as on the manual route.
      await expect(accept(planId, p.id, CM, { idg: true })).resolves.toMatchObject({
        status: "accepted",
      });
    });

    it("answers VERSION_IN_REVIEW 409 and keeps the proposal pending until the version returns to draft", async () => {
      const { planId, versionId } = await newPlan();
      const p = await pending(planId, PROBLEM_ADD);
      const finalized = (await svc.finalizeVersion(ORG_A, planId, versionId, 1, null)) as {
        status: string;
        version: number;
      };
      expect(finalized.status).toBe("in_review");

      await expect(accept(planId, p.id)).rejects.toMatchObject({
        code: "VERSION_IN_REVIEW",
        statusCode: 409,
      });
      expect(await proposalRow(p.id)).toMatchObject({
        status: "pending",
        decided_at: null,
        result_element_id: null,
      });
      expect(
        (await row("SELECT count(*)::int AS n FROM problem WHERE care_plan_id=$1", [planId])).n,
      ).toBe(1);
      expect((await reviewList(planId)).proposals.map((x) => x.id)).toEqual([p.id]);
      // Dismissing writes no element, so it is allowed while a version is in review.

      await svc.returnVersionToDraft(ORG_A, planId, versionId, finalized.version);
      await expect(accept(planId, p.id)).resolves.toMatchObject({ status: "accepted" });
    });

    it("a target that is gone or already finished is a clear 409 and the proposal stays pending", async () => {
      const { planId } = await newPlan();
      const related = (await svc.addProblem(ORG_A, planId, {
        description: "Nausea (synthetic)",
        kind: "related",
        source: "clinical",
      })) as Element;
      const p = await pending(planId, {
        kind: "problem_resolve",
        problemId: related.id,
        resolutionNote: "Resolved at the visit (synthetic)",
      });
      // Someone resolves it by hand before the proposal is decided.
      await svc.resolveProblem(
        ORG_A,
        planId,
        related.id,
        related.version,
        "Resolved by hand (synthetic)",
      );
      await expect(accept(planId, p.id)).rejects.toMatchObject({
        code: "PROPOSAL_TARGET_UNAVAILABLE",
        statusCode: 409,
      });
      expect((await proposalRow(p.id)).status).toBe("pending");

      // A target that no longer exists at all.
      const vanished = (await svc.addProblem(ORG_A, planId, {
        description: "Itching (synthetic)",
        kind: "related",
        source: "clinical",
      })) as Element;
      const onVanished = await pending(planId, {
        kind: "goal_add",
        problemId: vanished.id,
        originalText: "Keep food down (synthetic)",
      });
      await admin.query("DELETE FROM problem WHERE id=$1", [vanished.id]);
      await expect(accept(planId, onVanished.id)).rejects.toMatchObject({
        code: "PROPOSAL_TARGET_UNAVAILABLE",
        statusCode: 409,
      });
      // A proposal that cannot be applied can still be dismissed, with a coded reason, and a dismissal is idempotent.
      const dismissed = await as(CM, () =>
        proposals.dismiss(ORG_A, planId, p.id, { reason: "already_addressed" }, caller(CM)),
      );
      expect(dismissed).toMatchObject({
        status: "dismissed",
        dismissalReason: "already_addressed",
      });
      expect(
        await as(CM, () =>
          proposals.dismiss(ORG_A, planId, p.id, { reason: "duplicate" }, caller(CM)),
        ),
      ).toEqual(dismissed);
      await expect(accept(planId, p.id)).rejects.toMatchObject({
        code: "PROPOSAL_NOT_PENDING",
        statusCode: 409,
      });
      const live = await pending(planId, PROBLEM_ADD);
      await accept(planId, live.id);
      await expect(
        as(CM, () => proposals.dismiss(ORG_A, planId, live.id, {}, caller(CM))),
      ).rejects.toMatchObject({ code: "PROPOSAL_NOT_PENDING" });
    });
  });

  // ── dismissing a problem proposal takes its goals and interventions with it ──────────────────────
  describe("dismiss", () => {
    const withChildren = async (planId: string) => {
      const enc = randomUUID();
      const parent = await create(planId, enc, PROBLEM_ADD);
      const goal = await create(planId, enc, {
        kind: "goal_add",
        parentProposalId: parent.id,
        originalText: "Eat without coughing (synthetic)",
      });
      const intervention = await create(planId, enc, {
        kind: "intervention_add",
        parentProposalId: parent.id,
        scopeText: "Thickened fluids (synthetic)",
        frequencyText: "weekly",
        frequencyValue: "1:visit:week",
        discipline: "rn",
      });
      await release(enc);
      return { parent, goal, intervention };
    };

    it("dismisses the pending goals and interventions of a dismissed problem, for the same reason and by the same decider, and nothing else", async () => {
      const { planId } = await newPlan();
      const { parent, goal, intervention } = await withChildren(planId);
      const bystander = await pending(planId, { ...PROBLEM_ADD, description: "Other (synthetic)" });

      const out = await as(CM, () =>
        proposals.dismiss(ORG_A, planId, parent.id, { reason: "duplicate" }, caller(CM)),
      );
      expect(out).toMatchObject({ status: "dismissed", dismissalReason: "duplicate" });

      const parentRow = await proposalRow(parent.id);
      for (const id of [goal.id, intervention.id]) {
        const child = await proposalRow(id);
        expect(child).toMatchObject({
          status: "dismissed",
          dismissal_reason: "duplicate",
          decided_by_membership_id: CM.membershipId,
        });
        expect(child.decided_at).toEqual(parentRow.decided_at);
      }
      expect((await proposalRow(bystander.id)).status).toBe("pending");
      // The review list no longer carries children waiting on a problem that will never exist.
      expect((await reviewList(planId)).proposals.map((x) => x.id)).toEqual([bystander.id]);
      // Accepting one of them is not "accept the problem first": it was already decided.
      await expect(accept(planId, goal.id)).rejects.toMatchObject({
        code: "PROPOSAL_NOT_PENDING",
        statusCode: 409,
      });
    });

    it("leaves an accepted problem's children alone: dismissing a child never touches its parent", async () => {
      const { planId } = await newPlan();
      const { parent, goal, intervention } = await withChildren(planId);
      await accept(planId, parent.id);
      await as(CM, () => proposals.dismiss(ORG_A, planId, goal.id, {}, caller(CM)));
      expect((await proposalRow(parent.id)).status).toBe("accepted");
      expect((await proposalRow(intervention.id)).status).toBe("pending");
    });

    it("names the truth when a child is still pending under a dismissed problem (a row from before the cascade)", async () => {
      const { planId } = await newPlan();
      const { parent } = await withChildren(planId);
      await as(CM, () => proposals.dismiss(ORG_A, planId, parent.id, {}, caller(CM)));
      // Migration 1530 makes a dismissed row final (nothing can un-dismiss a child), so the older row is written straight: pending, under it.
      const old = await row(
        `INSERT INTO care_plan_change_proposal (organization_id, care_plan_id, patient_id, source_encounter_id, proposed_by_membership_id, kind, parent_proposal_id,
           goal_text, goal_source, status, released_at)
         SELECT organization_id, care_plan_id, patient_id, source_encounter_id, proposed_by_membership_id, 'goal_add', id, 'Older goal (synthetic)', 'clinical', 'pending', now()
           FROM care_plan_change_proposal WHERE id=$1 RETURNING id`,
        [parent.id],
      );
      await expect(accept(planId, old.id)).rejects.toMatchObject({
        code: "PROPOSAL_PARENT_DISMISSED",
        statusCode: 409,
      });
      expect((await proposalRow(old.id)).status).toBe("pending");
    });
  });

  // ── a long decided history is capped ───────────────────────────────────────────────────────────
  describe("list size", () => {
    it("returns at most the newest 200 proposals of a long decided history, oldest first", async () => {
      const { planId, patientId } = await newPlan();
      await admin.query(
        `INSERT INTO care_plan_change_proposal
           (organization_id, care_plan_id, patient_id, source_encounter_id, proposed_by_membership_id, kind, description, problem_kind, problem_source,
            status, released_at, decided_by_membership_id, decided_at, dismissal_reason, created_at)
         SELECT $1,$2,$3,gen_random_uuid(),$4,'problem_add','History '||n,'related','clinical',
                'dismissed', now(), $5, now(), 'duplicate', now() - make_interval(secs => 1000 - n)
           FROM generate_series(1,205) n`,
        [ORG_A, planId, patientId, FIELD_RN.membershipId, CM.membershipId],
      );
      const newest = (
        await admin.query(
          `SELECT id FROM care_plan_change_proposal WHERE care_plan_id=$1 ORDER BY created_at DESC, id DESC LIMIT 200`,
          [planId],
        )
      ).rows
        .map((r) => r.id as string)
        .reverse();

      const byPlan = await proposals.listForPlan(ORG_A, planId, {
        status: "dismissed",
        sudDisclosureAllowed: false,
      });
      expect(byPlan.proposals.map((x) => x.id)).toEqual(newest);
      const byPatient = await proposals.listForPatient(ORG_A, patientId, {
        status: "dismissed",
        membershipId: CM.membershipId,
        sudDisclosureAllowed: false,
      });
      expect(byPatient.proposals.map((x) => x.id)).toEqual(newest);
    });
  });

  // ── 42 CFR Part 2 ──────────────────────────────────────────────────────────────────────────────
  describe("Part 2 (§7.6)", () => {
    it("a Part 2 proposal is invisible, undecidable and un-targetable without disclosure", async () => {
      const { planId, patientId } = await newPlan();
      const sudText = "SYNTHETIC-PART2-PROPOSAL";
      const p = await pending(planId, { ...PROBLEM_ADD, description: sudText, sudRelated: true });
      const plain = await pending(planId, { ...PROBLEM_ADD, description: "Plain (synthetic)" });
      expect(p.sudRelated).toBe(true);

      const hidden = await reviewList(planId, false);
      expect(hidden.proposals.map((x) => x.id)).toEqual([plain.id]);
      expect(hidden.redacted).toBe(true);
      expect(JSON.stringify(hidden)).not.toContain(sudText);
      const visible = await reviewList(planId, true);
      expect(visible.proposals.map((x) => x.id).sort()).toEqual([p.id, plain.id].sort());
      expect(visible.redacted).toBe(false);
      const byPatient = await proposals.listForPatient(ORG_A, patientId, {
        membershipId: CM.membershipId,
        sudDisclosureAllowed: false,
      });
      expect(byPatient.proposals.map((x) => x.id)).toEqual([plain.id]);
      expect(byPatient.redacted).toBe(true);

      await expect(accept(planId, p.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        as(CM, () => proposals.dismiss(ORG_A, planId, p.id, {}, caller(CM))),
      ).rejects.toMatchObject({ statusCode: 404 });
      const done = await accept(planId, p.id, CM, { sud: true });
      expect(
        (await row("SELECT sud_related FROM problem WHERE id=$1", [done.resultElementId]))
          .sud_related,
      ).toBe(true);
    });

    it("copies the flag from the problem a goal touches, and answers 404 for one the caller may not see", async () => {
      const { planId } = await newPlan();
      const sud = (await svc.addProblem(ORG_A, planId, {
        description: "SYNTHETIC-PART2-PROBLEM",
        kind: "related",
        source: "clinical",
        sudRelated: true,
      })) as Element;
      await expect(
        create(
          planId,
          randomUUID(),
          { kind: "goal_add", problemId: sud.id, originalText: "x" },
          FIELD_RN,
          false,
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      const g = await create(
        planId,
        randomUUID(),
        { kind: "goal_add", problemId: sud.id, originalText: "Attend group (synthetic)" },
        FIELD_RN,
        true,
      );
      expect(g.sudRelated).toBe(true);

      const goal = (await svc.addGoal(
        ORG_A,
        planId,
        { problemId: sud.id, originalText: "Stay in recovery (synthetic)", source: "clinical" },
        false,
      )) as Element;
      await expect(
        create(
          planId,
          randomUUID(),
          { kind: "goal_update", goalId: goal.id, goalStatus: "in_progress" },
          FIELD_RN,
          false,
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
    });

    it("re-flags the goals under a problem proposal when the problem is re-flagged, so a caller without disclosure sees neither", async () => {
      const { planId } = await newPlan();
      const enc = randomUUID();
      const sudText = "SYNTHETIC-PART2-REFLAGGED-PROBLEM";
      const parent = await create(planId, enc, PROBLEM_ADD);
      const goal = await create(planId, enc, {
        kind: "goal_add",
        parentProposalId: parent.id,
        originalText: "Attend group (synthetic)",
      });
      expect(goal.sudRelated).toBe(false);

      const replaced = (await as(FIELD_RN, () =>
        proposals.replace(
          ORG_A,
          planId,
          parent.id,
          { ...PROBLEM_ADD, description: sudText, sudRelated: true } as never,
          caller(FIELD_RN),
        ),
      )) as View;
      expect(replaced.sudRelated).toBe(true);
      expect((await proposalRow(goal.id)).sud_related).toBe(true);
      await release(enc);

      const hidden = await reviewList(planId, false);
      expect(hidden.proposals).toEqual([]);
      expect(hidden.redacted).toBe(true);
      expect(JSON.stringify(hidden)).not.toContain(sudText);
      const visible = await reviewList(planId, true);
      expect(visible.proposals.map((x) => x.id).sort()).toEqual([parent.id, goal.id].sort());
      expect(visible.proposals.find((x) => x.id === goal.id)?.target?.label).toBe(sudText);
    });

    it("clears the flag again when the problem proposal is re-flagged off", async () => {
      const { planId } = await newPlan();
      const enc = randomUUID();
      const parent = await create(planId, enc, { ...PROBLEM_ADD, sudRelated: true });
      const goal = await create(
        planId,
        enc,
        { kind: "goal_add", parentProposalId: parent.id, originalText: "x" },
        FIELD_RN,
        true,
      );
      expect(goal.sudRelated).toBe(true);
      await as(FIELD_RN, () =>
        proposals.replace(ORG_A, planId, parent.id, PROBLEM_ADD as never, caller(FIELD_RN, true)),
      );
      expect((await proposalRow(goal.id)).sud_related).toBe(false);
    });

    it("answers a hidden Part 2 element with the id the caller SENT, never the Part 2 problem's id", async () => {
      const { planId } = await newPlan();
      const sud = (await svc.addProblem(ORG_A, planId, {
        description: "SYNTHETIC-PART2-PROBLEM-ID",
        kind: "related",
        source: "clinical",
        sudRelated: true,
      })) as Element;
      const goal = (await svc.addGoal(
        ORG_A,
        planId,
        { problemId: sud.id, originalText: "Stay in recovery (synthetic)", source: "clinical" },
        false,
      )) as Element;
      const intervention = (await svc.addIntervention(ORG_A, planId, {
        problemId: sud.id,
        scopeText: "Peer support (synthetic)",
        frequencyText: "weekly",
        frequencyValue: "1:visit:week",
        discipline: "rn",
      })) as Element;
      const targeted = [
        { kind: "goal_update", goalId: goal.id, goalStatus: "in_progress" },
        { kind: "intervention_discontinue", interventionId: intervention.id, reason: "x" },
        { kind: "problem_resolve", problemId: sud.id, resolutionNote: "x" },
      ];
      for (const change of targeted) {
        const sent = Object.values(change).find(
          (v) => v === goal.id || v === intervention.id || v === sud.id,
        );
        const refused = await create(planId, randomUUID(), change, FIELD_RN, false).then(
          () => null,
          (e: { statusCode?: number; message?: string }) => e,
        );
        expect(refused?.statusCode).toBe(404);
        // The message names what was sent, and the hidden problem's id appears only when it was the thing sent.
        expect(refused?.message).toContain(sent as string);
        if (sent !== sud.id) expect(refused?.message).not.toContain(sud.id);
      }
    });

    it("answers a goal under a hidden Part 2 problem exactly as a missing goal when a proposal links it (and flags the proposal when disclosed)", async () => {
      const { planId, terminalId } = await newPlan();
      const sud = (await svc.addProblem(ORG_A, planId, {
        description: "SYNTHETIC-PART2-LINK",
        kind: "related",
        source: "clinical",
        sudRelated: true,
      })) as Element;
      const hiddenGoal = (await svc.addGoal(
        ORG_A,
        planId,
        { problemId: sud.id, originalText: "Hidden goal (synthetic)", source: "clinical" },
        false,
      )) as Element;
      const plainGoal = (await svc.addGoal(
        ORG_A,
        planId,
        { problemId: terminalId, originalText: "Plain goal (synthetic)", source: "clinical" },
        false,
      )) as Element;
      const link = (goalRefs: string[], sudAllowed: boolean) =>
        create(
          planId,
          randomUUID(),
          {
            kind: "intervention_add",
            problemId: terminalId,
            goalRefs,
            scopeText: "Reassess (synthetic)",
            frequencyText: "weekly",
            frequencyValue: "1:visit:week",
            discipline: "rn",
          },
          FIELD_RN,
          sudAllowed,
        );
      const refusal = async (goalRefs: string[]) =>
        link(goalRefs, false).then(
          () => null,
          (e: { statusCode?: number; code?: string; message?: string }) => e,
        );
      // Same status, same code and same message shape for a hidden goal and one that does not exist.
      const hidden = await refusal([hiddenGoal.id]);
      const missing = await refusal([randomUUID()]);
      expect(hidden).toMatchObject({ statusCode: 404, code: missing?.code });
      expect(hidden?.message).toBe(`goal ${hiddenGoal.id} not found`);
      expect(missing?.message).toMatch(/^goal [0-9a-f-]{36} not found$/);
      // A goal that is not Part 2 still links; a caller with disclosure may link the hidden one, and the proposal is then Part 2 itself.
      expect((await link([plainGoal.id], false)).sudRelated).toBe(false);
      const disclosed = await link([hiddenGoal.id], true);
      expect(disclosed.sudRelated).toBe(true);
      expect((await reviewList(planId, false)).proposals.map((x) => x.id)).not.toContain(
        disclosed.id,
      );
    });

    it("answers a goal under a hidden Part 2 problem as a missing goal on the manual intervention route's service too", async () => {
      const { planId, terminalId } = await newPlan();
      const sud = (await svc.addProblem(ORG_A, planId, {
        description: "SYNTHETIC-PART2-MANUAL",
        kind: "related",
        source: "clinical",
        sudRelated: true,
      })) as Element;
      const hiddenGoal = (await svc.addGoal(
        ORG_A,
        planId,
        { problemId: sud.id, originalText: "Hidden goal (synthetic)", source: "clinical" },
        false,
      )) as Element;
      const plainGoal = (await svc.addGoal(
        ORG_A,
        planId,
        { problemId: terminalId, originalText: "Plain goal (synthetic)", source: "clinical" },
        false,
      )) as Element;
      const add = (goalRefs: string[], viewer?: { sudDisclosureAllowed: boolean }) =>
        svc.addIntervention(
          ORG_A,
          planId,
          {
            problemId: terminalId,
            goalRefs,
            scopeText: "Reassess (synthetic)",
            frequencyText: "weekly",
            frequencyValue: "1:visit:week",
            discipline: "rn",
          },
          undefined,
          undefined,
          viewer as never,
        );
      // No disclosure, and no viewer at all (the fail-closed default): the hidden goal is a 404 with the same words as a missing one.
      for (const viewer of [{ sudDisclosureAllowed: false }, undefined]) {
        await expect(add([hiddenGoal.id], viewer)).rejects.toMatchObject({
          statusCode: 404,
          message: `goal ${hiddenGoal.id} not found`,
        });
      }
      await expect(add([randomUUID()], { sudDisclosureAllowed: false })).rejects.toMatchObject({
        statusCode: 404,
      });
      // A goal that is not Part 2 links; with disclosure so does the hidden one.
      await expect(add([plainGoal.id], { sudDisclosureAllowed: false })).resolves.toMatchObject({
        status: "active",
      });
      await expect(add([hiddenGoal.id], { sudDisclosureAllowed: true })).resolves.toMatchObject({
        status: "active",
      });
    });

    it("never labels a visible goal with a Part 2 parent's text for a caller without disclosure", async () => {
      const { planId } = await newPlan();
      const enc = randomUUID();
      const sudText = "SYNTHETIC-PART2-PARENT-LABEL";
      const parent = await create(planId, enc, { ...PROBLEM_ADD, description: sudText });
      const goal = await create(planId, enc, {
        kind: "goal_add",
        parentProposalId: parent.id,
        originalText: "Attend group (synthetic)",
      });
      await release(enc);
      // A row from before the cascade: the parent is Part 2 while the goal still carries `false`.
      await admin.query("UPDATE care_plan_change_proposal SET sud_related=true WHERE id=$1", [
        parent.id,
      ]);

      const hidden = await reviewList(planId, false);
      expect(hidden.proposals.map((x) => x.id)).toEqual([goal.id]);
      expect(hidden.proposals[0]?.target).toMatchObject({ type: "problem", id: null, label: null });
      expect(JSON.stringify(hidden)).not.toContain(sudText);
      const visible = await reviewList(planId, true);
      expect(visible.proposals.find((x) => x.id === goal.id)?.target?.label).toBe(sudText);
    });
  });

  // ── isolation ──────────────────────────────────────────────────────────────────────────────────
  describe("tenant isolation", () => {
    it("another organization sees, decides and writes nothing of this one's proposals", async () => {
      const { planId, patientId } = await newPlan();
      const p = await pending(planId, PROBLEM_ADD);
      const asB = (fn: () => Promise<unknown>) =>
        runWithRequestContext({ organizationId: ORG_B, userId: ORG_B_USER.userId }, fn);

      await expect(
        proposals.listForPlan(ORG_B, planId, { sudDisclosureAllowed: true }),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect(
        (
          await proposals.listForPatient(ORG_B, patientId, {
            membershipId: ORG_B_USER.membershipId,
            sudDisclosureAllowed: true,
          })
        ).proposals,
      ).toEqual([]);
      await expect(
        asB(() => proposals.accept(ORG_B, planId, p.id, acceptor(ORG_B_USER, { sud: true }))),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        asB(() => proposals.dismiss(ORG_B, planId, p.id, {}, caller(ORG_B_USER, true))),
      ).rejects.toMatchObject({ statusCode: 404 });
      expect((await proposalRow(p.id)).status).toBe("pending");

      // Straight SQL as the NOBYPASSRLS app role: org B's scope reads none, and cannot write a row into org A.
      const rawRead = await withOrgContext(
        handle.db,
        { organizationId: ORG_B, userId: "" },
        async (tx) => {
          const { sql } = await import("drizzle-orm");
          const res = await (
            tx as unknown as { execute: (q: unknown) => Promise<{ rows: { n: number }[] }> }
          ).execute(sql`SELECT count(*)::int AS n FROM care_plan_change_proposal`);
          return res.rows[0]?.n;
        },
      );
      expect(rawRead).toBe(0);
      const rawWrite = withOrgContext(
        handle.db,
        { organizationId: ORG_B, userId: "" },
        async (tx) => {
          const { sql } = await import("drizzle-orm");
          await (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
            sql`INSERT INTO care_plan_change_proposal (organization_id, care_plan_id, patient_id, source_encounter_id, kind, description, problem_kind, problem_source, proposed_by_membership_id)
              SELECT ${ORG_A}::uuid, ${planId}::uuid, ${patientId}::uuid, ${randomUUID()}::uuid, 'problem_add', 'x', 'related', 'clinical', ${CM.membershipId}::uuid`,
          );
        },
      );
      // drizzle wraps the driver error: the database's own refusal is its `cause`.
      const refused = await rawWrite.then(
        () => null,
        (e: unknown) => e as { cause?: { message?: string } },
      );
      expect(refused).not.toBeNull();
      expect(refused?.cause?.message).toMatch(/row-level security/i);
    });
  });

  // ── audit ──────────────────────────────────────────────────────────────────────────────────────
  describe("audit", () => {
    it("every write lands in audit_event with the actor, and the free text never enters the diff", async () => {
      const { planId } = await newPlan();
      const text = "SYNTHETIC-FREE-TEXT-7F3A";
      const enc = randomUUID();
      const p = await create(planId, enc, { ...PROBLEM_ADD, description: text });
      await release(enc);
      await accept(planId, p.id);

      const { rows } = await admin.query(
        "SELECT event_type, actor_user_id, actor_kind, before, after FROM audit_event WHERE resource_id=$1 ORDER BY created_at, id",
        [p.id],
      );
      expect(rows.map((r) => r.event_type)).toEqual([
        "care_plan_change_proposal.insert",
        "care_plan_change_proposal.update", // release: no human acts
        "care_plan_change_proposal.update", // accept
      ]);
      expect(rows[0]?.actor_user_id).toBe(FIELD_RN.userId);
      expect(rows[1]).toMatchObject({ actor_user_id: null, actor_kind: "system" });
      expect(rows[2]?.actor_user_id).toBe(CM.userId);
      expect(JSON.stringify(rows)).not.toContain(text);
      expect(rows[2]?.after.status).toBe("accepted");
      // The element the accept wrote is audited under the accepter too.
      const problemId = (await proposalRow(p.id)).result_element_id;
      const problemAudit = await row(
        "SELECT actor_user_id FROM audit_event WHERE resource_id=$1 AND event_type='problem.insert'",
        [problemId],
      );
      expect(problemAudit.actor_user_id).toBe(CM.userId);
    });

    it("never writes a diagnosis code, a responsible role or a frequency value into the audit diff", async () => {
      const { planId, terminalId } = await newPlan();
      const code = "F11.20-SYNTHETIC";
      const snomed = "SNOMED-SYNTHETIC-123";
      const role = "SYNTHETIC-ROLE-NAME";
      // `frequency_value` is a free string at proposal time (the cadence format is only checked at accept), so it is scrubbed like text.
      const frequencyValue = "SYNTHETIC-FREQUENCY-VALUE-5C2D";
      const problem = await create(planId, randomUUID(), {
        ...PROBLEM_ADD,
        icd10Code: code,
        snomedCode: snomed,
        sudRelated: true,
      });
      const intervention = await create(
        planId,
        randomUUID(),
        {
          kind: "intervention_add",
          problemId: terminalId,
          scopeText: "Reassess (synthetic)",
          frequencyText: "weekly",
          frequencyValue,
          discipline: "rn",
          responsibleRole: role,
        },
        FIELD_RN,
        false,
      );
      await as(FIELD_RN, () =>
        proposals.replace(
          ORG_A,
          planId,
          problem.id,
          { ...PROBLEM_ADD, icd10Code: code, snomedCode: snomed, sudRelated: true } as never,
          caller(FIELD_RN, true),
        ),
      );
      const audit = await admin.query(
        "SELECT before, after FROM audit_event WHERE resource_id = ANY($1)",
        [[problem.id, intervention.id]],
      );
      expect(audit.rowCount).toBeGreaterThanOrEqual(3); // two inserts and an update: the writes were audited, only the values withheld
      const text = JSON.stringify(audit.rows);
      for (const secret of [code, snomed, role, frequencyValue]) expect(text).not.toContain(secret);
    });

    it("makes a decided or withdrawn proposal final, and a released Part 2 proposal stay Part 2, for every role", async () => {
      const { planId } = await newPlan();
      const accepted = await pending(planId, PROBLEM_ADD);
      await accept(planId, accepted.id);
      const dismissed = await pending(planId, {
        ...PROBLEM_ADD,
        description: "Second (synthetic)",
      });
      await as(CM, () => proposals.dismiss(ORG_A, planId, dismissed.id, {}, caller(CM)));
      const withdrawn = await create(planId, randomUUID(), PROBLEM_ADD);
      await as(FIELD_RN, () => proposals.withdraw(ORG_A, planId, withdrawn.id, caller(FIELD_RN)));
      // Not even a privileged role can rewrite a decision, re-open a proposal or edit a withdrawn one.
      for (const final of [accepted, dismissed, withdrawn]) {
        for (const change of [
          "description='Changed (synthetic)'",
          "sud_related=true",
          "updated_at=now()",
        ]) {
          await expect(
            admin.query(`UPDATE care_plan_change_proposal SET ${change} WHERE id=$1`, [final.id]),
            `${final.status} / ${change}`,
          ).rejects.toMatchObject({
            code: "23514",
            message: expect.stringMatching(/cannot be changed/),
          });
        }
      }
      // A Part 2 flag stays once the proposal has left draft; while still a draft its author re-flags it either way (replace).
      const sud = await pending(planId, {
        ...PROBLEM_ADD,
        description: "Part 2 (synthetic)",
        sudRelated: true,
      });
      await expect(
        admin.query("UPDATE care_plan_change_proposal SET sud_related=false WHERE id=$1", [sud.id]),
      ).rejects.toMatchObject({ code: "23514", message: expect.stringMatching(/Part 2 flag/) });
      const draft = await create(planId, randomUUID(), { ...PROBLEM_ADD, sudRelated: true });
      await expect(
        as(FIELD_RN, () =>
          proposals.replace(ORG_A, planId, draft.id, PROBLEM_ADD as never, caller(FIELD_RN, true)),
        ),
      ).resolves.toMatchObject({ sudRelated: false });
      // The flag can still be raised on a released proposal (the guard only refuses clearing it).
      const plain = await pending(planId, { ...PROBLEM_ADD, description: "Plain (synthetic)" });
      await expect(
        admin.query("UPDATE care_plan_change_proposal SET sud_related=true WHERE id=$1", [
          plain.id,
        ]),
      ).resolves.toBeDefined();
    });

    it("the application role cannot rewrite a proposal's plan, patient, visit, proposer or organisation, and no role can", async () => {
      const { planId } = await newPlan();
      const p = await create(planId, randomUUID(), PROBLEM_ADD);
      const asApp = (column: string) =>
        withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, async (tx) => {
          const { sql } = await import("drizzle-orm");
          await (tx as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(
            sql.raw(
              `UPDATE care_plan_change_proposal SET ${column} = '${randomUUID()}' WHERE id = '${p.id}'`,
            ),
          );
        });
      for (const column of [
        "source_encounter_id",
        "patient_id",
        "care_plan_id",
        "proposed_by_membership_id",
        "organization_id",
      ]) {
        // The column-level grant: drizzle wraps the driver error, so the database's own refusal is its `cause`.
        const refused = await asApp(column).then(
          () => null,
          (e: unknown) => e as { cause?: { code?: string } },
        );
        expect(refused?.cause?.code, column).toBe("42501");
      }
      // A privileged role passes the grant but not the guard trigger.
      for (const column of ["source_encounter_id", "patient_id", "proposed_by_membership_id"]) {
        await expect(
          admin.query(`UPDATE care_plan_change_proposal SET ${column}=$2 WHERE id=$1`, [
            p.id,
            randomUUID(),
          ]),
        ).rejects.toMatchObject({ code: "23514" });
      }
      // What the service writes still updates (a replace as the application role).
      await expect(
        as(FIELD_RN, () =>
          proposals.replace(
            ORG_A,
            planId,
            p.id,
            { ...PROBLEM_ADD, description: "Rewritten (synthetic)" } as never,
            caller(FIELD_RN),
          ),
        ),
      ).resolves.toMatchObject({ id: p.id });
    });

    it("rejects rows the CHECK constraints forbid, whoever writes them", async () => {
      const { planId, patientId } = await newPlan();
      const base = [ORG_A, planId, patientId, randomUUID(), FIELD_RN.membershipId];
      const insert = (kind: string, cols: string, vals: string) =>
        admin.query(
          `INSERT INTO care_plan_change_proposal (organization_id, care_plan_id, patient_id, source_encounter_id, proposed_by_membership_id, kind, ${cols}) VALUES ($1,$2,$3,$4,$5,'${kind}',${vals})`,
          base,
        );
      // A goal needs a problem (existing or proposed), exactly one of them.
      await expect(
        insert("goal_add", "goal_text, goal_source", "'x','clinical'"),
      ).rejects.toMatchObject({
        code: "23514",
      });
      // A change to an element needs its target.
      await expect(insert("problem_resolve", "resolution_note", "'x'")).rejects.toMatchObject({
        code: "23514",
      });
      // A kind outside the list.
      await expect(insert("problem_delete", "description", "'x'")).rejects.toMatchObject({
        code: "23514",
      });
      // The status moves with its lifecycle columns: nothing is accepted without who, when and what.
      const p = await create(planId, randomUUID(), PROBLEM_ADD);
      await expect(
        admin.query("UPDATE care_plan_change_proposal SET status='accepted' WHERE id=$1", [p.id]),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        admin.query("UPDATE care_plan_change_proposal SET status='pending' WHERE id=$1", [p.id]),
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  // ── erasure ────────────────────────────────────────────────────────────────────────────────────
  describe("patient destruction", () => {
    it("the care_plan_record eraser removes the proposals (parent and child in one statement) and counts them", async () => {
      const { planId, patientId } = await newPlan();
      const enc = randomUUID();
      const parent = await create(planId, enc, PROBLEM_ADD);
      await create(planId, enc, {
        kind: "goal_add",
        parentProposalId: parent.id,
        originalText: "x",
      });
      await pending(planId, PROBLEM_ADD);
      const before = await row(
        "SELECT count(*)::int AS n FROM care_plan_change_proposal WHERE care_plan_id=$1",
        [planId],
      );
      expect(before.n).toBe(3);

      const counts = await createDrizzleCarePlanEraseStore(adminHandle.db).eraseCarePlanSubtree(
        ORG_A,
        patientId,
      );
      expect(counts.changeProposals).toBe(3);
      const after = await row(
        "SELECT count(*)::int AS n FROM care_plan_change_proposal WHERE care_plan_id=$1",
        [planId],
      );
      expect(after.n).toBe(0);
    });
  });

  // ── over HTTP ──────────────────────────────────────────────────────────────────────────────────
  describe("routes", () => {
    function bootApp(full = false): FastifyInstance {
      resetAuthorizationContract();
      resetRbacEngine();
      registerEffectivePermissionResolver(
        createInMemoryEffectivePermissionStore(
          Object.entries(GRANTS).map(([userId, permissionKeys]) => ({
            orgId: PEOPLE.find((p) => p.userId === userId)?.org as string,
            userId,
            grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
          })),
        ).store,
      );
      const registry = createPredicateRegistry();
      for (const [name, fn] of Object.entries(
        buildCarePlanAbacPredicates({
          resolver: createDbCarePlanAbacResolver(handle.db),
          isInCaseload: async () => true,
        }),
      )) {
        registry.register(name, fn);
      }
      registerAbacRegistry(registry);
      const app = buildServer({
        db: handle.db as never,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      if (full) mountCarePlanRoutes(app, handle.db, outbox);
      else
        registerChangeProposalRoutes(app, {
          service: proposals,
          sudDisclosureAllowed: async ({ roles }) => roles.includes("rn_case_manager"),
        });
      return app;
    }
    const as_ = (who: Person, extra: Record<string, string> = {}) => ({
      "x-test-user": who.userId,
      ...extra,
    });
    const key = () => ({ "idempotency-key": randomUUID() });

    it("create → release → list → accept, and the read audit lands against the patient", async () => {
      const app = bootApp();
      const { planId, patientId } = await newPlan();
      const enc = randomUUID();
      const fieldRnVisit = randomUUID();
      await openVisit(planId, enc, CM);
      await openVisit(planId, fieldRnVisit, FIELD_RN);
      const url = `/api/v1/care-plans/${planId}/change-proposals`;

      // The field RN holds only care_plan.read by default, which is enough to record a proposal (it changes nothing on the plan) for a
      // visit of its own; it stays a draft, so nothing below sees it.
      const fieldRnDraft = await app.inject({
        method: "POST",
        url,
        headers: { ...as_(FIELD_RN), ...key() },
        payload: { ...PROBLEM_ADD, sourceEncounterId: fieldRnVisit },
      });
      expect(fieldRnDraft.statusCode).toBe(201);
      // A visit that is not the caller's own is a 404, whoever else's it is.
      const notMine = await app.inject({
        method: "POST",
        url,
        headers: { ...as_(FIELD_RN), ...key() },
        payload: { ...PROBLEM_ADD, sourceEncounterId: enc },
      });
      expect(notMine.statusCode).toBe(404);

      const idempotencyKey = randomUUID();
      const created = await app.inject({
        method: "POST",
        url,
        headers: { ...as_(CM), "idempotency-key": idempotencyKey },
        payload: { ...PROBLEM_ADD, sourceEncounterId: enc },
      });
      expect(created.statusCode).toBe(201);
      const draft = created.json() as View;
      expect(draft).toMatchObject({ status: "draft", proposedBy: { displayName: CM.name } });

      // The composer lists the author's drafts for the visit; the plan's review list shows nothing yet.
      const mine = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${patientId}/care-plan-change-proposals?sourceEncounterId=${enc}`,
        headers: as_(CM),
      });
      expect((mine.json() as { proposals: View[] }).proposals.map((x) => x.id)).toEqual([draft.id]);
      const review0 = await app.inject({ method: "GET", url, headers: as_(CM) });
      expect((review0.json() as { proposals: View[] }).proposals).toEqual([]);

      await release(enc);
      const review = await app.inject({ method: "GET", url, headers: as_(FIELD_RN) });
      expect(review.statusCode).toBe(200);
      expect((review.json() as { proposals: View[] }).proposals).toMatchObject([
        { id: draft.id, status: "pending", sourceEncounterId: enc },
      ]);

      // An AI principal can decide nothing, even holding the permission.
      const ai = await app.inject({
        method: "POST",
        url: `${url}/${draft.id}/accept`,
        headers: as_(CM, { "x-test-actor-kind": "ai_agent" }),
      });
      expect(ai.statusCode).toBe(403);
      // A clinician with read only cannot decide.
      const readOnly = await app.inject({
        method: "POST",
        url: `${url}/${draft.id}/accept`,
        headers: as_(FIELD_RN),
      });
      expect(readOnly.statusCode).toBe(403);

      const accepted = await app.inject({
        method: "POST",
        url: `${url}/${draft.id}/accept`,
        headers: as_(CM),
      });
      expect(accepted.statusCode).toBe(200);
      const again = await app.inject({
        method: "POST",
        url: `${url}/${draft.id}/accept`,
        headers: as_(CM),
      });
      expect(again.json()).toEqual(accepted.json());
      expect(accepted.json()).toMatchObject({ status: "accepted", resultElementType: "problem" });
      expect(
        (
          await row("SELECT count(*)::int AS n FROM problem WHERE id=$1", [
            accepted.json().resultElementId,
          ])
        ).n,
      ).toBe(1);

      // Read audit: both lists emit one aggregate event per read, accounted against the patient (§164.528).
      const viewed = await admin.query(
        `SELECT event_type, actor_user_id, context FROM audit_event
          WHERE organization_id=$1 AND event_type='care_plan_change_proposal.list_viewed' AND context->>'patientId'=$2`,
        [ORG_A, patientId],
      );
      expect(viewed.rowCount).toBeGreaterThanOrEqual(3);
      expect(viewed.rows.map((r) => r.actor_user_id)).toEqual(
        expect.arrayContaining([CM.userId, FIELD_RN.userId]),
      );
      await app.close();
    });

    it("a replayed POST with the same Idempotency-Key records one draft", async () => {
      const app = bootApp();
      const { planId } = await newPlan();
      const headers = { ...as_(CM), "idempotency-key": randomUUID() };
      const enc = randomUUID();
      await openVisit(planId, enc, CM);
      const payload = { ...PROBLEM_ADD, sourceEncounterId: enc };
      const url = `/api/v1/care-plans/${planId}/change-proposals`;
      const first = await app.inject({ method: "POST", url, headers, payload });
      const second = await app.inject({ method: "POST", url, headers, payload });
      expect([first.statusCode, second.statusCode]).toEqual([201, 201]);
      expect((second.json() as View).id).toBe((first.json() as View).id);
      expect(
        (
          await row(
            "SELECT count(*)::int AS n FROM care_plan_change_proposal WHERE care_plan_id=$1",
            [planId],
          )
        ).n,
      ).toBe(1);
      await app.close();
    });

    it("another organization's session gets 404 for the plan's list and cannot accept", async () => {
      const app = bootApp();
      const { planId } = await newPlan();
      const p = await pending(planId, PROBLEM_ADD);
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/care-plans/${planId}/change-proposals`,
        headers: as_(ORG_B_USER),
      });
      const decide = await app.inject({
        method: "POST",
        url: `/api/v1/care-plans/${planId}/change-proposals/${p.id}/accept`,
        headers: as_(ORG_B_USER),
      });
      expect([list.statusCode, decide.statusCode]).toEqual([404, 404]);
      await app.close();
    });

    it("is mounted by mountCarePlanRoutes, the way the composition root registers M7", async () => {
      const app = bootApp(true);
      const { patientId } = await newPlan();
      const res = await app.inject({
        method: "GET",
        url: `/api/v1/patients/${patientId}/care-plan-change-proposals`,
        headers: as_(CM),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ patientId, proposals: [] });
      await app.close();
    });
  });
});
