// M36 WP 3.4 - whether the tenant has tasks turned on, read from the org's resolved flags (no request per message row;
// the same source as the SBAR and presence gates). No provider mounted reads as OFF. The server stays the authority:
// with the flag off its task routes answer 404, so a stale "on" here only shows a trigger that then fails politely.
import { useFeatureFlag } from "@wardenx/ui";

export const TASKS_FLAG_KEY = "messaging.tasks";

export function useTasksEnabled(): boolean {
  try {
    return useFeatureFlag(TASKS_FLAG_KEY);
  } catch {
    return false;
  }
}
