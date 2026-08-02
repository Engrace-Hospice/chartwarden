// @wardenx/fhir — the consumed reader-seam + domain-input contracts the R4 projections read (M28-T04).
//
// M28 owns no clinical PHI (§1.2); every resource is composed at read time from an OWNER module's data.
// The spec (§4.11.2) types the DiagnosticReport projector against `@wardenx/orders/seams`,
// `@wardenx/external-interfaces/seams`, etc. — but M28 stays a headless PURE core until T06 wires the
// real `SeamRegistry`, so like the T03 auth cores we keep these shapes LOCAL here (the M13 witness-token
// / M12 webhook idiom): the MINIMAL row/reader contracts the projections need, deps INJECTED, no cross-
// package import and no `dependsOn` edge added ahead of the T06 seam bind. T06 supplies real adapters
// that satisfy these interfaces; the projector never learns whether it's talking to a real reader or a
// test double.

// ── M11 order (the DiagnosticReport metadata source, D19) ──────────────────────────────────────────────

/** The subset of an M11 `order_record` a lab DiagnosticReport is projected from. */
export interface LabOrderRow {
  readonly id: string;
  readonly kind: string;
  readonly patientId: string;
  /** The M29 observation currently attached to this order; null ⇒ no result yet, no report exists. */
  readonly lastLabObservationAttachedId: string | null;
  readonly orderingPhysicianMdmId: string | null;
  readonly labDestinationFacilityId: string | null;
  readonly signedAt: string | null;
  readonly data?: {
    readonly observationIdentifier?: { readonly code: string; readonly text: string };
  } | null;
}

/** The M11 read seam. `findOrder` for the single-report read; `searchOrdersByPatient` for `?patient=`. */
export interface OrderProvider {
  findOrder(organizationId: string, orderId: string): Promise<LabOrderRow | null>;
  searchOrdersByPatient(
    organizationId: string,
    patientId: string,
    opts: { kind: string; limit: number; afterId?: string },
  ): Promise<ReadonlyArray<LabOrderRow>>;
}

// ── M29 lab observation (the result values source, D19) ────────────────────────────────────────────────

/** One measured value inside an M29 `lab_observation`. `sudRedactionStatus !== 'not_applicable'` marks
 *  the value as 42 CFR Part 2 SUD-class, which drives the D20 whole-report redaction. */
export interface LabObservationValueRow {
  readonly loincCode: string;
  readonly loincText: string;
  readonly numericValue: number | null;
  readonly unit: string | null;
  readonly stringValue: string | null;
  readonly criticalFlag: string | null;
  readonly abnormalFlag: string | null;
  readonly referenceRange: string | null;
  readonly sudRedactionStatus: string;
}

/** The subset of an M29 `lab_observation` the projector reads. */
export interface LabObservationRow {
  readonly id: string;
  readonly attachedAt: string;
  readonly values: ReadonlyArray<LabObservationValueRow>;
}

/** The M29 `LabObservationReader` consumed seam (§4.11.4). */
export interface LabObservationReader {
  loadById(organizationId: string, observationId: string): Promise<LabObservationRow | null>;
}

// ── M5 patient (the subject source) ────────────────────────────────────────────────────────────────────

/** The subset of an M5 patient row the projections need — only `id` for a reference, the full row for
 *  the Patient mapper. */
export interface PatientRow {
  readonly id: string;
  readonly mrn: string | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly middleName: string | null;
  readonly gender: "male" | "female" | "other" | "unknown" | null;
  readonly birthDate: string | null;
  readonly deceasedDateTime: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly addressLines: ReadonlyArray<string> | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly postalCode: string | null;
}

/** The M5 patient read seam. */
export interface PatientReader {
  findById(input: { organizationId: string; patientId: string }): Promise<PatientRow | null>;
}

// ── M40 MDM (performer references) ─────────────────────────────────────────────────────────────────────

/** The subset of an M40 external-physician row a `Practitioner/{id}` reference needs. */
export interface ExternalPhysicianRow {
  readonly id: string;
}

/** The M40 external-physician read seam. */
export interface ExternalPhysicianReader {
  findById(organizationId: string, mdmId: string): Promise<ExternalPhysicianRow | null>;
}

/** The subset of an M40 facility row an `Organization/{id}` reference needs. */
export interface FacilityRow {
  readonly id: string;
}

/** The M40 facility read seam. */
export interface FacilityReader {
  findById(organizationId: string, facilityId: string): Promise<FacilityRow | null>;
}
