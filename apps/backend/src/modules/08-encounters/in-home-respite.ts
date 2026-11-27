// M8-owned delivered in-home respite evidence. This is a clinical event derived from a signed
// encounter; it contains no Medicaid price, unit conversion, coding or payer-authorization decision.
import { randomUUID } from "node:crypto";
import { type DbClient, schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import { ChartWardenError, NotFoundError } from "@chartwarden/types";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { buildFoundationSiteReader } from "../../bootstrap/foundation-site-reader";
import { assertTxScopedToOrg } from "../../bootstrap/onboarding-credential-port";

type Tx = Parameters<Parameters<DbClient["transaction"]>[0]>[0];
const E = schema.encounters;
const R = schema.encounterInHomeRespiteEvidence;
const SITES = buildFoundationSiteReader();

export interface InHomeRespiteEvidenceView {
  readonly id: string;
  readonly serviceId: string;
  readonly version: number;
  readonly sourceEncounterId: string;
  readonly sourceEncounterVersion: number;
  readonly serviceDate: string;
  readonly serviceStartedAt: string;
  readonly serviceEndedAt: string;
  readonly observedDurationSeconds: number;
  readonly timeSource: "evv" | "clinician";
  readonly supersedesId: string | null;
  readonly recordedByMembershipId: string;
  readonly createdAt: string;
}

export interface InHomeRespiteService {
  recordForSignedEncounter(
    organizationId: string,
    userId: string,
    membershipId: string,
    encounterId: string,
  ): Promise<InHomeRespiteEvidenceView>;
  correctFromSignedEncounter(
    organizationId: string,
    userId: string,
    membershipId: string,
    input: {
      readonly serviceId: string;
      readonly expectedVersion: number;
      readonly encounterId: string;
    },
  ): Promise<InHomeRespiteEvidenceView>;
  readForSignedEncounter(
    organizationId: string,
    userId: string,
    encounterId: string,
  ): Promise<readonly InHomeRespiteEvidenceView[]>;
}

function view(row: typeof R.$inferSelect): InHomeRespiteEvidenceView {
  return {
    id: row.id,
    serviceId: row.serviceId,
    version: row.version,
    sourceEncounterId: row.sourceEncounterId,
    sourceEncounterVersion: Number(row.sourceEncounterVersion),
    serviceDate: row.serviceDate,
    serviceStartedAt: row.serviceStartedAt.toISOString(),
    serviceEndedAt: row.serviceEndedAt.toISOString(),
    observedDurationSeconds: row.observedDurationSeconds,
    timeSource: row.timeSource as "evv" | "clinician",
    supersedesId: row.supersedesId,
    recordedByMembershipId: row.recordedByMembershipId,
    createdAt: row.createdAt.toISOString(),
  };
}

async function sourceFacts(
  tx: Tx,
  organizationId: string,
  encounterId: string,
): Promise<{
  providerEntityId: string;
  locationId: string;
  patientId: string;
  admissionId: string;
  sourceEncounterVersion: number;
  serviceDate: string;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
  timeSource: "evv" | "clinician";
}> {
  const [encounter] = await tx
    .select({
      id: E.id,
      providerEntityId: E.providerEntityId,
      locationId: E.locationId,
      patientId: E.patientId,
      admissionId: E.admissionId,
      version: E.version,
      serviceDate: E.serviceDate,
      startedAt: E.startedAt,
      endedAt: E.endedAt,
      timeSource: E.timeSource,
      status: E.status,
      signedAt: E.signedAt,
      voidedAt: E.voidedAt,
    })
    .from(E)
    .where(and(eq(E.organizationId, organizationId), eq(E.id, encounterId)))
    .limit(1)
    .for("share");
  if (
    !encounter ||
    !encounter.providerEntityId ||
    !encounter.locationId ||
    !encounter.startedAt ||
    !encounter.endedAt ||
    (encounter.status !== "signed" && encounter.status !== "cosigned") ||
    !encounter.signedAt ||
    encounter.voidedAt ||
    (encounter.timeSource !== "evv" && encounter.timeSource !== "clinician")
  ) {
    throw new ChartWardenError(
      "M8_IN_HOME_RESPITE_SOURCE_INCOMPLETE",
      "In-home respite evidence requires a current signed encounter with actual service times.",
      409,
    );
  }
  const elapsedMs = encounter.endedAt.getTime() - encounter.startedAt.getTime();
  if (elapsedMs <= 0 || elapsedMs % 1000 !== 0) {
    throw new ChartWardenError(
      "M8_IN_HOME_RESPITE_TIME_UNSUPPORTED",
      "The signed encounter has no valid whole-second delivered-service duration.",
      409,
    );
  }
  return {
    providerEntityId: encounter.providerEntityId,
    locationId: encounter.locationId,
    patientId: encounter.patientId,
    admissionId: encounter.admissionId,
    sourceEncounterVersion: Number(encounter.version),
    serviceDate: encounter.serviceDate,
    startedAt: encounter.startedAt,
    endedAt: encounter.endedAt,
    durationSeconds: elapsedMs / 1000,
    timeSource: encounter.timeSource,
  };
}

export function createDbInHomeRespiteService(db: DbClient): InHomeRespiteService {
  return {
    async recordForSignedEncounter(organizationId, userId, membershipId, encounterId) {
      return withOrgContext(db, { organizationId, userId }, async (transaction) => {
        const tx = transaction as Tx;
        await assertTxScopedToOrg(tx, organizationId);
        const facts = await sourceFacts(tx, organizationId, encounterId);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
          ${`m8-in-home-respite-source:${organizationId}:${encounterId}`}, 0))`);
        const [existing] = await tx
          .select()
          .from(R)
          .where(and(eq(R.organizationId, organizationId), eq(R.sourceEncounterId, encounterId)))
          .limit(1);
        if (existing) {
          const isSameCapture =
            existing.providerEntityId === facts.providerEntityId &&
            existing.patientId === facts.patientId &&
            existing.admissionId === facts.admissionId &&
            existing.sourceEncounterVersion === facts.sourceEncounterVersion &&
            existing.serviceStartedAt.getTime() === facts.startedAt.getTime() &&
            existing.serviceEndedAt.getTime() === facts.endedAt.getTime();
          if (isSameCapture) {
            const [successor] = await tx
              .select({ id: R.id })
              .from(R)
              .where(and(eq(R.organizationId, organizationId), eq(R.supersedesId, existing.id)))
              .limit(1);
            if (!successor) return view(existing);
          }
          throw new ChartWardenError(
            "M8_IN_HOME_RESPITE_SOURCE_ALREADY_USED",
            "This signed encounter is already bound to in-home respite evidence.",
            409,
          );
        }
        const [row] = await tx
          .insert(R)
          .values({
            serviceId: randomUUID(),
            organizationId,
            providerEntityId: facts.providerEntityId,
            locationId: facts.locationId,
            patientId: facts.patientId,
            admissionId: facts.admissionId,
            sourceEncounterId: encounterId,
            sourceEncounterVersion: facts.sourceEncounterVersion,
            serviceDate: facts.serviceDate,
            serviceStartedAt: facts.startedAt,
            serviceEndedAt: facts.endedAt,
            observedDurationSeconds: facts.durationSeconds,
            timeSource: facts.timeSource,
            version: 1,
            recordedByMembershipId: membershipId,
          })
          .returning();
        if (!row)
          throw new ChartWardenError(
            "M8_IN_HOME_RESPITE_WRITE_FAILED",
            "The in-home respite evidence could not be recorded.",
            500,
          );
        return view(row);
      });
    },

    async correctFromSignedEncounter(organizationId, userId, membershipId, input) {
      return withOrgContext(db, { organizationId, userId }, async (transaction) => {
        const tx = transaction as Tx;
        await assertTxScopedToOrg(tx, organizationId);
        const [observedHead] = await tx
          .select()
          .from(R)
          .where(and(eq(R.organizationId, organizationId), eq(R.serviceId, input.serviceId)))
          .orderBy(desc(R.version))
          .limit(1);
        if (!observedHead) throw new NotFoundError("in-home respite evidence");
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
          ${`m8-in-home-respite-scope:${organizationId}:${observedHead.providerEntityId}:${observedHead.patientId}:${observedHead.admissionId}`}, 0))`);
        // Re-read after the scope lock. Concurrent corrections serialize here; an outdated
        // expectedVersion cannot replace a newer append-only head.
        const [head] = await tx
          .select()
          .from(R)
          .where(and(eq(R.organizationId, organizationId), eq(R.serviceId, input.serviceId)))
          .orderBy(desc(R.version))
          .limit(1);
        if (!head) throw new NotFoundError("in-home respite evidence");
        if (head.version !== input.expectedVersion) {
          throw new ChartWardenError(
            "M8_IN_HOME_RESPITE_VERSION_STALE",
            "In-home respite evidence changed. Reload the current version before correcting it.",
            409,
          );
        }
        if (head.sourceEncounterId === input.encounterId) {
          throw new ChartWardenError(
            "M8_IN_HOME_RESPITE_CORRECTION_SOURCE_REUSED",
            "A correction must cite a new signed clinical source.",
            409,
          );
        }
        const facts = await sourceFacts(tx, organizationId, input.encounterId);
        if (
          facts.providerEntityId !== head.providerEntityId ||
          facts.patientId !== head.patientId ||
          facts.admissionId !== head.admissionId
        ) {
          throw new ChartWardenError(
            "M8_IN_HOME_RESPITE_CORRECTION_SCOPE_MISMATCH",
            "The correction source must belong to the same provider, patient and admission.",
            409,
          );
        }
        const [row] = await tx
          .insert(R)
          .values({
            serviceId: head.serviceId,
            organizationId,
            providerEntityId: facts.providerEntityId,
            locationId: facts.locationId,
            patientId: facts.patientId,
            admissionId: facts.admissionId,
            sourceEncounterId: input.encounterId,
            sourceEncounterVersion: facts.sourceEncounterVersion,
            serviceDate: facts.serviceDate,
            serviceStartedAt: facts.startedAt,
            serviceEndedAt: facts.endedAt,
            observedDurationSeconds: facts.durationSeconds,
            timeSource: facts.timeSource,
            version: head.version + 1,
            supersedesId: head.id,
            recordedByMembershipId: membershipId,
          })
          .returning();
        if (!row)
          throw new ChartWardenError(
            "M8_IN_HOME_RESPITE_CORRECTION_FAILED",
            "The in-home respite correction could not be recorded.",
            500,
          );
        return view(row);
      });
    },

    async readForSignedEncounter(organizationId, userId, encounterId) {
      return withOrgContext(db, { organizationId, userId }, async (transaction) => {
        const tx = transaction as Tx;
        await assertTxScopedToOrg(tx, organizationId);
        // A correction is sourced from a later signed encounter but remains the same service chain.
        // Resolve the chain by its service identity so opening either the original or correction note
        // shows the latest version and does not label superseded evidence as current.
        const serviceIds = await tx
          .selectDistinct({ serviceId: R.serviceId })
          .from(R)
          .where(and(eq(R.organizationId, organizationId), eq(R.sourceEncounterId, encounterId)));
        if (serviceIds.length === 0) return [];
        const rows = await tx
          .select()
          .from(R)
          .where(
            and(
              eq(R.organizationId, organizationId),
              inArray(
                R.serviceId,
                serviceIds.map((row) => row.serviceId),
              ),
            ),
          )
          .orderBy(desc(R.version));
        return rows.map(view);
      });
    },
  };
}

