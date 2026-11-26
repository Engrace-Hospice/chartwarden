import { Glyph, StatusPill, useApiClient } from "@chartwarden/ui";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import type { PlatformSupportAccess, Workspace } from "../doclens-api";
import { pageImageUrl, resolveIdentity, resolveSud } from "../doclens-api";
import {
  MIN_REASON,
  PART2_WITHHELD_MESSAGE,
  bboxPercent,
  docTypeLabel,
  identityNeedsAnswer,
} from "../doclens-model";
import type { SafeguardFocus, SafeguardSelection } from "./review-exception-tasks";
import { revealSafeguardBlock, safeguardBlockId } from "./review-safeguard-focus";

export function ReviewSafeguardPanel({
  workspace,
  selection,
  onFocusBlock,
  refresh,
  supportAccess,
}: {
  workspace: Workspace;
  /** The page and block the parent has open; each new object is a new request, even for the same block. */
  selection: SafeguardSelection | null;
  /** The reviewer chose the source of a block from inside the panel: the parent keeps the list in step. */
  onFocusBlock: (focus: SafeguardFocus, page: number) => void;
  refresh: () => Promise<Workspace | null>;
  supportAccess?: PlatformSupportAccess | null;
}): JSX.Element {
  const client = useApiClient();
  const [busy, setBusy] = useState(false);
  const [refreshPending, setRefreshPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sudRejecting, setSudRejecting] = useState(false);
  const [sudReason, setSudReason] = useState("");
  const selectedPage = selection?.page ?? null;
  const current = selection?.focus ?? null;
  const flagged = workspace.documents.filter(identityNeedsAnswer);
  const preferredPage =
    selectedPage ?? workspace.sud.indicators[0]?.page ?? flagged[0]?.pageFrom ?? null;
  const [activePage, setActivePage] = useState<number | null>(preferredPage);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const [sourceState, setSourceState] = useState<"loading" | "ready" | "forbidden" | "unavailable">(
    () => (workspace.sud.contentRedacted ? "forbidden" : "loading"),
  );
  const [readyPage, setReadyPage] = useState<number | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const sourceGeneration = useRef(0);
  const sudPage = workspace.sud.indicators[0]?.page ?? null;
  useEffect(() => {
    if (selectedPage !== null) setActivePage(selectedPage);
  }, [selectedPage]);
  useEffect(() => {
    // Only a deliberate choice scrolls and focuses; a restore or an in-panel click just marks the block.
    if (!selection?.reveal) return;
    if (selection.page !== null) setActivePage(selection.page);
    if (!selection.focus) return;
    const block = rootRef.current?.querySelector<HTMLElement>(
      `[data-safeguard-block="${safeguardBlockId(selection.focus)}"]`,
    );
    if (block) revealSafeguardBlock(block);
  }, [selection]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: page changes and explicit retries must lock resolution until the replacement image loads.
  useEffect(() => {
    sourceGeneration.current += 1;
    setSourceState(workspace.sud.contentRedacted ? "forbidden" : "loading");
    setReadyPage(null);
    // A cached image can fire `load` before this passive effect runs; keep it loaded.
    const image = imageRef.current;
    if (
      !workspace.sud.contentRedacted &&
      activePage !== null &&
      image?.complete &&
      image.naturalWidth > 0
    ) {
      setReadyPage(activePage);
      setSourceState("ready");
    }
  }, [activePage, sourceAttempt, workspace.sud.contentRedacted]);
  const activePageMetadata = workspace.pages.find((page) => page.page === activePage) ?? null;
  const activeIndicators = workspace.sud.indicators.filter(
    (indicator) => indicator.page === activePage,
  );
  const evidenceReadyFor = (page: number | null): boolean =>
    page !== null && activePage === page && sourceState === "ready" && readyPage === page;
  const onSourceError = (): void => {
    if (activePage === null) return;
    const generation = sourceGeneration.current;
    fetch(pageImageUrl(workspace.batch.id, activePage, supportAccess))
      .then((response) => {
        if (sourceGeneration.current !== generation) return;
        setReadyPage(null);
        setSourceState(response.status === 403 ? "forbidden" : "unavailable");
      })
      .catch(() => {
        if (sourceGeneration.current !== generation) return;
        setReadyPage(null);
        setSourceState("unavailable");
      });
  };
  const complete =
    workspace.review?.status === "complete" || workspace.batch.status === "writeback_complete";
  const locked = workspace.review?.status === "in_progress" && !workspace.review.isMine;
  const disabled = Boolean(supportAccess) || busy || refreshPending || complete || locked;
  const sudDisabled = disabled || !evidenceReadyFor(sudPage);

  async function saveSud(outcome: "confirmed" | "rejected", reason?: string): Promise<void> {
    if (sudDisabled) return;
    setBusy(true);
    setError(null);
    const result = await resolveSud(client, workspace.batch.id, outcome, reason);
    if (!result.ok) {
      setBusy(false);
      setError(result.message);
      return;
    }
    const latest = await refresh();
    setBusy(false);
    setRefreshPending(latest === null);
    if (latest) {
      setSudRejecting(false);
      setSudReason("");
    } else {
      setError("The safeguard was saved, but the workspace could not be refreshed.");
    }
  }

  async function refreshSafeguards(): Promise<Workspace | null> {
    const latest = await refresh();
    setRefreshPending(latest === null);
    if (latest) setError(null);
    return latest;
  }

  return (
    <section
      ref={rootRef}
      className="wx-unified-safeguards"
      aria-labelledby="unified-safeguards-title"
    >
      <header>
        <div>
          <span className="wx-unified-category">Clinical safeguards</span>
          <h2 id="unified-safeguards-title">Documents & protected information</h2>
        </div>
      </header>
      {error ? (
        <p role="alert" className="wx-doclens-error">
          {error}
        </p>
      ) : null}
      {supportAccess ? (
        <output className="wx-unified-banner">
          <Glyph name="lock" size={18} />
          <div>
            <strong>Read-only support session</strong>
            <span>Safeguard resolutions remain with an authorized tenant reviewer.</span>
          </div>
        </output>
      ) : null}
      {refreshPending ? (
        <button
          type="button"
          className="wx-btn-secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void refreshSafeguards().finally(() => setBusy(false));
          }}
        >
          <Glyph name="rotate-ccw" size={16} /> Retry workspace refresh
        </button>
      ) : null}

      <div className="wx-unified-source-stage" aria-label="Safeguard source evidence">
        {workspace.sud.contentRedacted || sourceState === "forbidden" ? (
          <div role="alert" className="wx-unified-source-failure">
            <Glyph name="shield" size={24} />
            <strong>Source access is restricted</strong>
            <p>{PART2_WITHHELD_MESSAGE}</p>
          </div>
        ) : activePage === null ? (
          <div className="wx-unified-source-failure">
            <Glyph name="info" size={24} />
            <strong>No safeguard source page is available</strong>
            <p>A resolution cannot be recorded without authorized source evidence.</p>
          </div>
        ) : sourceState === "unavailable" ? (
          <div role="alert" className="wx-unified-source-failure">
            <Glyph name="alert" size={24} />
            <strong>Source page could not be loaded</strong>
            <p>Safeguard resolution remains locked until the page is visible.</p>
            <button
              type="button"
              className="wx-btn-secondary"
              onClick={() => setSourceAttempt((current) => current + 1)}
            >
              <Glyph name="rotate-ccw" size={16} /> Retry source
            </button>
          </div>
        ) : (
          <>
            <StatusPill
              label={
                sourceState === "ready" ? `Source page ${activePage} loaded` : "Loading source"
              }
              tone={sourceState === "ready" ? "success" : "progress"}
            />
            <div className="wx-unified-source-page">
              <img
                ref={imageRef}
                key={`${activePage}:${sourceAttempt}`}
                src={pageImageUrl(workspace.batch.id, activePage, supportAccess)}
                alt={`Page ${activePage} of the safeguard source document`}
                onLoad={() => {
                  setReadyPage(activePage);
                  setSourceState("ready");
                }}
                onError={onSourceError}
              />
              {sourceState === "ready" && activePageMetadata
                ? activeIndicators.map((indicator) => (
                    <span
                      key={`${indicator.ruleId}:${indicator.term}`}
                      className="wx-unified-source-box"
                      style={bboxPercent(indicator.bbox, activePageMetadata)}
                      aria-hidden="true"
                    />
                  ))
                : null}
            </div>
            {activeIndicators.length > 0 ? (
              <p className="wx-row-sub">
                {activeIndicators.length} protected-content indicator
                {activeIndicators.length === 1 ? "" : "s"} highlighted on this page.
              </p>
            ) : null}
          </>
        )}
      </div>

      {workspace.sud.status === "detected" ? (
        <fieldset
          className="wx-unified-safeguard-task"
          aria-label="Part 2 / SUD safeguard"
          data-safeguard-block="sud"
          data-selected={sudPage !== null && selectedPage === sudPage}
          aria-current={current?.kind === "sud" ? "true" : undefined}
          tabIndex={-1}
        >
          <div>
            <strong>Part 2 / SUD safeguard</strong>
            <StatusPill label="Resolution required" tone="critical" />
          </div>
          {workspace.sud.contentRedacted ? (
            <p>
              {PART2_WITHHELD_MESSAGE} An authorized reviewer with a need to know must resolve it.
            </p>
          ) : (
            <>
              <p>
                Review the protected-content detection before completion. Confirming keeps Part 2
                restrictions; rejecting it as a false positive requires a reason.
              </p>
              {sudPage !== null && activePage !== sudPage ? (
                <button
                  type="button"
                  className="wx-btn-secondary"
                  onClick={() => {
                    setActivePage(sudPage);
                    onFocusBlock({ kind: "sud" }, sudPage);
                  }}
                >
                  Review source page {sudPage}
                </button>
              ) : null}
              {sudRejecting ? (
                <form
                  className="wx-doclens-input"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (sudReason.trim().length >= MIN_REASON)
                      void saveSud("rejected", sudReason.trim());
                  }}
                >
                  <label htmlFor="unified-sud-reason">False-positive reason</label>
                  <input
                    id="unified-sud-reason"
                    value={sudReason}
                    minLength={MIN_REASON}
                    onChange={(event) => setSudReason(event.target.value)}
                  />
                  <div className="wx-doclens-buttons">
                    <button
                      type="button"
                      className="wx-btn-secondary"
                      onClick={() => setSudRejecting(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      className="wx-btn-primary"
                      disabled={sudDisabled || sudReason.trim().length < MIN_REASON}
                    >
                      Reject as false positive
                    </button>
                  </div>
                </form>
              ) : (
                <div className="wx-doclens-buttons">
                  <button
                    type="button"
                    className="wx-btn-primary"
                    disabled={sudDisabled}
                    onClick={() => void saveSud("confirmed")}
                  >
                    <Glyph name="shield" size={16} /> Confirm Part 2 safeguard
                  </button>
                  <button
                    type="button"
                    className="wx-btn-secondary"
                    disabled={sudDisabled}
                    onClick={() => setSudRejecting(true)}
                  >
                    Reject false positive
                  </button>
                </div>
              )}
            </>
          )}
        </fieldset>
      ) : (
        <div className="wx-unified-safeguard-task">
          <strong>Part 2 / SUD safeguard</strong>
          <StatusPill
            label={
              workspace.sud.status === "confirmed"
                ? "Confirmed"
                : workspace.sud.status === "rejected"
                  ? "Rejected"
                  : "No detection"
            }
            tone={workspace.sud.status === "confirmed" ? "warning" : "success"}
          />
        </div>
      )}

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
            selected={activePage === document.pageFrom}
            current={current?.kind === "identity" && current.page === document.pageFrom}
            disabled={disabled || !evidenceReadyFor(document.pageFrom)}
            onReviewSource={() => {
              setActivePage(document.pageFrom);
              onFocusBlock({ kind: "identity", page: document.pageFrom }, document.pageFrom);
            }}
            onError={setError}
            onBusy={setBusy}
            onSaved={refreshSafeguards}
          />
        ))
      )}
    </section>
  );
}

