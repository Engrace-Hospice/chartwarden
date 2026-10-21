// apps/web/src/modules/07-care-plan — shared status→tone mapping for the M7 Care Plan screens.
// §6.6 badge taxonomy: care-plan lifecycle statuses (plan / version / problem / goal / intervention)
// map to a StatusPill tone. The server owns every status; the UI only chooses a tone. Unknown values
// fall back to neutral. Imported by care-plan-view + version-history so the mapping never diverges.
import type { StatusTone } from "@chartwarden/ui";

const STATUS_TONE: Record<string, StatusTone> = {
  draft: "neutral",
  proposed: "progress",
  pending: "progress",
  in_progress: "progress",
  revised: "progress",
  active: "success",
  signed: "success",
  met: "success",
  achieved: "success",
  resolved: "neutral",
  inactive: "neutral",
  closed: "neutral",
  superseded: "neutral",
  discontinued: "neutral",
};

export const toneFor = (s: string): StatusTone => STATUS_TONE[s] ?? "neutral";

export const cap = (s: string): string =>
  s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
