// @wardenx/quality — consumed-seam view of M12 (Medication Orders / DoseSpot). PRESENT producer (§4.4).
//
// M30 consumes M12's `MedicationOrderProvider.getOpioidOnAdmissionStats` for the opioid-on-admission
// indicator and `getComfortKitDeploymentTimeline` for the comfort-kit-deployment interval measure; it
// does NOT write to M12. Aggregate-by-default (D6). Bound to the live M12 reader via `getSeam` (P2C).
export interface QualityMedicationOrderConsumer {
  /** M12 `MedicationOrderProvider.getOpioidOnAdmissionStats` — opioid-on-admission counts over a window. */
  opioidOnAdmissionStats(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<Record<string, number>>;
  /** M12 `getComfortKitDeploymentTimeline` — comfort-kit deployment-to-order interval (median minutes). */
  comfortKitDeploymentIntervalMinutes(
    organizationId: string,
    period: { from: string; to: string },
  ): Promise<number | null>;
}
