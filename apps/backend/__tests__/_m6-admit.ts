// apps/backend/__tests__/_m6-admit.ts — main's M6 referral intake, for the live suites that need an admission.
//
// The live suites written before main's intake rework drove `createReferral → triageReferral →
// acceptReferral(ifVersion 1)`. Main's referral state machine is received → under_review (triage) →
// qualified (`qualifyReferral`) → converted (`acceptReferral`), and `acceptReferral` refuses anything but
// `qualified` ("must be triaged before it can be accepted"). Qualification is blocker-gated
// (`qualificationBlockers`): a resolved M5 patient, a clinical indication, and referral-source info. The
// conversion then confirms that patient through M5's `PatientIntakeResolver`, and activation readiness asks
// M5's `PatientAdmissionClearanceReader` — so the patient must be a real `patient` row and both seams bound.
//
// This is the same ceremony `m6-admission-write-lifecycle.live.test.ts` (`qualifiedReferral`) runs, plus the
// admission-details step (`updateAdmission` with an admission date), which readiness requires before activation.
import type { DbClient } from "@chartwarden/db";
import type { Client } from "pg";
import { registerSeam } from "../src/bootstrap/seams/registry";
import { buildPatientAdmissionClearanceReader } from "../src/modules/05-patient/admission-clearance-reader";
import { createDbPatientIntakeResolver } from "../src/modules/05-patient/seams/patient-intake-resolver";
import type { createDbAdmissionRouteService } from "../src/modules/06-admission/admission-route-service-db";
import { registerMdmSeams } from "../src/modules/40-mdm/seams";

type AdmissionService = ReturnType<typeof createDbAdmissionRouteService>;

/**
 * Bind the two M5 seams M6 intake consults, over the given (app-role) Drizzle handle — exactly the pair
 * production boot's `registerPatientSeams` binds for M6 — plus M40's MDM seams over an empty store. Only
 * these, so a suite's own registrations of the other M5 seams (caseload, care team, reader, mutator) are
 * left untouched.
 */
export function registerM5IntakeSeams(db: DbClient): void {
  registerSeam("PatientIntakeResolver", createDbPatientIntakeResolver(db));
  registerSeam("PatientAdmissionClearanceReader", buildPatientAdmissionClearanceReader(db));
  // Reading an admission resolves its hospice physician through M40; an empty in-memory MDM store
  // answers null (unknown physician), which the read tolerates.
  registerMdmSeams();
}

/** Seed (as superuser) the canonical M5 patient a referral resolves to. Idempotent on the id. */
export async function seedM5Patient(
  admin: Client,
  organizationId: string,
  patientId: string,
): Promise<void> {
  await admin.query(
    `INSERT INTO patient (id, organization_id, mrn, legal_first_name, legal_last_name, dob,
       sex_assigned_at_birth, status)
     VALUES ($1,$2,$3,'Test','Patient','1950-01-01','F','active')
     ON CONFLICT (id) DO NOTHING`,
    [patientId, organizationId, `MRN-${patientId}`],
  );
}

/**
 * Referral → triage → qualify → accept → admission details, through the production write service.
 * Returns the new admission's id. Seeds the M5 patient first; the caller must have run
 * `registerM5IntakeSeams` (or production's `registerPatientSeams`) in its `beforeAll`.
 */
export async function admitViaQualifiedReferral(
  svc: AdmissionService,
  admin: Client,
  opts: {
    organizationId: string;
    actorUserId: string;
    patientId: string;
    primaryDiagnosisIcd10?: string;
    source?: string;
    patientNameAtReceipt?: string;
    /** The admission's hospice physician; CTI draft and sign require it to match the CTI's hospice MD. */
    hospicePhysicianId?: string;
    /** Defaults to 2026-01-01 — before every fixed discharge date the suites use (a discharge may not
     *  precede the admission date). */
    admissionAt?: string;
  },
): Promise<{ admissionId: string }> {
  const { organizationId: org, actorUserId: user, patientId } = opts;
  await seedM5Patient(admin, org, patientId);
  const ref = await svc.createReferral(
    org,
    {
      source: opts.source ?? "phone",
      receivedAt: new Date().toISOString(),
      receivingUserId: user,
      patientNameAtReceipt: opts.patientNameAtReceipt ?? "P",
      patientId,
      referrerName: "Dr. Referrer",
      referringDxText: "Metastatic NSCLC",
    } as never,
    user,
  );
  await svc.triageReferral(org, ref.id, "eligible", 0); // → under_review, v1
  await svc.qualifyReferral(org, ref.id, 1, user); // → qualified, v2
  const { admissionId } = await svc.acceptReferral(
    org,
    ref.id,
    { primaryDiagnosisIcd10: opts.primaryDiagnosisIcd10 ?? "C34.90", patientId },
    2,
    user,
  );
  // Admission details: the admission date is the readiness gate's `admission_details` requirement; the
  // hospice physician is what CTI draft/sign check the CTI's hospice MD against.
  const { rows } = await admin.query("SELECT version FROM admission WHERE id=$1", [admissionId]);
  await svc.updateAdmission(
    org,
    admissionId,
    {
      admissionAt: opts.admissionAt ?? "2026-01-01T00:00:00.000Z",
      ...(opts.hospicePhysicianId ? { hospicePhysicianId: opts.hospicePhysicianId } : {}),
    },
    Number(rows[0].version),
  );
  return { admissionId };
}
