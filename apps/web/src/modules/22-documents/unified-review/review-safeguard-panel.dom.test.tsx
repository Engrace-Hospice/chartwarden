import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../doclens-api";
import { UNREACHABLE_DECISION_MESSAGE } from "./review-decision-flow";
import {
  NATURAL_WIDTH,
  OWN_REVIEW,
  SUPPORT_ACCESS,
  createPanelServer,
  documentNeedingIdentity,
  mountSafeguardPanel,
  sudWorkspace,
  workspaceFixture,
} from "./review-panel-test-kit";
import type { PanelServer, SafeguardPanelProps } from "./review-panel-test-kit";

let server: PanelServer;

function mount(workspace: Workspace, props: SafeguardPanelProps = {}) {
  server = createPanelServer(workspace);
  return mountSafeguardPanel(server, props);
}

const SUD_PAGE = 2;
const IDENTITY_PAGE = 3;

const pageImage = (page: number): HTMLElement =>
  screen.getByRole("img", { name: `Page ${page} of the safeguard source document` });
const loadPage = (page: number): void => {
  Object.defineProperty(pageImage(page), "naturalWidth", {
    value: NATURAL_WIDTH,
    configurable: true,
  });
  fireEvent.load(pageImage(page));
};
const confirmSud = (): HTMLElement =>
  screen.getByRole("button", { name: /Confirm Part 2 safeguard/ });