function IdentityTask({
  workspace,
  pageFrom,
  title,
  selected,
  current,
  disabled,
  onReviewSource,
  onError,
  onBusy,
  onSaved,
}: {
  workspace: Workspace;
  pageFrom: number;
  title: string;
  selected: boolean;
  current: boolean;
  disabled: boolean;
  onReviewSource: () => void;
  onError: (error: string | null) => void;
  onBusy: (busy: boolean) => void;
  onSaved: () => Promise<Workspace | null>;
}): JSX.Element {
  const client = useApiClient();
  const [resolution, setResolution] = useState<"same_patient" | "other_patient" | null>(null);
  const [reason, setReason] = useState("");

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (disabled || !resolution || reason.trim().length < MIN_REASON) return;
    onBusy(true);
    onError(null);
    const result = await resolveIdentity(
      client,
      workspace.batch.id,
      pageFrom,
      resolution,
      reason.trim(),
    );
    if (!result.ok) {
      onBusy(false);
      onError(result.message);
      return;
    }
    const latest = await onSaved();
    onBusy(false);
    if (latest) {
      setResolution(null);
      setReason("");
    } else {
      onError("The identity resolution was saved, but the workspace could not be refreshed.");
    }
  };

  return (
    <fieldset
      className="wx-unified-safeguard-task"
      aria-label={`Patient identity · ${title}`}
      data-safeguard-block={safeguardBlockId({ kind: "identity", page: pageFrom })}
      data-selected={selected}
      aria-current={current ? "true" : undefined}
      tabIndex={-1}
    >
      <div>
        <strong>Patient identity · {title}</strong>
        <StatusPill label="Identity review required" tone="critical" />
      </div>
      {!selected ? (
        <button type="button" className="wx-btn-secondary" onClick={onReviewSource}>
          Review source page {pageFrom}
        </button>
      ) : null}
      {resolution ? (
        <form className="wx-doclens-input" onSubmit={(event) => void submit(event)}>
          <label htmlFor={`identity-reason-${pageFrom}`}>Reason</label>
          <input
            id={`identity-reason-${pageFrom}`}
            value={reason}
            minLength={MIN_REASON}
            placeholder={
              resolution === "same_patient"
                ? "Why the identifiers are consistent"
                : "Why this belongs to another patient"
            }
            onChange={(event) => setReason(event.target.value)}
          />
          <div className="wx-doclens-buttons">
            <button type="button" className="wx-btn-secondary" onClick={() => setResolution(null)}>
              Cancel
            </button>
            <button
              type="submit"
              className="wx-btn-primary"
              disabled={disabled || reason.trim().length < MIN_REASON}
            >
              Save identity resolution
            </button>
          </div>
        </form>
      ) : (
        <div className="wx-doclens-buttons">
          <button
            type="button"
            className="wx-btn-primary"
            disabled={disabled}
            onClick={() => setResolution("same_patient")}
          >
            Same patient
          </button>
          <button
            type="button"
            className="wx-btn-secondary"
            disabled={disabled}
            onClick={() => setResolution("other_patient")}
          >
            Another patient
          </button>
        </div>
      )}
    </fieldset>
  );
}
