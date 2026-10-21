/**
 * F-193 (#248) — M21's OWN caregiver-signature CAPTURE, END TO END over real Postgres.
 *
 * F-191 (already committed) fixed the outbox-catalog mistake: `m22` was declared a consumer of
 * `m21.supply_request.delivered` for signature capture, but M22's own spec explicitly disclaims owning
 * signature capture and no capture route/seam/consumer exists anywhere in `22-documents/`. That left the
 * REAL gap exactly where it always was: M21's own spec (D7) says a caregiver signature is "optional via
 * M22's signature flow" — a mechanism that was never going to exist. This suite proves the real, minimal
 * replacement: `buildDrizzleM21WriteService(...).captureCaregiverSignature`, run as the REAL NOBYPASSRLS
 * `wardenx_app` role (not a superuser — see `_live-app-role.ts`), against a real Postgres migrated from
 * scratch through 0268.
 *
 * Proves:
 *   1. a `delivered` request accepts a `typed_signature_in_app` capture and the row reflects it
 *   2. a SECOND capture attempt on the same request is REFUSED (409), not overwritten or appended — the
 *      resubmission choice this build made, asserted explicitly
 *   3. a capture before `delivered` is refused (422)
 *   4. the per-method evidence floor refuses an incomplete `witnessed_verbal_documented` capture (422),
 *      then a complete one succeeds and the M22 evidence-document reference lands on its own discrete
 *      column (not inside the evidence jsonb)
 *   5. cross-tenant isolation holds under the REAL RLS policy: org B cannot capture (or even find) org
 *      A's request
 *   6. the M4 write-audit trigger's extended denylist actually scrubs `caregiver_signature_evidence_jsonb`
 *      from the audit diff (the migration 0268 change this suite is the regression test for)
 *
 *   WARDENX_TEST_DATABASE_URL=postgres://… bun run test:m21:caregiver-signature:live
 */
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createDbClient } from "@chartwarden/db";
import { NotFoundError } from "@chartwarden/types";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDrizzleM21ReadService,
  buildDrizzleM21WriteService,
} from "../src/modules/21-supplies/index";
import type { M21WriteActor } from "../src/modules/21-supplies/routes/actor";
import { LIVE_APP_ROLE_PASSWORD, appRoleUrl } from "./_live-app-role";

const DB_URL = process.env.WARDENX_TEST_DATABASE_URL;
const MIGRATIONS_DIR = join(__dirname, "../../../packages/db/migrations");
const ROLES = ["wardenx_app", "wardenx_admin", "wardenx_readonly", "wardenx_audit_writer"];

const ORG_A = "11111111-1111-1111-1111-111111111111";
const ORG_B = "22222222-2222-2222-2222-222222222222";
const USER_A = "33333333-3333-3333-3333-333333333333";
const USER_B = "44444444-4444-4444-4444-444444444444";