const rejectSud = (): HTMLElement => screen.getByRole("button", { name: "Reject false positive" });
const sudBlock = (): HTMLElement => screen.getByRole("group", { name: "Part 2 / SUD safeguard" });
const identityBlock = (): HTMLElement => screen.getByRole("group", { name: /Patient identity ·/ });
const sudAndIdentity = (overrides: Partial<Workspace> = {}): Workspace => ({
  ...sudWorkspace(),
  documents: [documentNeedingIdentity(IDENTITY_PAGE)],
  ...overrides,
});

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ReviewSafeguardPanel source image", () => {
  it("shows the Part 2 page, and a loaded pill once it loads", () => {
    mount(sudWorkspace());
    expect(screen.getByText("Loading source")).toBeTruthy();

    loadPage(SUD_PAGE);

    expect(screen.getByText(`Source page ${SUD_PAGE} loaded`)).toBeTruthy();
    expect(screen.getByText(/1 protected-content indicator highlighted/)).toBeTruthy();
    expect(document.querySelectorAll(".wx-unified-source-box")).toHaveLength(1);
  });

  it("offers the same zoom as the field task, kept by the workspace when it passes the zoom", () => {
    const onZoomChange = vi.fn();
    mount(sudWorkspace(), { zoom: "actual", onZoomChange });
    loadPage(SUD_PAGE);

    expect(screen.getByRole("button", { name: "Actual size" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(document.querySelector<HTMLElement>(".wx-unified-source-sheet")?.style.width).toBe(
      `${NATURAL_WIDTH}px`,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fit width" }));
    expect(onZoomChange).toHaveBeenCalledWith("fit");
  });

  it("keeps its own zoom when the workspace passes none", () => {
    mount(sudWorkspace());
    loadPage(SUD_PAGE);
    const sheet = document.querySelector<HTMLElement>(".wx-unified-source-sheet");
    expect(sheet?.style.width).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Actual size" }));

    expect(sheet?.style.width).toBe(`${NATURAL_WIDTH}px`);
  });

  it("makes the scrolling page a named region the keyboard can reach", () => {
    mount(sudWorkspace());

    expect(
      screen.getByRole("region", { name: "Safeguard source page" }).getAttribute("tabindex"),
    ).toBe("0");
  });

  it("draws every highlight when a protected term occurs twice on the page, without a key clash", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const base = sudWorkspace();
    const [indicator] = base.sud.indicators;
    if (!indicator) throw new Error("fixture has an indicator");
    mount({
      ...base,
      sud: {
        ...base.sud,
        indicators: [indicator, { ...indicator, bbox: [200, 300, 260, 320] }],
      },
    });

    loadPage(SUD_PAGE);

    expect(document.querySelectorAll(".wx-unified-source-box")).toHaveLength(2);
    expect(screen.getByText(/2 protected-content indicators highlighted/)).toBeTruthy();
    expect(errors).not.toHaveBeenCalled();
  });

  it("says a 503 is unavailable, and locks resolution until the page is visible", async () => {
    mount(sudWorkspace());
    server.answers.probe = 503;

    fireEvent.error(pageImage(SUD_PAGE));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Source page could not be loaded");
    expect(alert).toHaveTextContent(
      "Safeguard resolution remains locked until the page is visible.",
    );
    expect(server.requests.probes[0]).toMatchObject({ method: "HEAD" });
    expect(confirmSud()).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /Retry source/ }));
    loadPage(SUD_PAGE);
    expect(confirmSud()).not.toBeDisabled();
  });

  it("says source access is restricted for a 403, and offers no retry", async () => {
    mount(sudWorkspace());
    server.answers.probe = 403;
    fireEvent.error(pageImage(SUD_PAGE));
    expect(await screen.findByRole("alert")).toHaveTextContent("Source access is restricted");
    expect(screen.queryByRole("button", { name: /Retry source/ })).toBeNull();
  });

  it("says the session ended for a 401", async () => {
    mount(sudWorkspace());
    server.answers.probe = 401;

    fireEvent.error(pageImage(SUD_PAGE));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your session has ended");
  });

  it("reports a source that cannot be reached at all as unavailable", async () => {
    mount(sudWorkspace());
    server.answers.probe = "network";

    fireEvent.error(pageImage(SUD_PAGE));

    expect(await screen.findByRole("alert")).toHaveTextContent("Source page could not be loaded");
  });

  it("shows nothing for a probe answer that arrives after another page was opened", async () => {
    mount(sudAndIdentity());
    server.answers.probe = "pending";
    fireEvent.error(pageImage(SUD_PAGE));
    await waitFor(() => expect(server.requests.probes).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: `Review source page ${IDENTITY_PAGE}` }));
    server.releaseProbes(503);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(pageImage(IDENTITY_PAGE)).toBeTruthy();
    expect(screen.getByText("Loading source")).toBeTruthy();
  });

  it("never requests a page of withheld Part 2 content", () => {
    mount(sudWorkspace({ contentRedacted: true }));

    expect(screen.getByRole("alert")).toHaveTextContent("Source access is restricted");
    expect(screen.queryByRole("img")).toBeNull();
    expect(server.requests.probes).toHaveLength(0);
    expect(
      screen.getByText(/An authorized reviewer with a need to know must resolve it/),
    ).toBeTruthy();
  });

  it("says there is no source page when no safeguard has one", () => {
    mount(workspaceFixture());

    expect(screen.getByText("No safeguard source page is available")).toBeTruthy();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("names the heading the workspace focuses when it opens the safeguards", () => {
    mount(sudWorkspace());

    const heading = screen.getByRole("heading", { name: "Documents & protected information" });
    expect(heading.hasAttribute("data-task-heading")).toBe(true);
    expect(heading.getAttribute("tabindex")).toBe("-1");
  });
});

