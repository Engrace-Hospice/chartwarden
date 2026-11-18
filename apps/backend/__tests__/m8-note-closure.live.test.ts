/**
 * ADR-0113 — the M8 visit-note closure clock, proven against real Postgres as the NOBYPASSRLS `chartwarden_app` role.
 *
 * The unit suites assert rendered SQL and fakes; this one proves what only a database can:
 *   1. RLS isolates `documentation_obligation_policy` / `documentation_obligation_override` per tenant (negative control: RLS off).
 *   2. The override table is insert-only for the app role (UPDATE on the two revoke columns only, no DELETE) and its own CHECKs hold.
 *   3. `grantClosureOverride` writes the audit event on the grant's transaction (the screened reason as `context.justification`, scrubbed
 *      from the row's own snapshot, an SSN / MBI-shaped reason refused with nothing written); a revoke re-blocks at once, writes
 *      `closure_override_revoked` once and reports another supervisor's grant that still lifts the clinician.
 *   4. `putClosurePolicy` derives `enforce_from` (set on warn->block, kept on a repeat, cleared on block->warn); the grace is real.
 *   5. `evaluateMemberClosure` and the gate agree at every boundary for off/warn/block, built exactly as `index.ts` builds them.
 *   6. `encounter_open_clock_idx` serves BOTH the reader query and the sweep scan (EXPLAIN as the app role, with a negative control).
 *   7. `runNoteClosureSweep` over the REAL Drizzle `AlertEmitter`, the real alert-rule seed and the real batched "already alerted?"
 *      reader: one alert per stage (no lookback, nothing re-emitted), author-only, off = silent, an author who left is skipped.
 *   8. The `m17.visit.started` stamp consumer behind the real catalog-validating publisher and the real outbox dispatcher.
 *   9. GET overdue-notes lands one `encounter.viewed` read event per distinct patient and honours location scope, a note with no
 *      location included.
 *  10. Migration 1511 grants the override to the four supervisor role keys, and the policy key to the DON keys and the administrators
 *      (never to clinical_supervisor / clinical_lead), and to nobody else.
 *  11. Migration 1510's triggers: a revoked override stays revoked, an override's members belong to its organization, the clock is
 *      write-once (each with a negative control).
 *  12. The grant refuses a blocked grantor, an unblocked clinician and a note outside the grantor's sites, in that order.
 *  13. The supervisor board plans on `encounter_open_clock_board_idx` and does not sort the backlog (EXPLAIN as the app role).
 *  14. Migration 1512 disables the two retired alert rules (platform and tenant clones) and deletes nothing.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m8:note-closure:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1. Never point this at the shared Docker cluster.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AuditContext } from "@chartwarden/audit";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, createDbClient, organizationTimezone } from "@chartwarden/db";
import { type AlertEmitter, createAlertPayloadRegistry } from "@chartwarden/messaging";
import { systemOrgContext, withOrgContext } from "@chartwarden/tenancy";
import {
  ChartWardenError,
  ForbiddenError,
  M8_CLOSURE_ALERT_PAYLOADS,
  NotFoundError,
  ValidationError,
} from "@chartwarden/types";
import { Value } from "@sinclair/typebox/value";
import type { FastifyRequest } from "fastify";
import { Client, type Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { type NoteClosureGate, createNoteClosureGate } from "../src/bootstrap/note-closure-gate";
import { createOutboxDispatcher } from "../src/bootstrap/outbox-dispatcher";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import {
  runNoteClosureSweep,
  scanOrgClosureState,
} from "../src/modules/08-encounters/closure/closure-sweep";
import { listOverdueNotes } from "../src/modules/08-encounters/closure/overdue-board";
import {
  M8_OUTBOX_EVENTS,
  buildM8WorkerDeps,
  createClosurePolicyCache,
  createDbClosurePolicyCache,
  createDbClosureRouteService,
  evaluateMemberClosure,
  grantClosureOverride,
  putClosurePolicy,
  readClosurePolicy,
  registerClosureRoutes,
  revokeClosureOverride,
  runEncounterAttentionCron,
} from "../src/modules/08-encounters/index";
import { buildM8VisitStartedNoteClockConsumer } from "../src/modules/08-encounters/outbox-consumers/m17-visit-started-note-clock";
import { M17_OUTBOX_EVENTS } from "../src/modules/17-scheduling/index";
import {
  createDbAlertCorrelationReader,
  createDrizzleAlertEmitter,
  wireAlertRuleSeed,
} from "../src/modules/36-messaging/index";
import { appRoleConnectionString, dropLiveRoles, resetPublicSchema } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const LONG_TTL_MS = 10 * MINUTE_MS;
/** A past service date: `encounter_service_date_not_future` forbids the future. */
const SERVICE_DATE = "2026-01-15";
const VOIDED_REASON = "voided by the closure live suite: synthetic fixture, no patient content";
const NEW_YORK_SERVICE_DATE_START = "2026-01-15T05:00:00.000Z"; // 00:00 EST

const ORG_A = "11111111-1111-1111-1111-111111111111"; // sections 1-5: policy, override, matrix, gate
const ORG_B = "22222222-2222-2222-2222-222222222222"; // the other tenant
const ORG_S = "33333333-3333-3333-3333-333333333333"; // the alert sweep
const ORG_P = "44444444-4444-4444-4444-444444444444"; // realistic row counts for EXPLAIN
const ORG_R = "55555555-5555-5555-5555-555555555555"; // the HTTP routes

type EncounterStatus = "draft" | "finalized" | "signed" | "cosign_pending" | "cosigned" | "voided";
type ClockSource = "evv_check_in" | "visit_started" | "draft_opened" | "draft_created";
type Mode = "off" | "warn" | "block";

interface Member {
  readonly userId: string;
  readonly membershipId: string;
}
interface OrgFixture {
  readonly orgId: string;
  readonly providerEntityId: string;
  readonly locationIds: readonly [string, string];
}
interface EncounterSeed {
  readonly org: OrgFixture;
  readonly authorMembershipId: string;
  readonly status?: EncounterStatus;
  readonly clockStartedAt?: Date | null;
  readonly source?: ClockSource;
  readonly visitId?: string;
  /** Which of the org's two sites the note is at; `null` = no site at all (a seeded draft whose visit carries no location). */
  readonly locationIndex?: 0 | 1 | null;
}

const at = (base: Date, hours: number, extraMs = 0): Date =>
  new Date(base.getTime() + hours * HOUR_MS + extraMs);

