/**
 * COP27 API seed — demo patients and the referral-only scenario.
 *
 * A demo patient's legal LAST NAME is its marker (`DEMO-COP27-03`) — obviously fake on every census, chart
 * header and claim preview — and the marker is also recorded as a `hospice_external` identifier. (The MRN
 * itself cannot carry the prefix: M5 assigns it at creation and it is immutable.)
 *
 * Two ways a demo patient is born, matching how the platform lets each account find it again:
 *   · through intake — a referral (external id = the marker) → create-patient → triage → qualify → accept,
 *     which opens the admission. The referral worklist is readable by the admin, so the patient and its
 *     admission are re-found from the referral on every run without any patient-census access.
 *   · directly (`POST /patients`) — for transfer-ins, which the referral conversion cannot express. A patient
 *     created this way is only re-findable by an account with org-wide patient scope (a medical director), so
 *     the direct path is refused up front without one: creating a patient nobody can find again would
 *     duplicate it on the next run.
 */
import type { SeedContext } from "./context";
import { asAnyone, must, readAsAnyone } from "./http";
import type { ScenarioRun } from "./run";

export const IDENTIFIER_ISSUER = "WardenX COP27 demo seed (not a real patient)";

export interface DemoPatientSpec {
  /** `DEMO-COP27-NN` — also the legal last name. */
  readonly marker: string;
  readonly firstName: string;
  readonly dob: string;
  readonly sex: "female" | "male";
}

export interface DemoPatient {
  readonly id: string;
  readonly marker: string;
  readonly displayName: string;
}

interface ReferralDetail {
  id: string;
  status: string;
  version: number;
  patientId: string | null;
  patientNameAtReceipt: string;
  externalReferralId: string | null;
  convertedAdmissionId: string | null;
}

async function findReferral(ctx: SeedContext, marker: string): Promise<ReferralDetail | null> {
  const page = await must<{ items: Array<{ id: string; patientNameAtReceipt: string }> }>(
    "search referrals",
    ctx.admin.client.GET("/api/v1/referrals", {
      params: { query: { q: marker, includeConverted: true, limit: 50 } },
    }),
  );
  const hit = page.items.find((r) => r.patientNameAtReceipt.endsWith(marker));
  if (!hit) return null;
  return must<ReferralDetail>(
    "read referral",
    ctx.admin.client.GET("/api/v1/referrals/{id}", { params: { path: { id: hit.id } } }),
  );
}

async function createReferral(
  ctx: SeedContext,
  spec: DemoPatientSpec,
  name: string,
  dxText: string,
): Promise<ReferralDetail> {
  const created = await must<{ id: string }>(
    "create referral",
    ctx.admin.client.POST("/api/v1/referrals", {
      body: {
        source: "physician_office",
        receivedAt: new Date().toISOString(),
        patientNameAtReceipt: name,
        patientDobAtReceipt: spec.dob,
        sexAssignedAtBirth: spec.sex === "female" ? "F" : "M",
        referringDxText: `DEMO DATA — ${dxText}`,
        referrerName: "Dr. Demo Referrer (fictional)",
        referrerOrganization: "Demo Community Clinic (fictional)",
        referrerPhone: "555-0100",
        externalReferralId: spec.marker,
      },
    }),
  );
  return must<ReferralDetail>(
    "read referral",
    ctx.admin.client.GET("/api/v1/referrals/{id}", { params: { path: { id: created.id } } }),
  );
}

/** Scenario 1 — a referral left in the intake inbox; no patient, no admission. */
export async function ensureReferralOnly(
  run: ScenarioRun,
  ctx: SeedContext,
  spec: DemoPatientSpec,
): Promise<void> {
  const referral = await run.ensure(
    "referral",
    () => findReferral(ctx, spec.marker),
    () =>
      createReferral(
        ctx,
        spec,
        `${spec.firstName} ${spec.marker}`,
        "end-stage heart failure (NYHA IV), two admissions in 60 days; family requests a hospice evaluation.",
      ),
    (r) => `referral ${r.id} (${r.status})`,
  );
  await run.soft(
    "referral note",
    async () => {
      const notes = await must<{ items: Array<{ content: string }> }>(
        "list referral notes",
        ctx.admin.client.GET("/api/v1/referrals/{id}/notes", {
          params: { path: { id: referral.id } },
        }),
      );
      return notes.items.some((n) => n.content.includes(spec.marker)) ? true : null;
    },
    async () => {
      await must(
        "add referral note",
        ctx.admin.client.POST("/api/v1/referrals/{id}/notes", {
          params: { path: { id: referral.id } },
          body: {
            content: `${spec.marker}: demo referral — call the family to schedule an informational visit.`,
          },
        }),
      );
      return true;
    },
  );
}

export interface IntakePatient {
  readonly patient: DemoPatient;
  readonly admissionId: string;
}

