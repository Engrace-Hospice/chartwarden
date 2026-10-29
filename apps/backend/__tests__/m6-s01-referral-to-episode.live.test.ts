/**
 * S01 (clinical workflow audit 2026-10-28, §5): new referral → duplicate detection → election → admission →
 * episode, over real Postgres as the NOBYPASSRLS `chartwarden_app` role with the catalog-validating outbox.
 *
 *   1. Duplicate detection (M5 admit): exact → hard block (no second patient), near-match → soft review with
 *      an open `patient_match_review`, same MBI → blocked, a cross-tenant twin is NOT matched against (and so
 *      never disclosed), an authorised bypass leaves a CRITICAL audit row carrying actor / reason / patient /
 *      timestamp. The ROUTE gate on the bypass (`patient.create_bypass_match` + step-up → 403) is proven by
 *      `patient-routes.test.ts` (GAP-009); this suite proves what happens once past it, against the DB.
 *   2. Invalid transitions are typed and preserve state: a referral that is not `qualified` cannot convert, and
 *      an admission without a signed election + CTI cannot activate.
 *   3. The happy path ends in exactly one authoritative active episode (one admission, one benefit period), and
 *      a second election for the same patient is refused with a typed 409.
 *
 *   CHARTWARDEN_TEST_DATABASE_URL=postgres://… bun run test:m6:s01:live
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Journey, MD, ORG, ORG_B, USER, bootJourney } from "./_m6-journey";

const DB_URL = process.env.CHARTWARDEN_TEST_DATABASE_URL;
const MBI_A = "4KM5PN7QR28";
const JANE = {
  lastName: "Doe",
  firstName: "Jane",
  dob: "1950-01-01",
  administrativeSex: "female",
  primaryAddress: { line1: "1 Main St", city: "Austin", state: "TX", postalCode: "78701" },
};

describe.skipIf(!DB_URL)(
  "S01 referral → duplicate detection → election → admission → episode — LIVE",
  () => {
    let j: Journey;
    let janeId: string;

    beforeAll(async () => {
      j = await bootJourney(DB_URL as string, "s01");
    }, 240_000);
    afterAll(async () => {
      await j?.close();
    });

    const patientCount = async (org = ORG): Promise<number> =>
      Number(
        (
          await j.one<{ n: number }>(
            "SELECT count(*)::int AS n FROM patient WHERE organization_id=$1",
            [org],
          )
        ).n,
      );

    describe("duplicate detection", () => {
      it("a new referral's patient is admitted once (created, prospective, mrn identifier)", async () => {
        const out = await j.patients.admit(
          ORG,
          { ...JANE, mbi: MBI_A, phone: "512-555-0142", email: "jane.doe@example.test" },
          USER,
        );
        expect(out.outcome).toBe("created");
        janeId = (out as { patientId: string }).patientId;
        const p = await j.one<{ status: string; mrn: string }>(
          "SELECT status, mrn FROM patient WHERE id=$1",
          [janeId],
        );
        expect(p.status).toBe("prospective");
        const ids = await j.rows<{ kind: string }>(
          "SELECT kind FROM patient_identifier WHERE patient_id=$1",
          [janeId],
        );
        expect(ids.map((r) => r.kind).sort()).toEqual(["mbi", "mrn"]);
      });

      it("an exact duplicate is a hard block and creates no patient or review row", async () => {
        const before = await patientCount();
        const out = await j.patients.admit(ORG, JANE, USER);
        expect(out).toMatchObject({ outcome: "hard_block", existingPatientId: janeId });
        expect(await patientCount()).toBe(before);
      });

      it("the same MBI under a different name is blocked, not silently admitted", async () => {
        const before = await patientCount();
        const out = await j.patients.admit(
          ORG,
          {
            lastName: "Roe",
            firstName: "Richard",
            dob: "1951-02-02",
            administrativeSex: "male",
            mbi: MBI_A,
          },
          USER,
        );
        expect(out.outcome).not.toBe("created");
        expect(await patientCount()).toBe(before + (out.outcome === "soft_review" ? 1 : 0));
      });

      it("a near-match (same name+DOB, new address, same contact) opens an open soft review", async () => {
        const out = await j.patients.admit(
          ORG,
          {
            ...JANE,
            primaryAddress: {
              line1: "999 Elsewhere Blvd",
              city: "Austin",
              state: "TX",
              postalCode: "78799",
            },
            phone: "512-555-0142",
            email: "jane.doe@example.test",
          },
          USER,
        );
        expect(out.outcome).toBe("soft_review");
        const pid = (out as { patientId: string }).patientId;
        const reviews = await j.rows<{ status: string }>(
          "SELECT status FROM patient_match_review WHERE new_patient_id=$1",
          [pid],
        );
        expect(reviews.length).toBeGreaterThan(0);
        expect(reviews.every((r) => r.status === "open")).toBe(true);
      });

      it("cross-tenant: org B admitting the same person is created, matches nothing, and never sees org A's patient", async () => {
        const before = await patientCount(ORG);
        const out = await j.patients.admit(ORG_B, { ...JANE, mbi: MBI_A }, USER);
        expect(out.outcome).toBe("created");
        expect(JSON.stringify(out)).not.toContain(janeId);
        const bId = (out as { patientId: string }).patientId;
        expect(await patientCount(ORG)).toBe(before);
        const reviews = await j.rows(
          "SELECT 1 FROM patient_match_review WHERE organization_id=$1 OR new_patient_id=$2",
          [ORG_B, bId],
        );
        expect(reviews).toEqual([]);
      });

      it("an authorised bypass creates the patient and leaves a CRITICAL audit row (actor, reason, patient, time)", async () => {
        const justification = "Legitimate twin admission, confirmed with registrar";
        const t0 = Date.now() - 5_000;
        const out = await j.patients.admit(
          ORG,
          { ...JANE, bypassMatchReview: true, bypassJustification: justification },
          USER,
        );
        expect(out.outcome).toBe("created");
        const pid = (out as { patientId: string }).patientId;
        expect(pid).not.toBe(janeId);
        const audit = await j.rows<{
          severity: string;
          actor_user_id: string;
          context: Record<string, unknown>;
          created_at: Date;
        }>(
          `SELECT severity, actor_user_id, context, created_at FROM audit_event
          WHERE event_type='patient.create_bypass_match' AND resource_id=$1`,
          [pid],
        );
        expect(audit).toHaveLength(1);
        expect(audit[0]?.severity).toBe("critical");
        expect(audit[0]?.actor_user_id).toBe(USER);
        expect(audit[0]?.context).toMatchObject({ patientId: pid, byUserId: USER, justification });
        expect(new Date(audit[0]?.created_at as Date).getTime()).toBeGreaterThan(t0);
      });

      it("without the bypass flag no audit row is written and the duplicate pipeline still runs", async () => {
        const n = (
          await j.one<{ n: number }>(
            "SELECT count(*)::int AS n FROM audit_event WHERE event_type='patient.create_bypass_match'",
          )
        ).n;
        const out = await j.patients.admit(ORG, JANE, USER);
        expect(out.outcome).not.toBe("created");
        expect(
          (
            await j.one<{ n: number }>(
              "SELECT count(*)::int AS n FROM audit_event WHERE event_type='patient.create_bypass_match'",
            )
          ).n,
        ).toBe(n);
      });
    });

    describe("election → admission → episode", () => {
      it("a referral that is not qualified cannot convert; nothing is created and the referral is unchanged", async () => {
        const patientId = await j.newPatient();
        const ref = await j.svc.createReferral(
          ORG,
          {
            source: "phone",
            receivedAt: new Date().toISOString(),
            receivingUserId: USER,
            patientNameAtReceipt: "P",
            patientId,
            referrerName: "Dr. Referrer",
            referringDxText: "Metastatic NSCLC",
          } as never,
          USER,
        );
        await expect(
          j.svc.acceptReferral(
            ORG,
            ref.id,
            { primaryDiagnosisIcd10: "C34.90", patientId } as never,
            0,
            USER,
          ),
        ).rejects.toMatchObject({ statusCode: expect.any(Number) });
        const after = await j.one<{ state: string }>(
          "SELECT status AS state FROM referral WHERE id=$1",
          [ref.id],
        );
        expect(after.state).toBe("received");
        expect(await j.rows("SELECT 1 FROM admission WHERE patient_id=$1", [patientId])).toEqual(
          [],
        );
      });

      it("an admission without a signed election and CTI cannot activate, and stays exactly as it was", async () => {
        const patientId = await j.newPatient();
        const admissionId = await j.admit(patientId);
        const nor = await j.svc.acknowledgeNor(
          ORG,
          admissionId,
          { deliveryMethod: "electronic_witnessed", acknowledgedByRole: "patient" },
          USER,
        );
        const before = await j.one<{ status: string; version: string }>(
          "SELECT status, version FROM admission WHERE id=$1",
          [admissionId],
        );
        await expect(j.svc.activateAdmission(ORG, admissionId, nor.version)).rejects.toMatchObject({
          code: "ADMISSION_NOT_READY",
          statusCode: 412,
          missing: ["election_signed", "cti_signed"],
        });
        const after = await j.one<{ status: string; version: string; activated_at: Date | null }>(
          "SELECT status, version, activated_at FROM admission WHERE id=$1",
          [admissionId],
        );
        expect({ status: after.status, version: after.version }).toEqual(before);
        expect(after.activated_at).toBeNull();
      });

      it("referral → qualified → NOR → election → CTI → activation yields exactly one active episode", async () => {
        const patientId = await j.newPatient();
        const admissionId = await j.admit(patientId);
        await j.completeAndActivate(admissionId);

        const adm = await j.one<{ status: string; activated_at: Date | null }>(
          "SELECT status, activated_at FROM admission WHERE id=$1",
          [admissionId],
        );
        expect(adm.status).toBe("active");
        expect(adm.activated_at).not.toBeNull();
        const open = await j.rows(
          "SELECT id FROM admission WHERE patient_id=$1 AND status NOT IN ('discharged','bereavement','closed')",
          [patientId],
        );
        expect(open).toHaveLength(1);
        const periods = await j.rows<{ sequence_number: number; status: string }>(
          "SELECT sequence_number, status FROM election_period WHERE admission_id=$1",
          [admissionId],
        );
        expect(periods).toHaveLength(1);
        expect(periods[0]?.sequence_number).toBe(1);
        const ref = await j.one<{ state: string }>(
          "SELECT status AS state FROM referral WHERE id=(SELECT referral_id FROM admission WHERE id=$1)",
          [admissionId],
        );
        expect(ref.state).toBe("converted");

        // A second election for the same patient is a typed 409, with no extra admission or period.
        await expect(
          j.svc.createAdmission(
            ORG,
            { patientId, intakeMethod: "in_person", hospiceMedicalDirectorId: MD },
            USER,
          ),
        ).rejects.toMatchObject({ code: "PATIENT_ALREADY_ELECTED", statusCode: 409 });
        expect(
          await j.rows("SELECT 1 FROM admission WHERE patient_id=$1", [patientId]),
        ).toHaveLength(1);
      });

      it("tenancy: another org can neither read nor activate the admission", async () => {
        const patientId = await j.newPatient();
        const admissionId = await j.admit(patientId);
        expect(await j.svc.getAdmission(ORG_B, admissionId)).toBeNull();
        await expect(j.svc.activateAdmission(ORG_B, admissionId, 0)).rejects.toMatchObject({
          statusCode: expect.any(Number),
        });
        expect(
          (
            await j.one<{ status: string }>("SELECT status FROM admission WHERE id=$1", [
              admissionId,
            ])
          ).status,
        ).toBe("pending");
      });
    });
  },
);
