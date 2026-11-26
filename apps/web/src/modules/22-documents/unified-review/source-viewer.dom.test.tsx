import { fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NO_HIGHLIGHT_LOCATION_NOTE,
  SourceViewer,
  centerInViewport,
  pageWidthStyle,
} from "./source-viewer";
import type { SourceHighlight } from "./source-viewer";
import type { SourceImage, SourceImageState } from "./use-source-image";

const PAGE = { width: 612, height: 792 };
const HIGHLIGHT: SourceHighlight = { key: "h1", bbox: [61.2, 79.2, 306, 118.8] };

function sourceImage(state: SourceImageState, overrides: Partial<SourceImage> = {}): SourceImage {
  return {
    state,
    naturalWidth: 1000,
    imageRef: createRef<HTMLImageElement>(),
    imageKey: "k:0",
    src: "/synthetic-page.png",
    onLoad: vi.fn(),
    onError: vi.fn(),
    retry: vi.fn(),
    ...overrides,
  };
}

function viewer(
  source: SourceImage,
  props: Partial<Parameters<typeof SourceViewer>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <SourceViewer
      source={source}
      alt="Synthetic page"
      page={PAGE}
      highlights={[HIGHLIGHT]}
      zoom="fit"
      onZoomChange={vi.fn()}
      loadedLabel="Source loaded"
      unavailableDetail="Nothing can be confirmed."
      {...props}
    />,
  );
}