function one<T>(rows: readonly T[]): T {
  const [first, ...rest] = rows;
  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one row, got ${rows.length}`);
  }
  return first;
}

function auditContextOf(org: string, userId: string): AuditContext {
  return {
    organizationId: org,
    userId,
    actorKind: "user",
    correlationId: `closure-live-${randomUUID()}`,
    requestId: randomUUID(),
    sourceIp: "127.0.0.1",
    userAgent: "vitest",
  };
}

describe.skipIf(!DB_URL)("M8 visit-note closure clock (ADR-0113) — LIVE Postgres", () => {
  let admin: Client;
  let appPg: Client;
  let handle: ReturnType<typeof createDbClient>;
  const capturedSql: { text: string; values: unknown[] }[] = [];
  const orgs = {} as Record<"A" | "B" | "S" | "P" | "R", OrgFixture>;
  let configUser: Member;
  let supervisorA: Member;
  let supervisorB: Member;
  const roleIds = new Map<string, string>();
  let orgCounter = 0;

  // ---------------------------------------------------------------------------------------------------------------
  // fixtures
  // ---------------------------------------------------------------------------------------------------------------
  async function seedOrg(orgId: string, slug: string): Promise<OrgFixture> {
    orgCounter += 1;
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
      [orgId, `note-closure-${slug}`],
    );
    const pe = await admin.query<{ id: string }>(
      `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
       VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
      [orgId, `NC-${slug}`, `PE ${slug}`, String(1_300_000_000 + orgCounter)],
    );
    const providerEntityId = one(pe.rows).id;
    const locationIds: string[] = [];
    for (const name of ["Site one", "Site two"]) {
      const loc = await admin.query<{ id: string }>(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
         VALUES ($1,$2,'1 Main St','Town','NY','10001','America/New_York') RETURNING id`,
        [providerEntityId, name],
      );
      locationIds.push(one(loc.rows).id);
    }
    const [first, second] = locationIds;
    if (first === undefined || second === undefined) throw new Error("location seed failed");
    return { orgId, providerEntityId, locationIds: [first, second] };
  }

  async function roleIdOf(orgId: string, key: string): Promise<string> {
    const cached = roleIds.get(`${orgId}:${key}`);
    if (cached) return cached;
    const existing = await admin.query<{ id: string }>(
      "SELECT id FROM role WHERE organization_id=$1 AND key=$2",
      [orgId, key],
    );
    const id =
      existing.rows[0]?.id ??
      one(
        (
          await admin.query<{ id: string }>(
            "INSERT INTO role (organization_id,key,name,category) VALUES ($1,$2,$2,'clinical_staff') RETURNING id",
            [orgId, key],
          )
        ).rows,
      ).id;
    roleIds.set(`${orgId}:${key}`, id);
    return id;
  }

  async function seedMember(
    org: OrgFixture,
    label: string,
    opts: { roleKey?: string; assignToProviderEntity?: boolean } = {},
  ): Promise<Member> {
    const user = await admin.query<{ id: string }>(
      `INSERT INTO "user" (email) VALUES ($1) RETURNING id`,
      [`${label}-${randomUUID().slice(0, 8)}@closure.test`],
    );
    const userId = one(user.rows).id;
    const membership = await admin.query<{ id: string }>(
      `INSERT INTO membership (user_id, organization_id, status, default_provider_entity_id)
       VALUES ($1,$2,'active',$3) RETURNING id`,
      [userId, org.orgId, opts.assignToProviderEntity ? org.providerEntityId : null],
    );
    const membershipId = one(membership.rows).id;
    if (opts.roleKey) {
      await admin.query(
        "INSERT INTO membership_role (organization_id, membership_id, role_id) VALUES ($1,$2,$3)",
        [org.orgId, membershipId, await roleIdOf(org.orgId, opts.roleKey)],
      );
    }
    return { userId, membershipId };
  }

  async function seedEncounter(seed: EncounterSeed): Promise<string> {
    const status = seed.status ?? "draft";
    const clock = seed.clockStartedAt ?? null;
    const sealed = status === "signed" || status === "cosign_pending" || status === "cosigned";
    const voided = status === "voided";
    const stamp = clock ?? new Date("2026-01-16T00:00:00.000Z");
    const result = await admin.query<{ id: string }>(
      `INSERT INTO encounter (organization_id, provider_entity_id, location_id, patient_id, admission_id, visit_id,
         encounter_type, discipline, authored_by_membership_id, service_date, status, vocab_version_id, signed_at,
         voided_at, voided_by, voided_reason, clock_started_at, clock_start_source)
       VALUES ($1,$2,$3,$4,$5,$6,'routine_visit','rn',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
      [
        seed.org.orgId,
        seed.org.providerEntityId,
        seed.locationIndex === null ? null : seed.org.locationIds[seed.locationIndex ?? 0],
        randomUUID(),
        randomUUID(),
        seed.visitId ?? null,
        seed.authorMembershipId,
        SERVICE_DATE,
        status,
        status === "draft" ? null : randomUUID(),
        sealed ? stamp : null,
        voided ? stamp : null,
        voided ? seed.authorMembershipId : null,
        voided ? VOIDED_REASON : null,
        clock,
        clock ? (seed.source ?? "draft_created") : null,
      ],
    );
    return one(result.rows).id;
  }

  async function setPolicy(
    orgId: string,
    mode: Mode,
    opts: { thresholdHours?: number; enforceFrom?: Date | null } = {},
  ): Promise<void> {
    await admin.query(
      `INSERT INTO documentation_obligation_policy
         (organization_id, obligation_kind, mode, threshold_hours, enforce_from, configured_by_user_id)
       VALUES ($1,'visit_note',$2,$3,$4,$5)
       ON CONFLICT (organization_id, obligation_kind) DO UPDATE
         SET mode=EXCLUDED.mode, threshold_hours=EXCLUDED.threshold_hours, enforce_from=EXCLUDED.enforce_from`,
      [orgId, mode, opts.thresholdHours ?? 24, opts.enforceFrom ?? null, configUser.userId],
    );
  }

  async function insertOverrideRow(
    orgId: string,
    subjectMembershipId: string,
    grantedByMembershipId: string,
    opts: { reason?: string; grantedAt?: Date; expiresAt?: Date } = {},
  ): Promise<string> {
    const grantedAt = opts.grantedAt ?? new Date("2026-11-18T12:00:00.000Z");
    const result = await admin.query<{ id: string }>(
      `INSERT INTO documentation_obligation_override
         (organization_id, subject_membership_id, granted_by_membership_id, obligation_kind, reason, granted_at, expires_at)
       VALUES ($1,$2,$3,'visit_note',$4,$5,$6) RETURNING id`,
      [
        orgId,
        subjectMembershipId,
        grantedByMembershipId,
        opts.reason ?? "seeded by the live suite: synthetic closure override reason text",
        grantedAt,
        opts.expiresAt ?? at(grantedAt, 4),
      ],
    );
    return one(result.rows).id;
  }

  /** One transaction as `chartwarden_app` on a raw pg connection, with the GUCs `withOrgContext` sets (or none). */
  async function asApp<T>(
    org: string | null,
    userId: string,
    fn: (client: Client) => Promise<T>,
  ): Promise<T> {
    await appPg.query("BEGIN");
    try {
      if (org !== null) {
        await appPg.query(
          "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)",
          [org, userId],
        );
      }
      const result = await fn(appPg);
      await appPg.query("COMMIT");
      return result;
    } catch (error) {
      await appPg.query("ROLLBACK");
      throw error;
    }
  }

  async function sqlFailure(
    run: Promise<unknown>,
  ): Promise<{ code?: string; constraint?: string }> {
    try {
      await run;
    } catch (error) {
      return error as { code?: string; constraint?: string };
    }
    throw new Error("expected the statement to fail, but it succeeded");
  }

  const countAs = (org: string | null, userId: string, table: string, where = "true") =>
    asApp(org, userId, async (c) => {
      const result = await c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      );
      return one(result.rows).n;
    });

  const inOrg = <T>(orgId: string, userId: string, fn: (tx: DbClient) => Promise<T>): Promise<T> =>
    withOrgContext(handle.db, { organizationId: orgId, userId }, (tx) =>
      fn(tx as unknown as DbClient),
    );

  const evaluateAt = (
    orgId: string,
    member: Member,
    now: Date,
  ): ReturnType<typeof evaluateMemberClosure> =>
    inOrg(orgId, member.userId, (tx) =>
      evaluateMemberClosure(tx, { organizationId: orgId, membershipId: member.membershipId, now }),
    );

  /** The gate, adapted EXACTLY as `apps/backend/src/index.ts` builds it, with an injectable clock. */
  function buildGate(clock: { now: Date }, policyCache = createDbClosurePolicyCache(handle.db)) {
    const failures: unknown[] = [];
    const gate = createNoteClosureGate({
      policyCache,
      evaluate: ({ organizationId, userId, membershipId, now, policy }) =>
        withOrgContext(handle.db, { organizationId, userId }, (tx) =>
          evaluateMemberClosure(tx as unknown as DbClient, {
            organizationId,
            membershipId,
            now,
            policy,
          }),
        ),
      now: () => clock.now,
      onFailure: ({ error }) => failures.push(error),
    });
    return { gate, policyCache, failures };
  }

  const NON_ALLOWLISTED = {
    method: "POST",
    routeTemplate: "/api/v1/encounters/:encounterId/void",
    rawUrl: "/api/v1/encounters/x/void",
  } as const;
  const ALLOWLISTED = {
    method: "POST",
    routeTemplate: "/api/v1/encounters/:encounterId/sign",
    rawUrl: "/api/v1/encounters/x/sign",
  } as const;

  async function gateOutcome(
    gate: NoteClosureGate,
    orgId: string,
    member: Member,
    route: typeof NON_ALLOWLISTED | typeof ALLOWLISTED = NON_ALLOWLISTED,
  ): Promise<string> {
    try {
      await gate.assertMayCall({
        ...route,
        organizationId: orgId,
        userId: member.userId,
        membershipId: member.membershipId,
      });
      return "pass";
    } catch (error) {
      if (error instanceof ChartWardenError) return error.code;
      throw error;
    }
  }

  function captureQueries(pool: Pool): void {
    pool.on("connect", (client: PoolClient) => {
      const target = client as unknown as { query: (...args: unknown[]) => unknown };
      const original = target.query.bind(client);
      target.query = (...args: unknown[]) => {
        const [first, second] = args;
        if (typeof first === "string") {
          capturedSql.push({ text: first, values: Array.isArray(second) ? second : [] });
        } else if (first && typeof first === "object" && "text" in first) {
          // drizzle's node-postgres driver sends (config, params): the values ride as the second argument
          const config = first as { text: string; values?: unknown[] };
          capturedSql.push({
            text: config.text,
            values: Array.isArray(second) ? second : (config.values ?? []),
          });
        }
        return original(...args);
      };
    });
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetPublicSchema(admin);
    await dropLiveRoles(admin);
    const stripVector = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
      if (stripVector) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
    orgs.A = await seedOrg(ORG_A, "a");
    orgs.B = await seedOrg(ORG_B, "b");
    orgs.S = await seedOrg(ORG_S, "s");
    orgs.P = await seedOrg(ORG_P, "p");
    orgs.R = await seedOrg(ORG_R, "r");
    configUser = await seedMember(orgs.A, "config");
    supervisorA = await seedMember(orgs.A, "supervisor-a", { roleKey: "clinical_supervisor" });
    supervisorB = await seedMember(orgs.B, "supervisor-b", { roleKey: "clinical_supervisor" });

    const appUrl = await appRoleConnectionString(admin, DB_URL as string);
    appPg = new Client({ connectionString: appUrl });
    await appPg.connect();
    handle = createDbClient({ connectionString: appUrl });
    captureQueries(handle.pool);
  }, 600_000);

  afterAll(async () => {
    await handle?.close();
    if (appPg) await appPg.end();
    if (admin) await admin.end();
  });

  // ===============================================================================================================
  // 1. tenant isolation
  // ===============================================================================================================
  describe("1. cross-tenant isolation of the policy and override tables (RLS, as chartwarden_app)", () => {
    const tables = [
      "documentation_obligation_policy",
      "documentation_obligation_override",
    ] as const;
    let clinicianA: Member;
    let clinicianB: Member;
    let overrideA: string;

    beforeAll(async () => {
      clinicianA = await seedMember(orgs.A, "iso-clinician-a");
      clinicianB = await seedMember(orgs.B, "iso-clinician-b");
      await setPolicy(ORG_A, "block", { thresholdHours: 24 });
      await setPolicy(ORG_B, "warn", { thresholdHours: 48 });
      overrideA = await insertOverrideRow(ORG_A, clinicianA.membershipId, supervisorA.membershipId);
      await insertOverrideRow(ORG_B, clinicianB.membershipId, supervisorB.membershipId);
    });

    it("each tenant reads exactly its own rows, and a session with no org context reads none", async () => {
      for (const table of tables) {
        expect(await countAs(ORG_A, supervisorA.userId, table), `${table} as A`).toBe(1);
        expect(await countAs(ORG_B, supervisorB.userId, table), `${table} as B`).toBe(1);
        expect(await countAs(ORG_B, supervisorB.userId, table, `organization_id='${ORG_A}'`)).toBe(
          0,
        );
        expect(await countAs(ORG_A, supervisorA.userId, table, `organization_id='${ORG_B}'`)).toBe(
          0,
        );
        expect(await countAs(null, supervisorA.userId, table), `${table} with no GUC`).toBe(0);
      }
    });

    it("org B cannot write org A's rows: inserts hit the WITH CHECK, updates and deletes touch nothing", async () => {
      const policyInsert = await sqlFailure(
        asApp(ORG_B, supervisorB.userId, (c) =>
          c.query(
            `INSERT INTO documentation_obligation_policy (organization_id, obligation_kind, mode, threshold_hours, configured_by_user_id)
             VALUES ($1,'cti','off',24,$2)`,
            [ORG_A, configUser.userId],
          ),
        ),
      );
      expect(policyInsert.code).toBe("42501");
      const overrideInsert = await sqlFailure(
        asApp(ORG_B, supervisorB.userId, (c) =>
          c.query(
            `INSERT INTO documentation_obligation_override
               (organization_id, subject_membership_id, granted_by_membership_id, obligation_kind, reason, granted_at, expires_at)
             VALUES ($1,$2,$3,'visit_note',$4, now(), now() + interval '1 hour')`,
            [ORG_A, clinicianA.membershipId, supervisorA.membershipId, "x".repeat(60)],
          ),
        ),
      );
      // Refused by the org guard (23503: org B's session cannot even see org A's memberships) before RLS's WITH CHECK is reached.
      expect(overrideInsert.code).toBe("23503");
      // With the guard trigger off, RLS's own WITH CHECK is what refuses it: both layers are real, neither is the other's alibi.
      await admin.query(
        "ALTER TABLE documentation_obligation_override DISABLE TRIGGER trg_documentation_obligation_override_org_guard",
      );
      try {
        const rlsOnly = await sqlFailure(
          asApp(ORG_B, supervisorB.userId, (c) =>
            c.query(
              `INSERT INTO documentation_obligation_override
                 (organization_id, subject_membership_id, granted_by_membership_id, obligation_kind, reason, granted_at, expires_at)
               VALUES ($1,$2,$3,'visit_note',$4, now(), now() + interval '1 hour')`,
              [ORG_A, clinicianA.membershipId, supervisorA.membershipId, "x".repeat(60)],
            ),
          ),
        );
        expect(rlsOnly.code).toBe("42501");
      } finally {
        await admin.query(
          "ALTER TABLE documentation_obligation_override ENABLE TRIGGER trg_documentation_obligation_override_org_guard",
        );
      }

      const policyUpdate = await asApp(ORG_B, supervisorB.userId, (c) =>
        c.query("UPDATE documentation_obligation_policy SET mode='off' WHERE organization_id=$1", [
          ORG_A,
        ]),
      );
      expect(policyUpdate.rowCount).toBe(0);
      const revokeAttempt = await asApp(ORG_B, supervisorB.userId, (c) =>
        c.query(
          "UPDATE documentation_obligation_override SET revoked_at=now(), revoked_by_membership_id=$2 WHERE id=$1",
          [overrideA, supervisorB.membershipId],
        ),
      );
      expect(revokeAttempt.rowCount).toBe(0);

      const policyA = await admin.query(
        "SELECT mode FROM documentation_obligation_policy WHERE organization_id=$1",
        [ORG_A],
      );
      expect(one(policyA.rows).mode).toBe("block");
      const rowA = await admin.query(
        "SELECT revoked_at FROM documentation_obligation_override WHERE id=$1",
        [overrideA],
      );
      expect(one(rowA.rows).revoked_at).toBeNull();
    });

    it("negative control: with RLS switched off org B DOES see org A's rows, so the zero counts above are the policy", async () => {
      for (const table of tables) {
        await admin.query(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY`);
        try {
          const leaked = await countAs(
            ORG_B,
            supervisorB.userId,
            table,
            `organization_id='${ORG_A}'`,
          );
          expect(leaked, `${table} with RLS off`).toBeGreaterThan(0);
        } finally {
          await admin.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
          await admin.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
        }
        expect(await countAs(ORG_B, supervisorB.userId, table, `organization_id='${ORG_A}'`)).toBe(
          0,
        );
      }
    });
  });

  // ===============================================================================================================
  // 2. the override table is insert-only for the app role
  // ===============================================================================================================
  describe("2. documentation_obligation_override is insert-only for the app role", () => {
    let subject: Member;
    let granter: Member;
    const GRANTED_AT = "2026-11-18T12:00:00.000Z";

    beforeAll(async () => {
      subject = await seedMember(orgs.A, "append-subject");
      granter = await seedMember(orgs.A, "append-granter");
    });

    const insertAsApp = (o: {
      subject?: string;
      granter?: string;
      reason?: string;
      expiresAt?: string;
    }) =>
      asApp(ORG_A, granter.userId, (c) =>
        c.query(
          `INSERT INTO documentation_obligation_override
             (organization_id, subject_membership_id, granted_by_membership_id, obligation_kind, reason, granted_at, expires_at)
           VALUES ($1,$2,$3,'visit_note',$4,$5,$6) RETURNING id`,
          [
            ORG_A,
            o.subject ?? subject.membershipId,
            o.granter ?? granter.membershipId,
            o.reason ?? "r".repeat(60),
            GRANTED_AT,
            o.expiresAt ?? "2026-11-18T16:00:00.000Z",
          ],
        ),
      );

    it("a valid grant inserts (the control for every refusal below)", async () => {
      const inserted = await insertAsApp({});
      expect(inserted.rowCount).toBe(1);
    });

    it("the CHECKs reject a self-grant, a 25h window and a reason shorter than 40 characters", async () => {
      const self = await sqlFailure(insertAsApp({ subject: granter.membershipId }));
      expect([self.code, self.constraint]).toEqual([
        "23514",
        "documentation_obligation_override_not_self",
      ]);

      const window25 = await sqlFailure(insertAsApp({ expiresAt: "2026-11-19T13:00:00.000Z" }));
      expect([window25.code, window25.constraint]).toEqual([
        "23514",
        "documentation_obligation_override_expiry_window",
      ]);
      const expired = await sqlFailure(insertAsApp({ expiresAt: GRANTED_AT }));
      expect(expired.constraint).toBe("documentation_obligation_override_expiry_window");

      const shortReason = await sqlFailure(insertAsApp({ reason: "r".repeat(39) }));
      expect([shortReason.code, shortReason.constraint]).toEqual([
        "23514",
        "documentation_obligation_override_reason_len",
      ]);
      const padded = await sqlFailure(insertAsApp({ reason: `${" ".repeat(60)}x` }));
      expect(padded.constraint).toBe("documentation_obligation_override_reason_len");
    });

    it("the boundaries are inclusive where the migration says so: exactly 24h and exactly 40 characters insert", async () => {
      expect((await insertAsApp({ expiresAt: "2026-11-19T12:00:00.000Z" })).rowCount).toBe(1);
      expect((await insertAsApp({ reason: "r".repeat(40) })).rowCount).toBe(1);
      // the reason is capped at 500 characters: it is copied into the (append-only) audit event as well as stored on the row
      expect((await insertAsApp({ reason: "r".repeat(500) })).rowCount).toBe(1);
      const tooLong = await sqlFailure(insertAsApp({ reason: "r".repeat(501) }));
      expect([tooLong.code, tooLong.constraint]).toEqual([
        "23514",
        "documentation_obligation_override_reason_len",
      ]);
      const over = await sqlFailure(insertAsApp({ expiresAt: "2026-11-19T12:00:00.001Z" }));
      expect(over.constraint).toBe("documentation_obligation_override_expiry_window");
    });

    it("UPDATE is allowed only on the two revoke columns", async () => {
      const id = await insertOverrideRow(ORG_A, subject.membershipId, granter.membershipId);
      for (const column of [
        "reason",
        "expires_at",
        "granted_at",
        "subject_membership_id",
        "granted_by_membership_id",
        "obligation_kind",
        "organization_id",
        "id",
      ]) {
        const refused = await sqlFailure(
          asApp(ORG_A, granter.userId, (c) =>
            c.query(
              `UPDATE documentation_obligation_override SET ${column} = ${column} WHERE id=$1`,
              [id],
            ),
          ),
        );
        expect(refused.code, `UPDATE ${column}`).toBe("42501");
      }
      const halfRevoke = await sqlFailure(
        asApp(ORG_A, granter.userId, (c) =>
          c.query("UPDATE documentation_obligation_override SET revoked_at=now() WHERE id=$1", [
            id,
          ]),
        ),
      );
      expect(halfRevoke.constraint).toBe("documentation_obligation_override_revocation_pair");
      const revoked = await asApp(ORG_A, granter.userId, (c) =>
        c.query(
          "UPDATE documentation_obligation_override SET revoked_at=now(), revoked_by_membership_id=$2 WHERE id=$1",
          [id, granter.membershipId],
        ),
      );
      expect(revoked.rowCount).toBe(1);
    });

    it("DELETE is refused outright, for the row's own tenant too", async () => {
      const id = await insertOverrideRow(ORG_A, subject.membershipId, granter.membershipId);
      const refused = await sqlFailure(
        asApp(ORG_A, granter.userId, (c) =>
          c.query("DELETE FROM documentation_obligation_override WHERE id=$1", [id]),
        ),
      );
      expect(refused.code).toBe("42501");
      const still = await admin.query(
        "SELECT 1 FROM documentation_obligation_override WHERE id=$1",
        [id],
      );
      expect(still.rowCount).toBe(1);
    });

    it("the service refuses the same three cases first, with typed errors, and writes nothing", async () => {
      const before = await admin.query(
        "SELECT count(*)::int AS n FROM documentation_obligation_override WHERE organization_id=$1",
        [ORG_A],
      );
      const grant = (over: { subject?: string; reason?: string; hours?: number }) =>
        inOrg(ORG_A, granter.userId, (tx) =>
          grantClosureOverride(tx, {
            organizationId: ORG_A,
            subjectMembershipId: over.subject ?? subject.membershipId,
            grantedByMembershipId: granter.membershipId,
            obligationKind: "visit_note",
            reason: over.reason ?? "a supervisor-typed reason that is comfortably long enough",
            ...(over.hours === undefined ? {} : { hours: over.hours }),
            locationIds: null,
            audit: auditContextOf(ORG_A, granter.userId),
          }),
        );
      await expect(grant({ subject: granter.membershipId })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(grant({ hours: 25 })).rejects.toBeInstanceOf(ValidationError);
      await expect(grant({ reason: "too short" })).rejects.toBeInstanceOf(ValidationError);
      const otherTenant = await seedMember(orgs.B, "append-other-tenant");
      await expect(grant({ subject: otherTenant.membershipId })).rejects.toBeInstanceOf(
        ValidationError,
      );
      const after = await admin.query(
        "SELECT count(*)::int AS n FROM documentation_obligation_override WHERE organization_id=$1",
        [ORG_A],
      );
      expect(one(after.rows).n).toBe(one(before.rows).n);
    });
  });

  // ===============================================================================================================
  // 3. grant, audit, revoke
  // ===============================================================================================================
  describe("3. grantClosureOverride audits on the grant's transaction; revoke re-blocks at once", () => {
    const NOW = new Date("2026-11-18T12:00:00.000Z");
    const REASON =
      "Visit ran long after an on-call crisis; synthetic override reason text for the live suite";
    let clinician: Member;

    beforeAll(async () => {
      clinician = await seedMember(orgs.A, "grant-clinician");
      await seedEncounter({
        org: orgs.A,
        authorMembershipId: clinician.membershipId,
        clockStartedAt: at(NOW, -30),
      });
      await setPolicy(ORG_A, "block", { thresholdHours: 24 });
    });

    const grantAt = (now: Date, hours?: number) =>
      inOrg(ORG_A, supervisorA.userId, (tx) =>
        grantClosureOverride(tx, {
          organizationId: ORG_A,
          subjectMembershipId: clinician.membershipId,
          grantedByMembershipId: supervisorA.membershipId,
          obligationKind: "visit_note",
          reason: REASON,
          ...(hours === undefined ? {} : { hours }),
          locationIds: null,
          audit: auditContextOf(ORG_A, supervisorA.userId),
          now,
        }),
      );

    const revokeAt = (overrideId: string, now: Date) =>
      inOrg(ORG_A, supervisorA.userId, (tx) =>
        revokeClosureOverride(tx, {
          organizationId: ORG_A,
          overrideId,
          revokedByMembershipId: supervisorA.membershipId,
          locationIds: null,
          audit: auditContextOf(ORG_A, supervisorA.userId),
          now,
        }),
      );

    it("blocked -> (grant) lifted to warn, until the expiry instant -> (revoke) blocked again, gate included", async () => {
      expect((await evaluateAt(ORG_A, clinician, NOW)).verdict).toBe("blocked");
      const clock = { now: NOW };
      const { gate } = buildGate(clock);
      expect(await gateOutcome(gate, ORG_A, clinician)).toBe("NOTE_CLOSURE_REQUIRED");

      const granted = await grantAt(NOW, 4);
      expect(granted.expiresAt.toISOString()).toBe(at(NOW, 4).toISOString());
      const lifted = await evaluateAt(ORG_A, clinician, NOW);
      // The override lifts ONLY the block; the note is still overdue, so the verdict degrades to warn, never clear.
      expect(lifted.verdict).toBe("warn");
      expect(lifted.overrideExpiresAt?.toISOString()).toBe(at(NOW, 4).toISOString());
      expect(await gateOutcome(gate, ORG_A, clinician)).toBe("pass");

      expect((await evaluateAt(ORG_A, clinician, at(NOW, 4, -1))).verdict).toBe("warn");
      expect((await evaluateAt(ORG_A, clinician, at(NOW, 4))).verdict).toBe("blocked");

      const revokedAt = at(NOW, 1);
      clock.now = revokedAt;
      const revoked = await revokeAt(granted.id, revokedAt);
      expect(revoked.override.revokedAt?.toISOString()).toBe(revokedAt.toISOString());
      expect(revoked.remainingActiveUntil).toBeNull();
      const reblocked = await evaluateAt(ORG_A, clinician, revokedAt);
      expect(reblocked.verdict).toBe("blocked");
      expect(reblocked.overrideExpiresAt).toBeNull();
      // Same gate instance, no waiting: only a clear verdict is ever cached, so the revoke bites on the very next request.
      expect(await gateOutcome(gate, ORG_A, clinician)).toBe("NOTE_CLOSURE_REQUIRED");
    });

    it("revoke is idempotent and cannot reach another tenant's override", async () => {
      const granted = await grantAt(NOW, 2);
      const first = await revokeAt(granted.id, at(NOW, 1));
      const second = await revokeAt(granted.id, at(NOW, 3));
      expect(second.override.revokedAt?.toISOString()).toBe(
        first.override.revokedAt?.toISOString(),
      );
      await expect(
        inOrg(ORG_B, supervisorB.userId, (tx) =>
          revokeClosureOverride(tx, {
            organizationId: ORG_B,
            overrideId: granted.id,
            revokedByMembershipId: supervisorB.membershipId,
            locationIds: null,
            audit: auditContextOf(ORG_B, supervisorB.userId),
          }),
        ),
      ).rejects.toBeInstanceOf(NotFoundError);
      // the repeat wrote no second event: exactly one closure_override_revoked event for this grant
      const events = await admin.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND event_type='m8.encounter.closure_override_revoked' AND resource_id=$2",
        [ORG_A, granted.id],
      );
      expect(one(events.rows).n).toBe(1);
    });

    it("the explicit audit event lands with the grant and carries the screened reason as context.justification; the row trigger scrubs the row snapshot", async () => {
      const granted = await grantAt(NOW, 4);
      const explicit = await admin.query(
        `SELECT event_type, resource_kind, resource_id::text AS resource_id, severity, retention_class, actor_user_id::text AS actor, after, context
           FROM audit_event WHERE organization_id=$1 AND event_type='m8.encounter.closure_override_granted' AND resource_id=$2`,
        [ORG_A, granted.id],
      );
      const event = one(explicit.rows);
      expect(event.resource_kind).toBe("documentation_obligation_override");
      expect(event.severity).toBe("warn");
      expect(event.retention_class).toBe("compliance");
      expect(event.actor).toBe(supervisorA.userId);
      expect(event.after).toMatchObject({
        overrideId: granted.id,
        subjectMembershipId: clinician.membershipId,
        grantedByMembershipId: supervisorA.membershipId,
        obligationKind: "visit_note",
        hours: 4,
      });
      // the change snapshot is ids and instants; the reason is the event's context, the only audit copy of it
      expect(JSON.stringify(event.after)).not.toContain("on-call crisis");
      expect(event.context).toMatchObject({ justification: REASON });

      const trigger = await admin.query(
        `SELECT after FROM audit_event
          WHERE organization_id=$1 AND event_type='documentation_obligation_override.insert' AND resource_id=$2`,
        [ORG_A, granted.id],
      );
      const row = one(trigger.rows);
      expect(JSON.stringify(row.after)).not.toContain("on-call crisis");
      // recorded as changed, never as text (migration 1510's audit_scrub on the `reason` key)
      expect((row.after as Record<string, unknown>).reason).toBe("<changed>");
      expect(row.after).toMatchObject({ id: granted.id });
      // The reason itself is stored for the supervisors' own record.
      const stored = await admin.query(
        "SELECT reason FROM documentation_obligation_override WHERE id=$1",
        [granted.id],
      );
      expect(one(stored.rows).reason).toBe(REASON);
    });

    it("an SSN- or MBI-shaped reason is refused with a 422 on the reason field: nothing is written, no event, the value is not echoed", async () => {
      // Synthetic identifiers only (compliance/synthetic-identifiers.json): an SSN with area 900 and a listed MBI.
      const identifiers = ["900-12-3456", "1EG4TE5MK73"];
      const counts = async () => {
        const overrides = await admin.query(
          "SELECT count(*)::int AS n FROM documentation_obligation_override WHERE organization_id=$1",
          [ORG_A],
        );
        const events = await admin.query(
          "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND event_type LIKE 'm8.encounter.closure_override_%'",
          [ORG_A],
        );
        return [one(overrides.rows).n, one(events.rows).n];
      };
      const before = await counts();
      for (const identifier of identifiers) {
        const failure = await inOrg(ORG_A, supervisorA.userId, (tx) =>
          grantClosureOverride(tx, {
            organizationId: ORG_A,
            subjectMembershipId: clinician.membershipId,
            grantedByMembershipId: supervisorA.membershipId,
            obligationKind: "visit_note",
            reason: `Clinician is with the patient whose number is ${identifier} and cannot finish.`,
            locationIds: null,
            audit: auditContextOf(ORG_A, supervisorA.userId),
            now: NOW,
          }),
        ).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(ValidationError);
        const refusal = failure as ValidationError;
        expect(refusal.statusCode).toBe(422);
        expect(refusal.details?.[0]).toMatchObject({
          field: "reason",
          code: "EVIDENCE_LOOKS_LIKE_PHI",
        });
        expect(JSON.stringify([refusal.message, refusal.details])).not.toContain(identifier);
      }
      expect(await counts()).toEqual(before);
    });

    it("a revoke writes m8.encounter.closure_override_revoked (ids and instants) and the row trigger's update event, once", async () => {
      await admin.query(
        "UPDATE documentation_obligation_override SET revoked_at=$2, revoked_by_membership_id=$3 WHERE organization_id=$1 AND subject_membership_id=$4 AND revoked_at IS NULL",
        [ORG_A, at(NOW, 1), supervisorA.membershipId, clinician.membershipId],
      );
      const granted = await grantAt(NOW, 4);
      const revokedAt = at(NOW, 2);
      await revokeAt(granted.id, revokedAt);
      const events = await admin.query(
        `SELECT severity, retention_class, actor_user_id::text AS actor, after, context FROM audit_event
          WHERE organization_id=$1 AND event_type='m8.encounter.closure_override_revoked' AND resource_id=$2`,
        [ORG_A, granted.id],
      );
      const event = one(events.rows);
      expect([event.severity, event.retention_class, event.actor]).toEqual([
        "warn",
        "compliance",
        supervisorA.userId,
      ]);
      expect(event.after).toEqual({
        overrideId: granted.id,
        subjectMembershipId: clinician.membershipId,
        grantedByMembershipId: supervisorA.membershipId,
        revokedByMembershipId: supervisorA.membershipId,
        obligationKind: "visit_note",
        expiresAt: at(NOW, 4).toISOString(),
        revokedAt: revokedAt.toISOString(),
      });
      expect(JSON.stringify(event)).not.toContain("on-call crisis");
      expect(event.context).toEqual({});
      // the generic row trigger records the stamp too (the reason stays scrubbed)
      const trigger = await admin.query(
        "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND event_type='documentation_obligation_override.update' AND resource_id=$2",
        [ORG_A, granted.id],
      );
      expect(one(trigger.rows).n).toBe(1);
    });

    it("a revoke reports another supervisor's grant that still lifts the clinician (remainingActiveUntil), and the gate agrees", async () => {
      await admin.query(
        "UPDATE documentation_obligation_override SET revoked_at=$2, revoked_by_membership_id=$3 WHERE organization_id=$1 AND subject_membership_id=$4 AND revoked_at IS NULL",
        [ORG_A, at(NOW, 1), supervisorA.membershipId, clinician.membershipId],
      );
      const other = await seedMember(orgs.A, "second-grantor", { roleKey: "clinical_supervisor" });
      const first = await grantAt(NOW, 2);
      // the second supervisor's overlapping grant is seeded directly: the service refuses it, the clinician no longer being blocked
      await insertOverrideRow(ORG_A, clinician.membershipId, other.membershipId, {
        grantedAt: NOW,
        expiresAt: at(NOW, 6),
      });
      const afterFirst = await revokeAt(first.id, at(NOW, 1));
      expect(afterFirst.remainingActiveUntil?.toISOString()).toBe(at(NOW, 6).toISOString());
      // revoking one grant did not re-block the clinician
      expect((await evaluateAt(ORG_A, clinician, at(NOW, 1))).verdict).toBe("warn");
      expect((await revokeAt(first.id, at(NOW, 1))).remainingActiveUntil?.toISOString()).toBe(
        at(NOW, 6).toISOString(),
      );
      await admin.query(
        "UPDATE documentation_obligation_override SET revoked_at=$2, revoked_by_membership_id=$3 WHERE organization_id=$1 AND subject_membership_id=$4 AND revoked_at IS NULL",
        [ORG_A, at(NOW, 1), supervisorA.membershipId, clinician.membershipId],
      );
      expect((await evaluateAt(ORG_A, clinician, at(NOW, 1))).verdict).toBe("blocked");
    });

    it("the grant and its audit event commit or roll back together", async () => {
      const count = async (): Promise<[number, number]> => {
        const overrides = await admin.query(
          "SELECT count(*)::int AS n FROM documentation_obligation_override WHERE organization_id=$1",
          [ORG_A],
        );
        const events = await admin.query(
          "SELECT count(*)::int AS n FROM audit_event WHERE organization_id=$1 AND event_type='m8.encounter.closure_override_granted'",
          [ORG_A],
        );
        return [one(overrides.rows).n, one(events.rows).n];
      };
      const before = await count();
      await expect(
        inOrg(ORG_A, supervisorA.userId, async (tx) => {
          await grantClosureOverride(tx, {
            organizationId: ORG_A,
            subjectMembershipId: clinician.membershipId,
            grantedByMembershipId: supervisorA.membershipId,
            obligationKind: "visit_note",
            reason: REASON,
            locationIds: null,
            audit: auditContextOf(ORG_A, supervisorA.userId),
            now: NOW,
          });
          throw new Error("force a rollback after the grant");
        }),
      ).rejects.toThrow("force a rollback after the grant");
      expect(await count()).toEqual(before);
      await grantAt(NOW);
      const after = await count();
      expect(after).toEqual([before[0] + 1, before[1] + 1]);
    });
  });

  // ===============================================================================================================
  // 4. putClosurePolicy
  // ===============================================================================================================
  describe("4. putClosurePolicy derives enforce_from; an already-overdue note is not blocked by the switch", () => {
    const T0 = new Date("2026-11-18T09:00:00.000Z");

    const put = (mode: Mode, now: Date, thresholdHours = 24) =>
      inOrg(ORG_A, supervisorA.userId, (tx) =>
        putClosurePolicy(tx, {
          organizationId: ORG_A,
          obligationKind: "visit_note",
          mode,
          thresholdHours,
          actorUserId: supervisorA.userId,
          audit: auditContextOf(ORG_A, supervisorA.userId),
          now,
        }),
      );
    const stored = async () => {
      const result = await admin.query(
        "SELECT mode, threshold_hours, enforce_from, configured_by_user_id::text AS configured_by FROM documentation_obligation_policy WHERE organization_id=$1",
        [ORG_A],
      );
      return one(result.rows);
    };

    it("an absent row reads as the warn/24h default", async () => {
      await admin.query("DELETE FROM documentation_obligation_policy WHERE organization_id=$1", [
        ORG_A,
      ]);
      const policy = await inOrg(ORG_A, supervisorA.userId, (tx) =>
        readClosurePolicy(tx, ORG_A, "visit_note"),
      );
      expect(policy).toEqual({ mode: "warn", thresholdHours: 24, enforceFrom: null });
    });

    it("warn->block stamps enforce_from, a repeated block keeps it, block->warn clears it, the next block stamps afresh", async () => {
      await put("warn", T0);
      expect((await stored()).enforce_from).toBeNull();

      await put("block", at(T0, 1));
      expect((await stored()).enforce_from.toISOString()).toBe(at(T0, 1).toISOString());

      // a RAISED threshold under block keeps the original grace instant (every deadline moves later, nobody is newly late)
      const repeated = await put("block", at(T0, 5), 48);
      const afterRepeat = await stored();
      expect(afterRepeat.enforce_from.toISOString()).toBe(at(T0, 1).toISOString());
      expect(afterRepeat.threshold_hours).toBe(48);
      expect(repeated.enforceFrom?.toISOString()).toBe(at(T0, 1).toISOString());
      expect(afterRepeat.configured_by).toBe(supervisorA.userId);

      await put("warn", at(T0, 6));
      expect((await stored()).enforce_from).toBeNull();

      await put("block", at(T0, 7));
      expect((await stored()).enforce_from.toISOString()).toBe(at(T0, 7).toISOString());
      await put("off", at(T0, 8));
      expect((await stored()).enforce_from).toBeNull();
    });

    it("the service refuses a bad kind, mode or threshold before any write, and the table CHECK backs the range", async () => {
      await put("warn", T0);
      const bad = (input: Partial<Parameters<typeof putClosurePolicy>[1]>) =>
        inOrg(ORG_A, supervisorA.userId, (tx) =>
          putClosurePolicy(tx, {
            organizationId: ORG_A,
            obligationKind: "visit_note",
            mode: "block",
            thresholdHours: 24,
            actorUserId: supervisorA.userId,
            audit: auditContextOf(ORG_A, supervisorA.userId),
            ...input,
          }),
        );
      await expect(bad({ thresholdHours: 0 })).rejects.toBeInstanceOf(ValidationError);
      await expect(bad({ thresholdHours: 169 })).rejects.toBeInstanceOf(ValidationError);
      await expect(bad({ obligationKind: "cti" })).rejects.toBeInstanceOf(ValidationError);
      expect((await stored()).mode).toBe("warn");
      const raw = await sqlFailure(
        asApp(ORG_A, supervisorA.userId, (c) =>
          c.query(
            "UPDATE documentation_obligation_policy SET threshold_hours=169 WHERE organization_id=$1",
            [ORG_A],
          ),
        ),
      );
      expect(raw.constraint).toBe("documentation_obligation_policy_threshold");
    });

    it("LOWERING the threshold under block opens a fresh window: a 30h-old note under a new 24h limit is not blocked until now + 24h", async () => {
      const SWITCH = new Date("2026-11-18T10:00:00.000Z");
      const member = await seedMember(orgs.A, "grace-lowered");
      await seedEncounter({
        org: orgs.A,
        authorMembershipId: member.membershipId,
        clockStartedAt: at(SWITCH, -30),
      });
      // block at 168h since long before: nothing is near its (far) deadline
      await put("block", at(SWITCH, -100), 168);
      expect((await stored()).enforce_from.toISOString()).toBe(at(SWITCH, -100).toISOString());
      expect((await evaluateAt(ORG_A, member, SWITCH)).verdict).toBe("clear");

      // the tenant tightens to 24h: with the OLD enforce_from kept, blockFrom would be max(clock, -100h) + 24h = -6h, already past
      await put("block", SWITCH, 24);
      expect((await stored()).enforce_from.toISOString()).toBe(SWITCH.toISOString());
      const atSwitch = await evaluateAt(ORG_A, member, SWITCH);
      expect([atSwitch.decision.stage, atSwitch.verdict]).toEqual(["overdue", "warn"]);
      expect(atSwitch.decision.blockFrom?.toISOString()).toBe(at(SWITCH, 24).toISOString());
      expect((await evaluateAt(ORG_A, member, at(SWITCH, 24, -1))).verdict).toBe("warn");
      expect((await evaluateAt(ORG_A, member, at(SWITCH, 24))).verdict).toBe("blocked");
      // and RAISING it again moves nothing: the grace instant stays the switch
      await put("block", at(SWITCH, 1), 72);
      expect((await stored()).enforce_from.toISOString()).toBe(SWITCH.toISOString());
    });

    describe("every policy write is audited twice: the row trigger and the explicit warn-severity event", () => {
      const WRITE_AT = new Date("2026-11-18T08:00:00.000Z");
      const policyAudit = async (eventType: string) =>
        (
          await admin.query(
            `SELECT event_type, resource_kind, resource_id::text AS resource_id, severity, retention_class,
                    actor_user_id::text AS actor, before, after, correlation_id
               FROM audit_event
              WHERE organization_id=$1 AND event_type=$2
              ORDER BY created_at, id`,
            [ORG_A, eventType],
          )
        ).rows;

      it("the first write (an insert) and a later one (an update) each land the trigger row AND the explicit event, attributed to the actor", async () => {
        // audit_event is append-only: count what is there first and read only what these two writes add.
        await admin.query("DELETE FROM documentation_obligation_policy WHERE organization_id=$1", [
          ORG_A,
        ]);
        const seen = {
          insert: (await policyAudit("documentation_obligation_policy.insert")).length,
          update: (await policyAudit("documentation_obligation_policy.update")).length,
          explicit: (await policyAudit("m8.encounter.closure_policy_changed")).length,
        };

        await put("block", WRITE_AT, 36); // first write: warn/24 (default) -> block/36
        await put("block", at(WRITE_AT, 1), 12); // update: lowering under block re-stamps enforce_from

        const instant = (value: unknown): string => new Date(String(value)).toISOString();
        const inserted = one(
          (await policyAudit("documentation_obligation_policy.insert")).slice(seen.insert),
        );
        expect(inserted.actor).toBe(supervisorA.userId);
        expect(inserted.before).toBeNull();
        expect(inserted.after).toMatchObject({
          mode: "block",
          threshold_hours: 36,
          configured_by_user_id: supervisorA.userId,
        });
        expect(instant(inserted.after.enforce_from)).toBe(WRITE_AT.toISOString());

        const updated = one(
          (await policyAudit("documentation_obligation_policy.update")).slice(seen.update),
        );
        expect(updated.actor).toBe(supervisorA.userId);
        expect(updated.before).toMatchObject({ mode: "block", threshold_hours: 36 });
        expect(updated.after).toMatchObject({ mode: "block", threshold_hours: 12 });
        expect(instant(updated.after.enforce_from)).toBe(at(WRITE_AT, 1).toISOString());

        const [first, second, ...extra] = (
          await policyAudit("m8.encounter.closure_policy_changed")
        ).slice(seen.explicit);
        expect(extra).toEqual([]);
        for (const event of [first, second]) {
          expect(event?.resource_kind).toBe("documentation_obligation_policy");
          expect(event?.resource_id).toBe(ORG_A);
          expect(event?.severity).toBe("warn");
          expect(event?.retention_class).toBe("compliance");
          expect(event?.actor).toBe(supervisorA.userId);
        }
        expect(first?.after).toEqual({
          obligationKind: "visit_note",
          previousMode: "warn",
          previousThresholdHours: 24,
          mode: "block",
          thresholdHours: 36,
          enforceFrom: WRITE_AT.toISOString(),
        });
        expect(second?.after).toEqual({
          obligationKind: "visit_note",
          previousMode: "block",
          previousThresholdHours: 36,
          mode: "block",
          thresholdHours: 12,
          enforceFrom: at(WRITE_AT, 1).toISOString(),
        });
      });

      it("a refused write leaves neither a row nor an explicit event, and the explicit event commits or rolls back with the write", async () => {
        const before = (await policyAudit("m8.encounter.closure_policy_changed")).length;
        await expect(put("block", WRITE_AT, 0)).rejects.toBeInstanceOf(ValidationError);
        expect((await policyAudit("m8.encounter.closure_policy_changed")).length).toBe(before);
      });
    });

    it("a note already overdue at the switch is not blocked until enforce_from + threshold; a note started after is on its own clock", async () => {
      const SWITCH = new Date("2026-11-18T10:00:00.000Z");
      const stale = await seedMember(orgs.A, "grace-stale");
      const fresh = await seedMember(orgs.A, "grace-fresh");
      await seedEncounter({
        org: orgs.A,
        authorMembershipId: stale.membershipId,
        clockStartedAt: at(SWITCH, -30),
      });
      await seedEncounter({
        org: orgs.A,
        authorMembershipId: fresh.membershipId,
        clockStartedAt: at(SWITCH, 1),
      });

      await put("warn", at(SWITCH, -1));
      const beforeSwitch = await evaluateAt(ORG_A, stale, SWITCH);
      expect([beforeSwitch.decision.stage, beforeSwitch.verdict]).toEqual(["overdue", "warn"]);

      await put("block", SWITCH);
      const atSwitch = await evaluateAt(ORG_A, stale, SWITCH);
      expect([atSwitch.decision.stage, atSwitch.verdict]).toEqual(["overdue", "warn"]);
      // The ALERT stage is the true clock (escalated at 36h), the BLOCK waits out the grace: enforce_from + 24h.
      const escalatedButGraced = await evaluateAt(ORG_A, stale, at(SWITCH, 12));
      expect([escalatedButGraced.decision.stage, escalatedButGraced.verdict]).toEqual([
        "escalated",
        "warn",
      ]);
      expect((await evaluateAt(ORG_A, stale, at(SWITCH, 24, -1))).verdict).toBe("warn");
      expect((await evaluateAt(ORG_A, stale, at(SWITCH, 24))).verdict).toBe("blocked");

      // started after the switch: blockFrom = clock + threshold (enforce_from is earlier than the clock, so it never delays)
      expect((await evaluateAt(ORG_A, fresh, at(SWITCH, 25, -1))).verdict).toBe("clear");
      expect((await evaluateAt(ORG_A, fresh, at(SWITCH, 25))).verdict).toBe("blocked");
    });
  });

  // ===============================================================================================================
  // 5. evaluator and gate agree
  // ===============================================================================================================
  describe("5. evaluateMemberClosure and the gate agree at every boundary, in every mode", () => {
    const CLOCK0 = new Date("2026-11-10T08:00:00.000Z");
    /** [label, hours after the clock start, extra ms, expected stage] for T = 24h. */
    const BOUNDARIES: ReadonlyArray<readonly [string, number, number, string]> = [
      ["T-6h minus 1ms", 18, -1, "ok"],
      ["T-6h (at_risk begins)", 18, 0, "at_risk"],
      ["T minus 1ms", 24, -1, "at_risk"],
      ["T (overdue begins)", 24, 0, "overdue"],
      ["T+12h minus 1ms", 36, -1, "overdue"],
      ["T+12h (escalated begins)", 36, 0, "escalated"],
    ];
    const VERDICTS: Record<Mode, readonly string[]> = {
      off: ["clear", "clear", "clear", "clear", "clear", "clear"],
      warn: ["clear", "clear", "clear", "warn", "warn", "warn"],
      block: ["clear", "clear", "clear", "blocked", "blocked", "blocked"],
    };
    let clinician: Member;

    beforeAll(async () => {
      clinician = await seedMember(orgs.A, "matrix-clinician");
      await seedEncounter({
        org: orgs.A,
        authorMembershipId: clinician.membershipId,
        clockStartedAt: CLOCK0,
      });
    });

    for (const mode of ["off", "warn", "block"] as const) {
      it(`mode ${mode}: the evaluator's verdict and the gate's refusal match at all six boundaries`, async () => {
        await setPolicy(ORG_A, mode, { thresholdHours: 24, enforceFrom: null });
        const clock = { now: CLOCK0 };
        const { gate } = buildGate(clock); // one gate per mode: its clear-verdict cache must not carry a member past blockFrom
        for (const [index, [label, hours, extraMs, stage]] of BOUNDARIES.entries()) {
          const now = at(CLOCK0, hours, extraMs);
          clock.now = now;
          const evaluation = await evaluateAt(ORG_A, clinician, now);
          const expectedVerdict = VERDICTS[mode][index];
          // mode off reads no note, so its decision is the no-clock one; every other mode stages the real note
          const expectedStage = mode === "off" ? "ok" : stage;
          expect(evaluation.verdict, `${mode} @ ${label}`).toBe(expectedVerdict);
          expect(evaluation.decision.stage, `${mode} @ ${label} stage`).toBe(expectedStage);
          const outcome = await gateOutcome(gate, ORG_A, clinician);
          expect(outcome, `${mode} @ ${label} gate`).toBe(
            evaluation.verdict === "blocked" ? "NOTE_CLOSURE_REQUIRED" : "pass",
          );
          // an allowlisted route is never refused, even blocked
          expect(await gateOutcome(gate, ORG_A, clinician, ALLOWLISTED)).toBe("pass");
        }
      });
    }

    it("the enforce_from grace moves only the block instant: block @ clock+34h, alerts stay on the true clock", async () => {
      await setPolicy(ORG_A, "block", { thresholdHours: 24, enforceFrom: at(CLOCK0, 10) });
      const clock = { now: CLOCK0 };
      const { gate } = buildGate(clock);
      const walk: ReadonlyArray<readonly [number, number, string, string]> = [
        [24, 0, "overdue", "warn"],
        [34, -1, "overdue", "warn"],
        [34, 0, "overdue", "blocked"],
        [36, 0, "escalated", "blocked"],
      ];
      for (const [hours, extraMs, stage, verdict] of walk) {
        const now = at(CLOCK0, hours, extraMs);
        clock.now = now;
        const evaluation = await evaluateAt(ORG_A, clinician, now);
        expect([evaluation.decision.stage, evaluation.verdict], `+${hours}h${extraMs}ms`).toEqual([
          stage,
          verdict,
        ]);
        expect(await gateOutcome(gate, ORG_A, clinician)).toBe(
          verdict === "blocked" ? "NOTE_CLOSURE_REQUIRED" : "pass",
        );
      }
    });

    it("a legacy note with a null clock is never selected (control: stamping its clock blocks the same clinician)", async () => {
      await setPolicy(ORG_A, "block", { thresholdHours: 24 });
      const legacy = await seedMember(orgs.A, "legacy-clinician");
      const NOW = new Date("2026-11-18T12:00:00.000Z");
      const noteId = await seedEncounter({
        org: orgs.A,
        authorMembershipId: legacy.membershipId,
        clockStartedAt: null,
      });
      const clock = { now: NOW };
      const { gate } = buildGate(clock);

      const clear = await evaluateAt(ORG_A, legacy, NOW);
      expect([clear.verdict, clear.encounterId, clear.overdueCount]).toEqual(["clear", null, 0]);
      expect(await gateOutcome(gate, ORG_A, legacy)).toBe("pass");
      const scanned = await scanOrgClosureState(handle.db, ORG_A);
      expect(scanned.notes.map((n) => n.encounterId)).not.toContain(noteId);

      await admin.query(
        "UPDATE encounter SET clock_started_at=$2, clock_start_source='draft_opened' WHERE id=$1",
        [noteId, at(NOW, -100)],
      );
      const blocked = await evaluateAt(ORG_A, legacy, NOW);
      expect([blocked.verdict, blocked.encounterId]).toEqual(["blocked", noteId]);
      const { gate: fresh } = buildGate(clock);
      expect(await gateOutcome(fresh, ORG_A, legacy)).toBe("NOTE_CLOSURE_REQUIRED");
    });

    it("assertNotBlocked (the half the EVV offline-sync route asks) agrees with the gate over the real evaluator: a blocked clinician is refused, a clear one passes, a signature lifts it at once", async () => {
      await setPolicy(ORG_A, "block", { thresholdHours: 24 });
      const NOW = new Date("2026-11-18T12:00:00.000Z");
      const blockedMember = await seedMember(orgs.A, "assert-not-blocked");
      const clearMember = await seedMember(orgs.A, "assert-clear");
      const noteId = await seedEncounter({
        org: orgs.A,
        authorMembershipId: blockedMember.membershipId,
        clockStartedAt: at(NOW, -30),
      });
      const { gate } = buildGate({ now: NOW });
      const outcome = async (member: Member): Promise<string> => {
        try {
          await gate.assertNotBlocked({
            organizationId: ORG_A,
            userId: member.userId,
            membershipId: member.membershipId,
          });
          return "pass";
        } catch (error) {
          if (error instanceof ChartWardenError) return error.code;
          throw error;
        }
      };
      expect(await outcome(blockedMember)).toBe("NOTE_CLOSURE_REQUIRED");
      expect(await outcome(clearMember)).toBe("pass");
      await admin.query(
        "UPDATE encounter SET status='signed', signed_at=now(), vocab_version_id=$2 WHERE id=$1",
        [noteId, randomUUID()],
      );
      expect(await outcome(blockedMember)).toBe("pass");
    });

    it("a signed, cosign_pending, cosigned or voided note is not open; a finalized one is; signing clears at once", async () => {
      await setPolicy(ORG_A, "block", { thresholdHours: 24 });
      const closed = await seedMember(orgs.A, "closed-clinician");
      const NOW = new Date("2026-11-18T12:00:00.000Z");
      const old = at(NOW, -100);
      for (const status of ["signed", "cosign_pending", "cosigned", "voided"] as const) {
        await seedEncounter({
          org: orgs.A,
          authorMembershipId: closed.membershipId,
          status,
          clockStartedAt: old,
        });
      }
      const clock = { now: NOW };
      const { gate } = buildGate(clock);
      const none = await evaluateAt(ORG_A, closed, NOW);
      expect([none.verdict, none.encounterId, none.overdueCount]).toEqual(["clear", null, 0]);
      expect(await gateOutcome(gate, ORG_A, closed)).toBe("pass");

      const finalizedId = await seedEncounter({
        org: orgs.A,
        authorMembershipId: closed.membershipId,
        status: "finalized",
        clockStartedAt: old,
      });
      const { gate: fresh } = buildGate(clock);
      expect((await evaluateAt(ORG_A, closed, NOW)).encounterId).toBe(finalizedId);
      expect(await gateOutcome(fresh, ORG_A, closed)).toBe("NOTE_CLOSURE_REQUIRED");

      await admin.query("UPDATE encounter SET status='signed', signed_at=$2 WHERE id=$1", [
        finalizedId,
        NOW,
      ]);
      expect((await evaluateAt(ORG_A, closed, NOW)).verdict).toBe("clear");
      // the same gate that just refused: a block is never cached, so the signature is honoured on the next request
      expect(await gateOutcome(fresh, ORG_A, closed)).toBe("pass");
    });

    it("a policy PUT through the route service invalidates the gate's shared cache (control: an unshared cache stays stale)", async () => {
      const NOW = new Date("2026-11-18T12:00:00.000Z");
      const member = await seedMember(orgs.A, "cache-clinician");
      await seedEncounter({
        org: orgs.A,
        authorMembershipId: member.membershipId,
        clockStartedAt: at(NOW, -26),
      });
      await setPolicy(ORG_A, "warn", { thresholdHours: 24 });
      const shared = createDbClosurePolicyCache(handle.db);
      const clock = { now: NOW };
      const sharedGate = buildGate(clock, shared).gate;
      // its own, never-invalidated cache: another replica, in effect (a long TTL so a slow CI machine cannot expire it mid-test)
      const otherReplicaCache = createClosurePolicyCache({
        ttlMs: LONG_TTL_MS,
        load: (organizationId, kind) =>
          withOrgContext(handle.db, systemOrgContext(organizationId), (tx) =>
            readClosurePolicy(tx as unknown as DbClient, organizationId, kind),
          ),
      });
      const staleGate = buildGate(clock, otherReplicaCache).gate;
      expect(await gateOutcome(sharedGate, ORG_A, member)).toBe("pass");
      expect(await gateOutcome(staleGate, ORG_A, member)).toBe("pass");

      // enforce_from = NOW-25h (the PUT's own clock), the note started NOW-26h: blockFrom = max(clock, enforce_from) + 24h = NOW-1h
      const service = createDbClosureRouteService({
        db: handle.db,
        policyCache: shared,
        now: () => at(NOW, -25),
      });
      await service.putPolicy(
        {
          organizationId: ORG_A,
          userId: supervisorA.userId,
          membershipId: supervisorA.membershipId,
        },
        { mode: "block", thresholdHours: 24 },
        auditContextOf(ORG_A, supervisorA.userId),
      );
      // the invalidated shared cache re-reads `block`; the other gate still holds the warn it cached before the PUT (within its 5s TTL)
      expect(await gateOutcome(sharedGate, ORG_A, member)).toBe("NOTE_CLOSURE_REQUIRED");
      expect(await gateOutcome(staleGate, ORG_A, member)).toBe("pass");
    });
  });

  // ===============================================================================================================
  // 6. the partial index serves the reader and the sweep scan
  // ===============================================================================================================
  describe("6. encounter_open_clock_idx serves the reader query and the sweep scan (EXPLAIN as chartwarden_app)", () => {
    const INDEX = "encounter_open_clock_idx";
    const NOW = new Date("2026-11-18T12:00:00.000Z");
    const SIGNED_ROWS = 40_000;
    const OPEN_CLOCKED_ROWS = 400;
    const OPEN_LEGACY_ROWS = 600;
    const MEMBERS = 40;
    let probeMember: Member;
    let readerQuery: { text: string; values: unknown[] };
    let scanQuery: { text: string; values: unknown[] };

    beforeAll(async () => {
      const members: Member[] = [];
      for (let i = 0; i < MEMBERS; i += 1) members.push(await seedMember(orgs.P, `perf-${i}`));
      probeMember = members[0] as Member;
      const ids = members.map((m) => m.membershipId);
      const common = `(organization_id, provider_entity_id, location_id, patient_id, admission_id, encounter_type, discipline,
         authored_by_membership_id, service_date, status, vocab_version_id, signed_at, clock_started_at, clock_start_source)`;
      const author = "(($2::uuid[])[1 + (g % $3::int)])";
      // Bulk seed as the superuser with triggers off: realistic table size is the point, not the audit trail.
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      const base = [ORG_P, ids, MEMBERS, orgs.P.providerEntityId, orgs.P.locationIds[0]] as const;
      await admin.query(
        `INSERT INTO encounter ${common}
         SELECT $1, $4, $5, gen_random_uuid(), gen_random_uuid(), 'routine_visit', 'rn', ${author}, date '${SERVICE_DATE}',
                'signed', gen_random_uuid(), now(), now() - (g || ' minutes')::interval, 'draft_created'
           FROM generate_series(1, ${SIGNED_ROWS}) g`,
        [...base],
      );
      await admin.query(
        `INSERT INTO encounter ${common}
         SELECT $1, $4, $5, gen_random_uuid(), gen_random_uuid(), 'routine_visit', 'rn', ${author}, date '${SERVICE_DATE}',
                'draft', NULL, NULL, now() - (g || ' minutes')::interval, 'draft_created'
           FROM generate_series(1, ${OPEN_CLOCKED_ROWS}) g`,
        [...base],
      );
      await admin.query(
        `INSERT INTO encounter ${common}
         SELECT $1, $4, $5, gen_random_uuid(), gen_random_uuid(), 'routine_visit', 'rn', ${author}, date '${SERVICE_DATE}',
                'draft', NULL, NULL, NULL, NULL
           FROM generate_series(1, ${OPEN_LEGACY_ROWS}) g`,
        [...base],
      );
      await admin.query("COMMIT");
      await admin.query("ANALYZE encounter");
    }, 300_000);

    /** Every index name used anywhere in an EXPLAIN (FORMAT JSON) plan tree. */
    function indexesUsed(node: unknown): string[] {
      if (Array.isArray(node)) return node.flatMap(indexesUsed);
      if (node === null || typeof node !== "object") return [];
      return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
        key === "Index Name" && typeof value === "string" ? [value] : indexesUsed(value),
      );
    }
    const explainAsApp = (query: { text: string; values: unknown[] }) =>
      asApp(ORG_P, probeMember.userId, async (c) => {
        const result = await c.query({
          text: `EXPLAIN (ANALYZE false, FORMAT JSON) ${query.text}`,
          values: query.values,
        });
        return indexesUsed(one(result.rows)["QUERY PLAN"]);
      });

    it("captures the production reader query and the sweep scan query as they are really sent", async () => {
      capturedSql.length = 0;
      await inOrg(ORG_P, probeMember.userId, (tx) =>
        evaluateMemberClosure(tx, {
          organizationId: ORG_P,
          membershipId: probeMember.membershipId,
          now: NOW,
          policy: { mode: "warn", thresholdHours: 24, enforceFrom: null },
        }),
      );
      const reader = capturedSql.filter(
        (q) => /from "encounter"/.test(q.text) && /"clock_started_at" is not null/.test(q.text),
      );
      readerQuery = one(reader);
      expect(readerQuery.text).toMatch(/IN \('draft', 'finalized'\)/);

      capturedSql.length = 0;
      await setPolicy(ORG_P, "warn");
      const scan = await scanOrgClosureState(handle.db, ORG_P);
      expect(scan.notes.length).toBe(OPEN_CLOCKED_ROWS);
      scanQuery = one(
        capturedSql.filter(
          (q) => /inner join "membership"/.test(q.text) && /from "encounter"/.test(q.text),
        ),
      );
    });

    it("the reader query plans on encounter_open_clock_idx (realistic row counts; no enable_seqscan tweak)", async () => {
      expect(await explainAsApp(readerQuery)).toContain(INDEX);
    });

    it("the sweep's scanOrgClosureState query plans on encounter_open_clock_idx too", async () => {
      expect(await explainAsApp(scanQuery)).toContain(INDEX);
    });

    it("negative controls: without the index, or without a provable predicate, the plan does not use it", async () => {
      for (const query of [readerQuery, scanQuery]) {
        await admin.query("BEGIN");
        try {
          await admin.query(`DROP INDEX ${INDEX}`);
          const result = await admin.query({
            text: `EXPLAIN (ANALYZE false, FORMAT JSON) ${query.text}`,
            values: query.values,
          });
          expect(indexesUsed(one(result.rows)["QUERY PLAN"])).not.toContain(INDEX);
        } finally {
          await admin.query("ROLLBACK"); // DDL is transactional: the index is back
        }
      }
      // A status list the planner cannot prove implies the partial-index predicate: the literal list matters.
      const widened = {
        ...readerQuery,
        text: readerQuery.text.replace(
          /IN \('draft', 'finalized'\)/,
          "IN ('draft', 'finalized', 'signed')",
        ),
      };
      expect(widened.text).not.toBe(readerQuery.text);
      expect(await explainAsApp(widened)).not.toContain(INDEX);
      expect(await explainAsApp(readerQuery)).toContain(INDEX);
    });
  });

  // ===============================================================================================================
  // 7. the alert sweep over the real emitter
  // ===============================================================================================================
  describe("7. runNoteClosureSweep + scanOrgClosureState over the real AlertEmitter", () => {
    const TICK_MS = 15 * MINUTE_MS;
    const alertCatalog = (() => {
      const registry = createAlertPayloadRegistry();
      registry.register(M8_CLOSURE_ALERT_PAYLOADS);
      return registry.build();
    })();
    const emitted: { tick: Date; eventType: string; correlationId: string; severity: string }[] =
      [];
    let emitter: AlertEmitter;
    let author: Member;
    let supervisorS: Member;
    let bystander: Member;

    const recordingEmit =
      (tick: Date): AlertEmitter["emit"] =>
      async (organizationId, input) => {
        const entry = alertCatalog.get(input.eventType);
        if (!entry) throw new Error(`${input.eventType} is not in the alert payload catalog`);
        expect(Value.Check(entry.payloadSchema, input.payload), `${input.eventType} payload`).toBe(
          true,
        );
        emitted.push({
          tick,
          eventType: input.eventType,
          correlationId: input.correlationId,
          severity: input.severity,
        });
        return emitter.emit(organizationId, input);
      };
    const sweepAt = (tick: Date) =>
      runNoteClosureSweep({
        listActiveOrgs: async () => [{ organizationId: ORG_S }],
        scanOrg: (organizationId) => scanOrgClosureState(handle.db, organizationId),
        // the REAL batched pre-filter (M36's reader over the alert table), exactly as the composition root injects it
        existingCorrelations: createDbAlertCorrelationReader(handle.db),
        emit: recordingEmit(tick),
        now: () => tick,
      });
    async function tickThrough(from: Date, toHours: number): Promise<void> {
      for (let tick = from.getTime(); tick <= from.getTime() + toHours * HOUR_MS; tick += TICK_MS) {
        await sweepAt(new Date(tick));
      }
    }
    const correlation = (encounterId: string, stage: string) =>
      `m8:closure:visit_note:${encounterId}:${stage}`;
    async function alertsFor(encounterId: string, stage: string) {
      const alerts = await admin.query(
        "SELECT id, event_type, severity, payload FROM alert WHERE organization_id=$1 AND correlation_id=$2",
        [ORG_S, correlation(encounterId, stage)],
      );
      const recipients = await admin.query(
        `SELECT DISTINCT d.recipient_user_id::text AS user_id FROM notification_delivery d JOIN alert a ON a.id = d.alert_id
          WHERE a.organization_id=$1 AND a.correlation_id=$2`,
        [ORG_S, correlation(encounterId, stage)],
      );
      return {
        alerts: alerts.rows,
        recipients: recipients.rows.map((r) => r.user_id as string).sort(),
      };
    }
    const emitsFor = (encounterId: string) =>
      emitted.filter((e) => e.correlationId.includes(encounterId));

    beforeAll(async () => {
      await wireAlertRuleSeed(handle.db);
      emitter = createDrizzleAlertEmitter(handle.db);
      author = await seedMember(orgs.S, "sweep-author", { roleKey: "rn" });
      supervisorS = await seedMember(orgs.S, "sweep-supervisor", {
        roleKey: "clinical_supervisor",
        assignToProviderEntity: true,
      });
      bystander = await seedMember(orgs.S, "sweep-bystander", { roleKey: "rn" });
    }, 120_000);

    it("one alert per stage per note across 15-minute ticks, each emitted exactly once (nothing re-emitted); author-only until escalation", async () => {
      await setPolicy(ORG_S, "warn", { thresholdHours: 24 });
      const CLOCK = new Date("2026-12-01T08:00:00.000Z");
      const noteId = await seedEncounter({
        org: orgs.S,
        authorMembershipId: author.membershipId,
        clockStartedAt: CLOCK,
      });
      await tickThrough(at(CLOCK, 10), 30); // 10h .. 40h after the clock start

      const stageStart: Record<string, number> = {
        closure_at_risk: 18,
        closure_overdue: 24,
        closure_escalated: 36,
      };
      const mine = emitsFor(noteId);
      expect(new Set(mine.map((e) => e.eventType))).toEqual(
        new Set([
          "m8.encounter.closure_at_risk",
          "m8.encounter.closure_overdue",
          "m8.encounter.closure_escalated",
        ]),
      );
      // each stage is emitted by the FIRST tick at or after it begins, and by no other (the already-alerted filter keeps the rest quiet)
      expect(mine).toHaveLength(3);
      for (const emit of mine) {
        const begins = stageStart[emit.eventType.replace("m8.encounter.", "")] as number;
        const offsetHours = (emit.tick.getTime() - CLOCK.getTime()) / HOUR_MS;
        expect(offsetHours, emit.eventType).toBeGreaterThanOrEqual(begins);
        expect(offsetHours, emit.eventType).toBeLessThan(begins + TICK_MS / HOUR_MS);
      }
      expect(Object.fromEntries(mine.map((e) => [e.eventType, e.severity]))).toEqual({
        "m8.encounter.closure_at_risk": "info",
        "m8.encounter.closure_overdue": "warn",
        "m8.encounter.closure_escalated": "warn",
      });

      // One alert per stage (the pre-filter stops the re-emits; the emitter's unique (org, correlation id) is the backstop).
      for (const stage of ["at_risk", "overdue", "escalated"]) {
        const { alerts } = await alertsFor(noteId, stage);
        expect(alerts, stage).toHaveLength(1);
      }
      expect((await alertsFor(noteId, "at_risk")).recipients).toEqual([author.userId]);
      expect((await alertsFor(noteId, "overdue")).recipients).toEqual([author.userId]);
      // escalated: the author and the supervisors of the note's provider entity; never an uninvolved clinician
      expect((await alertsFor(noteId, "escalated")).recipients).toEqual(
        [author.userId, supervisorS.userId].sort(),
      );
      expect((await alertsFor(noteId, "escalated")).recipients).not.toContain(bystander.userId);
      const [overdue] = (await alertsFor(noteId, "overdue")).alerts;
      expect(overdue.payload).toMatchObject({
        obligationKind: "visit_note",
        encounterId: noteId,
        stage: "overdue",
        authorUserId: author.userId,
      });
      expect(JSON.stringify(overdue.payload)).not.toMatch(/patient/i);
    }, 240_000);

    it("has no lookback: a tick that first sees a note long after a stage began still alerts its CURRENT stage, once, and never an earlier one", async () => {
      const CLOCK = new Date("2026-12-05T08:00:00.000Z");
      const noteId = await seedEncounter({
        org: orgs.S,
        authorMembershipId: author.membershipId,
        clockStartedAt: CLOCK,
      });
      await sweepAt(at(CLOCK, 30)); // overdue began 6h ago, at_risk 12h ago: a worker outage, a late EVV instant or a lowered threshold
      expect(emitsFor(noteId).map((e) => e.eventType)).toEqual(["m8.encounter.closure_overdue"]);
      expect((await alertsFor(noteId, "overdue")).alerts).toHaveLength(1);
      expect((await alertsFor(noteId, "overdue")).recipients).toEqual([author.userId]);
      expect((await alertsFor(noteId, "at_risk")).alerts).toHaveLength(0); // not retroactive
      expect((await alertsFor(noteId, "escalated")).alerts).toHaveLength(0);
      await sweepAt(at(CLOCK, 30, TICK_MS)); // the next tick finds it alerted already: nothing is emitted
      expect(emitsFor(noteId)).toHaveLength(1);
    });

    it("the batched reader answers for ITS organization only, and across chunk boundaries", async () => {
      const CLOCK = new Date("2026-12-06T08:00:00.000Z");
      const noteId = await seedEncounter({
        org: orgs.S,
        authorMembershipId: author.membershipId,
        clockStartedAt: CLOCK,
      });
      await sweepAt(at(CLOCK, 24, MINUTE_MS));
      const real = correlation(noteId, "overdue");
      const absent = correlation(noteId, "escalated");
      const reader = createDbAlertCorrelationReader(handle.db);
      expect([...(await reader(ORG_S, [real, absent]))]).toEqual([real]);
      expect((await reader(ORG_S, [])).size).toBe(0);
      // another tenant cannot see it, by RLS and by predicate
      expect((await reader(ORG_A, [real])).size).toBe(0);
      // 2,500 ids span three statements; the one real id is still found (and duplicates collapse)
      const padding = Array.from(
        { length: 2_500 },
        (_, i) => `m8:closure:visit_note:none-${i}:overdue`,
      );
      expect([...(await reader(ORG_S, [...padding, real, real]))]).toEqual([real]);
    });

    it("an author who is no longer an active member: the author-only stages are skipped, the escalation still reaches the supervisors", async () => {
      const leaver = await seedMember(orgs.S, "sweep-leaver", { roleKey: "rn" });
      await admin.query("UPDATE membership SET status='suspended' WHERE id=$1", [
        leaver.membershipId,
      ]);
      const CLOCK = new Date("2026-12-07T08:00:00.000Z");
      const noteId = await seedEncounter({
        org: orgs.S,
        authorMembershipId: leaver.membershipId,
        clockStartedAt: CLOCK,
      });
      const scanned = (await scanOrgClosureState(handle.db, ORG_S)).notes.find(
        (n) => n.encounterId === noteId,
      );
      expect(scanned?.authorUserId).toBeNull();
      await sweepAt(at(CLOCK, 19)); // at_risk: nobody to tell
      await sweepAt(at(CLOCK, 25)); // overdue: nobody to tell
      expect(emitsFor(noteId)).toHaveLength(0);
      await sweepAt(at(CLOCK, 37)); // escalated: the supervisors still hear
      expect(emitsFor(noteId).map((e) => e.eventType)).toEqual(["m8.encounter.closure_escalated"]);
      const { alerts, recipients } = await alertsFor(noteId, "escalated");
      expect(alerts).toHaveLength(1);
      expect(alerts[0].payload.authorUserId).toBeNull();
      expect(recipients).toEqual([supervisorS.userId]);
    });

    it("mode off emits nothing, ever; flipping the same org to warn then alerts (the control)", async () => {
      const CLOCK = new Date("2026-12-10T08:00:00.000Z");
      const noteId = await seedEncounter({
        org: orgs.S,
        authorMembershipId: author.membershipId,
        clockStartedAt: CLOCK,
      });
      await setPolicy(ORG_S, "off", { thresholdHours: 24 });
      expect((await scanOrgClosureState(handle.db, ORG_S)).notes).toEqual([]);
      await tickThrough(at(CLOCK, 17), 9);
      expect(emitsFor(noteId)).toHaveLength(0);
      expect((await alertsFor(noteId, "at_risk")).alerts).toHaveLength(0);
      expect((await alertsFor(noteId, "overdue")).alerts).toHaveLength(0);

      await setPolicy(ORG_S, "warn", { thresholdHours: 24 });
      await tickThrough(at(CLOCK, 17), 9);
      expect(emitsFor(noteId).length).toBeGreaterThan(0);
      expect((await alertsFor(noteId, "overdue")).alerts).toHaveLength(1);
    }, 240_000);

    it("the real cron body (runEncounterAttentionCron) runs the same sweep over the real emitter", async () => {
      await setPolicy(ORG_S, "warn", { thresholdHours: 24 });
      const CLOCK = new Date("2026-12-20T08:00:00.000Z");
      const noteId = await seedEncounter({
        org: orgs.S,
        authorMembershipId: author.membershipId,
        clockStartedAt: CLOCK,
      });
      const deps = {
        ...buildM8WorkerDeps({
          connection: {} as never,
          db: handle.db,
          outbox: {} as never,
          activeOrgs: { listActiveOrgs: async () => [{ organizationId: ORG_S }] },
          alerts: emitter,
          existingAlertCorrelations: createDbAlertCorrelationReader(handle.db),
        }),
        now: () => at(CLOCK, 24, 5 * MINUTE_MS),
      };
      await runEncounterAttentionCron(deps);
      const { alerts, recipients } = await alertsFor(noteId, "overdue");
      expect(alerts).toHaveLength(1);
      expect(recipients).toEqual([author.userId]);
    });

    it("block mode alerts on the TRUE clock: enforce_from delays the block, never the alert", async () => {
      const CLOCK = new Date("2026-12-15T08:00:00.000Z");
      const noteId = await seedEncounter({
        org: orgs.S,
        authorMembershipId: author.membershipId,
        clockStartedAt: CLOCK,
      });
      await setPolicy(ORG_S, "block", { thresholdHours: 24, enforceFrom: at(CLOCK, 100) });
      await sweepAt(at(CLOCK, 24, 5 * MINUTE_MS));
      expect((await alertsFor(noteId, "overdue")).alerts).toHaveLength(1);
      const evaluation = await evaluateAt(ORG_S, author, at(CLOCK, 24, 5 * MINUTE_MS));
      expect(evaluation.verdict).toBe("warn"); // alerted, but not blocked: the grace holds
    });

    it("a legacy (null-clock) note, a signed note and a voided note are never scanned or alerted; tenants scan only themselves", async () => {
      await setPolicy(ORG_S, "warn", { thresholdHours: 24 });
      const legacy = await seedEncounter({
        org: orgs.S,
        authorMembershipId: author.membershipId,
        clockStartedAt: null,
      });
      const signed = await seedEncounter({
        org: orgs.S,
        authorMembershipId: author.membershipId,
        status: "signed",
        clockStartedAt: new Date("2026-12-01T00:00:00.000Z"),
      });
      const voided = await seedEncounter({
        org: orgs.S,
        authorMembershipId: author.membershipId,
        status: "voided",
        clockStartedAt: new Date("2026-12-01T00:00:00.000Z"),
      });
      const scannedS = (await scanOrgClosureState(handle.db, ORG_S)).notes.map(
        (n) => n.encounterId,
      );
      for (const id of [legacy, signed, voided]) expect(scannedS).not.toContain(id);
      await tickThrough(new Date("2026-12-01T00:00:00.000Z"), 60);
      for (const id of [legacy, signed, voided]) expect(emitsFor(id)).toHaveLength(0);

      const scannedA = (await scanOrgClosureState(handle.db, ORG_A)).notes.map(
        (n) => n.encounterId,
      );
      expect(scannedA.filter((id) => scannedS.includes(id))).toEqual([]);
      expect(scannedS.length).toBeGreaterThan(0);
    }, 240_000);
  });

  // ===============================================================================================================
  // 8. the stamp consumer
  // ===============================================================================================================
  describe("8. m8.stamp-note-clock behind the real publisher and the real dispatcher", () => {
    /** When M17 recorded the start (the outbox row's server-side `created_at`): the clamp's upper bound, never the delivery time. */
    const RECORDED = new Date("2026-01-15T14:05:00.000Z");
    const STARTED = "2026-01-15T14:00:00.000Z";
    let publisher: ReturnType<typeof buildTxOutboxPublisher>;
    let dispatcher: ReturnType<typeof createOutboxDispatcher>;
    let consumer: ReturnType<typeof buildM8VisitStartedNoteClockConsumer>;
    let author: Member;
    let authorB: Member;

    const publishStarted = (
      orgId: string,
      visitId: string,
      startedAt: string,
      evvBracketState: string,
      payloadOverride: Record<string, unknown> = {},
    ) =>
      withOrgContext(handle.db, { organizationId: orgId, userId: "" }, (tx) =>
        publisher.publish(
          tx as never,
          {
            eventName: "m17.visit.started",
            payload: { visitId, startedAt, evvBracketState, ...payloadOverride },
            organizationId: orgId,
            aggregateKind: "visit",
            aggregateId: visitId,
            callerModule: "m17",
          } as never,
        ),
      );
    const clockOf = async (encounterId: string) =>
      one(
        (
          await admin.query(
            "SELECT clock_started_at, clock_start_source, status, version, updated_at FROM encounter WHERE id=$1",
            [encounterId],
          )
        ).rows,
      );
    const outboxStatus = async (visitId: string) =>
      (
        await admin.query(
          "SELECT status FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at",
          [visitId],
        )
      ).rows.map((r) => r.status as string);

    beforeAll(async () => {
      author = await seedMember(orgs.A, "stamp-author");
      authorB = await seedMember(orgs.B, "stamp-author-b");
      publisher = buildTxOutboxPublisher(
        buildBootOutboxCatalog([M8_OUTBOX_EVENTS, M17_OUTBOX_EVENTS]),
      );
      consumer = buildM8VisitStartedNoteClockConsumer({ db: handle.db });
      dispatcher = createOutboxDispatcher({
        db: handle.db,
        orgs: {
          listActiveOrgs: async () => [{ organizationId: ORG_A }, { organizationId: ORG_B }],
        },
        consumers: [consumer],
        eventCatalog: buildBootOutboxCatalog([M8_OUTBOX_EVENTS, M17_OUTBOX_EVENTS]),
        options: { log: () => {} },
      });
    });

    it("stamps the seeded draft once, from an EVV event: source evv_check_in, clock = the arrival instant", async () => {
      const visitId = randomUUID();
      const id = await seedEncounter({
        org: orgs.A,
        authorMembershipId: author.membershipId,
        visitId,
      });
      await publishStarted(ORG_A, visitId, STARTED, "evv_present");
      await dispatcher.tick();
      const row = await clockOf(id);
      expect(row.clock_started_at.toISOString()).toBe(STARTED);
      expect(row.clock_start_source).toBe("evv_check_in");
      expect(await outboxStatus(visitId)).toEqual(["dispatched"]);
    });

    it("write-once: a second event moves nothing, and redelivering the very same row is a no-op (no version bump)", async () => {
      const visitId = randomUUID();
      const id = await seedEncounter({
        org: orgs.A,
        authorMembershipId: author.membershipId,
        visitId,
      });
      await publishStarted(ORG_A, visitId, STARTED, "evv_present");
      await dispatcher.tick();
      const first = await clockOf(id);

      await publishStarted(ORG_A, visitId, "2026-01-15T14:03:00.000Z", "self_attested");
      await dispatcher.tick();
      const afterSecond = await clockOf(id);
      expect(afterSecond.clock_started_at.toISOString()).toBe(STARTED);
      expect(afterSecond.clock_start_source).toBe("evv_check_in");

      const delivered = await admin.query(
        "SELECT id, organization_id, event_type, aggregate_kind, aggregate_id, payload, attempt_count, created_at FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at LIMIT 1",
        [visitId],
      );
      const row = one(delivered.rows);
      await consumer.handle({
        id: row.id,
        organizationId: row.organization_id,
        eventType: row.event_type,
        aggregateKind: row.aggregate_kind,
        aggregateId: row.aggregate_id,
        payload: row.payload,
        attemptCount: row.attempt_count,
        createdAt: row.created_at,
      });
      const afterRedelivery = await clockOf(id);
      expect(afterRedelivery.clock_started_at.toISOString()).toBe(
        first.clock_started_at.toISOString(),
      );
      expect(afterRedelivery.version).toBe(first.version);
      expect(afterRedelivery.updated_at.toISOString()).toBe(first.updated_at.toISOString());
    });

    it("a non-EVV bracket stamps source visit_started; the first event decides the source (a later EVV one does not overwrite it)", async () => {
      const visitId = randomUUID();
      const id = await seedEncounter({
        org: orgs.A,
        authorMembershipId: author.membershipId,
        visitId,
      });
      await publishStarted(ORG_A, visitId, STARTED, "evv_missing_documented");
      await dispatcher.tick();
      expect((await clockOf(id)).clock_start_source).toBe("visit_started");
      await publishStarted(ORG_A, visitId, "2026-01-15T13:59:00.000Z", "evv_present");
      await dispatcher.tick();
      const row = await clockOf(id);
      expect([row.clock_started_at.toISOString(), row.clock_start_source]).toEqual([
        STARTED,
        "visit_started",
      ]);
    });

    it("never touches a signed, cosign_pending, cosigned or voided note", async () => {
      for (const status of ["signed", "cosign_pending", "cosigned", "voided"] as const) {
        const visitId = randomUUID();
        const id = await seedEncounter({
          org: orgs.A,
          authorMembershipId: author.membershipId,
          visitId,
          status,
        });
        await publishStarted(ORG_A, visitId, STARTED, "evv_present");
        await dispatcher.tick();
        const row = await clockOf(id);
        expect([status, row.clock_started_at, row.clock_start_source]).toEqual([
          status,
          null,
          null,
        ]);
        expect(await outboxStatus(visitId)).toEqual(["dispatched"]);
      }
      // control: the same event on a finalized note does stamp
      const visitId = randomUUID();
      const id = await seedEncounter({
        org: orgs.A,
        authorMembershipId: author.membershipId,
        visitId,
        status: "finalized",
      });
      await publishStarted(ORG_A, visitId, STARTED, "evv_present");
      await dispatcher.tick();
      expect((await clockOf(id)).clock_started_at?.toISOString()).toBe(STARTED);
    });

    it("never crosses tenants: the same visit id in two organizations is stamped only for the event's own organization", async () => {
      const visitId = randomUUID();
      const inA = await seedEncounter({
        org: orgs.A,
        authorMembershipId: author.membershipId,
        visitId,
      });
      const inB = await seedEncounter({
        org: orgs.B,
        authorMembershipId: authorB.membershipId,
        visitId,
      });
      await publishStarted(ORG_A, visitId, STARTED, "evv_present");
      await dispatcher.tick();
      expect((await clockOf(inA)).clock_started_at?.toISOString()).toBe(STARTED);
      expect((await clockOf(inB)).clock_started_at).toBeNull();

      const onlyInB = randomUUID();
      const soleB = await seedEncounter({
        org: orgs.B,
        authorMembershipId: authorB.membershipId,
        visitId: onlyInB,
      });
      await publishStarted(ORG_A, onlyInB, STARTED, "evv_present"); // org A has no such visit
      await dispatcher.tick();
      expect((await clockOf(soleB)).clock_started_at).toBeNull();
      expect(await outboxStatus(onlyInB)).toEqual(["dispatched"]);
      // control: org B's own event stamps it
      await publishStarted(ORG_B, onlyInB, STARTED, "evv_present");
      await dispatcher.tick();
      expect((await clockOf(soleB)).clock_started_at?.toISOString()).toBe(STARTED);
    });

    it("clamps a skewed device clock to [service date local midnight, the event's creation time] using the organization's timezone; a late delivery cannot widen it", async () => {
      const behind = randomUUID();
      const ahead = randomUUID();
      const behindId = await seedEncounter({
        org: orgs.A,
        authorMembershipId: author.membershipId,
        visitId: behind,
      });
      const aheadId = await seedEncounter({
        org: orgs.A,
        authorMembershipId: author.membershipId,
        visitId: ahead,
      });
      const zone = await inOrg(ORG_A, author.userId, (tx) => organizationTimezone(tx, ORG_A));
      expect(zone).toBe("America/New_York");
      await publishStarted(ORG_A, behind, "2026-01-13T10:00:00.000Z", "evv_present"); // two days early
      await publishStarted(ORG_A, ahead, "2026-01-15T20:00:00.000Z", "evv_present"); // after the instant M17 recorded the start
      // The outbox row is stamped by the database clock; pin it to the scenario's instant. The dispatcher then delivers it months
      // LATER (the suite's real now), and the clamp must still hold at the creation time, not at the delivery time.
      await admin.query("UPDATE outbox_event SET created_at=$1 WHERE aggregate_id=ANY($2)", [
        RECORDED,
        [behind, ahead],
      ]);
      await dispatcher.tick();
      expect((await clockOf(behindId)).clock_started_at.toISOString()).toBe(
        NEW_YORK_SERVICE_DATE_START,
      );
      expect((await clockOf(aheadId)).clock_started_at.toISOString()).toBe(RECORDED.toISOString());
    });

    it("the real publisher refuses a payload the catalog rejects, and nothing is written", async () => {
      const visitId = randomUUID();
      await expect(
        publishStarted(ORG_A, visitId, STARTED, "evv_present", { visitId: undefined }),
      ).rejects.toBeDefined();
      expect(await outboxStatus(visitId)).toEqual([]);
    });
  });

  // ===============================================================================================================
  // 9. routes: read audit and location scope
  // ===============================================================================================================
  describe("9. GET overdue-notes: the read-audit event lands, and the board respects location scope", () => {
    const NOW = new Date("2026-11-18T12:00:00.000Z");
    const KEYS = ["encounter.closure_override", "encounter.author"];
    let wide: Member;
    let siteOne: Member;
    let siteNone: Member;
    let outsider: Member;
    let authorR: Member;
    const noteIds: Record<string, string> = {};
    let app: ReturnType<typeof buildServer>;

    function headerAuth(request: FastifyRequest): void {
      const user = request.headers["x-test-user"];
      if (typeof user !== "string" || user.length === 0) return;
      const membership = request.headers["x-test-membership"];
      const roles = request.headers["x-test-roles"];
      const locations = request.headers["x-test-locations"];
      request.context.userId = user;
      request.context.organizationId = ORG_R;
      request.context.attributes.membershipId = typeof membership === "string" ? membership : "";
      request.context.roles = typeof roles === "string" && roles.length > 0 ? roles.split(",") : [];
      request.context.locationIds =
        typeof locations === "string" && locations.length > 0 ? locations.split(",") : [];
    }
    const as = (who: Member, roles: string[], locationIds: readonly string[] = []) => ({
      "x-test-user": who.userId,
      "x-test-membership": who.membershipId,
      "x-test-roles": roles.join(","),
      "x-test-locations": locationIds.join(","),
    });
    const grant = (who: Member, permissionKeys: string[]) => ({
      orgId: ORG_R,
      userId: who.userId,
      grants: [{ roleKey: "seed", enabled: true, expiresAt: null, permissionKeys }],
    });
    const boardIds = (body: string): string[] =>
      (JSON.parse(body) as { items: { encounterId: string }[] }).items
        .map((i) => i.encounterId)
        .sort();
    // The board is audited as a multi-patient read: one `encounter.viewed` event per distinct patient on the page.
    const viewEvents = async (actor: Member) =>
      (
        await admin.query(
          `SELECT event_type, resource_id::text AS resource_id, context FROM audit_event
            WHERE organization_id=$1 AND actor_user_id=$2 AND event_type IN ('encounter.viewed', 'encounter.list_viewed')
            ORDER BY created_at`,
          [ORG_R, actor.userId],
        )
      ).rows;
    const patientsOf = async (ids: readonly (string | undefined)[]): Promise<string[]> =>
      (
        await admin.query<{ patient_id: string }>(
          "SELECT patient_id::text AS patient_id FROM encounter WHERE id = ANY($1)",
          [ids],
        )
      ).rows
        .map((r) => r.patient_id)
        .sort();

    beforeAll(async () => {
      wide = await seedMember(orgs.R, "board-wide", { roleKey: "director_of_nursing" });
      siteOne = await seedMember(orgs.R, "board-site-one", { roleKey: "clinical_supervisor" });
      siteNone = await seedMember(orgs.R, "board-site-none", { roleKey: "clinical_supervisor" });
      outsider = await seedMember(orgs.R, "board-outsider");
      authorR = await seedMember(orgs.R, "board-author", { roleKey: "rn" });
      const authorOther = await seedMember(orgs.B, "board-author-b");
      await setPolicy(ORG_R, "block", { thresholdHours: 24 });
      await setPolicy(ORG_B, "block", { thresholdHours: 24 });
      noteIds.overdueOne = await seedEncounter({
        org: orgs.R,
        authorMembershipId: authorR.membershipId,
        clockStartedAt: at(NOW, -30),
        locationIndex: 0,
      });
      noteIds.overdueTwo = await seedEncounter({
        org: orgs.R,
        authorMembershipId: authorR.membershipId,
        clockStartedAt: at(NOW, -40),
        locationIndex: 1,
      });
      noteIds.atRiskOne = await seedEncounter({
        org: orgs.R,
        authorMembershipId: authorR.membershipId,
        status: "finalized",
        clockStartedAt: at(NOW, -19),
        locationIndex: 0,
      });
      noteIds.fresh = await seedEncounter({
        org: orgs.R,
        authorMembershipId: authorR.membershipId,
        clockStartedAt: at(NOW, -2),
        locationIndex: 0,
      });
      noteIds.legacy = await seedEncounter({
        org: orgs.R,
        authorMembershipId: authorR.membershipId,
        clockStartedAt: null,
        locationIndex: 0,
      });
      noteIds.signed = await seedEncounter({
        org: orgs.R,
        authorMembershipId: authorR.membershipId,
        status: "signed",
        clockStartedAt: at(NOW, -50),
        locationIndex: 0,
      });
      noteIds.otherTenant = await seedEncounter({
        org: orgs.B,
        authorMembershipId: authorOther.membershipId,
        clockStartedAt: at(NOW, -60),
      });

      resetAuthorizationContract();
      resetRbacEngine();
      registerEffectivePermissionResolver(
        createInMemoryEffectivePermissionStore([
          grant(wide, KEYS),
          grant(siteOne, KEYS),
          grant(siteNone, KEYS),
          grant(authorR, ["encounter.author"]),
          grant(outsider, ["encounter.read"]),
        ]).store,
      );
      app = buildServer({
        db: handle.db,
        authenticate: headerAuth,
        security: { rateLimitEnabled: false },
      });
      registerClosureRoutes(app, {
        service: createDbClosureRouteService({ db: handle.db, now: () => NOW }),
      });
      await app.ready();
    }, 120_000);

    afterAll(async () => {
      await app?.close();
    });

    it("an org-wide supervisor sees every site's at-risk and overdue notes, and no other tenant's, legacy or signed note", async () => {
      await admin.query("DELETE FROM audit_event WHERE organization_id=$1", [ORG_R]);
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/encounters/overdue-notes?limit=50",
        headers: as(wide, ["director_of_nursing"]),
      });
      expect(response.statusCode).toBe(200);
      expect(boardIds(response.body)).toEqual(
        [noteIds.overdueOne, noteIds.overdueTwo, noteIds.atRiskOne].sort(),
      );
      expect(boardIds(response.body)).not.toContain(noteIds.otherTenant);
    });

    it("the read events land: one encounter.viewed per distinct patient on the page, attributed to the supervisor, against the first row's encounter", async () => {
      const events = await viewEvents(wide);
      expect(events.map((e) => e.event_type)).toEqual([
        "encounter.viewed",
        "encounter.viewed",
        "encounter.viewed",
      ]);
      // the §164.528 accounting join: every patient the board disclosed, once each
      const attributed = events.map((e) => (e.context as { patientId?: string }).patientId).sort();
      expect(attributed).toEqual(
        await patientsOf([noteIds.overdueOne, noteIds.overdueTwo, noteIds.atRiskOne]),
      );
      // all against the first (oldest) row's id: the config names `items.0.encounterId` as the resource
      expect(new Set(events.map((e) => e.resource_id))).toEqual(new Set([noteIds.overdueTwo]));
    });

    it("a supervisor without org-wide scope sees only their session's locations; none at all sees nothing (fail closed)", async () => {
      const [locationOne, locationTwo] = orgs.R.locationIds;
      const siteOneResponse = await app.inject({
        method: "GET",
        url: "/api/v1/encounters/overdue-notes",
        headers: as(siteOne, ["clinical_supervisor"], [locationOne]),
      });
      expect(siteOneResponse.statusCode).toBe(200);
      expect(boardIds(siteOneResponse.body)).toEqual(
        [noteIds.overdueOne, noteIds.atRiskOne].sort(),
      );

      const siteTwoResponse = await app.inject({
        method: "GET",
        url: "/api/v1/encounters/overdue-notes",
        headers: as(siteOne, ["clinical_supervisor"], [locationTwo]),
      });
      expect(boardIds(siteTwoResponse.body)).toEqual([noteIds.overdueTwo]);

      const noSiteResponse = await app.inject({
        method: "GET",
        url: "/api/v1/encounters/overdue-notes",
        headers: as(siteNone, ["clinical_supervisor"], []),
      });
      expect(noSiteResponse.statusCode).toBe(200);
      expect(boardIds(noSiteResponse.body)).toEqual([]);
      // control: the dataset is not empty, the scope is what narrowed it (the org-wide read above saw all three)
      // and an empty page discloses no patient, so it writes no read event
      expect(await viewEvents(siteNone)).toEqual([]);
      expect((await viewEvents(wide)).length).toBe(3);
      // the site-scoped reads are attributed to exactly the patients each page showed (two, then one)
      const siteOneEvents = await viewEvents(siteOne);
      expect(siteOneEvents).toHaveLength(3);
      expect(
        siteOneEvents.map((e) => (e.context as { patientId?: string }).patientId).sort(),
      ).toEqual(await patientsOf([noteIds.overdueOne, noteIds.atRiskOne, noteIds.overdueTwo]));
    });

    it("a caller without encounter.closure_override is refused and leaves no read event", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/encounters/overdue-notes",
        headers: as(outsider, ["clinical_supervisor"], [...orgs.R.locationIds]),
      });
      expect(response.statusCode).toBe(403);
      expect(await viewEvents(outsider)).toEqual([]);
    });

    it("closure-status answers from the same evaluator: the author of the overdue notes is blocked, naming the oldest", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/encounters/closure-status",
        headers: as(authorR, ["rn"]),
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        mode: "block",
        verdict: "blocked",
        stage: "escalated",
        encounterId: noteIds.overdueTwo,
        // the banner links the oldest note from these two, so it never has to read the (read-audited) encounter itself
        patientId: (await patientsOf([noteIds.overdueTwo]))[0],
        encounterStatus: "draft",
        overdueCount: 2,
      });
      // the author's own position is not a per-patient read: no encounter.viewed event for the patient the answer names
      expect(await viewEvents(authorR)).toEqual([]);
    });

    it("a note with no location is on every supervisor's board, site-scoped ones included (the alert falls back org-wide for it); no sites still sees nothing; another tenant's is never shown", async () => {
      const authorNone = await seedMember(orgs.R, "board-author-no-site", { roleKey: "rn" });
      const noSite = await seedEncounter({
        org: orgs.R,
        authorMembershipId: authorNone.membershipId,
        clockStartedAt: at(NOW, -35),
        locationIndex: null,
      });
      const authorOtherTenant = await seedMember(orgs.B, "board-author-b-no-site");
      const otherTenantNoSite = await seedEncounter({
        org: orgs.B,
        authorMembershipId: authorOtherTenant.membershipId,
        clockStartedAt: at(NOW, -61),
        locationIndex: null,
      });
      const [locationOne, locationTwo] = orgs.R.locationIds;
      const read = async (who: Member, roles: string[], locations: readonly string[]) =>
        boardIds(
          (
            await app.inject({
              method: "GET",
              url: "/api/v1/encounters/overdue-notes",
              headers: as(who, roles, locations),
            })
          ).body,
        );
      expect(await read(wide, ["director_of_nursing"], [])).toContain(noSite);
      const atSiteOne = await read(siteOne, ["clinical_supervisor"], [locationOne]);
      expect(atSiteOne).toContain(noSite);
      expect(await read(siteOne, ["clinical_supervisor"], [locationTwo])).toContain(noSite);
      // control: the scope still narrows by site (overdueTwo is at location two), so the no-site rule is not "see everything"
      expect(atSiteOne).not.toContain(noteIds.overdueTwo);
      // fail closed: no sites in the session sees nothing at all, the no-site note included
      expect(await read(siteNone, ["clinical_supervisor"], [])).toEqual([]);
      // another tenant's no-site note is org-filtered out of every board
      for (const board of [await read(wide, ["director_of_nursing"], []), atSiteOne]) {
        expect(board).not.toContain(otherTenantNoSite);
      }
    });
  });

  // ===============================================================================================================
  // 10. migration 1511
  // ===============================================================================================================
  describe("10. migration 1511 mirrors the two permissions: the override to the four supervisor keys, the policy key to the DON keys and the administrators", () => {
    const KEYS = ["encounter.closure_override", "encounter.closure_policy_admin"];
    const [OVERRIDE, POLICY_ADMIN] = KEYS as [string, string];
    // ADR-0113 D7: who holds what once the migration has run over a tenant that already has these roles
    const EXPECTED: Record<string, string[]> = {
      clinical_supervisor: [OVERRIDE],
      clinical_lead: [OVERRIDE],
      director_of_nursing: [OVERRIDE, POLICY_ADMIN],
      don: [OVERRIDE, POLICY_ADMIN],
      org_admin: [POLICY_ADMIN],
      administrator: [POLICY_ADMIN],
      rn: [],
    };
    const migration = () =>
      readFileSync(join(MIGRATIONS_DIR, "1511_m8_note_closure_permissions.sql"), "utf8");
    const grantsFor = async (roleKey: string, orgId: string | null) =>
      (
        await admin.query(
          `SELECT rp.permission_key FROM role_permission rp JOIN role r ON r.id = rp.role_id
            WHERE r.key=$1 AND r.organization_id IS NOT DISTINCT FROM $2 AND rp.permission_key = ANY($3) ORDER BY 1`,
          [roleKey, orgId, KEYS],
        )
      ).rows.map((r) => r.permission_key as string);

    it("both permission rows exist in the catalog (compliance category, no ABAC default)", async () => {
      const rows = await admin.query(
        "SELECT key, resource, action, category::text AS category, default_abac::text AS default_abac FROM permission WHERE key = ANY($1) ORDER BY key",
        [KEYS],
      );
      expect(rows.rows).toEqual([
        {
          key: "encounter.closure_override",
          resource: "encounter",
          action: "closure_override",
          category: "compliance",
          default_abac: "none",
        },
        {
          key: "encounter.closure_policy_admin",
          resource: "encounter",
          action: "closure_policy_admin",
          category: "compliance",
          default_abac: "none",
        },
      ]);
    });

    it("grants each existing role exactly its share (override: four supervisors; policy: the DON keys and the administrators), no clinician or platform-template role (re-run is idempotent)", async () => {
      // The migration ran on an empty tenant set: roles created since hold no grant yet (the control).
      for (const key of Object.keys(EXPECTED)) await roleIdOf(ORG_A, key);
      await admin.query(
        "INSERT INTO role (organization_id,key,name,category) VALUES (NULL,'clinical_lead','template','clinical_staff') ON CONFLICT DO NOTHING",
      );
      for (const key of Object.keys(EXPECTED))
        expect(await grantsFor(key, ORG_A), `${key} before`).toEqual([]);

      await admin.query(migration());
      for (const [key, expected] of Object.entries(EXPECTED))
        expect(await grantsFor(key, ORG_A), `${key} after`).toEqual(expected);
      // the field supervisors never get the policy key; an administrator never gets the override
      expect(await grantsFor("clinical_supervisor", ORG_A)).not.toContain(POLICY_ADMIN);
      expect(await grantsFor("clinical_lead", ORG_A)).not.toContain(POLICY_ADMIN);
      expect(await grantsFor("org_admin", ORG_A)).not.toContain(OVERRIDE);
      expect(await grantsFor("administrator", ORG_A)).not.toContain(OVERRIDE);
      expect(await grantsFor("clinical_lead", null)).toEqual([]);

      const before = await admin.query(
        "SELECT count(*)::int AS n FROM role_permission WHERE permission_key = ANY($1)",
        [KEYS],
      );
      await admin.query(migration());
      const after = await admin.query(
        "SELECT count(*)::int AS n FROM role_permission WHERE permission_key = ANY($1)",
        [KEYS],
      );
      expect(one(after.rows).n).toBe(one(before.rows).n);
    });
  });

  // ===============================================================================================================
  // 11. database hardening: the three triggers of migration 1510
  // ===============================================================================================================
  describe("11. migration 1510's triggers: a revoked override stays revoked, an override's members belong to its organization, the clock is write-once", () => {
    let subject: Member;
    let grantor: Member;
    let otherTenantMember: Member;
    const REVOKED_AT = "2026-11-18T13:00:00.000Z";

    beforeAll(async () => {
      subject = await seedMember(orgs.A, "trigger-subject");
      grantor = await seedMember(orgs.A, "trigger-grantor");
      otherTenantMember = await seedMember(orgs.B, "trigger-other-tenant");
    });

    const refusal = async (
      run: Promise<unknown>,
    ): Promise<{ code: string | undefined; message: string }> => {
      try {
        await run;
      } catch (error) {
        const failure = error as { code?: string; message: string };
        return { code: failure.code, message: failure.message };
      }
      throw new Error("expected the statement to fail, but it succeeded");
    };

    const revokedOverride = async (): Promise<string> => {
      const id = await insertOverrideRow(ORG_A, subject.membershipId, grantor.membershipId);
      const stamped = await asApp(ORG_A, grantor.userId, (c) =>
        c.query(
          "UPDATE documentation_obligation_override SET revoked_at=$2, revoked_by_membership_id=$3 WHERE id=$1",
          [id, REVOKED_AT, grantor.membershipId],
        ),
      );
      expect(stamped.rowCount).toBe(1); // control: the first revoke is allowed
      return id;
    };
    const revocationOf = async (id: string) =>
      one(
        (
          await admin.query(
            "SELECT revoked_at, revoked_by_membership_id::text AS by FROM documentation_obligation_override WHERE id=$1",
            [id],
          )
        ).rows,
      );

    it("(a) once revoked, the app role cannot clear, move or re-point the revocation columns", async () => {
      const id = await revokedOverride();
      const attempts: [string, unknown[]][] = [
        ["revoked_at = NULL, revoked_by_membership_id = NULL", [id]],
        ["revoked_at = revoked_at + interval '1 hour'", [id]],
        ["revoked_by_membership_id = $2", [id, subject.membershipId]],
      ];
      for (const [set, values] of attempts) {
        const refused = await refusal(
          asApp(ORG_A, grantor.userId, (c) =>
            c.query(`UPDATE documentation_obligation_override SET ${set} WHERE id=$1`, values),
          ),
        );
        expect([refused.code, refused.message], set).toEqual([
          "23514",
          "documentation_obligation_override: a revoked override cannot be changed",
        ]);
      }
      const row = await revocationOf(id);
      expect([new Date(row.revoked_at).toISOString(), row.by]).toEqual([
        REVOKED_AT,
        grantor.membershipId,
      ]);
    });

    it("(a) negative control: with the trigger off the same un-revoke goes through, so the trigger is what refuses it", async () => {
      const id = await revokedOverride();
      await admin.query(
        "ALTER TABLE documentation_obligation_override DISABLE TRIGGER trg_documentation_obligation_override_org_guard",
      );
      try {
        const reopened = await asApp(ORG_A, grantor.userId, (c) =>
          c.query(
            "UPDATE documentation_obligation_override SET revoked_at = NULL, revoked_by_membership_id = NULL WHERE id=$1",
            [id],
          ),
        );
        expect(reopened.rowCount).toBe(1);
      } finally {
        await admin.query(
          "ALTER TABLE documentation_obligation_override ENABLE TRIGGER trg_documentation_obligation_override_org_guard",
        );
      }
      expect((await revocationOf(id)).revoked_at).toBeNull();
    });

    it("(a) a first revoke by a member of another organization is refused, by the app role and by a connection that bypasses RLS", async () => {
      const id = await insertOverrideRow(ORG_A, subject.membershipId, grantor.membershipId);
      const asAppRole = await refusal(
        asApp(ORG_A, grantor.userId, (c) =>
          c.query(
            "UPDATE documentation_obligation_override SET revoked_at=$2, revoked_by_membership_id=$3 WHERE id=$1",
            [id, REVOKED_AT, otherTenantMember.membershipId],
          ),
        ),
      );
      expect(asAppRole.code).toBe("23503");
      const asAdmin = await refusal(
        admin.query(
          "UPDATE documentation_obligation_override SET revoked_at=$2, revoked_by_membership_id=$3 WHERE id=$1",
          [id, REVOKED_AT, otherTenantMember.membershipId],
        ),
      );
      expect([asAdmin.code, asAdmin.message]).toEqual([
        "23503",
        "documentation_obligation_override: the revoker must be a member of the override's organization",
      ]);
      expect((await revocationOf(id)).revoked_at).toBeNull();
    });

    it("(b) an override naming another organization's subject or grantor is refused, as the app role and as a connection that bypasses RLS", async () => {
      const insert = (subjectId: string, grantorId: string) => ({
        text: `INSERT INTO documentation_obligation_override
             (organization_id, subject_membership_id, granted_by_membership_id, obligation_kind, reason, granted_at, expires_at)
           VALUES ($1,$2,$3,'visit_note',$4, now(), now() + interval '1 hour') RETURNING id`,
        values: [
          ORG_A,
          subjectId,
          grantorId,
          "synthetic reason text, long enough for the 40 character CHECK",
        ],
      });
      // control: both members of org A insert
      expect(
        (
          await asApp(ORG_A, grantor.userId, (c) =>
            c.query(insert(subject.membershipId, grantor.membershipId)),
          )
        ).rowCount,
      ).toBe(1);
      const message =
        "documentation_obligation_override: the subject and the grantor must be members of the override's organization";
      for (const [label, subjectId, grantorId] of [
        ["subject", otherTenantMember.membershipId, grantor.membershipId],
        ["grantor", subject.membershipId, otherTenantMember.membershipId],
      ] as const) {
        const viaApp = await refusal(
          asApp(ORG_A, grantor.userId, (c) => c.query(insert(subjectId, grantorId))),
        );
        expect([viaApp.code, viaApp.message], `${label} as app`).toEqual(["23503", message]);
        // the superuser sees every membership row, so only the explicit organization comparison can refuse this one
        const viaAdmin = await refusal(admin.query(insert(subjectId, grantorId)));
        expect([viaAdmin.code, viaAdmin.message], `${label} as admin`).toEqual(["23503", message]);
      }
    });

    describe("(c) encounter.clock_started_at / clock_start_source are write-once", () => {
      const WRITE_ONCE =
        "encounter: the visit-note closure clock is write-once and cannot be changed or cleared";
      const CLOCK = new Date("2026-11-18T08:00:00.000Z");
      let clocked: string;
      let legacy: string;

      beforeAll(async () => {
        clocked = await seedEncounter({
          org: orgs.A,
          authorMembershipId: subject.membershipId,
          clockStartedAt: CLOCK,
          source: "evv_check_in",
        });
        legacy = await seedEncounter({
          org: orgs.A,
          authorMembershipId: subject.membershipId,
          clockStartedAt: null,
        });
      });

      const clockOfRow = async (id: string) =>
        one(
          (
            await admin.query(
              "SELECT clock_started_at, clock_start_source FROM encounter WHERE id=$1",
              [id],
            )
          ).rows,
        );

      it("refuses moving, changing the source of, or clearing a clock, for the superuser and for the app role", async () => {
        const attempts = [
          "clock_started_at = clock_started_at + interval '1 hour'",
          "clock_start_source = 'draft_created'",
          "clock_started_at = NULL, clock_start_source = NULL",
        ];
        for (const set of attempts) {
          const viaAdmin = await refusal(
            admin.query(`UPDATE encounter SET ${set} WHERE id=$1`, [clocked]),
          );
          expect([viaAdmin.code, viaAdmin.message], `admin ${set}`).toEqual(["23514", WRITE_ONCE]);
          const viaApp = await refusal(
            asApp(ORG_A, subject.userId, (c) =>
              c.query(`UPDATE encounter SET ${set} WHERE id=$1`, [clocked]),
            ),
          );
          expect([viaApp.code, viaApp.message], `app ${set}`).toEqual(["23514", WRITE_ONCE]);
        }
        const row = await clockOfRow(clocked);
        expect([new Date(row.clock_started_at).toISOString(), row.clock_start_source]).toEqual([
          CLOCK.toISOString(),
          "evv_check_in",
        ]);
      });

      it("still allows the one legitimate write (NULL to a value), a no-op rewrite and every unrelated edit", async () => {
        const stamped = await asApp(ORG_A, subject.userId, (c) =>
          c.query(
            "UPDATE encounter SET clock_started_at=$2, clock_start_source='draft_opened' WHERE id=$1 AND clock_started_at IS NULL",
            [legacy, CLOCK],
          ),
        );
        expect(stamped.rowCount).toBe(1);
        // naming the columns without changing them is not a change
        const same = await asApp(ORG_A, subject.userId, (c) =>
          c.query(
            "UPDATE encounter SET clock_started_at = clock_started_at, clock_start_source = clock_start_source WHERE id=$1",
            [legacy],
          ),
        );
        expect(same.rowCount).toBe(1);
        const unrelated = await asApp(ORG_A, subject.userId, (c) =>
          c.query("UPDATE encounter SET updated_at = now() WHERE id=$1", [legacy]),
        );
        expect(unrelated.rowCount).toBe(1);
        expect((await clockOfRow(legacy)).clock_start_source).toBe("draft_opened");
      });

      it("negative control: with session_replication_role = replica (what a fixture seed uses) the clock can be rewritten, so the trigger is what refuses it", async () => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL session_replication_role = replica");
          const moved = await admin.query(
            "UPDATE encounter SET clock_started_at = clock_started_at + interval '1 hour' WHERE id=$1",
            [clocked],
          );
          expect(moved.rowCount).toBe(1);
        } finally {
          await admin.query("ROLLBACK");
        }
        expect(new Date((await clockOfRow(clocked)).clock_started_at).toISOString()).toBe(
          CLOCK.toISOString(),
        );
      });
    });
  });

  // ===============================================================================================================
  // 12. who may release whom
  // ===============================================================================================================
  describe("12. the override grant refuses a blocked grantor, an unblocked clinician and a note outside the grantor's sites", () => {
    const ORG_G = "66666666-6666-6666-6666-666666666666";
    const NOW = new Date("2026-11-18T12:00:00.000Z");
    const REASON =
      "Visit ran long after an on-call crisis; synthetic override reason text for the live suite";
    let org: OrgFixture;
    let counter = 0;

    beforeAll(async () => {
      org = await seedOrg(ORG_G, "g");
      await setPolicy(ORG_G, "block", { thresholdHours: 24 });
    });

    /** A supervisor, optionally blocked by one overdue open note. */
    async function supervisor(blockedBy?: number): Promise<Member & { noteId: string | null }> {
      counter += 1;
      const member = await seedMember(org, `guard-supervisor-${counter}`, {
        roleKey: "clinical_supervisor",
      });
      const noteId =
        blockedBy === undefined
          ? null
          : await seedEncounter({
              org,
              authorMembershipId: member.membershipId,
              clockStartedAt: at(NOW, -blockedBy),
            });
      return { ...member, noteId };
    }
    /** A clinician whose oldest note is past its block instant, at a site (0 | 1) or at none. */
    async function blockedClinician(locationIndex: 0 | 1 | null, ageHours = 30): Promise<Member> {
      counter += 1;
      const member = await seedMember(org, `guard-clinician-${counter}`, { roleKey: "rn" });
      await seedEncounter({
        org,
        authorMembershipId: member.membershipId,
        clockStartedAt: at(NOW, -ageHours),
        locationIndex,
      });
      return member;
    }
    const grant = (by: Member, subject: Member, locationIds: readonly string[] | null = null) =>
      inOrg(ORG_G, by.userId, (tx) =>
        grantClosureOverride(tx, {
          organizationId: ORG_G,
          subjectMembershipId: subject.membershipId,
          grantedByMembershipId: by.membershipId,
          obligationKind: "visit_note",
          reason: REASON,
          locationIds,
          audit: auditContextOf(ORG_G, by.userId),
          now: NOW,
        }),
      );
    const codeOf = async (run: Promise<unknown>): Promise<string> => {
      try {
        await run;
        return "granted";
      } catch (error) {
        if (error instanceof ChartWardenError) return `${error.statusCode} ${error.code}`;
        throw error;
      }
    };
    const overrideCount = async (): Promise<number> =>
      one(
        (
          await admin.query(
            "SELECT count(*)::int AS n FROM documentation_obligation_override WHERE organization_id=$1",
            [ORG_G],
          )
        ).rows,
      ).n;

    it("two blocked supervisors cannot release each other; one who only holds an override is still not fit to release others; once they close their note they can; a blocked supervisor can still revoke", async () => {
      const a = await supervisor(31);
      const b = await supervisor(32);
      const before = await overrideCount();
      expect(await codeOf(grant(a, b))).toBe("403 NOTE_CLOSURE_GRANTOR_BLOCKED");
      expect(await codeOf(grant(b, a))).toBe("403 NOTE_CLOSURE_GRANTOR_BLOCKED");
      expect(await overrideCount()).toBe(before);

      // a clear supervisor releases B: B is overridden (the gate lets them through), but their own note is still past its block instant
      const clear = await supervisor();
      const released = await grant(clear, b);
      expect((await evaluateAt(ORG_G, b, NOW)).verdict).toBe("warn");
      expect((await evaluateAt(ORG_G, b, NOW)).overrideExpiresAt).not.toBeNull();
      const c = await blockedClinician(0);
      expect(await codeOf(grant(b, c))).toBe("403 NOTE_CLOSURE_GRANTOR_BLOCKED");
      // ...and A, still blocked, is no better: so A and B cannot release each other in a loop, even with B overridden
      expect(await codeOf(grant(b, a))).toBe("403 NOTE_CLOSURE_GRANTOR_BLOCKED");
      expect(await overrideCount()).toBe(before + 1); // only the clear supervisor's grant

      // control: once B closes their own note, B is clear and may release C
      await admin.query(
        "UPDATE encounter SET status='signed', signed_at=$2, vocab_version_id=gen_random_uuid() WHERE id=$1",
        [b.noteId, NOW],
      );
      expect(await codeOf(grant(b, c))).toBe("granted");
      // control: A closing theirs lets A release too
      await admin.query(
        "UPDATE encounter SET status='signed', signed_at=$2, vocab_version_id=gen_random_uuid() WHERE id=$1",
        [a.noteId, NOW],
      );
      expect((await evaluateAt(ORG_G, a, NOW)).verdict).toBe("clear");

      // a supervisor who is blocked themselves can still REVOKE (revoke is on the gate's allowlist); org-wide scope here
      const d = await supervisor(40);
      expect((await evaluateAt(ORG_G, d, NOW)).verdict).toBe("blocked");
      const revoked = await inOrg(ORG_G, d.userId, (tx) =>
        revokeClosureOverride(tx, {
          organizationId: ORG_G,
          overrideId: released.id,
          revokedByMembershipId: d.membershipId,
          locationIds: null,
          audit: auditContextOf(ORG_G, d.userId),
          now: NOW,
        }),
      );
      expect(revoked.override.revokedAt?.toISOString()).toBe(NOW.toISOString());
    });

    it("a clinician who is not blocked right now cannot be released: 409 NOTE_CLOSURE_SUBJECT_NOT_BLOCKED, nothing written", async () => {
      const grantor = await supervisor();
      counter += 1;
      const noNotes = await seedMember(org, `guard-no-notes-${counter}`, { roleKey: "rn" });
      const fresh = await blockedClinician(0, 2); // 2h old: not even at risk
      const legacy = await seedMember(org, `guard-legacy-${++counter}`, { roleKey: "rn" });
      await seedEncounter({
        org,
        authorMembershipId: legacy.membershipId,
        clockStartedAt: null, // no clock: never blocks
      });
      const overridden = await blockedClinician(0);
      await grant(grantor, overridden); // now overridden: warn, not blocked
      const before = await overrideCount();
      for (const [label, subject] of [
        ["no notes", noNotes],
        ["a fresh note", fresh],
        ["a legacy note with no clock", legacy],
        ["already overridden", overridden],
      ] as const) {
        expect(await codeOf(grant(grantor, subject)), label).toBe(
          "409 NOTE_CLOSURE_SUBJECT_NOT_BLOCKED",
        );
      }
      expect(await overrideCount()).toBe(before);
    });

    it("scope: the clinician's OLDEST note decides, by the board's rule (their sites or no site; org-wide sees all; no sites sees none)", async () => {
      const [siteOne, siteTwo] = org.locationIds;
      const siteSupervisor = await supervisor();
      const inScope = await blockedClinician(0);
      const outOfScope = await blockedClinician(1);
      const noSite = await blockedClinician(null);
      const before = await overrideCount();

      expect(await codeOf(grant(siteSupervisor, outOfScope, [siteOne]))).toBe(
        "403 NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE",
      );
      // a supervisor with no sites at all is out of scope for every note, a no-site note included (fail closed)
      expect(await codeOf(grant(siteSupervisor, noSite, []))).toBe(
        "403 NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE",
      );
      expect(await overrideCount()).toBe(before);

      expect(await codeOf(grant(siteSupervisor, inScope, [siteOne]))).toBe("granted");
      // the note with no site is in scope for a site-scoped supervisor (the alert falls back org-wide for it)
      expect(await codeOf(grant(siteSupervisor, noSite, [siteOne]))).toBe("granted");
      // an org-wide caller needs no scope
      const outOfScopeToo = await blockedClinician(1);
      expect(await codeOf(grant(siteSupervisor, outOfScopeToo, null))).toBe("granted");
      expect(siteTwo).toBeDefined();

      // the OLDEST note decides: a newer note inside the sites does not bring an older one outside them into scope
      const mixed = await seedMember(org, `guard-mixed-${++counter}`, { roleKey: "rn" });
      await seedEncounter({
        org,
        authorMembershipId: mixed.membershipId,
        clockStartedAt: at(NOW, -40),
        locationIndex: 1,
      });
      await seedEncounter({
        org,
        authorMembershipId: mixed.membershipId,
        clockStartedAt: at(NOW, -30),
        locationIndex: 0,
      });
      expect(await codeOf(grant(siteSupervisor, mixed, [siteOne]))).toBe(
        "403 NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE",
      );
      expect(await codeOf(grant(siteSupervisor, mixed, [siteTwo]))).toBe("granted");
    });

    it("the order of refusals is the documented one: grantor blocked, then out of scope, then clinician not blocked", async () => {
      const blockedGrantor = await supervisor(33);
      const clear = await supervisor();
      const outsideSites = await blockedClinician(1);
      const [siteOne] = org.locationIds;
      // grantor blocked AND clinician outside scope: the grantor's own state is reported first
      expect(await codeOf(grant(blockedGrantor, outsideSites, [siteOne]))).toBe(
        "403 NOTE_CLOSURE_GRANTOR_BLOCKED",
      );
      // a clinician with no open note at all: not blocked, and no scope question asked
      expect(await codeOf(grant(clear, await supervisor(), [siteOne]))).toBe(
        "409 NOTE_CLOSURE_SUBJECT_NOT_BLOCKED",
      );
    });

    it("scope is decided BEFORE the blocked question: a site-scoped supervisor gets the same 403 for a blocked and an unblocked clinician outside their sites", async () => {
      const [siteOne] = org.locationIds;
      const scoped = await supervisor();
      const blockedElsewhere = await blockedClinician(1, 30); // blocked, at site two
      const freshElsewhere = await blockedClinician(1, 2); // not blocked (2h old), at site two
      const overriddenElsewhere = await blockedClinician(1, 30);
      await grant(scoped, overriddenElsewhere, null); // org-wide grant: now overridden (warn)
      const before = await overrideCount();
      for (const [label, subject] of [
        ["blocked", blockedElsewhere],
        ["unblocked", freshElsewhere],
        ["overridden", overriddenElsewhere],
      ] as const) {
        expect(await codeOf(grant(scoped, subject, [siteOne])), label).toBe(
          "403 NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE",
        );
      }
      expect(await overrideCount()).toBe(before);
      // control: inside their sites the unblocked one is the 409 and the blocked one is released
      const freshHere = await blockedClinician(0, 2);
      const blockedHere = await blockedClinician(0, 30);
      expect(await codeOf(grant(scoped, freshHere, [siteOne]))).toBe(
        "409 NOTE_CLOSURE_SUBJECT_NOT_BLOCKED",
      );
      expect(await codeOf(grant(scoped, blockedHere, [siteOne]))).toBe("granted");
    });

    it("a site-scoped supervisor may revoke only what they granted; an org-wide caller may revoke any; a blocked grantor can still revoke their own", async () => {
      const [siteOne] = org.locationIds;
      const granter = await supervisor();
      const other = await supervisor();
      const clinician = await blockedClinician(0, 30);
      const override = await grant(granter, clinician, [siteOne]);
      const revoke = (by: Member, locationIds: readonly string[] | null) =>
        inOrg(ORG_G, by.userId, (tx) =>
          revokeClosureOverride(tx, {
            organizationId: ORG_G,
            overrideId: override.id,
            revokedByMembershipId: by.membershipId,
            locationIds,
            audit: auditContextOf(ORG_G, by.userId),
            now: NOW,
          }),
        );
      // another SITE-SCOPED supervisor (their scope includes this very site) did not grant it: refused, nothing written
      expect(await codeOf(revoke(other, [siteOne]))).toBe("403 NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE");
      expect(await codeOf(revoke(other, []))).toBe("403 NOTE_CLOSURE_SUBJECT_OUT_OF_SCOPE");
      const stillActive = await admin.query(
        "SELECT revoked_at FROM documentation_obligation_override WHERE id=$1",
        [override.id],
      );
      expect(one(stillActive.rows).revoked_at).toBeNull();
      expect((await evaluateAt(ORG_G, clinician, NOW)).verdict).toBe("warn");
      // the grantor can, even when their own note is overdue and their scope is a single site
      await seedEncounter({
        org,
        authorMembershipId: granter.membershipId,
        clockStartedAt: at(NOW, -40),
      });
      expect((await evaluateAt(ORG_G, granter, NOW)).verdict).toBe("blocked");
      const revoked = await revoke(granter, [siteOne]);
      expect(revoked.override.revokedAt?.toISOString()).toBe(NOW.toISOString());
      expect((await evaluateAt(ORG_G, clinician, NOW)).verdict).toBe("blocked");

      // an org-wide caller may revoke someone else's grant
      const second = await grant(await supervisor(), clinician, null);
      const wide = await supervisor();
      const revokedByWide = await inOrg(ORG_G, wide.userId, (tx) =>
        revokeClosureOverride(tx, {
          organizationId: ORG_G,
          overrideId: second.id,
          revokedByMembershipId: wide.membershipId,
          locationIds: null,
          audit: auditContextOf(ORG_G, wide.userId),
          now: NOW,
        }),
      );
      expect(revokedByWide.override.revokedAt?.toISOString()).toBe(NOW.toISOString());
    });
  });

  // ===============================================================================================================
  // 13. the supervisor board's query plan
  // ===============================================================================================================
  describe("13. the overdue board plans on encounter_open_clock_board_idx and does not sort the backlog (EXPLAIN as chartwarden_app)", () => {
    const ORG_D = "77777777-7777-7777-7777-777777777777";
    const BOARD_INDEX = "encounter_open_clock_board_idx";
    const SIGNED_ROWS = 30_000;
    const OVERDUE_OPEN_ROWS = 12_000;
    const MEMBERS = 40;
    const PAGE = 50;
    let org: OrgFixture;
    let probe: Member;
    let boardQuery: { text: string; values: unknown[] };
    let scopedBoardQuery: { text: string; values: unknown[] };

    beforeAll(async () => {
      org = await seedOrg(ORG_D, "d");
      const members: Member[] = [];
      for (let i = 0; i < MEMBERS; i += 1) members.push(await seedMember(org, `board-perf-${i}`));
      probe = members[0] as Member;
      const ids = members.map((m) => m.membershipId);
      const columns = `(organization_id, provider_entity_id, location_id, patient_id, admission_id, encounter_type, discipline,
         authored_by_membership_id, service_date, status, vocab_version_id, signed_at, clock_started_at, clock_start_source)`;
      const author = "(($2::uuid[])[1 + (g % $3::int)])";
      await admin.query("BEGIN");
      await admin.query("SET LOCAL session_replication_role = replica");
      const base = [ORG_D, ids, MEMBERS, org.providerEntityId, org.locationIds[0]] as const;
      await admin.query(
        `INSERT INTO encounter ${columns}
         SELECT $1, $4, $5, gen_random_uuid(), gen_random_uuid(), 'routine_visit', 'rn', ${author}, date '${SERVICE_DATE}',
                'signed', gen_random_uuid(), now(), now() - ((g + 100000) || ' minutes')::interval, 'draft_created'
           FROM generate_series(1, ${SIGNED_ROWS}) g`,
        [...base],
      );
      // a deep backlog of open notes, all past a 24h threshold: the board must read a page of it, not all of it
      await admin.query(
        `INSERT INTO encounter ${columns}
         SELECT $1, $4, $5, gen_random_uuid(), gen_random_uuid(), 'routine_visit', 'rn', ${author}, date '${SERVICE_DATE}',
                'draft', NULL, NULL, now() - ((g + 1500) || ' minutes')::interval, 'draft_created'
           FROM generate_series(1, ${OVERDUE_OPEN_ROWS}) g`,
        [...base],
      );
      await admin.query("COMMIT");
      await admin.query("ANALYZE encounter");
    }, 300_000);

    const sortFree = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.every(sortFree);
      if (node === null || typeof node !== "object") return true;
      return Object.entries(node as Record<string, unknown>).every(([key, value]) =>
        key === "Node Type" ? value !== "Sort" && value !== "Incremental Sort" : sortFree(value),
      );
    };
    const indexNames = (node: unknown): string[] => {
      if (Array.isArray(node)) return node.flatMap(indexNames);
      if (node === null || typeof node !== "object") return [];
      return Object.entries(node as Record<string, unknown>).flatMap(([key, value]) =>
        key === "Index Name" && typeof value === "string" ? [value] : indexNames(value),
      );
    };
    const planAsApp = (query: { text: string; values: unknown[] }) =>
      asApp(ORG_D, probe.userId, async (c) => {
        const result = await c.query({
          text: `EXPLAIN (ANALYZE false, FORMAT JSON) ${query.text}`,
          values: query.values,
        });
        return one(result.rows)["QUERY PLAN"];
      });
    const policy = { mode: "warn", thresholdHours: 24, enforceFrom: null } as const;
    const capture = async (locationIds: readonly string[] | null) => {
      capturedSql.length = 0;
      const board = await inOrg(ORG_D, probe.userId, (tx) =>
        listOverdueNotes(tx, {
          organizationId: ORG_D,
          policy,
          now: new Date(),
          limit: PAGE,
          locationIds,
        }),
      );
      expect(board.items).toHaveLength(PAGE);
      expect(board.truncated).toBe(true);
      return one(
        capturedSql.filter(
          (q) =>
            /from "encounter"/.test(q.text) &&
            /order by "encounter"\."clock_started_at"/i.test(q.text),
        ),
      );
    };

    it("captures the production board query as it is really sent, org-wide and site-scoped", async () => {
      boardQuery = await capture(null);
      expect(boardQuery.text).toMatch(/IN \('draft', 'finalized'\)/);
      scopedBoardQuery = await capture([org.locationIds[0]]);
      expect(scopedBoardQuery.text).toMatch(/"location_id" is null/i);
    });

    it("org-wide: the page is the first index entries, in order, with no sort node over the backlog", async () => {
      const plan = await planAsApp(boardQuery);
      expect(indexNames(plan)).toContain(BOARD_INDEX);
      expect(sortFree(plan)).toBe(true);
    });

    it("site-scoped (their sites or no site): still ordered by the board index, no sort", async () => {
      const plan = await planAsApp(scopedBoardQuery);
      expect(indexNames(plan)).toContain(BOARD_INDEX);
      expect(sortFree(plan)).toBe(true);
    });

    it("negative control: without the board index the same query sorts the whole backlog", async () => {
      await admin.query("BEGIN");
      try {
        await admin.query(`DROP INDEX ${BOARD_INDEX}`);
        const result = await admin.query({
          text: `EXPLAIN (ANALYZE false, FORMAT JSON) ${boardQuery.text}`,
          values: boardQuery.values,
        });
        const plan = one(result.rows)["QUERY PLAN"];
        expect(indexNames(plan)).not.toContain(BOARD_INDEX);
        expect(sortFree(plan)).toBe(false);
      } finally {
        await admin.query("ROLLBACK");
      }
    });
  });

  // ===============================================================================================================
  // 14. migration 1512
  // ===============================================================================================================
  describe("14. migration 1512 retires the two superseded alert rules, platform row and tenant clones, and deletes nothing", () => {
    const OLD_TYPES = ["m8.encounter.unsigned", "m8.encounter.documentation_late"];
    const CONTROL_TYPE = "m8.encounter.closure_control_rule";
    const migration = () =>
      readFileSync(
        join(
          MIGRATIONS_DIR,
          readdirSync(MIGRATIONS_DIR).find((name) => name.startsWith("1512_")) as string,
        ),
        "utf8",
      );
    const rules = async () =>
      (
        await admin.query<{ event_type: string; organization_id: string | null; enabled: boolean }>(
          "SELECT event_type, organization_id::text AS organization_id, enabled FROM alert_rule WHERE event_type = ANY($1) ORDER BY event_type, organization_id NULLS FIRST",
          [[...OLD_TYPES, CONTROL_TYPE]],
        )
      ).rows;

    it("disables the platform rows and every tenant clone of them, leaves other rules and the alerts alone, and re-runs as a no-op", async () => {
      const insertRule = (eventType: string, orgId: string | null) =>
        admin.query(
          `INSERT INTO alert_rule (organization_id, event_type, category, severity_floor, recipient_resolver)
           VALUES ($1,$2,'clinical_routine','warn','care_team')`,
          [orgId, eventType],
        );
      for (const type of [...OLD_TYPES, CONTROL_TYPE]) await insertRule(type, null);
      await insertRule(OLD_TYPES[0] as string, ORG_A);
      await insertRule(OLD_TYPES[1] as string, ORG_B);
      await admin.query(
        `INSERT INTO alert (organization_id, event_type, severity, payload, correlation_id)
         VALUES ($1,$2,'warn','{}'::jsonb,$3)`,
        [ORG_A, OLD_TYPES[0], `closure-live-${randomUUID()}`],
      );
      const alertCount = async () =>
        one(
          (
            await admin.query("SELECT count(*)::int AS n FROM alert WHERE event_type = ANY($1)", [
              OLD_TYPES,
            ])
          ).rows,
        ).n;
      expect((await rules()).filter((r) => r.enabled)).toHaveLength(5); // the control: all five start enabled
      const alertsBefore = await alertCount();

      await admin.query(migration());
      const after = await rules();
      expect(after).toHaveLength(5); // nothing deleted
      for (const rule of after) {
        expect(rule.enabled, `${rule.event_type} ${rule.organization_id}`).toBe(
          rule.event_type === CONTROL_TYPE,
        );
      }
      expect(await alertCount()).toBe(alertsBefore); // the alerts that carry the old event types are untouched

      await admin.query(migration());
      expect(await rules()).toEqual(after);
    });
  });
});
