import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
// @chartwarden/portal — authenticated shell contract. The sign-in flow remains chromeless, while every
// patient route keeps the short navigation, explicit patient context, and urgent-help guidance.
import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import { describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";
import { PortalPatientContext, usePortalPatient } from "../src/patient-context";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

function stubClient(label = "Alex Morgan") {
  return createApiClient({
    baseUrl: "http://localhost",
    fetch: async (request) => {
      const url = request instanceof Request ? request.url : String(request);
      if (url.includes("/api/v1/portal/care-summary")) {
        return Response.json({
          patient: { layLabel: label },
          upcomingVisitsCount: 0,
          recentVisitsCount: 0,
          activeMedicationsCount: 0,
          unreadMessagesCount: 0,
          pendingDocumentSharesCount: 0,
        });
      }
      return new Response(JSON.stringify({ error: { code: "TEST_STUB", message: "no backend" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });
}

describe("portal authenticated shell", () => {
  it("keeps the sign-in route chromeless", () => {
    window.history.pushState({}, "", "/");
    render(<PortalApp client={stubClient()} />);

    expect(screen.queryByRole("navigation", { name: "Portal navigation" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Family Portal sidebar" })).toBeNull();
    expect(screen.queryByRole("complementary", { name: "Urgent care information" })).toBeNull();
  });

  it("provides patient navigation, context, and persistent urgent help", async () => {
    window.history.pushState({}, "", `/p/${PATIENT_ID}/messages`);
    render(<PortalApp client={stubClient()} />);

    const nav = screen.getByRole("navigation", { name: "Portal navigation" });
    expect(nav).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Home" }).getAttribute("href")).toBe(
      `/p/${PATIENT_ID}`,
    );
    expect(within(nav).getByRole("link", { name: "Messages" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(screen.getByRole("link", { name: "Switch patient" }).getAttribute("href")).toBe(
      "/patient-picker",
    );
    expect(within(nav).getByRole("link", { name: "Care plan" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Medications" })).toBeTruthy();
    expect(within(nav).getByRole("link", { name: "Bereavement support" })).toBeTruthy();
    expect(await screen.findByText("Alex Morgan")).toBeTruthy();
    expect(screen.getByRole("main").id).toBe("portal-main");
    expect(screen.getByRole("complementary", { name: "Urgent care information" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Mobile portal navigation" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("dialog", { name: "More portal destinations" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "More portal destinations" })).toBeTruthy();

    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
  });

  it("uses compact account navigation and on-demand help without a selected patient", async () => {
    window.history.pushState({}, "", "/patient-picker");
    render(<PortalApp client={stubClient()} />);

    const nav = screen.getByRole("navigation", { name: "Portal account navigation" });
    expect(within(nav).getByRole("link", { name: "Choose patient" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Account & security" })).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Mobile account navigation" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Urgent care information" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Help" }));
    expect(screen.getByRole("dialog", { name: "Need urgent help?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close help" }));
    expect(screen.queryByRole("dialog", { name: "Need urgent help?" })).toBeNull();
  });

  it("clears the previous patient identity while a new patient context loads", async () => {
    let resolveSecond: ((response: Response) => void) | undefined;
    let requests = 0;
    const client = createApiClient({
      baseUrl: "http://localhost",
      fetch: async () => {
        requests += 1;
        if (requests === 1) return Response.json({ patient: { layLabel: "First patient" } });
        return new Promise<Response>((resolve) => {
          resolveSecond = resolve;
        });
      },
    });
    function Probe(): JSX.Element {
      const patient = usePortalPatient();
      return (
        <output>{patient.loading ? "Loading patient" : patient.summary?.patient.layLabel}</output>
      );
    }
    const view = render(
      <ApiClientProvider client={client}>
        <PortalPatientContext patientId="patient-a">
          <Probe />
        </PortalPatientContext>
      </ApiClientProvider>,
    );
    expect(await screen.findByText("First patient")).toBeTruthy();
    view.rerender(
      <ApiClientProvider client={client}>
        <PortalPatientContext patientId="patient-b">
          <Probe />
        </PortalPatientContext>
      </ApiClientProvider>,
    );
    expect(screen.queryByText("First patient")).toBeNull();
    expect(screen.getByText("Loading patient")).toBeTruthy();
    await waitFor(() => expect(requests).toBe(2));
    await act(async () => {
      resolveSecond?.(Response.json({ patient: { layLabel: "Second patient" } }));
    });
    expect(await screen.findByText("Second patient")).toBeTruthy();
  });
});

describe("PR5 mobile navigation regression", () => {
  it("labels icon-only links and dismisses More after navigation", async () => {
    window.history.pushState({}, "", `/p/${PATIENT_ID}/care-plan`);
    render(<PortalApp client={stubClient()} />);
    const sidebar = screen.getByRole("navigation", {
      name: "Portal navigation",
    });
    expect(
      within(sidebar).getByRole("link", { name: "Care plan" }).getAttribute("aria-label"),
    ).toBe("Care plan");
    const more = screen.getByRole("button", { name: "More" });
    expect(more.className).toContain("is-active");
    fireEvent.click(more);
    const sheet = screen.getByRole("navigation", {
      name: "More portal destinations",
    });
    fireEvent.click(within(sheet).getByRole("link", { name: "Documents" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/p/${PATIENT_ID}/documents`));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "More portal destinations" })).toBeNull(),
    );
  });
});
