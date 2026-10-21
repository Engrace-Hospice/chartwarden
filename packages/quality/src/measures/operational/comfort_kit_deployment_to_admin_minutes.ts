// @chartwarden/quality — operational measure: comfort-kit deployment-to-administration interval. Pure. No IO.
// Modeled as the rate of comfort-kit deployments whose first administration occurred within the SLA-minute
// window (higher is better); the snapshot carries the median/p90 minutes for the deployment-to-admin
// interval. Source: M12 `getComfortKitDeploymentTimeline` + M13 `getComfortKitAdministrationTimeline`.
import type { ComputeMeasureInput, QualityMeasureValueResult, ThresholdRule } from "../result";
import { ratioResult } from "../result";

/** Already-fetched comfort-kit deployment-to-administration figures. */
export interface ComfortKitDeploymentToAdminMinutesInput extends ComputeMeasureInput {
  /** Comfort-kit deployments in the window (denominator). */
  readonly deployments: number;
  /** Deployments whose first administration was within the SLA-minute window (numerator). */
  readonly deploymentsAdministeredWithinSla: number;
  /** The SLA window in minutes (snapshot context). */
  readonly slaMinutes: number;
  /** Median minutes from deployment to first administration (snapshot context). */
  readonly medianMinutesToAdministration: number | null;
  /** The per-FY/agency target on the within-SLA rate (higher-is-better). */
  readonly threshold: ThresholdRule;
  /** Optional warn band below target. */
  readonly warn?: ThresholdRule;
}

/** Compute the comfort-kit-deployment-to-administration within-SLA rate. Pure. */
export function computeComfortKitDeploymentToAdminMinutes(
  input: ComfortKitDeploymentToAdminMinutesInput,
): QualityMeasureValueResult {
  return ratioResult({
    numerator: input.deploymentsAdministeredWithinSla,
    denominator: input.deployments,
    threshold: input.threshold,
    warn: input.warn,
    snapshot: {
      measure: "comfort_kit_deployment_to_admin_minutes",
      deployments: input.deployments,
      deploymentsAdministeredWithinSla: input.deploymentsAdministeredWithinSla,
      slaMinutes: input.slaMinutes,
      medianMinutesToAdministration: input.medianMinutesToAdministration,
    },
  });
}
