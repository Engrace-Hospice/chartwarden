// @chartwarden/db — M17's organization-settings contributions (M1 Foundation §3.15.1).
//
// Same contribution pattern as settings-by-m3.ts / settings-by-m5.ts — the key belongs to M17
// here, since it's M17's own pre-schedule-gate policy (GAP-030 follow-up).
import { Type } from "@sinclair/typebox";
import type { ModuleSettingsContribution } from "./types";

export const M17_ORGANIZATION_SETTINGS: ModuleSettingsContribution = [
  {
    settingsKey: "allow_unassigned_pool_assignment",
    registeredByModule: "m17",
    description:
      "§4.7 D8 predicate 4 (within_caseload_or_unassigned_pool): when true, any active clinician " +
      "may be assigned a visit regardless of caseload membership (an 'unassigned pool' staffing " +
      "model); when false (the default), an assignment must be to a clinician already in the " +
      "patient's caseload.",
    typeBoxSchema: Type.Boolean(),
    uniqueAcrossTenants: false,
    defaultValue: false,
    required: false,
  },
];
