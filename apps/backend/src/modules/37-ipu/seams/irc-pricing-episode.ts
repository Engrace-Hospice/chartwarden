// M37 owner read for M24's nonposting local IRC pricing slice. The projection contains only episode,
// stay, facility and version facts; M24 never reads M37 persistence directly.
import { type DbClient, organizationTimezone, schema } from "@chartwarden/db";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { assertTxScopedToOrg } from "../../../bootstrap/onboarding-credential-port";

export interface IrcPricingEpisodeScope {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly locPeriodId: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
}

export interface IrcPricingEpisodeFacts {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly locPeriodId: string;
  readonly ipuAdmissionId: string;
  readonly ipuAdmissionVersion: number;
  readonly ipuAdmissionUpdatedAt: Date;
  readonly ipuAdmissionKind: string;
  readonly ipuAdmissionState: string;
  readonly ipuAdmissionClosedAt: Date | null;
  readonly ipuAdmissionClosedLocalDate: string | null;
  readonly episodeId: string;
  readonly episodeVersion: number;
  readonly episodeState: string;
  readonly episodeStartedAt: Date;
  readonly episodeUpdatedAt: Date;
  readonly episodeStartedLocalDate: string;
  readonly episodeExpectedEndAt: Date;
  readonly episodeExpectedEndLocalDate: string;
  readonly episodeClosedAt: Date | null;
  readonly episodeClosedLocalDate: string | null;
  readonly consecutiveDayCount: number;
  readonly carriedOverDays: number;
  readonly capOverrideInvoked: boolean;
  readonly remoteStayId: string;
  readonly remoteStayVersion: number;
  readonly facilityId: string;
  readonly remoteStayStartedAt: Date;
  readonly remoteStayUpdatedAt: Date;
  readonly remoteStayStartedLocalDate: string;
  readonly remoteStayEndedAt: Date | null;
  readonly remoteStayEndLocalDate: string | null;
  readonly agreementDocumentId: string | null;
  readonly arrangementBillingBasis: string;
  readonly serviceTimeZone: string;
  readonly transitionBeforeServiceEnd: boolean;
}

/**
 * Read and share-lock the exact M37 IRC episode, admission and remote inpatient stay for one M6 LOC period.
 * The date bounds use the same M37 organization-local day convention as its IRC cap watchdog. Any source
 * transition inside the requested dates is surfaced so M24 can refuse unsupported transfer continuity.
 */
