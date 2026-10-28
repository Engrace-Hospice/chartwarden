import { createApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";

const PATIENT = "11111111-1111-4111-8111-111111111111";
const OTHER_PATIENT = "22222222-2222-4222-8222-222222222222";
const careSummary = {
  problems: [
    {
      problemId: "p1",
      label: "Comfort",
      goals: ["Support a comfortable daily routine", "Talk about changing needs"],
      focus: ["Symptoms and comfort", "Communication"],
    },
    {
      problemId: "p2",
      label: "Family support",
      goals: [],
      focus: ["Caregiver questions"],
    },
    {
      problemId: "p3",
      label: "Additional care area",
      goals: [],
      focus: [],
    },
  ],
  redacted: false,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type Handler = (path: string) => Response | Promise<Response>;
function renderCarePlan(
  handler: Handler = (path) =>
    path === "/api/v1/portal/care-plan/summary" ? json(careSummary) : json({}, 404),
) {
  window.history.pushState({}, "", `/portal/p/${PATIENT}/care-plan`);
  const requests: string[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      requests.push(path);
      if (path === "/api/v1/portal/care-summary")
        return json({
          patient: { layLabel: "Example patient" },
          upcomingVisitsCount: 0,
          recentVisitsCount: 0,
          activeMedicationsCount: 0,
          unreadMessagesCount: 0,
          pendingDocumentSharesCount: 0,
        });
      return handler(path);
    },
  });
  return { ...render(<PortalApp client={client} />), requests };
}

