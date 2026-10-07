// apps/backend/src/modules/30-quality/routes/provider-entity-for-subject.ts — GAP-154.
//
// M30's provider-scoped writes used to be stamped with the org's "primary" provider entity. In a multi-CCN org
// that merges outbreak clustering across CCNs and attributes every result to one CCN. A patient-linked write
// now derives its provider entity from the SUBJECT (the patient's active admission, via an injected,
// org-explicit M6 seam port — M30's manifest does not depend on M6). Subject-less writes, and patients with no
// sited active admission, keep the primary-entity behaviour (never a guess from the request body).
/** The provider-entity port: the org's primary entity + the optional subject-derived entity. */
export interface SubjectProviderEntityPort<Tx = unknown> {
  primaryProviderEntityId(tx: Tx, organizationId: string): Promise<string>;
  /** The provider entity of the patient's active, sited admission, or null when there is none. */
  providerEntityIdForPatient?(organizationId: string, patientId: string): Promise<string | null>;
}

export async function resolveProviderEntityForSubject<Tx>(
  port: SubjectProviderEntityPort<Tx>,
  tx: Tx,
  organizationId: string,
  patientId: string | null | undefined,
): Promise<string> {
  if (patientId && port.providerEntityIdForPatient) {
    const subjectEntity = await port.providerEntityIdForPatient(organizationId, patientId);
    if (subjectEntity) return subjectEntity;
  }
  return port.primaryProviderEntityId(tx, organizationId);
}
