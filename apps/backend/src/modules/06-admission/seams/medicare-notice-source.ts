// M6-owned authoritative clinical source for M23 Medicare notices. This seam returns ids, dates,
// diagnosis and physician references only; beneficiary identity/MBI remain M5-owned and X12 parties
// remain M23/M40-owned. Every query is explicitly organization-scoped in addition to FORCE RLS.
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { and, desc, eq, lte } from "drizzle-orm";

export type M6NoticeSourceCode =
  | "M6_NOTICE_SOURCE_NOT_FOUND"
  | "M6_NOTICE_RELATIONSHIP_INVALID"
  | "M6_NOTICE_ELECTION_UNSIGNED"
  | "M6_NOTICE_DIAGNOSIS_MISSING"
  | "M6_NOTR_EVENT_UNSUPPORTED"
  | "M6_TRANSFER_SOURCE_INVALID";

/** Contains field names and codes only; never source values or narrative PHI. */
export class M6NoticeSourceError extends Error {
  override readonly name = "M6NoticeSourceError";
  constructor(readonly code: M6NoticeSourceCode, readonly field?: string) {
    super(field ? `${code}: ${field}` : code);
  }
}

export interface M6AuthoritativeNoticeFacts {
  readonly organizationId: string;
  readonly admissionId: string;
  readonly patientId: string;
  readonly providerEntityId: string;
  readonly electionPeriodId: string;
  readonly electionStatementId: string;
  readonly relatedSourceId: string;
  readonly admissionDate: string;
  readonly statementFromDate: string;
  readonly terminationDate: string | null;
  readonly principalDiagnosis: string;
  readonly attendingPhysicianId: string;
  readonly certifyingPhysicianId: string;
  /** Stable non-PHI row revision material consumed by M23's keyed source fingerprint. */
  readonly sourceVersions: Readonly<Record<string, number | string>>;
}

type Tx = DbClient;

async function admissionFor(
  tx: Tx,
  organizationId: string,
  admissionId: string,
) {
  const A = schema.admissions;
  const [row] = await tx.select({
    id: A.id,
    organizationId: A.organizationId,
    patientId: A.patientId,
    providerEntityId: A.providerEntityId,
    admissionAt: A.admissionAt,
    attendingPhysicianId: A.attendingPhysicianId,
    hospicePhysicianId: A.hospicePhysicianId,
    version: A.version,
  }).from(A).where(and(eq(A.organizationId, organizationId), eq(A.id, admissionId))).limit(1);
  if (!row?.providerEntityId || !row.admissionAt) {
    throw new M6NoticeSourceError("M6_NOTICE_SOURCE_NOT_FOUND", "admission");
  }
  return row;
}

async function signedElectionFor(
  tx: Tx,
  input: { organizationId: string; electionPeriodId: string; patientId: string; providerEntityId: string },
) {
  const E = schema.electionStatements;
  const rows = await tx.select({
    id: E.id,
    patientId: E.patientId,
    providerEntityId: E.providerEntityId,
    status: E.status,
    signedAt: E.signedAt,
    documentId: E.documentId,
    declaredEffectiveDate: E.declaredEffectiveDate,
    principalDiagnosis: E.primaryDiagnosisIcd10AtElection,
    attendingPhysicianId: E.attendingPhysicianId,
    version: E.version,
  }).from(E).where(and(
    eq(E.organizationId, input.organizationId),
    eq(E.electionPeriodId, input.electionPeriodId),
  )).limit(2);
  if (rows.length !== 1 || !rows[0]) {
    throw new M6NoticeSourceError("M6_NOTICE_SOURCE_NOT_FOUND", "electionStatement");
  }
  const row = rows[0];
  if (row.patientId !== input.patientId || row.providerEntityId !== input.providerEntityId) {
    throw new M6NoticeSourceError("M6_NOTICE_RELATIONSHIP_INVALID", "electionStatement");
  }
  if (row.status !== "signed" || !row.signedAt || !row.documentId) {
    throw new M6NoticeSourceError("M6_NOTICE_ELECTION_UNSIGNED", "electionStatement");
  }
  if (!row.principalDiagnosis?.trim()) {
    throw new M6NoticeSourceError("M6_NOTICE_DIAGNOSIS_MISSING", "principalDiagnosis");
  }
  return row;
}

async function periodFor(tx: Tx, organizationId: string, periodId: string, admissionId: string) {
  const P = schema.electionPeriods;
  const [row] = await tx.select({
    id: P.id,
    admissionId: P.admissionId,
    effectiveAt: P.effectiveAt,
    version: P.version,
  }).from(P).where(and(eq(P.organizationId, organizationId), eq(P.id, periodId))).limit(1);
  if (!row?.effectiveAt) throw new M6NoticeSourceError("M6_NOTICE_SOURCE_NOT_FOUND", "electionPeriod");
  if (row.admissionId !== admissionId) {
    throw new M6NoticeSourceError("M6_NOTICE_RELATIONSHIP_INVALID", "electionPeriod");
  }
  return row;
}

