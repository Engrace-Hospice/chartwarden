/**
 * M11L — the Drizzle order write lifecycle, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `chartwarden_app` role, exercising the §3.4 (0037) state-transition
 * triggers the service leans on: draft create/edit · requestSignature · sign (the apply-to-target trigger
 * flips → active) · LPN-cosign gate (self-cosign reject; diff-RN cosign then sign) · recordVerbal (the
 * set-target-pending trigger flips → verbal_pending) then sign-in-time · discontinue (ledger row) · correct
 * (the supersede trigger discontinues the original + writes its ledger) · complete · standing-order
 * create + PRN spawn (born active) · verbal-policy upsert + timer regenerate. Like the M7–M10 write suites
 * it binds the REAL catalog-validating transactional publisher (buildBootOutboxCatalog([M11_OUTBOX_EVENTS])
 * → the caller's tx) and asserts the `m11.order.*` rows land in `outbox_event`. RLS is exercised end-to-end.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m11:write:live
 * For a local PG without pgvector: also set CHARTWARDEN_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M11_OUTBOX_EVENTS } from "../src/modules/11-orders/index";
import {
  type OrderWriteOutboxPort,
  createDbOrderBackend,
} from "../src/modules/11-orders/orders-route-service-db";
import { type OrderDetailActor, SYSTEM_ORDER_ACTOR } from "../src/modules/11-orders/routes/service";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const USER2 = "3a3a3a3a-3a3a-4a3a-8a3a-3a3a3a3a3a3a";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const PHYSICIAN_MDM = "66666666-6666-6666-6666-666666666666";
/** A ≥100-char verbal attestation (the §2.3 recorder-attestation floor). */
const ATTESTATION =
  "Read back and verbally confirmed the complete order with the ordering physician at the bedside per §2.3 policy.";