/** jsdom has no layout: give the viewport and the highlight the boxes a browser would. */
function stubLayout(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const box = this.classList.contains("wx-unified-source-box")
      ? { left: 300, top: 250, width: 40, height: 20 }
      : { left: 100, top: 50, width: 400, height: 300 };
    return {
      ...box,
      right: box.left + box.width,
      bottom: box.top + box.height,
      x: box.left,
      y: box.top,
      toJSON: () => box,
    };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("centerInViewport", () => {
  it("asks the viewport to scroll the target to its middle", () => {
    stubLayout();
    const viewport = document.createElement("div");
    const target = document.createElement("span");
    target.className = "wx-unified-source-box";
    const scrollTo = vi.fn();
    viewport.scrollTo = scrollTo;

    centerInViewport(viewport, target);

    // x: (300 - 100) - (400 - 40) / 2 = 20; y: (250 - 50) - (300 - 20) / 2 = 60
    expect(scrollTo).toHaveBeenCalledWith({ left: 20, top: 60 });
  });

  it("adds the scroll position the viewport already has", () => {
    stubLayout();
    const viewport = document.createElement("div");
    viewport.scrollLeft = 5;
    viewport.scrollTop = 7;
    const target = document.createElement("span");
    target.className = "wx-unified-source-box";
    const scrollTo = vi.fn();
    viewport.scrollTo = scrollTo;

    centerInViewport(viewport, target);

    expect(scrollTo).toHaveBeenCalledWith({ left: 25, top: 67 });
  });
});

describe("pageWidthStyle", () => {
  it.each([null, 0, -1])("sets nothing for a natural width of %s", (width) => {
    expect(pageWidthStyle("fit", width)).toEqual({});
    expect(pageWidthStyle("actual", width)).toEqual({});
  });

  it("caps fit width and fixes actual size at the natural width", () => {
    expect(pageWidthStyle("fit", 800)).toEqual({ maxWidth: "800px" });
    expect(pageWidthStyle("actual", 800)).toEqual({ width: "800px", maxWidth: "none" });
  });
});

describe("SourceViewer", () => {
  it("centres the highlight once the page is ready, and again when the zoom changes", () => {
    stubLayout();
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo");
    const { rerender } = viewer(sourceImage("ready"));
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({ left: 20, top: 60 });

    rerender(
      <SourceViewer
        source={sourceImage("ready")}
        alt="Synthetic page"
        page={PAGE}
        highlights={[HIGHLIGHT]}
        zoom="actual"
        onZoomChange={vi.fn()}
        loadedLabel="Source loaded"
        unavailableDetail="Nothing can be confirmed."
      />,
    );

    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it("does not scroll while the page is still loading or when there is nothing to highlight", () => {
    stubLayout();
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo");

    viewer(sourceImage("loading"));
    expect(scrollTo).not.toHaveBeenCalled();

    viewer(sourceImage("ready"), { highlights: [] });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("scrolls to the first of several highlights", () => {
    stubLayout();
    const scrollTo = vi.spyOn(Element.prototype, "scrollTo");

    viewer(sourceImage("ready"), { highlights: [HIGHLIGHT, { key: "h2", bbox: [1, 1, 2, 2] }] });

    expect(document.querySelectorAll(".wx-unified-source-box")).toHaveLength(2);
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it("makes the scrolling viewport a named region the keyboard can reach", () => {
    viewer(sourceImage("ready"), { regionLabel: "Safeguard source page" });

    const viewport = screen.getByRole("region", { name: "Safeguard source page" });
    expect(viewport.getAttribute("tabindex")).toBe("0");
    expect(within(viewport).getByRole("img", { name: "Synthetic page" })).toBeTruthy();
  });

  it("sizes the sheet from the natural width and the zoom", () => {
    const { rerender } = viewer(sourceImage("ready"));
    const sheet = document.querySelector<HTMLElement>(".wx-unified-source-sheet");
    expect(sheet?.style.maxWidth).toBe("1000px");

    rerender(
      <SourceViewer
        source={sourceImage("ready")}
        alt="Synthetic page"
        page={PAGE}
        highlights={[HIGHLIGHT]}
        zoom="actual"
        onZoomChange={vi.fn()}
        loadedLabel="Source loaded"
        unavailableDetail="x"
      />,
    );

    expect(sheet?.style.width).toBe("1000px");
  });

  it("draws no highlight and says so when the page has no size", () => {
    viewer(sourceImage("ready"), { page: null });

    expect(document.querySelector(".wx-unified-source-box")).toBeNull();
    expect(screen.getByText(NO_HIGHLIGHT_LOCATION_NOTE)).toBeTruthy();
  });

  it("does not claim a missing location when there is nothing to highlight", () => {
    viewer(sourceImage("ready"), { page: null, highlights: [] });

    expect(screen.queryByText(NO_HIGHLIGHT_LOCATION_NOTE)).toBeNull();
  });

  it("reports the zoom the reviewer chose", () => {
    const onZoomChange = vi.fn();
    viewer(sourceImage("ready"), { onZoomChange });

    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit width" }));

    expect(onZoomChange.mock.calls).toEqual([["actual"], ["fit"]]);
  });

  it("labels the status pill from the load state", () => {
    const { rerender } = viewer(sourceImage("loading"), { loadedLabel: "Source page 2 loaded" });
    expect(screen.getByText("Loading source")).toBeTruthy();

    rerender(
      <SourceViewer
        source={sourceImage("ready")}
        alt="Synthetic page"
        page={PAGE}
        highlights={[]}
        zoom="fit"
        onZoomChange={vi.fn()}
        loadedLabel="Source page 2 loaded"
        unavailableDetail="x"
      />,
    );

    expect(screen.getByText("Source page 2 loaded")).toBeTruthy();
  });

  it.each([
    ["forbidden", "Source access is restricted", false],
    ["unavailable", "Source page could not be loaded", true],
    ["expired", "Your session has ended", true],
  ] as const)(
    "shows an alert for a %s page, with a retry only when one can help",
    (state, title, retry) => {
      const source = sourceImage(state);
      viewer(source, { unavailableDetail: "Safeguard resolution stays locked." });

      expect(screen.getByRole("alert")).toHaveTextContent(title);
      expect(screen.queryByRole("img")).toBeNull();
      const button = screen.queryByRole("button", { name: /Retry source/ });
      expect(button !== null).toBe(retry);
      if (button) {
        fireEvent.click(button);
        expect(source.retry).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("names what stays blocked for an unavailable page", () => {
    viewer(sourceImage("unavailable"), { unavailableDetail: "Safeguard resolution stays locked." });

    expect(screen.getByText("Safeguard resolution stays locked.")).toBeTruthy();
  });
});
