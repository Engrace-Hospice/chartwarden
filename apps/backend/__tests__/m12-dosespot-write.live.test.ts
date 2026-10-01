/**
 * M12L — the Drizzle DoseSpot write lifecycle, proven against real Postgres.
 *
 * Drives the writes as the NOBYPASSRLS `wardenx_app` role. Unlike M11, M12 has NO state-transition triggers,
 * so the service does every status transition itself (composing the pure `@wardenx/dosespot` machines):
 * createDraft/edit · requestSignature (prescriber-eligibility gate) · sign → `signed` · recordVerbal →
 * `verbal_pending` then named-prescriber sign · discontinue/complete (on a seeded `active` order) · correct ·
 * refill approve (mints a new order) / deny · prescriber enroll/revoke · the controlled-substance EPCS-OFF
 * gate (D18) · the tighten-only policy guards. Like the M7–M11 write suites it binds the REAL catalog-
 * validating transactional publisher (buildBootOutboxCatalog([M12_OUTBOX_EVENTS]) → the caller's tx) and
 * asserts the `m12.*` rows land in `outbox_event`. RLS is exercised end-to-end.
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m12:write:live
 * For a local PG without pgvector: also set WARDENX_TEST_NO_PGVECTOR=1.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@wardenx/db";
import { runWithRequestContext } from "@wardenx/tenancy";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBootOutboxCatalog, buildTxOutboxPublisher } from "../src/bootstrap/outbox-persister";
import { createDrizzleOrderSeamStore, registerOrderSeams } from "../src/modules/11-orders/index";
import {
  type DoseSpotWriteOutboxPort,
  createDbDoseSpotBackend,
} from "../src/modules/12-dosespot/dosespot-route-service-db";
import { M12_OUTBOX_EVENTS } from "../src/modules/12-dosespot/index";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];
const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const USER2 = "3b3b3b3b-3b3b-4b3b-8b3b-3b3b3b3b3b3b";
const PATIENT = "44444444-4444-4444-4444-444444444444";
const ADMISSION = "55555555-5555-5555-5555-555555555555";
const PHYSICIAN_MDM = "66666666-6666-6666-6666-666666666666";
/** A ≥100-char verbal attestation (the §2.3 recorder-attestation floor). */
const ATTESTATION =
  "Read back and verbally confirmed the complete medication order with the named prescriber at the bedside per §2.3.";

/** A complete, clinically coherent standard.v1 payload: morphine 5 mg tab, 1 tab PO q6h PRN pain, 7-day supply. */
const STANDARD_MED_DATA = {
  sigStructured: {
    doseQuantity: 1,
    doseUnit: "tablet",
    route: "oral",
    frequencyCode: "Q6H",
    asNeeded: true,
    asNeededReasonCode: "pain",
  },
  sigFreeText: "1 tab PO q6h PRN pain",
  refillsAuthorized: 0,
  dispenseQuantity: { value: 28, unit: "tablet" },
  daysSupply: 7,
  daw: false,
};
/** controlled_substance.v1 for a Schedule II opioid: non-refillable, indication + justification + DEA required. */
const CONTROLLED_MED_DATA = {
  ...STANDARD_MED_DATA,
  indication: "Severe cancer-related pain",
  clinicalJustification:
    "Opioid required for pain uncontrolled on non-opioid analgesics at end of life.",
  deaSchedule: "II",
  prescriberDea: "AB1234563",
};

