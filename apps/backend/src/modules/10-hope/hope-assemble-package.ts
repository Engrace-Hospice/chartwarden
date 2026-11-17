// apps/backend/src/modules/10-hope/hope-assemble-package.ts — the package bytes and the stored report of ONE `assembleSubmission`.
//
// Built from the serialised records BEFORE the share locks are taken (the CRC of every entry and the base64 of the whole ZIP are
// CPU work on multi-MB buffers: under the locks they would hold a correction's signature back for as long as they take), and
// built again only when the re-judgement under the lock dropped a record, so the package holds exactly the records that were
// packaged. The result is pure data: the caller writes it.
import type { SerializedHopeXml } from "./hope-cms-xml-serializer";
import { type BuiltZip, buildDeterministicZip } from "./hope-zip";

export interface AssemblePackage {
  readonly zip: BuiltZip;
  /** What `hope_submission.acceptance_report` holds for a packaged batch: the ZIP as base64 and the files in it. */
  readonly acceptanceReport: {
    readonly transportMode: "manual_iqies_upload";
    readonly packageContentBase64: string;
    readonly files: readonly {
      readonly filename: string;
      readonly sha256: string;
      readonly operation: SerializedHopeXml["operation"];
    }[];
  };
}

export function buildAssemblePackage(payloads: readonly SerializedHopeXml[]): AssemblePackage {
  const zip = buildDeterministicZip(
    payloads.map((payload) => ({ filename: payload.filename, content: payload.bytes })),
  );
  return {
    zip,
    acceptanceReport: {
      transportMode: "manual_iqies_upload",
      packageContentBase64: zip.bytes.toString("base64"),
      files: payloads.map((payload) => ({
        filename: payload.filename,
        sha256: payload.sha256,
        operation: payload.operation,
      })),
    },
  };
}