const isoDay = (value: Date): string => value.toISOString().slice(0, 10);

async function commonFacts(
  tx: Tx,
  input: {
    organizationId: string;
    admissionId: string;
    electionPeriodId: string;
    expectedPatientId: string;
    expectedProviderEntityId: string;
    relatedSourceId: string;
    statementFromDate: string;
    terminationDate?: string;
    sourceVersion: number | string;
  },
): Promise<M6AuthoritativeNoticeFacts> {
  const admission = await admissionFor(tx, input.organizationId, input.admissionId);
  if (
    admission.patientId !== input.expectedPatientId ||
    admission.providerEntityId !== input.expectedProviderEntityId
  ) {
    throw new M6NoticeSourceError("M6_NOTICE_RELATIONSHIP_INVALID", "admission");
  }
  const period = await periodFor(tx, input.organizationId, input.electionPeriodId, admission.id);
  const election = await signedElectionFor(tx, {
    organizationId: input.organizationId,
    electionPeriodId: period.id,
    patientId: admission.patientId,
    providerEntityId: admission.providerEntityId,
  });
  if (!election.declaredEffectiveDate || election.declaredEffectiveDate !== period.effectiveAt) {
    throw new M6NoticeSourceError("M6_NOTICE_RELATIONSHIP_INVALID", "electionEffectiveDate");
  }
  const attendingPhysicianId = election.attendingPhysicianId ?? admission.attendingPhysicianId;
  const certifyingPhysicianId = admission.hospicePhysicianId;
  if (!attendingPhysicianId) {
    throw new M6NoticeSourceError("M6_NOTICE_SOURCE_NOT_FOUND", "attendingPhysician");
  }
  if (!certifyingPhysicianId) {
    throw new M6NoticeSourceError("M6_NOTICE_SOURCE_NOT_FOUND", "certifyingPhysician");
  }
  return {
    organizationId: input.organizationId,
    admissionId: admission.id,
    patientId: admission.patientId,
    providerEntityId: admission.providerEntityId,
    electionPeriodId: period.id,
    electionStatementId: election.id,
    relatedSourceId: input.relatedSourceId,
    admissionDate: isoDay(admission.admissionAt!),
    statementFromDate: input.statementFromDate,
    terminationDate: input.terminationDate ?? null,
    principalDiagnosis: election.principalDiagnosis!.trim(),
    attendingPhysicianId,
    certifyingPhysicianId,
    sourceVersions: {
      admission: admission.version,
      electionPeriod: period.version,
      electionStatement: election.version,
      relatedSource: input.sourceVersion,
    },
  };
}