export interface InHomeRespiteReadScope {
  readonly organizationId: string;
  readonly providerEntityId: string;
  readonly patientId: string;
  readonly admissionId: string;
  readonly serviceFrom: string;
  readonly serviceTo: string;
}

export interface InHomeRespiteBillingProjection {
  readonly status: "none" | "current" | "incomplete" | "ambiguous" | "scope_conflict";
  readonly serviceCount: number;
  readonly evidenceVersions: readonly {
    readonly serviceId: string;
    readonly version: number;
    readonly sourceEncounterId: string;
    readonly sourceEncounterVersion: number;
    readonly serviceDate: string;
    readonly durationSeconds: number;
  }[];
}

/** M8's transaction-bound, PHI-minimal evidence seam for M24. */
export async function readInHomeRespiteForBillingInTransaction(
  transaction: unknown,
  scope: InHomeRespiteReadScope,
): Promise<InHomeRespiteBillingProjection> {
  const tx = transaction as Tx;
  await assertTxScopedToOrg(tx, scope.organizationId);
  if (scope.serviceFrom > scope.serviceTo)
    return { status: "incomplete", serviceCount: 0, evidenceVersions: [] };
  // The insert trigger takes this same scope lock. It serializes a new capture/correction against
  // claim assembly without granting UPDATE merely to use SELECT FOR SHARE on this append-only table.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
    ${`m8-in-home-respite-scope:${scope.organizationId}:${scope.providerEntityId}:${scope.patientId}:${scope.admissionId}`}, 0))`);
  const candidates = await tx
    .select({
      serviceId: R.serviceId,
      version: R.version,
      providerEntityId: R.providerEntityId,
      sourceEncounterId: R.sourceEncounterId,
      sourceEncounterVersion: R.sourceEncounterVersion,
      serviceDate: R.serviceDate,
      serviceStartedAt: R.serviceStartedAt,
      serviceEndedAt: R.serviceEndedAt,
      timeSource: R.timeSource,
      durationSeconds: R.observedDurationSeconds,
      locationId: R.locationId,
      currentSourceVersion: E.version,
      sourceStatus: E.status,
      signedAt: E.signedAt,
      voidedAt: E.voidedAt,
      sourceProviderEntityId: E.providerEntityId,
      sourcePatientId: E.patientId,
      sourceAdmissionId: E.admissionId,
      sourceLocationId: E.locationId,
      sourceStartedAt: E.startedAt,
      sourceEndedAt: E.endedAt,
      sourceTimeSource: E.timeSource,
    })
    .from(R)
    .innerJoin(E, and(eq(E.id, R.sourceEncounterId), eq(E.organizationId, R.organizationId)))
    .where(
      and(
        eq(R.organizationId, scope.organizationId),
        eq(R.patientId, scope.patientId),
        eq(R.admissionId, scope.admissionId),
        sql`NOT EXISTS (
          SELECT 1 FROM encounter_in_home_respite_evidence successor
           WHERE successor.organization_id = ${R.organizationId}
             AND successor.supersedes_id = ${R.id}
        )`,
      ),
    )
    .orderBy(R.serviceStartedAt, R.serviceId)
    .for("share", { of: [E] });
  type Candidate = (typeof candidates)[number] & {
    locationProviderEntityId: string;
    timezone: string;
    sourceLocalServiceDate: string | null;
  };
  const rows: Candidate[] = [];
  let unresolvedLocation = false;
  for (const candidate of candidates) {
    const site = await SITES.locationSiteFacts(tx, scope.organizationId, candidate.locationId);
    if (!site) {
      unresolvedLocation = true;
      continue;
    }
    const window = await tx.execute(sql`
      SELECT
        ${candidate.serviceStartedAt} < ((${scope.serviceTo}::date + 1)::timestamp AT TIME ZONE ${site.timeZone}) AND
        ${candidate.serviceEndedAt} > (${scope.serviceFrom}::date::timestamp AT TIME ZONE ${site.timeZone}) AS overlaps,
        (${candidate.sourceStartedAt} AT TIME ZONE ${site.timeZone})::date::text AS source_local_service_date
    `);
    const windowRow = (
      window as {
        rows?: readonly { overlaps?: boolean; source_local_service_date?: string }[];
      }
    ).rows?.[0];
    if (!windowRow || typeof windowRow.overlaps !== "boolean") {
      unresolvedLocation = true;
      continue;
    }
    if (!windowRow.overlaps) continue;
    rows.push({
      ...candidate,
      locationProviderEntityId: site.providerEntityId,
      timezone: site.timeZone,
      sourceLocalServiceDate: windowRow.source_local_service_date ?? null,
    });
  }
  if (unresolvedLocation)
    return { status: "scope_conflict", serviceCount: 0, evidenceVersions: [] };
  if (rows.length === 0) return { status: "none", serviceCount: 0, evidenceVersions: [] };
  const scopeConflict = rows.some(
    (row) =>
      row.providerEntityId !== scope.providerEntityId ||
      row.sourceProviderEntityId !== scope.providerEntityId ||
      row.sourcePatientId !== scope.patientId ||
      row.sourceAdmissionId !== scope.admissionId ||
      row.locationProviderEntityId !== scope.providerEntityId ||
      row.sourceLocationId !== row.locationId,
  );
  const incomplete = rows.some(
    (row) =>
      Number(row.currentSourceVersion) !== Number(row.sourceEncounterVersion) ||
      (row.sourceStatus !== "signed" && row.sourceStatus !== "cosigned") ||
      row.signedAt === null ||
      row.voidedAt !== null ||
      row.sourceStartedAt === null ||
      row.sourceEndedAt === null ||
      row.sourceStartedAt.getTime() !== row.serviceStartedAt.getTime() ||
      row.sourceEndedAt.getTime() !== row.serviceEndedAt.getTime() ||
      row.sourceTimeSource !== row.timeSource ||
      row.sourceLocalServiceDate !== row.serviceDate ||
      Math.floor((row.serviceEndedAt.getTime() - row.serviceStartedAt.getTime()) / 1000) !==
        row.durationSeconds,
  );
  const status = scopeConflict
    ? "scope_conflict"
    : incomplete
      ? "incomplete"
      : rows.length > 1
        ? "ambiguous"
        : "current";
  return {
    status,
    serviceCount: rows.length,
    evidenceVersions: rows.map((row) => ({
      serviceId: row.serviceId,
      version: row.version,
      sourceEncounterId: row.sourceEncounterId,
      sourceEncounterVersion: Number(row.sourceEncounterVersion),
      serviceDate: row.serviceDate,
      durationSeconds: row.durationSeconds,
    })),
  };
}
