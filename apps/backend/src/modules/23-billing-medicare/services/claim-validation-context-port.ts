// apps/backend/src/modules/23-billing-medicare/services/claim-validation-context-port.ts
//
// The production `ValidationContextPort` (GAP-070): re-materialises the §11.A `ValidationContext` for an
// EXISTING claim, so the `validation-run` worker can actually run the rule library. Before this the port was a
// fail-closed stub, so no validation could ever complete.
//
// It reads through the SAME seam readers and the SAME derivations as the assembly (`readAssemblyFacts`,
// `computeClaimHipps`, `computeClaimSia`, `assembleValidationContext`) — never a parallel copy — and takes the
// claim's own persisted lines. A fact that changed since assembly (a level-of-care change, a revoked election,
// a new rate) therefore shows up as a failing rule instead of being masked by stale persisted numbers. Two
// facts the assembly deliberately leaves null are real here: the latest resolved HETS eligibility check and the
// admission's NOE row.
import {
  type IsoDate,
  type NoeStatusSnapshot,
  medicareReceiptDay,
  repositories,
} from "@wardenx/billing";
import type { ClaimAssemblySeams } from "./claim-assembly";
import { computeClaimHipps, computeClaimSia, readAssemblyFacts } from "./claim-assembly-facts";
import type { BillingTx, BillingWriteActor } from "./claim-state-service";
import type {
  MaterializedValidationInputs,
  ValidationContextPort,
} from "./claim-validation-service";
import { readClaimRhcCarryOver, rhcCarryOverSnapshot } from "./rhc-carry-over";
import { assembleValidationContext } from "./validation-context";

const MS_PER_DAY = 86_400_000;
const INTERIM_TOBS: ReadonlySet<string> = new Set(["811", "812", "813", "814"]);
/** Claim states a successor claim is NOT continuous with (mirrors the assembly's `NON_SUPERSEDED`). */
const NON_CONTINUOUS_STATES: ReadonlySet<string> = new Set(["voided", "replaced", "ack_rejected"]);

const wholeDaysBetween = (from: Date, to: Date): number =>
  Math.max(0, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY));

const isoDayOf = (d: Date): IsoDate => d.toISOString().slice(0, 10);

export interface ClaimValidationContextPortDeps {
  /** The same reader-seam bundle the claim assembly runs over. */
  readonly seams: ClaimAssemblySeams;
  /** True only when a HETS eligibility path is live; false → the eligibility rule skips (never fails). */
  readonly eligibilityBound: boolean;
  readonly now?: () => Date;
}

