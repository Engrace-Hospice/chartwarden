// M36 WP 5.7 (ADR-0089, PROPOSED) - the artefact reader the download route calls (B1's `ExportArtefactReader`): load the ciphertext, unwrap the
// job's data key under the tenant KEK, decrypt, verify the recorded sha256. Fails closed: no wrapped key (expired), a missing object, a bad
// envelope or a digest mismatch all throw, and the download then returns no bytes and records no trail row. Errors carry no content.
import { ExportCryptoError, type ExportKeyWrap, openArtefact, sha256Hex } from "./export-crypto";
import type { ExportArtefactReader } from "./export-ports";

/** The stored object's bytes; null when it is gone. Bound over the M36 attachment storage port at the composition root. */
export type ExportObjectGet = (args: {
  readonly organizationId: string;
  readonly objectKey: string;
}) => Promise<Uint8Array | null>;

export function createExportArtefactReader(deps: {
  readonly get: ExportObjectGet;
  readonly keys: Pick<ExportKeyWrap, "unwrap">;
}): ExportArtefactReader {
  return async (job) => {
    if (!job.wrappedDek) throw new ExportCryptoError("export: the artefact key is gone (expired)");
    const stored = await deps.get({
      organizationId: job.organizationId,
      objectKey: job.artefactKey,
    });
    if (!stored) throw new ExportCryptoError("export: the artefact object is missing");
    const dek = await deps.keys.unwrap(job.organizationId, job.wrappedDek);
    try {
      const plaintext = openArtefact(stored, dek, {
        organizationId: job.organizationId,
        jobId: job.jobId,
      });
      if (sha256Hex(plaintext) !== job.artefactSha256) {
        throw new ExportCryptoError("export: the artefact digest does not match");
      }
      return plaintext;
    } finally {
      dek.fill(0);
    }
  };
}
