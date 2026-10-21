// @chartwarden/iqies-client — the MinIO envelope-storage convention (M10-T07, spec §4.10.1 / M10-F17 /
// SD-033/034). Submitted CMS HOPE envelopes are PHI-bearing XML subject to the CMS 10-year retention; they
// are stored under a declared per-tenant prefix with COMPLIANCE object-lock so no principal (including a
// platform admin) can overwrite or delete them before the retention period expires. This module owns the
// pure key-builder + the object-lock / lifecycle constants; the actual put/get goes through the M4
// audit-read proxy (presigned URL per read, architecture §8(3)). Pure: just string assembly + constants.

/** §4.10.1 object-lock + lifecycle policy for the per-tenant `iqies-envelopes/` prefix (SD-033/034). */
export const IQIES_ENVELOPE_OBJECT_LOCK = {
  /** WORM mode: prevents overwrite/delete by ANY principal until retention expires. */
  mode: "COMPLIANCE",
  /** 10 years (3650 days) from object creation — the CMS extended retention for submitted HOPE. */
  retentionDays: 3650,
  /** Lifecycle: 12 years (4380 days) total from creation, then permanent delete (2-year legal-hold buffer). */
  lifecycleExpirationDays: 4380,
  /** The bucket prefix the lifecycle rule + IAM policies are registered against. */
  lifecyclePrefix: "tenants/*/iqies-envelopes/",
} as const;

/**
 * `buildEnvelopeStorageUri` — the §4.10.1 per-tenant MinIO object key for one submitted envelope:
 *   `tenants/<org_id>/iqies-envelopes/<provider_entity_id>/<submission_period>/<submission_id>.xml.enc`
 * The `tenants/<org_id>/` prefix is the platform-standard per-tenant isolation (architecture §8(3)); the
 * `<provider_entity_id>/` sub-level lets IAM gate per-CCN; the `.xml.enc` suffix signals PHI-bearing,
 * SSE-encrypted at rest. The full key (not a presigned URL) is recorded in
 * `hope_submission.envelope_storage_uri`.
 */
export function buildEnvelopeStorageUri(input: {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly submissionPeriod: string;
  readonly submissionId: string;
}): string {
  return `tenants/${input.organizationId}/iqies-envelopes/${input.providerEntityId}/${input.submissionPeriod}/${input.submissionId}.xml.enc`;
}