export async function ircPricingEpisodeInTransaction(
  transaction: unknown,
  scope: IrcPricingEpisodeScope,
): Promise<IrcPricingEpisodeFacts | null> {
  const tx = transaction as DbClient;
  await assertTxScopedToOrg(tx, scope.organizationId);
  const timezone = await organizationTimezone(tx, scope.organizationId);
  const startInclusive = sql`(${scope.serviceFrom}::date::timestamp AT TIME ZONE ${timezone})`;
  const endExclusive = sql`(${scope.serviceTo}::date + 1)::timestamp AT TIME ZONE ${timezone}`;
  const I = schema.ipuAdmission;
  const E = schema.ircEpisode;
  const R = schema.ipuRemoteInpatientEpisode;
  const transitions = schema.ipuAdmissionTransition;
  const rows = await tx
    .select({
      organizationId: E.organizationId,
      providerEntityId: E.providerEntityId,
      patientId: E.patientId,
      admissionId: I.admissionId,
      locPeriodId: R.levelOfCarePeriodId,
      ipuAdmissionId: I.id,
      ipuAdmissionVersion: I.version,
      ipuAdmissionUpdatedAt: I.updatedAt,
      ipuAdmissionKind: I.kind,
      ipuAdmissionState: I.state,
      ipuAdmissionClosedAt: I.closedAt,
      ipuAdmissionClosedLocalDate: sql<
        string | null
      >`(${I.closedAt} AT TIME ZONE ${timezone})::date::text`,
      episodeId: E.id,
      episodeVersion: E.version,
      episodeState: E.state,
      episodeStartedAt: E.startedAt,
      episodeUpdatedAt: E.updatedAt,
      episodeStartedLocalDate: sql<string>`(${E.startedAt} AT TIME ZONE ${timezone})::date::text`,
      episodeExpectedEndAt: E.expectedEndAt,
      episodeExpectedEndLocalDate: sql<string>`(${E.expectedEndAt} AT TIME ZONE ${timezone})::date::text`,
      episodeClosedAt: E.closedAt,
      episodeClosedLocalDate: sql<
        string | null
      >`(${E.closedAt} AT TIME ZONE ${timezone})::date::text`,
      consecutiveDayCount: E.consecutiveDayCount,
      carriedOverDays: E.carriedOverDays,
      capOverrideInvoked: E.capOverrideInvoked,
      remoteStayId: R.id,
      remoteStayVersion: R.version,
      facilityId: R.remoteFacilityId,
      remoteStayStartedAt: R.startedAt,
      remoteStayUpdatedAt: R.updatedAt,
      remoteStayStartedLocalDate: sql<string>`(${R.startedAt} AT TIME ZONE ${timezone})::date::text`,
      remoteStayEndedAt: R.endedAt,
      remoteStayEndLocalDate: sql<string>`(${R.endedAt} AT TIME ZONE ${timezone})::date::text`,
      agreementDocumentId: R.arrangementAgreementDocumentId,
      arrangementBillingBasis: R.arrangementBillingBasis,
    })
    .from(E)
    .innerJoin(I, eq(I.id, E.ipuAdmissionId))
    .innerJoin(R, eq(R.ipuAdmissionId, I.id))
    .where(
      and(
        eq(E.organizationId, scope.organizationId),
        eq(E.providerEntityId, scope.providerEntityId),
        eq(E.patientId, scope.patientId),
        eq(I.admissionId, scope.admissionId),
        eq(I.organizationId, scope.organizationId),
        eq(I.providerEntityId, scope.providerEntityId),
        eq(I.patientId, scope.patientId),
        // Remote M37 stays use the arranged IPU admission shape; the remote stay row itself owns GIP/IRC kind.
        eq(I.kind, "arranged"),
        eq(R.organizationId, scope.organizationId),
        eq(R.providerEntityId, scope.providerEntityId),
        eq(R.patientId, scope.patientId),
        eq(R.levelOfCarePeriodId, scope.locPeriodId),
        eq(R.remoteFacilityId, I.remoteFacilityId),
        eq(R.kind, "irc"),
        sql`${E.startedAt} <= ${startInclusive}`,
        sql`(${R.startedAt} AT TIME ZONE ${timezone})::date <= ${scope.serviceFrom}::date`,
        sql`(${R.endedAt} IS NULL OR ${R.endedAt} >= ${endExclusive})`,
      ),
    )
    .limit(2)
    .for("share");
  if (rows.length !== 1) return null;
  const row = rows[0]!;
  const transitionRows = await tx
    .select({ id: transitions.id })
    .from(transitions)
    .where(
      and(
        eq(transitions.organizationId, scope.organizationId),
        eq(transitions.ipuAdmissionId, row.ipuAdmissionId),
        // A transition anywhere in this respite episode can break the day sequence. Checking only
        // the claim window would miss a transfer/resumption between the episode anchor and this claim.
        gte(transitions.initiatedAt, row.episodeStartedAt),
        lt(transitions.initiatedAt, endExclusive),
      ),
    )
    .limit(1)
    .for("share");
  return {
    ...row,
    ipuAdmissionVersion: Number(row.ipuAdmissionVersion),
    episodeVersion: Number(row.episodeVersion),
    remoteStayVersion: Number(row.remoteStayVersion),
    consecutiveDayCount: Number(row.consecutiveDayCount),
    carriedOverDays: Number(row.carriedOverDays),
    serviceTimeZone: timezone,
    transitionBeforeServiceEnd: transitionRows.length > 0,
  };
}