describe("ReviewSafeguardPanel Part 2 / SUD resolution", () => {
  it("confirms the safeguard once the source page shows", async () => {
    mount(sudWorkspace());
    expect(confirmSud()).toBeDisabled();
    expect(confirmSud()).toHaveAccessibleDescription(/unlocks once source page 2 is showing/);

    loadPage(SUD_PAGE);
    fireEvent.click(confirmSud());

    expect(await screen.findByText("Confirmed")).toBeTruthy();
    expect(server.requests.sud).toEqual([{ outcome: "confirmed" }]);
  });

  it("rejects the detection as a false positive with a reason of at least five characters", async () => {
    mount(sudWorkspace());
    loadPage(SUD_PAGE);

    fireEvent.click(rejectSud());
    const reason = screen.getByLabelText("False-positive reason");
    expect(document.activeElement).toBe(reason);
    expect(reason.getAttribute("type")).toBe("text");
    expect(reason.getAttribute("autocomplete")).toBe("off");
    const submit = screen.getByRole("button", { name: "Reject as false positive" });
    expect(submit).toBeDisabled();
    fireEvent.change(reason, { target: { value: "no" } });
    expect(submit).toBeDisabled();
    fireEvent.change(reason, { target: { value: "  clinic name, not a diagnosis  " } });
    fireEvent.click(submit);

    expect(await screen.findByText("Rejected")).toBeTruthy();
    expect(server.requests.sud).toEqual([
      { outcome: "rejected", reason: "clinic name, not a diagnosis" },
    ]);
  });

  it("returns focus to Reject false positive when the reason form is cancelled", () => {
    mount(sudWorkspace());
    loadPage(SUD_PAGE);
    fireEvent.click(rejectSud());

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(document.activeElement).toBe(rejectSud());
  });

  it("tells the workspace a save is in flight until it ends, whether it works or not", async () => {
    const onBusyChange = vi.fn();
    mount(sudWorkspace(), { onBusyChange });
    loadPage(SUD_PAGE);

    fireEvent.click(confirmSud());
    expect(await screen.findByText("Confirmed")).toBeTruthy();

    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it("tells the workspace the save has ended when the request is rejected", async () => {
    const onBusyChange = vi.fn();
    mount(sudWorkspace(), { onBusyChange });
    server.answers.sud = "network";
    loadPage(SUD_PAGE);

    fireEvent.click(confirmSud());
    await screen.findByRole("alert");

    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });

  it("unlocks and says so when the request is rejected", async () => {
    mount(sudWorkspace());
    server.answers.sud = "network";
    loadPage(SUD_PAGE);
    confirmSud().focus();

    fireEvent.click(confirmSud());

    expect(await screen.findByRole("alert")).toHaveTextContent(UNREACHABLE_DECISION_MESSAGE);
    expect(confirmSud()).not.toBeDisabled();
    expect(rejectSud()).not.toBeDisabled();
  });

  it("shows the server's refusal and unlocks", async () => {
    mount(sudWorkspace());
    server.answers.sud = { status: 409, message: "Someone else resolved this" };
    loadPage(SUD_PAGE);

    fireEvent.click(confirmSud());

    expect(await screen.findByRole("alert")).toHaveTextContent("Someone else resolved this");
    expect(confirmSud()).not.toBeDisabled();
  });

  it("warns when the workspace cannot be refreshed, and clears it once a retry works", async () => {
    mount(sudWorkspace());
    server.answers.refresh = "null";
    loadPage(SUD_PAGE);

    fireEvent.click(confirmSud());

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The safeguard was saved, but the workspace could not be refreshed.",
    );
    server.answers.refresh = "ok";
    fireEvent.click(screen.getByRole("button", { name: "Retry workspace refresh" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.queryByRole("button", { name: "Retry workspace refresh" })).toBeNull();
  });

  it("survives a refresh that is rejected, not only one that resolves to nothing", async () => {
    mount(sudWorkspace());
    server.answers.refresh = "throw";
    loadPage(SUD_PAGE);

    fireEvent.click(confirmSud());

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be refreshed/);
    expect(screen.getByRole("button", { name: "Retry workspace refresh" })).not.toBeDisabled();
  });

  it("stays locked, saying why, when another reviewer owns the review", () => {
    mount({ ...sudWorkspace(), review: { ...OWN_REVIEW, isMine: false } });
    loadPage(SUD_PAGE);

    expect(confirmSud()).toBeDisabled();
    expect(rejectSud()).toBeDisabled();
    expect(confirmSud()).toHaveAccessibleDescription("Another reviewer owns this review.");
  });

  it("stays locked, saying why, once the review is complete", () => {
    mount({ ...sudWorkspace(), review: { ...OWN_REVIEW, status: "complete" } });
    loadPage(SUD_PAGE);

    expect(confirmSud()).toBeDisabled();
    expect(confirmSud()).toHaveAccessibleDescription(/review is complete/);
  });

  it("is read-only in a support session, with a note rather than a live announcement", () => {
    mount(sudWorkspace(), { supportAccess: SUPPORT_ACCESS });
    loadPage(SUD_PAGE);

    const banner = screen.getByRole("note");
    expect(banner).toHaveTextContent("Read-only support session");
    expect(banner.tagName).toBe("DIV");
    expect(confirmSud()).toBeDisabled();
    expect(confirmSud()).toHaveAccessibleDescription(/Read-only support session/);
    expect(pageImage(SUD_PAGE).getAttribute("src")).toContain(
      `/api/v1/platform/organizations/${SUPPORT_ACCESS.organizationId}/`,
    );
  });

  it("shows a resolved safeguard as a summary with no controls", () => {
    mount({ ...sudWorkspace(), sud: { ...sudWorkspace().sud, status: "confirmed" } });

    expect(screen.getByText("Confirmed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Confirm Part 2 safeguard/ })).toBeNull();
  });
});

describe("ReviewSafeguardPanel focus after a resolution", () => {
  const heading = (): HTMLElement =>
    screen.getByRole("heading", { name: "Documents & protected information" });

  it("keeps focus on the panel heading when a confirmed safeguard drops its controls", async () => {
    mount(sudWorkspace());
    loadPage(SUD_PAGE);
    confirmSud().focus();

    fireEvent.click(confirmSud());

    await screen.findByText("Confirmed");
    await waitFor(() => expect(document.activeElement).toBe(heading()));
  });

  it("keeps focus on the panel heading when a resolved document leaves the list", async () => {
    mount({ ...workspaceFixture(), documents: [documentNeedingIdentity(IDENTITY_PAGE)] });
    loadPage(IDENTITY_PAGE);
    fireEvent.click(screen.getByRole("button", { name: "Same patient" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "same date of birth" } });
    screen.getByRole("button", { name: "Save identity resolution" }).focus();

    fireEvent.click(screen.getByRole("button", { name: "Save identity resolution" }));

    await screen.findByText("No unresolved documents");
    await waitFor(() => expect(document.activeElement).toBe(heading()));
  });

  it("leaves focus on the control when the save did not go through", async () => {
    mount(sudWorkspace());
    server.answers.sud = "network";
    loadPage(SUD_PAGE);
    confirmSud().focus();

    fireEvent.click(confirmSud());

    await screen.findByRole("alert");
    expect(document.activeElement).toBe(confirmSud());
  });
});

describe("ReviewSafeguardPanel patient identity", () => {
  it("opens the page of a document with the Review source page button, and parks focus on the block", () => {
    const view = mount(sudAndIdentity());
    loadPage(SUD_PAGE);
    expect(screen.getByRole("button", { name: "Same patient" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Same patient" })).toHaveAccessibleDescription(
      /unlocks once source page 3 is showing/,
    );

    fireEvent.click(screen.getByRole("button", { name: `Review source page ${IDENTITY_PAGE}` }));

    expect(view.onFocusBlock).toHaveBeenCalledWith(
      { kind: "identity", page: IDENTITY_PAGE },
      IDENTITY_PAGE,
    );
    expect(
      screen.queryByRole("button", { name: `Review source page ${IDENTITY_PAGE}` }),
    ).toBeNull();
    expect(document.activeElement).toBe(identityBlock());
    expect(pageImage(IDENTITY_PAGE)).toBeTruthy();
    loadPage(IDENTITY_PAGE);
    expect(screen.getByRole("button", { name: "Same patient" })).not.toBeDisabled();
  });

  it("saves the answer with a reason once the page shows, and then lists no document", async () => {
    mount({ ...workspaceFixture(), documents: [documentNeedingIdentity(IDENTITY_PAGE)] });
    loadPage(IDENTITY_PAGE);

    fireEvent.click(screen.getByRole("button", { name: "Another patient" }));
    const reason = screen.getByLabelText("Reason");
    expect(document.activeElement).toBe(reason);
    expect(reason.getAttribute("placeholder")).toBe("Why this belongs to another patient");
    expect(reason.getAttribute("type")).toBe("text");
    expect(reason.getAttribute("autocomplete")).toBe("off");
    const save = screen.getByRole("button", { name: "Save identity resolution" });
    expect(save).toBeDisabled();
    fireEvent.change(reason, { target: { value: "  different date of birth  " } });
    fireEvent.click(save);

    expect(await screen.findByText("No unresolved documents")).toBeTruthy();
    expect(server.requests.identity).toEqual([
      { pageFrom: IDENTITY_PAGE, resolution: "other_patient", reason: "different date of birth" },
    ]);
  });

  it("uses the consistent-identifiers prompt for Same patient", () => {
    mount({ ...workspaceFixture(), documents: [documentNeedingIdentity(IDENTITY_PAGE)] });
    loadPage(IDENTITY_PAGE);

    fireEvent.click(screen.getByRole("button", { name: "Same patient" }));

    expect(screen.getByLabelText("Reason").getAttribute("placeholder")).toBe(
      "Why the identifiers are consistent",
    );
  });

  it("returns focus to the answer button that opened the form when it is cancelled", () => {
    mount({ ...workspaceFixture(), documents: [documentNeedingIdentity(IDENTITY_PAGE)] });
    loadPage(IDENTITY_PAGE);
    fireEvent.click(screen.getByRole("button", { name: "Another patient" }));

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Another patient" }));
  });

  it("keeps the typed reason, unlocks and says so when the request is rejected", async () => {
    mount({ ...workspaceFixture(), documents: [documentNeedingIdentity(IDENTITY_PAGE)] });
    server.answers.identity = "network";
    loadPage(IDENTITY_PAGE);
    fireEvent.click(screen.getByRole("button", { name: "Same patient" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "same date of birth" } });

    fireEvent.click(screen.getByRole("button", { name: "Save identity resolution" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(UNREACHABLE_DECISION_MESSAGE);
    expect(screen.getByLabelText("Reason")).toHaveValue("same date of birth");
    expect(screen.getByRole("button", { name: "Save identity resolution" })).not.toBeDisabled();
  });

  it("warns when the workspace cannot be refreshed after an identity answer", async () => {
    mount({ ...workspaceFixture(), documents: [documentNeedingIdentity(IDENTITY_PAGE)] });
    server.answers.refresh = "null";
    loadPage(IDENTITY_PAGE);
    fireEvent.click(screen.getByRole("button", { name: "Same patient" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "same date of birth" } });

    fireEvent.click(screen.getByRole("button", { name: "Save identity resolution" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The identity resolution was saved, but the workspace could not be refreshed.",
    );
  });
});

describe("ReviewSafeguardPanel selection", () => {
  const sudSelection = { page: SUD_PAGE, focus: { kind: "sud" as const }, taskId: "safeguard:sud" };

  it("marks the chosen block with aria-current and no data-selected attribute", () => {
    mount(sudAndIdentity(), { selection: { ...sudSelection, reveal: false } });

    expect(sudBlock().getAttribute("aria-current")).toBe("true");
    expect(identityBlock().hasAttribute("aria-current")).toBe(false);
    expect(document.querySelector("[data-selected]")).toBeNull();
  });

  it("focuses and scrolls to the block only for a deliberate choice", () => {
    mount(sudAndIdentity(), { selection: { ...sudSelection, reveal: true } });

    expect(document.activeElement).toBe(sudBlock());
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("only marks the block for a restore, leaving focus where it was", () => {
    mount(sudAndIdentity(), { selection: { ...sudSelection, reveal: false } });

    expect(document.activeElement).not.toBe(sudBlock());
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it("opens the page the selection names", () => {
    mount(sudAndIdentity(), {
      selection: {
        page: IDENTITY_PAGE,
        focus: { kind: "identity", page: IDENTITY_PAGE },
        taskId: `safeguard:identity:${IDENTITY_PAGE}`,
        reveal: false,
      },
    });

    expect(pageImage(IDENTITY_PAGE)).toBeTruthy();
    expect(
      within(identityBlock()).queryByRole("button", { name: /Review source page/ }),
    ).toBeNull();
  });
});
