// apps/backend/src/modules/36-messaging/afterhours-triage/afterhours-flag.ts - ADR-0082 decision 8: `messaging.afterhours_triage` (absent = off)
// AND the four flags it needs. Read through the platform flag reader, cached a few seconds per org. A read error propagates.
import {
  AFTERHOURS_TRIAGE_FLAG_KEY,
  AFTERHOURS_TRIAGE_REQUIRED_FLAG_KEYS,
} from "@chartwarden/types";
import { cacheFlagRead } from "../presence/binding";

export type AfterHoursFlagReader = {
  forOrg(organizationId: string): Promise<Record<string, boolean>>;
};

export function buildAfterHoursEnabled(
  flags: AfterHoursFlagReader | undefined,
): (organizationId: string) => Promise<boolean> {
  return cacheFlagRead(async (organizationId) => {
    if (!flags) return false;
    const on = await flags.forOrg(organizationId);
    return [AFTERHOURS_TRIAGE_FLAG_KEY, ...AFTERHOURS_TRIAGE_REQUIRED_FLAG_KEYS].every(
      (key) => on[key] === true,
    );
  });
}
