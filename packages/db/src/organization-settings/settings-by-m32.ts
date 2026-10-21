// @chartwarden/db — M32's organization-settings contributions (M1 Foundation §3.15.1; F-236).
//
// `ai_token_budgets` is the monthly per-capability token budget the M32 invocation pipeline's cap gate
// reads. M32 §1.1 places the figure on the tenant's configuration and names no platform default, so the
// default here is `null` — which the cap gate answers as `budget_unconfigured` and REFUSES (token-cap.ts):
// an absent bound never becomes an unbounded one. A capability missing from a configured map is likewise
// unconfigured, not unlimited.
import { Type } from "@sinclair/typebox";
import type { ModuleSettingsContribution } from "./types";

export const M32_ORGANIZATION_SETTINGS: ModuleSettingsContribution = [
  {
    settingsKey: "ai_token_budgets",
    registeredByModule: "m32",
    description:
      "Per-capability monthly AI token budgets: { <capability_key>: { hardCapTokens, softCapTokens? } }. " +
      "Absent (the default) or a capability missing from the map ⇒ that capability refuses at the M32 " +
      "token-cap gate (budget_unconfigured). softCapTokens defaults to 80% of the hard cap.",
    typeBoxSchema: Type.Union([
      Type.Null(),
      Type.Record(
        Type.String({ pattern: "^[a-z0-9_]+$" }),
        Type.Object(
          {
            hardCapTokens: Type.Integer({ minimum: 1 }),
            softCapTokens: Type.Optional(Type.Integer({ minimum: 1 })),
          },
          { additionalProperties: false },
        ),
      ),
    ]),
    uniqueAcrossTenants: false,
    defaultValue: null,
    required: false,
  },
];
