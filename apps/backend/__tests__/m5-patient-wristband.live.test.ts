/**
 * GAP-020 -- the M5 patient wristband (the on-file side of the BCMA `wrong_patient` arm) against REAL Postgres,
 * as the NOBYPASSRLS `chartwarden_app` role. Proves, through the real routes, the real Drizzle store and the real
 * M4 audit trigger:
 *   - printing mints a token whose RAW value is returned once and stored nowhere: the row holds only an org-salted
 *     digest, and `audit_event`, `outbox_event` and `idempotency_key` (even when the client sent an
 *     Idempotency-Key) never contain it;
 *   - a reprint supersedes the old generation atomically (exactly one ACTIVE row), the old band stops verifying
 *     online, and two parallel prints with the same expectedCurrentGeneration yield exactly one winner;
 *   - the verifier's verdicts over the real store, incl. another patient's band, cross-tenant isolation, and the
 *     offline-sync grace window (a voided band never verifies);
 *   - RLS ENABLE+FORCE, the CHECK constraints and the partial-unique active index;
 *   - merging a patient away and recording death void the band in the SAME commit; the destruction eraser removes
 *     the rows; a void needs step-up;
 *   - the chart-badge read leaves a read-audit event with a real resource id (not swallowed by the best-effort
 *     wrapper).
 *
 * CHARTWARDEN_TEST_DATABASE_URL=postgres://... bunx vitest run apps/backend/__tests__/m5-patient-wristband.live.test.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  createInMemoryEffectivePermissionStore,
  registerEffectivePermissionResolver,
  registerPredicateIdempotent,
  resetAuthorizationContract,
  resetRbacEngine,
} from "@chartwarden/auth";
import { type DbClient, createDbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { OFFLINE_WRISTBAND_MAX_AGE_MS } from "@chartwarden/types";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDbIdempotencyStore } from "../src/bootstrap/plugins/idempotency-store-db";
import { recordDeathFromDischarge } from "../src/modules/05-patient/deceased-db";
import { createDrizzlePatientEraseStore } from "../src/modules/05-patient/erasers/patient-eraser";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/index";
import { mergePatients } from "../src/modules/05-patient/merges-db";
import { registerPatientWristbandRoutes } from "../src/modules/05-patient/routes/wristband-routes";
import { buildPatientWristbandVerifier } from "../src/modules/05-patient/wristband-verifier";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";
import { installPermissiveConsentAbac } from "./consent-abac-harness";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["chartwarden_app", "chartwarden_admin", "chartwarden_readonly", "chartwarden_audit_writer"];
const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const NURSE = "d0000000-0000-4000-8000-000000000001";
const NURSE_B = "d0000000-0000-4000-8000-000000000002";

function headerAuth(request: FastifyRequest): void {
  const user = request.headers["x-test-user"];
  if (typeof user !== "string" || user.length === 0) return;
  request.context.userId = user;
  const org = request.headers["x-test-org"];
  request.context.organizationId = typeof org === "string" ? org : "";
  request.context.roles = ["rn"];
  request.context.attributes.stepUpRecent = request.headers["x-test-stepup"] === "1";
}
const asNurse = { "x-test-user": NURSE, "x-test-org": ORG_A };
const asNurseStepUp = { ...asNurse, "x-test-stepup": "1" };
const asNurseB = { "x-test-user": NURSE_B, "x-test-org": ORG_B };

describe.skipIf(!DB_URL)("GAP-020 patient wristband -- LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let app: FastifyInstance;
  let patientA = "";
  let patientB = "";

  const outbox = {
    publish: (tx: never, input: never) =>
      buildTxOutboxPublisher(buildBootOutboxCatalog([M5_OUTBOX_EVENTS])).publish(tx, {
        ...(input as object),
        callerModule: "m5",
      } as never),
  };

  async function newPatient(org: string, status = "active"): Promise<string> {
    const { rows } = await admin.query(
      `INSERT INTO patient (organization_id, mrn, legal_first_name, legal_last_name, dob,
         sex_assigned_at_birth, status)
       VALUES ($1, $2, 'Pat', 'Wristband', '1950-01-01', 'female', $3) RETURNING id`,
      [org, `mrn-${Math.random().toString(36).slice(2)}`, status],
    );
    return rows[0].id as string;
  }
  const issue = (
    patientId: string,
    body: { reason: string; expectedCurrentGeneration: number | null },
    headers: Record<string, string> = asNurse,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/v1/patients/${patientId}/wristbands`,
      headers,
      payload: body,
    });
  const verify = (
    patientId: string,
    payload: string | null,
    over: { mode?: "online" | "offline_sync"; asOf?: string; org?: string } = {},
  ) =>
    buildPatientWristbandVerifier(handle.db).verify({
      organizationId: over.org ?? ORG_A,
      patientId,
      payload,
      asOf: over.asOf ?? new Date().toISOString(),
      mode: over.mode ?? "online",
    });
  const activeCount = async (patientId: string): Promise<number> =>
    Number(
      (
        await admin.query(
          `SELECT count(*)::int AS n FROM patient_wristband
            WHERE patient_id=$1 AND superseded_at IS NULL AND voided_at IS NULL`,
          [patientId],
        )
      ).rows[0].n,
    );

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    for (const [id, slug] of [
      [ORG_A, "org-wb-a"],
      [ORG_B, "org-wb-b"],
    ] as const)
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    for (const [id, n] of [
      [NURSE, "nurse"],
      [NURSE_B, "nurseb"],
    ] as const)
      await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [id, `${n}@wb.test`]);
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    resetAuthorizationContract();
    resetRbacEngine();
    registerEffectivePermissionResolver(
      createInMemoryEffectivePermissionStore(
        [
          [NURSE, ORG_A],
          [NURSE_B, ORG_B],
        ].map(([userId, orgId]) => ({
          orgId: orgId as string,
          userId: userId as string,
          grants: [
            {
              roleKey: "seed",
              enabled: true,
              expiresAt: null,
              permissionKeys: ["patient.read", "patient.wristband.issue", "patient.wristband.void"],
            },
          ],
        })),
      ).store,
    );
    installPermissiveConsentAbac();
    // caseload scope is proven by its own suites; here every actor is on the patient's caseload.
    registerPredicateIdempotent("caseload_or_scope", async () => true);
    registerPredicateIdempotent(
      "step_up_recent",
      async (context) => context.attributes.stepUpRecent === true,
    );
    app = buildServer({
      db: handle.db,
      authenticate: headerAuth,
      security: { rateLimitEnabled: false },
      idempotencyStore: createDbIdempotencyStore(handle.db),
    });
    registerPatientWristbandRoutes(app, { db: handle.db });
  }, 240_000);

  afterAll(async () => {
    resetAuthorizationContract();
    resetRbacEngine();
    await app?.close();
    await handle?.close();
    if (admin) await admin.end();
  });

  beforeEach(async () => {
    await admin.query("DELETE FROM patient_wristband");
    await admin.query("DELETE FROM idempotency_key");
    await admin.query("DELETE FROM audit_event WHERE organization_id IN ($1,$2)", [ORG_A, ORG_B]);
    await admin.query("DELETE FROM outbox_event");
    patientA = await newPatient(ORG_A);
    patientB = await newPatient(ORG_A);
  });

  it("prints a band: the raw payload is returned ONCE and never stored, audited, queued or idempotency-captured", async () => {
    const res = await issue(patientA, { reason: "first_issue", expectedCurrentGeneration: null }, {
      ...asNurse,
      "idempotency-key": "wb-key-1",
    } as never);
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json() as { payload: string; generation: number; label: { mrn: string } };
    expect(body.payload).toMatch(/^WXB1\.[0-9A-HJKMNP-TV-Z]{26}\.[0-9A-F]{4}$/);
    expect(body.generation).toBe(1);
    // The human-readable line is separate from the code; the code carries no identity.
    expect(body.payload).not.toContain(body.label.mrn);

    const token = body.payload.slice(0, body.payload.lastIndexOf("."));
    const everywhere = await admin.query(
      `SELECT (SELECT coalesce(string_agg(t::text, ' '), '') FROM patient_wristband t) AS rows,
              (SELECT coalesce(string_agg(t::text, ' '), '') FROM audit_event t WHERE organization_id=$1) AS audit,
              (SELECT coalesce(string_agg(t::text, ' '), '') FROM outbox_event t) AS outbox,
              (SELECT coalesce(string_agg(t::text, ' '), '') FROM idempotency_key t) AS idem`,
      [ORG_A],
    );
    for (const place of ["rows", "audit", "outbox", "idem"] as const) {
      expect(everywhere.rows[0][place]).not.toContain(token);
      expect(everywhere.rows[0][place]).not.toContain(body.payload);
    }
    // The opt-out is what keeps the key from capturing the response: nothing was recorded under it at all.
    expect((await admin.query("SELECT 1 FROM idempotency_key")).rowCount).toBe(0);

    // The M4 trigger audited the insert but scrubbed the digest.
    const { rows: stored } = await admin.query("SELECT payload_digest FROM patient_wristband");
    expect(stored[0].payload_digest).toMatch(/^[0-9a-f]{64}$/);
    const audit = await admin.query(
      `SELECT after::text AS after FROM audit_event
        WHERE event_type = 'patient_wristband.insert' AND organization_id=$1`,
      [ORG_A],
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0].after).not.toContain(stored[0].payload_digest);
  });

  it("a reprint supersedes the old band atomically: one ACTIVE row, the old band stops verifying online", async () => {
    const first = (
      await issue(patientA, { reason: "first_issue", expectedCurrentGeneration: null })
    ).json();
    expect((await verify(patientA, first.payload)).status).toBe("verified");

    const second = await issue(patientA, { reason: "reprint_lost", expectedCurrentGeneration: 1 });
    expect(second.statusCode).toBe(201);
    expect(second.json().generation).toBe(2);
    expect(await activeCount(patientA)).toBe(1);

    expect((await verify(patientA, first.payload)).status).toBe("superseded");
    expect((await verify(patientA, second.json().payload)).status).toBe("verified");
  });

  it("two parallel prints with the same expectedCurrentGeneration: exactly one wins, the other is 409", async () => {
    const [a, b] = await Promise.all([
      issue(patientA, { reason: "first_issue", expectedCurrentGeneration: null }),
      issue(patientA, { reason: "first_issue", expectedCurrentGeneration: null }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect(await activeCount(patientA)).toBe(1);
    expect(
      Number((await admin.query("SELECT count(*)::int n FROM patient_wristband")).rows[0].n),
    ).toBe(1);
  });

  it("a stale expectedCurrentGeneration and a wrong-shaped reason are refused", async () => {
    await issue(patientA, { reason: "first_issue", expectedCurrentGeneration: null });
    expect(
      (await issue(patientA, { reason: "reprint_lost", expectedCurrentGeneration: null }))
        .statusCode,
    ).toBe(409);
    expect(
      (await issue(patientA, { reason: "first_issue", expectedCurrentGeneration: 1 })).statusCode,
    ).toBe(422);
  });

  it("verdicts over the real store: another patient's band, malformed, not presented, not on file", async () => {
    const a = (
      await issue(patientA, { reason: "first_issue", expectedCurrentGeneration: null })
    ).json();
    const b = (
      await issue(patientB, { reason: "first_issue", expectedCurrentGeneration: null })
    ).json();
    const other = await verify(patientA, b.payload);
    expect(other).toMatchObject({ status: "mismatch", matchedPatientId: patientB });
    expect((await verify(patientA, "sha256:patient-a")).status).toBe("malformed");
    expect((await verify(patientA, null)).status).toBe("not_presented");
    const bare = await newPatient(ORG_A);
    expect((await verify(bare, null)).status).toBe("not_on_file");
    // A patient with no band presenting ANOTHER patient's band is still a mismatch that names the owner.
    expect(await verify(bare, a.payload)).toMatchObject({
      status: "mismatch",
      matchedPatientId: patientA,
    });
  });

  it("tenant isolation: a band is invisible to another org, and the patient there reads as not on file", async () => {
    const a = (
      await issue(patientA, { reason: "first_issue", expectedCurrentGeneration: null })
    ).json();
    const patientInB = await newPatient(ORG_B);
    expect((await verify(patientInB, a.payload, { org: ORG_B })).status).toBe("not_on_file");
    expect((await verify(patientA, a.payload, { org: ORG_B })).status).toBe("not_on_file");
    // Through the routes: org B cannot print for, or read the badge of, org A's patient.
    expect(
      (await issue(patientA, { reason: "first_issue", expectedCurrentGeneration: null }, asNurseB))
        .statusCode,
    ).toBe(404);
    const badge = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${patientA}/wristband`,
      headers: asNurseB,
    });
    expect(badge.statusCode).toBe(404);
    // And as the app role scoped to org B, the table shows nothing of org A's.
    const seenByB = await withOrgContext(
      handle.db,
      { organizationId: ORG_B, userId: "" },
      async (tx) => (tx as unknown as DbClient).select().from(schema.patientWristbands),
    );
    expect(seenByB).toHaveLength(0);
  });

  it("RLS is ENABLED and FORCED on patient_wristband; the table carries the audit trigger", async () => {
    const { rows } = await admin.query(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname='patient_wristband'`,
    );
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const trig = await admin.query(
      `SELECT 1 FROM pg_trigger WHERE tgrelid='patient_wristband'::regclass AND tgname='trg_audit_patient_wristband'`,
    );
    expect(trig.rowCount).toBe(1);
  });

  it("constraints: a second ACTIVE generation, a non-hex digest, a bad reason and a half-voided row are all refused", async () => {
    await issue(patientA, { reason: "first_issue", expectedCurrentGeneration: null });
    const base = `INSERT INTO patient_wristband (organization_id, patient_id, generation, payload_digest,
        issued_by_user_id, issue_reason`;
    await expect(
      admin.query(`${base}) VALUES ($1,$2,2,$3,$4,'reprint_lost')`, [
        ORG_A,
        patientA,
        "a".repeat(64),
        NURSE,
      ]),
    ).rejects.toMatchObject({ code: "23505" }); // partial unique: one active per patient
    await expect(
      admin.query(`${base}) VALUES ($1,$2,9,$3,$4,'reprint_lost')`, [
        ORG_A,
        patientB,
        "NOT-HEX",
        NURSE,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      admin.query(`${base}) VALUES ($1,$2,9,$3,$4,'because')`, [
        ORG_A,
        patientB,
        "b".repeat(64),
        NURSE,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      admin.query(`${base}, voided_at) VALUES ($1,$2,9,$3,$4,'reprint_lost', now())`, [
        ORG_A,
        patientB,
        "c".repeat(64),
        NURSE,
      ]),
    ).rejects.toMatchObject({ code: "23514" }); // voided_at without void_reason
  });

  it("offline_sync grace: a scan taken while the band was active still verifies after a reprint, for 72 h", async () => {
    const first = (
      await issue(patientA, { reason: "first_issue", expectedCurrentGeneration: null })
    ).json();
    // Age the first generation so the scan time lies inside its life: issued 30 h ago, superseded 10 h ago.
    await admin.query(
      `UPDATE patient_wristband SET issued_at = now() - interval '30 hours' WHERE patient_id=$1`,
      [patientA],
    );
    await issue(patientA, { reason: "reprint_lost", expectedCurrentGeneration: 1 });
    await admin.query(
      `UPDATE patient_wristband SET superseded_at = now() - interval '10 hours'
        WHERE patient_id=$1 AND generation=1`,
      [patientA],
    );
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
    expect(
      (await verify(patientA, first.payload, { mode: "offline_sync", asOf: hoursAgo(12) })).status,
    ).toBe("verified");
    // After supersession, before issue, and the same instant ONLINE are all refused.
    expect(
      (await verify(patientA, first.payload, { mode: "offline_sync", asOf: hoursAgo(9) })).status,
    ).toBe("superseded");
    expect(
      (await verify(patientA, first.payload, { mode: "offline_sync", asOf: hoursAgo(31) })).status,
    ).toBe("superseded");
    expect(
      (await verify(patientA, first.payload, { mode: "online", asOf: hoursAgo(12) })).status,
    ).toBe("superseded");
    // A scan older than 72 h at sync is refused even inside the band's life.
    await admin.query(
      `UPDATE patient_wristband SET issued_at = now() - interval '200 hours',
         superseded_at = now() - interval '1 hours' WHERE patient_id=$1 AND generation=1`,
      [patientA],
    );
    const limit = Date.now() - OFFLINE_WRISTBAND_MAX_AGE_MS;
    expect(
      (
        await verify(patientA, first.payload, {
          mode: "offline_sync",
          asOf: new Date(limit + 60_000).toISOString(),
        })
      ).status,
    ).toBe("verified");
    expect(
      (
        await verify(patientA, first.payload, {
          mode: "offline_sync",
          asOf: new Date(limit - 60_000).toISOString(),
        })
      ).status,
    ).toBe("superseded");
  });

  it("void needs step-up; a voided band never verifies, online or offline; a new print continues the numbering", async () => {
    const first = (
      await issue(patientA, { reason: "first_issue", expectedCurrentGeneration: null })
    ).json();
    const url = `/api/v1/patients/${patientA}/wristbands/1/void`;
    const noStepUp = await app.inject({
      method: "POST",
      url,
      headers: asNurse,
      payload: { reason: "identity_error" },
    });
    expect(noStepUp.statusCode).toBe(403);
    expect((await verify(patientA, first.payload)).status).toBe("verified");

    const ok = await app.inject({
      method: "POST",
      url,
      headers: asNurseStepUp,
      payload: { reason: "identity_error" },
    });
    expect(ok.statusCode).toBe(204);
    expect((await verify(patientA, first.payload)).status).toBe("voided");
    expect(
      (
        await verify(patientA, first.payload, {
          mode: "offline_sync",
          asOf: new Date().toISOString(),
        })
      ).status,
    ).toBe("voided");
    // Voiding twice is a conflict; a system reason is not an operator choice.
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: asNurseStepUp,
          payload: { reason: "identity_error" },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: asNurseStepUp,
          payload: { reason: "patient_merged" },
        })
      ).statusCode,
    ).toBe(422);

    const next = await issue(patientA, {
      reason: "identity_correction",
      expectedCurrentGeneration: null,
    });
    expect(next.statusCode).toBe(201);
    expect(next.json().generation).toBe(2);
  });

  it("merging a patient away voids the SOURCE band in the same commit; the survivor needs a new print", async () => {
    const src = (
      await issue(patientA, { reason: "first_issue", expectedCurrentGeneration: null })
    ).json();
    const tgt = (
      await issue(patientB, { reason: "first_issue", expectedCurrentGeneration: null })
    ).json();
    await mergePatients(handle.db, outbox as never, {
      organizationId: ORG_A,
      sourcePatientId: patientA,
      targetPatientId: patientB,
      fieldResolutions: {},
      reason: "duplicate chart",
      actorUserId: NURSE,
    });
    expect((await verify(patientA, src.payload)).status).toBe("voided");
    expect((await verify(patientB, tgt.payload)).status).toBe("verified");
    const row = await admin.query("SELECT void_reason FROM patient_wristband WHERE patient_id=$1", [
      patientA,
    ]);
    expect(row.rows[0].void_reason).toBe("patient_merged");
    // A merged-away patient cannot be issued a new one.
    expect(
      (await issue(patientA, { reason: "reprint_lost", expectedCurrentGeneration: null }))
        .statusCode,
    ).toBe(409);
  });

  it("recording death voids the band in the same commit", async () => {
    const dischargedPatient = await newPatient(ORG_A, "discharged");
    const band = (
      await issue(dischargedPatient, { reason: "first_issue", expectedCurrentGeneration: null })
    ).json();
    await recordDeathFromDischarge(handle.db, outbox as never, {
      organizationId: ORG_A,
      patientId: dischargedPatient,
      deceasedDate: "2026-10-01",
      today: "2026-10-08",
      actorUserId: NURSE,
    });
    expect((await verify(dischargedPatient, band.payload)).status).toBe("voided");
  });

  it("the destruction eraser removes the patient's wristband rows and counts them", async () => {
    await issue(patientA, { reason: "first_issue", expectedCurrentGeneration: null });
    await issue(patientA, { reason: "reprint_lost", expectedCurrentGeneration: 1 });
    // The destruction path runs on the destruction connection (not the app role, which cannot DELETE).
    const destruction = createDbClient({ connectionString: DB_URL as string });
    try {
      const counts = await createDrizzlePatientEraseStore(destruction.db).erasePatientSubtree(
        ORG_A,
        patientA,
      );
      expect(counts.wristbands).toBe(2);
    } finally {
      await destruction.close();
    }
    // ...and the app role really cannot delete a band itself.
    await expect(
      withOrgContext(handle.db, { organizationId: ORG_A, userId: "" }, async (tx) =>
        (tx as unknown as DbClient).delete(schema.patientWristbands),
      ),
    ).rejects.toThrow();
    expect(
      Number(
        (
          await admin.query("SELECT count(*)::int n FROM patient_wristband WHERE patient_id=$1", [
            patientA,
          ])
        ).rows[0].n,
      ),
    ).toBe(0);
  });

  it("the chart-badge read leaves a read-audit event with a real resource id, and never a token", async () => {
    const band = (
      await issue(patientA, { reason: "first_issue", expectedCurrentGeneration: null })
    ).json();
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/patients/${patientA}/wristband`,
      headers: asNurse,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: "active", generation: 1 });
    expect(JSON.stringify(res.json())).not.toContain(band.payload);
    const events = await admin.query(
      `SELECT event_type, resource_id::text FROM audit_event
        WHERE organization_id=$1 AND event_type LIKE 'patient.%viewed' ORDER BY created_at`,
      [ORG_A],
    );
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].resource_id).toBe(patientA);
  });
});
