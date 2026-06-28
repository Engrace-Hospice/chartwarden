// @wardenx/quality — consumed-seam view of M5 (Patient). PRESENT producer (§4.4).
//
// M30 reads `PatientHeaderReader.minimalForQualityContext` ONLY — the decedent display name + date of
// death used to label mortality reviews and CAHPS decedent samples. It does NOT read addresses, payer
// detail, or full privacy-flag context. Bound to the live M5 reader via `getSeam` at boot (P2C);
// consumer-defined interface — no import of M5's package or schema.
export interface QualityPatientConsumer {
  /**
   * M5 `PatientHeaderReader.minimalForQualityContext` — the minimal decedent context (display name +
   * date of death) for a mortality-review / CAHPS-sample label, or `null` if the patient is unknown to
   * the caller's org scope. PHI-minimal by contract (no payer / address / privacy detail crosses).
   */
  minimalForQualityContext(
    organizationId: string,
    patientId: string,
  ): Promise<{ displayName: string; dateOfDeath: string | null } | null>;
}
