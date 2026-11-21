// apps/web/src/modules/08-encounters/review — whether the late-entry reason field is on screen. A refused finalize that asked for a reason
// shows it, and it STAYS for the note: the next finalize clears the refusal while it is in flight, and a field that left the page for
// that moment would come back as a new one (a layout shift, and the "left it too short" state it had learned gone).
import { useState } from "react";
import { type GateAttempt, asksForLateEntryReason } from "./refusal-model";

/**
 * `noteId` is the note the attempt belongs to: another note starts without the field. A reason typed ahead of any request also shows it.
 */
export function useLateEntryReasonShown(
  attempt: GateAttempt,
  lateReason: string,
  noteId = "",
): boolean {
  const [askedOn, setAskedOn] = useState<string | null>(null);
  const asks = asksForLateEntryReason(attempt);
  if (asks && askedOn !== noteId) setAskedOn(noteId);
  // Another note (Back or Forward between composer URLs) starts clean: what one note was asked is not remembered on returning to it.
  else if (!asks && askedOn !== null && askedOn !== noteId) setAskedOn(null);
  return asks || askedOn === noteId || lateReason !== "";
}
