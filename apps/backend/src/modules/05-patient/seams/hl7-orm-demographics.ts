// apps/backend/src/modules/05-patient/seams/hl7-orm-demographics.ts — the M5-owned, org-explicit read the
// M11 outbound-lab-ORM producer needs (F-178, #248). Same reason as `dosespotSyncDemographicsForOrg`:
// `patient_address` / `patient_privacy_flag_snapshot` are M5-owned, M11's manifest `dependsOn` is
// `[1, 6, 36, 38, 40]` (no edge to 5), so M11 reads them through THIS function, injected as a port at the
// composition root — never a schema import (`arch:tables` / `arch:boundaries`).
//
// UNLIKE the `...ForOrg` siblings this runs on the CALLER'S transaction (`tx`), not its own
// `withOrgContext`: M11 gathers these facts inside the very sign transaction that publishes the event, and a
// second pooled connection held open beside the sign tx would risk pool exhaustion for no isolation gain (the
// tx already carries `app.org_id`; the explicit `organization_id` predicate below is defense in depth, exactly
// like every other org-explicit read here).
//
// PHI DISCIPLINE (F-035 D3, 42 CFR Part 2): this returns the MINIMUM an HL7 ORM^O01 PID segment carries — the
// spine's name / DOB / sex code / MRN plus the primary CURRENT address. Never SSN, MBI, phone, email, race,
// ethnicity or any identifier beyond the MRN. `sudRestricted` is FAIL-CLOSED: it is true whenever the patient's
// privacy-flag snapshot lists `sud`, INCLUDING a snapshot marked invalidated — an invalidated snapshot is stale,
// and "stale" is not evidence the restriction lapsed. The caller REFUSES to disclose a `sudRestricted` patient
// to an outside lab; it must never assert `false` on the strength of an absent/stale row alone.
import { type DbClient, schema } from "@wardenx/db";
import { and, eq, isNull } from "drizzle-orm";

/** What `hl7OrmDemographicsInTx` hands back. `null` from the function = no such patient in this org. */
export interface Hl7OrmDemographics {
  readonly patientId: string;
  readonly mrn: string;
  /** The assigning authority for the INTERNAL MRN. M5 stores no issuer for it (`patient_identifier.issuer`
   *  is NULL for kind='mrn'), and the MRN is unique per organization (`patient_mrn_org_unique`), so the
   *  namespace that assigned it is the tenant itself: `WARDENX-<organizationId>`. A namespace label, not a
   *  demographic fact. */
  readonly mrnAssigningAuthority: string;
  readonly familyName: string;
  readonly givenName: string;
  /** ISO `yyyy-mm-dd`. */
  readonly dateOfBirth: string;
  /** The raw `patient.sex_assigned_at_birth` code (`M`/`F`/`U`/`O`/`UNK`, or a spelled-out / SNOMED value an
   *  ingest may have written). Mapping to HL7 table 0001 — and REFUSING the unmappable — is the caller's job. */
  readonly sexCode: string;
  /** `patient.status` — the caller refuses a `merged` spine (identity is ambiguous). */
  readonly status: string;
  /** Primary CURRENT address, or `null` when none is recorded (the ORM omits PID-11 rather than inventing one). */
  readonly address: {
    readonly line1: string;
    readonly city: string;
    readonly state: string | null;
    readonly postalCode: string;
  } | null;
  /** True when the privacy-flag snapshot lists `sud` (fail-closed — see the header). */
  readonly sudRestricted: boolean;
}

export async function hl7OrmDemographicsInTx(
  tx: DbClient,
  organizationId: string,
  patientId: string,
): Promise<Hl7OrmDemographics | null> {
  const P = schema.patients;
  const PA = schema.patientAddresses;
  const S = schema.patientPrivacyFlagSnapshots;

  const [patient] = await tx
    .select()
    .from(P)
    .where(and(eq(P.organizationId, organizationId), eq(P.id, patientId)))
    .limit(1);
  if (!patient) return null;

  const [address] = await tx
    .select()
    .from(PA)
    .where(
      and(
        eq(PA.organizationId, organizationId),
        eq(PA.patientId, patientId),
        eq(PA.isPrimary, true),
        isNull(PA.effectiveTo),
      ),
    )
    .limit(1);

  const [snapshot] = await tx
    .select({ flags: S.flags })
    .from(S)
    .where(and(eq(S.organizationId, organizationId), eq(S.patientId, patientId)))
    .limit(1);

  return {
    patientId: patient.id,
    mrn: patient.mrn,
    mrnAssigningAuthority: `WARDENX-${organizationId}`,
    familyName: patient.legalLastName,
    givenName: patient.legalFirstName,
    dateOfBirth: patient.dob,
    sexCode: patient.sexAssignedAtBirth,
    status: patient.status,
    address: address
      ? {
          line1: address.line1,
          city: address.city,
          state: address.state ?? null,
          postalCode: address.postalCode,
        }
      : null,
    sudRestricted: (snapshot?.flags ?? []).includes("sud"),
  };
}
