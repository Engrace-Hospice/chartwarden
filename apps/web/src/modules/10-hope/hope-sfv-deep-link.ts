// apps/web/src/modules/10-hope — the two ways back to an SFV the clinician meant to complete, both of which open the
// completion dialog once the screen can say it is offerable:
//   • the SFV queue's Complete link, which lands on the triggering assessment with `?completeSfv=1`;
//   • a return from /step-up with a stashed, unsent form (`hope-sfv-draft.ts`).
// The dialog is opened at most once per record per visit, whichever path asks first.
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { peekStepUpDraft } from "../../shell/step-up-redirect";
import { useStepUpOwner, useStepUpReturn } from "../../shell/use-step-up-return";
import { COMPLETE_SFV_PARAM } from "./hope-paths";
import { SFV_DRAFT_ACTIONS, type SfvDraft, sfvDraftKey } from "./hope-sfv-draft";
import type { SfvLookup } from "./hope-sfv-lookup";

interface SfvDeepLinkInputs {
  /** The record the route names (the screen may still hold the previous record's data for a moment). */
  readonly routeId: string | undefined;
  readonly assessment: { readonly id: string; readonly status: string } | null;
  readonly workspaceLoaded: boolean;
  /** A draft whose follow-up is required and not yet recorded: Complete SFV is on the card. */
  readonly draftOffer: boolean;
  /** Whether the screen asks the SFV queue about this record (a locked record whose follow-up is outstanding). */
  readonly lookupWanted: boolean;
  readonly lookup: SfvLookup;
  /** Reveals the follow-up card and opens the dialog. */
  readonly show: () => void;
}

/** Whether a locked (non-draft) record's queue row says the visit can still be completed. */
function lookupOffers(lookup: SfvLookup): boolean {
  return lookup.state === "found" && (lookup.status === "open" || lookup.status === "overdue");
}

export function useSfvDeepLink(inputs: SfvDeepLinkInputs): void {
  const { routeId, assessment, workspaceLoaded, draftOffer, lookupWanted, lookup, show } = inputs;
  const owner = useStepUpOwner();
  const returningFromStepUp = useStepUpReturn(owner, SFV_DRAFT_ACTIONS);
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get(COMPLETE_SFV_PARAM) === "1";
  const ready = routeId !== undefined && assessment?.id === routeId && workspaceLoaded;
  const status = assessment?.status;

  // Keyed by record, so a visit to another record starts clean.
  const shownFor = useRef<string | null>(null);
  const showOnce = (): void => {
    if (!routeId || shownFor.current === routeId) return;
    shownFor.current = routeId;
    show();
  };

  const returnedFor = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: showOnce is recreated every render but only reads refs, routeId and `show`; routeId and `show` are in the dependency list (`show` changes with the workspace, which re-runs this), and the per-record refs stop a re-run from firing twice.
  useEffect(() => {
    if (!ready || !returningFromStepUp || !owner || !routeId || returnedFor.current === routeId)
      return;
    returnedFor.current = routeId;
    if (peekStepUpDraft<SfvDraft>(sfvDraftKey(owner, routeId)) !== null) showOnce();
  }, [ready, returningFromStepUp, owner, routeId, show]);

  // The Complete link is consumed only once the screen has what it needs to decide: the workspace, and for a locked
  // record the queue's answer. A failed lookup keeps it, so Retry (or a reload) can still open the dialog; a failed
  // load keeps it too, until the screen has loaded.
  const linkedFor = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: showOnce is recreated every render but only reads refs, routeId and `show`; routeId and `show` are in the dependency list (`show` changes with the workspace, which re-runs this), and the per-record refs stop a re-run from firing twice.
  useEffect(() => {
    if (!requested || !ready || !routeId || linkedFor.current === routeId) return;
    const locked = status !== "draft";
    if (locked && lookupWanted && (lookup.state === "loading" || lookup.state === "failed")) return;
    linkedFor.current = routeId;
    if (locked ? lookupWanted && lookupOffers(lookup) : draftOffer) showOnce();
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(COMPLETE_SFV_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [requested, ready, routeId, status, lookupWanted, lookup, draftOffer, show, setSearchParams]);
}