describe("patient care-plan redesign", () => {
  it("shows authorized care areas, goals and focus without inventing completion states", async () => {
    const { requests } = renderCarePlan();
    expect(await screen.findByRole("heading", { name: "Comfort" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Care plan", level: 1 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Your care areas" })).toBeTruthy();
    expect(screen.getByText("3 areas shared")).toBeTruthy();
    const list = screen.getByRole("list", { name: "Care areas" });
    expect(within(list).getByText("Family support")).toBeTruthy();
    expect(screen.getByText("Support a comfortable daily routine")).toBeTruthy();
    expect(screen.getByText("Talk about changing needs")).toBeTruthy();
    expect(screen.getByText("Symptoms and comfort")).toBeTruthy();
    expect(screen.getByText("Caregiver questions")).toBeTruthy();
    expect(
      screen.getByText("No additional details have been shared for this care area."),
    ).toBeTruthy();
    expect(screen.getByText(/This is a read-only summary/)).toBeTruthy();
    expect(screen.queryByText(/100% complete|goals achieved|care plan approved/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /edit|sign|complete goal/i })).toBeNull();
    expect(requests.filter((path) => path === "/api/v1/portal/care-plan/summary")).toHaveLength(1);
  });

  it("does not show a privacy notice unless the backend marks the summary as redacted", async () => {
    renderCarePlan();
    await screen.findByRole("heading", { name: "Comfort" });
    expect(screen.queryByRole("note", { name: "Care plan privacy notice" })).toBeNull();
  });

  it("explains redacted content without revealing or guessing its subject", async () => {
    renderCarePlan((path) =>
      path === "/api/v1/portal/care-plan/summary"
        ? json({ ...careSummary, redacted: true })
        : json({}, 404),
    );
    const notice = await screen.findByRole("note", { name: "Care plan privacy notice" });
    expect(within(notice).getByText("Some details are not shown here")).toBeTruthy();
    expect(within(notice).getByText(/available to your account/)).toBeTruthy();
    expect(within(notice).queryByText(/substance|violence|redaction reason/i)).toBeNull();
  });

  it("distinguishes an empty shared summary from a fully redacted view", async () => {
    const { unmount } = renderCarePlan((path) =>
      path === "/api/v1/portal/care-plan/summary"
        ? json({ problems: [], redacted: false })
        : json({}, 404),
    );
    expect(
      await screen.findByRole("heading", { name: "No care-plan items shared yet" }),
    ).toBeTruthy();
    unmount();
    renderCarePlan((path) =>
      path === "/api/v1/portal/care-plan/summary"
        ? json({ problems: [], redacted: true })
        : json({}, 404),
    );
    expect(
      await screen.findByRole("heading", { name: "No care-plan details available to show" }),
    ).toBeTruthy();
    expect(screen.getByRole("note", { name: "Care plan privacy notice" })).toBeTruthy();
  });

  it("shows an error rather than falsely reporting no goals, and supports retry", async () => {
    let attempts = 0;
    renderCarePlan((path) => {
      if (path === "/api/v1/portal/care-plan/summary") {
        attempts += 1;
        return attempts === 1 ? json({}, 500) : json(careSummary);
      }
      return json({}, 404);
    });
    const error = await screen.findByRole("alert");
    expect(within(error).getByRole("heading", { name: "Care plan unavailable" })).toBeTruthy();
    expect(screen.queryByText("No care-plan items shared yet")).toBeNull();
    fireEvent.click(within(error).getByRole("button", { name: /Try again/ }));
    expect(await screen.findByRole("heading", { name: "Comfort" })).toBeTruthy();
    expect(attempts).toBe(2);
  });

  it("does not disclose care-plan data when the portal API denies access", async () => {
    renderCarePlan((path) =>
      path === "/api/v1/portal/care-plan/summary"
        ? json({ error: { code: "FORBIDDEN" } }, 403)
        : json({}, 404),
    );
    expect(await screen.findByRole("heading", { name: "Care plan unavailable" })).toBeTruthy();
    expect(screen.getByText("This information is not available on your account.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Care areas" })).toBeNull();
  });

  it("does not interpret invalid server DTOs as an empty care plan", async () => {
    renderCarePlan((path) =>
      path === "/api/v1/portal/care-plan/summary" ? json({ wrongProperty: [] }) : json({}, 404),
    );
    expect(await screen.findByRole("heading", { name: "Care plan unavailable" })).toBeTruthy();
    expect(screen.queryByText("No care-plan items shared yet")).toBeNull();
  });

  it("escapes patient-visible text rather than interpreting it as HTML", async () => {
    renderCarePlan((path) =>
      path === "/api/v1/portal/care-plan/summary"
        ? json({
            problems: [
              {
                problemId: "p",
                label: "<script>alert(1)</script>",
                goals: ["<b>Text</b>"],
                focus: [],
              },
            ],
            redacted: false,
          })
        : json({}, 404),
    );
    expect(await screen.findByRole("heading", { name: "<script>alert(1)</script>" })).toBeTruthy();
    expect(screen.getByText("<b>Text</b>")).toBeTruthy();
    expect(document.querySelector(".wx-care-plan-area script")).toBeNull();
    expect(document.querySelector(".wx-care-plan-area b")).toBeNull();
  });

  it("does not render stale patient PHI when a pending response resolves after switching", async () => {
    let resolveOld: ((response: Response) => void) | undefined;
    let count = 0;
    renderCarePlan((path) => {
      if (path !== "/api/v1/portal/care-plan/summary") return json({}, 404);
      count += 1;
      if (count === 1)
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      return json({
        problems: [
          { problemId: "new", label: "New patient goal area", goals: ["New goal"], focus: [] },
        ],
        redacted: false,
      });
    });
    await waitFor(() => expect(count).toBe(1));
    window.history.pushState({}, "", `/portal/p/${OTHER_PATIENT}/care-plan`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { name: "New patient goal area" })).toBeTruthy();
    await act(async () => {
      resolveOld?.(
        json({
          problems: [
            { problemId: "old", label: "Old patient PHI", goals: ["Old goal"], focus: [] },
          ],
          redacted: true,
        }),
      );
    });
    expect(screen.queryByText("Old patient PHI")).toBeNull();
    expect(screen.queryByText("Old goal")).toBeNull();
    expect(screen.queryByRole("note", { name: "Care plan privacy notice" })).toBeNull();
  });
});
