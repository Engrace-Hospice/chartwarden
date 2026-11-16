// apps/web/src/modules/10-hope — the assessment screen's Symptom Follow-Up Visit flow: whether the completion dialog is
// open, what the SFV queue says about a locked record, and what happens once a visit has been recorded (re-read the
// screen, say so if that fails, and put focus on the follow-up card once it shows the result).
import { useCallback, useEffect, useState } from "react";
import { useSfvDeepLink } from "./hope-sfv-deep-link";
import { useSfvOfSignedRecord } from "./hope-sfv-lookup";
import { SFV_SECTION_ID, type SfvSectionItem, sfvStateOf } from "./hope-sfv-section";
import { scrollWithinWorkspace } from "./use-hope-workspace-scrolling";

interface FlowInputs {
  /** The record the route names. */
  readonly routeId: string | undefined;
  readonly assessment: { readonly id: string; readonly status: string } | null;
  readonly workspace: {
    readonly sections: ReadonlyArray<{
      readonly code: string;
      readonly items: readonly SfvSectionItem[];
    }>;
  } | null;
  /** Re-reads the screen; false when any of it could not be read. Never rejects. */
  readonly refresh: () => Promise<boolean>;
  /** Shows the follow-up card (its section and group), so the dialog opens over the place it will report to. */
  readonly revealCard: () => void;
}

const REFRESH_FAILED =
  "The follow-up visit was recorded, but this page could not refresh. Reload to see it.";

export function useSfvFlow(inputs: FlowInputs) {
  const { routeId, assessment, workspace, refresh, revealCard } = inputs;
  const [open, setOpen] = useState(false);
  // Bumped when a visit is recorded, so a locked record re-reads its follow-up's status from the queue.
  const [lookupKey, setLookupKey] = useState(0);
  // Bumped once the recorded visit is on screen, so the follow-up card takes the focus the dialog's button had.
  const [focusKey, setFocusKey] = useState(0);
  const [focusDue, setFocusDue] = useState(false);
  // Bumped when the dialog closes with nothing recorded, so the card can take focus back if nothing else has it.
  const [returnFocusKey, setReturnFocusKey] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const jItems = workspace?.sections.find((section) => section.code === "J")?.items ?? [];
  const { completed, required } = sfvStateOf(jItems);
  // A record that is not a draft (signed, or superseded by a correction) is read-only: its own J2052/J2053 never say
  // whether the visit happened since, so the SFV queue does.
  const locked = assessment !== null && assessment.status !== "draft";
  const lookupWanted = locked && required && !completed;
  const { lookup, retry: retryLookup } = useSfvOfSignedRecord(
    assessment?.id ?? "",
    lookupWanted,
    lookupKey,
  );

  const show = useCallback(() => {
    revealCard();
    setOpen(true);
  }, [revealCard]);
  // Show-all puts every section on one page, so the card the dialog reports to may be far off screen behind it. Scrolled
  // through the workspace's own scroller, which keeps it clear of the sticky jump bar.
  useEffect(() => {
    const card = document.getElementById(SFV_SECTION_ID);
    if (open && card) scrollWithinWorkspace(card, "nearest");
  }, [open]);
  useSfvDeepLink({
    routeId,
    assessment,
    workspaceLoaded: workspace !== null,
    draftOffer: !locked && required && !completed,
    lookupWanted,
    lookup,
    show,
  });

  const complete = useCallback(async () => {
    setOpen(false);
    setLookupKey((key) => key + 1);
    setNotice((await refresh()) ? null : REFRESH_FAILED);
    setFocusDue(true);
  }, [refresh]);

  // Focus waits for the answer the card will show: a locked record's queue row is re-read after a completion, and
  // moving focus before it settles would land on a card that still says "Required".
  useEffect(() => {
    if (!focusDue || (lookupWanted && lookup.state === "loading")) return;
    setFocusDue(false);
    setFocusKey((key) => key + 1);
  }, [focusDue, lookupWanted, lookup.state]);

  return {
    open,
    show,
    close: useCallback(() => {
      setOpen(false);
      setReturnFocusKey((key) => key + 1);
    }, []),
    complete,
    locked,
    lookup,
    retryLookup,
    focusKey,
    returnFocusKey,
    notice,
  };
}
