// @chartwarden/db — M5's organization-settings contributions (M1 Foundation §3.15.1).
//
// The contribution file lives in M1's foundation registry (schema-adjacent, M1-owned)
// even though the key belongs to M5: M1 hosts the single registry + the one
// `validate_organization_settings()` trigger, and modules append their declarations
// here (mirroring the seam/event-catalog contribution pattern). This is data, not a
// cross-module schema import — no module boundary is crossed.
import { Type } from "@sinclair/typebox";
import type { ModuleSettingsContribution } from "./types";

export const M5_ORGANIZATION_SETTINGS: ModuleSettingsContribution = [
  {
    settingsKey: "hl7_internal_mrn_authority",
    registeredByModule: "m5",
    description: "HL7 v2 PID-3.4 assigning authority code for this tenant's internal MRNs",
    typeBoxSchema: Type.String({ minLength: 1, maxLength: 64 }),
    uniqueAcrossTenants: true,
    defaultValue: null,
    required: false,
  },
];
