import { type DbClient, schema } from "@wardenx/db";
import { WardenXError } from "@wardenx/types";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ResourceNotFoundError } from "./routes/service";

const AE = schema.admissionEvidence;
const ADM = schema.admissions;

export const ADMISSION_EVIDENCE_REQUIREMENTS = [
  "notice_of_rights",
  "election_statement",
  "election_signature",
  "cti",
  "cti_signature",
] as const;
export type AdmissionEvidenceRequirement = (typeof ADMISSION_EVIDENCE_REQUIREMENTS)[number];
export type AdmissionEvidenceSource = "structured" | "uploaded";
export type AdmissionEvidenceStatus = "pending" | "valid" | "invalid" | "superseded";
export type StructuredEvidenceEntity = "notice_of_rights" | "election_statement" | "cti";

export interface EvidenceReadModel {
  readonly sourceType: AdmissionEvidenceSource;
  readonly evidenceId: string;
  readonly documentId?: string;
  readonly documentVersionId?: string;
  readonly structuredEntityId?: string;
  readonly completedAt?: string;
}

export interface AdmissionEvidenceFacts {
  readonly noticeOfRights?: EvidenceReadModel;
  readonly electionStatement?: EvidenceReadModel;
  readonly electionSignature?: EvidenceReadModel;
  readonly cti?: EvidenceReadModel;
  readonly ctiSignature?: EvidenceReadModel;
}

export interface EvidenceScope {
  readonly organizationId: string;
  readonly admissionId: string;
  readonly electionPeriodId?: string | null;
  readonly requirementType: AdmissionEvidenceRequirement;
}

export interface AdmissionEvidenceDocumentValidator {
  validateAdmissionEvidenceDocumentVersion(args: {
    readonly organizationId: string;
    readonly admissionId: string;
    readonly patientId: string;
    readonly documentId: string;
    readonly documentVersionId: string;
  }): Promise<void>;
}

export interface RecordStructuredEvidenceInput extends EvidenceScope {
  readonly patientId: string;
  readonly structuredEntityType: StructuredEvidenceEntity;
  readonly structuredEntityId: string;
  readonly effectiveAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly metadata?: Record<string, unknown>;
  readonly createdByMembershipId?: string | null;
}

export interface RecordUploadedEvidenceInput extends EvidenceScope {
  readonly patientId: string;
  readonly documentId: string;
  readonly documentVersionId: string;
  readonly effectiveAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly metadata: Record<string, unknown>;
  readonly createdByMembershipId?: string | null;
}

function metadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return value ?? {};
}

function evidenceRowToReadModel(row: typeof AE.$inferSelect): EvidenceReadModel {
  return {
    sourceType: row.sourceType as AdmissionEvidenceSource,
    evidenceId: row.id,
    ...(row.documentId ? { documentId: row.documentId } : {}),
    ...(row.documentVersionId ? { documentVersionId: row.documentVersionId } : {}),
    ...(row.structuredEntityId ? { structuredEntityId: row.structuredEntityId } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt.toISOString() } : {}),
  };
}