export function buildClaimValidationContextPort(
  deps: ClaimValidationContextPortDeps,
): ValidationContextPort {
  const now = deps.now ?? (() => new Date());

  return {
    async build(
      tx: BillingTx,
      actor: BillingWriteActor,
      claim: repositories.ClaimRecord,
    ): Promise<MaterializedValidationInputs> {
      const orgId = actor.organizationId;
      const facts = await readAssemblyFacts(deps.seams, orgId, {
        providerEntityId: claim.providerEntityId,
        patientId: claim.patientId,
        serviceFrom: claim.serviceFrom,
        serviceTo: claim.serviceTo,
      });
      const lines = await new repositories.ClaimLineRepository(tx).listForClaim(claim.id);
      // Two-tier RHC carry-over, re-derived (a newer HETS check or a corrected stay surfaces as a HIPPS diff).
      const rhcCarryOver = await readClaimRhcCarryOver(
        tx as repositories.BillingDb,
        orgId,
        claim.patientId,
        facts.admission,
        now(),
      );
      const hipps = computeClaimHipps(
        facts,
        { serviceFrom: claim.serviceFrom, serviceTo: claim.serviceTo },
        rhcCarryOver.priorDays,
      );
      const sia = await computeClaimSia(deps.seams, facts);

      // Prior-claim continuity for the admission, EXCLUDING the claim under validation.
      const patientClaims = await new repositories.ClaimRepository(tx).listByOrgPage(
        orgId,
        { providerEntityId: claim.providerEntityId, patientId: claim.patientId },
        undefined,
        repositories.MAX_PAGE_SIZE,
      );
      const priorClaim = patientClaims.items
        .filter(
          (c) =>
            c.id !== claim.id &&
            c.admissionId === facts.admission.admissionId &&
            !NON_CONTINUOUS_STATES.has(c.state) &&
            INTERIM_TOBS.has(c.tob) &&
            c.serviceTo < claim.serviceFrom,
        )
        .sort((a, b) => (a.serviceTo < b.serviceTo ? 1 : a.serviceTo > b.serviceTo ? -1 : 0))[0];

      const asOf = now();
      const latestEligibility = deps.eligibilityBound
        ? await new repositories.EligibilityCheckRepository(tx).findLatestResolvedForPatient(
            orgId,
            claim.patientId,
          )
        : null;
      // The admission's EFFECTIVE NOE (latest non-cancelled, non-rejected — an `ack_accepted` one included).
      // `findActiveByAdmission` excludes accepted NOEs (it means "still in flight"), which made an accepted NOE
      // validate as "No Notice of Election".
      const noeRepo = new repositories.NoeRepository(tx);
      const noeRow = await noeRepo.findEffectiveByAdmission(facts.admission.admissionId);

      const context = assembleValidationContext({
        orgId,
        facts,
        claim: {
          claimId: claim.id,
          providerEntityId: claim.providerEntityId,
          patientId: claim.patientId,
          tob: claim.tob,
          serviceFrom: claim.serviceFrom,
          serviceTo: claim.serviceTo,
          replacesClaimId: claim.replacesClaimId ?? null,
          totalChargeCents: claim.totalChargeCents,
          priorClaimTob: priorClaim?.tob ?? null,
          priorClaimServiceTo: priorClaim?.serviceTo ?? null,
        },
        lines,
        hipps,
        siaQualifyingVisitCount: sia?.qualifyingVisits.length ?? 0,
        siaCents: sia?.siaAddOnCents ?? 0,
        eligibility: latestEligibility
          ? {
              outcome: latestEligibility.outcome,
              checkedAt: latestEligibility.checkedAt.toISOString(),
              asOfDate: latestEligibility.asOfServiceDate,
              ageDays: wholeDaysBetween(latestEligibility.checkedAt, asOf),
            }
          : null,
        noe: noeRow
          ? noeStatusSnapshot(
              noeRow,
              await noeClockStart((id) => noeRepo.findById(id), noeRow),
              facts.admission.hospiceAdmissionDate,
              asOf,
            )
          : null,
        eligibilityBound: deps.eligibilityBound,
        rhcCarryOver: rhcCarryOverSnapshot(rhcCarryOver),
      });
      return { context };
    },
  };
}

/**
 * The effective NOE as the `noe_timeliness_5d` rule sees it. A corrected NOE accepted after a rejection is the
 * effective one (`findEffectiveByAdmission` skips rejected rows). The ch. 11 §20.1.1 clock starts at `clockStart`
 * ({@link noeClockStart}), so a correction cannot move it later. Its acceptance date is the MAC's (`payer_status_date`) when
 * recorded, else the (Eastern) day we received the acceptance (a pre-0378 row).
 */
export function noeStatusSnapshot(
  noe: repositories.NoeRecord,
  clockStart: IsoDate,
  hospiceAdmissionDate: string,
  asOf: Date,
): NoeStatusSnapshot {
  const accepted = noe.state === "ack_accepted";
  const acceptedDate = !accepted
    ? null
    : (noe.payerStatusDate ?? (noe.acceptedAt ? medicareReceiptDay(noe.acceptedAt) : null));
  return {
    state: noe.state,
    admissionDay: wholeDaysBetween(
      new Date(`${hospiceAdmissionDate}T00:00:00.000Z`),
      new Date(`${isoDayOf(asOf)}T00:00:00.000Z`),
    ),
    windowBreached: noe.windowBreachedAt !== null,
    electionEffectiveDate: clockStart,
    acceptedDate,
    acceptedDateSource: !accepted
      ? null
      : noe.payerStatusDate
        ? (noe.payerStatusDateSource ?? "receipt")
        : acceptedDate
          ? "receipt"
          : null,
  };
}

/** Corrections are bounded by the D4 attempt index (`notice-correction-service.ts`). */
const MAX_CHAIN_LINKS = 99;

/**
 * Where the NOE's 5-day clock starts: the EARLIEST admission date along its correction chain (the original NOE was
 * dated from M6's election period). A corrected NOE may fix a wrong date, but it can never move the clock later —
 * otherwise "correcting" the admission date would turn a late NOE into a timely one and erase its OSC 77 days.
 */
export async function noeClockStart(
  find: (id: string) => Promise<repositories.NoeRecord | null>,
  noe: repositories.NoeRecord,
): Promise<IsoDate> {
  let start = noe.electionEffectiveDate;
  let cursor = noe.correctsNoticeId;
  for (let link = 0; cursor !== null && link < MAX_CHAIN_LINKS; link += 1) {
    const prior = await find(cursor);
    if (!prior) break;
    if (prior.electionEffectiveDate < start) start = prior.electionEffectiveDate;
    cursor = prior.correctsNoticeId;
  }
  return start;
}
