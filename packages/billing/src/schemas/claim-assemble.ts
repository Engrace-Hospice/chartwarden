// @wardenx/billing — schemas for route #1 `POST /api/v1/billing/claims:assemble` (§4.1 / §4.2).
//
// Server-authoritative claim assembly: takes (provider_entity_id, patient_id, service_from, service_to,
// tob) and produces a DRAFT `claim` with lines + HIPPS + SIA snapshots, then runs the initial
// `validation_run`. 817/818 are NOT assemblable here — they go through the dedicated :replace / :void
// routes (so `tob` is the four interim/admission-through-discharge codes only).
import { type Static, Type } from "@sinclair/typebox";
import { CentsSchema, ClaimTobAssemblable, Count, IsoDateSchema, Uuid } from "./common";

export const ClaimAssembleRequest = Type.Object({
  providerEntityId: Uuid,
  patientId: Uuid,
  serviceFrom: IsoDateSchema,
  serviceTo: IsoDateSchema,
  tob: ClaimTobAssemblable,
  /** Optional explicit election-period scope (else derived from serviceFrom/serviceTo + the M6 reader). */
  electionPeriodScope: Type.Optional(
    Type.Object({
      electionPeriodIdFrom: Uuid,
      electionPeriodIdTo: Uuid,
    }),
  ),
});
export type ClaimAssembleRequest = Static<typeof ClaimAssembleRequest>;

export const ClaimAssembleResponse = Type.Object({
  claimId: Uuid,
  state: Type.Literal("DRAFT"),
  totalChargeCents: CentsSchema,
  /** INTERNAL per-diem class code (not a Medicare HIPPS code). */
  perDiemClassCode: Type.String(),
  perDiemRateCents: CentsSchema,
  lineCount: Count,
  initialValidationRunId: Uuid,
  initialValidationOutcome: Type.Union([
    Type.Literal("all_pass"),
    Type.Literal("failures_present"),
    Type.Literal("overrides_required"),
  ]),
});
export type ClaimAssembleResponse = Static<typeof ClaimAssembleResponse>;

// Errors (per §4.2):
//   409 PATIENT_NOT_ELECTED          — no active election covering serviceFrom..serviceTo (M6)
//   409 NON_MEDICARE_PRIMARY_PAYER   — D15
//   409 PATIENT_DECEASED_BEFORE_FROM — patient died before the claim's service_from
//   409 OVERLAPPING_ACTIVE_CLAIM     — a non-superseded claim already covers this range
//   422 ASSEMBLY_VALIDATION_FAILED   — the rule registry found failures even before SUBMIT
//   412 IF_MATCH_REQUIRED            — duplicate-call without a version precondition
