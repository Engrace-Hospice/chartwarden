import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../doclens-api";
import {
  CANDIDATE_ID,
  NATURAL_WIDTH,
  OWN_REVIEW,
  SUPPORT_ACCESS,
  candidateFixture,
  createPanelServer,
  mountSourcePanel,
  savedDecision,
  workspaceFixture,
} from "./review-panel-test-kit";
import type { PanelServer, SourcePanelProps } from "./review-panel-test-kit";
import { overrideImageProperty } from "./review-test-support";

let server: PanelServer;

function mount(workspace: Workspace, props: SourcePanelProps = {}) {
  server = createPanelServer(workspace);
  return mountSourcePanel(server, props);
}

function loadSource(): HTMLImageElement {
  const image = screen.getByRole("img", { name: /Page 1 of the source document/ });
  Object.defineProperty(image, "naturalWidth", { value: NATURAL_WIDTH, configurable: true });
  fireEvent.load(image);
  return image as HTMLImageElement;
}

const confirmation = (): HTMLInputElement =>
  screen.getByRole("checkbox", { name: /I compared this with the source/ });
const accept = (): HTMLElement => screen.getByRole("button", { name: "Accept extracted value" });
const edit = (): HTMLElement => screen.getByRole("button", { name: "Edit value" });
const reject = (): HTMLElement => screen.getByRole("button", { name: "Reject extracted value" });
const sheet = (): HTMLElement | null => document.querySelector(".wx-unified-source-sheet");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReviewSourcePanel source viewer", () => {
  it("treats a page image that finished loading before the effects ran as loaded", () => {
    // A cached image fires `load` before React's passive effects; the check must not undo it.
    const restoreComplete = overrideImageProperty("complete", true);
    const restoreWidth = overrideImageProperty("naturalWidth", NATURAL_WIDTH);
    try {
      const view = mount(workspaceFixture());

      expect(screen.getByText("Source loaded")).toBeTruthy();
      expect(sheet()?.style.maxWidth).toBe(`${NATURAL_WIDTH}px`);
      expect(view.onAvailabilityChange).toHaveBeenCalledWith(1, false);
    } finally {
      restoreWidth();
      restoreComplete();
    }
  });

  it("shows the page at the panel width, capped at its natural width", () => {
    mount(workspaceFixture());
    loadSource();

    expect(sheet()?.style.maxWidth).toBe(`${NATURAL_WIDTH}px`);
    expect(sheet()?.style.width).toBe("");
    const zoom = screen.getByRole("group", { name: "Source zoom" });
    expect(
      within(zoom).getByRole("button", { name: "Fit width" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(zoom).getByRole("button", { name: "Actual size" }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("asks the workspace for the zoom and shows the page pixel for pixel at actual size", () => {
    const view = mount(workspaceFixture());
    loadSource();

    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));
    expect(view.onZoomChange).toHaveBeenCalledWith("actual");

    view.rerender({ zoom: "actual" });
    expect(sheet()?.style.width).toBe(`${NATURAL_WIDTH}px`);
    expect(screen.getByRole("button", { name: "Actual size" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Fit width" }));
    expect(view.onZoomChange).toHaveBeenLastCalledWith("fit");
  });

  it("positions the highlight with the same percentage coordinates at any scale", () => {
    mount(workspaceFixture());
    loadSource();

    const box = document.querySelector<HTMLElement>(".wx-unified-source-box");
    expect(box).toBeTruthy();
    expect(box?.style.left).toBe("10%");
    expect(box?.style.top).toBe("10%");
    expect(box?.style.width).toBe("40%");
    expect(box?.style.height).toBe("5%");
    expect(box?.getAttribute("aria-hidden")).toBe("true");
  });

  it("names the heading the workspace focuses when it opens the task", () => {
    mount(workspaceFixture());

    const heading = screen.getByRole("heading", { name: "City", level: 2 });
    expect(heading.hasAttribute("data-task-heading")).toBe(true);
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });
});

describe("ReviewSourcePanel after a saved decision", () => {
  async function saveCorrection(value: string): Promise<void> {
    loadSource();
    fireEvent.click(confirmation());
    fireEvent.click(edit());
    fireEvent.change(screen.getByLabelText("Corrected value"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save corrected value" }));
    expect(await screen.findByText(`Decision saved: corrected to ${value}`)).toBeTruthy();
  }

  it("shows the corrected value in the header and clears the comparison", async () => {
    mount(workspaceFixture());
    await saveCorrection("Keizer");

    const header = screen.getByRole("heading", { name: "City", level: 2 }).closest("header");
    expect(header?.querySelector("p")?.textContent).toMatch(/^Keizer · /);
    expect(header?.textContent).toContain("Saved decision: Edited");
    expect(header?.textContent).toContain("Extracted: Salem");
    expect(confirmation().checked).toBe(false);
  });

  it("locks the three decision buttons until Change decision is chosen", async () => {
    mount(workspaceFixture());
    await saveCorrection("Keizer");

    expect(accept()).toBeDisabled();
    expect(edit()).toBeDisabled();
    expect(reject()).toBeDisabled();
    expect(confirmation()).toBeDisabled();
    fireEvent.click(accept());
    expect(server.requests.decisions).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Change decision" }));
    expect(screen.queryByRole("button", { name: "Change decision" })).toBeNull();
    expect(confirmation()).not.toBeDisabled();
    expect(confirmation().checked).toBe(false);
    expect(accept()).toBeDisabled();

    fireEvent.click(confirmation());
    expect(accept()).not.toBeDisabled();
    expect(edit()).not.toBeDisabled();
    expect(reject()).not.toBeDisabled();
  });

  it("moves focus to the comparison checkbox when Change decision is chosen", async () => {
    mount(workspaceFixture());
    await saveCorrection("Keizer");

    const change = screen.getByRole("button", { name: "Change decision" });
    change.focus();
    fireEvent.click(change);

    await waitFor(() => expect(document.activeElement).toBe(confirmation()));
  });

  it("moves focus to the panel when Change decision is chosen and the source is not ready", () => {
    mount(
      workspaceFixture([candidateFixture(CANDIDATE_ID, { decision: savedDecision("approve") })]),
    );
    // The page never loaded, so the comparison checkbox is disabled and cannot take focus.
    expect(confirmation()).toBeDisabled();
    const change = screen.getByRole("button", { name: "Change decision" });
    change.focus();

    fireEvent.click(change);

    expect(document.activeElement).toBe(screen.getByRole("region", { name: "Review task" }));
  });

  it("locks again after the changed decision is saved", async () => {
    mount(workspaceFixture());
    await saveCorrection("Keizer");
    fireEvent.click(screen.getByRole("button", { name: "Change decision" }));
    fireEvent.click(confirmation());
    fireEvent.click(accept());

    expect(await screen.findByText(/Decision saved: accepted Salem/)).toBeTruthy();
    expect(server.requests.decisions).toHaveLength(2);
    await waitFor(() => expect(accept()).toBeDisabled());
    expect(confirmation().checked).toBe(false);
    expect(screen.getByRole("button", { name: "Change decision" })).toBeTruthy();
  });

  it("opens an already decided observation locked, with its saved state in the header", () => {
    mount(
      workspaceFixture([
        candidateFixture(CANDIDATE_ID, { decision: savedDecision("approve_with_edit", "Keizer") }),
      ]),
    );
    loadSource();

    const header = screen.getByRole("heading", { name: "City", level: 2 }).closest("header");
    expect(header?.textContent).toContain("Keizer");
    expect(header?.textContent).toContain("Extracted: Salem");
    expect(confirmation()).toBeDisabled();
    expect(accept()).toBeDisabled();
    expect(edit()).toBeDisabled();
    expect(reject()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change decision" })).toBeTruthy();
  });

  it("states an accepted decision in the header without changing the value", () => {
    mount(
      workspaceFixture([candidateFixture(CANDIDATE_ID, { decision: savedDecision("approve") })]),
    );

    const header = screen.getByRole("heading", { name: "City", level: 2 }).closest("header");
    expect(header?.textContent).toContain("Salem");
    expect(header?.textContent).toContain("Saved decision: Approved");
  });

  it("offers a first decision on an undecided observation without Change decision", () => {
    mount(workspaceFixture());
    loadSource();

    expect(screen.queryByRole("button", { name: "Change decision" })).toBeNull();
    fireEvent.click(confirmation());
    expect(accept()).not.toBeDisabled();
  });
});

describe("ReviewSourcePanel protected and empty values", () => {
  const WITHHELD = "WITHHELD-SYNTHETIC-VALUE";
  const CORRECTED = "CORRECTED-SYNTHETIC-VALUE";

  it("shows no value in the header of a withheld Part 2 observation", () => {
    mount(workspaceFixture([candidateFixture(CANDIDATE_ID, { redacted: true, value: WITHHELD })]));

    const header = screen.getByRole("heading", { name: "City", level: 2 }).closest("header");
    expect(header?.querySelector("p")?.textContent).toMatch(/^Protected value withheld · /);
    expect(header?.textContent).not.toContain(WITHHELD);
  });

  it("shows neither a saved-decision line nor any value for a withheld observation", () => {
    mount(
      workspaceFixture([
        candidateFixture(CANDIDATE_ID, {
          redacted: true,
          value: WITHHELD,
          decision: savedDecision("approve_with_edit", CORRECTED),
        }),
      ]),
    );

    const header = screen.getByRole("heading", { name: "City", level: 2 }).closest("header");
    expect(header?.textContent).not.toContain("Saved decision");
    expect(header?.textContent).not.toContain(WITHHELD);
    expect(header?.textContent).not.toContain(CORRECTED);
    expect(document.body.textContent).not.toContain(WITHHELD);
    expect(document.body.textContent).not.toContain(CORRECTED);
  });

  it("never requests the page image of a withheld observation", () => {
    mount(workspaceFixture([candidateFixture(CANDIDATE_ID, { redacted: true })]));

    expect(screen.getByRole("alert")).toHaveTextContent("Source access is restricted");
    expect(screen.queryByRole("img")).toBeNull();
    expect(server.requests.probes).toHaveLength(0);
  });

  it.each([
    ["an empty", ""],
    ["a whitespace-only", "   "],
  ])("names %s extracted value as no value in the header", (_label, value) => {
    mount(workspaceFixture([candidateFixture(CANDIDATE_ID, { value })]));

    const header = screen.getByRole("heading", { name: "City", level: 2 }).closest("header");
    expect(header?.querySelector("p")?.textContent).toMatch(/^No value extracted · /);
  });
});

describe("ReviewSourcePanel footer copy", () => {
  const CHECKBOX_COPY = /comparison checkbox/;

  it("keeps the checkbox requirement when decisions are available", () => {
    mount(workspaceFixture());

    expect(screen.getByText(CHECKBOX_COPY)).toBeTruthy();
  });

  it("does not mention a checkbox when another reviewer owns the review", () => {
    mount(
      workspaceFixture([candidateFixture(CANDIDATE_ID)], {
        review: { ...OWN_REVIEW, isMine: false },
      }),
    );

    expect(screen.getByText("Another reviewer owns this review.")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByText(CHECKBOX_COPY)).toBeNull();
    expect(screen.getByText(/does not record a decision/)).toBeTruthy();
  });

  it("does not mention a checkbox once the review is complete", () => {
    mount(
      workspaceFixture([candidateFixture(CANDIDATE_ID)], {
        review: { ...OWN_REVIEW, status: "complete" },
      }),
    );

    expect(screen.queryByText(CHECKBOX_COPY)).toBeNull();
    expect(screen.getByText(/does not record a decision/)).toBeTruthy();
  });

  it("does not mention a checkbox in a read-only support session", () => {
    mount(workspaceFixture(), { supportAccess: SUPPORT_ACCESS });

    expect(screen.queryByText(CHECKBOX_COPY)).toBeNull();
    expect(screen.getByText(/Support-session access is read-only/)).toBeTruthy();
    expect(screen.getByText(/does not record a decision/)).toBeTruthy();
  });

  it("does not mention a checkbox for withheld Part 2 content", () => {
    mount(workspaceFixture([candidateFixture(CANDIDATE_ID, { redacted: true })]));

    expect(screen.queryByText(CHECKBOX_COPY)).toBeNull();
    expect(screen.getByText(/does not record a decision/)).toBeTruthy();
  });
});
