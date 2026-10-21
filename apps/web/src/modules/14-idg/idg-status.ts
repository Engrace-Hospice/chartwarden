// apps/web/src/modules/14-idg — shared IDG presentation helpers (R1, Lantern).
// The §2.2 meeting, §1.1 action-item, and D10 minutes enums each map to the §6.6 badge taxonomy tone
// (grounded in the @chartwarden/types unions) so every M14 surface renders the same StatusPill for a state.
import type { StatusTone } from "@chartwarden/ui";

// IdgMeetingStatus = scheduled | packets_building | packets_ready | live | adjourned | cancelled | rescheduled.
export const MEETING_TONE: Record<string, StatusTone> = {
  scheduled: "progress",
  packets_building: "progress",
  packets_ready: "success",
  live: "progress",
  adjourned: "success",
  cancelled: "error",
  rescheduled: "neutral",
};

// IdgActionItemStatus = open | in_progress | completed | cancelled | auto_closed.
export const ACTION_TONE: Record<string, StatusTone> = {
  open: "warning",
  in_progress: "progress",
  completed: "success",
  cancelled: "neutral",
  auto_closed: "success",
};

// IdgMinutesStatus = in_progress | final.
export const MINUTES_TONE: Record<string, StatusTone> = {
  in_progress: "progress",
  final: "success",
};

/** Title-case an underscore enum value, e.g. `packets_building` → `Packets Building`. */
export function stateLabel(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
