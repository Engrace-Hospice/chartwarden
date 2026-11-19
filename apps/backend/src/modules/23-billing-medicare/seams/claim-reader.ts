import type {
  ClaimReader,
  ClaimSummaryDto,
  MedicareClaimEvidenceStatus,
  MedicareSecondaryContextDto,
} from "@chartwarden/billing";
import type { DbClient } from "@chartwarden/db";
import * as schema from "@chartwarden/db/schema";
import { withOrgContext } from "@chartwarden/tenancy";
import { NotImplementedError } from "@chartwarden/types";
import { and, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";

const dateOnly = (value: Date | string): string =>
  value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);

export function classifyMedicareClaimEvidence(
  state: string,
  remittanceAdviceRecorded: boolean,
  latestRemittanceTargetState?: string | null,
): MedicareClaimEvidenceStatus {
  // M23 models a recoupment by returning the claim to ACK_ACCEPTED. The latest M25-linked
  // transition, rather than the current state label alone, is needed to avoid presenting a
  // previously paid claim as still paid after a reversal.
  if (remittanceAdviceRecorded && latestRemittanceTargetState?.toLowerCase() === "ack_accepted") {
    return "reversed_or_superseded";
  }
  switch (state.toLowerCase()) {
    case "draft":
    case "validating":
    case "ready":
      return "draft";
    case "submitted":
    case "ack_pending":
      return "submitted";
    case "ack_accepted":
    case "ack_partial":
      return "acknowledged";
    case "ack_rejected":
      return "rejected";
    case "paid":
      return remittanceAdviceRecorded ? "adjudicated_paid" : "unknown";
    case "partial_paid":
      return remittanceAdviceRecorded ? "adjudicated_partial" : "unknown";
    case "denied":
      return remittanceAdviceRecorded ? "adjudicated_denied" : "unknown";
    case "replaced":
    case "voided":
      return "reversed_or_superseded";
    default:
      return "unknown";
  }
}

function rangeRelation(
  claimFrom: string,
  claimTo: string,
  requested: { from: string; to: string },
): MedicareSecondaryContextDto["rangeRelation"] {
  if (claimFrom === requested.from && claimTo === requested.to) return "exact";
  if (claimFrom <= requested.from && claimTo >= requested.to) return "covers_requested_range";
  return "partial_overlap";
}

/**
 * M23-owned, tenant-scoped Medicare claim evidence. This reader returns identity, lifecycle and
 * M25-remittance-link facts only. M23 has no authoritative by-claim payment-amount projection, so both
 * amount fields remain null; callers must not reinterpret null as zero. More detailed M25 amounts require
 * an M25-owned reader and are intentionally not reconstructed from M23 event payloads.
 */