export function createAdmissionEvidenceService(
  tx: DbClient,
  documentValidator?: AdmissionEvidenceDocumentValidator,
) {
  async function admissionTenancy(scope: {
    organizationId: string;
    admissionId: string;
    patientId: string;
  }) {
    const [adm] = await tx
      .select({
        id: ADM.id,
        patientId: ADM.patientId,
        providerEntityId: ADM.providerEntityId,
        locationId: ADM.locationId,
        hospicePhysicianId: ADM.hospicePhysicianId,
      })
      .from(ADM)
      .where(and(eq(ADM.organizationId, scope.organizationId), eq(ADM.id, scope.admissionId)))
      .limit(1);
    if (!adm) throw new ResourceNotFoundError(scope.admissionId);
    if (adm.patientId !== scope.patientId) {
      throw new WardenXError(
        "ADMISSION_EVIDENCE_PATIENT_MISMATCH",
        "Admission evidence patient does not match the admission.",
        400,
      );
    }
    return adm;
  }

  async function supersedeValid(scope: EvidenceScope): Promise<void> {
    await tx
      .update(AE)
      .set({ status: "superseded", updatedAt: new Date() })
      .where(
        and(
          eq(AE.organizationId, scope.organizationId),
          eq(AE.admissionId, scope.admissionId),
          scope.electionPeriodId
            ? eq(AE.electionPeriodId, scope.electionPeriodId)
            : isNull(AE.electionPeriodId),
          eq(AE.requirementType, scope.requirementType),
          eq(AE.status, "valid"),
        ),
      );
  }

  async function recordStructuredEvidence(input: RecordStructuredEvidenceInput) {
    const adm = await admissionTenancy(input);
    await supersedeValid(input);
    const [row] = await tx
      .insert(AE)
      .values({
        organizationId: input.organizationId,
        providerEntityId: adm.providerEntityId,
        locationId: adm.locationId,
        admissionId: input.admissionId,
        patientId: input.patientId,
        electionPeriodId: input.electionPeriodId ?? null,
        requirementType: input.requirementType,
        sourceType: "structured",
        status: "valid",
        structuredEntityType: input.structuredEntityType,
        structuredEntityId: input.structuredEntityId,
        effectiveAt: input.effectiveAt ?? null,
        completedAt: input.completedAt ?? new Date(),
        metadata: metadata(input.metadata),
        createdByMembershipId: input.createdByMembershipId ?? null,
      })
      .returning();
    return row;
  }

  async function recordUploadedEvidence(input: RecordUploadedEvidenceInput) {
    const adm = await admissionTenancy(input);
    if (!documentValidator) {
      throw new WardenXError(
        "ADMISSION_EVIDENCE_DOCUMENT_VALIDATOR_UNBOUND",
        "Admission uploaded evidence requires the M22 document-version validator.",
        503,
      );
    }
    await documentValidator.validateAdmissionEvidenceDocumentVersion({
      organizationId: input.organizationId,
      admissionId: input.admissionId,
      patientId: input.patientId,
      documentId: input.documentId,
      documentVersionId: input.documentVersionId,
    });
    await supersedeValid(input);
    const [row] = await tx
      .insert(AE)
      .values({
        organizationId: input.organizationId,
        providerEntityId: adm.providerEntityId,
        locationId: adm.locationId,
        admissionId: input.admissionId,
        patientId: input.patientId,
        electionPeriodId: input.electionPeriodId ?? null,
        requirementType: input.requirementType,
        sourceType: "uploaded",
        status: "valid",
        documentId: input.documentId,
        documentVersionId: input.documentVersionId,
        effectiveAt: input.effectiveAt ?? null,
        completedAt: input.completedAt ?? new Date(),
        metadata: input.metadata,
        createdByMembershipId: input.createdByMembershipId ?? null,
      })
      .returning();
    return row;
  }

  async function findValidEvidence(scope: EvidenceScope) {
    const [row] = await tx
      .select()
      .from(AE)
      .where(
        and(
          eq(AE.organizationId, scope.organizationId),
          eq(AE.admissionId, scope.admissionId),
          scope.electionPeriodId
            ? eq(AE.electionPeriodId, scope.electionPeriodId)
            : isNull(AE.electionPeriodId),
          eq(AE.requirementType, scope.requirementType),
          eq(AE.status, "valid"),
        ),
      )
      .orderBy(desc(AE.createdAt))
      .limit(1);
    return row ?? null;
  }

  async function hasValidEvidence(scope: EvidenceScope): Promise<boolean> {
    return (await findValidEvidence(scope)) != null;
  }

  async function readFacts(args: {
    organizationId: string;
    admissionId: string;
    electionPeriodId?: string | null;
  }): Promise<AdmissionEvidenceFacts> {
    const rows = await tx
      .select()
      .from(AE)
      .where(
        and(
          eq(AE.organizationId, args.organizationId),
          eq(AE.admissionId, args.admissionId),
          eq(AE.status, "valid"),
          sql`${AE.requirementType} IN ('notice_of_rights','election_statement','election_signature','cti','cti_signature')`,
        ),
      )
      .orderBy(desc(AE.createdAt));
    const pick = (requirementType: AdmissionEvidenceRequirement, electionScoped: boolean) =>
      rows.find(
        (row) =>
          row.requirementType === requirementType &&
          (electionScoped
            ? row.electionPeriodId === (args.electionPeriodId ?? null)
            : row.electionPeriodId == null),
      );
    return {
      ...(pick("notice_of_rights", false)
        ? { noticeOfRights: evidenceRowToReadModel(pick("notice_of_rights", false)!) }
        : {}),
      ...(pick("election_statement", true)
        ? { electionStatement: evidenceRowToReadModel(pick("election_statement", true)!) }
        : {}),
      ...(pick("election_signature", true)
        ? { electionSignature: evidenceRowToReadModel(pick("election_signature", true)!) }
        : {}),
      ...(pick("cti", true) ? { cti: evidenceRowToReadModel(pick("cti", true)!) } : {}),
      ...(pick("cti_signature", true)
        ? { ctiSignature: evidenceRowToReadModel(pick("cti_signature", true)!) }
        : {}),
    };
  }

  return {
    recordStructuredEvidence,
    recordUploadedEvidence,
    supersedeEvidence: supersedeValid,
    findValidEvidence,
    hasValidEvidence,
    readFacts,
  };
}
