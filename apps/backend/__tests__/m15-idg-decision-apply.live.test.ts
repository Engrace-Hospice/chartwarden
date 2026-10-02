/**
 * F-234 (#248) — the M14 ⇄ M15 IDG-decision loop, END TO END over real Postgres.
 *
 * `m15.idg_decision.applied` (M15 spec §4.5: "IDG decision applied — consumer M14") was catalogued with no
 * producer and no consumer. M14's envelope had no arm that could NAME a discipline plan, M15 had no intake
 * consumer for `idg.decision_recorded`, and M14 had nowhere to record an acknowledgement. This suite drives
 * the whole loop with nothing stubbed:
 *
 *   `idg.decision_recorded` (kind `discipline_plan_update`), published through the REAL catalog-validating
 *   publisher as the M14 adjournment emit does → the REAL dispatcher → M15's consumer opens a draft
 *   `idg_review` version on the named plan, applies the mutations under RLS and emits
 *   `m15.idg_decision.applied` through the real publisher → the dispatcher → M14's consumer records the
 *   acknowledgement (`idg_decision_application_ack`), read back through M14's real list read.
 *
 * All as the NOBYPASSRLS `wardenx_app` role. The M7 parent-problem check is M7's REAL org-explicit
 * `activeProblemIdsForOrg` over real `care_plan` / `problem` rows.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m15:idg-decision:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { withOrgContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActiveOrgEnumerator } from "../src/bootstrap/active-org-enumerator";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { activeProblemIdsForOrg } from "../src/modules/07-care-plan/index";
import {
  type IdgWriteOutboxPort,
  createDbIdgBackend,
} from "../src/modules/14-idg/idg-route-service-db";
import { M14_OUTBOX_EVENTS, buildM14DecisionAppliedConsumer } from "../src/modules/14-idg/index";
import {
  M15_OUTBOX_EVENTS,
  buildM15IdgDecisionConsumer,
} from "../src/modules/15-discipline-care-plans/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const COORDINATOR = "33333333-3333-3333-3333-33333333aaaa"; // idg tables carry no membership FK

describe.skipIf(!DB_URL)("F-234 — M14 ⇄ M15 IDG-decision loop, LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let dispatcher: ReturnType<typeof createOutboxDispatcher>;
  let svc: ReturnType<typeof createDbIdgBackend>;
  let publishDecision: (org: string, e: SeededDecision, patientOrg?: string) => Promise<void>;
  const peOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};

  interface SeededDecision {
    readonly decisionId: string;
    readonly meetingId: string;
    readonly patientId: string;
    readonly payload: Record<string, unknown>;
  }
  interface SeededPlan {
    readonly patientId: string;
    readonly planId: string;
    readonly problemId: string;
    readonly goalId: string;
    readonly sudGoalId: string;
    readonly interventionId: string;
  }

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of ROLES)
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

  /** An ACTIVE msw_plan with one IPOC problem (M7), one goal, one SUD-flagged goal and one intervention. */
  async function seedPlan(
    org: string,
    opts: { status?: string; kind?: string } = {},
  ): Promise<SeededPlan> {
    const patientId = randomUUID();
    const kind = opts.kind ?? "msw_plan";
    const status = opts.status ?? "active";
    const admissionId = randomUUID();
    const carePlanId = (
      await admin.query(
        `INSERT INTO care_plan (organization_id, provider_entity_id, location_id, patient_id, admission_id,
           status, initial_due_at) VALUES ($1,$2,$3,$4,$5,'active', now() + interval '5 days') RETURNING id`,
        [org, peOf[org], locationOf[org], patientId, admissionId],
      )
    ).rows[0].id as string;
    const problemId = (
      await admin.query(
        `INSERT INTO problem (organization_id, provider_entity_id, location_id, care_plan_id, description, kind)
         VALUES ($1,$2,$3,$4,'Anticipatory grief','related') RETURNING id`,
        [org, peOf[org], locationOf[org], carePlanId],
      )
    ).rows[0].id as string;
    const planId = (
      await admin.query(
        `INSERT INTO discipline_care_plan (organization_id, patient_id, admission_id, provider_entity_id,
           location_id, kind, status) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [org, patientId, admissionId, peOf[org], locationOf[org], kind, status],
      )
    ).rows[0].id as string;
    const goal = async (text: string, sud: boolean) =>
      (
        await admin.query(
          `INSERT INTO discipline_goal (organization_id, provider_entity_id, location_id, plan_id,
             parent_problem_id, source, status, original_text, sud_related, added_by_membership_id,
             added_by_discipline) VALUES ($1,$2,$3,$4,$5,'clinical','in_progress',$6,$7,$8,'msw') RETURNING id`,
          [org, peOf[org], locationOf[org], planId, problemId, text, sud, COORDINATOR],
        )
      ).rows[0].id as string;
    const goalId = await goal("Family will report reduced distress", false);
    const sudGoalId = await goal("Patient will engage in SUD treatment planning", true);
    const interventionId = (
      await admin.query(
        `INSERT INTO discipline_intervention (organization_id, provider_entity_id, location_id, plan_id,
           scope_text, frequency_text, frequency_value, discipline, added_by_membership_id,
           added_by_discipline) VALUES ($1,$2,$3,$4,'Grief counseling','Weekly','1:visit:week','msw',$5,'msw')
         RETURNING id`,
        [org, peOf[org], locationOf[org], planId, COORDINATOR],
      )
    ).rows[0].id as string;
    return { patientId, planId, problemId, goalId, sudGoalId, interventionId };
  }

  /** A real `idg_decision` row (status emitted) so M14's acknowledgement has a decision to hang off. */
  async function seedDecision(
    org: string,
    patientId: string,
    payload: Record<string, unknown>,
    kind = "discipline_plan_update",
  ): Promise<SeededDecision> {
    const meetingId = (
      await admin.query(
        `INSERT INTO idg_meeting (organization_id, location_id, scheduled_start, scheduled_end, status,
           coordinator_membership_id, tenant_quorum_snapshot)
         VALUES ($1,$2, now(), now() + interval '2 hours', 'adjourned', $3, '{}'::jsonb) RETURNING id`,
        [org, locationOf[org], COORDINATOR],
      )
    ).rows[0].id as string;
    const decisionId = (
      await admin.query(
        `INSERT INTO idg_decision (organization_id, provider_entity_id, location_id, idg_meeting_id, patient_id,
           decision_kind, payload, was_quorate, quorum_snapshot, recorded_by_membership_id, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,true,'{}'::jsonb,$8,'emitted') RETURNING id`,
        [
          org,
          peOf[org],
          locationOf[org],
          meetingId,
          patientId,
          kind,
          JSON.stringify(payload),
          COORDINATOR,
        ],
      )
    ).rows[0].id as string;
    return { decisionId, meetingId, patientId, payload };
  }

  const dbRows = async (sql: string, params: unknown[] = []) =>
    (await admin.query(sql, params)).rows as Record<string, unknown>[];
  const applications = (decisionId: string) =>
    dbRows("SELECT * FROM discipline_plan_idg_decision_application WHERE idg_decision_id=$1", [
      decisionId,
    ]);
  const acks = (decisionId: string) =>
    dbRows("SELECT * FROM idg_decision_application_ack WHERE idg_decision_id=$1", [decisionId]);
  const appliedEvents = (decisionId: string) =>
    dbRows(
      `SELECT payload FROM outbox_event WHERE event_type='m15.idg_decision.applied'
        AND payload->>'idgDecisionId'=$1`,
      [decisionId],
    );
  const versions = (planId: string) =>
    dbRows(
      "SELECT id, sequence, status, kind, idg_meeting_id FROM discipline_care_plan_version WHERE plan_id=$1 ORDER BY sequence",
      [planId],
    );
  const planStatus = async (planId: string) =>
    (await dbRows("SELECT status FROM discipline_care_plan WHERE id=$1", [planId]))[0]
      ?.status as string;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'f232@x.test')`, [USER]);
    for (const org of [ORG_A, ORG_B]) {
      peOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
             VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [org, `CCN-${org.slice(0, 4)}`, `PE ${org.slice(0, 4)}`, `NPI-${org.slice(0, 4)}`],
        )
      ).rows[0].id as string;
      locationOf[org] = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
             VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [peOf[org]],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    const catalog = buildBootOutboxCatalog([M14_OUTBOX_EVENTS, M15_OUTBOX_EVENTS]);
    const publisher = buildTxOutboxPublisher(catalog);
    const bind = (module: string) => ({
      publish: (tx: unknown, e: Record<string, unknown>) =>
        publisher.publish(tx as never, { ...e, callerModule: module } as never),
    });
    svc = createDbIdgBackend(handle.db, bind("m14") as unknown as IdgWriteOutboxPort);

    // The exact envelope M14's adjournment emit publishes (`idg-route-service-db.ts`), through the real
    // catalog-validating publisher — a payload the catalog rejects (e.g. an unknown arm) fails HERE.
    publishDecision = async (org, d, patientOrg) => {
      await withOrgContext(handle.db, { organizationId: org, userId: "" }, (tx) =>
        publisher.publish(
          tx as never,
          {
            eventName: "idg.decision_recorded",
            organizationId: org,
            aggregateKind: "idg_decision",
            aggregateId: d.decisionId,
            callerModule: "m14",
            payload: {
              decisionId: d.decisionId,
              meetingId: d.meetingId,
              patientId: d.patientId,
              organizationId: patientOrg ?? org,
              decisionKind: d.payload.kind,
              payload: d.payload,
              payloadSchemaVersion: "2026-01-v1",
              recordedByMembershipId: COORDINATOR,
              recordedAt: new Date().toISOString(),
              meetingAdjournedAt: new Date().toISOString(),
              wasQuorate: true,
              quorumSnapshot: {},
            },
          } as never,
        ),
      );
    };

    const orgs: ActiveOrgEnumerator = {
      listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
    };
    dispatcher = createOutboxDispatcher({
      db: handle.db,
      orgs,
      consumers: [
        buildM15IdgDecisionConsumer({
          db: handle.db,
          outbox: bind("m15") as never,
          activeProblemIds: (organizationId, patientId) =>
            activeProblemIdsForOrg(handle.db, organizationId, patientId),
        }),
        buildM14DecisionAppliedConsumer({ db: handle.db }),
      ],
      eventCatalog: catalog,
      options: { log: () => {} },
    });
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  /** One tick delivers the decision to M15; a second delivers M15's acknowledgement to M14. */
  const settle = async () => {
    await dispatcher.tick();
    await dispatcher.tick();
  };

  it("applies a discipline_plan_update end to end: draft idg_review version, mutations, ack, M14 read", async () => {
    const plan = await seedPlan(ORG_A);
    const d = await seedDecision(ORG_A, plan.patientId, {
      kind: "discipline_plan_update",
      planKind: "msw_plan",
      mutations: [
        {
          op: "goal_add",
          parentProblemId: plan.problemId,
          source: "clinical",
          originalText: "Chaplain weekly presence visit will reduce spiritual distress",
          measurableOutcome: "Distress score falls by 2 points in 14 days",
        },
        {
          op: "goal_update",
          goalId: plan.goalId,
          event: "revise",
          revisedText: "Family will report reduced distress within 30 days",
        },
        {
          op: "intervention_add",
          goalRefs: [plan.goalId],
          discipline: "msw",
          scopeText: "Family support session",
          frequencyText: "Twice weekly",
          frequencyValue: "2:visit:week",
        },
        {
          op: "intervention_discontinue",
          interventionId: plan.interventionId,
          reason: "Family declined grief counseling",
        },
      ],
    });
    await publishDecision(ORG_A, d);
    expect(await applications(d.decisionId)).toHaveLength(0); // nothing until the relay runs

    await settle();

    // The plan opened its next version and is revising; the new version is a DRAFT idg_review for the meeting.
    expect(await planStatus(plan.planId)).toBe("draft_revising");
    const vs = await versions(plan.planId);
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({
      sequence: "1", // bigint → string over pg
      status: "draft",
      kind: "idg_review",
      idg_meeting_id: d.meetingId,
    });

    // The mutations landed on the working rows.
    const goals = await dbRows(
      "SELECT original_text, revised_text, status FROM discipline_goal WHERE plan_id=$1 ORDER BY created_at",
      [plan.planId],
    );
    expect(goals).toHaveLength(3);
    expect(
      goals.find((g) => g.original_text === "Family will report reduced distress"),
    ).toMatchObject({
      status: "revised",
      revised_text: "Family will report reduced distress within 30 days",
    });
    expect(
      goals.some(
        (g) => g.original_text === "Chaplain weekly presence visit will reduce spiritual distress",
      ),
    ).toBe(true);
    const ivs = await dbRows(
      "SELECT scope_text, status, discontinuation_reason, added_by_discipline FROM discipline_intervention WHERE plan_id=$1 ORDER BY created_at",
      [plan.planId],
    );
    expect(ivs).toHaveLength(2);
    expect(ivs[0]).toMatchObject({
      status: "discontinued",
      discontinuation_reason: "Family declined grief counseling",
    });
    expect(ivs[1]).toMatchObject({ status: "active", added_by_discipline: "idg_coordinator" });

    // The application record + the acknowledgement event (catalog-validated payload).
    const apps = await applications(d.decisionId);
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      status: "applied",
      mutations_applied: 4,
      plan_id: plan.planId,
      version_id: vs[0]?.id,
      organization_id: ORG_A,
    });
    const events = await appliedEvents(d.decisionId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      planId: plan.planId,
      versionId: vs[0]?.id,
      idgDecisionId: d.decisionId,
      mutationsApplied: 4,
    });

    // M14 recorded the acknowledgement, and its real decision-list read surfaces it.
    const a = await acks(d.decisionId);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({
      target_module: "m15",
      plan_id: plan.planId,
      version_id: vs[0]?.id,
      mutations_applied: 4,
      patient_id: plan.patientId,
      idg_meeting_id: d.meetingId,
    });
    const listed = await svc.listDecisions(ORG_A, d.meetingId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.applications).toEqual([
      expect.objectContaining({
        module: "m15",
        planId: plan.planId,
        versionId: vs[0]?.id,
        mutationsApplied: 4,
      }),
    ]);
  });

  it("is idempotent on idgDecisionId — a re-published decision adds no version, no rows, no second ack", async () => {
    const plan = await seedPlan(ORG_A);
    const d = await seedDecision(ORG_A, plan.patientId, {
      kind: "discipline_plan_update",
      planKind: "msw_plan",
      mutations: [
        {
          op: "intervention_add",
          goalRefs: [],
          discipline: "msw",
          scopeText: "Bereavement planning",
          frequencyText: "Weekly",
          frequencyValue: "1:visit:week",
        },
      ],
    });
    await publishDecision(ORG_A, d);
    await settle();
    await publishDecision(ORG_A, d); // redelivery of the same decision (a NEW outbox row)
    await settle();
    await settle();

    // BOTH deliveries were handled cleanly (a receipt each, no failed attempt): the redelivery is a true
    // no-op, not a unique-violation that rolls back and retries (which would leave the same row counts).
    const deliveries = await dbRows(
      `SELECT e.attempt_count, e.last_error,
              (SELECT count(*)::int FROM outbox_consumer_receipt r
                WHERE r.event_id = e.id AND r.consumer_name = 'm15.apply-idg-decision') AS receipts
         FROM outbox_event e WHERE e.event_type='idg.decision_recorded' AND e.aggregate_id=$1`,
      [d.decisionId],
    );
    expect(deliveries).toHaveLength(2);
    for (const row of deliveries) {
      expect(row.receipts).toBe(1);
      expect(Number(row.attempt_count)).toBe(0);
      expect(String(row.last_error)).toMatch(/^deferred:/);
    }
    expect(await versions(plan.planId)).toHaveLength(1);
    expect(await applications(d.decisionId)).toHaveLength(1);
    expect(await appliedEvents(d.decisionId)).toHaveLength(1);
    expect(await acks(d.decisionId)).toHaveLength(1);
    const ivs = await dbRows("SELECT id FROM discipline_intervention WHERE plan_id=$1", [
      plan.planId,
    ]);
    expect(ivs).toHaveLength(2); // the seeded one + exactly one add
  });

  it("applies into an already-open DRAFT version instead of opening a second one", async () => {
    const plan = await seedPlan(ORG_A, { status: "draft_revising" });
    const openVersion = (
      await admin.query(
        `INSERT INTO discipline_care_plan_version (organization_id, provider_entity_id, location_id, plan_id,
           sequence, status, kind) VALUES ($1,$2,$3,$4,2,'draft','interim_revision') RETURNING id`,
        [ORG_A, peOf[ORG_A], locationOf[ORG_A], plan.planId],
      )
    ).rows[0].id as string;
    const d = await seedDecision(ORG_A, plan.patientId, {
      kind: "discipline_plan_update",
      planKind: "msw_plan",
      mutations: [{ op: "goal_update", goalId: plan.goalId, event: "meet" }],
    });
    await publishDecision(ORG_A, d);
    await settle();

    const vs = await versions(plan.planId);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.id).toBe(openVersion);
    const [app] = await applications(d.decisionId);
    expect(app).toMatchObject({ status: "applied", version_id: openVersion, mutations_applied: 1 });
    expect(
      (await dbRows("SELECT status FROM discipline_goal WHERE id=$1", [plan.goalId]))[0]?.status,
    ).toBe("met");
  });

  it("FAILS CLOSED on Part 2: a goal flagged sud_related is never changed or linked — refused, nothing applied, no ack", async () => {
    const plan = await seedPlan(ORG_A);
    const d = await seedDecision(ORG_A, plan.patientId, {
      kind: "discipline_plan_update",
      planKind: "msw_plan",
      mutations: [
        { op: "goal_update", goalId: plan.goalId, event: "meet" }, // a legal edit that must NOT land either
        {
          op: "goal_update",
          goalId: plan.sudGoalId,
          event: "discontinue",
          reason: "no longer needed",
        },
      ],
    });
    await publishDecision(ORG_A, d);
    await settle();

    const [app] = await applications(d.decisionId);
    expect(app).toMatchObject({
      status: "refused",
      refusal_reason: "sud_goal_targeted",
      version_id: null,
      mutations_applied: 0,
    });
    // All-or-nothing: the legal first mutation did not land, no version opened, plan untouched.
    expect(
      (await dbRows("SELECT status FROM discipline_goal WHERE id=$1", [plan.goalId]))[0]?.status,
    ).toBe("in_progress");
    expect(
      (await dbRows("SELECT status FROM discipline_goal WHERE id=$1", [plan.sudGoalId]))[0]?.status,
    ).toBe("in_progress");
    expect(await versions(plan.planId)).toHaveLength(0);
    expect(await planStatus(plan.planId)).toBe("active");
    expect(await appliedEvents(d.decisionId)).toHaveLength(0);
    expect(await acks(d.decisionId)).toHaveLength(0);

    // Linking a NEW intervention to the SUD goal is refused for the same reason.
    const d2 = await seedDecision(ORG_A, plan.patientId, {
      kind: "discipline_plan_update",
      planKind: "msw_plan",
      mutations: [
        {
          op: "intervention_add",
          goalRefs: [plan.sudGoalId],
          discipline: "msw",
          scopeText: "x",
          frequencyText: "y",
          frequencyValue: "1:visit:week",
        },
      ],
    });
    await publishDecision(ORG_A, d2);
    await settle();
    expect((await applications(d2.decisionId))[0]).toMatchObject({
      status: "refused",
      refusal_reason: "sud_goal_targeted",
    });
  });

  it("refuses the WHOLE decision when one mutation is bad — nothing half-applied", async () => {
    const plan = await seedPlan(ORG_A);
    const d = await seedDecision(ORG_A, plan.patientId, {
      kind: "discipline_plan_update",
      planKind: "msw_plan",
      mutations: [
        {
          op: "goal_add",
          parentProblemId: plan.problemId,
          source: "clinical",
          originalText: "Valid goal that must not land",
          measurableOutcome: null,
        },
        { op: "goal_update", goalId: randomUUID(), event: "meet" }, // not on this plan
      ],
    });
    await publishDecision(ORG_A, d);
    await settle();

    expect((await applications(d.decisionId))[0]).toMatchObject({
      status: "refused",
      refusal_reason: "goal_not_on_plan",
    });
    expect(
      await dbRows(
        "SELECT id FROM discipline_goal WHERE plan_id=$1 AND original_text LIKE 'Valid goal%'",
        [plan.planId],
      ),
    ).toHaveLength(0);
    expect(await versions(plan.planId)).toHaveLength(0);
  });

  it("refuses a goal whose parent IPOC problem is not an active M7 problem (another patient's is not enough)", async () => {
    const plan = await seedPlan(ORG_A);
    const other = await seedPlan(ORG_A);
    const d = await seedDecision(ORG_A, plan.patientId, {
      kind: "discipline_plan_update",
      planKind: "msw_plan",
      mutations: [
        {
          op: "goal_add",
          parentProblemId: other.problemId,
          source: "clinical",
          originalText: "Goal under someone else's problem",
          measurableOutcome: null,
        },
      ],
    });
    await publishDecision(ORG_A, d);
    await settle();
    expect((await applications(d.decisionId))[0]).toMatchObject({
      status: "refused",
      refusal_reason: "parent_problem_not_active",
    });
  });

  it("refuses a discharged plan (terminal) and a plan that never reached active", async () => {
    const discharged = await seedPlan(ORG_A, { status: "discharged" });
    const dDis = await seedDecision(ORG_A, discharged.patientId, {
      kind: "discipline_plan_update",
      planKind: "msw_plan",
      mutations: [{ op: "goal_update", goalId: discharged.goalId, event: "meet" }],
    });
    const fresh = await seedPlan(ORG_A, { status: "draft" });
    const dDraft = await seedDecision(ORG_A, fresh.patientId, {
      kind: "discipline_plan_update",
      planKind: "msw_plan",
      mutations: [{ op: "goal_update", goalId: fresh.goalId, event: "meet" }],
    });
    await publishDecision(ORG_A, dDis);
    await publishDecision(ORG_A, dDraft);
    await settle();

    expect((await applications(dDis.decisionId))[0]).toMatchObject({
      status: "refused",
      refusal_reason: "plan_discharged",
      plan_id: discharged.planId,
    });
    expect((await applications(dDraft.decisionId))[0]).toMatchObject({
      status: "refused",
      refusal_reason: "plan_not_yet_active",
    });
    expect(await appliedEvents(dDis.decisionId)).toHaveLength(0);
    expect(await appliedEvents(dDraft.decisionId)).toHaveLength(0);
  });

  it("THROWS (retry / dead-letter, never a silent drop) when no plan of that kind exists yet or the open version is in review", async () => {
    // No plan bootstrapped for this patient at all.
    const ghostPatient = randomUUID();
    const dGhost = await seedDecision(ORG_A, ghostPatient, {
      kind: "discipline_plan_update",
      planKind: "spiritual_plan",
      mutations: [{ op: "goal_update", goalId: randomUUID(), event: "meet" }],
    });
    // A plan whose open version is sealed `in_review`.
    const plan = await seedPlan(ORG_A, { status: "draft_revising" });
    await admin.query(
      `INSERT INTO discipline_care_plan_version (organization_id, provider_entity_id, location_id, plan_id,
         sequence, status, kind, state_snapshot) VALUES ($1,$2,$3,$4,1,'in_review','idg_review','{}'::jsonb)`,
      [ORG_A, peOf[ORG_A], locationOf[ORG_A], plan.planId],
    );
    const dReview = await seedDecision(ORG_A, plan.patientId, {
      kind: "discipline_plan_update",
      planKind: "msw_plan",
      mutations: [{ op: "goal_update", goalId: plan.goalId, event: "meet" }],
    });
    await publishDecision(ORG_A, dGhost);
    await publishDecision(ORG_A, dReview);
    await dispatcher.tick();

    for (const d of [dGhost, dReview]) {
      expect(await applications(d.decisionId)).toHaveLength(0);
      const [row] = await dbRows(
        `SELECT status, attempt_count FROM outbox_event WHERE event_type='idg.decision_recorded' AND aggregate_id=$1`,
        [d.decisionId],
      );
      expect(row?.status).toBe("pending"); // failed attempt recorded, scheduled for retry
      expect(Number(row?.attempt_count)).toBeGreaterThanOrEqual(1);
    }
    expect(
      (await dbRows("SELECT status FROM discipline_goal WHERE id=$1", [plan.goalId]))[0]?.status,
    ).toBe("in_progress");
  });

  it("ignores every other decision arm (M7/M11/M12/M16's), delivering without a write", async () => {
    const plan = await seedPlan(ORG_A);
    const d = await seedDecision(
      ORG_A,
      plan.patientId,
      { kind: "team_note", noteText: "not M15's" },
      "team_note",
    );
    // `team_note` is never emitted in production (non-actionable); publishing it proves M15 returns on any
    // arm that is not its own rather than trusting the emitter.
    await publishDecision(ORG_A, d);
    await settle();
    expect(await applications(d.decisionId)).toHaveLength(0);
    // M15 handled the delivery (a durable receipt, no failed attempt). The row itself stays `pending`
    // only because M7/M11/M12/M16 — the other declared consumers — are not bound in this harness.
    const [row] = await dbRows(
      `SELECT e.attempt_count, e.last_error,
              (SELECT count(*)::int FROM outbox_consumer_receipt r
                WHERE r.event_id = e.id AND r.consumer_name = 'm15.apply-idg-decision') AS receipts
         FROM outbox_event e WHERE e.event_type='idg.decision_recorded' AND e.aggregate_id=$1`,
      [d.decisionId],
    );
    expect(row?.receipts).toBe(1);
    expect(Number(row?.attempt_count)).toBe(0);
    expect(String(row?.last_error)).toMatch(/^deferred:/);
  });

  it("is tenant-isolated: org B cannot apply to org A's plan, and a forged payload organization is refused", async () => {
    const plan = await seedPlan(ORG_A);
    // (1) org B's relay delivers a decision naming org A's patient: B has no such plan → throw, A untouched.
    const dB = await seedDecision(ORG_B, plan.patientId, {
      kind: "discipline_plan_update",
      planKind: "msw_plan",
      mutations: [{ op: "goal_update", goalId: plan.goalId, event: "meet" }],
    });
    await publishDecision(ORG_B, dB);
    // (2) an org A outbox row whose payload claims org B (tamper) → consumer throws before any write.
    const dForged = await seedDecision(ORG_A, plan.patientId, {
      kind: "discipline_plan_update",
      planKind: "msw_plan",
      mutations: [{ op: "goal_update", goalId: plan.goalId, event: "meet" }],
    });
    await publishDecision(ORG_A, dForged, ORG_B);
    await dispatcher.tick();

    expect(await applications(dB.decisionId)).toHaveLength(0);
    expect(await applications(dForged.decisionId)).toHaveLength(0);
    expect(
      (await dbRows("SELECT status FROM discipline_goal WHERE id=$1", [plan.goalId]))[0]?.status,
    ).toBe("in_progress");
    expect(await planStatus(plan.planId)).toBe("active");
  });

  it("the app role can only INSERT/SELECT the two new tables (no UPDATE/DELETE), under RLS", async () => {
    const app = new Client({ connectionString: appRoleUrl(DB_URL as string) });
    await app.connect();
    try {
      await app.query("BEGIN");
      await app.query("SELECT set_config('app.org_id', $1, true)", [ORG_B]);
      // Org B sees none of org A's rows.
      const a = await app.query(
        "SELECT count(*)::int AS n FROM discipline_plan_idg_decision_application",
      );
      const b = await app.query("SELECT count(*)::int AS n FROM idg_decision_application_ack");
      expect(a.rows[0].n).toBe(0);
      expect(b.rows[0].n).toBe(0);
      await app.query("ROLLBACK");
      for (const table of [
        "discipline_plan_idg_decision_application",
        "idg_decision_application_ack",
      ]) {
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
        await expect(app.query(`DELETE FROM ${table}`)).rejects.toThrow(/permission denied/);
        await app.query("ROLLBACK");
        await app.query("BEGIN");
        await app.query("SELECT set_config('app.org_id', $1, true)", [ORG_A]);
        await expect(app.query(`UPDATE ${table} SET mutations_applied = 0`)).rejects.toThrow(
          /permission denied/,
        );
        await app.query("ROLLBACK");
      }
    } finally {
      await app.end();
    }
  });
});
