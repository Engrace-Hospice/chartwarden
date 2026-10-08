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
import { PASSING_M12_SAFETY_GATES } from "./_m12-safety-gates";

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
  let outboxPort: DoseSpotWriteOutboxPort;
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
    outboxPort = outbox;
    svc = createDbDoseSpotBackend(handle.db, outbox, PASSING_M12_SAFETY_GATES);
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

  /** GAP-018 -- the sign path records its signature through M11's request-scoped seam, so it needs a request. */
  const signAsMember = (id: string) =>
    runWithRequestContext({ organizationId: ORG_A, userId: USER }, () =>
      svc.signOrder(ORG_A, memberOf[ORG_A], id, {
        signerDisciplines: ["hospice_physician"],
        signedAtClient: new Date().toISOString(),
      }),
    );
  const signatureRows = async (id: string) =>
    (
      await admin.query(
        "SELECT signature_kind, target_kind, signer_membership_id, signer_discipline, signed_at FROM order_signature WHERE target_id=$1",
        [id],
      )
    ).rows;

  it("F-058: requestSignature → pending_signature; sign → ACTIVE when nothing is e-prescribed", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    const pending = await svc.requestSignature(ORG_A, draft.id, "hospice_physician", [
      "hospice_physician",
    ]);
    expect(pending.status).toBe("pending_signature");
    expect(await eventsFor(draft.id)).toContain("m12.medication_order.signature_requested");
    const signed = await signAsMember(draft.id);
    // This used to assert `signed`, and `signed` is where the order then stayed forever: no transmission
    // worker, no webhook handler, and `signed` had one exit. `dosespot_send_state` defaults to
    // `not_required` — nothing is being e-prescribed — so there is nothing left to wait for.
    expect(signed.status).toBe("active");
    expect(signed.signedAt).not.toBeNull();
    // GAP-018 -- the signature record exists: who signed, under which discipline, when (server time).
    const sigs = await signatureRows(draft.id);
    expect(sigs).toHaveLength(1);
    expect(sigs[0]).toMatchObject({
      signature_kind: "signature",
      target_kind: "medication_order",
      signer_membership_id: memberOf[ORG_A],
      signer_discipline: "hospice_physician",
    });
    expect(sigs[0].signed_at).toBeInstanceOf(Date);
    // A replayed sign is refused (the order left pending_signature) and mints no second record.
    await expect(signAsMember(draft.id)).rejects.toBeDefined();
    expect(await signatureRows(draft.id)).toHaveLength(1);
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
    await svc.requestSignature(ORG_A, draft.id, "hospice_physician", ["hospice_physician"]);
    // The e-prescribing path: this order has a NewRx queued, so it activates on the pharmacy
    // acknowledgment and not before. The `signed → active` arm is guarded on exactly this.
    await admin.query("UPDATE medication_order SET dosespot_send_state='queued' WHERE id=$1", [
      draft.id,
    ]);
    const signed = await signAsMember(draft.id);
    expect(signed.status).toBe("signed");
    expect(await eventsFor(draft.id)).not.toContain("m12.medication_order.active");
  });

  it("requestSignature by an ineligible discipline (MSW) → PRESCRIBER_NOT_ELIGIBLE", async () => {
    // rn_case_manager may draft-on-behalf for standard meds; a non-clinical discipline (msw) may not.
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    await expect(svc.requestSignature(ORG_A, draft.id, "msw", ["msw"])).rejects.toMatchObject({
      code: "PRESCRIBER_NOT_ELIGIBLE",
    });
  });

  it("sign by an ineligible signer (RN) → SIGNER_NOT_ELIGIBLE", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    await svc.requestSignature(ORG_A, draft.id, "hospice_physician", ["hospice_physician"]);
    await expect(
      svc.signOrder(ORG_A, memberOf[ORG_A], draft.id, {
        signerDisciplines: ["rn_case_manager"],
        signedAtClient: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "SIGNER_NOT_ELIGIBLE" });
  });

  describe("GAP-034 — cosignature (status guard, session role, separation of duties, M11 seam record)", () => {
    const COSIGN_ATTESTATION =
      "I have reviewed this medication order drafted on behalf of the prescriber and concur with it.";
    const cosignArgs = (over: Record<string, unknown> = {}) => ({
      cosignerRole: "clinical_supervisor" as const,
      attestationText: COSIGN_ATTESTATION,
      cosignerDisciplines: ["clinical_supervisor"],
      ...over,
    });
    const cosignAs = (userId: string, id: string, args: ReturnType<typeof cosignArgs>) =>
      runWithRequestContext({ organizationId: ORG_A, userId: USER2 }, () =>
        svc.cosignOrder(ORG_A, userId, id, args),
      );
    const cosignRows = async (id: string) =>
      (
        await admin.query(
          "SELECT signature_kind, target_kind, cosigner_role, signer_membership_id, attestation_text FROM order_signature WHERE target_id=$1 AND signature_kind='cosignature'",
          [id],
        )
      ).rows;
    /** An RN-drafted order owing a cosign: drafted by USER's membership, signature requested as an RN. */
    async function rnDraftedPending() {
      const draft = await svc.createDraft(
        ORG_A,
        memberOf[ORG_A],
        draftArgs({ prescriberDiscipline: "rn_case_manager" }),
      );
      return svc.requestSignature(ORG_A, draft.id, "rn_case_manager", ["rn_case_manager"]);
    }

    it("requestSignature by an RN sets cosign_required + 'pending'; a physician's does not; sign is blocked until attached", async () => {
      const pending = await rnDraftedPending();
      expect(pending).toMatchObject({ cosignRequired: true, cosignStatus: "pending" });
      await expect(
        svc.signOrder(ORG_A, memberOf[ORG_A], pending.id, {
          signerDisciplines: ["hospice_physician"],
          signedAtClient: new Date().toISOString(),
        }),
      ).rejects.toMatchObject({ code: "COSIGN_REQUIRED" });
      const md = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
      const mdPending = await svc.requestSignature(ORG_A, md.id, "hospice_physician", [
        "hospice_physician",
      ]);
      expect(mdPending).toMatchObject({ cosignRequired: false, cosignStatus: null });
    });

    it("GAP-034 follow-up — an RN-drafted order submitted for signature by a PHYSICIAN still owes the cosign (drafter discipline persisted)", async () => {
      const draft = await svc.createDraft(
        ORG_A,
        memberOf[ORG_A],
        draftArgs({ prescriberDiscipline: "rn_case_manager" }),
      );
      const stored = await admin.query(
        "SELECT drafted_by_discipline FROM medication_order WHERE id=$1",
        [draft.id],
      );
      expect(stored.rows[0].drafted_by_discipline).toBe("rn_case_manager");
      // A physician (not the RN) requests signature: the requirement still comes from the STORED drafter.
      const pending = await svc.requestSignature(ORG_A, draft.id, "hospice_physician", [
        "hospice_physician",
      ]);
      expect(pending).toMatchObject({ cosignRequired: true, cosignStatus: "pending" });
      await expect(
        svc.signOrder(ORG_A, memberOf[ORG_A], pending.id, {
          signerDisciplines: ["hospice_physician"],
          signedAtClient: new Date().toISOString(),
        }),
      ).rejects.toMatchObject({ code: "COSIGN_REQUIRED" });
    });

    it("GAP-034 follow-up — a legacy row with NULL drafted_by_discipline falls back to the requesting discipline", async () => {
      const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
      await admin.query("UPDATE medication_order SET drafted_by_discipline=NULL WHERE id=$1", [
        draft.id,
      ]);
      const pending = await svc.requestSignature(ORG_A, draft.id, "rn_case_manager", [
        "rn_case_manager",
      ]);
      expect(pending).toMatchObject({ cosignRequired: true, cosignStatus: "pending" });
    });

    it("a valid cosign writes an M11 order_signature cosignature row (target_kind='medication_order') and attaches", async () => {
      const pending = await rnDraftedPending();
      const out = await cosignAs(member2Of[ORG_A], pending.id, cosignArgs());
      expect(out.cosignStatus).toBe("attached");
      const rows = await cosignRows(pending.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        signature_kind: "cosignature",
        target_kind: "medication_order",
        cosigner_role: "clinical_supervisor",
        signer_membership_id: member2Of[ORG_A],
        // GAP-034 follow-up — the attestation travels through the M11 seam and is persisted.
        attestation_text: COSIGN_ATTESTATION,
      });
      await expect(cosignAs(member2Of[ORG_A], pending.id, cosignArgs())).rejects.toMatchObject({
        code: "ALREADY_COSIGNED",
      });
    });

    it("two concurrent cosigns write exactly ONE order_signature cosignature row (per-order row lock)", async () => {
      const pending = await rnDraftedPending();
      const results = await Promise.allSettled([
        cosignAs(member2Of[ORG_A], pending.id, cosignArgs()),
        cosignAs(member2Of[ORG_A], pending.id, cosignArgs()),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(lost.reason).toMatchObject({ code: "ALREADY_COSIGNED" });
      expect(await cosignRows(pending.id)).toHaveLength(1);
    });

    it("refusals write NO order_signature row: role not held, role too low, drafter, wrong status, not required", async () => {
      const pending = await rnDraftedPending();
      await expect(
        cosignAs(
          member2Of[ORG_A],
          pending.id,
          cosignArgs({ cosignerDisciplines: ["rn_case_manager"] }),
        ),
      ).rejects.toMatchObject({ code: "DISCIPLINE_NOT_HELD" });
      await expect(
        cosignAs(
          member2Of[ORG_A],
          pending.id,
          cosignArgs({ cosignerRole: "rn_case_manager", cosignerDisciplines: ["rn_case_manager"] }),
        ),
      ).rejects.toMatchObject({ code: "COSIGNER_ROLE_MISMATCH" });
      await expect(cosignAs(memberOf[ORG_A], pending.id, cosignArgs())).rejects.toMatchObject({
        code: "COSIGN_SELF",
      });
      const draft = await svc.createDraft(
        ORG_A,
        memberOf[ORG_A],
        draftArgs({ prescriberDiscipline: "rn_case_manager" }),
      );
      await expect(cosignAs(member2Of[ORG_A], draft.id, cosignArgs())).rejects.toMatchObject({
        code: "COSIGN_NOT_ALLOWED_IN_STATUS",
      });
      const md = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
      await svc.requestSignature(ORG_A, md.id, "hospice_physician", ["hospice_physician"]);
      await expect(cosignAs(member2Of[ORG_A], md.id, cosignArgs())).rejects.toMatchObject({
        code: "COSIGN_NOT_REQUIRED",
      });
      for (const id of [pending.id, draft.id, md.id]) expect(await cosignRows(id)).toHaveLength(0);
      expect(await statusOf(pending.id)).toBe("pending_signature");
    });

    it("the named physician who will sign may not cosign the same order", async () => {
      const pending = await rnDraftedPending();
      await svc.enrollPrescriber(ORG_A, member2Of[ORG_A], [], PHYSICIAN_MDM);
      await expect(
        cosignAs(
          member2Of[ORG_A],
          pending.id,
          cosignArgs({
            cosignerRole: "medical_director",
            cosignerDisciplines: ["medical_director"],
          }),
        ),
      ).rejects.toMatchObject({ code: "COSIGN_SELF" });
      await svc.revokePrescriber(ORG_A, member2Of[ORG_A], "test cleanup");
    });
  });

  it("GAP-035: another prescriber cannot sign a pending order they neither authored nor are named on", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    await svc.requestSignature(ORG_A, draft.id, "hospice_physician", ["hospice_physician"]);
    await expect(
      svc.signOrder(ORG_A, member2Of[ORG_A], draft.id, {
        signerDisciplines: ["hospice_physician"],
        signedAtClient: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "SIGNER_NOT_ORDERING_PHYSICIAN" });
    expect(await statusOf(draft.id)).toBe("pending_signature");
  });

  it("GAP-035: user B signing A's verbal order gets VERBAL_SIGNER_NOT_NAMED_PRESCRIBER and the status is unchanged", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    await svc.requestSignature(ORG_A, draft.id, "hospice_physician", ["hospice_physician"]);
    // The named prescriber must be enrolled BEFORE the record step (NAMED_PRESCRIBER_NOT_ENROLLED).
    await svc.enrollPrescriber(ORG_A, memberOf[ORG_A], [], PHYSICIAN_MDM);
    await runWithRequestContext({ organizationId: ORG_A, userId: USER }, () =>
      svc.recordVerbal(ORG_A, memberOf[ORG_A], draft.id, {
        recorderDiscipline: "rn_case_manager",
        recorderDisciplines: ["rn_case_manager"],
        verbalAttestation: ATTESTATION,
        receivedAt: new Date().toISOString(),
        namedPrescriberMdmId: PHYSICIAN_MDM,
      }),
    );
    // USER2 is a physician, but their roster row maps to a DIFFERENT physician.
    await svc.enrollPrescriber(ORG_A, member2Of[ORG_A], [], "77777777-7777-4777-8777-777777777777");
    await expect(
      svc.signOrder(ORG_A, member2Of[ORG_A], draft.id, {
        signerDisciplines: ["hospice_physician"],
        signedAtClient: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ code: "VERBAL_SIGNER_NOT_NAMED_PRESCRIBER" });
    expect(await statusOf(draft.id)).toBe("verbal_pending");
  });

  it("recordVerbal → verbal_pending; the named prescriber then signs → signed (viaVerbal)", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    await svc.requestSignature(ORG_A, draft.id, "hospice_physician", ["hospice_physician"]);
    await svc.enrollPrescriber(ORG_A, memberOf[ORG_A], [], PHYSICIAN_MDM);
    // The route runs inside the request's ambient context; the M11 seam it writes through
    // (`withOrgContextFromRequest`) reads it, exactly as in production.
    const verbal = await runWithRequestContext({ organizationId: ORG_A, userId: USER }, () =>
      svc.recordVerbal(ORG_A, memberOf[ORG_A], draft.id, {
        recorderDiscipline: "rn_case_manager",
        recorderDisciplines: ["rn_case_manager"],
        verbalAttestation: ATTESTATION,
        receivedAt: new Date().toISOString(),
        namedPrescriberMdmId: PHYSICIAN_MDM,
      }),
    );
    expect(verbal.status).toBe("verbal_pending");
    expect(await eventsFor(draft.id)).toContain("m12.medication_order.verbal_received");
    // GAP-035 — the named prescriber is an MDM id; the signer must be the roster member mapped to it.
    const signed = await signAsMember(draft.id);
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
    await expect(
      svc.requestSignature(ORG_A, draft.id, "hospice_physician", ["hospice_physician"]),
    ).rejects.toMatchObject({
      code: "EPCS_NOT_CERTIFIED",
    });
    // The EPCS gate already blocked pending_signature, so the order is still a draft: signControlledInitiate
    // is an ILLEGAL transition from draft (the controlled order can never reach the EPCS challenge, D18).
    await expect(
      svc.signControlledInitiate(ORG_A, memberOf[ORG_A], draft.id, "II", {
        signerDiscipline: "hospice_physician",
        signerDisciplines: ["hospice_physician"],
      }),
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

  it("GAP-035 follow-up: recordVerbal refuses a named prescriber with no active roster row (NAMED_PRESCRIBER_NOT_ENROLLED)", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    await svc.requestSignature(ORG_A, draft.id, "hospice_physician", ["hospice_physician"]);
    await expect(
      runWithRequestContext({ organizationId: ORG_A, userId: USER }, () =>
        svc.recordVerbal(ORG_A, memberOf[ORG_A], draft.id, {
          recorderDiscipline: "rn_case_manager",
          recorderDisciplines: ["rn_case_manager"],
          verbalAttestation: ATTESTATION,
          receivedAt: new Date().toISOString(),
          namedPrescriberMdmId: "88888888-8888-4888-8888-888888888888",
        }),
      ),
    ).rejects.toMatchObject({ code: "NAMED_PRESCRIBER_NOT_ENROLLED" });
    expect(await statusOf(draft.id)).toBe("pending_signature");
  });

  it("GAP-035 follow-up: listNamedPrescribers returns only active rows that carry an MDM id", async () => {
    await svc.enrollPrescriber(ORG_A, memberOf[ORG_A], [], PHYSICIAN_MDM);
    const { prescribers } = await svc.listNamedPrescribers(ORG_A);
    expect(prescribers).toContainEqual({
      membershipId: memberOf[ORG_A],
      externalPhysicianMdmId: PHYSICIAN_MDM,
    });
  });

  it("GAP-035 follow-up: retransmit by a physician who is neither the author nor the named physician is refused", async () => {
    const failedId = (
      await admin.query(
        `INSERT INTO medication_order (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, med_class, drug_name, strength, dose_form, route, data, prescriber_membership_id,
           prescribing_physician_mdm_id, status)
         VALUES ($1,$2,$3,$4,$5,'standard','Morphine','5 mg','tablet','oral','{}'::jsonb,$6,$7,'transmission_failed') RETURNING id`,
        [
          ORG_A,
          providerOf[ORG_A],
          locationOf[ORG_A],
          PATIENT,
          ADMISSION,
          memberOf[ORG_A],
          PHYSICIAN_MDM,
        ],
      )
    ).rows[0].id as string;
    await expect(
      svc.retransmit(ORG_A, member2Of[ORG_A], failedId, {
        signerDisciplines: ["hospice_physician"],
      }),
    ).rejects.toMatchObject({ code: "SIGNER_NOT_ORDERING_PHYSICIAN" });
  });

  it("getOrder's viewerMayRetransmit applies the retransmit standing rule (author, roster-mapped physician, others)", async () => {
    const namedMdm = "99999999-9999-4999-8999-999999999999";
    const failedId = (
      await admin.query(
        `INSERT INTO medication_order (organization_id, provider_entity_id, location_id, patient_id,
           admission_id, med_class, drug_name, strength, dose_form, route, data, prescriber_membership_id,
           prescribing_physician_mdm_id, status)
         VALUES ($1,$2,$3,$4,$5,'standard','Morphine','5 mg','tablet','oral','{}'::jsonb,$6,$7,'transmission_failed') RETURNING id`,
        [
          ORG_A,
          providerOf[ORG_A],
          locationOf[ORG_A],
          PATIENT,
          ADMISSION,
          memberOf[ORG_A],
          namedMdm,
        ],
      )
    ).rows[0].id as string;
    const physician = ["hospice_physician"];
    const asViewer = (membershipId: string, disciplines: readonly string[], id = failedId) =>
      svc.getOrder(ORG_A, id, { membershipId, disciplines });

    // No viewer ⇒ the field is absent (the pre-existing projection).
    expect(await svc.getOrder(ORG_A, failedId)).not.toHaveProperty("viewerMayRetransmit");
    // The authoring prescriber.
    expect((await asViewer(memberOf[ORG_A], physician)).viewerMayRetransmit).toBe(true);
    // Same membership, but a discipline that cannot sign.
    expect((await asViewer(memberOf[ORG_A], ["rn_case_manager"])).viewerMayRetransmit).toBe(false);
    // Another physician whose roster row does not map to the named MDM id — the write refuses them too.
    expect((await asViewer(member2Of[ORG_A], physician)).viewerMayRetransmit).toBe(false);
    // Once their ACTIVE roster row maps to the named physician, the read and the write agree: allowed.
    await svc.enrollPrescriber(ORG_A, member2Of[ORG_A], [], namedMdm);
    expect((await asViewer(member2Of[ORG_A], physician)).viewerMayRetransmit).toBe(true);
    // A revoked roster row no longer counts.
    await svc.revokePrescriber(ORG_A, member2Of[ORG_A], "test cleanup");
    expect((await asViewer(member2Of[ORG_A], physician)).viewerMayRetransmit).toBe(false);
    // A non-failed order is never retransmittable, even by its author.
    const active = await seedActiveOrder(ORG_A);
    expect((await asViewer(memberOf[ORG_A], physician, active)).viewerMayRetransmit).toBe(false);
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

  it("MDM uniqueness: a second ACTIVE roster row on the same MDM id is refused 409 MDM_ID_ALREADY_ENROLLED", async () => {
    const mdm = "88888888-8888-4888-8888-888888888888";
    await svc.enrollPrescriber(ORG_A, memberOf[ORG_A], [], mdm);
    await expect(svc.enrollPrescriber(ORG_A, member2Of[ORG_A], [], mdm)).rejects.toMatchObject({
      code: "MDM_ID_ALREADY_ENROLLED",
      statusCode: 409,
    });
    // revoking the holder frees the MDM id (the partial index only covers revoked_at IS NULL rows).
    await svc.revokePrescriber(ORG_A, memberOf[ORG_A], "left the practice");
    await expect(svc.enrollPrescriber(ORG_A, member2Of[ORG_A], [], mdm)).resolves.toMatchObject({
      externalPhysicianMdmId: mdm,
    });
  });

  it("verbal: an LPN recorder is refused VERBAL_RECORDER_NOT_ELIGIBLE and a claimed discipline the actor lacks is 422", async () => {
    const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
    await svc.requestSignature(ORG_A, draft.id, "hospice_physician", ["hospice_physician"]);
    await svc.enrollPrescriber(ORG_A, memberOf[ORG_A], [], PHYSICIAN_MDM);
    const args = {
      verbalAttestation: ATTESTATION,
      receivedAt: new Date().toISOString(),
      namedPrescriberMdmId: PHYSICIAN_MDM,
    };
    await expect(
      svc.recordVerbal(ORG_A, memberOf[ORG_A], draft.id, {
        ...args,
        recorderDiscipline: "lpn",
        recorderDisciplines: ["lpn"],
      }),
    ).rejects.toMatchObject({ code: "VERBAL_RECORDER_NOT_ELIGIBLE" });
    await expect(
      svc.recordVerbal(ORG_A, memberOf[ORG_A], draft.id, {
        ...args,
        recorderDiscipline: "hospice_physician",
        recorderDisciplines: ["lpn"],
      }),
    ).rejects.toMatchObject({ code: "DISCIPLINE_NOT_HELD" });
    expect(await statusOf(draft.id)).toBe("pending_signature");
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
    await svc.requestSignature(ORG_A, draft.id, "hospice_physician", ["hospice_physician"]);
    await expect(
      svc.signOrder(ORG_B, memberOf[ORG_B], draft.id, {
        signerDisciplines: ["hospice_physician"],
        signedAtClient: new Date().toISOString(),
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // ── GAP-036 — the SUD-consent and allergy gates, fail-closed, decided from the stored order + session ──
  describe("GAP-036 requestSignature safety gates", () => {
    const backendWith = (gates: Parameters<typeof createDbDoseSpotBackend>[2]) =>
      createDbDoseSpotBackend(handle.db, outboxPort, gates);
    const sudDenied = {
      ...PASSING_M12_SAFETY_GATES,
      resolveConsentEvaluator: () => ({
        evaluateForInternalAccess: async () => ({ redactSubstanceUseDisorderFields: true }),
      }),
    };

    it("an SUD-treatment medication for a patient without a Part 2 release → 422 SUD_CONSENT_REQUIRED; the order stays a draft", async () => {
      const draft = await svc.createDraft(
        ORG_A,
        memberOf[ORG_A],
        draftArgs({ drugName: "Buprenorphine/naloxone" }),
      );
      expect(draft.id).toBeTruthy();
      await expect(
        backendWith(sudDenied).requestSignature(
          ORG_A,
          draft.id,
          "hospice_physician",
          ["hospice_physician"],
          memberOf[ORG_A],
        ),
      ).rejects.toMatchObject({ code: "SUD_CONSENT_REQUIRED", statusCode: 422 });
      expect(await statusOf(draft.id)).toBe("draft");
      const { rows } = await admin.query(
        "SELECT is_sud_treatment FROM medication_order WHERE id=$1",
        [draft.id],
      );
      expect(rows[0].is_sud_treatment).toBe(true); // derived server-side from the drug, never the body
    });

    it("the same SUD order passes once M39 allows the acting membership, and M39 is asked about THAT membership", async () => {
      const draft = await svc.createDraft(
        ORG_A,
        memberOf[ORG_A],
        draftArgs({ drugName: "Methadone" }),
      );
      const asked: Array<string | null> = [];
      const allowed = backendWith({
        ...PASSING_M12_SAFETY_GATES,
        resolveConsentEvaluator: () => ({
          evaluateForInternalAccess: async (a) => {
            asked.push(a.actor.membershipId);
            return { redactSubstanceUseDisorderFields: false };
          },
        }),
      });
      const pending = await allowed.requestSignature(
        ORG_A,
        draft.id,
        "hospice_physician",
        ["hospice_physician"],
        memberOf[ORG_A],
      );
      expect(pending.status).toBe("pending_signature");
      expect(asked).toEqual([memberOf[ORG_A]]);
    });

    it("an M39 seam throw denies an SUD order (fail closed)", async () => {
      const draft = await svc.createDraft(
        ORG_A,
        memberOf[ORG_A],
        draftArgs({ drugName: "Naltrexone" }),
      );
      const down = backendWith({
        ...PASSING_M12_SAFETY_GATES,
        resolveConsentEvaluator: () => {
          throw new Error("M39 unavailable");
        },
      });
      await expect(
        down.requestSignature(
          ORG_A,
          draft.id,
          "hospice_physician",
          ["hospice_physician"],
          memberOf[ORG_A],
        ),
      ).rejects.toMatchObject({ code: "SUD_CONSENT_REQUIRED" });
      expect(await statusOf(draft.id)).toBe("draft");
    });

    it("a non-SUD order never consults M39 (an M39 outage does not block ordinary prescribing)", async () => {
      const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
      const down = backendWith({
        ...PASSING_M12_SAFETY_GATES,
        resolveConsentEvaluator: () => {
          throw new Error("M39 unavailable");
        },
      });
      const pending = await down.requestSignature(
        ORG_A,
        draft.id,
        "hospice_physician",
        ["hospice_physician"],
        memberOf[ORG_A],
      );
      expect(pending.status).toBe("pending_signature");
    });

    it("a recorded allergy (verified OR unverified) naming the drug → 422 ALLERGY_CHECK_NOT_PASSED", async () => {
      for (const verificationStatus of ["verified", "unverified"] as const) {
        const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
        const allergic = backendWith({
          ...PASSING_M12_SAFETY_GATES,
          resolveAllergyReader: () => ({
            activeAllergies: async () => [
              { allergenText: "Morphine", verificationStatus, severity: "severe" },
            ],
          }),
        });
        await expect(
          allergic.requestSignature(
            ORG_A,
            draft.id,
            "hospice_physician",
            ["hospice_physician"],
            memberOf[ORG_A],
          ),
        ).rejects.toMatchObject({ code: "ALLERGY_CHECK_NOT_PASSED", statusCode: 422 });
        expect(await statusOf(draft.id)).toBe("draft");
      }
    });

    it("unreadable allergy data (reader throws / null for the patient) denies — never read as 'no allergies'", async () => {
      for (const resolveAllergyReader of [
        () => {
          throw new Error("M5 unavailable");
        },
        () => ({ activeAllergies: async () => null }),
      ]) {
        const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
        const blind = backendWith({ ...PASSING_M12_SAFETY_GATES, resolveAllergyReader });
        await expect(
          blind.requestSignature(
            ORG_A,
            draft.id,
            "hospice_physician",
            ["hospice_physician"],
            memberOf[ORG_A],
          ),
        ).rejects.toMatchObject({ code: "ALLERGY_CHECK_NOT_PASSED" });
      }
    });

    // GAP-036 follow-up — class matching + the acknowledgement-with-reason override.
    const classAllergy = (allergenText: string) =>
      backendWith({
        ...PASSING_M12_SAFETY_GATES,
        resolveAllergyReader: () => ({
          activeAllergies: async () => [
            { allergenText, verificationStatus: "verified" as const, severity: "severe" as const },
          ],
        }),
      });
    const REASON = "Benefit outweighs risk; patient and family counselled.";

    it("a class allergy ('opioids') blocks morphine and names the class, offering an acknowledgement", async () => {
      const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
      await expect(
        classAllergy("opioids").requestSignature(
          ORG_A,
          draft.id,
          "hospice_physician",
          ["hospice_physician"],
          memberOf[ORG_A],
        ),
      ).rejects.toMatchObject({
        code: "ALLERGY_CHECK_NOT_PASSED",
        statusCode: 422,
        message: expect.stringMatching(/opioid.*allergyOverrideReason/s),
      });
      expect(await statusOf(draft.id)).toBe("draft");
    });

    it("a reason WITHOUT a fresh step-up does not override (403 STEP_UP_REQUIRED), the order stays a draft", async () => {
      const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
      await expect(
        classAllergy("opioids").requestSignature(
          ORG_A,
          draft.id,
          "hospice_physician",
          ["hospice_physician"],
          memberOf[ORG_A],
          { reason: REASON, stepUpFresh: false },
        ),
      ).rejects.toMatchObject({ code: "STEP_UP_REQUIRED" });
      expect(await statusOf(draft.id)).toBe("draft");
    });

    it("reason + fresh step-up proceeds, records the acknowledgement on the order and emits it without the reason text", async () => {
      const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
      const pending = await classAllergy("opioids").requestSignature(
        ORG_A,
        draft.id,
        "hospice_physician",
        ["hospice_physician"],
        memberOf[ORG_A],
        { reason: REASON, stepUpFresh: true },
      );
      expect(pending.status).toBe("pending_signature");
      expect((pending.data as Record<string, unknown>).allergyOverride).toMatchObject({
        reason: REASON,
        acknowledgedByMembershipId: memberOf[ORG_A],
        matchedClasses: ["opioid"],
      });
    });

    it("an unreadable allergy list is never overridable, even with a reason and a fresh step-up", async () => {
      const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
      const blind = backendWith({
        ...PASSING_M12_SAFETY_GATES,
        resolveAllergyReader: () => ({ activeAllergies: async () => null }),
      });
      await expect(
        blind.requestSignature(
          ORG_A,
          draft.id,
          "hospice_physician",
          ["hospice_physician"],
          memberOf[ORG_A],
          { reason: REASON, stepUpFresh: true },
        ),
      ).rejects.toMatchObject({ code: "ALLERGY_CHECK_NOT_PASSED" });
    });

    it("a non-prescriber discipline cannot override: the eligibility refusal wins and nothing is recorded", async () => {
      const draft = await svc.createDraft(ORG_A, memberOf[ORG_A], draftArgs());
      await expect(
        classAllergy("opioids").requestSignature(
          ORG_A,
          draft.id,
          "hospice_rn",
          ["hospice_rn"],
          memberOf[ORG_A],
          { reason: REASON, stepUpFresh: true },
        ),
      ).rejects.toMatchObject({ code: "PRESCRIBER_NOT_ELIGIBLE" });
      expect(await statusOf(draft.id)).toBe("draft");
    });
  });
});
