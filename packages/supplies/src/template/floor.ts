// @wardenx/supplies — the §2.3 / D3 platform-floor comfort kit and its tenant-tighten-only validator.
//
// Mirrors the M9 D2 / M11 D3 / M15 D3 platform-floor-tighten-only pattern: a tenant may ADD medications,
// REDUCE quantities within bounds, and RAISE replenishment thresholds — never remove a floor medication,
// never exceed the ceiling, never disarm a controlled-substance flag. The seed rows in
// `0021_comfort_kit_platform_floor` are generated from this table, so the database and the validator cannot
// drift. PURE — no IO.

import type { ControlledSubstanceSchedule } from "@wardenx/types";

import {
  REPLENISHMENT_THRESHOLD_PCT_DEFAULT,
  TEMPLATE_QUANTITY_TENANT_MAX_MULTIPLE,
  TEMPLATE_QUANTITY_TENANT_MIN_MULTIPLE,
} from "../policy";

export interface ComfortKitFloorMedication {
  /** Stable key the migration seeds on and the validator matches tenant rows by. */
  readonly key: string;
  /** Illustrative CUI; the production migration re-resolves against M38 at migration-prep time and falls
   *  back to the seeded value if M38's RxNorm load has not yet run. */
  readonly rxNorm: string;
  readonly drugName: string;
  readonly strength: string;
  readonly dosageForm: string;
  readonly routeOfAdministration: string;
  readonly isControlledSubstance: boolean;
  readonly controlledSubstanceSchedule: ControlledSubstanceSchedule | null;
  readonly expectedQuantity: number;
  readonly expectedUnit: string;
  readonly replenishmentThresholdPct: number;
  readonly displayOrder: number;
}

/**
 * D3 — the four-medication industry-standard hospice comfort-kit baseline. Every one of these is
 * `system_locked=true` and `is_platform_floor=true`; a tenant template that omits one is not a tightened
 * kit, it is a different kit.
 */
export const COMFORT_KIT_PLATFORM_FLOOR: readonly ComfortKitFloorMedication[] = [
  {
    key: "morphine_sulfate_20mg_ml_oral_solution",
    rxNorm: "894801",
    drugName: "Morphine sulfate",
    strength: "20 mg/mL",
    dosageForm: "oral_solution",
    routeOfAdministration: "PO",
    isControlledSubstance: true,
    controlledSubstanceSchedule: "CII",
    expectedQuantity: 30,
    expectedUnit: "mL",
    replenishmentThresholdPct: REPLENISHMENT_THRESHOLD_PCT_DEFAULT,
    displayOrder: 1,
  },
  {
    key: "lorazepam_2mg_ml_oral_solution",
    rxNorm: "801957",
    drugName: "Lorazepam",
    strength: "2 mg/mL",
    dosageForm: "oral_solution",
    routeOfAdministration: "PO",
    isControlledSubstance: true,
    controlledSubstanceSchedule: "CIV",
    expectedQuantity: 15,
    expectedUnit: "mL",
    replenishmentThresholdPct: REPLENISHMENT_THRESHOLD_PCT_DEFAULT,
    displayOrder: 2,
  },
  {
    key: "haloperidol_5mg_ml_oral_solution",
    rxNorm: "197632",
    drugName: "Haloperidol",
    strength: "5 mg/mL",
    dosageForm: "oral_solution",
    routeOfAdministration: "PO",
    isControlledSubstance: false,
    controlledSubstanceSchedule: null,
    expectedQuantity: 10,
    expectedUnit: "mL",
    replenishmentThresholdPct: REPLENISHMENT_THRESHOLD_PCT_DEFAULT,
    displayOrder: 3,
  },
  {
    key: "atropine_sulfate_1pct_ophthalmic_solution",
    rxNorm: "197379",
    drugName: "Atropine sulfate",
    strength: "1%",
    dosageForm: "ophthalmic_solution",
    routeOfAdministration: "ophthalmic",
    isControlledSubstance: false,
    controlledSubstanceSchedule: null,
    expectedQuantity: 5,
    expectedUnit: "mL",
    replenishmentThresholdPct: REPLENISHMENT_THRESHOLD_PCT_DEFAULT,
    displayOrder: 4,
  },
] as const;

