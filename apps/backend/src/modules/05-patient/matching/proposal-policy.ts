// apps/backend/src/modules/05-patient/matching/proposal-policy.ts — the M29-proposal field policy
// (M5 D12, W-M5-17). The PatientMutator (T08) applies a field-level diff from an accepted M29 ADT
// proposal; THIS pure policy decides which fields may be written and which are stripped — defense in
// depth against a chatty partner's PID carrying sensitive identifiers (W-M5-17: ignore SSN even if
// the lab sends it). Co-located with the matcher because it is identifier-handling policy; T08 wires
// it into the mutator and emits `patient.updated` with the applied-field list + audits the stripped set.

/** Fields an M29 proposal may NEVER write (D12) — identifiers + status/merge transitions M5 owns. */
export const FORBIDDEN_PROPOSAL_FIELDS = [
  "mrn",
  "mbi",
  "ssn",
  "state_id",
  "status",
  "merged_into_id",
  "id",
  "organization_id",
] as const;

const FORBIDDEN = new Set<string>(FORBIDDEN_PROPOSAL_FIELDS);

/** The result of vetting a proposal patch: the fields that may be applied + those stripped (D12). */
export interface ProposalStripResult<T extends Record<string, unknown>> {
  /** The patch with forbidden fields removed — what the mutator may apply. */
  readonly applied: Partial<T>;
  /** The forbidden field names that were present and removed (audited; W-M5-17 `strippedFields`). */
  readonly stripped: readonly string[];
}

/**
 * Strip the D12-forbidden fields from an M29 proposal patch (W-M5-17). Returns the appliable subset
 * plus the stripped field names (for the audit row that helps ops spot chatty partners). Pure — no
 * DB write; the mutator (T08) applies `applied` and never touches `patient_identifier(kind='ssn')`
 * from this path, so an SSN on the wire is dropped, not persisted.
 */
export function stripForbiddenProposalFields<T extends Record<string, unknown>>(
  patch: T,
): ProposalStripResult<T> {
  const applied: Partial<T> = {};
  const stripped: string[] = [];
  for (const key of Object.keys(patch)) {
    if (FORBIDDEN.has(key)) stripped.push(key);
    else (applied as Record<string, unknown>)[key] = patch[key];
  }
  return { applied, stripped };
}
