/**
 * M6-owned, transaction-bound election facts for M24 daily pricing. This is intentionally a
 * fact reader: it does not apply Medicare benefit-period carry-over or decide payer day-count policy.
 * M24 must pair these signed source facts with an explicitly qualified payer methodology.
 */
import { type DbClient, schema } from "@chartwarden/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { assertTxScopedToOrg } from "../../../bootstrap/onboarding-credential-port";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

export interface MedicaidElectionHistoryFacts {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly admissionVersion: number;
  readonly transferredIn: boolean;
  readonly admissionState: string;
  readonly historyTruncated: boolean;
  readonly historyEvidence: null | {
    readonly id: string;
    readonly electionPeriodId: string;
    readonly coverageFrom: string;
    readonly coverageThrough: string;
    readonly completenessStatus: string;
    readonly priorHospiceStatus: string;
    readonly transferStatus: string;
    readonly interruptionStatus: string;
    readonly sourceReference: string;
    readonly sourceVersion: number;
    readonly verificationStatus: string;
    readonly verifiedAt: string | null;
    readonly version: number;
    readonly createdAt: string;
  };
  readonly electionPeriods: readonly {
    readonly id: string;
    readonly sequenceNumber: number;
    readonly status: string;
    readonly effectiveAt: string | null;
    readonly actualEndAt: string | null;
    readonly electionStatementId: string | null;
    readonly version: number;
    readonly updatedAt: string;
    readonly statement: null | {
      readonly id: string;
      readonly status: string;
      readonly patientId: string;
      readonly providerEntityId: string | null;
      readonly declaredEffectiveDate: string | null;
      readonly signedAt: string | null;
      readonly version: number;
      readonly updatedAt: string;
    };
  }[];
  readonly transfers: readonly {
    readonly id: string;
    readonly direction: "in" | "out";
    readonly effectiveAt: string;
    readonly version: number;
    readonly updatedAt: string;
  }[];
  readonly revocations: readonly {
    readonly id: string;
    readonly effectiveAt: string;
    readonly version: number;
    readonly updatedAt: string;
  }[];
  readonly completedDischarges: readonly {
    readonly id: string;
    readonly effectiveAt: string;
    readonly version: number;
    readonly updatedAt: string;
  }[];
}

export interface MedicaidElectionHistoryReader {
  readInTransaction(
    transaction: unknown,
    scope: {
      readonly organizationId: string;
      readonly providerEntityId: string;
      readonly patientId: string;
      readonly admissionId: string;
    },
  ): Promise<MedicaidElectionHistoryFacts | null>;
}

const dateText = (value: Date | string | null): string | null =>
  value === null
    ? null
    : value instanceof Date
      ? value.toISOString().slice(0, 10)
      : value.slice(0, 10);
