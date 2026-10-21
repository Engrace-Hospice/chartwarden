import { ChartWardenError } from "@wardenx/types";
import type { AdmissionEvidenceRequirement } from "./admission-evidence-service";

export type UploadedCtiMetadata =
  | {
      readonly documentState: "unsigned";
    }
  | {
      readonly documentState: "signed";
      readonly signedAt?: string;
      readonly signingPhysicianId: string;
    };

export type UploadedElectionMetadata =
  | {
      readonly documentState: "unsigned";
    }
  | {
      readonly documentState: "signed";
      readonly signedAt?: string;
      readonly signerRole: "patient" | "legal_representative" | "caregiver";
    };

export interface UploadedNoticeOfRightsMetadata {
  readonly acknowledgedAt?: string;
  readonly acknowledgedByName?: string;
  readonly acknowledgedByRole?: "patient" | "legal_representative" | "caregiver";
}

function assertIsoDateTime(value: string | undefined, code: string): void {
  if (value === undefined) return;
  if (Number.isNaN(Date.parse(value))) {
    throw new ChartWardenError(code, "Evidence timestamp must be a valid ISO date/time.", 400);
  }
}

export function requirementsForUploadedCti(
  metadata: UploadedCtiMetadata,
  admissionHospicePhysicianId: string | null | undefined,
): readonly AdmissionEvidenceRequirement[] {
  if (metadata.documentState === "unsigned") return ["cti"];
  assertIsoDateTime(metadata.signedAt, "UPLOADED_CTI_SIGNED_AT_INVALID");
  if (!admissionHospicePhysicianId || metadata.signingPhysicianId !== admissionHospicePhysicianId) {
    throw new ChartWardenError(
      "UPLOADED_CTI_HOSPICE_PHYSICIAN_MISMATCH",
      "Uploaded signed CTI must be signed by the admission selected hospice physician.",
      400,
    );
  }
  return ["cti", "cti_signature"];
}

export function requirementsForUploadedElectionStatement(
  metadata: UploadedElectionMetadata,
): readonly AdmissionEvidenceRequirement[] {
  if (metadata.documentState === "unsigned") return ["election_statement"];
  assertIsoDateTime(metadata.signedAt, "UPLOADED_ELECTION_SIGNED_AT_INVALID");
  return ["election_statement", "election_signature"];
}

export function requirementsForUploadedNoticeOfRights(
  metadata: UploadedNoticeOfRightsMetadata,
): readonly AdmissionEvidenceRequirement[] {
  assertIsoDateTime(metadata.acknowledgedAt, "UPLOADED_NOR_ACKNOWLEDGED_AT_INVALID");
  return ["notice_of_rights"];
}