export function buildM6MedicareNoticeSource(db: DbClient) {
  return {
    loadNoe(input: {
      organizationId: string;
      admissionId: string;
      electionPeriodId: string;
      patientId: string;
      providerEntityId: string;
      electionEffectiveDate: string;
    }): Promise<M6AuthoritativeNoticeFacts> {
      return withOrgContext(db, { organizationId: input.organizationId, userId: "" }, async (tx) => {
        const period = await periodFor(tx as Tx, input.organizationId, input.electionPeriodId, input.admissionId);
        if (period.effectiveAt !== input.electionEffectiveDate) {
          throw new M6NoticeSourceError("M6_NOTICE_RELATIONSHIP_INVALID", "electionEffectiveDate");
        }
        return commonFacts(tx as Tx, {
          ...input,
          expectedPatientId: input.patientId,
          expectedProviderEntityId: input.providerEntityId,
          relatedSourceId: input.electionPeriodId,
          statementFromDate: input.electionEffectiveDate,
          sourceVersion: period.version,
        });
      });
    },

    loadNotr(input: {
      organizationId: string;
      admissionId: string;
      patientId: string;
      providerEntityId: string;
      triggerKind: "revocation" | "transfer_out" | "discharge";
      revocationEventId: string | null;
      transferEventId: string | null;
      dischargeEventId: string | null;
      effectiveEndDate: string;
    }): Promise<M6AuthoritativeNoticeFacts> {
      return withOrgContext(db, { organizationId: input.organizationId, userId: "" }, async (tx) => {
        if (input.triggerKind === "transfer_out") {
          throw new M6NoticeSourceError("M6_NOTR_EVENT_UNSUPPORTED", "triggerKind");
        }
        let eventId: string;
        let eventVersion: number;
        let electionPeriodId: string;
        if (input.triggerKind === "revocation") {
          const R = schema.revocationEvents;
          const [event] = await (tx as Tx).select({
            id: R.id,
            admissionId: R.admissionId,
            electionPeriodId: R.electionPeriodId,
            effectiveAt: R.effectiveAt,
            signedAt: R.signedAt,
            documentId: R.documentId,
            version: R.version,
          }).from(R).where(and(
            eq(R.organizationId, input.organizationId),
            eq(R.id, input.revocationEventId ?? "00000000-0000-0000-0000-000000000000"),
          )).limit(1);
          if (!event || event.admissionId !== input.admissionId || !event.signedAt || !event.documentId) {
            throw new M6NoticeSourceError("M6_NOTICE_SOURCE_NOT_FOUND", "revocationEvent");
          }
          if (event.effectiveAt !== input.effectiveEndDate) {
            throw new M6NoticeSourceError("M6_NOTICE_RELATIONSHIP_INVALID", "effectiveEndDate");
          }
          eventId = event.id;
          eventVersion = event.version;
          electionPeriodId = event.electionPeriodId;
        } else {
          const D = schema.dischargeEvents;
          const [event] = await (tx as Tx).select({
            id: D.id,
            admissionId: D.admissionId,
            dischargeType: D.dischargeType,
            status: D.status,
            effectiveAt: D.effectiveAt,
            version: D.version,
          }).from(D).where(and(
            eq(D.organizationId, input.organizationId),
            eq(D.id, input.dischargeEventId ?? "00000000-0000-0000-0000-000000000000"),
          )).limit(1);
          const aliveDischarge = event && event.status === "completed" &&
            !["death", "transfer", "revocation"].includes(event.dischargeType);
          if (!event || !aliveDischarge || event.admissionId !== input.admissionId) {
            throw new M6NoticeSourceError("M6_NOTR_EVENT_UNSUPPORTED", "dischargeEvent");
          }
          if (event.effectiveAt !== input.effectiveEndDate) {
            throw new M6NoticeSourceError("M6_NOTICE_RELATIONSHIP_INVALID", "effectiveEndDate");
          }
          const P = schema.electionPeriods;
          const periods = await (tx as Tx).select({ id: P.id }).from(P).where(and(
            eq(P.organizationId, input.organizationId),
            eq(P.admissionId, input.admissionId),
            lte(P.effectiveAt, event.effectiveAt),
          )).orderBy(desc(P.sequenceNumber)).limit(2);
          if (!periods[0]) throw new M6NoticeSourceError("M6_NOTICE_SOURCE_NOT_FOUND", "electionPeriod");
          eventId = event.id;
          eventVersion = event.version;
          electionPeriodId = periods[0].id;
        }
        const T = schema.transferEvents;
        const [latestTransferIn] = await (tx as Tx).select({ effectiveAt: T.effectiveAt }).from(T).where(and(
          eq(T.organizationId, input.organizationId),
          eq(T.admissionId, input.admissionId),
          eq(T.direction, "in"),
          lte(T.effectiveAt, input.effectiveEndDate),
        )).orderBy(desc(T.effectiveAt)).limit(1);
        const period = await periodFor(tx as Tx, input.organizationId, electionPeriodId, input.admissionId);
        return commonFacts(tx as Tx, {
          organizationId: input.organizationId,
          admissionId: input.admissionId,
          electionPeriodId,
          expectedPatientId: input.patientId,
          expectedProviderEntityId: input.providerEntityId,
          relatedSourceId: eventId,
          statementFromDate: latestTransferIn?.effectiveAt ?? period.effectiveAt!,
          terminationDate: input.effectiveEndDate,
          sourceVersion: eventVersion,
        });
      });
    },

    loadTransferOrCancellation(input: {
      organizationId: string;
      admissionId: string;
      electionPeriodId: string;
      transferEventId: string;
      patientId: string;
      providerEntityId: string;
      statementFromDate: string;
      action: "original" | "correction" | "void";
    }): Promise<M6AuthoritativeNoticeFacts> {
      return withOrgContext(db, { organizationId: input.organizationId, userId: "" }, async (tx) => {
        const T = schema.transferEvents;
        const [event] = await (tx as Tx).select({
          id: T.id,
          admissionId: T.admissionId,
          direction: T.direction,
          effectiveAt: T.effectiveAt,
          version: T.version,
        }).from(T).where(and(
          eq(T.organizationId, input.organizationId),
          eq(T.id, input.transferEventId),
        )).limit(1);
        if (!event || event.direction !== "in" || event.admissionId !== input.admissionId) {
          throw new M6NoticeSourceError("M6_TRANSFER_SOURCE_INVALID", "transferEvent");
        }
        if (input.action !== "correction" && event.effectiveAt !== input.statementFromDate) {
          throw new M6NoticeSourceError("M6_NOTICE_RELATIONSHIP_INVALID", "statementFromDate");
        }
        return commonFacts(tx as Tx, {
          ...input,
          expectedPatientId: input.patientId,
          expectedProviderEntityId: input.providerEntityId,
          relatedSourceId: event.id,
          statementFromDate: input.statementFromDate,
          sourceVersion: event.version,
        });
      });
    },
  };
}

export type M6MedicareNoticeSource = ReturnType<typeof buildM6MedicareNoticeSource>;
