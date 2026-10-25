import { randomUUID } from "node:crypto";
// apps/backend/src/modules/41-billing-commercial/services/claim-assembly.ts — assemble a hospice 837I claim for a COMMERCIAL
// primary payer from the shared claim facts (issue #722, ADR-0100 D6/D7).
//
// This lane is the mirror image of M23's: M23 refuses a claim whose primary payer is not Medicare FFS
// (`NON_MEDICARE_PRIMARY_PAYER`); this one refuses a claim whose primary payer is not a commercial plan
// (`NON_COMMERCIAL_PRIMARY_PAYER`) and names the lane that does own it. A Medicare Advantage enrollee's hospice claim goes to
// the Medicare contractor through M23, never here (42 CFR 422.320(c)).
//
// Facts come through the reader seams M23 already binds; the contract terms come from the M41 plan, route and rate tables,
// and ALL THREE effective periods are intersected with the claim window (the database bounds none of them by the others).
// A claim whose plan does not cover the window is still saved as a DRAFT carrying the failing hard-block rules, exactly like
// M23; a claim with no plan at all for the payer is refused because there is nothing to snapshot.
import {
  buildClaimSnapshot,
  claimAdmissionCodes,
  claimPhysicianNpis,
  deriveTypeOfBill,
} from "@chartwarden/billing";
import { schema } from "@chartwarden/db";
import { withOrgContext } from "@chartwarden/tenancy";
import {
  COMMERCIAL_ERROR_CODES,
  ChartWardenError,
  type CommercialHospiceLevelOfCare,
  type CommercialSecondaryPayerKind,
  ConflictError,
  type PatientCoverage,
} from "@chartwarden/types";
import { and, eq, gte, isNull, lte, ne, or, sql } from "drizzle-orm";
import { qCodeForPlaceOfService } from "../../23-billing-medicare/services/claim-assembly-lines";
import { claimDischargeCodes } from "../../23-billing-medicare/services/claim-discharge";
import {
  type LevelOfCarePeriodFact,
  expectedPaymentCents,
  priceClaimLines,
} from "../domain/pricing";
import { conflictOnUnique } from "./db-errors";
import {
  assertPatientBoundToProvider,
  assertPatientReachable,
  assertProviderInScope,
} from "./scope-guard";
import type {
  AssembleCommercialClaimInput,
  CommercialActor,
  CommercialClaimSeams,
  CommercialDb,
} from "./types";
import { type ValidationRunView, runAndPersistValidation, toRateFact } from "./validation-runner";

export interface AssembledCommercialClaim {
  readonly claimId: string;
  readonly state: "draft";
  readonly tob: string;
  readonly totalChargeCents: number;
  readonly expectedPaymentCents: number | null;
  readonly lineCount: number;
  readonly secondaryPayerKind: CommercialSecondaryPayerKind | null;
  readonly validation: ValidationRunView;
}

/** M23's level-of-care spelling to M41's (the contract tables use the shorter inpatient names). */
const LOC_BY_M23: Record<string, CommercialHospiceLevelOfCare> = {
  routine_home_care: "routine_home_care",
  continuous_home_care: "continuous_home_care",
  inpatient_respite_care: "inpatient_respite",
  general_inpatient_care: "general_inpatient",
};

const inForce = (c: PatientCoverage, day: string): boolean =>
  c.effectiveFrom <= day && (c.effectiveTo === null || c.effectiveTo >= day);

const SECONDARY_KIND: Record<string, CommercialSecondaryPayerKind> = {
  medicare_ffs: "medicare",
  medicaid: "medicaid",
};

/** Where a claim whose primary coverage is not commercial belongs. */
function refusalFor(kind: string | null): string {
  switch (kind) {
    case "medicare_ffs":
      return "Medicare FFS is the primary payer for this window: bill it through Module 23 (Billing - Medicare).";
    case "medicare_advantage":
      return "The primary coverage is Medicare Advantage. Hospice for a Medicare Advantage enrollee is billed to the Medicare contractor as an Original Medicare claim through Module 23, never to the plan.";
    case "medicaid":
      return "Medicaid is the primary payer for this window: bill it through Module 24 (Billing - Medicaid).";
    case null:
      return "No coverage is in force for the whole service window. Record the patient's coverage before billing.";
    default:
      return `The primary coverage (${kind}) is not a commercial plan, so this lane does not bill it.`;
  }
}

/**
 * The coverage that is primary across the WHOLE window and, if any, the Medicare / Medicaid coverage behind it. A primary
 * that changes inside the window cannot be billed as one claim.
 */