describe.skipIf(!DB_URL)("M12 DoseSpot write lifecycle — LIVE Postgres (M12L)", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let svc: ReturnType<typeof createDbDoseSpotBackend>;
  const memberOf: Record<string, string> = {};
  const member2Of: Record<string, string> = {};
  const providerOf: Record<string, string> = {};
  const locationOf: Record<string, string> = {};

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
    const strip = !!process.env.WARDENX_TEST_NO_PGVECTOR;
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
    const { rows } = await admin.query("SELECT status FROM medication_order WHERE id=$1", [id]);
    return rows[0]?.status as string;
  }
  /** Seed an `active` medication_order (the discontinue/complete/refill-source precondition) as superuser. */
  async function seedActiveOrder(org: string): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO medication_order (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, med_class, drug_name, strength, dose_form, route, data, prescriber_membership_id,
           prescribing_physician_mdm_id, status)
         VALUES ($1,$2,$3,$4,$5,'standard','Morphine','5 mg','tablet','oral','{}'::jsonb,$6,$7,'active') RETURNING id`,
        [org, providerOf[org], locationOf[org], PATIENT, ADMISSION, memberOf[org], PHYSICIAN_MDM],
      )
    ).rows[0].id as string;
  }
  /** Seed a pending refill_request against a source order as superuser; returns its id. */
  async function seedRefill(org: string, sourceOrderId: string, n: number): Promise<string> {
    return (
      await admin.query(
        `INSERT INTO refill_request (organization_id, provider_entity_id, location_id,
           source_medication_order_id, patient_id, dosespot_event_id, received_at)
         VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING id`,
        [
          org,
          providerOf[org],
          locationOf[org],
          sourceOrderId,
          PATIENT,
          `rx-evt-${org.slice(0, 4)}-${n}`,
        ],
      )
    ).rows[0].id as string;
  }

  const draftArgs = (over: Record<string, unknown> = {}) => ({
    patientId: PATIENT,
    admissionId: ADMISSION,
    medClass: "standard" as const,
    rxnormRxcui: "1049502",
    ndc: null,
    drugName: "Morphine",
    strength: "5 mg",
    doseForm: "tablet",
    route: "oral",
    // standard.v1 payload (packages/dosespot/src/classes/contracts.ts): unknown keys are rejected at draft
    // and the full shape is required at requestSignature.
    data: STANDARD_MED_DATA,
    prescriberDiscipline: "hospice_physician",
    prescribingPhysicianMdmId: PHYSICIAN_MDM,
    refillsAuthorized: 0,
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
      `INSERT INTO "user" (id,email) VALUES ($1,'m12w@x.test'),($2,'m12w2@x.test')`,
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
      providerOf[org] = (
        await admin.query(
          `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,$2,$3,$4,'enc','12-31') RETURNING id`,
          [
            org,
            `CCN-M12W-${org.slice(0, 4)}`,
            `M12W ${org.slice(0, 4)}`,
            `NPI-M12W-${org.slice(0, 4)}`,
          ],
        )
      ).rows[0].id as string;
      locationOf[org] = (
        await admin.query(
          `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
          [providerOf[org]],
        )
      ).rows[0].id as string;
    }
    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({
      connectionString: appRoleUrl(DB_URL as string),
    });
    // The real M11 OrderSignatureProvider seam over the real Drizzle store, registered exactly as
    // `apps/backend/src/index.ts` does on a db boot. M12's `recordVerbal` writes its `verbal_order` receipt
    // through this seam since F-162 (651f8ef6); without it the route throws "seam requested before
    // registration". Registered once for the file (a module-scope Map; one test file per process).
    registerOrderSeams({ store: createDrizzleOrderSeamStore(handle.db) });
    const txPublisher = buildTxOutboxPublisher(buildBootOutboxCatalog([M12_OUTBOX_EVENTS]));
    const outbox: DoseSpotWriteOutboxPort = {
      publish: (tx, e) => txPublisher.publish(tx as never, { ...e, callerModule: "m12" }),
    };
    svc = createDbDoseSpotBackend(handle.db, outbox);
  }, 120_000);

  afterAll(async () => {
    await handle?.close();
    if (admin) await admin.end();
  });

  it("createDraft persists a draft (draft_created); editDraft bumps version", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    expect(draft.status).toBe("draft");
    expect(draft.version).toBe(1);
    expect(await eventsFor(draft.id)).toContain("m12.medication_order.draft_created");
    const edited = await svc.editDraft(ORG_A, draft.id, {
      strength: "10 mg",
      refillsAuthorized: 2,
    });
    expect(edited.version).toBe(2);
    expect(edited.strength).toBe("10 mg");
    expect(edited.refillsRemaining).toBe(2);
  });

  it("F-058: requestSignature → pending_signature; sign → ACTIVE when nothing is e-prescribed", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    const pending = await svc.requestSignature(ORG_A, draft.id, "hospice_physician");
    expect(pending.status).toBe("pending_signature");
    expect(await eventsFor(draft.id)).toContain("m12.medication_order.signature_requested");
    const signed = await svc.signOrder(ORG_A, memberOf[ORG_A], draft.id, {
      signerDiscipline: "hospice_physician",
      signedAtClient: new Date().toISOString(),
    });
    // This used to assert `signed`, and `signed` is where the order then stayed forever: no transmission
    // worker, no webhook handler, and `signed` had one exit. `dosespot_send_state` defaults to
    // `not_required` — nothing is being e-prescribed — so there is nothing left to wait for.
    expect(signed.status).toBe("active");
    expect(signed.signedAt).not.toBeNull();
    const events = await eventsFor(draft.id);
    expect(events).toContain("m12.medication_order.signed");
    expect(events).toContain("m12.medication_order.active");
    const { rows } = await admin.query("SELECT activated_at FROM medication_order WHERE id=$1", [
      draft.id,
    ]);
    expect(rows[0].activated_at).not.toBeNull();
    // …and it is finally visible on the read every downstream surface uses.
    const active = await svc.activeMedications(ORG_A, PATIENT);
    expect(active.orders.map((o) => o.id)).toContain(draft.id);
  });

  it("F-058: an order that OWES a transmission stays signed on signature", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    await svc.requestSignature(ORG_A, draft.id, "hospice_physician");
    // The e-prescribing path: this order has a NewRx queued, so it activates on the pharmacy
    // acknowledgment and not before. The `signed → active` arm is guarded on exactly this.
    await admin.query("UPDATE medication_order SET dosespot_send_state='queued' WHERE id=$1", [
      draft.id,
    ]);
    const signed = await svc.signOrder(ORG_A, memberOf[ORG_A], draft.id, {
      signerDiscipline: "hospice_physician",
      signedAtClient: new Date().toISOString(),
    });
    expect(signed.status).toBe("signed");
    expect(await eventsFor(draft.id)).not.toContain("m12.medication_order.active");
  });

  it("requestSignature by an ineligible discipline (MSW) → PRESCRIBER_NOT_ELIGIBLE", async () => {
    // rn_case_manager may draft-on-behalf for standard meds; a non-clinical discipline (msw) may not.
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    await expect(svc.requestSignature(ORG_A, draft.id, "msw")).rejects.toMatchObject({
      code: "PRESCRIBER_NOT_ELIGIBLE",
    });
  });

  it("sign by an ineligible signer (RN) → SIGNER_NOT_ELIGIBLE", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    await svc.requestSignature(ORG_A, draft.id, "hospice_physician");
    await expect(
      svc.signOrder(ORG_A, memberOf[ORG_A], draft.id, {
        signerDiscipline: "rn_case_manager",
        signedAtClient: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "SIGNER_NOT_ELIGIBLE" });
  });

  it("recordVerbal → verbal_pending; the named prescriber then signs → signed (viaVerbal)", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    await svc.requestSignature(ORG_A, draft.id, "hospice_physician");
    // The route runs inside the request's ambient context; the M11 seam it writes through
    // (`withOrgContextFromRequest`) reads it, exactly as in production.
    const verbal = await runWithRequestContext({ organizationId: ORG_A, userId: USER }, () =>
      svc.recordVerbal(ORG_A, memberOf[ORG_A], draft.id, {
        recorderDiscipline: "rn_case_manager",
        verbalAttestation: ATTESTATION,
        receivedAt: new Date().toISOString(),
        namedPrescriberMdmId: PHYSICIAN_MDM,
      }),
    );
    expect(verbal.status).toBe("verbal_pending");
    expect(await eventsFor(draft.id)).toContain("m12.medication_order.verbal_received");
    const signed = await svc.signOrder(ORG_A, memberOf[ORG_A], draft.id, {
      signerDiscipline: "hospice_physician",
      signedAtClient: new Date().toISOString(),
      signerIsOrderingPhysician: true,
    });
    // F-058 — the verbal follow-up signature activates too; the drug was already being given under the
    // verbal order (M12 §2.3: a verbal order "is active for clinical execution during this window").
    expect(signed.status).toBe("active");
  });

  it("EPCS is OFF (D18): a controlled order fails at requestSignature and signControlledInitiate", async () => {
    const draft = await svc.createDraft(
      ORG_A,
      memberOf[ORG_A],
      draftArgs({ medClass: "controlled_substance", deaSchedule: "II", data: CONTROLLED_MED_DATA }),
    );
    expect(draft.isControlledSubstance).toBe(true);
    expect(draft.deaSchedule).toBe("II");
    await expect(svc.requestSignature(ORG_A, draft.id, "hospice_physician")).rejects.toMatchObject({
      code: "EPCS_NOT_CERTIFIED",
    });
    // The EPCS gate already blocked pending_signature, so the order is still a draft: signControlledInitiate
    // is an ILLEGAL transition from draft (the controlled order can never reach the EPCS challenge, D18).
    await expect(
      svc.signControlledInitiate(ORG_A, memberOf[ORG_A], draft.id, "II"),
    ).rejects.toMatchObject({
      code: "ILLEGAL_MEDICATION_ORDER_TRANSITION",
    });
  });

  it("discontinue + complete operate on an active order and emit their events", async () => {
    const active1 = await seedActiveOrder(ORG_A);
    const dc = await svc.discontinueOrder(ORG_A, memberOf[ORG_A], active1, {
      reason: "clinical_judgement",
      effectiveAt: new Date().toISOString(),
    });
    expect(dc.status).toBe("discontinued");
    expect(await eventsFor(active1)).toContain("m12.medication_order.discontinued");
    const active2 = await seedActiveOrder(ORG_A);
    const done = await svc.completeOrder(ORG_A, memberOf[ORG_A], active2, "one-shot met");
    expect(done.status).toBe("completed");
    expect(await eventsFor(active2)).toContain("m12.medication_order.completed");
  });

  it("correctOrder mints a replacement draft (replaces set) and emits draft_created", async () => {
    const active = await seedActiveOrder(ORG_A);
    const { newOrderId } = await svc.correctOrder(
      ORG_A,
      memberOf[ORG_A],
      active,
      draftArgs({ strength: "15 mg" }),
    );
    expect(await statusOf(newOrderId)).toBe("draft");
    const corrected = await svc.getOrder(ORG_A, newOrderId);
    expect(corrected.replacesMedicationOrderId).toBe(active);
    expect(await eventsFor(newOrderId)).toContain("m12.medication_order.draft_created");
  });

  it("approveRefill mints a new order (D9); denyRefill records a denial", async () => {
    const source = await seedActiveOrder(ORG_A);
    const refillA = await seedRefill(ORG_A, source, 1);
    const { resultingOrderId } = await svc.approveRefill(ORG_A, memberOf[ORG_A], refillA, {
      refillsAuthorized: 2,
    });
    expect(await statusOf(resultingOrderId)).toBe("draft");
    const back = await svc.getRefill(ORG_A, refillA);
    expect(back.status).toBe("approved");
    expect(back.resultingMedicationOrderId).toBe(resultingOrderId);
    expect(await eventsFor(refillA)).toContain("m12.refill_request_approved");

    const refillB = await seedRefill(ORG_A, source, 2);
    const denied = await svc.denyRefill(ORG_A, memberOf[ORG_A], refillB, {
      denialReason: "not clinically appropriate at this time",
    });
    expect(denied.status).toBe("denied");
    expect((await svc.getRefill(ORG_A, refillB)).status).toBe("denied");
    expect(await eventsFor(refillB)).toContain("m12.refill_request_denied");
  });

  it("enrollPrescriber then revokePrescriber round-trips the roster + emits", async () => {
    const enrolled = await svc.enrollPrescriber(ORG_A, member2Of[ORG_A], ["III", "IV"]);
    expect(enrolled.enrolled).toBe(true);
    expect(await eventsFor(member2Of[ORG_A])).toContain("m12.prescriber_enrolled");
    const revoked = await svc.revokePrescriber(ORG_A, member2Of[ORG_A], "left the practice");
    expect(revoked.status).toBe("revoked");
    const { prescribers } = await svc.listPrescribers(ORG_A);
    expect(prescribers.find((p) => p.membershipId === member2Of[ORG_A])?.enrolled).toBe(false);
    expect(await eventsFor(member2Of[ORG_A])).toContain("m12.prescriber_revoked");
  });

  it("policy guards are tighten-only (controlled ≤ 5 refills; refill SLA ≤ floor)", async () => {
    await expect(
      svc.putControlledSubstancePolicy(ORG_A, { scheduleIiiToVMaxRefills: 6 }),
    ).rejects.toBeTruthy();
    const csOk = await svc.putControlledSubstancePolicy(ORG_A, { scheduleIiiToVMaxRefills: 3 });
    expect(csOk.scheduleIiiToVMaxRefills).toBe(3);
    await expect(svc.putRefillInboxPolicy(ORG_A, { slaWarnHours: 72 })).rejects.toBeTruthy();
    const slaOk = await svc.putRefillInboxPolicy(ORG_A, { slaWarnHours: 24 });
    expect(slaOk.slaWarnHours).toBe(24);
  });

  it("RLS: org B cannot read or sign org A's order (404 under the wardenx_app policy)", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    await expect(svc.getOrder(ORG_B, draft.id)).rejects.toMatchObject({ statusCode: 404 });
    await svc.requestSignature(ORG_A, draft.id, "hospice_physician");
    await expect(
      svc.signOrder(ORG_B, memberOf[ORG_B], draft.id, {
        signerDiscipline: "hospice_physician",
        signedAtClient: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
