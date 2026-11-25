// apps/web/src/modules/08-encounters/compose — the reason a scheduled visit's purpose suggests for the note (moved out of
// encounter-compose.tsx unchanged).
import { visitPurposeLabel } from "@chartwarden/types";
import type { ApiClient } from "@chartwarden/ui";
import { type Dispatch, type SetStateAction, useEffect } from "react";
import {
  type DraftSections,
  type EncounterView,
  type TemplateView,
  loadVisitPurpose,
  suggestedReasonCode,
} from "../encounters-api";
import { REASON_SECTION_ID, type ReasonSuggestion } from "./compose-model";

/**
 * A note that came from the schedule suggests the reason its visit purpose implies (a routine visit, an MSW or
 * chaplain assessment). Only into an empty Reason for Visit, and only as an unsaved choice: the clinician
 * confirms it by saving, or picks another.
 */
export function useVisitPurposeSuggestion(
  client: ApiClient,
  encounter: EncounterView | null,
  template: TemplateView | null,
  setDraft: Dispatch<SetStateAction<DraftSections>>,
  setSuggestion: Dispatch<SetStateAction<ReasonSuggestion | null>>,
): void {
  useEffect(() => {
    const visitId = encounter?.visitId;
    const reasonSection = template?.sections.find((s) => s.sectionId === REASON_SECTION_ID);
    if (encounter?.status !== "draft" || !visitId || reasonSection === undefined) return;
    let current = true;
    void loadVisitPurpose(client, visitId).then((purpose) => {
      if (!current || purpose === null) return;
      const code = suggestedReasonCode(purpose, reasonSection.entries);
      if (code === null) return;
      setDraft((prev) => {
        const held = prev[REASON_SECTION_ID];
        if (held !== undefined && (held.entries.length > 0 || held.freeText.trim() !== "")) {
          return prev;
        }
        setSuggestion({ code, from: visitPurposeLabel(purpose) ?? purpose });
        return {
          ...prev,
          [REASON_SECTION_ID]: { freeText: held?.freeText ?? "", entries: [{ code, params: {} }] },
        };
      });
    });
    return () => {
      current = false;
    };
  }, [client, encounter, template, setDraft, setSuggestion]);
}
