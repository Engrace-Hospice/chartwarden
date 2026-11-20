// apps/web/src/modules/08-encounters — the visit-note draft of one encounter, as the composer and the sign step hold it (ADR-0114).
//
//   off          the tenant has the draft switched off, or this viewer may not read it: the screen is exactly as it was before drafts
//   unavailable  a source could not be read (503), nothing answered, or the answer is not a draft: say so, never pretend there is no draft
//   notAuthor    an amending addendum's draft read by anyone but its author (403): the screen says so in its own words
//   ready        the draft for THIS viewer; each section has a state the server decided
//
// The server is the only judge of a state. A resolve that answers 409 DRAFT_SECTION_STALE means the clinician acted on text that is no
// longer the text there is: nothing was recorded, so the whole draft is re-read and the section says so. The draft is never cached
// across encounters or viewers: it is re-read on mount and whenever the caller says what it is built from changed (a save, a link).
//
// ORDER. Two things may answer out of order, and neither may put an older picture over a newer one:
//   - a resolve whose encounter changed (or whose screen closed) before it answered: its answer belongs to a draft that is no longer
//     shown, so it writes nothing (`epoch`);
//   - a re-read asked for while a resolve is in flight: a GET served before the PUT commits could answer after it, so the re-read waits
//     for the resolve to land and then reads once (`rereadAfterResolve`).
import { useApiClient } from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { amendedSectionNote } from "./amendment-model";
import {
  type DraftSectionView,
  type DraftView,
  type Outcome,
  type Resolution,
  SECTION_STALE_CODE,
  describeDraftRefusal,
  loadAmendmentDraft,
  loadDraft,
  resolveAmendmentSection,
  resolveDraftSection,
} from "./draft-api";
import {
  type DraftLoad,
  type SectionNote,
  isDraftSectionView,
  notAuthorRefusal,
  replaceSection,
  resolutionNote,
} from "./draft-model";

export type { DraftLoad };

export interface NoteDraft {
  readonly load: DraftLoad;
  /** The section whose resolve is in flight (one at a time), else null. */
  readonly busySectionId: string | null;
  /** What the last action on each section said; cleared whenever the draft is re-read. */
  readonly notes: Readonly<Record<string, SectionNote>>;
  /** A re-read of the draft is in flight: the text on screen may be about to change, so nothing should be resolved against it. */
  readonly refreshing: boolean;
  /**
   * Re-read the draft (after a save or a link changed what it is built from). Resolves to what the screen now knows of it, or null when this
   * read was not the one that counted (another was already out, or the screen moved on): then it says nothing about the outcome.
   */
  readonly reload: () => Promise<DraftLoad | null>;
  /** Confirm or deselect one drafted section. True when the server recorded it. */
  readonly resolve: (section: DraftSectionView, resolution: Resolution) => Promise<boolean>;
}

const NOT_ALLOWED_STATUSES: readonly number[] = [403, 404];
const FORBIDDEN_CODE = "FORBIDDEN";
const FORBIDDEN_STATUS = 403;

function loadStateOf(outcome: Outcome<DraftView>, amending: boolean): DraftLoad {
  if (outcome.ok) {
    // A 200 that is not a draft (no sections list, or a section the screens cannot read) is a broken answer, not an empty draft.
    const sections: unknown = outcome.data?.sections;
    return Array.isArray(sections) && sections.every(isDraftSectionView)
      ? { status: "ready", draft: outcome.data }
      : { status: "unavailable" };
  }
  // An addendum's draft is read by its author only: a 403 there is "not yours", never the tenant switch or a missing role, and its words
  // are the app's (the server's text is not kept).
  if (amending && outcome.status === FORBIDDEN_STATUS) return { status: "notAuthor" };
  return NOT_ALLOWED_STATUSES.includes(outcome.status)
    ? { status: "off" }
    : { status: "unavailable" };
}

/**
 * `refreshKey` re-reads the draft when it changes (a note that moved from draft to finalized pins its text); `encounterId` undefined reads
 * nothing yet (a page that does not know its encounter until it has loaded it). With `addendumId` the draft is that amending addendum's
 * own (S1 PR E3, VN-D30): its named sections only, read and resolved through the addendum's routes, never the note's.
 */