const instantText = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/** Reads and share-locks the bounded current admission's election/transfer/end facts on M24's transaction. */
export function createMedicaidElectionHistoryReader(): MedicaidElectionHistoryReader {
  return {
    async readInTransaction(transaction, scope) {
      const tx = transaction as Tx;
      await assertTxScopedToOrg(tx, scope.organizationId);
      const A = schema.admissions;
      const EP = schema.electionPeriods;
      const ES = schema.electionStatements;
      const TE = schema.transferEvents;
      const RE = schema.revocationEvents;
      const DE = schema.dischargeEvents;
      const HE = schema.medicaidElectionHistoryEvidence;
      // History evidence is intentionally SELECT-only for chartwarden_app. A transaction advisory
      // lock, shared with the append-only insert guard, provides the version-head serialization
      // that a row lock would otherwise require UPDATE privilege to acquire.
      const historyLockKey = `m6-medicaid-election-history:${scope.organizationId}:${scope.admissionId}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${historyLockKey}, 0))`);
      const [admission] = await tx
        .select({
          id: A.id,
          organizationId: A.organizationId,
          providerEntityId: A.providerEntityId,
          patientId: A.patientId,
          version: A.version,
          transferredIn: A.transferredIn,
          status: A.status,
        })
        .from(A)
        .where(
          and(
            eq(A.organizationId, scope.organizationId),
            eq(A.id, scope.admissionId),
            eq(A.providerEntityId, scope.providerEntityId),
            eq(A.patientId, scope.patientId),
          ),
        )
        .for("share")
        .limit(1);
      if (!admission) return null;

      const historyEvidenceRows = await tx
        .select({
          id: HE.id,
          electionPeriodId: HE.electionPeriodId,
          coverageFrom: HE.coverageFrom,
          coverageThrough: HE.coverageThrough,
          completenessStatus: HE.completenessStatus,
          priorHospiceStatus: HE.priorHospiceStatus,
          transferStatus: HE.transferStatus,
          interruptionStatus: HE.interruptionStatus,
          sourceReference: HE.sourceReference,
          sourceVersion: HE.sourceVersion,
          verificationStatus: HE.verificationStatus,
          verifiedAt: HE.verifiedAt,
          version: HE.version,
          createdAt: HE.createdAt,
        })
        .from(HE)
        .where(
          and(
            eq(HE.organizationId, scope.organizationId),
            eq(HE.providerEntityId, scope.providerEntityId),
            eq(HE.patientId, scope.patientId),
            eq(HE.admissionId, scope.admissionId),
          ),
        )
        .orderBy(HE.version)
        .limit(101);
      const periodRows = await tx
        .select({
          id: EP.id,
          sequenceNumber: EP.sequenceNumber,
          status: EP.status,
          effectiveAt: EP.effectiveAt,
          actualEndAt: EP.actualEndAt,
          electionStatementId: EP.electionStatementId,
          version: EP.version,
          updatedAt: EP.updatedAt,
        })
        .from(EP)
        .where(
          and(eq(EP.organizationId, scope.organizationId), eq(EP.admissionId, scope.admissionId)),
        )
        .orderBy(EP.sequenceNumber)
        .limit(101)
        .for("share");
      // Lock the two sides separately. PostgreSQL cannot apply FOR SHARE to the nullable side of
      // the former LEFT JOIN; separate owner-scoped reads preserve missing-statement visibility
      // while locking every persisted statement that could affect this pricing assessment.
      const statementIds = periodRows.flatMap((period) =>
        period.electionStatementId ? [period.electionStatementId] : [],
      );
      const statementRows =
        statementIds.length === 0
          ? []
          : await tx
              .select({
                id: ES.id,
                status: ES.status,
                patientId: ES.patientId,
                providerEntityId: ES.providerEntityId,
                electionPeriodId: ES.electionPeriodId,
                declaredEffectiveDate: ES.declaredEffectiveDate,
                signedAt: ES.signedAt,
                version: ES.version,
                updatedAt: ES.updatedAt,
              })
              .from(ES)
              .where(and(eq(ES.organizationId, scope.organizationId), inArray(ES.id, statementIds)))
              .for("share");
      const statementById = new Map(statementRows.map((statement) => [statement.id, statement]));
      const periods = periodRows.map((period) => {
        const statement = period.electionStatementId
          ? statementById.get(period.electionStatementId)
          : undefined;
        return {
          ...period,
          statementId: statement?.id ?? null,
          statementStatus: statement?.status ?? null,
          statementPatientId: statement?.patientId ?? null,
          statementProviderEntityId: statement?.providerEntityId ?? null,
          statementPeriodId: statement?.electionPeriodId ?? null,
          declaredEffectiveDate: statement?.declaredEffectiveDate ?? null,
          signedAt: statement?.signedAt ?? null,
          statementVersion: statement?.version ?? null,
          statementUpdatedAt: statement?.updatedAt ?? null,
        };
      });
      const initialElectionPeriod = periods.find((period) => period.sequenceNumber === 1);
      const latestHistoryEvidence =
        historyEvidenceRows
          .filter((row) => row.electionPeriodId === initialElectionPeriod?.id)
          .at(-1) ?? null;
      const transfers = await tx
        .select({
          id: TE.id,
          direction: TE.direction,
          effectiveAt: TE.effectiveAt,
          version: TE.version,
          updatedAt: TE.updatedAt,
        })
        .from(TE)
        .where(
          and(eq(TE.organizationId, scope.organizationId), eq(TE.admissionId, scope.admissionId)),
        )
        .orderBy(TE.effectiveAt, TE.id)
        .limit(101)
        .for("share");
      const revocations = await tx
        .select({
          id: RE.id,
          effectiveAt: RE.effectiveAt,
          version: RE.version,
          updatedAt: RE.updatedAt,
        })
        .from(RE)
        .where(
          and(eq(RE.organizationId, scope.organizationId), eq(RE.admissionId, scope.admissionId)),
        )
        .orderBy(RE.effectiveAt, RE.id)
        .limit(101)
        .for("share");
      const discharges = await tx
        .select({
          id: DE.id,
          effectiveAt: DE.effectiveAt,
          version: DE.version,
          updatedAt: DE.updatedAt,
        })
        .from(DE)
        .where(
          and(
            eq(DE.organizationId, scope.organizationId),
            eq(DE.admissionId, scope.admissionId),
            eq(DE.status, "completed"),
          ),
        )
        .orderBy(DE.effectiveAt, DE.id)
        .limit(101)
        .for("share");

      return {
        organizationId: admission.organizationId,
        providerEntityId: admission.providerEntityId!,
        patientId: admission.patientId,
        admissionId: admission.id,
        admissionVersion: Number(admission.version),
        transferredIn: admission.transferredIn,
        admissionState: admission.status,
        historyTruncated:
          historyEvidenceRows.length > 100 ||
          periods.length > 100 ||
          transfers.length > 100 ||
          revocations.length > 100 ||
          discharges.length > 100,
        historyEvidence: latestHistoryEvidence
          ? {
              id: latestHistoryEvidence.id,
              electionPeriodId: latestHistoryEvidence.electionPeriodId,
              coverageFrom: dateText(latestHistoryEvidence.coverageFrom)!,
              coverageThrough: dateText(latestHistoryEvidence.coverageThrough)!,
              completenessStatus: latestHistoryEvidence.completenessStatus,
              priorHospiceStatus: latestHistoryEvidence.priorHospiceStatus,
              transferStatus: latestHistoryEvidence.transferStatus,
              interruptionStatus: latestHistoryEvidence.interruptionStatus,
              sourceReference: latestHistoryEvidence.sourceReference,
              sourceVersion: Number(latestHistoryEvidence.sourceVersion),
              verificationStatus: latestHistoryEvidence.verificationStatus,
              verifiedAt: latestHistoryEvidence.verifiedAt
                ? instantText(latestHistoryEvidence.verifiedAt)
                : null,
              version: Number(latestHistoryEvidence.version),
              createdAt: instantText(latestHistoryEvidence.createdAt),
            }
          : null,
        electionPeriods: periods.map((period) => ({
          id: period.id,
          sequenceNumber: Number(period.sequenceNumber),
          status: period.status,
          effectiveAt: dateText(period.effectiveAt),
          actualEndAt: dateText(period.actualEndAt),
          electionStatementId: period.electionStatementId,
          version: Number(period.version),
          updatedAt: instantText(period.updatedAt),
          statement:
            period.statementId && period.statementPeriodId === period.id
              ? {
                  id: period.statementId,
                  status: period.statementStatus!,
                  patientId: period.statementPatientId!,
                  providerEntityId: period.statementProviderEntityId,
                  declaredEffectiveDate: dateText(period.declaredEffectiveDate),
                  signedAt: dateText(period.signedAt),
                  version: Number(period.statementVersion),
                  updatedAt: instantText(period.statementUpdatedAt!),
                }
              : null,
        })),
        transfers: transfers.map((row) => ({
          id: row.id,
          direction: row.direction === "in" ? ("in" as const) : ("out" as const),
          effectiveAt: dateText(row.effectiveAt)!,
          version: Number(row.version),
          updatedAt: instantText(row.updatedAt),
        })),
        revocations: revocations.map((row) => ({
          id: row.id,
          effectiveAt: dateText(row.effectiveAt)!,
          version: Number(row.version),
          updatedAt: instantText(row.updatedAt),
        })),
        completedDischarges: discharges.map((row) => ({
          id: row.id,
          effectiveAt: dateText(row.effectiveAt)!,
          version: Number(row.version),
          updatedAt: instantText(row.updatedAt),
        })),
      };
    },
  };
}
