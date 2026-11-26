import { Glyph, InlineAlert, StatusPill, useRestoreFocus } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { PlatformSupportAccess, Workspace } from "../doclens-api";
import { docTypeLabel, identityNeedsAnswer } from "../doclens-model";
import { settle } from "./review-decision-flow";
import type { SafeguardFocus, SafeguardSelection } from "./review-exception-tasks";
import { IdentityTask } from "./review-identity-task";
import { revealSafeguardBlock, safeguardBlockId } from "./review-safeguard-focus";
import { SafeguardSource, SupportBanner } from "./review-safeguard-parts";
import { SudTask } from "./review-sud-task";
import type { SourceZoom } from "./source-viewer";
import { useSourceImage } from "./use-source-image";
import "./unified-review-panels.css";

/** What the reviewer must do to unlock a safeguard's resolution; null when nothing but a save in flight blocks it. */
function lockedReason(state: {
  supportAccess: boolean;
  complete: boolean;
  ownedByAnother: boolean;
  refreshPending: boolean;
  /** The page whose image must be showing before the safeguard can be resolved; null when it already is. */
  waitingForPage: number | null;
}): string | null {
  if (state.supportAccess)
    return "Read-only support session: a tenant reviewer resolves safeguards.";
  if (state.complete) return "The review is complete; safeguards are read-only.";
  if (state.ownedByAnother) return "Another reviewer owns this review.";
  if (state.refreshPending) return "Retry the workspace refresh before resolving a safeguard.";
  return state.waitingForPage === null
    ? null
    : `Resolution unlocks once source page ${state.waitingForPage} is showing.`;
}

export function ReviewSafeguardPanel({
  workspace,
  selection,
  onFocusBlock,
  refresh,
  supportAccess,
  zoom: zoomFromParent,
  onZoomChange: onZoomChangeFromParent,
  onBusyChange,
}: {
  workspace: Workspace;
  /** The page and block the parent has open; each new object is a new request, even for the same block. */
  selection: SafeguardSelection | null;
  /** The reviewer chose the source of a block from inside the panel: the parent keeps the list in step. */
  onFocusBlock: (focus: SafeguardFocus, page: number) => void;
  refresh: () => Promise<Workspace | null>;
  supportAccess?: PlatformSupportAccess | null;
  /** The source zoom, kept by the workspace so it survives a change of task; "fit" when absent. */
  zoom?: SourceZoom;
  onZoomChange?: (zoom: SourceZoom) => void;
  /** True while a safeguard save is in flight, so the workspace does not switch task under it. */
  onBusyChange?: (busy: boolean) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localZoom, setLocalZoom] = useState<SourceZoom>("fit");
  const zoom = zoomFromParent ?? localZoom;
  const onZoomChange = onZoomChangeFromParent ?? setLocalZoom;
  const selectedPage = selection?.page ?? null;
  const current = selection?.focus ?? null;
  const flagged = workspace.documents.filter(identityNeedsAnswer);
  const sudPage = workspace.sud.indicators[0]?.page ?? null;
  const [activePage, setActivePage] = useState<number | null>(
    selectedPage ?? sudPage ?? flagged[0]?.pageFrom ?? null,
  );
  const rootRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // A resolved safeguard's controls unmount; keep keyboard focus on the panel instead of the page body.
  const captureFocus = useRestoreFocus(busy, () => headingRef.current);
  const setPending = (pending: boolean): void => {
    if (pending) captureFocus();
    setBusy(pending);
    onBusyChange?.(pending);
  };
  const source = useSourceImage({
    batchId: workspace.batch.id,
    page: activePage,
    access: supportAccess,
    withheld: workspace.sud.contentRedacted,
    resetKey: String(activePage),
  });

  useEffect(() => {
    if (selectedPage !== null) setActivePage(selectedPage);
  }, [selectedPage]);
  useEffect(() => {
    // Only a deliberate choice scrolls and focuses; a restore or an in-panel click just marks the block.
    if (!selection?.reveal || !selection.focus) return;
    const block = rootRef.current?.querySelector<HTMLElement>(
      `[data-safeguard-block="${safeguardBlockId(selection.focus)}"]`,
    );
    if (block) revealSafeguardBlock(block);
  }, [selection]);

  const complete =
    workspace.review?.status === "complete" || workspace.batch.status === "writeback_complete";
  const ownedByAnother = workspace.review?.status === "in_progress" && !workspace.review.isMine;
  const disabled = Boolean(supportAccess) || busy || refreshPending || complete || ownedByAnother;
  const evidenceReadyFor = (page: number | null): boolean =>
    page !== null && activePage === page && source.state === "ready";
  const reasonFor = (page: number | null): string | null =>
    lockedReason({
      supportAccess: Boolean(supportAccess),
      complete,
      ownedByAnother: Boolean(ownedByAnother),
      refreshPending,
      waitingForPage: evidenceReadyFor(page) ? null : page,
    });

  async function refreshSafeguards(): Promise<Workspace | null> {
    const latest = await settle(refresh);
    setRefreshPending(latest === null);
    if (latest) setError(null);
    return latest;
  }
  const retryRefresh = async (): Promise<void> => {
    setPending(true);
    await refreshSafeguards();
    setPending(false);
  };
  const showSource = (page: number, focus: SafeguardFocus): void => {
    setActivePage(page);
    onFocusBlock(focus, page);
  };

  return (
    <section
      ref={rootRef}
      className="wx-unified-safeguards"
      aria-labelledby="unified-safeguards-title"
    >
      <header>
        <div>
          <span className="wx-unified-category">Clinical safeguards</span>
          <h2 ref={headingRef} id="unified-safeguards-title" tabIndex={-1} data-task-heading>
            Documents & protected information
          </h2>
        </div>
      </header>
      {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
      {supportAccess ? <SupportBanner /> : null}
      {refreshPending ? (
        <button
          type="button"
          className="wx-btn-secondary"
          disabled={busy}
          onClick={() => void retryRefresh()}
        >
          <Glyph name="rotate-ccw" size={16} /> Retry workspace refresh
        </button>
      ) : null}

      <SafeguardSource
        workspace={workspace}
        source={source}
        activePage={activePage}
        zoom={zoom}
        onZoomChange={onZoomChange}
      />

      <SudTask
        workspace={workspace}
        activePage={activePage}
        current={current?.kind === "sud"}
        busy={busy}
        disabled={disabled || !evidenceReadyFor(sudPage)}
        blockedReason={reasonFor(sudPage)}
        onReviewSource={(page) => showSource(page, { kind: "sud" })}
        onBusy={setPending}
        onError={setError}
        onSaved={refreshSafeguards}
      />

      {flagged.length === 0 ? (
        <div className="wx-unified-safeguard-task">
          <strong>Patient identity</strong>
          <StatusPill label="No unresolved documents" tone="success" />
        </div>
      ) : (
        flagged.map((document) => (
          <IdentityTask
            key={document.pageFrom}
            workspace={workspace}
            pageFrom={document.pageFrom}
            title={`${docTypeLabel(document.documentType)} · page ${document.pageFrom}`}
            showingSource={activePage === document.pageFrom}
            current={current?.kind === "identity" && current.page === document.pageFrom}
            busy={busy}
            disabled={disabled || !evidenceReadyFor(document.pageFrom)}
            blockedReason={reasonFor(document.pageFrom)}
            onReviewSource={() =>
              showSource(document.pageFrom, { kind: "identity", page: document.pageFrom })
            }
            onError={setError}
            onBusy={setPending}
            onSaved={refreshSafeguards}
          />
        ))
      )}
    </section>
  );
}
