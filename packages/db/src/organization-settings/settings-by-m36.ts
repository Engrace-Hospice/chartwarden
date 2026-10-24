// @chartwarden/db - M36's organization-settings contribution (M1 Foundation §3.15.1), ADR-0085 (PROPOSED) slice G1.
//
// Same contribution pattern as settings-by-m3.ts. The key belongs to M36, the registry is M1's. Nothing reads it until slice G2 issues grants.
import { Type } from "@sinclair/typebox";
import type { ModuleSettingsContribution } from "./types";

export const THREAD_ACCESS_GRANT_HOURS_KEY = "thread_access_grant_hours";
/** PLACEHOLDER mirroring the M3 break-glass +4h; no clinical lead has set it (ADR-0085 decision 5). */
export const THREAD_ACCESS_GRANT_HOURS_DEFAULT = 4;
export const THREAD_ACCESS_GRANT_HOURS_MIN = 1;
/** The database caps `expires_at` at `granted_at` + 7 days (migration 1135 CHECK); the setting may never exceed it. */
export const THREAD_ACCESS_GRANT_HOURS_MAX = 168;

export const M36_ORGANIZATION_SETTINGS: ModuleSettingsContribution = [
  {
    settingsKey: THREAD_ACCESS_GRANT_HOURS_KEY,
    registeredByModule: "m36",
    description:
      "ADR-0085: how many hours a one-thread read grant lasts for an escalated assignee who cannot view the channel " +
      "(whole hours, 1 to 168; the database independently caps a grant at 7 days). Tenant policy, never a request field. " +
      "Placeholder default 4; unused until the grant wiring (slice G2) and the flag `messaging.thread_access_grant`.",
    typeBoxSchema: Type.Integer({
      minimum: THREAD_ACCESS_GRANT_HOURS_MIN,
      maximum: THREAD_ACCESS_GRANT_HOURS_MAX,
    }),
    uniqueAcrossTenants: false,
    defaultValue: THREAD_ACCESS_GRANT_HOURS_DEFAULT,
    required: false,
  },
];
