// @wardenx/discipline-plans — §3.1 `src/kinds/` barrel (M15-T01).
//
// M15-T01 lands the §3.5 / D11 required-signer constants per kind. The §3.4 per-kind TypeBox `data jsonb`
// schemas + their validators land with the Drizzle schema they validate (M15-T02).

import type {
  DisciplinePlanKind,
  DisciplinePlanVersionKind,
  DisciplineRequiredSignerSet,
} from "@wardenx/types";

import {
  AIDE_POC_REQUIRED_SIGNERS,
  type RequiredSignersByVersionKind,
} from "./aide-poc/required-signers";
import { MSW_PLAN_REQUIRED_SIGNERS } from "./msw-plan/required-signers";
import { SPIRITUAL_PLAN_REQUIRED_SIGNERS } from "./spiritual-plan/required-signers";
import { VOLUNTEER_PLAN_REQUIRED_SIGNERS } from "./volunteer-plan/required-signers";

export * from "./aide-poc/required-signers";
export * from "./msw-plan/required-signers";
export * from "./spiritual-plan/required-signers";
export * from "./volunteer-plan/required-signers";

/** §3.5 / D11 — every kind's quorum, keyed by the D1 plan-kind discriminator. */
export const REQUIRED_SIGNERS_BY_KIND: {
  readonly [K in DisciplinePlanKind]: RequiredSignersByVersionKind;
} = {
  aide_poc: AIDE_POC_REQUIRED_SIGNERS,
  msw_plan: MSW_PLAN_REQUIRED_SIGNERS,
  spiritual_plan: SPIRITUAL_PLAN_REQUIRED_SIGNERS,
  volunteer_plan: VOLUNTEER_PLAN_REQUIRED_SIGNERS,
} as const;

/**
 * §2.2.2 / §3.5 — the quorum captured on `discipline_care_plan_version.required_signer_set` at the
 * `in_review` transition. `interim_revision` reuses the `initial` set; the auto-built `discharge` version is
 * signed by the system actor on `m6.admission.discharged` and therefore carries an EMPTY quorum.
 */
export function requiredSignersFor(
  kind: DisciplinePlanKind,
  versionKind: DisciplinePlanVersionKind,
): DisciplineRequiredSignerSet {
  if (versionKind === "discharge") return [];
  const byVersionKind = REQUIRED_SIGNERS_BY_KIND[kind];
  return versionKind === "idg_review" ? byVersionKind.idg_review : byVersionKind.initial;
}
