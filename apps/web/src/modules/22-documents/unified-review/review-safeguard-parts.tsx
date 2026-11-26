// UR — the stateless pieces of the safeguard panel: its source page (or the notice that there is none)
// and the read-only support-session banner.
import { Glyph } from "@chartwarden/ui";
import type { JSX } from "react";
import type { Workspace } from "../doclens-api";
import { SourceViewer } from "./source-viewer";
import type { SourceZoom } from "./source-viewer";
import type { SourceImage } from "./use-source-image";

export function SupportBanner(): JSX.Element {
  return (
    <div role="note" className="wx-unified-banner">
      <Glyph name="lock" size={18} />
      <div>
        <strong>Read-only support session</strong>
        <span>Safeguard resolutions remain with an authorized tenant reviewer.</span>
      </div>
    </div>
  );
}

/** The page a safeguard is on, with its protected-content indicators highlighted. */
export function SafeguardSource({
  workspace,
  source,
  activePage,
  zoom,
  onZoomChange,
}: {
  workspace: Workspace;
  source: SourceImage;
  activePage: number | null;
  zoom: SourceZoom;
  onZoomChange: (zoom: SourceZoom) => void;
}): JSX.Element {
  if (activePage === null && !workspace.sud.contentRedacted)
    return (
      <div className="wx-unified-source-viewer">
        <div className="wx-unified-source-failure">
          <Glyph name="info" size={24} />
          <strong>No safeguard source page is available</strong>
          <p>A resolution cannot be recorded without authorized source evidence.</p>
        </div>
      </div>
    );
  const indicators = workspace.sud.indicators.filter((indicator) => indicator.page === activePage);
  const showing = source.state === "loading" || source.state === "ready";
  return (
    <>
      <SourceViewer
        source={source}
        alt={`Page ${activePage} of the safeguard source document`}
        page={workspace.pages.find((page) => page.page === activePage) ?? null}
        highlights={indicators.map((indicator, index) => ({
          key: `${indicator.ruleId}:${indicator.bbox.join(",")}:${index}`,
          bbox: indicator.bbox,
        }))}
        zoom={zoom}
        onZoomChange={onZoomChange}
        loadedLabel={`Source page ${activePage} loaded`}
        unavailableDetail="Safeguard resolution remains locked until the page is visible."
        regionLabel="Safeguard source page"
      />
      {indicators.length > 0 && showing ? (
        <p className="wx-row-sub">
          {indicators.length} protected-content indicator
          {indicators.length === 1 ? "" : "s"} highlighted on this page.
        </p>
      ) : null}
    </>
  );
}
