/**
 * S07 (clinical workflow audit 2026-10-28) -- medication order lifecycle -> administration, on real Postgres.
 *
 * m13-emar-write.live.test.ts answers "is this order administrable?" with a hand-written stub port, and
 * m12-dosespot-write.live.test.ts never calls M13. This suite joins them with the production wiring: the real
 * M11 `OrderSignatureProvider`, the real M12 `MedicationOrderProvider` read seam, and the same
 * `getAdministrationContext -> toAdministrationIdentity` port, hand-copied from `buildEmarBackend` in
 * `13-emar/index.ts` (keep the two in step). It proves:
 *   - draft -> sign -> active order is administrable, and the record snapshots the REAL order's drug;
 *   - an unsigned order and a discontinued order are refused ADMINISTRATION_BLOCKED, leaving no row;
 *   - a verbal order is administrable (M12 §2.3) and stays so after the named prescriber signs;
 *   - a signature that cannot be recorded leaves the order unchanged (no status flip, no signed event);
 *   - a discontinue racing an administration ends in a consistent state.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m12-m13:order-administration:live
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { runWithRequestContext } from "@chartwarden/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSeam } from "../src/bootstrap/index";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDrizzleOrderSeamStore, registerOrderSeams } from "../src/modules/11-orders/index";
import {
  type DoseSpotWriteOutboxPort,
  createDbDoseSpotBackend,
} from "../src/modules/12-dosespot/dosespot-route-service-db";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { createDrizzleDoseSpotSeamStore } from "../src/modules/12-dosespot/seams/drizzle-store";
import { registerDoseSpotSeams } from "../src/modules/12-dosespot/seams/index";
import { toAdministrationIdentity } from "../src/modules/13-emar/administration-identity";
import {
  type EmarMedicationOrderPort,
  type EmarWriteOutboxPort,
  createDbEmarBackend,
} from "../src/modules/13-emar/emar-route-service-db";
import { M13_OUTBOX_EVENTS } from "../src/modules/13-emar/index";
import { LIVE_APP_ROLE_PASSWORD, LIVE_DROP_ROLES, appRoleUrl } from "./_live-app-role";
import { PASSING_M12_SAFETY_GATES } from "./_m12-safety-gates";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const PHYSICIAN_MDM = "66666666-6666-6666-6666-666666666666";
/** A ≥100-char verbal attestation (the §2.3 recorder-attestation floor). */
const ATTESTATION =
  "Read back and verbally confirmed the complete medication order with the named prescriber at the bedside per §2.3.";
const SIG = {
  doseQuantity: 1,
  doseUnit: "tablet",
  route: "oral",
  frequencyCode: "Q6H",
  asNeeded: true,
  asNeededReasonCode: "pain",
};
const STANDARD_MED_DATA = {
  sigStructured: SIG,
  sigFreeText: "1 tab PO q6h PRN pain",
  refillsAuthorized: 0,
  dispenseQuantity: { value: 28, unit: "tablet" },
  daysSupply: 7,
  daw: false,
};