export function resolveCoverages(
  coverages: readonly PatientCoverage[],
  range: { from: string; to: string },
): { primary: PatientCoverage | null; secondary: PatientCoverage | null } {
  const atStart = [...coverages]
    .filter((c) => inForce(c, range.from))
    .sort((a, b) => a.rank - b.rank);
  const primary = atStart[0] ?? null;
  if (primary === null) return { primary: null, secondary: null };
  if (!inForce(primary, range.to)) {
    throw new ChartWardenError(
      "COVERAGE_CHANGES_IN_WINDOW",
      "The primary coverage changes inside the service window. Split the claim at the change and bill each part to its own payer.",
      409,
    );
  }
  const secondary =
    atStart.find(
      (c) =>
        c.rank > primary.rank &&
        inForce(c, range.to) &&
        SECONDARY_KIND[c.coverageKind] !== undefined,
    ) ?? null;
  return { primary, secondary };
}

export interface CommercialClaimAssemblyService {
  assemble(
    actor: CommercialActor,
    input: AssembleCommercialClaimInput,
  ): Promise<AssembledCommercialClaim>;
}

export function buildCommercialClaimAssemblyService(
  db: CommercialDb,
  seams: CommercialClaimSeams,
): CommercialClaimAssemblyService {
  const now = seams.now ?? (() => new Date());
  return {
    async assemble(actor, input) {
      if (actor.actorKind.startsWith("ai_")) {
        throw new ChartWardenError("AI_ACTOR_FORBIDDEN", "AI actors may not assemble claims", 403);
      }
      const orgId = actor.organizationId;
      const { providerEntityId, patientId, serviceFrom, serviceTo } = input;
      if (serviceTo < serviceFrom) {
        throw new ChartWardenError("VALIDATION_FAILED", "serviceTo precedes serviceFrom", 422);
      }
      const range = { from: serviceFrom, to: serviceTo };

      // 0. Scope the DATA, not just the entity named in the request: the provider entity is in the actor's billing scope, the
      // patient is in their caseload, and the patient's admission belongs to THAT entity. Nothing clinical or financial is read
      // (and no refusal that depends on it is returned) before these hold, so a scoped user cannot probe or bill another
      // entity's patient by pairing it with their own entity id.
      assertProviderInScope(actor, providerEntityId);
      await assertPatientReachable(actor, seams.caseload, patientId);
      // the bound admission is the one billed (read once, so it cannot change between the check and its use)
      const admission = await assertPatientBoundToProvider(
        seams.admission,
        orgId,
        patientId,
        providerEntityId,
        range,
      );

      // 1. The commercial-primary gate (the mirror of M23's D15 Medicare-primary gate).
      const coverages = await seams.coverage.coveragesForPatient({
        organizationId: orgId,
        patientId,
      });
      const { primary, secondary } = resolveCoverages(coverages, range);
      if (primary === null || primary.coverageKind !== "commercial") {
        throw new ChartWardenError(
          COMMERCIAL_ERROR_CODES.nonCommercialPrimary,
          refusalFor(primary?.coverageKind ?? null),
          409,
        );
      }

      // 2. Clinical facts through the shared seams.
      if (admission.deceasedDate !== null && admission.deceasedDate < serviceFrom) {
        throw new ChartWardenError(
          "PATIENT_DECEASED_BEFORE_FROM",
          "the patient died before the claim's service_from",
          409,
        );
      }
      const periods = await seams.electionPeriods.coveringRange(orgId, patientId, range);
      if (periods.length === 0) {
        throw new ChartWardenError(
          "PATIENT_NOT_ELECTED",
          "no active election covers the service window",
          409,
        );
      }
      const locPeriods = await seams.levelOfCare.periodsInRange(orgId, patientId, range);
      const diagnosisRead = await seams.diagnoses.forRange(orgId, patientId, range);
      const participants = await seams.clinicalParticipants.resolveClinicalParticipants(
        orgId,
        patientId,
        serviceFrom,
        range,
      );
      const { discharge, codes: dischargeCodes } = claimDischargeCodes(
        admission,
        periods,
        serviceTo,
      );
      if (dischargeCodes.patientStatus === null) {
        throw new ChartWardenError(
          "DISCHARGE_CODES_UNRESOLVED",
          `The patient status for the end of the stay could not be derived (${dischargeCodes.unresolved ?? "unknown"}). Complete the discharge record in the admission.`,
          422,
        );
      }
      const patientStatusCode = dischargeCodes.patientStatus;
      const patientDischarged = discharge !== null && discharge.effectiveDate <= serviceTo;
      const snapshot = buildClaimSnapshot(participants, diagnosisRead.sequence);
      const npis = claimPhysicianNpis(participants);
      const admissionCodes = claimAdmissionCodes(admission);

      return withOrgContext(db, { organizationId: orgId, userId: actor.userId }, async (tx) => {
        // 3. The plan: the primary payer's plan whose period intersects the window (never trusting the DB to bound it).
        const plans = await tx
          .select()
          .from(schema.commercialPayerPlan)
          .where(
            and(
              eq(schema.commercialPayerPlan.organizationId, orgId),
              eq(schema.commercialPayerPlan.payerId, primary.payerId),
              lte(schema.commercialPayerPlan.effectiveFrom, serviceTo),
              or(
                isNull(schema.commercialPayerPlan.effectiveTo),
                gte(schema.commercialPayerPlan.effectiveTo, serviceFrom),
              ),
            ),
          );
        const named = input.planId ? plans.filter((p) => p.id === input.planId) : plans;
        if (named.length === 0) {
          throw new ChartWardenError(
            COMMERCIAL_ERROR_CODES.planNotFound,
            "No payer plan is in effect for the patient's primary commercial payer during this service window. Add the plan (with its contract rates and payer route) under Billing - Commercial, then assemble again.",
            422,
          );
        }
        const whole = named.filter(
          (p) =>
            p.effectiveFrom <= serviceFrom &&
            (p.effectiveTo === null || p.effectiveTo >= serviceTo),
        );
        if (whole.length > 1) {
          throw new ChartWardenError(
            "COMMERCIAL_PLAN_AMBIGUOUS",
            `${whole.length} plans of this payer cover the whole window. Name the plan to bill.`,
            409,
          );
        }
        const plan =
          whole[0] ?? [...named].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))[0];
        if (!plan) throw new Error("unreachable: named plans are non-empty");

        // 4. Overlap and bill-type cadence against this lane's own earlier claims. One assembly per patient at a time: the
        // transaction-scoped advisory lock serializes concurrent assemblies, so neither the overlap check nor the bill-type
        // cadence can be raced (the table's exclusion constraint is the backstop for anything that slips past).
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`m41:${orgId}:${patientId}`}, 0))`,
        );
        const earlier = await tx
          .select()
          .from(schema.commercialClaims)
          .where(
            and(
              eq(schema.commercialClaims.organizationId, orgId),
              eq(schema.commercialClaims.patientId, patientId),
              ne(schema.commercialClaims.state, "void"),
              or(
                and(
                  lte(schema.commercialClaims.serviceFrom, serviceTo),
                  gte(schema.commercialClaims.serviceTo, serviceFrom),
                ),
                eq(schema.commercialClaims.admissionId, admission.admissionId),
              ),
            ),
          );
        if (earlier.some((c) => c.serviceFrom <= serviceTo && c.serviceTo >= serviceFrom)) {
          throw new ConflictError(
            "a non-void commercial claim already covers part of this service window",
          );
        }
        // a bill continues the stay only when an earlier-window claim of this admission exists (a re-assembled March claim is not
        // "continuing" because an April claim exists)
        const hasPrior = earlier.some(
          (c) => c.admissionId === admission.admissionId && c.serviceTo < serviceFrom,
        );
        const tob = deriveTypeOfBill({
          hasPriorClaimForAdmission: hasPrior,
          patientDischarged,
          adjustment: "none",
        });

        // 5. Price the lines: plan x rate x level-of-care periods, intersected.
        const rateRows = await tx
          .select()
          .from(schema.commercialContractRate)
          .where(eq(schema.commercialContractRate.planId, plan.id));
        const periodsFacts: LevelOfCarePeriodFact[] = [];
        for (const p of locPeriods) {
          const loc = LOC_BY_M23[p.levelOfCare];
          if (loc)
            periodsFacts.push({
              levelOfCare: loc,
              from: p.from,
              to: p.to,
              chcDocumentedHours: p.chcDocumentedHours,
            });
        }
        const hcpcs =
          plan.siteOfServiceHcpcsRequired && participants.placeOfService !== null
            ? qCodeForPlaceOfService(participants.placeOfService)
            : null;
        const lines = priceClaimLines({
          window: range,
          periods: periodsFacts,
          rates: rateRows.map(toRateFact),
          hcpcsCode: hcpcs,
        });
        if (lines.length === 0) {
          // Found by the stack run: an admission with no level-of-care period in the window produced an empty INSERT (a 500).
          throw new ChartWardenError(
            "ASSEMBLY_VALIDATION_FAILED",
            "no level-of-care period backs the service window, so there is nothing to bill. Record the level of care for the stay (Admissions) or correct the dates, then assemble again.",
            422,
          );
        }
        const totalChargeCents = lines.reduce((s, l) => s + l.lineChargeCents, 0);
        const expected = expectedPaymentCents(lines);

        // 6. The clearinghouse route in effect on the last service day (snapshot; the rule re-checks on every run).
        const routes = await tx
          .select()
          .from(schema.commercialPayerRoute)
          .where(eq(schema.commercialPayerRoute.planId, plan.id));
        const routeNow = routes.filter(
          (r) =>
            (input.clearinghouseKey === undefined ||
              r.clearinghouseKey === input.clearinghouseKey) &&
            r.effectiveFrom <= serviceTo &&
            (r.effectiveTo === null || r.effectiveTo >= serviceTo),
        );
        const route = routeNow.length === 1 ? routeNow[0] : undefined;

        // 7. Persist: claim, lines, history, first validation run, outbox event - one transaction.
        const claimId = randomUUID();
        const yymmdd = serviceFrom.slice(2, 4) + serviceFrom.slice(5, 7) + serviceFrom.slice(8, 10);
        const secondaryKind = secondary ? (SECONDARY_KIND[secondary.coverageKind] ?? null) : null;
        const [claim] = await conflictOnUnique(
          "a commercial claim for this window already exists",
          async () =>
            await tx
              .insert(schema.commercialClaims)
              .values({
                id: claimId,
                organizationId: orgId,
                providerEntityId,
                patientId,
                admissionId: admission.admissionId,
                planId: plan.id,
                primaryPatientPayerId: primary.id,
                secondaryPatientPayerId: secondary?.id ?? null,
                secondaryPayerKind: secondaryKind,
                claimFilingIndicator: plan.claimFilingIndicator,
                clearinghouseKey: route?.clearinghouseKey ?? null,
                clearinghousePayerId: route?.clearinghousePayerId ?? null,
                tob,
                frequencyCode: tob.slice(2),
                serviceFrom,
                serviceTo,
                admissionDate: admission.hospiceAdmissionDate,
                admissionTypeCode: admissionCodes.admissionTypeCode,
                admissionSourceCode: admissionCodes.admissionSourceCode,
                patientStatusCode,
                claimControlNumber: `${yymmdd}-${claimId.replaceAll("-", "").slice(0, 12)}`,
                diagnoses: snapshot.diagnosisSnapshot,
                attendingNpi: npis.attendingPhysicianNpi,
                attendingFirstName: snapshot.attendingPhysicianFirstName,
                attendingLastName: snapshot.attendingPhysicianLastName,
                totalChargeCents,
                expectedPaymentCents: expected,
                createdByMembershipId: actor.membershipId,
              })
              .returning(),
        );
        if (!claim) throw new Error("commercial claim insert returned no row");
        await tx.insert(schema.commercialClaimLines).values(
          lines.map((l) => ({
            organizationId: orgId,
            providerEntityId,
            claimId,
            lineNumber: l.lineNumber,
            levelOfCare: l.levelOfCare,
            revenueCode: l.revenueCode,
            hcpcsCode: l.hcpcsCode,
            serviceFrom: l.serviceFrom,
            serviceTo: l.serviceTo,
            units: l.units,
            unitRateCents: l.unitRateCents,
            lineChargeCents: l.lineChargeCents,
            contractRateId: l.contractRateId,
          })),
        );
        await tx.insert(schema.commercialClaimStateHistory).values({
          organizationId: orgId,
          providerEntityId,
          claimId,
          fromState: null,
          toState: "draft",
          actorKind: actor.actorKind,
          actorMembershipId: actor.membershipId,
        });
        const validation = await runAndPersistValidation(
          tx,
          claim,
          "initial_assembly",
          actor.membershipId,
          now(),
        );
        await seams.outbox.publish(tx, {
          eventName: "m41.claim.draft_created",
          organizationId: orgId,
          aggregateKind: "commercial_claim",
          aggregateId: claimId,
          payload: {
            claimId,
            providerEntityId,
            patientId,
            planId: plan.id,
            tob,
            serviceFrom,
            serviceTo,
            secondaryPayerKind: secondaryKind,
          },
        });
        return {
          claimId,
          state: "draft" as const,
          tob,
          totalChargeCents,
          expectedPaymentCents: expected,
          lineCount: lines.length,
          secondaryPayerKind: secondaryKind,
          validation,
        };
      });
    },
  };
}
