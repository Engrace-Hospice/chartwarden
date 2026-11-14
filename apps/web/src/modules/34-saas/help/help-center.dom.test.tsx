import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ok, refused, renderAt, stubClient } from "../wizard/test-support";
import { HelpCenter } from "./help-center";

const PATH = "/api/v1/tenant/help-requests";

afterEach(cleanup);

describe("HelpCenter", () => {
  it("files a non-PHI onboarding request with the step from the URL", async () => {
    let reads = 0;
    const client = stubClient({
      GET: {
        [PATH]: () => {
          reads += 1;
          return ok({ current: null, items: [], nextCursor: null, hasMore: false });
        },
      },
      POST: { [PATH]: () => ok({}, 201) },
    });
    renderAt(
      "/admin/help?topic=mac_configured",
      [{ path: "/admin/help", element: <HelpCenter /> }],
      client,
    );

    fireEvent.change(await screen.findByLabelText("What do you need help with?"), {
      target: { value: "The portal test is not completing." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send request" }));

    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(client.POST.mock.calls[0]?.[1]?.body).toEqual({
      message: "The portal test is not completing.",
      stepKey: "mac_configured",
    });
    await waitFor(() => expect(reads).toBeGreaterThan(1));
  });

  it("shows the recorded-session banner and lets the tenant end help", async () => {
    const current = {
      id: "help-1",
      status: "approved",
      phase: "in_session",
      message: "Please help with the setup screen.",
      requestedAt: "2026-11-10T00:00:00.000Z",
      stepKey: "mac_configured",
      closeNote: null,
      closedBy: null,
      session: {
        state: "open",
        expiresAt: "2026-11-10T08:00:00.000Z",
        actionCount: 2,
        lastActionAt: "2026-11-10T01:00:00.000Z",
      },
    };
    const client = stubClient({
      GET: {
        [PATH]: () => ok({ current, items: [], nextCursor: null, hasMore: false }),
      },
      POST: {
        "/api/v1/tenant/help-requests/{id}/close": () => ok({}),
      },
    });
    renderAt("/admin/help", [{ path: "/admin/help", element: <HelpCenter /> }], client);

    expect(await screen.findByText(/Everything they do is recorded/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End help" }));
    await waitFor(() => expect(client.POST).toHaveBeenCalledTimes(1));
    expect(client.POST.mock.calls[0]?.[1]?.params?.path).toEqual({ id: "help-1" });
  });

  it("offers Re-verify when approving help needs a fresh step-up", async () => {
    const current = {
      id: "help-1",
      status: "open",
      phase: "waiting_for_consent",
      message: "Please help with the setup screen.",
      requestedAt: "2026-11-10T00:00:00.000Z",
      stepKey: "mac_configured",
      closeNote: null,
      closedBy: null,
      session: null,
    };
    const client = stubClient({
      GET: {
        [PATH]: () => ok({ current, items: [], nextCursor: null, hasMore: false }),
      },
      POST: {
        "/api/v1/tenant/help-requests/{id}/approve": () => refused(403, "STEP_UP_REQUIRED"),
      },
    });
    renderAt("/admin/help", [{ path: "/admin/help", element: <HelpCenter /> }], client);

    fireEvent.click(await screen.findByRole("button", { name: "Approve 8 hours of non-PHI help" }));

    expect(await screen.findByRole("link", { name: "Re-verify" })).toBeTruthy();
  });
});
