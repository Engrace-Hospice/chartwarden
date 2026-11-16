import { randomUUID } from "node:crypto";
/**
 * M7L-T02 — the Drizzle care-plan WRITE lifecycle, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `chartwarden_app` role: bootstrap opens the plan + its initial draft
 * version; problem/goal/intervention authoring runs the §2.3 validators; the version aggregate goes
 * draft → in_review → signed through the D5 quorum with §7.7 optimistic concurrency; and RLS scopes every
 * row by tenant. Unlike the M6 outbox slices (which ran against a NOOP), this suite binds the REAL
 * catalog-validating transactional publisher (buildBootOutboxCatalog([M7_OUTBOX_EVENTS]) → the caller's
 * tx) and asserts the `m7.*` rows actually land in `outbox_event` — so the boot-catalog wiring is proven,
 * not assumed.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m7:write:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OutboxDeferral } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  type CarePlanWriteOutboxPort,
  M7_OUTBOX_EVENTS,
  activeProblemIdsForOrg,
  buildM7AdmissionActivatedConsumer,
  buildM7AdmissionDischargedConsumer,
  buildM7IdgDecisionConsumer,
  createDbCarePlanAbacResolver,
  createDbCarePlanRouteService,
  createDrizzleCarePlanReaderStore,
  idgPacketCarePlanContextForOrg,
} from "../src/modules/07-care-plan/index";
import { runCarePlanGatesCron } from "../src/modules/07-care-plan/jobs/cron-workers";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const MEMBER = "44444444-4444-4444-4444-444444444444";
/** Older than the 14-day wait horizon, after which an IDG decision stops waiting and is recorded as refused. */
const STALE_DECISION_MS = 15 * 24 * 60 * 60_000;

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
  return {
    userId: `5555555${n}-5555-4555-8555-${tail}`,
    membershipId: `6666666${n}-6666-4666-8666-${tail}`,
  };
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
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [
        userId,
        `${role}@m7.test`,
      ]);
      await admin.query(
        "INSERT INTO membership (id,user_id,organization_id,status) VALUES ($1,$2,$3,'active')",
        [membershipId, userId, ORG_A],
      );
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
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
    const ready = (await svc.finalizeVersion(ORG_A, boot.id, boot.initialVersionId, 1, null, {
      sudDisclosureAllowed: true,
    })) as Version;
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

    const next = (await svc.finalizeVersion(ORG_A, boot.id, boot.initialVersionId, 4, null, {
      sudDisclosureAllowed: true,
    })) as Version;
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
    const finalized = (await svc.finalizeVersion(ORG_A, boot.id, review.id, review.version, null, {
      sudDisclosureAllowed: true,
    })) as Version | { stateSnapshot: { problems: { description: string }[] } };
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
      await svc.signVersion(
        ORG_A,
        boot.id,
        review.id,
        version,
        role,
        "2026-06-22T12:00:00.000Z",
        signerFor(role),
      );
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

  it("an IDG decision that meets an open revision WAITS (deferred, nothing written), then proposes once the revision is signed", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    const rev = (await svc.createVersion(ORG_A, boot.id, "interim_revision", null)) as Version;
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    const event = idgEvent({
      patientId,
      mutations: [
        {
          op: "problem_update",
          problemId: problem.id,
          updates: { description: "Waits for the revision" },
        },
      ],
    });
    const decisionId = event.payload.decisionId;
    const rowsFor = async (sqlText: string) =>
      Number((await admin.query(sqlText, [decisionId])).rows[0].n);

    // Fresh event + open revision: the handler asks the relay to retry later; nothing is recorded or refused.
    await expect(consumer.handle(event)).rejects.toBeInstanceOf(OutboxDeferral);
    expect(
      await rowsFor(
        "SELECT count(*)::int AS n FROM care_plan_idg_decision_application WHERE idg_decision_id=$1",
      ),
    ).toBe(0);
    expect(
      await rowsFor(
        "SELECT count(*)::int AS n FROM audit_event WHERE event_type='m7.care_plan.idg_proposal_refused' AND context->>'decisionId'=$1",
      ),
    ).toBe(0);

    // The revision is signed: the very same delivery now becomes a governed proposal.
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
    await consumer.handle(event);
    const apps = await admin.query(
      "SELECT status FROM care_plan_idg_decision_application WHERE idg_decision_id=$1",
      [decisionId],
    );
    expect(apps.rows).toEqual([{ status: "proposed" }]);
  });

  it("an IDG decision for a draft plan WAITS for the plan to be signed instead of being refused", async () => {
    const patientId = randomUUID();
    await svc.bootstrapCarePlan(ORG_A, patientId, randomUUID());
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    const event = idgEvent({
      patientId,
      mutations: [
        {
          op: "problem_add",
          icd10Code: null,
          snomedCode: null,
          description: "Waits for the plan",
          problemKind: "related",
        },
      ],
    });
    await expect(consumer.handle(event)).rejects.toBeInstanceOf(OutboxDeferral);
    const apps = await admin.query(
      "SELECT count(*)::int AS n FROM care_plan_idg_decision_application WHERE idg_decision_id=$1",
      [event.payload.decisionId],
    );
    expect(Number(apps.rows[0].n)).toBe(0);
  });

  it("two mutations of ONE decision on the same element are refused up front (applied in sequence they could wedge finalize)", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    const event = idgEvent({
      patientId,
      mutations: [
        { op: "problem_update", problemId: problem.id, updates: { description: "First wording" } },
        { op: "problem_update", problemId: problem.id, updates: { description: "Second wording" } },
      ],
    });
    await consumer.handle(event);

    const apps = await admin.query(
      "SELECT status, conflict_reason FROM care_plan_idg_decision_application WHERE idg_decision_id=$1",
      [event.payload.decisionId],
    );
    expect(apps.rows).toHaveLength(1);
    expect(apps.rows[0].status).toBe("conflict");
    expect(apps.rows[0].conflict_reason).toContain("element_targeted_twice");
    // refused before any version was opened or any change written
    const opened = await admin.query(
      "SELECT count(*)::int AS n FROM care_plan_version WHERE care_plan_id=$1 AND kind='idg_review'",
      [boot.id],
    );
    expect(Number(opened.rows[0].n)).toBe(0);
    const changes = await admin.query(
      "SELECT count(*)::int AS n FROM care_plan_idg_proposed_change WHERE care_plan_id=$1",
      [boot.id],
    );
    expect(Number(changes.rows[0].n)).toBe(0);
  });

  it("the same element named in two letter cases is still one element (uuid ids compare case-insensitively)", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    const event = idgEvent({
      patientId,
      mutations: [
        { op: "problem_update", problemId: problem.id, updates: { description: "First wording" } },
        {
          op: "problem_update",
          problemId: problem.id.toUpperCase(),
          updates: { description: "Second wording" },
        },
      ],
    });
    await consumer.handle(event);

    const apps = await admin.query(
      "SELECT status, conflict_reason FROM care_plan_idg_decision_application WHERE idg_decision_id=$1",
      [event.payload.decisionId],
    );
    expect(apps.rows).toHaveLength(1);
    expect(apps.rows[0].status).toBe("conflict");
    expect(apps.rows[0].conflict_reason).toContain("element_targeted_twice");
    const changes = await admin.query(
      "SELECT count(*)::int AS n FROM care_plan_idg_proposed_change WHERE care_plan_id=$1",
      [boot.id],
    );
    expect(Number(changes.rows[0].n)).toBe(0);
  });

  it("a second decision of the same meeting on an element already proposed WAITS, and records a durable refusal once stale", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    const meetingId = randomUUID();
    const first = idgEvent({
      patientId,
      meetingId,
      mutations: [
        { op: "problem_update", problemId: problem.id, updates: { description: "First wording" } },
      ],
    });
    await consumer.handle(first);

    const second = idgEvent({
      patientId,
      meetingId,
      mutations: [
        { op: "problem_update", problemId: problem.id, updates: { description: "Second wording" } },
      ],
    });
    const secondRows = async (sqlText: string) =>
      Number((await admin.query(sqlText, [second.payload.decisionId])).rows[0].n);
    // The meeting's draft already carries a change to this problem: wait, write nothing.
    await expect(consumer.handle(second)).rejects.toBeInstanceOf(OutboxDeferral);
    expect(
      await secondRows(
        "SELECT count(*)::int AS n FROM care_plan_idg_decision_application WHERE idg_decision_id=$1",
      ),
    ).toBe(0);
    const pending = await admin.query(
      "SELECT count(*)::int AS n FROM care_plan_idg_proposed_change WHERE care_plan_id=$1",
      [boot.id],
    );
    expect(Number(pending.rows[0].n)).toBe(1);

    // Past the wait horizon it stops waiting and is recorded, not thrown into the retry/dead-letter loop.
    await consumer.handle({ ...second, createdAt: new Date(Date.now() - STALE_DECISION_MS) });
    const refused = await admin.query(
      "SELECT status, conflict_reason FROM care_plan_idg_decision_application WHERE idg_decision_id=$1",
      [second.payload.decisionId],
    );
    expect(refused.rows).toHaveLength(1);
    expect(refused.rows[0].status).toBe("conflict");
    expect(refused.rows[0].conflict_reason).toContain("element_has_pending_change");
  });

  it("an open revision that outlasts the wait horizon refuses the IDG proposal as a durable conflict row (acked, not retried) without mutating active content", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    await svc.createVersion(ORG_A, boot.id, "interim_revision", null);
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    const event = idgEvent({
      patientId,
      mutations: [
        {
          op: "problem_update",
          problemId: problem.id,
          updates: { description: "Blocked IDG wording" },
        },
      ],
    });
    // The decision has waited past the horizon, so it stops waiting: the handler records the refusal and
    // returns (the outbox row is acked) instead of throwing into the retry loop.
    const stale = { ...event, createdAt: new Date(Date.now() - STALE_DECISION_MS) };
    await consumer.handle(stale);
    await consumer.handle({ ...stale, id: randomUUID() }); // a redelivery is a no-op

    const apps = await admin.query(
      "SELECT status, conflict_reason, care_plan_version_id FROM care_plan_idg_decision_application WHERE idg_decision_id=$1",
      [event.payload.decisionId],
    );
    expect(apps.rows).toHaveLength(1);
    expect(apps.rows[0].status).toBe("conflict");
    expect(apps.rows[0].conflict_reason).toContain("version_already_open");
    // anchored on a non-idg_review version (an idg_review version's proposal bundle must stay publishable)
    const [anchor] = (
      await admin.query("SELECT kind FROM care_plan_version WHERE id=$1", [
        apps.rows[0].care_plan_version_id,
      ])
    ).rows;
    expect(anchor.kind).not.toBe("idg_review");
    // no idg_review version was opened and no proposed change was written
    const idgVersions = await admin.query(
      "SELECT count(*)::int AS n FROM care_plan_version WHERE care_plan_id=$1 AND kind='idg_review'",
      [boot.id],
    );
    expect(Number(idgVersions.rows[0].n)).toBe(0);
    const changes = await admin.query(
      "SELECT count(*)::int AS n FROM care_plan_idg_proposed_change WHERE care_plan_id=$1",
      [boot.id],
    );
    expect(Number(changes.rows[0].n)).toBe(0);
    // the refusal leaves exactly one audit event
    const audits = await admin.query(
      "SELECT count(*)::int AS n FROM audit_event WHERE resource_id=$1 AND event_type='m7.care_plan.idg_proposal_refused'",
      [boot.id],
    );
    expect(Number(audits.rows[0].n)).toBe(1);
    const [problemRow] = (
      await admin.query("SELECT description FROM problem WHERE id=$1", [problem.id])
    ).rows;
    expect(problemRow.description).toBe("Baseline terminal");
  });

  it("an IDG decision for a plan that stays unsigned past the wait horizon is recorded as a durable conflict row", async () => {
    const patientId = randomUUID();
    const boot = (await svc.bootstrapCarePlan(ORG_A, patientId, randomUUID())) as Boot;
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    const event = idgEvent({
      patientId,
      mutations: [
        {
          op: "problem_add",
          icd10Code: null,
          snomedCode: null,
          description: "IDG proposed problem",
          problemKind: "related",
        },
      ],
    });
    // Past the wait horizon: acked with a durable refusal, not thrown into the retry/dead-letter loop.
    await consumer.handle({ ...event, createdAt: new Date(Date.now() - STALE_DECISION_MS) });

    const apps = await admin.query(
      "SELECT status, conflict_reason, care_plan_id FROM care_plan_idg_decision_application WHERE idg_decision_id=$1",
      [event.payload.decisionId],
    );
    expect(apps.rows).toHaveLength(1);
    expect(apps.rows[0]).toMatchObject({ status: "conflict", care_plan_id: boot.id });
    expect(apps.rows[0].conflict_reason).toContain("plan_not_active");
    const problems = await admin.query(
      "SELECT count(*)::int AS n FROM problem WHERE care_plan_id=$1",
      [boot.id],
    );
    expect(Number(problems.rows[0].n)).toBe(0);
  });

  it("an IDG intervention with a discipline outside M7's enum is refused as a durable conflict row, opening no version", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    const event = idgEvent({
      patientId,
      mutations: [
        {
          op: "intervention_add",
          problemId: problem.id,
          goalRefs: [],
          discipline: "hospice_wizard",
          scopeText: "Unsupported discipline",
          frequencyText: "weekly",
          frequencyValue: "1:visit:week",
        },
      ],
    });
    await consumer.handle(event);

    const apps = await admin.query(
      "SELECT status, conflict_reason FROM care_plan_idg_decision_application WHERE idg_decision_id=$1",
      [event.payload.decisionId],
    );
    expect(apps.rows).toHaveLength(1);
    expect(apps.rows[0].status).toBe("conflict");
    expect(apps.rows[0].conflict_reason).toContain("unsupported_intervention_discipline");
    const idgVersions = await admin.query(
      "SELECT count(*)::int AS n FROM care_plan_version WHERE care_plan_id=$1 AND kind='idg_review'",
      [boot.id],
    );
    expect(Number(idgVersions.rows[0].n)).toBe(0);
  });

  it("an IDG decision that would resolve the terminal problem is refused (T4) and leaves the problem active", async () => {
    const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
    const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
    const event = idgEvent({
      patientId,
      mutations: [{ op: "problem_update", problemId: problem.id, updates: { status: "resolved" } }],
    });
    await consumer.handle(event);

    const apps = await admin.query(
      "SELECT status, conflict_reason FROM care_plan_idg_decision_application WHERE idg_decision_id=$1",
      [event.payload.decisionId],
    );
    expect(apps.rows).toHaveLength(1);
    expect(apps.rows[0].status).toBe("conflict");
    expect(apps.rows[0].conflict_reason).toContain("terminal_problem_status_change");
    const [problemRow] = (
      await admin.query("SELECT status FROM problem WHERE id=$1 AND care_plan_id=$2", [
        problem.id,
        boot.id,
      ])
    ).rows;
    expect(problemRow.status).toBe("active");
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

  it("§7.7 optimistic concurrency — a stale ifVersion patch is 409 STALE_VERSION, a fresh one bumps the version", async () => {
    const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
    const prob = (await svc.addProblem(ORG_A, boot.id, {
      description: "Cachexia",
      kind: "related",
      source: "clinical",
    })) as Element;
    await expect(
      svc.patchProblem(ORG_A, boot.id, prob.id, prob.version + 99, { description: "x" }),
    ).rejects.toMatchObject({ statusCode: 409, code: "STALE_VERSION" });
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

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // M7 HARDENING (fixer B1) — written WITHOUT a database to run against; the lead runs these in a
  // private chartwarden-postgres container. Each case names the finding it pins.
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  describe("M7 hardening — races, plan selection, §7.6 snapshot redaction, element guards", () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const DENY_SUD = { sudDisclosureAllowed: false } as const;
    const ALLOW_SUD = { sudDisclosureAllowed: true } as const;
    const SUD_TEXT = "Opioid use disorder in remission (synthetic)";
    const SUD_GOAL_TEXT = "Attend weekly recovery group (synthetic)";

    /** A plan with an initial version finalized (in_review, version 2) — nobody has signed yet. */
    async function finalizedInitialPlan() {
      const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
      await svc.addProblem(ORG_A, boot.id, {
        description: "Terminal illness",
        kind: "terminal",
        source: "clinical",
      });
      await svc.finalizeVersion(ORG_A, boot.id, boot.initialVersionId, 1, null);
      return boot;
    }
    const signAs = (boot: Boot, role: (typeof SIGNER_ROLES)[number], ifVersion: number) =>
      svc.signVersion(
        ORG_A,
        boot.id,
        boot.initialVersionId,
        ifVersion,
        role,
        "2026-06-21T12:00:00.000Z",
        signerFor(role),
      );

    it("#1 two concurrent last signers serialise on the version row: one wins, the loser is 409 STALE_VERSION, and a retry reaches quorum", async () => {
      const boot = await finalizedInitialPlan();
      const results = await Promise.allSettled([
        signAs(boot, "rn_case_manager", 2),
        signAs(boot, "hospice_physician", 2),
      ]);
      // Before the fix BOTH succeeded, each seeing "0 existing signatures" → the version sat in_review with
      // the full quorum attached and the plan never activated.
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ statusCode: 409, code: "STALE_VERSION" });

      const mid = (await svc.getVersion(ORG_A, boot.id, boot.initialVersionId)) as Version;
      expect(mid.status).toBe("in_review");
      expect(mid.signatures).toHaveLength(1);

      const loserRole = results[0]?.status === "rejected" ? "rn_case_manager" : "hospice_physician";
      await signAs(boot, loserRole, mid.version);
      const done = (await svc.getVersion(ORG_A, boot.id, boot.initialVersionId)) as Version;
      expect(done.status).toBe("signed");
      expect(done.signatures).toHaveLength(2);
      const plan = (await admin.query(
        "SELECT status, active_version_id FROM care_plan WHERE id=$1",
        [boot.id],
      )) as { rows: { status: string; active_version_id: string }[] };
      expect(plan.rows[0]).toMatchObject({
        status: "active",
        active_version_id: boot.initialVersionId,
      });
      const signedEvents = (await eventsFor(boot.initialVersionId)).filter(
        (e) => e === "m7.care_plan.version_signed",
      );
      expect(signedEvents).toHaveLength(1);
    });

    it("CP-15 a stale ifVersion sign is refused (409 STALE_VERSION) and attaches no signature", async () => {
      const boot = await finalizedInitialPlan(); // version is now 2
      await expect(signAs(boot, "rn_case_manager", 1)).rejects.toMatchObject({
        statusCode: 409,
        code: "STALE_VERSION",
      });
      const sigs = await admin.query(
        "SELECT count(*)::int AS n FROM care_plan_signature WHERE care_plan_version_id=$1",
        [boot.initialVersionId],
      );
      expect(sigs.rows[0].n).toBe(0);
      const v = (await svc.getVersion(ORG_A, boot.id, boot.initialVersionId)) as Version;
      expect(v).toMatchObject({ status: "in_review", version: 2 });
    });

    it("#6 a discharge that commits while a sign is in flight is not overwritten back to active", async () => {
      const boot = await finalizedInitialPlan();
      await signAs(boot, "rn_case_manager", 2); // version 3; one signature short of quorum
      // A second, superuser connection holds an UNCOMMITTED discharge of the plan row.
      const other = new Client({ connectionString: DB_URL });
      await other.connect();
      try {
        await other.query("BEGIN");
        await other.query("UPDATE care_plan SET status='discharged' WHERE id=$1", [boot.id]);
        const signing = signAs(boot, "hospice_physician", 3); // blocks on the plan row lock
        const outcome = signing.then(
          () => "signed" as const,
          (err: unknown) => err,
        );
        await sleep(300);
        await other.query("COMMIT");
        expect(await outcome).toMatchObject({ statusCode: 409, code: "CARE_PLAN_CLOSED" });
      } finally {
        await other.end();
      }
      const plan = await admin.query("SELECT status FROM care_plan WHERE id=$1", [boot.id]);
      expect(plan.rows[0].status).toBe("discharged");
      const v = (await svc.getVersion(ORG_A, boot.id, boot.initialVersionId)) as Version;
      expect(v.status).toBe("in_review");
    });

    it("#3 after discharge + re-admission every patient-keyed read resolves the LIVE plan 2, and plan 2 accepts writes", async () => {
      const patientId = randomUUID();
      const admission1 = randomUUID();
      const plan1 = (await svc.bootstrapCarePlan(ORG_A, patientId, admission1)) as Boot;
      await svc.addProblem(ORG_A, plan1.id, {
        description: "Plan 1 problem",
        kind: "terminal",
        source: "clinical",
      });
      await svc.closeCarePlanForAdmission(
        ORG_A,
        admission1,
        "discharged",
        "2026-07-01T00:00:00.000Z",
      );
      // Every plan discharged → the newest still reads (a discharged chart stays viewable).
      expect(((await svc.getCarePlanForPatient(ORG_A, patientId)) as { id: string }).id).toBe(
        plan1.id,
      );

      const plan2 = (await svc.bootstrapCarePlan(ORG_A, patientId, randomUUID())) as Boot;
      const problem2 = (await svc.addProblem(ORG_A, plan2.id, {
        description: "Plan 2 problem",
        kind: "terminal",
        source: "clinical",
      })) as Element;

      const aggregate = (await svc.getCarePlanForPatient(ORG_A, patientId)) as {
        id: string;
        status: string;
      };
      expect(aggregate.id).toBe(plan2.id);
      expect(aggregate.status).toBe("draft");
      // Plan 1 would answer CARE_PLAN_CLOSED to every write; plan 2 (the one the UI now holds) does not.
      await expect(
        svc.addProblem(ORG_A, plan1.id, { description: "x", kind: "related", source: "clinical" }),
      ).rejects.toMatchObject({ code: "CARE_PLAN_CLOSED" });

      // The org-level reads agree with the route service (they used newest-ANY-status / "one row per patient").
      expect(await activeProblemIdsForOrg(handle.db, ORG_A, patientId)).toEqual([problem2.id]);
      const packet = await idgPacketCarePlanContextForOrg(
        handle.db,
        ORG_A,
        patientId,
        "2026-07-02T00:00:00.000Z",
      );
      expect(packet?.carePlanId).toBe(plan2.id);
      // The §7.8 reader store (ambient request context, as the M8/M15 callers run it).
      const store = createDrizzleCarePlanReaderStore(handle.db);
      const elements = await runWithRequestContext({ organizationId: ORG_A, userId: USER }, () =>
        store.activeCarePlanElements(patientId),
      );
      expect(elements?.planId).toBe(plan2.id);
    });

    it("#2 a version's stateSnapshot is redacted of SUD problems and their goals for a caller without Part 2 disclosure", async () => {
      const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot & {
        patientId: string;
      };
      const terminal = (await svc.addProblem(ORG_A, boot.id, {
        description: "Terminal illness",
        kind: "terminal",
        source: "clinical",
      })) as Element;
      const sud = (await svc.addProblem(ORG_A, boot.id, {
        description: SUD_TEXT,
        kind: "related",
        source: "clinical",
        sudRelated: true,
      })) as Element;
      await svc.addGoal(
        ORG_A,
        boot.id,
        { problemId: sud.id, originalText: SUD_GOAL_TEXT, source: "clinical" },
        false,
      );
      await svc.addGoal(
        ORG_A,
        boot.id,
        { problemId: terminal.id, originalText: "Comfort at home", source: "clinical" },
        false,
      );
      const finalized = await svc.finalizeVersion(ORG_A, boot.id, boot.initialVersionId, 1, null);
      // The DB row's snapshot is the FULL plan (the signing path must see every problem)…
      const raw = await admin.query("SELECT state_snapshot FROM care_plan_version WHERE id=$1", [
        boot.initialVersionId,
      ]);
      expect(JSON.stringify(raw.rows[0].state_snapshot)).toContain(SUD_TEXT);
      expect(finalized).toBeTruthy();

      // …but no per-caller projection leaks it.
      const denied = [
        await svc.getVersion(ORG_A, boot.id, boot.initialVersionId, DENY_SUD),
        await svc.listVersions(ORG_A, boot.id, DENY_SUD),
        await svc.getCarePlanForPatient(ORG_A, boot.patientId, DENY_SUD),
      ];
      for (const body of denied) {
        const text = JSON.stringify(body);
        expect(text).not.toContain(SUD_TEXT);
        expect(text).not.toContain(SUD_GOAL_TEXT);
      }
      expect(JSON.stringify(denied[0])).toContain("Comfort at home"); // a filter, not a blanket null

      const allowed = JSON.stringify(
        await svc.getVersion(ORG_A, boot.id, boot.initialVersionId, ALLOW_SUD),
      );
      expect(allowed).toContain(SUD_TEXT);
      expect(allowed).toContain(SUD_GOAL_TEXT);
      // No viewer FAILS CLOSED: a caller that does not say who is reading gets the redacted snapshot.
      const unspecified = JSON.stringify(
        await svc.getVersion(ORG_A, boot.id, boot.initialVersionId),
      );
      expect(unspecified).not.toContain(SUD_TEXT);
      expect(unspecified).not.toContain(SUD_GOAL_TEXT);
    });

    it("#2 proposed-changes drops IDG changes anchored to a SUD problem for a caller without disclosure", async () => {
      const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
      const sud = (await svc.addProblem(ORG_A, boot.id, {
        description: SUD_TEXT,
        kind: "related",
        source: "clinical",
        sudRelated: true,
      })) as Element;
      const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
      await consumer.handle(
        idgEvent({
          patientId,
          mutations: [
            {
              op: "goal_add",
              problemId: sud.id,
              originalText: SUD_GOAL_TEXT,
              revisedText: null,
              source: "clinical",
              measurableOutcome: "weekly attendance",
            },
            {
              op: "goal_add",
              problemId: problem.id,
              originalText: "Comfort at home",
              revisedText: null,
              source: "clinical",
              measurableOutcome: "self-reported comfort",
            },
          ],
        }),
      );
      const [review] = (
        await admin.query(
          "SELECT id FROM care_plan_version WHERE care_plan_id=$1 AND kind='idg_review'",
          [boot.id],
        )
      ).rows;
      const denied = JSON.stringify(
        await svc.getProposedChanges(ORG_A, boot.id, review.id, DENY_SUD),
      );
      expect(denied).not.toContain(SUD_GOAL_TEXT);
      expect(denied).toContain("Comfort at home");
      const allowed = JSON.stringify(
        await svc.getProposedChanges(ORG_A, boot.id, review.id, ALLOW_SUD),
      );
      expect(allowed).toContain(SUD_GOAL_TEXT);
      expect(allowed).toContain("Comfort at home");
    });

    it("a proposal made ONLY of Part 2 changes is not listed without disclosure (its id, status and reason would confirm it exists)", async () => {
      const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
      const sud = (await svc.addProblem(ORG_A, boot.id, {
        description: SUD_TEXT,
        kind: "related",
        source: "clinical",
        sudRelated: true,
      })) as Element;
      const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
      const goalOn = (problemId: string, text: string) => ({
        op: "goal_add",
        problemId,
        originalText: text,
        revisedText: null,
        source: "clinical",
        measurableOutcome: "weekly",
      });
      const sudOnly = idgEvent({ patientId, mutations: [goalOn(sud.id, SUD_GOAL_TEXT)] });
      const meetingId = sudOnly.payload.meetingId;
      const plain = idgEvent({
        patientId,
        meetingId,
        mutations: [goalOn(problem.id, "Comfort at home")],
      });
      for (const event of [sudOnly, plain]) await consumer.handle(event);
      const [review] = (
        await admin.query(
          "SELECT id FROM care_plan_version WHERE care_plan_id=$1 AND kind='idg_review'",
          [boot.id],
        )
      ).rows;
      const listed = async (viewer: typeof DENY_SUD | typeof ALLOW_SUD) =>
        (
          (await svc.getProposedChanges(ORG_A, boot.id, review.id, viewer)) as {
            proposals: { decisionId: string }[];
          }
        ).proposals
          .map((p) => p.decisionId)
          .sort();

      expect(await listed(DENY_SUD)).toEqual([plain.payload.decisionId]);
      expect(await listed(ALLOW_SUD)).toEqual(
        [sudOnly.payload.decisionId, plain.payload.decisionId].sort(),
      );
    });

    it("#5 a problem resolves once: a re-resolve is 409 and keeps the first note, one m7.problem.resolved event, and a resolved row is read-only", async () => {
      const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
      const p = (await svc.addProblem(ORG_A, boot.id, {
        description: "Dyspnea",
        kind: "related",
        source: "clinical",
      })) as Element;
      const resolved = (await svc.resolveProblem(
        ORG_A,
        boot.id,
        p.id,
        p.version,
        "first note",
      )) as Element;
      await expect(
        svc.resolveProblem(ORG_A, boot.id, p.id, resolved.version, "overwrite attempt"),
      ).rejects.toMatchObject({ statusCode: 409, code: "ILLEGAL_TRANSITION" });
      await expect(
        svc.patchProblem(ORG_A, boot.id, p.id, resolved.version, {
          description: "edit after resolve",
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: "ILLEGAL_TRANSITION" });
      const row = (
        await admin.query("SELECT resolution_note, status FROM problem WHERE id=$1", [p.id])
      ).rows[0];
      expect(row).toMatchObject({ resolution_note: "first note", status: "resolved" });
      expect((await eventsFor(p.id)).filter((e) => e === "m7.problem.resolved")).toHaveLength(1);
    });

    it("#5 goals follow the §2.2.3 graph (not_started → met is 409) and a met goal is read-only; a discontinued intervention is read-only", async () => {
      const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
      const p = (await svc.addProblem(ORG_A, boot.id, {
        description: "Pain",
        kind: "related",
        source: "clinical",
      })) as Element;
      const g = (await svc.addGoal(
        ORG_A,
        boot.id,
        { problemId: p.id, originalText: "Pain under 3/10", source: "clinical" },
        false,
      )) as Element;
      await expect(
        svc.patchGoal(ORG_A, boot.id, g.id, g.version, { status: "met" }),
      ).rejects.toMatchObject({ statusCode: 409, code: "ILLEGAL_TRANSITION" });
      const started = (await svc.patchGoal(ORG_A, boot.id, g.id, g.version, {
        status: "in_progress",
      })) as Element;
      const met = (await svc.patchGoal(ORG_A, boot.id, g.id, started.version, {
        status: "met",
      })) as Element;
      await expect(
        svc.patchGoal(ORG_A, boot.id, g.id, met.version, { revisedText: "edit after met" }),
      ).rejects.toMatchObject({ statusCode: 409, code: "ILLEGAL_TRANSITION" });

      const i = (await svc.addIntervention(ORG_A, boot.id, {
        problemId: p.id,
        scopeText: "Reassess pain",
        frequencyText: "weekly",
        frequencyValue: "1/week",
        discipline: "rn",
      })) as Element;
      const off = (await svc.discontinueIntervention(
        ORG_A,
        boot.id,
        i.id,
        i.version,
        "declined",
      )) as Element;
      await expect(
        svc.discontinueIntervention(ORG_A, boot.id, i.id, off.version, "again"),
      ).rejects.toMatchObject({ statusCode: 409, code: "ILLEGAL_TRANSITION" });
      await expect(
        svc.patchIntervention(ORG_A, boot.id, i.id, off.version, {
          scopeText: "edit after discontinue",
        }),
      ).rejects.toMatchObject({ statusCode: 409, code: "ILLEGAL_TRANSITION" });
    });

    it("#18 a stale IDG proposal's conflict is DURABLE: finalize is 409 AND the application row says conflict/baseline_changed", async () => {
      const { boot, patientId, problem } = await activePlanWithTerminalProblem("Baseline terminal");
      const consumer = buildM7IdgDecisionConsumer({ db: handle.db, outbox: svcOutbox() });
      const event = idgEvent({
        patientId,
        mutations: [
          {
            op: "problem_update",
            problemId: problem.id,
            updates: { description: "Stale IDG wording" },
          },
        ],
      });
      await consumer.handle(event);
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
      ).rejects.toMatchObject({ code: "IDG_PROPOSAL_CONFLICT" });
      const app = (
        await admin.query(
          "SELECT status, conflict_reason FROM care_plan_idg_decision_application WHERE idg_decision_id=$1",
          [event.payload.decisionId],
        )
      ).rows[0];
      expect(app).toMatchObject({ status: "conflict", conflict_reason: "baseline_changed" });
      // The version is untouched (still a draft): only the conflict marker committed.
      expect(((await svc.getVersion(ORG_A, boot.id, review.id)) as Version).status).toBe("draft");
    });

    it("#7 bootstrap seeds initial_due_at at the END of the org-local day, activation day + 5 calendar days (org tz, not +120h)", async () => {
      await admin.query(
        `UPDATE organization SET settings = coalesce(settings, '{}'::jsonb) || '{"org_timezone":"America/Los_Angeles"}'::jsonb WHERE id=$1`,
        [ORG_B],
      );
      const boot = (await svc.bootstrapCarePlan(
        ORG_B,
        randomUUID(),
        randomUUID(),
        "2026-06-21T12:00:00.000Z", // 05:00 on 2026-06-21 in Los Angeles
      )) as Boot;
      const row = (await admin.query("SELECT initial_due_at FROM care_plan WHERE id=$1", [boot.id]))
        .rows[0];
      // 2026-06-21 + 5 = 2026-06-26, 23:59:59.999 PDT = 2026-06-27T06:59:59.999Z
      expect(new Date(row.initial_due_at).toISOString()).toBe("2026-06-27T06:59:59.999Z");
    });

    /** A second superuser connection holding an uncommitted row lock, released by the returned `release`. */
    async function holdRowLock(sqlText: string, params: unknown[]) {
      const other = new Client({ connectionString: DB_URL });
      await other.connect();
      await other.query("BEGIN");
      await other.query(sqlText, params);
      return {
        release: async () => {
          await other.query("COMMIT");
          await other.end();
        },
      };
    }

    it("#1b a sign parks behind the version row lock (deterministic overlap): one wins after release, the other is 409 STALE_VERSION", async () => {
      const boot = await finalizedInitialPlan();
      const held = await holdRowLock("SELECT id FROM care_plan_version WHERE id=$1 FOR UPDATE", [
        boot.initialVersionId,
      ]);
      let settled = 0;
      const track = <T>(p: Promise<T>) =>
        p.then(
          (v) => {
            settled++;
            return { ok: true as const, v };
          },
          (e: unknown) => {
            settled++;
            return { ok: false as const, e };
          },
        );
      const both = Promise.all([
        track(signAs(boot, "rn_case_manager", 2)),
        track(signAs(boot, "hospice_physician", 2)),
      ]);
      await sleep(400);
      // Without the FOR UPDATE both would already have read version 2 and signed.
      expect(settled).toBe(0);
      await held.release();
      const results = await both;
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const lost = results.find((r) => !r.ok) as { ok: false; e: unknown };
      expect(lost.e).toMatchObject({ statusCode: 409, code: "STALE_VERSION" });
    });

    it("finalize and return-to-draft queue behind the plan row lock exactly as sign does (one lock order, no 40P01)", async () => {
      const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
      await svc.addProblem(ORG_A, boot.id, {
        description: "Terminal illness",
        kind: "terminal",
        source: "clinical",
      });
      const held = await holdRowLock("SELECT id FROM care_plan WHERE id=$1 FOR UPDATE", [boot.id]);
      let finalized = false;
      const finalizing = svc
        .finalizeVersion(ORG_A, boot.id, boot.initialVersionId, 1, null)
        .then(() => {
          finalized = true;
        });
      await sleep(400);
      expect(finalized).toBe(false);
      await held.release();
      await finalizing;

      const held2 = await holdRowLock("SELECT id FROM care_plan WHERE id=$1 FOR UPDATE", [boot.id]);
      let returned = false;
      const returning = svc
        .returnVersionToDraft(ORG_A, boot.id, boot.initialVersionId, 2)
        .then(() => {
          returned = true;
        });
      await sleep(400);
      expect(returned).toBe(false);
      await held2.release();
      await returning;
      expect(
        ((await svc.getVersion(ORG_A, boot.id, boot.initialVersionId)) as Version).status,
      ).toBe("draft");
    });

    it("review-status dates a legacy plan (NULL next_review_due_at) the way the gate does, and a malformed plan id is simply not found", async () => {
      const { boot } = await activePlanWithTerminalProblem("Legacy review clock");
      await admin.query("UPDATE care_plan SET next_review_due_at = NULL WHERE id=$1", [boot.id]);
      const signedAt = (
        await admin.query("SELECT initial_signed_at FROM care_plan WHERE id=$1", [boot.id])
      ).rows[0].initial_signed_at as Date;
      const status = (await svc.getReviewStatus(
        ORG_A,
        boot.id,
        new Date(signedAt.getTime() + 30 * 86_400_000).toISOString(),
      )) as { status: string; nextReviewDueAt: string | null };
      expect(status.status).toBe("overdue");
      expect(status.nextReviewDueAt).not.toBeNull();

      expect(await svc.getPlanPatientId(ORG_A, "not-a-uuid")).toBeNull();
    });

    it("#8 only an initial / idg_review signature re-arms the review clock; an interim revision leaves it and the emission markers alone", async () => {
      const { boot } = await activePlanWithTerminalProblem("Baseline terminal");
      await admin.query(
        "UPDATE care_plan SET review_due_emitted=true, review_overdue_emitted=true WHERE id=$1",
        [boot.id],
      );
      const before = (
        await admin.query("SELECT next_review_due_at FROM care_plan WHERE id=$1", [boot.id])
      ).rows[0].next_review_due_at as Date;
      const draft = (await svc.createVersion(
        ORG_A,
        boot.id,
        "interim_revision",
        null,
      )) as Version & {
        requiredSignerSet: { role: string; count: number }[];
      };
      await svc.finalizeVersion(ORG_A, boot.id, draft.id, draft.version, null);
      let version = draft.version + 1;
      for (const slot of draft.requiredSignerSet) {
        const role = slot.role.split("|")[0] as (typeof SIGNER_ROLES)[number];
        await svc.signVersion(
          ORG_A,
          boot.id,
          draft.id,
          version++,
          role,
          "2026-07-20T12:00:00.000Z",
          signerFor(role),
        );
      }
      const after = (
        await admin.query(
          "SELECT status, next_review_due_at, review_due_emitted, review_overdue_emitted FROM care_plan WHERE id=$1",
          [boot.id],
        )
      ).rows[0];
      expect(((await svc.getVersion(ORG_A, boot.id, draft.id)) as Version).status).toBe("signed");
      expect(new Date(after.next_review_due_at).toISOString()).toBe(new Date(before).toISOString());
      expect(after.review_due_emitted).toBe(true);
      expect(after.review_overdue_emitted).toBe(true);
    });

    it("#10 a goal / intervention cannot hang on another plan's problem or goal (FK checks bypass RLS) — 404, nothing inserted", async () => {
      const mine = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
      const theirs = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
      const myProblem = (await svc.addProblem(ORG_A, mine.id, {
        description: "Mine",
        kind: "related",
        source: "clinical",
      })) as Element;
      const theirProblem = (await svc.addProblem(ORG_A, theirs.id, {
        description: "Theirs",
        kind: "related",
        source: "clinical",
      })) as Element;
      const theirGoal = (await svc.addGoal(
        ORG_A,
        theirs.id,
        { problemId: theirProblem.id, originalText: "Their goal", source: "clinical" },
        false,
      )) as Element;
      await expect(
        svc.addGoal(
          ORG_A,
          mine.id,
          { problemId: theirProblem.id, originalText: "x", source: "clinical" },
          false,
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        svc.addGoal(
          ORG_A,
          mine.id,
          { problemId: randomUUID(), originalText: "x", source: "clinical" },
          false,
        ),
      ).rejects.toMatchObject({ statusCode: 404 });
      const intervention = {
        scopeText: "s",
        frequencyText: "weekly",
        frequencyValue: "1/week",
        discipline: "rn" as const,
      };
      await expect(
        svc.addIntervention(ORG_A, mine.id, { ...intervention, problemId: theirProblem.id }),
      ).rejects.toMatchObject({ statusCode: 404 });
      await expect(
        svc.addIntervention(ORG_A, mine.id, {
          ...intervention,
          problemId: myProblem.id,
          goalRefs: [theirGoal.id],
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
      const counts = await admin.query(
        "SELECT (SELECT count(*)::int FROM goal WHERE care_plan_id=$1) AS g, (SELECT count(*)::int FROM intervention WHERE care_plan_id=$1) AS i",
        [mine.id],
      );
      expect(counts.rows[0]).toEqual({ g: 0, i: 0 });
    });

    it("#12 §7.4 discipline_scope also guards PATCH / discontinue against the intervention's OWN discipline", async () => {
      const boot = (await svc.bootstrapCarePlan(ORG_A, randomUUID(), randomUUID())) as Boot;
      const p = (await svc.addProblem(ORG_A, boot.id, {
        description: "Pain",
        kind: "related",
        source: "clinical",
      })) as Element;
      const i = (await svc.addIntervention(ORG_A, boot.id, {
        problemId: p.id,
        scopeText: "Reassess pain",
        frequencyText: "weekly",
        frequencyValue: "1/week",
        discipline: "rn",
      })) as Element;
      const msw = { disciplines: ["msw" as const], isIdgCoordinator: false };
      const rn = { disciplines: ["rn" as const], isIdgCoordinator: false };
      await expect(
        svc.patchIntervention(ORG_A, boot.id, i.id, i.version, { scopeText: "hijacked" }, msw),
      ).rejects.toMatchObject({ statusCode: 403, code: "DISCIPLINE_SCOPE_VIOLATION" });
      await expect(
        svc.discontinueIntervention(ORG_A, boot.id, i.id, i.version, "hijack", msw),
      ).rejects.toMatchObject({ statusCode: 403, code: "DISCIPLINE_SCOPE_VIOLATION" });
      const ok = (await svc.patchIntervention(
        ORG_A,
        boot.id,
        i.id,
        i.version,
        { scopeText: "Reassess pain twice weekly" },
        rn,
      )) as Element;
      expect(ok.version).toBe(i.version + 1);
    });

    it("#14 creates stamp the acting membership (added_by / drafted_by); #17 the signature records the proven step-up method", async () => {
      const actor = { membershipId: MEMBER };
      const boot = (await svc.bootstrapCarePlan(
        ORG_A,
        randomUUID(),
        randomUUID(),
        undefined,
        actor,
      )) as Boot;
      const p = (await svc.addProblem(
        ORG_A,
        boot.id,
        {
          description: "Pain",
          kind: "terminal",
          source: "clinical",
          onsetAt: "2026-05-01T00:00:00.000Z",
        },
        actor,
      )) as Element;
      const g = (await svc.addGoal(
        ORG_A,
        boot.id,
        {
          problemId: p.id,
          originalText: "Pain under 3/10",
          source: "clinical",
          targetAt: "2026-09-01T00:00:00.000Z",
        },
        false,
        actor,
      )) as Element;
      const i = (await svc.addIntervention(
        ORG_A,
        boot.id,
        {
          problemId: p.id,
          goalRefs: [g.id],
          scopeText: "Reassess pain",
          frequencyText: "weekly",
          frequencyValue: "1/week",
          discipline: "rn",
        },
        undefined,
        actor,
      )) as Element;
      const rows = await admin.query(
        `SELECT
           (SELECT added_by_membership_id FROM problem WHERE id=$1) AS problem_by,
           (SELECT onset_at FROM problem WHERE id=$1) AS onset_at,
           (SELECT added_by_membership_id FROM goal WHERE id=$2) AS goal_by,
           (SELECT target_at FROM goal WHERE id=$2) AS target_at,
           (SELECT added_by_membership_id FROM intervention WHERE id=$3) AS intervention_by,
           (SELECT drafted_by_membership_id FROM care_plan_version WHERE id=$4) AS version_by`,
        [p.id, g.id, i.id, boot.initialVersionId],
      );
      const r = rows.rows[0];
      expect([r.problem_by, r.goal_by, r.intervention_by, r.version_by]).toEqual([
        MEMBER,
        MEMBER,
        MEMBER,
        MEMBER,
      ]);
      expect(new Date(r.onset_at).toISOString()).toBe("2026-05-01T00:00:00.000Z");
      expect(new Date(r.target_at).toISOString()).toBe("2026-09-01T00:00:00.000Z");

      await svc.finalizeVersion(ORG_A, boot.id, boot.initialVersionId, 1, null);
      await svc.signVersion(
        ORG_A,
        boot.id,
        boot.initialVersionId,
        2,
        "rn_case_manager",
        "2026-06-21T12:00:00.000Z",
        { ...signerFor("rn_case_manager"), signatureMethod: "passkey" },
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
      const methods = await admin.query(
        "SELECT signer_role, signature_method FROM care_plan_signature WHERE care_plan_version_id=$1 ORDER BY signed_at",
        [boot.initialVersionId],
      );
      // Signed order: the RN (passkey) at 12:00, then the physician (password step-up) at 12:05.
      expect(methods.rows).toEqual([
        { signer_role: "rn_case_manager", signature_method: "passkey" },
        { signer_role: "hospice_physician", signature_method: "password_step_up" },
      ]);
    });
  });
});