export function buildDrizzleM23ClaimReader(db: DbClient): ClaimReader {
  const unavailable = (method: string): never => {
    throw new NotImplementedError(`ClaimReader.${method}`);
  };

  return {
    async fhirProjection() {
      return unavailable("fhirProjection");
    },
    async measureFeatureSetForPatient() {
      return unavailable("measureFeatureSetForPatient");
    },
    async gipDaysForPatientInPeriod() {
      return unavailable("gipDaysForPatientInPeriod");
    },
    async claimById(orgId, claimId) {
      return withOrgContext(db, { organizationId: orgId, userId: "system" }, async (tx) => {
        const rows = await tx
          .select()
          .from(schema.claim)
          .where(and(eq(schema.claim.organizationId, orgId), eq(schema.claim.id, claimId)))
          .limit(1);
        const row = rows[0];
        return row
          ? ({
              claimId: row.id,
              providerEntityId: row.providerEntityId,
              patientId: row.patientId,
              admissionId: row.admissionId,
              tob: row.tob,
              state: String(row.state).toLowerCase(),
              serviceFrom: dateOnly(row.serviceFrom),
              serviceTo: dateOnly(row.serviceTo),
              claimControlNumber: row.claimControlNumber,
              totalChargeCents: row.totalChargeCents,
            } satisfies ClaimSummaryDto)
          : null;
      });
    },
    async claimByControlNumber(orgId, controlNumber) {
      return withOrgContext(db, { organizationId: orgId, userId: "system" }, async (tx) => {
        const rows = await tx
          .select()
          .from(schema.claim)
          .where(
            and(
              eq(schema.claim.organizationId, orgId),
              eq(schema.claim.claimControlNumber, controlNumber),
            ),
          )
          .limit(1);
        const row = rows[0];
        return row
          ? ({
              claimId: row.id,
              providerEntityId: row.providerEntityId,
              patientId: row.patientId,
              admissionId: row.admissionId,
              tob: row.tob,
              state: String(row.state).toLowerCase(),
              serviceFrom: dateOnly(row.serviceFrom),
              serviceTo: dateOnly(row.serviceTo),
              claimControlNumber: row.claimControlNumber,
              totalChargeCents: row.totalChargeCents,
            } satisfies ClaimSummaryDto)
          : null;
      });
    },
    async medicareSecondaryContext(orgId, patientId, range, scope) {
      return withOrgContext(db, { organizationId: orgId, userId: "system" }, async (tx) => {
        const candidates = await tx
          .select({
            organizationId: schema.claim.organizationId,
            claimId: schema.claim.id,
            patientId: schema.claim.patientId,
            providerEntityId: schema.claim.providerEntityId,
            admissionId: schema.claim.admissionId,
            patientPayerId: schema.claim.patientPayerId,
            serviceFrom: schema.claim.serviceFrom,
            serviceTo: schema.claim.serviceTo,
            state: schema.claim.state,
          })
          .from(schema.claim)
          .where(
            and(
              eq(schema.claim.organizationId, orgId),
              eq(schema.claim.patientId, patientId),
              eq(schema.claim.providerEntityId, scope.providerEntityId),
              eq(schema.claim.admissionId, scope.admissionId),
              eq(schema.claim.patientPayerId, scope.primaryCoverageId),
              lte(schema.claim.serviceFrom, new Date(`${range.to}T00:00:00.000Z`)),
              gte(schema.claim.serviceTo, new Date(`${range.from}T00:00:00.000Z`)),
            ),
          )
          .orderBy(schema.claim.serviceFrom, schema.claim.id)
          // Two scoped matches are enough to establish ambiguity; never choose an arbitrary first claim.
          .limit(2);
        if (candidates.length === 0) return [];

        const claimIds = candidates.map((candidate) => candidate.claimId);
        const histories = await tx
          .select({
            claimId: schema.claimStateHistory.claimId,
            remittanceAdviceId: schema.claimStateHistory.remittanceAdviceId,
            toState: schema.claimStateHistory.toState,
          })
          .from(schema.claimStateHistory)
          .where(
            and(
              eq(schema.claimStateHistory.organizationId, orgId),
              inArray(schema.claimStateHistory.claimId, claimIds),
              isNotNull(schema.claimStateHistory.remittanceAdviceId),
            ),
          )
          .orderBy(desc(schema.claimStateHistory.at));
        const latestRemittanceByClaim = new Map<string, { targetState: string }>();
        for (const history of histories) {
          if (
            history.remittanceAdviceId !== null &&
            !latestRemittanceByClaim.has(history.claimId)
          ) {
            latestRemittanceByClaim.set(history.claimId, { targetState: String(history.toState) });
          }
        }

        return candidates.map((candidate) => {
          const serviceFrom = dateOnly(candidate.serviceFrom);
          const serviceTo = dateOnly(candidate.serviceTo);
          const latestRemittance = latestRemittanceByClaim.get(candidate.claimId) ?? null;
          const remittanceAdviceRecorded = latestRemittance !== null;
          const state = String(candidate.state).toLowerCase();
          return {
            organizationId: candidate.organizationId,
            claimId: candidate.claimId,
            patientId: candidate.patientId,
            providerEntityId: candidate.providerEntityId,
            admissionId: candidate.admissionId,
            patientPayerId: candidate.patientPayerId,
            serviceFrom,
            serviceTo,
            claimState: state as ClaimSummaryDto["state"],
            rangeRelation: rangeRelation(serviceFrom, serviceTo, range),
            evidenceStatus: classifyMedicareClaimEvidence(
              state,
              remittanceAdviceRecorded,
              latestRemittance?.targetState,
            ),
            medicareClaimState: state as ClaimSummaryDto["state"],
            remittanceAdviceRecorded,
            paidAmountCents: null,
            patientResponsibilityCents: null,
          } satisfies MedicareSecondaryContextDto;
        });
      });
    },
  };
}
