// apps/web/src/modules/08-encounters — the sections of a signed note this viewer may name in an amending addendum (ADR-0114 VN-D30). Offered
// only when the draft is on for this viewer (the same read the composer holds), the note has sealed sections, and the session does not show
// the viewer to be neither the note's author nor a supervisor (the server refuses them 403; a viewer it cannot tell is offered the choice
// and told in words if refused). Moved out of encounter-read.tsx unchanged.
import { useSession } from "../../shell/session";
import { mayNameSections } from "./amendment-model";
import type { DraftLoad } from "./draft-model";
import {
  type AmendableSection,
  type FinalDocumentationView,
  amendableSections,
} from "./signed-note-model";

export function useAmendableSections(
  draftLoad: DraftLoad,
  note: {
    readonly authoredByUserId: string;
    readonly finalDocumentationView?: FinalDocumentationView | null;
  } | null,
): readonly AmendableSection[] {
  const session = useSession();
  return note !== null &&
    draftLoad.status === "ready" &&
    mayNameSections(session, note.authoredByUserId)
    ? amendableSections(note.finalDocumentationView)
    : [];
}