/** Intake path: referral → patient → triage → qualify → accept (opens the admission). */
export async function ensureIntakePatient(
  run: ScenarioRun,
  ctx: SeedContext,
  spec: DemoPatientSpec,
): Promise<IntakePatient> {
  const name = `${spec.firstName} ${spec.marker}`;
  let referral = await run.ensure(
    "referral",
    () => findReferral(ctx, spec.marker),
    () =>
      createReferral(
        ctx,
        spec,
        name,
        "metastatic lung cancer, declining function; hospice election discussed.",
      ),
    (r) => `referral ${r.id} (${r.status})`,
  );
  const reload = async (): Promise<ReferralDetail> => {
    const r = await findReferral(ctx, spec.marker);
    if (!r) throw new Error(`referral for ${spec.marker} disappeared`);
    return r;
  };
  referral = await run.ensure(
    "patient (from referral)",
    async () => (referral.patientId ? referral : null),
    async () => {
      await must(
        "create patient from referral",
        ctx.admin.client.POST("/api/v1/referrals/{id}/create-patient", {
          params: { path: { id: referral.id } },
          body: { ifVersion: referral.version },
        }),
      );
      return reload();
    },
    (r) => `patient ${r.patientId}`,
  );
  const advance = async (
    step: string,
    done: (r: ReferralDetail) => boolean,
    write: (r: ReferralDetail) => Promise<unknown>,
  ): Promise<void> => {
    referral = await run.ensure(
      step,
      async () => (done(referral) ? referral : null),
      async () => {
        await write(referral);
        return reload();
      },
      (r) => r.status,
    );
  };
  await advance(
    "referral triaged eligible",
    (r) => r.status !== "received",
    (r) =>
      must(
        "triage referral",
        ctx.admin.client.POST("/api/v1/referrals/{id}/triage", {
          params: { path: { id: r.id } },
          body: {
            outcome: "eligible",
            notes: "DEMO DATA — meets hospice eligibility on review.",
            ifVersion: r.version,
          },
        }),
      ),
  );
  await advance(
    "referral qualified",
    (r) => r.status === "qualified" || r.status === "converted",
    (r) =>
      must(
        "qualify referral",
        ctx.admin.client.POST("/api/v1/referrals/{id}/qualify", {
          params: { path: { id: r.id } },
          body: { ifVersion: r.version },
        }),
      ),
  );
  await advance(
    "referral accepted (admission opened)",
    (r) => r.convertedAdmissionId !== null,
    (r) =>
      must(
        "accept referral",
        ctx.admin.client.POST("/api/v1/referrals/{id}/accept", {
          params: { path: { id: r.id } },
          body: {
            primaryDiagnosisIcd10: "C34.90",
            ...(ctx.attending ? { attendingPhysicianId: ctx.attending.id } : {}),
            ifVersion: r.version,
          },
        }),
      ),
  );
  const patientId = referral.patientId;
  const admissionId = referral.convertedAdmissionId;
  if (!patientId || !admissionId)
    throw new Error(`referral ${referral.id} has no patient/admission`);
  const patient = { id: patientId, marker: spec.marker, displayName: name };
  await ensureMarkerIdentifier(run, ctx, patient);
  return { patient, admissionId };
}

interface PatientListItem {
  id: string;
  lastName: string;
  firstName: string;
}

/** Find a directly-created demo patient with whichever account has census scope over it. */
async function searchPatient(ctx: SeedContext, marker: string): Promise<DemoPatient | null> {
  for (const s of ctx.sessions) {
    const page = await must<{ items: PatientListItem[] }>(
      "search patients",
      s.client.GET("/api/v1/patients", { params: { query: { q: marker, limit: 20 } } }),
    );
    const hit = page.items.find((p) => p.lastName === marker);
    if (hit) return { id: hit.id, marker, displayName: `${hit.firstName} ${hit.lastName}` };
  }
  return null;
}

/** Direct path (transfer-ins): `POST /patients`, only when an org-wide-scope account can re-find it. */
export async function ensureDirectPatient(
  run: ScenarioRun,
  ctx: SeedContext,
  spec: DemoPatientSpec,
): Promise<DemoPatient> {
  const physician = ctx.physician;
  if (!physician) {
    run.stop(
      "patient",
      "a transfer-in patient is created directly and can only be re-found by an account with org-wide patient scope (medical_director); none is available, so it is not created (it would be duplicated on the next run)",
    );
  }
  const patient = await run.ensure(
    "patient",
    () => searchPatient(ctx, spec.marker),
    async () => {
      await asAnyone("create patient", [physician], (s) =>
        s.client.POST("/api/v1/patients", {
          body: {
            lastName: spec.marker,
            firstName: spec.firstName,
            dob: spec.dob,
            administrativeSex: spec.sex,
            primaryAddress: demoAddress(ctx),
            bypassMatchReview: true,
          },
        }),
      );
      const created = await searchPatient(ctx, spec.marker);
      if (!created) throw new Error(`patient ${spec.marker} not found after create`);
      return created;
    },
    (p) => `patient ${p.id}`,
  );
  await ensureMarkerIdentifier(run, ctx, patient);
  return patient;
}

function demoAddress(ctx: SeedContext): { line1: string; city: string; postalCode: string } {
  const loc = ctx.location?.address;
  return {
    line1: "1 Demo Data Way (fictional)",
    city: loc?.city ?? "Asheville",
    postalCode: loc?.postalCode ?? "28801",
  };
}

async function ensureMarkerIdentifier(
  run: ScenarioRun,
  ctx: SeedContext,
  patient: DemoPatient,
): Promise<void> {
  await run.soft(
    "marker identifier",
    async () => {
      const ids = await readAsAnyone<{
        identifiers: Array<{ kind: string; value: string | null }>;
      }>("list identifiers", ctx.sessions, (s) =>
        s.client.GET("/api/v1/patients/{id}/identifiers", { params: { path: { id: patient.id } } }),
      );
      return ids?.identifiers.some(
        (i) => i.kind === "hospice_external" && i.value === patient.marker,
      )
        ? true
        : null;
    },
    async () => {
      await asAnyone("add marker identifier", ctx.sessions, (s) =>
        s.client.POST("/api/v1/patients/{id}/identifiers", {
          params: { path: { id: patient.id } },
          body: { kind: "hospice_external", value: patient.marker, issuer: IDENTIFIER_ISSUER },
        }),
      );
      return true;
    },
    () => `hospice_external=${patient.marker}`,
  );
}
