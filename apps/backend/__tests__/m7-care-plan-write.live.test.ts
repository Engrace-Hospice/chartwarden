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
  createDbCarePlanAbacResolver,
  createDbCarePlanRouteService,
} from "../src/modules/07-care-plan/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";

type Boot = { id: string; initialVersionId: string; version: number };
type Element = { id: string; status: string; version: number };
type Version = { id: string; status: string; version: number; signatures: unknown[] };

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
    )) as Version;
    expect(sig1.status).toBe("in_review");
    // The attending (hospice physician) fills the second slot — quorum met → signed + plan active.
    const sig2 = (await svc.signVersion(
      ORG_A,
      boot.id,
      boot.initialVersionId,
      3,
      "hospice_physician",
      new Date().toISOString(),
    )) as Version;
    expect(sig2.status).toBe("signed");
    expect(sig2.signatures.length).toBe(2);
    const [row] = (
      await admin.query("SELECT status, active_version_id FROM care_plan WHERE id=$1", [boot.id])
    ).rows;
    expect(row.status).toBe("active");
    expect(row.active_version_id).toBe(boot.initialVersionId);
    expect(await eventsFor(boot.initialVersionId)).toContain("m7.care_plan.version_signed");
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
});
