// UR — the source page viewer both review panels use: a status pill, a Fit width / Actual size toggle,
// a keyboard-focusable scroll viewport, and the highlight overlay (positioned in percentages, so it
// is right at any scale). The load state comes from `useSourceImage`; the zoom is the caller's, so it
// survives a change of task.
import { Glyph, StatusPill } from "@chartwarden/ui";
import { useEffect, useRef } from "react";
import type { CSSProperties, JSX } from "react";
import type { Bbox, WorkspacePage } from "../doclens-api";
import { PART2_WITHHELD_MESSAGE, bboxPercent } from "../doclens-model";
import type { SourceImage } from "./use-source-image";

export type SourceZoom = "fit" | "actual";

export interface SourceHighlight {
  readonly key: string;
  readonly bbox: Bbox;
}

export const NO_HIGHLIGHT_LOCATION_NOTE =
  "Location on the page is unavailable; compare the whole page.";

/** Fit width fills the panel up to the page's natural width; actual size shows it pixel for pixel. */
export function pageWidthStyle(zoom: SourceZoom, naturalWidth: number | null): CSSProperties {
  if (naturalWidth === null || naturalWidth <= 0) return {};
  return zoom === "actual"
    ? { width: `${naturalWidth}px`, maxWidth: "none" }
    : { maxWidth: `${naturalWidth}px` };
}

/** Scrolls only the source viewport (never the window) so the highlighted line sits in its middle. */
export function centerInViewport(viewport: HTMLElement, target: HTMLElement): void {
  const view = viewport.getBoundingClientRect();
  const mark = target.getBoundingClientRect();
  viewport.scrollTo?.({
    left: viewport.scrollLeft + (mark.left - view.left) - (view.width - mark.width) / 2,
    top: viewport.scrollTop + (mark.top - view.top) - (view.height - mark.height) / 2,
  });
}

function SourceFailure({
  icon,
  title,
  detail,
  onRetry,
}: {
  icon: "shield" | "alert";
  title: string;
  detail: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div role="alert" className="wx-unified-source-failure">
      <Glyph name={icon} size={24} />
      <strong>{title}</strong>
      <p>{detail}</p>
      {onRetry ? (
        <button type="button" className="wx-btn-secondary" onClick={onRetry}>
          <Glyph name="rotate-ccw" size={16} /> Retry source
        </button>
      ) : null}
    </div>
  );
}

function ZoomToggle({
  zoom,
  onZoomChange,
}: {
  zoom: SourceZoom;
  onZoomChange: (zoom: SourceZoom) => void;
}): JSX.Element {
  return (
    <fieldset className="wx-unified-source-zoom" aria-label="Source zoom">
      <button
        type="button"
        className="wx-btn-secondary wx-btn-sm"
        aria-pressed={zoom === "fit"}
        onClick={() => onZoomChange("fit")}
      >
        Fit width
      </button>
      <button
        type="button"
        className="wx-btn-secondary wx-btn-sm"
        aria-pressed={zoom === "actual"}
        onClick={() => onZoomChange("actual")}
      >
        Actual size
      </button>
    </fieldset>
  );
}

export function SourceViewer({
  source,
  alt,
  page,
  highlights,
  zoom,
  onZoomChange,
  loadedLabel,
  unavailableDetail,
  regionLabel = "Source page",
}: {
  source: SourceImage;
  alt: string;
  /** The page's size, which positions the highlights; null when the workspace has no entry for it. */
  page: Pick<WorkspacePage, "width" | "height"> | null;
  highlights: readonly SourceHighlight[];
  zoom: SourceZoom;
  onZoomChange: (zoom: SourceZoom) => void;
  loadedLabel: string;
  /** What the failure alert says is blocked while the page cannot be shown. */
  unavailableDetail: string;
  regionLabel?: string;
}): JSX.Element {
  const viewportRef = useRef<HTMLElement>(null);
  const firstHighlightRef = useRef<HTMLSpanElement>(null);
  const { state, naturalWidth } = source;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a zoom or size change moves the highlight and must re-centre it.
  useEffect(() => {
    if (state !== "ready" || !viewportRef.current || !firstHighlightRef.current) return;
    centerInViewport(viewportRef.current, firstHighlightRef.current);
  }, [state, zoom, naturalWidth]);

  if (state === "forbidden")
    return (
      <div className="wx-unified-source-viewer">
        <SourceFailure
          icon="shield"
          title="Source access is restricted"
          detail={PART2_WITHHELD_MESSAGE}
        />
      </div>
    );
  if (state === "unavailable" || state === "expired")
    return (
      <div className="wx-unified-source-viewer">
        <SourceFailure
          icon="alert"
          title={state === "expired" ? "Your session has ended" : "Source page could not be loaded"}
          detail={
            state === "expired" ? "Sign in again to load the source page." : unavailableDetail
          }
          onRetry={source.retry}
        />
      </div>
    );

  const markedPage = state === "ready" ? page : null;
  return (
    <div className="wx-unified-source-viewer">
      <div className="wx-unified-source-toolbar">
        <output>
          <StatusPill
            label={state === "loading" ? "Loading source" : loadedLabel}
            tone={state === "loading" ? "progress" : "success"}
          />
        </output>
        <ZoomToggle zoom={zoom} onZoomChange={onZoomChange} />
      </div>
      <section
        className="wx-unified-source-viewport"
        ref={viewportRef}
        aria-label={regionLabel}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling page image holds nothing focusable, so the keyboard needs a stop to scroll it.
        tabIndex={0}
      >
        <div className="wx-unified-source-sheet" style={pageWidthStyle(zoom, naturalWidth)}>
          <img
            ref={source.imageRef}
            key={source.imageKey}
            src={source.src}
            alt={alt}
            onLoad={source.onLoad}
            onError={source.onError}
          />
          {markedPage
            ? highlights.map((highlight, index) => (
                <span
                  key={highlight.key}
                  ref={index === 0 ? firstHighlightRef : undefined}
                  className="wx-unified-source-box"
                  style={bboxPercent(highlight.bbox, markedPage)}
                  aria-hidden="true"
                />
              ))
            : null}
        </div>
      </section>
      {state === "ready" && page === null && highlights.length > 0 ? (
        <p className="wx-row-sub">{NO_HIGHLIGHT_LOCATION_NOTE}</p>
      ) : null}
    </div>
  );
}
