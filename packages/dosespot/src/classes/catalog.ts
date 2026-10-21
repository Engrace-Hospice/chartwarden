// @chartwarden/dosespot — §2.1 Medication-Class catalog (M12-T01 domain layout).
//
// The single source of per-class metadata the lifecycle (§2.2 D2), the validators (§3.4), the EPCS gate
// (§2.4), and the terminology bindings (M38) read instead of re-deriving rules inline: which schedules
// trigger the EPCS layer for the class, the M38 terminology value-sets the class binds, and whether the
// class can carry a controlled component (compounded only, driven at runtime by `data.contains_controlled`).
//
// PURE DATA — no IO, `@chartwarden/types`-only. The per-class TypeBox `data` schemas + cross-field validators
// + transmission mappers + concrete `epcs-rules` land per-folder in `classes/<class>/` in later tasks
// (the spec §2.1 lazy-import shape); this catalog pins the metadata they hang off so adding a class is one
// PR (drop a folder + add an entry; no `ALTER TABLE`, no migration — §2.1).

import type { DeaSchedule, MedClass } from "@chartwarden/types";

/** The M38 terminology value-sets a class binds at validation time (§2.1 "terminologyBindings"). */
export type TerminologyBinding =
  | "rxnorm"
  | "ndc"
  | "route_of_administration"
  | "dosage_form"
  | "dea_schedule";

/** Per-class §2.1 metadata. */
export interface MedClassMeta {
  readonly medClass: MedClass;
  /** The M38 value-sets the class's `validate` step cross-checks against. */
  readonly terminologyBindings: readonly TerminologyBinding[];
  /** §2.4 — the schedules whose presence routes a sign through the EPCS `epcs_identity_pending` branch.
   * Empty for `standard`; for `compounded` this applies only when `data.contains_controlled` is true. */
  readonly schedulesRequiringEpcs: readonly DeaSchedule[];
  /** §2.1 — may the class carry a controlled component gated by a runtime `data.contains_controlled` flag
   * (compounded only) rather than by the class itself always being controlled? */
  readonly controlledByDataFlag: boolean;
}

/** §2.1 — the authoritative per-class catalog (one entry per {@link MedClass}). */
export const MED_CLASS_CATALOG: { readonly [K in MedClass]: MedClassMeta } = {
  standard: {
    medClass: "standard",
    terminologyBindings: ["rxnorm", "ndc", "route_of_administration", "dosage_form"],
    schedulesRequiringEpcs: [],
    controlledByDataFlag: false,
  },
  controlled_substance: {
    medClass: "controlled_substance",
    terminologyBindings: [
      "rxnorm",
      "ndc",
      "route_of_administration",
      "dosage_form",
      "dea_schedule",
    ],
    schedulesRequiringEpcs: ["II", "III", "IV", "V"],
    controlledByDataFlag: false,
  },
  compounded: {
    medClass: "compounded",
    terminologyBindings: ["rxnorm", "route_of_administration", "dosage_form"],
    schedulesRequiringEpcs: ["II", "III", "IV", "V"], // applies only if data.contains_controlled
    controlledByDataFlag: true,
  },
} as const;