const FLOOR_BY_KEY = new Map(COMFORT_KIT_PLATFORM_FLOOR.map((m) => [m.key, m]));

/** D3 — the tenant-tightening bounds for one floor medication, derived rather than restated so a floor
 *  quantity change moves the bounds with it. */
export function floorQuantityBounds(key: string): { min: number; max: number } | null {
  const floor = FLOOR_BY_KEY.get(key);
  if (!floor) return null;
  return {
    min: floor.expectedQuantity * TEMPLATE_QUANTITY_TENANT_MIN_MULTIPLE,
    max: floor.expectedQuantity * TEMPLATE_QUANTITY_TENANT_MAX_MULTIPLE,
  };
}

/** A tenant template's medication line, as the validator sees it. Lines with no `floorKey` are tenant
 *  ADDITIONS (glycopyrrolate, dexamethasone, …) and are unconstrained by the floor rules. */
export interface TenantTemplateMedication {
  readonly floorKey: string | null;
  readonly drugName: string;
  readonly isControlledSubstance: boolean;
  readonly expectedQuantity: number;
  readonly replenishmentThresholdPct: number;
}

export interface TemplateViolation {
  readonly floorKey: string | null;
  readonly code:
    | "floor_medication_removed"
    | "quantity_below_tenant_minimum"
    | "quantity_above_tenant_ceiling"
    | "threshold_loosened"
    | "controlled_flag_disarmed";
  readonly message: string;
}

export type TemplateValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly violations: readonly TemplateViolation[] };

/**
 * D3 — prove a tenant template only ADDED, TIGHTENED quantities within bounds, or RAISED thresholds.
 *
 * Note the asymmetry on `replenishmentThresholdPct`: a HIGHER threshold triggers replenishment sooner, so
 * raising it is a tightening and is allowed; lowering it lets a kit run further down before anyone is told,
 * which is the direction that leaves a dying patient without morphine at 2am.
 */
export function validateTenantTemplate(
  lines: readonly TenantTemplateMedication[],
): TemplateValidation {
  const violations: TemplateViolation[] = [];
  const present = new Set(lines.map((l) => l.floorKey).filter((k): k is string => k !== null));

  for (const floor of COMFORT_KIT_PLATFORM_FLOOR) {
    if (!present.has(floor.key)) {
      violations.push({
        floorKey: floor.key,
        code: "floor_medication_removed",
        message: `platform-floor medication '${floor.drugName}' may not be removed from a tenant template`,
      });
    }
  }

  for (const line of lines) {
    if (line.floorKey === null) continue;
    const floor = FLOOR_BY_KEY.get(line.floorKey);
    if (!floor) continue;

    const bounds = floorQuantityBounds(floor.key);
    if (bounds) {
      if (line.expectedQuantity < bounds.min) {
        violations.push({
          floorKey: floor.key,
          code: "quantity_below_tenant_minimum",
          message: `${floor.drugName}: ${line.expectedQuantity} ${floor.expectedUnit} is below the ${bounds.min} ${floor.expectedUnit} tenant minimum`,
        });
      }
      if (line.expectedQuantity > bounds.max) {
        violations.push({
          floorKey: floor.key,
          code: "quantity_above_tenant_ceiling",
          message: `${floor.drugName}: ${line.expectedQuantity} ${floor.expectedUnit} exceeds the ${bounds.max} ${floor.expectedUnit} platform ceiling (raised only by controlled migration)`,
        });
      }
    }

    if (line.replenishmentThresholdPct < floor.replenishmentThresholdPct) {
      violations.push({
        floorKey: floor.key,
        code: "threshold_loosened",
        message: `${floor.drugName}: replenishment threshold may be raised, never lowered below ${floor.replenishmentThresholdPct}`,
      });
    }

    if (floor.isControlledSubstance && !line.isControlledSubstance) {
      violations.push({
        floorKey: floor.key,
        code: "controlled_flag_disarmed",
        message: `${floor.drugName}: is_controlled_substance is platform-managed and may not be cleared`,
      });
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
