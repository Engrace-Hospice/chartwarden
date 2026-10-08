import { randomUUID } from "node:crypto";
/**
 * M7L-T02 — the Drizzle care-plan WRITE lifecycle, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `wardenx_app` role: bootstrap opens the plan + its initial draft
 * version; problem/goal/intervention authoring runs the §2.3 validators; the version aggregate goes
 * draft → in_review → signed through the D5 quorum with §7.7 optimistic concurrency; and RLS scopes every
 * row by tenant. Unlike the M6 outbox slices (which ran against a NOOP), this suite binds the REAL
 * catalog-validating transactional publisher (buildBootOutboxCatalog([M7_OUTBOX_EVENTS]) → the caller's
 * tx) and asserts the `m7.*` rows actually land in `outbox_event` — so the boot-catalog wiring is proven,
 * not assumed.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m7:write:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type CarePlanWriteOutboxPort,
  M7_OUTBOX_EVENTS,
  buildM7AdmissionActivatedConsumer,
  buildM7AdmissionDischargedConsumer,
  buildM7IdgDecisionConsumer,
  createDbCarePlanAbacResolver,
  createDbCarePlanRouteService,
} from "../src/modules/07-care-plan/index";
import { runCarePlanGatesCron } from "../src/modules/07-care-plan/jobs/cron-workers";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const MEMBER = "44444444-4444-4444-4444-444444444444";

// GAP-011: signing is bound to the actor, so each signer slot needs its own person holding that role.
const SIGNER_ROLES = [
  "rn_case_manager",
  "hospice_physician",
  "nurse_practitioner",
  "msw",
  "chaplain",
  "medical_director",
] as const;
const signerIds = (role: string) => {
  const n = SIGNER_ROLES.indexOf(role as (typeof SIGNER_ROLES)[number]) + 1;
  const tail = String(n).padStart(12, "0");
  return { userId: `5555555${n}-5555-4555-8555-${tail}`, membershipId: `6666666${n}-6666-4666-8666-${tail}` };
};
const signerFor = (role: string) => ({ ...signerIds(role), roles: [role] });

type Boot = { id: string; initialVersionId: string; version: number };
type Element = { id: string; status: string; version: number };
type Version = {
  id: string;
  status: string;
  version: number;
  signatures: unknown[];
  stateSnapshot: unknown;
};

describe.skipIf(!DB_URL)("M7 care-plan write lifecycle — LIVE Postgres (M7L-T02)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbCarePlanRouteService>;

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

  /** The `m7.*` events persisted for an aggregate, event-type only (asserts the catalog wiring). */
  async function eventsFor(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
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
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'m7t2@x.test')`, [USER]);
    await admin.query(
      "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')",
      [MEMBER, USER, ORG_A],
    );
    for (const role of SIGNER_ROLES) {
      const { userId, membershipId } = signerIds(role);
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [userId, `${role}@m7.test`]);
      await admin.query(
        "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')",
        [membershipId, userId, ORG_A],
      );
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    // The REAL transactional publisher, catalog-validated against M7's `m7.*` contract and pinned to
    // caller-module `m7` — the same wiring the composition root binds (bindCallerModule is private there).
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M7_OUTBOX_EVENTS]));
    const outbox: CarePlanWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m7" }),
    };
    svc = createDbCarePlanRouteService(handle.db, outbox);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("bootstrap opens the plan + its initial draft version and emits m7.care_plan.created/version_drafted", async () => {
    const admissionId = randomUUID();
    const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), admissionId)) as Boot;
    expect(boot.version).toBe(1);
    expect(boot.initialVersionId).toBeTruthy();
    const v = (await svc.getVersion(ORG_A, boot.id, boot.initialVersionId)) as Version;
    expect(v.status).toBe("draft");
    expect(v.version).toBe(1);
    expect(await eventsFor(boot.id)).toContain("m7.care_plan.created");
    expect(await eventsFor(boot.initialVersionId)).toContain("m7.care_plan.version_drafted");
  });

  it("one active plan per admission — a second bootstrap for the same admission is 409", async () => {
    const admissionId = randomUUID();
    await svc.bootstrapCarePlan(ORG_A, randomUUID(), admissionId);
    await expect(svc.bootstrapCarePlan(ORG_A, randomUUID(), admissionId)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("m6.admission.activated consumer bootstraps exactly one root and one initial draft on replay", async () => {
    const admissionId = randomUUID();
    const patientId = randomUUID();
    const consumer = buildM7AdmissionActivatedConsumer({ db: handle.db, outbox: svcOutbox() });
    const event = {
      id: randomUUID(),
      organizationId: ORG_A,
      eventType: "m6.admission.activated",
      aggregateKind: "admission",
      aggregateId: admissionId,
      attemptCount: 0,
      createdAt: new Date(),
      payload: {
        admissionId,
        patientId,
        activatedAt: "2026-06-21T12:00:00.000Z",
      },
    };
    await consumer.handle(event);
    await consumer.handle({ ...event, id: randomUUID() });
    const plans = await admin.query("SELECT id,status FROM care_plan WHERE admission_id=$1", [
      admissionId,
    ]);
    expect(plans.rowCount).toBe(1);
    expect(plans.rows[0].status).toBe("draft");
    const versions = await admin.query(
      "SELECT kind,status FROM care_plan_version WHERE care_plan_id=$1",
      [plans.rows[0].id],
    );
    expect(versions.rowCount).toBe(1);
    expect(versions.rows[0]).toMatchObject({ kind: "initial", status: "draft" });
  });

  function svcOutbox(): CarePlanWriteOutboxPort {
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M7_OUTBOX_EVENTS]));
    return {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m7" }),
    };
  }

  async function activePlanWithTerminalProblem(description = "Terminal illness") {
    const patientId = randomUUID();
    const boot = (await svc.bootstrapCarePlan(ORG_A, patientId, randomUUID())) as Boot;
    const problem = (await svc.addProblem(ORG_A, boot.id, {
      description,
      kind: "terminal",
      source: "clinical",
    })) as Element;
    await svc.finalizeVersion(ORG_A, boot.id, boot.initialVersionId, 1, null);
    await svc.signVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      2,
      "rn_case_manager",
      "2026-06-21T12:00:00.000Z",
      signerFor("rn_case_manager"),
    );
    await svc.signVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      3,
      "hospice_physician",
      "2026-06-21T12:05:00.000Z",
      signerFor("hospice_physician"),
    );
    return { boot, patientId, problem };
  }

  function idgEvent(input: {
    patientId: string;
    decisionId?: string;
    meetingId?: string;
    mutations: readonly Record<string, unknown>[];
  }) {
    const decisionId = input.decisionId ?? randomUUID();
    const meetingId = input.meetingId ?? randomUUID();
    return {
      id: randomUUID(),
      organizationId: ORG_A,
      eventType: "idg.decision_recorded",
      aggregateKind: "idg_decision",
      aggregateId: decisionId,
      attemptCount: 0,
      createdAt: new Date(),
      payload: {
        organizationId: ORG_A,
        payloadSchemaVersion: "2026-01-v1",
        decisionId,
        meetingId,
        patientId: input.patientId,
        recordedByMembershipId: MEMBER,
        payload: {
          kind: "care_plan_update",
          mutations: input.mutations,
        },
      },
    };
  }

  it("rejects finalize before an active terminal problem exists, then allows it after one is added", async () => {
    const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
    await expect(
      svc.finalizeVersion(ORG_A, boot.id, boot.initialVersionId, 1, null),
    ).rejects.toMatchObject({
      code: "CARE_PLAN_NOT_READY",
      statusCode: 422,
    });
    await svc.addProblem(ORG_A, boot.id, {
      description: "Terminal decline",
      kind: "terminal",
      source: "clinical",
    });
    const ready = (await svc.finalizeVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      1,
      null,
    )) as Version;
    expect(ready.status).toBe("in_review");
    expect(ready.stateSnapshot).toMatchObject({
      schemaVersion: "2026-08-m7-v1",
      problems: [expect.objectContaining({ kind: "terminal", status: "active" })],
    });
  });

  it("rejects a second open draft and the DB partial unique index enforces the same invariant", async () => {
    const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
    await expect(svc.createVersion(ORG_A, boot.id, "interim_revision", null)).rejects.toMatchObject(
      {
        code: "OPEN_VERSION_EXISTS",
        statusCode: 409,
      },
    );
    await expect(
      admin.query(
        "INSERT INTO care_plan_version (organization_id, care_plan_id, sequence, kind, status, required_signer_set) VALUES ($1,$2,99,'interim_revision','draft',$3)",
        [ORG_A, boot.id, JSON.stringify([{ role: "rn_case_manager", count: 1 }])],
      ),
    ).rejects.toThrow();
  });

  it("authoring → finalize → the D5 initial quorum signs the version and activates the plan", async () => {
    const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
    const prob = (await svc.addProblem(ORG_A, boot.id, {
      description: "End-stage COPD",
      kind: "terminal",
      source: "clinical",
    })) as Element;
    await svc.addGoal(
      ORG_A,
      boot.id,
      {
        problemId: prob.id,
        originalText: "I want to stay comfortable at home",
        source: "patient_stated",
      },
      false,
    );
    await svc.addIntervention(ORG_A, boot.id, {
      problemId: prob.id,
      scopeText: "Assess dyspnea each visit",
      frequencyText: "2x/week",
      frequencyValue: "2:visit:week",
      discipline: "rn",
    });
    // draft (v1) → in_review (v2)
    const finalized = (await svc.finalizeVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      1,
      null,
    )) as Version;
    expect(finalized.status).toBe("in_review");
    expect(finalized.version).toBe(2);
    // First required signature (RN case manager) — quorum not yet met.
    const sig1 = (await svc.signVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      2,
      "rn_case_manager",
      new Date().toISOString(),
      signerFor("rn_case_manager"),
      "Patient verbalized understanding",
    )) as Version;
    expect(sig1.status).toBe("in_review");
    // GAP-011 — the claimed slot is bound to the actor. The RN holds only rn_case_manager…
    await expect(
      svc.signVersion(
        ORG_A,
        boot.id,
        boot.initialVersionId,
        3,
        "hospice_physician",
        new Date().toISOString(),
        signerFor("rn_case_manager"),
      ),
    ).rejects.toMatchObject({ code: "SIGNER_ROLE_MISMATCH" });
    // …and even holding BOTH roles, the same membership cannot fill a second slot.
    await expect(
      svc.signVersion(
        ORG_A,
        boot.id,
        boot.initialVersionId,
        3,
        "hospice_physician",
        new Date().toISOString(),
        { ...signerFor("rn_case_manager"), roles: ["rn_case_manager", "hospice_physician"] },
      ),
    ).rejects.toMatchObject({ code: "SIGNER_ALREADY_SIGNED" });
    // The DB backstop (migration 0620) refuses the same duplicate even if a caller skipped the check.
    await expect(
      admin.query(
        `INSERT INTO care_plan_signature (organization_id, care_plan_version_id, membership_id, signer_role, signature_method, signed_at)
         VALUES ($1,$2,$3,'hospice_physician','password_step_up',now())`,
        [ORG_A, boot.initialVersionId, signerIds("rn_case_manager").membershipId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    // The attending (hospice physician) fills the second slot — quorum met → signed + plan active.
    const sig2 = (await svc.signVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      3,
      "hospice_physician",
      new Date().toISOString(),
      signerFor("hospice_physician"),
    )) as Version;
    expect(sig2.status).toBe("signed");
    expect(sig2.signatures.length).toBe(2);
    const [row] = (
      await admin.query("SELECT status, active_version_id FROM care_plan WHERE id=$1", [boot.id])
    ).rows;
    expect(row.status).toBe("active");
    expect(row.active_version_id).toBe(boot.initialVersionId);
    expect(await eventsFor(boot.initialVersionId)).toContain("m7.care_plan.version_signed");
    const sigRows = await admin.query(
      "SELECT membership_id FROM care_plan_signature WHERE care_plan_version_id=$1 AND invalidated_at IS NULL",
      [boot.initialVersionId],
    );
    // GAP-011: one membership per slot — the two signatures carry two DIFFERENT memberships.
    expect(new Set(sigRows.rows.map((r) => r.membership_id)).size).toBe(2);
    const [versionRow] = (
      await admin.query(
        "SELECT patient_understanding_text, state_snapshot FROM care_plan_version WHERE id=$1",
        [boot.initialVersionId],
      )
    ).rows;
    expect(versionRow.patient_understanding_text).toBe("Patient verbalized understanding");
    expect(versionRow.state_snapshot.problems).toHaveLength(1);
  });

  it("in-review snapshot remains frozen across working-state edits, return-to-draft clears it, and next finalize recreates it", async () => {
    const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
    const prob = (await svc.addProblem(ORG_A, boot.id, {
      description: "Original terminal problem",
      kind: "terminal",
      source: "clinical",
    })) as Element;
    await svc.finalizeVersion(ORG_A, boot.id, boot.initialVersionId, 1, null);
    const [before] = (
      await admin.query("SELECT state_snapshot FROM care_plan_version WHERE id=$1", [
        boot.initialVersionId,
      ])
    ).rows;
    await svc.patchProblem(ORG_A, boot.id, prob.id, prob.version, {
      description: "Mutated working problem",
    });
    const [afterMutation] = (
      await admin.query("SELECT state_snapshot FROM care_plan_version WHERE id=$1", [
        boot.initialVersionId,
      ])
    ).rows;
    expect(afterMutation.state_snapshot).toEqual(before.state_snapshot);

    await svc.signVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      2,
      "rn_case_manager",
      new Date().toISOString(),
      signerFor("rn_case_manager"),
    );
    await svc.returnVersionToDraft(ORG_A, boot.id, boot.initialVersionId, 3);
    const [returned] = (
      await admin.query("SELECT state_snapshot FROM care_plan_version WHERE id=$1", [
        boot.initialVersionId,
      ])
    ).rows;
    expect(returned.state_snapshot).toBeNull();
    const invalidated = await admin.query(
      "SELECT count(*)::int AS n FROM care_plan_signature WHERE care_plan_version_id=$1 AND invalidated_at IS NOT NULL",
      [boot.initialVersionId],
    );
    expect(Number(invalidated.rows[0].n)).toBe(1);

    const next = (await svc.finalizeVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      4,
      null,
    )) as Version;
    expect(next.stateSnapshot).toMatchObject({
      problems: [expect.objectContaining({ description: "Mutated working problem" })],
    });
  });

  it("a future signed revision supersedes the previous active signed version atomically", async () => {
    const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
    await svc.addProblem(ORG_A, boot.id, {
      description: "Terminal illness",
      kind: "terminal",
      source: "clinical",
    });
    await svc.finalizeVersion(ORG_A, boot.id, boot.initialVersionId, 1, null);
    await svc.signVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      2,
      "rn_case_manager",
      "2026-06-21T12:00:00.000Z",
      signerFor("rn_case_manager"),
    );
    await svc.signVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      3,
      "hospice_physician",
      "2026-06-21T12:05:00.000Z",
      signerFor("hospice_physician"),
    );

    const rev = (await svc.createVersion(ORG_A, boot.id, "interim_revision", null)) as Version;
    await svc.finalizeVersion(ORG_A, boot.id, rev.id, rev.version, null);
    await svc.signVersion(
      ORG_A,
      boot.id,
      rev.id,
      2,
      "rn_case_manager",
      "2026-06-22T12:00:00.000Z",
      signerFor("rn_case_manager"),
    );
    await svc.signVersion(
      ORG_A,
      boot.id,
      rev.id,
      3,
      "nurse_practitioner",
      "2026-06-22T12:05:00.000Z",
      signerFor("nurse_practitioner"),
    );

    const versions = await admin.query(
      "SELECT id,status,superseded_at FROM care_plan_version WHERE care_plan_id=$1 ORDER BY sequence",
      [boot.id],
    );
    expect(versions.rows[0]).toMatchObject({ id: boot.initialVersionId, status: "superseded" });
    expect(versions.rows[0].superseded_at).toBeTruthy();
    expect(versions.rows[1]).toMatchObject({ id: rev.id, status: "signed" });
    const [planRow] = (
      await admin.query("SELECT active_version_id,status FROM care_plan WHERE id=$1", [boot.id])
    ).rows;
    expect(planRow).toMatchObject({ active_version_id: rev.id, status: "active" });
  });

  it("idg.decision_recorded persists a proposal and leaves active clinical rows unchanged", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    await consumer.handle(
      idgEvent({
        patientId,
        mutations: [
          {
            op: "problem_update",
            problemId: problem.id,
            updates: { description: "IDG proposed terminal wording" },
          },
        ],
      }),
    );

    const [problemRow] = (
      await admin.query("SELECT description FROM problem WHERE id=$1", [problem.id])
    ).rows;
    expect(problemRow.description).toBe("Baseline terminal");
    const proposal = await svc.getProposedChanges(
      ORG_A,
      boot.id,
      (
        await admin.query(
          "SELECT id FROM care_plan_version WHERE care_plan_id=$1 AND kind='idg_review'",
          [boot.id],
        )
      ).rows[0].id,
    );
    expect((proposal as { changes: unknown[] }).changes).toHaveLength(1);
  });

  it("IDG proposal delivery is idempotent by decision and creates no duplicate mutations", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    const event = idgEvent({
      patientId,
      mutations: [
        {
          op: "problem_update",
          problemId: problem.id,
          updates: { description: "IDG proposed terminal wording" },
        },
      ],
    });
    await consumer.handle(event);
    await consumer.handle({ ...event, id: randomUUID() });

    const apps = await admin.query(
      "SELECT count(*)::int AS n FROM care_plan_idg_decision_application WHERE care_plan_id=$1",
      [boot.id],
    );
    const changes = await admin.query(
      "SELECT count(*)::int AS n FROM care_plan_idg_proposed_change WHERE care_plan_id=$1",
      [boot.id],
    );
    expect(Number(apps.rows[0].n)).toBe(1);
    expect(Number(changes.rows[0].n)).toBe(1);
  });

  it("IDG finalize snapshots the candidate state while working rows stay unchanged until quorum", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    await consumer.handle(
      idgEvent({
        patientId,
        mutations: [
          {
            op: "problem_update",
            problemId: problem.id,
            updates: { description: "IDG candidate terminal wording" },
          },
        ],
      }),
    );
    const [review] = (
      await admin.query(
        "SELECT id,version FROM care_plan_version WHERE care_plan_id=$1 AND kind='idg_review'",
        [boot.id],
      )
    ).rows;
    const finalized = (await svc.finalizeVersion(
      ORG_A,
      boot.id,
      review.id,
      review.version,
      null,
    )) as Version | { stateSnapshot: { problems: { description: string }[] } };
    expect(JSON.stringify(finalized.stateSnapshot)).toContain("IDG candidate terminal wording");
    const [problemRow] = (
      await admin.query("SELECT description FROM problem WHERE id=$1", [problem.id])
    ).rows;
    expect(problemRow.description).toBe("Baseline terminal");
  });

  it("partial IDG signatures keep the proposal unapplied and the active content unchanged", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    await consumer.handle(
      idgEvent({
        patientId,
        mutations: [
          {
            op: "problem_update",
            problemId: problem.id,
            updates: { description: "Partially signed wording" },
          },
        ],
      }),
    );
    const [review] = (
      await admin.query(
        "SELECT id,version FROM care_plan_version WHERE care_plan_id=$1 AND kind='idg_review'",
        [boot.id],
      )
    ).rows;
    await svc.finalizeVersion(ORG_A, boot.id, review.id, review.version, null);
    const sig = (await svc.signVersion(
      ORG_A,
      boot.id,
      review.id,
      review.version + 1,
      "rn_case_manager",
      "2026-06-22T12:00:00.000Z",
      signerFor("rn_case_manager"),
    )) as Version;
    expect(sig.status).toBe("in_review");
    const [problemRow] = (
      await admin.query("SELECT description FROM problem WHERE id=$1", [problem.id])
    ).rows;
    expect(problemRow.description).toBe("Baseline terminal");
  });

  it("final IDG quorum applies proposals once, signs/currentizes the version, and supersedes prior", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    await consumer.handle(
      idgEvent({
        patientId,
        mutations: [
          {
            op: "problem_update",
            problemId: problem.id,
            updates: { description: "Signed IDG terminal wording" },
          },
        ],
      }),
    );
    const [review] = (
      await admin.query(
        "SELECT id,version FROM care_plan_version WHERE care_plan_id=$1 AND kind='idg_review'",
        [boot.id],
      )
    ).rows;
    await svc.finalizeVersion(ORG_A, boot.id, review.id, review.version, null);
    let version = review.version + 1;
    const signerRoles = ["rn_case_manager", "msw", "chaplain", "medical_director"] as const;
    for (const role of signerRoles.slice(0, -1)) {
      await svc.signVersion(ORG_A, boot.id, review.id, version, role, "2026-06-22T12:00:00.000Z", signerFor(role));
      version++;
    }
    await admin.query(
      "UPDATE care_plan SET review_due_emitted=true, review_overdue_emitted=true WHERE id=$1",
      [boot.id],
    );
    await svc.signVersion(
      ORG_A,
      boot.id,
      review.id,
      version,
      signerRoles[signerRoles.length - 1],
      "2026-06-22T12:00:00.000Z",
      signerFor(signerRoles[signerRoles.length - 1]),
    );
    const [problemRow] = (
      await admin.query("SELECT description FROM problem WHERE id=$1", [problem.id])
    ).rows;
    expect(problemRow.description).toBe("Signed IDG terminal wording");
    const [planRow] = (
      await admin.query(
        "SELECT active_version_id,next_review_due_at,review_due_emitted,review_overdue_emitted FROM care_plan WHERE id=$1",
        [boot.id],
      )
    ).rows;
    expect(planRow.active_version_id).toBe(review.id);
    expect(planRow.next_review_due_at).toBeTruthy();
    expect(planRow.review_due_emitted).toBe(false);
    expect(planRow.review_overdue_emitted).toBe(false);
    const versions = await admin.query(
      "SELECT id,status FROM care_plan_version WHERE care_plan_id=$1 ORDER BY sequence",
      [boot.id],
    );
    expect(versions.rows[0]).toMatchObject({ id: boot.initialVersionId, status: "superseded" });
    expect(versions.rows[1]).toMatchObject({ id: review.id, status: "signed" });
    const apps = await admin.query(
      "SELECT status FROM care_plan_idg_decision_application WHERE care_plan_version_id=$1",
      [review.id],
    );
    expect(apps.rows[0].status).toBe("applied");
  });

  it("returning an in-review IDG proposal to draft invalidates signatures without mutating active content", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    await consumer.handle(
      idgEvent({
        patientId,
        mutations: [
          {
            op: "problem_update",
            problemId: problem.id,
            updates: { description: "Returned IDG wording" },
          },
        ],
      }),
    );
    const [review] = (
      await admin.query(
        "SELECT id,version FROM care_plan_version WHERE care_plan_id=$1 AND kind='idg_review'",
        [boot.id],
      )
    ).rows;
    await svc.finalizeVersion(ORG_A, boot.id, review.id, review.version, null);
    await svc.signVersion(
      ORG_A,
      boot.id,
      review.id,
      review.version + 1,
      "rn_case_manager",
      "2026-06-22T12:00:00.000Z",
      signerFor("rn_case_manager"),
    );
    await svc.returnVersionToDraft(ORG_A, boot.id, review.id, review.version + 2);
    const [problemRow] = (
      await admin.query("SELECT description FROM problem WHERE id=$1", [problem.id])
    ).rows;
    expect(problemRow.description).toBe("Baseline terminal");
    const [appRow] = (
      await admin.query(
        "SELECT status FROM care_plan_idg_decision_application WHERE care_plan_version_id=$1",
        [review.id],
      )
    ).rows;
    expect(appRow.status).toBe("proposed");
  });

  it("stale IDG proposals conflict instead of overwriting newer working care-plan state", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    await consumer.handle(
      idgEvent({
        patientId,
        mutations: [
          {
            op: "problem_update",
            problemId: problem.id,
            updates: { description: "Stale IDG wording" },
          },
        ],
      }),
    );
    await svc.patchProblem(ORG_A, boot.id, problem.id, problem.version, {
      description: "Independent clinician update",
    });
    const [review] = (
      await admin.query(
        "SELECT id,version FROM care_plan_version WHERE care_plan_id=$1 AND kind='idg_review'",
        [boot.id],
      )
    ).rows;
    await expect(
      svc.finalizeVersion(ORG_A, boot.id, review.id, review.version, null),
    ).rejects.toMatchObject({
      code: "IDG_PROPOSAL_CONFLICT",
    });
    const [problemRow] = (
      await admin.query("SELECT description FROM problem WHERE id=$1", [problem.id])
    ).rows;
    expect(problemRow.description).toBe("Independent clinician update");
  });

  it("manual open revision blocks IDG proposal creation without mutating active content", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    await svc.createVersion(ORG_A, boot.id, "interim_revision", null);
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    await expect(
      consumer.handle(
        idgEvent({
          patientId,
          mutations: [
            {
              op: "problem_update",
              problemId: problem.id,
              updates: { description: "Blocked IDG wording" },
            },
          ],
        }),
      ),
    ).rejects.toThrow("incompatible care-plan version is already open");
    const [problemRow] = (
      await admin.query("SELECT description FROM problem WHERE id=$1", [problem.id])
    ).rows;
    expect(problemRow.description).toBe("Baseline terminal");
  });

  it("review status moves not_due → due → overdue without auto-creating revisions", async () => {
    const { boot } = await activePlanWithTerminalProblem("Baseline terminal");
    expect(await svc.getReviewStatus(ORG_A, boot.id, "2026-06-22T12:00:00.000Z")).toMatchObject({
      status: "not_due",
      canStartReview: true,
    });
    expect(await svc.getReviewStatus(ORG_A, boot.id, "2026-07-04T12:00:00.000Z")).toMatchObject({
      status: "due",
    });
    expect(await svc.getReviewStatus(ORG_A, boot.id, "2026-07-07T12:00:00.000Z")).toMatchObject({
      status: "overdue",
    });
  });

  it("m6.admission.discharged closes an active M7 root idempotently without fabricating a discharge version", async () => {
    const admissionId = randomUUID();
    const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), admissionId)) as Boot;
    const consumer = buildM7AdmissionDischargedConsumer({ db: handle.db, outbox: svcOutbox() });
    const event = {
      id: randomUUID(),
      organizationId: ORG_A,
      eventType: "m6.admission.discharged",
      aggregateKind: "admission",
      aggregateId: admissionId,
      attemptCount: 0,
      createdAt: new Date(),
      payload: {
        admissionId,
        reason: "transfer",
        dischargeDate: "2026-06-30T00:00:00.000Z",
      },
    };
    await consumer.handle(event);
    await consumer.handle({ ...event, id: randomUUID() });
    const [planRow] = (await admin.query("SELECT status FROM care_plan WHERE id=$1", [boot.id]))
      .rows;
    expect(planRow.status).toBe("discharged");
    const count = await admin.query(
      "SELECT count(*)::int AS n FROM care_plan_version WHERE care_plan_id=$1",
      [boot.id],
    );
    expect(Number(count.rows[0].n)).toBe(1);
  });

  it("§7.7 optimistic concurrency — a stale ifVersion patch is 412, a fresh one bumps the version", async () => {
    const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
    const prob = (await svc.addProblem(ORG_A, boot.id, {
      description: "Cachexia",
      kind: "related",
      source: "clinical",
    })) as Element;
    await expect(
      svc.patchProblem(ORG_A, boot.id, prob.id, prob.version + 99, { description: "x" }),
    ).rejects.toMatchObject({ statusCode: 412 });
    const patched = (await svc.patchProblem(ORG_A, boot.id, prob.id, prob.version, {
      description: "Cancer cachexia",
    })) as Element;
    expect(patched.version).toBe(prob.version + 1);
  });

  it("§7.4 discipline_scope — authoring an intervention outside the actor's discipline is 403", async () => {
    const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
    const prob = (await svc.addProblem(ORG_A, boot.id, {
      description: "Spiritual distress",
      kind: "related",
      source: "clinical",
    })) as Element;
    await expect(
      svc.addIntervention(
        ORG_A,
        boot.id,
        {
          problemId: prob.id,
          scopeText: "Nursing dressing change",
          frequencyText: "daily",
          frequencyValue: "1:visit:day",
          discipline: "rn",
        },
        { disciplines: ["msw"], isIdgCoordinator: false },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("return-to-draft clears the collected signatures (D8)", async () => {
    const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
    await svc.addProblem(ORG_A, boot.id, {
      description: "Pain",
      kind: "terminal",
      source: "clinical",
    });
    await svc.finalizeVersion(ORG_A, boot.id, boot.initialVersionId, 1, null);
    await svc.signVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      2,
      "rn_case_manager",
      new Date().toISOString(),
      signerFor("rn_case_manager"),
    );
    const returned = (await svc.returnVersionToDraft(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      3,
    )) as Version;
    expect(returned.status).toBe("draft");
    expect(returned.signatures.length).toBe(0);
  });

  it("RLS — org B cannot read or write org A's plan (non-leaking 404)", async () => {
    const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
    await expect(svc.getVersion(ORG_B, boot.id, boot.initialVersionId)).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(svc.createVersion(ORG_B, boot.id, "interim_revision", null)).rejects.toMatchObject(
      { statusCode: 404 },
    );
  });

  it("the Drizzle CarePlanAbacResolver resolves real plan/problem/version facts and fails closed cross-tenant", async () => {
    const resolver = createDbCarePlanAbacResolver(handle.db);
    const patientId = randomUUID();
    const boot = (await svc.bootstrapCarePlan(ORG_A, patientId, randomUUID())) as Boot & {
      patientId: string;
    };
    const sudProblem = (await svc.addProblem(ORG_A, boot.id, {
      description: "Opioid use disorder",
      kind: "terminal",
      source: "clinical",
      sudRelated: true,
    })) as Element;

    // loadPlan → the plan's patient (the caseload_or_scope / dpoa_active plan-arm).
    expect(await resolver.loadPlan(ORG_A, boot.id)).toEqual({ planId: boot.id, patientId });
    // loadProblem → the §7.6 SUD facts (sud_disclosure_allowed).
    expect(await resolver.loadProblem(ORG_A, sudProblem.id)).toEqual({
      planId: boot.id,
      patientId,
      sudRelated: true,
    });
    // loadVersion → the D5 quorum the caller's signer roles must intersect (signer_role_match).
    const version = await resolver.loadVersion(ORG_A, boot.initialVersionId);
    expect(version?.planId).toBe(boot.id);
    expect(Array.isArray(version?.requiredSignerSet)).toBe(true);
    expect(version?.requiredSignerSet.length ?? 0).toBeGreaterThan(0);

    // Fail-closed: RLS hides org A's rows from org B → every loader returns null (never leaks existence).
    expect(await resolver.loadPlan(ORG_B, boot.id)).toBeNull();
    expect(await resolver.loadProblem(ORG_B, sudProblem.id)).toBeNull();
    expect(await resolver.loadVersion(ORG_B, boot.initialVersionId)).toBeNull();
    // A non-existent id (and a non-problem element id) also fails closed.
    expect(await resolver.loadProblem(ORG_A, randomUUID())).toBeNull();
  });

  it("the care-plan gates cron flips its marker under the NULL (system) audit actor, not a sentinel uuid", async () => {
    // Before the fix the cron stamped `00000000-…-000000000007` into `app.user_id`; the `care_plan`
    // write-audit trigger copied it into `audit_event.actor_user_id` (FK to `user`) → 23503 every tick.
    const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
    await admin.query(
      "UPDATE care_plan SET initial_due_at = now() - interval '1 day', initial_warning_emitted = false WHERE id=$1",
      [boot.id],
    );
    await runCarePlanGatesCron({
      connection: {} as never,
      db: handle.db,
      outbox: svcOutbox() as never,
      activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_A }] },
      now: () => new Date(),
    });
    const row = (
      await admin.query("SELECT initial_warning_emitted FROM care_plan WHERE id=$1", [boot.id])
    ).rows[0] as { initial_warning_emitted: boolean };
    expect(row.initial_warning_emitted).toBe(true);
    expect(await eventsFor(boot.id)).toContain("m7.care_plan.initial_overdue");
    const audit = await admin.query(
      "SELECT actor_user_id FROM audit_event WHERE resource_id=$1 AND event_type='care_plan.update'",
      [boot.id],
    );
    expect(audit.rows.length).toBeGreaterThan(0);
    expect(audit.rows.every((r) => r.actor_user_id === null)).toBe(true);
  });
});