export function useNoteDraft(
  encounterId: string | undefined,
  refreshKey = "",
  addendumId?: string,
): NoteDraft {
  const client = useApiClient();
  const [load, setLoad] = useState<DraftLoad>({ status: "loading" });
  const [busySectionId, setBusySectionId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Readonly<Record<string, SectionNote>>>({});
  const [refreshing, setRefreshing] = useState(false);
  const sequence = useRef(0);
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const rereadAfterResolve = useRef(false);
  // A read is out (the `refreshing` state, readable inside `resolve` without waiting for a render): nothing is resolved against text that
  // is about to change.
  const reading = useRef(false);

  const reload = useCallback(async (): Promise<DraftLoad | null> => {
    if (!encounterId) return null;
    if (inFlight.current) {
      rereadAfterResolve.current = true;
      return null;
    }
    const mine = ++sequence.current;
    setNotes({});
    reading.current = true;
    setRefreshing(true);
    const outcome = await (addendumId === undefined
      ? loadDraft(client, encounterId)
      : loadAmendmentDraft(client, encounterId, addendumId));
    if (mine !== sequence.current) return null;
    reading.current = false;
    setRefreshing(false);
    const next = loadStateOf(outcome, addendumId !== undefined);
    setLoad(next);
    return next;
  }, [client, encounterId, addendumId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refreshKey` is the re-read trigger, not read in the body.
  useEffect(() => {
    setLoad({ status: "loading" });
    reading.current = false;
    setRefreshing(false);
    void reload();
    return () => {
      sequence.current += 1;
    };
  }, [reload, refreshKey]);

  // A resolve belongs to the encounter, addendum (and the screen) it started in. When either goes, its answer is stale: it must write nothing,
  // and the guard it held must not outlive it (a resolve the next encounter starts is its own).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `encounterId` and `addendumId` are the triggers for the cleanup, not read in the body.
  useEffect(
    () => () => {
      epoch.current += 1;
      inFlight.current = false;
      rereadAfterResolve.current = false;
      setBusySectionId(null);
    },
    [encounterId, addendumId],
  );

  const resolve = useCallback(
    async (section: DraftSectionView, resolution: Resolution): Promise<boolean> => {
      if (!encounterId || inFlight.current || reading.current) return false;
      const startedIn = epoch.current;
      const stillHere = (): boolean => startedIn === epoch.current;
      inFlight.current = true;
      setBusySectionId(section.sectionId);
      setNotes(({ [section.sectionId]: _gone, ...rest }) => rest);
      const noteFor = (sectionId: string, note: SectionNote): void =>
        setNotes((current) => ({ ...current, [sectionId]: note }));
      const outcome = await (addendumId === undefined
        ? resolveDraftSection(client, encounterId, section, resolution)
        : resolveAmendmentSection(client, encounterId, addendumId, section, resolution));
      if (!stillHere()) return false;
      inFlight.current = false;
      setBusySectionId(null);
      const rereadAsked = rereadAfterResolve.current;
      rereadAfterResolve.current = false;
      if (outcome.ok) {
        setLoad((current) =>
          current.status === "ready"
            ? { status: "ready", draft: replaceSection(current.draft, outcome.data) }
            : current,
        );
        if (rereadAsked) await reload();
        if (stillHere()) {
          const amended = addendumId === undefined ? null : amendedSectionNote(outcome.data.state);
          noteFor(section.sectionId, amended ?? resolutionNote(resolution, section, outcome.data));
        }
        return stillHere();
      }
      if (outcome.status === 404) {
        setLoad({ status: "off" });
        return false;
      }
      const failure = describeDraftRefusal(outcome);
      if (failure.code === SECTION_STALE_CODE) {
        await reload();
        if (stillHere()) noteFor(section.sectionId, { tone: "warning", text: failure.message });
        return false;
      }
      if (rereadAsked) await reload();
      // Only the author may resolve (403 FORBIDDEN): worded for the act, not as a general lack of access. Nothing was recorded, so the section stays as it was.
      const text =
        failure.code === FORBIDDEN_CODE
          ? notAuthorRefusal(addendumId !== undefined)
          : failure.message;
      if (stillHere()) noteFor(section.sectionId, { tone: "error", text });
      return false;
    },
    [client, encounterId, addendumId, reload],
  );

  return { load, busySectionId, notes, refreshing, reload, resolve };
}
