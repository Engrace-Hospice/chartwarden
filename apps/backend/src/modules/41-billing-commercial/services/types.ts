// apps/backend/src/modules/41-billing-commercial/services/types.ts — the injected ports of the commercial claim lane.
//
// Claim FACTS (coverage, admission, election, level of care, diagnoses, attending) come from the consumed reader seams
// Module 23 already binds (ADR-0100 D2): the reader SHAPES are reused from M23's claim-assembly types so one bound adapter
// serves both lanes. M41 reads no other module's tables.
import type { DbClient } from "@chartwarden/db";
import type { PatientCoverageReader } from "@chartwarden/types";
import type {
  AdmissionContextReader,
  DiagnosisSequenceReader,
  ElectionPeriodReader,
  LevelOfCareReader,
  MdmEntityProvider,
} from "../../23-billing-medicare/services/claim-assembly-types";

export type CommercialDb = DbClient;
/** The org-context transaction handle every statement runs on. */
export type CommercialTx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];

/** The server-assembled actor (NEVER the request body). */
export interface CommercialActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly membershipId: string;
  /** `ai_*` is rejected fail-closed: billing is a human compliance surface (M23 D13 posture). */
  readonly actorKind: string;
  /** A recent step-up (re-authentication) was proven for this request; required for an override. */
  readonly stepUpRecent: boolean;
  readonly request?: {
    readonly correlationId?: string;
    readonly requestId?: string;
    readonly sourceIp?: string;
    readonly userAgent?: string;
  };
}

/** §4.10 transactional outbox: the emit commits in the same transaction as the mutation. */
export interface CommercialOutboxPort {
  publish(
    tx: CommercialTx,
    event: {
      readonly eventName: string;
      readonly payload: Record<string, unknown>;
      readonly organizationId: string;
      readonly aggregateKind: string;
      readonly aggregateId: string;
    },
  ): Promise<void>;
}

/** The prominent M4 audit event of an applied override (written in the override's own transaction). */
export interface CommercialAuditPort {
  recordOverrideAudit(
    tx: CommercialTx,
    input: {
      readonly organizationId: string;
      readonly actorUserId: string;
      readonly claimId: string;
      readonly validationResultId: string;
      readonly ruleKey: string;
      readonly reasonLength: number;
      readonly correlationId: string;
      readonly requestId?: string;
      readonly sourceIp?: string;
      readonly userAgent?: string;
    },
  ): Promise<{ auditEventId: string }>;
}

export interface CommercialClaimSeams {
  readonly coverage: Pick<PatientCoverageReader, "coveragesForPatient">; // M5
  readonly admission: AdmissionContextReader; // M6
  readonly electionPeriods: ElectionPeriodReader; // M6
  readonly levelOfCare: LevelOfCareReader; // M6
  readonly diagnoses: DiagnosisSequenceReader; // M7
  readonly clinicalParticipants: Pick<MdmEntityProvider, "resolveClinicalParticipants">; // M40
  readonly outbox: CommercialOutboxPort;
  readonly audit: CommercialAuditPort;
  readonly now?: () => Date;
}

export interface AssembleCommercialClaimInput {
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
  /** Names the plan when more than one plan of the primary payer is in effect. */
  readonly planId?: string;
  /** The platform clearinghouse binding's key (ADR-0053), when known; narrows the plan's payer routes. */
  readonly clearinghouseKey?: string;
}
