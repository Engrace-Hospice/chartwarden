/**
 * GAP-016 — the production M5 PatientRouteService publishes m5.patient.* from its writes, against REAL
 * Postgres as the NOBYPASSRLS `chartwarden_app` role and through the REAL catalog-validating outbox
 * publisher (`buildTxOutboxPublisher`, callerModule `m5`). Proves, per write, that exactly the spec'd event
 * lands in `outbox_event` in the same transaction with the payload shape the live M12 consumers decide on
 * (`organizationId` + `patientId`), that a rolled-back write leaves no event, and that RLS hides another
 * tenant's rows.
 *
 * CHARTWARDEN_TEST_DATABASE_URL=postgres://... bunx vitest run \
 *   apps/backend/__tests__/m5-patient-write-outbox.live.test.ts
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { M5_OUTBOX_EVENTS } from "../src/modules/05-patient/index";
import { createDbPatientRouteService } from "../src/modules/05-patient/patient-route-service-db";
import { decidePatientSyncTrigger } from "../src/modules/12-dosespot/consumers/sync-triggers";
import { LIVE_DROP_ROLES, appRoleConnectionString } from "./_live-app-role";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = LIVE_DROP_ROLES;
const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const STAFF = "d0000000-0000-4000-8000-000000000001";

describe.skipIf(!DB_URL)("GAP-016 M5 write outbox — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let service: ReturnType<typeof createDbPatientRouteService>;

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort())
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    for (const [id, slug] of [
      [ORG_A, "org-gap016-a"],
      [ORG_B, "org-gap016-b"],
    ] as const) {
      await admin.query(
        "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,$2,$2,$2)",
        [id, slug],
      );
    }
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,$2)`, [STAFF, "s@gap016.test"]);
    for (const org of [ORG_A, ORG_B]) {
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active')",
        [STAFF, org],
      );
    }
    handle = createDbClient({
      connectionString: await appRoleConnectionString(admin, DB_URL as string),
    });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M5_OUTBOX_EVENTS]));
    const outbox = {
      publish: (tx: Parameters<typeof txPublisher.publish>[0], input: never) =>
        txPublisher.publish(tx, { ...(input as object), callerModule: "m5" } as never),
    };
    service = createDbPatientRouteService(handle.db, outbox as never);
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  afterEach(async () => {
    await admin.query("DELETE FROM outbox_event");
  });

  const events = async () =>
    (await admin.query("SELECT event_type, payload FROM outbox_event ORDER BY created_at"))
      .rows as {
      event_type: string;
      payload: Record<string, unknown>;
    }[];

  const admit = async () => {
    const out = await service.admit(
      ORG_A,
      {
        lastName: "Outbox",
        firstName: "Pat",
        dob: "1950-01-01",
        administrativeSex: "female",
        bypassMatchReview: true,
      } as never,
      STAFF,
    );
    if (out.outcome === "hard_block") throw new Error("unexpected hard_block");
    return out.patientId;
  };

  it("admit publishes m5.patient.created and the M12 decider accepts the payload", async () => {
    const patientId = await admit();
    const [created, ...rest] = await events();
    expect(rest).toEqual([]);
    expect(created?.event_type).toBe("m5.patient.created");
    expect(created?.payload).toMatchObject({ patientId, organizationId: ORG_A });
    expect(String(created?.payload.mrn)).toMatch(/^MRN-/);
    expect(decidePatientSyncTrigger("created", created?.payload as never)).toMatchObject({
      enqueueSync: true,
      patientId,
    });
  });

  it("addAddress publishes m5.patient.address_changed with the new addressId", async () => {
    const patientId = await admit();
    await admin.query("DELETE FROM outbox_event");
    const out = await service.addAddress(
      ORG_A,
      patientId,
      {
        line1: "1 Main",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        isPrimary: true,
      } as never,
      STAFF,
    );
    expect(out.cascadeEmitted).toBe("m5.patient.address_changed");
    const evs = await events();
    expect(evs.map((e) => e.event_type)).toEqual(["m5.patient.address_changed"]);
    expect(evs[0]?.payload).toMatchObject({
      patientId,
      organizationId: ORG_A,
      addressId: out.addressId,
    });
    expect(decidePatientSyncTrigger("address_changed", evs[0]?.payload as never).enqueueSync).toBe(
      true,
    );
  });

  it("addPayer publishes m5.patient.payer_changed (M12 invalidates the RxBenefit cache)", async () => {
    const patientId = await admit();
    await admin.query("DELETE FROM outbox_event");
    await service.addPayer(
      ORG_A,
      patientId,
      {
        payerId: randomUUID(),
        rank: 1,
        coverageKind: "medicare_ffs",
        subscriberId: "S1",
        effectiveFrom: "2026-01-01",
      } as never,
      STAFF,
    );
    const evs = await events();
    expect(evs.map((e) => e.event_type)).toEqual(["m5.patient.payer_changed"]);
    expect(evs[0]?.payload).toMatchObject({ patientId, organizationId: ORG_A });
    expect(
      decidePatientSyncTrigger("payer_changed", evs[0]?.payload as never).invalidateRxBenefitCache,
    ).toBe(true);
  });

  it("amendment submit + decide publish amendment_request_received then amendment_decided", async () => {
    const patientId = await admit();
    await admin.query("DELETE FROM outbox_event");
    const amd = await service.submitAmendment(
      ORG_A,
      patientId,
      { scope: "demographic", rationale: "dob typo" },
      STAFF,
    );
    await service.decideAmendment(ORG_A, amd.id, { accept: true }, STAFF);
    const evs = await events();
    expect(evs.map((e) => e.event_type)).toEqual([
      "m5.patient.amendment_request_received",
      "m5.patient.amendment_decided",
    ]);
    expect(evs[0]?.payload).toMatchObject({
      patientId,
      organizationId: ORG_A,
      amendmentId: amd.id,
    });
    expect(evs[1]?.payload).toMatchObject({
      patientId,
      amendmentId: amd.id,
      decision: "accepted",
    });
  });

  it("a write that fails after the insert leaves no event and no row (same transaction)", async () => {
    const patientId = await admit();
    await admin.query("DELETE FROM outbox_event");
    const before = (await admin.query("SELECT count(*)::int AS n FROM patient_address")).rows[0].n;
    // US address without a state violates the patient_address CHECK -> the whole tx rolls back.
    await expect(
      service.addAddress(
        ORG_A,
        patientId,
        { line1: "1", city: "A", postalCode: "1", isPrimary: false } as never,
        STAFF,
      ),
    ).rejects.toBeTruthy();
    expect(await events()).toEqual([]);
    const { rows } = await admin.query("SELECT count(*)::int AS n FROM patient_address");
    expect(rows[0].n).toBe(before);
  });

  it("another tenant cannot write an address for this patient (RLS) and nothing is published", async () => {
    const patientId = await admit();
    await admin.query("DELETE FROM outbox_event");
    await expect(
      service.addAddress(
        ORG_B,
        patientId,
        { line1: "1", city: "A", state: "TX", postalCode: "1" } as never,
        STAFF,
      ),
    ).rejects.toBeTruthy();
    expect(await events()).toEqual([]);
  });
});