describe.skipIf(!DB_URL)("F-193 — M21's caregiver-signature capture — LIVE Postgres", () => {
  let admin: Client;
  let handle: ReturnType<typeof createDbClient>;
  let providerA: string;
  let providerB: string;
  let locationA: string;
  let locationB: string;
  let memberA: string;
  let memberB: string;
  let readService: ReturnType<typeof buildDrizzleM21ReadService>;
  let writeService: ReturnType<typeof buildDrizzleM21WriteService>;

  async function resetSchema() {
    await admin.query("DROP SCHEMA IF EXISTS public CASCADE");
    await admin.query("CREATE SCHEMA public");
    for (const role of ROLES) {
      await admin.query(
        `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${role}') THEN ` +
          `EXECUTE 'DROP OWNED BY ${role} CASCADE'; EXECUTE 'DROP ROLE ${role}'; END IF; END $$;`,
      );
    }
  }
  async function applyMigrations() {
    for (const file of readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      await admin.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
    }
  }

  function actorFor(organizationId: string, userId: string, membershipId: string): M21WriteActor {
    return {
      organizationId,
      userId,
      membershipId,
      roles: ["supply_coordinator"],
      locationIds: [],
      stepUpRecent: true,
    };
  }

  /** Seeds a `supply_request` DIRECTLY (bypassing the write service's own create path — this suite is
   *  about the capture, not the creation lifecycle) at a given status. `delivered` rows carry the D7
   *  courier attestation already recorded, matching what a real row looks like by the time a caregiver
   *  signature could ever be captured against it. */
  async function seedRequest(opts: {
    organizationId: string;
    providerEntityId: string;
    locationId: string;
    membershipId: string;
    status: "requested" | "delivered";
  }): Promise<{ id: string; updatedAt: string }> {
    const patientId = randomUUID();
    const admissionId = randomUUID();
    const { rows } = await admin.query(
      `INSERT INTO supply_request
         (organization_id, patient_id, admission_id, location_id, provider_entity_id,
          requested_by_membership_id, kind, data, status, routing_rule_resolved_jsonb,
          delivered_at, delivered_by_membership_id, delivery_method)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::uuid,'dme','{}'::jsonb,
               $7::text::m21_supply_request_status,
               CASE WHEN $7::text = 'requested' THEN NULL ELSE '{}'::jsonb END,
               CASE WHEN $7::text = 'delivered' THEN now() ELSE NULL END,
               CASE WHEN $7::text = 'delivered' THEN $8::uuid ELSE NULL END,
               CASE WHEN $7::text = 'delivered' THEN 'agency_courier'::m21_delivery_method ELSE NULL END)
       RETURNING id, updated_at`,
      [
        opts.organizationId,
        patientId,
        admissionId,
        opts.locationId,
        opts.providerEntityId,
        opts.membershipId,
        opts.status,
        opts.membershipId,
      ],
    );
    return { id: rows[0].id as string, updatedAt: (rows[0].updated_at as Date).toISOString() };
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
    await admin.query(
      `INSERT INTO "user" (id,email) VALUES ($1,'f192a@x.test'),($2,'f192b@x.test')`,
      [USER_A, USER_B],
    );
    providerA = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,'CCN-A','Hospice A','NPI-A','\\x00','12-31') RETURNING id`,
        [ORG_A],
      )
    ).rows[0].id as string;
    providerB = (
      await admin.query(
        `INSERT INTO provider_entity (organization_id, ccn, legal_name, npi, tax_id_encrypted, fiscal_year_end)
           VALUES ($1,'CCN-B','Hospice B','NPI-B','\\x00','12-31') RETURNING id`,
        [ORG_B],
      )
    ).rows[0].id as string;
    locationA = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc A','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerA],
      )
    ).rows[0].id as string;
    locationB = (
      await admin.query(
        `INSERT INTO location (provider_entity_id, name, address_line1, city, state, postal_code, timezone)
           VALUES ($1,'Loc B','1 St','Town','OR','97000','America/Los_Angeles') RETURNING id`,
        [providerB],
      )
    ).rows[0].id as string;
    memberA = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER_A, ORG_A],
      )
    ).rows[0].id as string;
    memberB = (
      await admin.query(
        `INSERT INTO membership (user_id, organization_id, status) VALUES ($1,$2,'active') RETURNING id`,
        [USER_B, ORG_B],
      )
    ).rows[0].id as string;

    await admin.query(`ALTER ROLE wardenx_app LOGIN PASSWORD '${LIVE_APP_ROLE_PASSWORD}'`);
    handle = createDbClient({ connectionString: appRoleUrl(DB_URL as string) });
    readService = buildDrizzleM21ReadService(handle.db);
    writeService = buildDrizzleM21WriteService(handle.db, readService, {});
  }, 180_000);

  afterAll(async () => {
    await handle?.close();
    await admin?.end();
  });

  it("captures a typed_signature_in_app signature against a delivered request", async () => {
    const req = await seedRequest({
      organizationId: ORG_A,
      providerEntityId: providerA,
      locationId: locationA,
      membershipId: memberA,
      status: "delivered",
    });
    const actor = actorFor(ORG_A, USER_A, memberA);

    const detail = await writeService.captureCaregiverSignature(actor, req.id, {
      expectedUpdatedAt: req.updatedAt,
      captureMethod: "typed_signature_in_app",
      typedSignatureName: "Dana Reyes",
    });

    expect(detail.status).toBe("delivered"); // status does NOT move
    expect(detail.caregiverSignatureCaptureMethod).toBe("typed_signature_in_app");
    expect(detail.caregiverSignatureCapturedByMembershipId).toBe(memberA);
    expect(detail.caregiverSignatureCapturedAt).not.toBeNull();
    expect(detail.caregiverSignatureEvidence).toEqual({ typedSignatureName: "Dana Reyes" });
    expect(detail.caregiverSignatureEvidenceDocumentId).toBeNull();

    const { rows } = await admin.query(
      "SELECT caregiver_signature_capture_method, caregiver_signature_captured_by_membership_id FROM supply_request WHERE id=$1",
      [req.id],
    );
    expect(rows[0].caregiver_signature_capture_method).toBe("typed_signature_in_app");
    expect(rows[0].caregiver_signature_captured_by_membership_id).toBe(memberA);
  });

  it("REFUSES a second capture attempt (409) — resubmission is rejected, not overwritten or appended", async () => {
    const req = await seedRequest({
      organizationId: ORG_A,
      providerEntityId: providerA,
      locationId: locationA,
      membershipId: memberA,
      status: "delivered",
    });
    const actor = actorFor(ORG_A, USER_A, memberA);

    const first = await writeService.captureCaregiverSignature(actor, req.id, {
      expectedUpdatedAt: req.updatedAt,
      captureMethod: "declined",
      declinedReason: "caregiver not present",
    });

    await expect(
      writeService.captureCaregiverSignature(actor, req.id, {
        expectedUpdatedAt: first.updatedAt,
        captureMethod: "typed_signature_in_app",
        typedSignatureName: "Someone Else",
      }),
    ).rejects.toMatchObject({ code: "M21_CAREGIVER_SIGNATURE_ALREADY_CAPTURED", statusCode: 409 });

    // The row still shows the FIRST capture — proving it was not overwritten.
    const { rows } = await admin.query(
      "SELECT caregiver_signature_capture_method FROM supply_request WHERE id=$1",
      [req.id],
    );
    expect(rows[0].caregiver_signature_capture_method).toBe("declined");
  });

  it("refuses a capture before the request has reached 'delivered' (422)", async () => {
    const req = await seedRequest({
      organizationId: ORG_A,
      providerEntityId: providerA,
      locationId: locationA,
      membershipId: memberA,
      status: "requested",
    });
    const actor = actorFor(ORG_A, USER_A, memberA);

    await expect(
      writeService.captureCaregiverSignature(actor, req.id, {
        expectedUpdatedAt: req.updatedAt,
        captureMethod: "declined",
      }),
    ).rejects.toMatchObject({ code: "M21_CAREGIVER_SIGNATURE_REQUIRES_DELIVERY", statusCode: 422 });
  });

  it("enforces the per-method evidence floor: an incomplete witnessed capture is refused, a complete one succeeds with the M22 reference on its own column", async () => {
    const req = await seedRequest({
      organizationId: ORG_A,
      providerEntityId: providerA,
      locationId: locationA,
      membershipId: memberA,
      status: "delivered",
    });
    const actor = actorFor(ORG_A, USER_A, memberA);

    await expect(
      writeService.captureCaregiverSignature(actor, req.id, {
        expectedUpdatedAt: req.updatedAt,
        captureMethod: "witnessed_verbal_documented",
        witnessName: "Chris Lee",
        // missing witnessAttestationText + evidenceDocumentId
      }),
    ).rejects.toMatchObject({ code: "M21_CAREGIVER_SIGNATURE_EVIDENCE_REQUIRED", statusCode: 422 });

    const evidenceDocumentId = randomUUID();
    const detail = await writeService.captureCaregiverSignature(actor, req.id, {
      expectedUpdatedAt: req.updatedAt,
      captureMethod: "witnessed_verbal_documented",
      witnessName: "Chris Lee",
      witnessAttestationText:
        "I witnessed the caregiver verbally consent to receipt of the DME item.",
      evidenceDocumentId,
    });
    expect(detail.caregiverSignatureCaptureMethod).toBe("witnessed_verbal_documented");
    expect(detail.caregiverSignatureEvidenceDocumentId).toBe(evidenceDocumentId);
    // The evidence document id lives on its OWN column, not duplicated inside the jsonb.
    expect(detail.caregiverSignatureEvidence).toEqual({
      witnessName: "Chris Lee",
      witnessAttestationText:
        "I witnessed the caregiver verbally consent to receipt of the DME item.",
    });
  });

  it("cross-tenant isolation: org B cannot find, let alone capture, org A's request (real RLS, not a superuser probe)", async () => {
    const req = await seedRequest({
      organizationId: ORG_A,
      providerEntityId: providerA,
      locationId: locationA,
      membershipId: memberA,
      status: "delivered",
    });
    const actorB = actorFor(ORG_B, USER_B, memberB);

    await expect(
      writeService.captureCaregiverSignature(actorB, req.id, {
        expectedUpdatedAt: req.updatedAt,
        captureMethod: "declined",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // GAP-064 — a dispatch ships from the Location STORED on its supply request; a body naming another
  // Location is refused (422) before eligibility, par-stock or any insert, as the real wardenx_app role.
  it("GAP-064: createDispatch refuses a body locationId that is not the request's stored Location and writes no dispatch row", async () => {
    const req = await seedRequest({
      organizationId: ORG_A,
      providerEntityId: providerA,
      locationId: locationA,
      membershipId: memberA,
      status: "requested",
    });
    await expect(
      writeService.createDispatch(actorFor(ORG_A, USER_A, memberA), {
        supplyRequestId: req.id,
        comfortKitTemplateId: randomUUID(),
        locationId: locationB,
        deploymentSite: "home",
        dispatchSource: "supply_hub",
        pharmacyDispatchMode: "supply_hub_dispatch",
        kitSerialNumber: "KIT-GAP064",
        contents: [
          {
            comfortKitTemplateMedicationId: randomUUID(),
            dispatchedQuantity: "1",
            dispatchedUnit: "tablet",
          },
        ],
      } as never),
    ).rejects.toMatchObject({ code: "M21_LOCATION_MISMATCH" });
    const { rows } = await admin.query(
      "SELECT count(*)::int AS n FROM comfort_kit_dispatch WHERE supply_request_id = $1::uuid",
      [req.id],
    );
    expect(rows[0].n).toBe(0);
  });

  it("the M4 audit trigger scrubs caregiver_signature_evidence_jsonb from the audit diff (migration 0268's denylist extension)", async () => {
    const req = await seedRequest({
      organizationId: ORG_A,
      providerEntityId: providerA,
      locationId: locationA,
      membershipId: memberA,
      status: "delivered",
    });
    const actor = actorFor(ORG_A, USER_A, memberA);

    await writeService.captureCaregiverSignature(actor, req.id, {
      expectedUpdatedAt: req.updatedAt,
      captureMethod: "typed_signature_in_app",
      typedSignatureName: "Dana Reyes",
    });

    const { rows } = await admin.query(
      `SELECT after FROM audit_event
         WHERE resource_kind='supply_request' AND resource_id=$1 AND event_type='supply_request.update'
         ORDER BY created_at DESC LIMIT 1`,
      [req.id],
    );
    expect(rows.length).toBe(1);
    const after = rows[0].after as Record<string, unknown>;
    // The row itself carries the real name (proven above); the AUDIT DIFF must not.
    expect(after.caregiver_signature_evidence_jsonb).toBe("<changed>");
  });
});
