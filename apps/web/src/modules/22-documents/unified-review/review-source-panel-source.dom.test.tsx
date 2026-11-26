import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../doclens-api";
import {
  CANDIDATE_ID,
  SECOND_CANDIDATE_ID,
  SUPPORT_ACCESS,
  candidateFixture,
  createPanelServer,
  mountSourcePanel,
  workspaceFixture,
} from "./review-panel-test-kit";
import type { PanelServer, SourcePanelProps } from "./review-panel-test-kit";

let server: PanelServer;

function mount(workspace: Workspace = workspaceFixture(), props: SourcePanelProps = {}) {
  server = createPanelServer(workspace);
  return mountSourcePanel(server, props);
}

const image = (): HTMLElement => screen.getByRole("img", { name: /Page 1 of the source document/ });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ReviewSourcePanel source availability", () => {
  it("reports the page as available when it loads", () => {
    const view = mount();

    fireEvent.load(image());

    expect(view.onAvailabilityChange).toHaveBeenCalledWith(1, false);
    expect(view.onAvailabilityChange).not.toHaveBeenCalledWith(1, true);
  });

  it("reports the page as unavailable after a 503, then available again after a retry loads it", async () => {
    server = createPanelServer(workspaceFixture());
    server.answers.probe = 503;
    const view = mountSourcePanel(server);

    fireEvent.error(image());

    expect(await screen.findByRole("alert")).toHaveTextContent("Source page could not be loaded");
    expect(view.onAvailabilityChange).toHaveBeenCalledWith(1, true);
    expect(server.requests.probes).toHaveLength(1);
    expect(server.requests.probes[0]).toMatchObject({ method: "HEAD" });
    expect(server.requests.probes[0]?.url).toMatch(/\/pages\/1\/image$/);

    fireEvent.click(screen.getByRole("button", { name: /Retry source/ }));
    fireEvent.load(image());

    expect(screen.getByText("Source loaded")).toBeTruthy();
    expect(view.onAvailabilityChange).toHaveBeenLastCalledWith(1, false);
  });

  it("says source access is restricted, with no retry, when the page image is refused with 403", async () => {
    server = createPanelServer(workspaceFixture());
    server.answers.probe = 403;
    const view = mountSourcePanel(server);

    fireEvent.error(image());

    expect(await screen.findByRole("alert")).toHaveTextContent("Source access is restricted");
    expect(screen.queryByRole("button", { name: /Retry source/ })).toBeNull();
    expect(view.onAvailabilityChange).toHaveBeenCalledWith(1, true);
  });

  it("says the session has ended when the page image is refused with 401", async () => {
    server = createPanelServer(workspaceFixture());
    server.answers.probe = 401;
    mountSourcePanel(server);

    fireEvent.error(image());

    expect(await screen.findByRole("alert")).toHaveTextContent("Your session has ended");
    expect(screen.getByRole("button", { name: /Retry source/ })).toBeTruthy();
  });

  it("reports a source that cannot be reached at all as unavailable", async () => {
    server = createPanelServer(workspaceFixture());
    server.answers.probe = "network";
    mountSourcePanel(server);

    fireEvent.error(image());

    expect(await screen.findByRole("alert")).toHaveTextContent("Source page could not be loaded");
  });

  it("probes the support-session URL in a support session", async () => {
    server = createPanelServer(workspaceFixture());
    server.answers.probe = 503;
    mountSourcePanel(server, { supportAccess: SUPPORT_ACCESS });

    fireEvent.error(image());

    await screen.findByRole("alert");
    const { url } = server.requests.probes[0] ?? { url: "" };
    expect(url).toContain(`/api/v1/platform/organizations/${SUPPORT_ACCESS.organizationId}/`);
    expect(url).toContain(`supportSessionId=${SUPPORT_ACCESS.supportSessionId}`);
  });

  it("ignores a probe answer that arrives after another task was opened", async () => {
    server = createPanelServer(
      workspaceFixture([
        candidateFixture(CANDIDATE_ID),
        candidateFixture(SECOND_CANDIDATE_ID, { fieldPath: "patient.address.state", value: "OR" }),
      ]),
    );
    server.answers.probe = "pending";
    const view = mountSourcePanel(server);
    fireEvent.error(image());
    await waitFor(() => expect(server.requests.probes).toHaveLength(1));

    view.rerender({ candidateId: SECOND_CANDIDATE_ID });
    server.releaseProbes(503);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(view.onAvailabilityChange).not.toHaveBeenCalled();
  });

  it("ignores a probe answer that arrives after the panel closed", async () => {
    server = createPanelServer(workspaceFixture());
    server.answers.probe = "pending";
    const view = mountSourcePanel(server);
    fireEvent.error(image());
    await waitFor(() => expect(server.requests.probes).toHaveLength(1));

    cleanup();
    server.releaseProbes(503);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(view.onAvailabilityChange).not.toHaveBeenCalled();
  });

  it("announces the loading and loaded states in an always-mounted status region", () => {
    mount();
    const status = screen.getByText("Loading source").closest("output");
    expect(status).toBeTruthy();

    fireEvent.load(image());

    expect(screen.getByText("Source loaded").closest("output")).toBe(status);
  });

  it("makes the scrolling page viewport a named, keyboard-focusable region", () => {
    mount();

    const viewport = screen.getByRole("region", { name: "Source page" });
    expect(viewport.getAttribute("tabindex")).toBe("0");
  });

  it("says where it cannot highlight when the workspace has no entry for the page", () => {
    mount(workspaceFixture([candidateFixture(CANDIDATE_ID)], { pages: [] }));

    fireEvent.load(image());

    expect(document.querySelector(".wx-unified-source-box")).toBeNull();
    expect(
      screen.getByText("Location on the page is unavailable; compare the whole page."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /I compared this with the source/ }));
    expect(screen.getByRole("button", { name: "Accept extracted value" })).not.toBeDisabled();
  });
});