describe.skipIf(!DB_URL)("M11 order write lifecycle — LIVE Postgres (M11L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbOrderBackend>;
  const memberOf: Record<string, string> = {}; // primary author membership per org
  const member2Of: Record<string, string> = {}; // a distinct cosigner membership per org

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
    const strip = !!process.env.CHARTWARDEN_TEST_NO_PGVECTOR;
    for (const f of readdirSync(MIGRATIONS_DIR)
      .filter((x) => x.endsWith(".sql"))
      .sort()) {
      let sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8");
      if (strip) {
        sql = sql.replace(/^.*EXTENSION IF NOT EXISTS "?vector"?.*$/gm, "-- (vector stripped)");
        sql = sql.replace(/\bvector\(\d+\)/g, "text");
        sql = sql.replace(/^.*USING hnsw \(.*$/gm, "-- (hnsw stripped)");
      }
      await admin.query(sql);
    }
  }
  async function eventsFor(aggregateId: string): Promise<string[]> {
    const { rows } = await admin.query(
      "SELECT event_type FROM outbox_event WHERE aggregate_id=$1 ORDER BY created_at, event_type",
      [aggregateId],
    );
    return rows.map((r) => r.event_type as string);
  }
  async function statusOf(id: string): Promise<string> {
    const { rows } = await admin.query("SELECT status FROM order_record WHERE id=$1", [id]);
    return rows[0]?.status as string;
  }

  const draftArgs = (over: Partial<Record<string, unknown>> = {}) => ({
    patientId: PATIENT,
    admissionId: ADMISSION,
    kind: "dme" as const,
    drafterDiscipline: "rn_case_manager",
    data: { hcpcs: "E0260" },
    orderingPhysicianMdmId: PHYSICIAN_MDM,
    ...over,
  });

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await resetSchema();
    await applyMigrations();
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A'),($2,'org-b','B','B')",
      [ORG_A, ORG_B],
    );
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'m11w@x.test'),($2,'m11w2@x.test')`,
      [USER, USER2],
    );
    for (const org of [ORG_A, ORG_B]) {
      memberOf[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER, org],
        )
      ).rows[0].id as string;
      member2Of[org] = (
        await admin.query(
          `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
          [USER2, org],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M11_OUTBOX_EVENTS]));
    const outbox: OrderWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m11" }),
    };
    svc = createDbOrderBackend(handle.db, outbox);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("createDraft persists a draft and emits draft_created; editDraft bumps version", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs(), SYSTEM_ORDER_ACTOR);
    expect(draft.status).toBe("draft");
    expect(draft.version).toBe(1);
    expect(await eventsFor(draft.id)).toContain("m11.order.draft_created");
    const edited = await svc.editDraft(
      ORG_A,
      draft.id,
      { hcpcs: "E0261" },
      "stat",
      SYSTEM_ORDER_ACTOR,
    );
    expect(edited.version).toBe(2);
    expect(edited.priority).toBe("stat");
  });

  it("projects a persisted draft mutation with the same actor-aware actions as a subsequent read", async () => {
    const actor: OrderDetailActor = {
      membershipId: memberOf[ORG_A] as string,
      roles: ["rn_case_manager"],
      disciplines: ["rn_case_manager"],
      // A real (non-system) actor: org-wide so the service's caseload re-check passes without a seam.
      orgWide: true,
      permissions: new Set(["orders.draft"]),
    };
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A] as string, draftArgs(), actor);
    const edited = await svc.editDraft(ORG_A, draft.id, { hcpcs: "E0261" }, "stat", actor);
    const read = await svc.getOrder(ORG_A, draft.id, actor);

    expect(edited.allowedActions).toEqual(read.allowedActions);
    expect(edited.allowedActions.edit).toBe(true);
  });

  it("requestSignature → sign flips the order to active (apply-to-target trigger) and emits signed", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs(), SYSTEM_ORDER_ACTOR);
    const pending = await svc.requestSignature(
      ORG_A,
      draft.id,
      {
        signerDiscipline: "rn_case_manager",
      },
      SYSTEM_ORDER_ACTOR,
    );
    expect(pending.status).toBe("pending_signature");
    expect(pending.cosignRequired).toBe(false);
    expect(await eventsFor(draft.id)).toContain("m11.order.signature_requested");
    const signed = await svc.signOrder(
      ORG_A,
      memberOf[ORG_A],
      draft.id,
      {
        signerDiscipline: "rn_case_manager",
        signedAtClient: new Date().toISOString(),
      },
      SYSTEM_ORDER_ACTOR,
    );
    expect(signed.status).toBe("active");
    expect(signed.signedBy).toBe(memberOf[ORG_A]);
    expect(await eventsFor(draft.id)).toContain("m11.order.signed");
  });

  it("LPN draft requires RN cosign: sign is blocked (409 COSIGN_PENDING), self-cosign rejected, diff-RN cosign then sign", async () => {
    const draft = await svc.createDraft(
      ORG_A,
      memberOf[ORG_A],
      draftArgs({ drafterDiscipline: "lpn" }),
      SYSTEM_ORDER_ACTOR,
    );
    const pending = await svc.requestSignature(
      ORG_A,
      draft.id,
      {
        signerDiscipline: "rn_case_manager",
      },
      SYSTEM_ORDER_ACTOR,
    );
    expect(pending.cosignRequired).toBe(true);
    expect(pending.cosignStatus).toBe("pending");
    expect(await eventsFor(draft.id)).toContain("m11.order.cosign_requested");
    // Signing before cosign is attached is blocked by the pure machine (the DB apply-trigger is silent).
    await expect(
      svc.signOrder(
        ORG_A,
        memberOf[ORG_A],
        draft.id,
        {
          signerDiscipline: "rn_case_manager",
          signedAtClient: new Date().toISOString(),
        },
        SYSTEM_ORDER_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "COSIGN_PENDING" });
    // The order's author may not cosign their own order (§7.3).
    await expect(
      svc.cosignOrder(
        ORG_A,
        memberOf[ORG_A],
        draft.id,
        {
          cosignerRole: "rn_case_manager",
          attestationText: "x",
        },
        SYSTEM_ORDER_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "COSIGNER_NOT_ELIGIBLE" });
    // A distinct RN cosigns → attached.
    const cosigned = await svc.cosignOrder(
      ORG_A,
      member2Of[ORG_A],
      draft.id,
      {
        cosignerRole: "rn_case_manager",
        attestationText: "Reviewed and countersigned.",
      },
      SYSTEM_ORDER_ACTOR,
    );
    expect(cosigned.cosignStatus).toBe("attached");
    expect(await eventsFor(draft.id)).toContain("m11.order.cosigned");
    const signed = await svc.signOrder(
      ORG_A,
      member2Of[ORG_A],
      draft.id,
      {
        signerDiscipline: "rn_case_manager",
        signedAtClient: new Date().toISOString(),
      },
      SYSTEM_ORDER_ACTOR,
    );
    expect(signed.status).toBe("active");
  });

  it("recordVerbal flips to verbal_pending (set-target-pending trigger); sign-in-time emits verbal_signed_in_time", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs(), SYSTEM_ORDER_ACTOR);
    await svc.requestSignature(
      ORG_A,
      draft.id,
      { signerDiscipline: "rn_case_manager" },
      SYSTEM_ORDER_ACTOR,
    );
    const verbal = await svc.recordVerbal(
      ORG_A,
      memberOf[ORG_A],
      draft.id,
      {
        recorderDiscipline: "rn_case_manager",
        verbalAttestation: ATTESTATION,
        readBackVerified: true,
        effectiveAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        orderingPhysicianMdmId: PHYSICIAN_MDM,
      },
      SYSTEM_ORDER_ACTOR,
    );
    expect(verbal.status).toBe("verbal_pending");
    expect(verbal.verbalDeadlineAt).not.toBeNull();
    expect(await eventsFor(draft.id)).toContain("m11.order.verbal_received");
    const signed = await svc.signOrder(
      ORG_A,
      memberOf[ORG_A],
      draft.id,
      {
        signerDiscipline: "rn_case_manager",
        signedAtClient: new Date().toISOString(),
      },
      SYSTEM_ORDER_ACTOR,
    );
    expect(signed.status).toBe("active");
    expect(await eventsFor(draft.id)).toContain("m11.order.verbal_signed_in_time");
  });

  it("GAP-017: recordVerbal refuses a receivedAt in the future or beyond the look-back; the order stays pending_signature", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs(), SYSTEM_ORDER_ACTOR);
    await svc.requestSignature(
      ORG_A,
      draft.id,
      { signerDiscipline: "rn_case_manager" },
      SYSTEM_ORDER_ACTOR,
    );
    for (const receivedAt of [
      new Date(Date.now() + 47 * 3_600_000).toISOString(), // would postpone the 48h deadline ~2 days
      new Date(Date.now() - 72 * 3_600_000).toISOString(), // would manufacture an instant expiry
    ]) {
      await expect(
        svc.recordVerbal(
          ORG_A,
          memberOf[ORG_A],
          draft.id,
          {
            recorderDiscipline: "rn_case_manager",
            verbalAttestation: ATTESTATION,
            readBackVerified: true,
            effectiveAt: new Date().toISOString(),
            receivedAt,
            orderingPhysicianMdmId: PHYSICIAN_MDM,
          },
          SYSTEM_ORDER_ACTOR,
        ),
      ).rejects.toMatchObject({ code: "VERBAL_RECEIVED_AT_OUT_OF_RANGE", statusCode: 422 });
    }
    expect(
      (
        await admin.query("SELECT count(*)::int AS n FROM verbal_order WHERE target_id=$1", [
          draft.id,
        ])
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await admin.query("SELECT status FROM order_record WHERE id=$1", [draft.id])).rows[0].status,
    ).toBe("pending_signature");
  });

  it("GAP-031: requestSignature derives the cosign requirement from the stored order, ignoring body signerDiscipline / levelChange", async () => {
    const draft = await svc.createDraft(
      ORG_A,
      memberOf[ORG_A],
      draftArgs({
        kind: "level_of_care_change",
        drafterDiscipline: "hospice_physician",
        data: {
          fromLevel: "rhc",
          toLevel: "gip",
          effectiveAt: new Date().toISOString(),
          clinicalJustification: "Uncontrolled symptoms require inpatient symptom management.",
        },
      }),
      SYSTEM_ORDER_ACTOR,
    );
    // A lying body (medical_director signer, rhc -> chc) must not dodge the rhc -> gip escalation cosign.
    const pending = await svc.requestSignature(
      ORG_A,
      draft.id,
      {
        signerDiscipline: "medical_director",
        levelChange: { fromLevel: "rhc", toLevel: "chc" },
      },
      SYSTEM_ORDER_ACTOR,
    );
    expect(pending.cosignRequired).toBe(true);
    expect(pending.cosignStatus).toBe("pending");
  });

  it("GAP-031: recordVerbal refuses a recorder discipline that may not author the kind (VERBAL_RECORDER_NOT_ELIGIBLE)", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs(), SYSTEM_ORDER_ACTOR);
    await svc.requestSignature(
      ORG_A,
      draft.id,
      { signerDiscipline: "rn_case_manager" },
      SYSTEM_ORDER_ACTOR,
    );
    await expect(
      svc.recordVerbal(
        ORG_A,
        memberOf[ORG_A],
        draft.id,
        {
          recorderDiscipline: "volunteer",
          verbalAttestation: ATTESTATION,
          readBackVerified: true,
          effectiveAt: new Date().toISOString(),
          receivedAt: new Date().toISOString(),
          orderingPhysicianMdmId: PHYSICIAN_MDM,
        },
        SYSTEM_ORDER_ACTOR,
      ),
    ).rejects.toMatchObject({ code: "VERBAL_RECORDER_NOT_ELIGIBLE" });
  });

  it("discontinueOrder writes an order_discontinuation ledger row and emits discontinued", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs(), SYSTEM_ORDER_ACTOR);
    await svc.requestSignature(
      ORG_A,
      draft.id,
      { signerDiscipline: "rn_case_manager" },
      SYSTEM_ORDER_ACTOR,
    );
    await svc.signOrder(
      ORG_A,
      memberOf[ORG_A],
      draft.id,
      {
        signerDiscipline: "rn_case_manager",
        signedAtClient: new Date().toISOString(),
      },
      SYSTEM_ORDER_ACTOR,
    );
    const dc = await svc.discontinueOrder(
      ORG_A,
      memberOf[ORG_A],
      draft.id,
      {
        reason: "clinical_judgement",
        effectiveAt: new Date().toISOString(),
        notes: "no longer needed",
      },
      SYSTEM_ORDER_ACTOR,
    );
    expect(dc.status).toBe("discontinued");
    const { rows } = await admin.query(
      "SELECT reason FROM order_discontinuation WHERE order_record_id=$1",
      [draft.id],
    );
    expect(rows.map((r) => r.reason)).toContain("clinical_judgement");
    expect(await eventsFor(draft.id)).toContain("m11.order.discontinued");
  });

  it("correctOrder inserts a replacement whose supersede trigger discontinues the original + writes its ledger", async () => {
    const orig = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs(), SYSTEM_ORDER_ACTOR);
    await svc.requestSignature(
      ORG_A,
      orig.id,
      { signerDiscipline: "rn_case_manager" },
      SYSTEM_ORDER_ACTOR,
    );
    await svc.signOrder(
      ORG_A,
      memberOf[ORG_A],
      orig.id,
      {
        signerDiscipline: "rn_case_manager",
        signedAtClient: new Date().toISOString(),
      },
      SYSTEM_ORDER_ACTOR,
    );
    const correction = await svc.correctOrder(
      ORG_A,
      memberOf[ORG_A],
      orig.id,
      draftArgs({ data: { hcpcs: "E0265" } }),
      SYSTEM_ORDER_ACTOR,
    );
    expect(correction.status).toBe("draft");
    expect(correction.replacesOrderId).toBe(orig.id);
    // The AFTER-INSERT supersede trigger discontinued the original + wrote its 'corrected_replacement' ledger.
    expect(await statusOf(orig.id)).toBe("discontinued");
    const { rows } = await admin.query(
      "SELECT reason FROM order_discontinuation WHERE order_record_id=$1",
      [orig.id],
    );
    expect(rows.map((r) => r.reason)).toContain("corrected_replacement");
    expect(await eventsFor(correction.id)).toEqual(
      expect.arrayContaining(["m11.order.draft_created", "m11.order.corrected"]),
    );
  });

  it("completeOrder finishes an active order and emits completed", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs(), SYSTEM_ORDER_ACTOR);
    await svc.requestSignature(
      ORG_A,
      draft.id,
      { signerDiscipline: "rn_case_manager" },
      SYSTEM_ORDER_ACTOR,
    );
    await svc.signOrder(
      ORG_A,
      memberOf[ORG_A],
      draft.id,
      {
        signerDiscipline: "rn_case_manager",
        signedAtClient: new Date().toISOString(),
      },
      SYSTEM_ORDER_ACTOR,
    );
    const done = await svc.completeOrder(
      ORG_A,
      memberOf[ORG_A],
      draft.id,
      "one-shot met",
      SYSTEM_ORDER_ACTOR,
    );
    expect(done.status).toBe("completed");
    expect(done.completedAt).not.toBeNull();
    expect(await eventsFor(draft.id)).toContain("m11.order.completed");
  });

  it("standing-order create + PRN spawn mints a born-active order + instance and advances spawn_count", async () => {
    const so = await svc.createStandingOrder(ORG_A, memberOf[ORG_A], {
      patientId: PATIENT,
      admissionId: ADMISSION,
      kind: "lab",
      signerDiscipline: "rn_case_manager",
      orderingPhysicianMdmId: PHYSICIAN_MDM,
      cadence: "prn",
      // lab.v1 canonical payload (packages/orders/src/kinds.ts): the spawn re-validates template_data.
      data: {
        testCodes: [
          {
            system: "http://loinc.org",
            code: "789-8",
            display: "Erythrocytes [#/volume] in Blood by Automated count",
          },
        ],
        fastingRequired: false,
      },
    });
    expect(so.status).toBe("active");
    expect(await eventsFor(so.id)).toContain("m11.order.standing_created");
    const { orderId } = await svc.spawnStandingOrder(ORG_A, memberOf[ORG_A], so.id);
    expect(await statusOf(orderId)).toBe("active");
    const back = await svc.getStandingOrder(ORG_A, so.id);
    expect(back.spawnCount).toBe(1);
    const { rows } = await admin.query(
      "SELECT id FROM standing_order_instance WHERE order_record_id=$1",
      [orderId],
    );
    expect(rows.length).toBe(1);
    expect(await eventsFor(orderId)).toContain("m11.order.standing_spawned");
  });

  it("putVerbalPolicy tightens the window (≤48h floor) and regenerateVerbalTimer re-emits verbal_received", async () => {
    const updated = await svc.putVerbalPolicy(ORG_A, { windowHours: 24, businessHoursOnly: false });
    expect(updated.windowHours).toBe(24);
    // ≥48h is above the platform floor → tighten-only guard rejects.
    await expect(svc.putVerbalPolicy(ORG_A, { windowHours: 72 })).rejects.toMatchObject({
      code: "VERBAL_WINDOW_EXCEEDS_FLOOR",
    });
    // Regenerate the timer on a verbal_pending order.
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs(), SYSTEM_ORDER_ACTOR);
    await svc.requestSignature(
      ORG_A,
      draft.id,
      { signerDiscipline: "rn_case_manager" },
      SYSTEM_ORDER_ACTOR,
    );
    await svc.recordVerbal(
      ORG_A,
      memberOf[ORG_A],
      draft.id,
      {
        recorderDiscipline: "rn_case_manager",
        verbalAttestation: ATTESTATION,
        readBackVerified: true,
        effectiveAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        orderingPhysicianMdmId: PHYSICIAN_MDM,
      },
      SYSTEM_ORDER_ACTOR,
    );
    const regen = await svc.regenerateVerbalTimer(ORG_A, draft.id);
    expect(regen.status).toBe("verbal_pending");
    expect(regen.verbalDeadlineAt).not.toBeNull();
  });

  it("RLS: org B cannot read or sign org A's order (404 under the chartwarden_app policy)", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs(), SYSTEM_ORDER_ACTOR);
    await expect(svc.getOrder(ORG_B, draft.id)).rejects.toMatchObject({ statusCode: 404 });
    await svc.requestSignature(
      ORG_A,
      draft.id,
      { signerDiscipline: "rn_case_manager" },
      SYSTEM_ORDER_ACTOR,
    );
    await expect(
      svc.signOrder(
        ORG_B,
        memberOf[ORG_B],
        draft.id,
        {
          signerDiscipline: "rn_case_manager",
          signedAtClient: new Date().toISOString(),
        },
        SYSTEM_ORDER_ACTOR,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