describe.skipIf(!DB_URL)("S07 order lifecycle -> administration — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let orders: ReturnType<typeof createDbDoseSpotBackend>;
  let emar: ReturnType<typeof createDbEmarBackend>;
  let membershipId: string;
  /** When true the M11 signature store refuses to record a signature (an infrastructure failure at that step). */
  let failSignature = false;

  const inCtx = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithRequestContext({ organizationId: ORG, userId: USER }, fn);
  const draftActive = async (): Promise<string> => {
    const draft = await orders.createDraft(ORG, membershipId, {
      patientId: PATIENT,
      admissionId: ADMISSION,
      medClass: "standard",
      rxnormRxcui: "1049502",
      ndc: null,
      drugName: "Morphine",
      strength: "5 mg",
      doseForm: "tablet",
      route: "oral",
      data: STANDARD_MED_DATA,
      prescriberDiscipline: "hospice_physician",
      prescribingPhysicianMdmId: PHYSICIAN_MDM,
      refillsAuthorized: 0,
    } as never);
    await orders.requestSignature(ORG, draft.id, "hospice_physician", ["hospice_physician"]);
    return draft.id;
  };
  const sign = (id: string) =>
    inCtx(() =>
      orders.signOrder(ORG, membershipId, id, {
        signerDisciplines: ["hospice_physician"],
        signedAtClient: new Date().toISOString(),
      }),
    );
  const signedActive = async (): Promise<string> => {
    const id = await draftActive();
    await sign(id);
    return id;
  };
  /** The M12 read seam is request-scoped (`withOrgContextFromRequest`); the eMAR route always runs inside one. */
  const give = (medicationOrderId: string) =>
    inCtx(() =>
      emar.recordAdministration(ORG, membershipId, {
        medicationOrderId,
        medClass: "standard",
        mode: "single_dose",
        administeredAt: new Date(Date.now() - 60_000).toISOString(),
        route: "oral",
        doseAmount: 1,
        doseUnit: "tablet",
      } as never),
    );
  const scalar = async (sql: string, args: unknown[]): Promise<number> =>
    (await admin.query(sql, args)).rows[0].n as number;
  const administrations = (orderId: string) =>
    scalar("SELECT count(*)::int AS n FROM administration_record WHERE medication_order_id=$1", [
      orderId,
    ]);
  const statusOf = async (id: string): Promise<string> =>
    (await admin.query("SELECT status FROM medication_order WHERE id=$1", [id])).rows[0]
      .status as string;
  const events = async (id: string, type: string): Promise<number> =>
    scalar("SELECT count(*)::int AS n FROM outbox_event WHERE aggregate_id=$1 AND event_type=$2", [
      id,
      type,
    ]);
  const signatures = (id: string) =>
    scalar("SELECT count(*)::int AS n FROM order_signature WHERE target_id=$1", [id]);

  beforeAll(async () => {
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const r of LIVE_DROP_ROLES)
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${r}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; END IF; END $$;`,
      );
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
    await admin.query(
      "INSERT INTO organization (id,slug,legal_name,display_name) VALUES ($1,'org-a','A','A')",
      [ORG],
    );
    await admin.query(`INSERT INTO "user" (id,email) VALUES ($1,'s07@x.test')`, [USER]);
    membershipId = (
      await admin.query(
        "INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id",
        [USER, ORG],
      )
    ).rows[0].id as string;
    const provider = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
         VALUES ($1,'CCN-S07','S07','NPI-S07','enc','12-31') RETURNING id`,
        [ORG],
      )
    ).rows[0].id as string;
    await admin.query(
      `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
       VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles')`,
      [provider],
    );
    await admin.query(
      `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob,
         sex_assigned_at_birth, status)
       VALUES ($1,$2,'mrn-s07','Pat','Alpha','1950-01-01','female','active')`,
      [PATIENT, ORG],
    );
    await admin.query(`ALTER ROLE chartwarden_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });

    // The production seam wiring (apps/backend/src/index.ts): M11 signature provider + M12 order read seam.
    const orderStore = createDrizzleOrderSeamStore(handle.db);
    registerOrderSeams({
      store: new Proxy(orderStore, {
        get(target, prop) {
          if (prop === "insertSignature" && failSignature)
            return async () => {
              throw new Error("injected signature-store failure");
            };
          return Reflect.get(target, prop);
        },
      }),
    });
    registerDoseSpotSeams({ store: createDrizzleDoseSpotSeamStore(handle.db), db: handle.db });

    const publisher = buildTxOutboxPublisher(
      buildBootOutboxCatalog([M12_OUTBOX_EVENTS, M13_OUTBOX_EVENTS]),
    );
    const m12Outbox: DoseSpotWriteOutboxPort = {
      publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m12" }),
    };
    const m13Outbox: EmarWriteOutboxPort = {
      publish: (tx, e) => publisher.publish(tx as never, { ...e, callerModule: "m13" }),
    };
    orders = createDbDoseSpotBackend(handle.db, m12Outbox, PASSING_M12_SAFETY_GATES);
    // The same port `13-emar/index.ts` hands the production eMAR backend.
    const realOrderPort: EmarMedicationOrderPort = {
      async administrationIdentity({ organizationId, medicationOrderId }) {
        const ctx = await getSeam("MedicationOrderProvider").getAdministrationContext(
          organizationId,
          medicationOrderId,
        );
        return ctx === null ? null : toAdministrationIdentity(ctx);
      },
      async activeMedicationOrderIds({ organizationId, patientId }) {
        const active = await getSeam("MedicationOrderProvider").getActiveMedications(
          organizationId,
          patientId,
        );
        return active.map((o) => o.id as string);
      },
    };
    emar = createDbEmarBackend(handle.db, m13Outbox, undefined, () => realOrderPort);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("draft -> sign -> active: the order is administrable and the record snapshots the real drug", async () => {
    const id = await signedActive();
    expect(await statusOf(id)).toBe("active");
    expect(await signatures(id)).toBe(1);

    const view = await give(id);

    expect(view.status).toBe("committed");
    const { rows } = await admin.query(
      "SELECT drug_name_snapshot, patient_id FROM administration_record WHERE id=$1",
      [view.id],
    );
    expect(rows[0].drug_name_snapshot).toBe("Morphine");
    expect(rows[0].patient_id).toBe(PATIENT);
  });

  it("an order awaiting signature is refused ADMINISTRATION_BLOCKED and nothing is written", async () => {
    const id = await draftActive();
    expect(await statusOf(id)).toBe("pending_signature");

    await expect(give(id)).rejects.toMatchObject({ code: "ADMINISTRATION_BLOCKED" });

    expect(await administrations(id)).toBe(0);
  });

  it("discontinue -> administer is refused ADMINISTRATION_BLOCKED with no row, and earlier doses keep their drug", async () => {
    const id = await signedActive();
    const before = await give(id);

    await orders.discontinueOrder(ORG, membershipId, id, {
      reason: "clinical_judgement",
      effectiveAt: new Date().toISOString(),
    });

    expect(await statusOf(id)).toBe("discontinued");
    await expect(give(id)).rejects.toMatchObject({ code: "ADMINISTRATION_BLOCKED" });
    expect(await administrations(id)).toBe(1);
    const { rows } = await admin.query(
      "SELECT drug_name_snapshot FROM administration_record WHERE id=$1",
      [before.id],
    );
    expect(rows[0].drug_name_snapshot).toBe("Morphine");
  });

  it("a verbal order is administrable while verbal_pending, and after the named prescriber signs", async () => {
    const id = await draftActive();
    await orders.enrollPrescriber(ORG, membershipId, [], PHYSICIAN_MDM);
    await inCtx(() =>
      orders.recordVerbal(ORG, membershipId, id, {
        recorderDiscipline: "rn_case_manager",
        recorderDisciplines: ["rn_case_manager"],
        verbalAttestation: ATTESTATION,
        receivedAt: new Date().toISOString(),
        namedPrescriberMdmId: PHYSICIAN_MDM,
      }),
    );
    expect(await statusOf(id)).toBe("verbal_pending");

    const underVerbal = await give(id);
    await sign(id);
    const afterSign = await give(id);

    expect(underVerbal.status).toBe("committed");
    expect(afterSign.status).toBe("committed");
    expect(await statusOf(id)).toBe("active");
    expect(await administrations(id)).toBe(2);
  });

  it("a signature that cannot be recorded leaves the order unchanged: no status flip, no signed event, no signature", async () => {
    const id = await draftActive();
    failSignature = true;
    try {
      await expect(sign(id)).rejects.toThrow(/injected signature-store failure/);
    } finally {
      failSignature = false;
    }

    expect(await statusOf(id)).toBe("pending_signature");
    const { rows } = await admin.query("SELECT signed_at FROM medication_order WHERE id=$1", [id]);
    expect(rows[0].signed_at).toBeNull();
    expect(await events(id, "m12.medication_order.signed")).toBe(0);
    expect(await events(id, "m12.medication_order.active")).toBe(0);
    expect(await signatures(id)).toBe(0);
    await expect(give(id)).rejects.toMatchObject({ code: "ADMINISTRATION_BLOCKED" });
    // The failure was not sticky: the same order signs once the store recovers.
    await sign(id);
    expect(await statusOf(id)).toBe("active");
    expect(await signatures(id)).toBe(1);
  });

  it("a discontinue racing an administration ends consistent: discontinued, at most one dose, and the next dose refused", async () => {
    const id = await signedActive();

    const [dose, discontinued] = await Promise.allSettled([
      give(id),
      orders.discontinueOrder(ORG, membershipId, id, {
        reason: "clinical_judgement",
        effectiveAt: new Date().toISOString(),
      }),
    ]);

    expect(discontinued.status).toBe("fulfilled");
    expect(await statusOf(id)).toBe("discontinued");
    // Either order of arrival is legal, but a refused dose must be refused for the RIGHT reason.
    if (dose.status === "rejected")
      expect((dose.reason as { code?: unknown }).code).toBe("ADMINISTRATION_BLOCKED");
    expect(await administrations(id)).toBe(dose.status === "fulfilled" ? 1 : 0);
    await expect(give(id)).rejects.toMatchObject({ code: "ADMINISTRATION_BLOCKED" });
  });
});
