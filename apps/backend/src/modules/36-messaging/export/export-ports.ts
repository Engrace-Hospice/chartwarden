// M36 WP 5.7 (ADR-0089, PROPOSED) - the ports the export request/decide/read side is built on. The artefact builder and the expiry sweep
// (export-builder / export-worker / export-expiry-sweep) own the other half of the lifecycle: approved -> building -> ready | failed -> expired.

/** What the reader needs to find and open one artefact. Everything comes off the job row; nothing is a client value. */
export interface ExportArtefactRef {
  readonly jobId: string;
  readonly organizationId: string;
  readonly artefactKey: string;
  /** The per-job data key wrapped by the tenant key (the reader unwraps it; null only after expiry, when the download is refused first). */
  readonly wrappedDek: string;
  readonly artefactSha256: string;
  readonly artefactBytes: number;
}

/**
 * Reads the artefact, decrypts it and returns the PLAINTEXT JSON document (manifest + messages). Supplied by the builder side (B2); the
 * download path calls it only for a ready, unexpired job whose requester is the caller. It must verify the sha256 and throw on any
 * mismatch or missing object: the download then fails closed (no trail row, no bytes).
 */
export type ExportArtefactReader = (job: ExportArtefactRef) => Promise<Buffer | Uint8Array>;

/** M1 flag reader (same shape as the break-glass one). Absent => the feature is off. */
export interface ExportFlagReader {
  forOrg(organizationId: string): Promise<Record<string, boolean>>;
}

/** Whether a user currently holds a permission key; rechecked where a decision or a download happens. Absent => nobody does (fail closed). */
export type ExportPermissionCheck = (
  organizationId: string,
  userId: string,
  permissionKey: string,
) => Promise<boolean>;

/**
 * The channel kinds a PATIENT scope exports. The store (request-time scope check) and the build store (channel lookup) both use this one list,
 * so a kind accepted at request is always built. The Part 2 gate is NOT tied to it: the builder gates every channel that names a subject patient.
 */
export const EXPORT_PATIENT_SCOPE_CHANNEL_KINDS = ["care_team"] as const;
