// @wardenx/db — M3's organization-settings contributions (M1 Foundation §3.15.1).
//
// Same contribution pattern as `settings-by-m5.ts`: the key belongs to M3, the registry is M1's.
import { Type } from "@sinclair/typebox";
import type { ModuleSettingsContribution } from "./types";

export const M3_ORGANIZATION_SETTINGS: ModuleSettingsContribution = [
  {
    settingsKey: "breakglass_cosign_required",
    registeredByModule: "m3",
    description:
      "When true, a §7.4 break-glass invocation opens as `cosign_pending` (no access until a " +
      "second party co-signs) instead of `active`. Tenant policy — never the caller's request: " +
      "letting the invoker choose lets one permission self-issue an un-cosigned emergency grant.",
    typeBoxSchema: Type.Boolean(),
    uniqueAcrossTenants: false,
    // Default FALSE, deliberately. `cosign_pending` grants no access (the checker requires
    // status='active'), so defaulting to true would withhold emergency chart access until a
    // co-signer acts — the opposite of what break-glass exists for. A tenant that wants the
    // stricter posture opts in; the safety property fixed here is that the CALLER cannot choose.
    defaultValue: false,
    required: false,
  },
];
