// apps/web/src/modules/08-encounters — the visit-note draft of one encounter, as the composer and the sign step hold it (ADR-0114).
//
//   off          the tenant has the draft switched off, or this viewer may not read it: the screen is exactly as it was before drafts
//   unavailable  a source could not be read (503) or nothing answered: say so, never pretend there is no draft
//   ready        the draft for THIS viewer; each section has a state the server decided
//
// The server is the only judge of a state. A resolve that answers 409 DRAFT_SECTION_STALE means the clinician acted on text that is no
// longer the text there is: nothing was recorded, so the whole draft is re-read and the section says so. The draft is never cached
// across encounters or viewers: it is re-read on mount and whenever the caller says what it is built from changed (a save, a link).
import { useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DraftSectionView,
  type DraftView,
  type Outcome,
  type Resolution,
  SECTION_STALE_CODE,
  describeDraftRefusal,
  loadDraft,
  resolveDraftSection,
} from "./draft-api";
import { type SectionNote, replaceSection, resolutionNote } from "./draft-model";
import { useIsMounted } from "./use-is-mounted";

export type DraftLoad =
  | { readonly status: "loading" }
  | { readonly status: "off" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly draft: DraftView };

export interface NoteDraft {
  readonly load: DraftLoad;
  /** The section whose resolve is in flight (one at a time), else null. */
  readonly busySectionId: string | null;
  /** What the last action on each section said; cleared whenever the draft is re-read. */
  readonly notes: Readonly<Record<string, SectionNote>>;
  /** Re-read the draft (after a save or a link changed what it is built from). */
  readonly reload: () => Promise<void>;
  /** Confirm or deselect one drafted section. True when the server recorded it. */
  readonly resolve: (section: DraftSectionView, resolution: Resolution) => Promise<boolean>;
}

const NOT_ALLOWED_STATUSES: readonly number[] = [403, 404];

function loadStateOf(outcome: Outcome<DraftView>): DraftLoad {
  // A 200 that is not a draft (no sections list) is a broken answer, not an empty draft.
  if (outcome.ok) {
    return Array.isArray(outcome.data.sections)
      ? { status: "ready", draft: outcome.data }
      : { status: "unavailable" };
  }
  return NOT_ALLOWED_STATUSES.includes(outcome.status)
    ? { status: "off" }
    : { status: "unavailable" };
}

export function useNoteDraft(encounterId: string | undefined): NoteDraft {
  const client = useApiClient();
  const mounted = useIsMounted();
  const [load, setLoad] = useState<DraftLoad>({ status: "loading" });
  const [busySectionId, setBusySectionId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Readonly<Record<string, SectionNote>>>({});
  const sequence = useRef(0);
  const inFlight = useRef(false);

  const reload = useCallback(async (): Promise<void> => {
    if (!encounterId) return;
    const mine = ++sequence.current;
    setNotes({});
    const outcome = await loadDraft(client, encounterId);
    if (mine === sequence.current) setLoad(loadStateOf(outcome));
  }, [client, encounterId]);

  useEffect(() => {
    setLoad({ status: "loading" });
    void reload();
    return () => {
      sequence.current += 1;
    };
  }, [reload]);

  const resolve = useCallback(
    async (section: DraftSectionView, resolution: Resolution): Promise<boolean> => {
      if (!encounterId || inFlight.current) return false;
      inFlight.current = true;
      setBusySectionId(section.sectionId);
      setNotes(({ [section.sectionId]: _gone, ...rest }) => rest);
      const noteFor = (sectionId: string, note: SectionNote): void =>
        setNotes((current) => ({ ...current, [sectionId]: note }));
      const outcome = await resolveDraftSection(client, encounterId, section, resolution);
      inFlight.current = false;
      if (!mounted.current) return false;
      setBusySectionId(null);
      if (outcome.ok) {
        setLoad((current) =>
          current.status === "ready"
            ? { status: "ready", draft: replaceSection(current.draft, outcome.data) }
            : current,
        );
        noteFor(section.sectionId, resolutionNote(resolution, section, outcome.data));
        return true;
      }
      if (outcome.status === 404) {
        setLoad({ status: "off" });
        return false;
      }
      const failure = describeDraftRefusal(outcome);
      if (failure.code === SECTION_STALE_CODE) {
        await reload();
        if (mounted.current) noteFor(section.sectionId, { tone: "warning", text: failure.message });
        return false;
      }
      noteFor(section.sectionId, { tone: "error", text: failure.message });
      return false;
    },
    [client, encounterId, mounted, reload],
  );

  return { load, busySectionId, notes, reload, resolve };
}
