import { fireEvent, render, screen, waitFor } from "@testing-library/react";
// @wardenx/portal — lots 6/7 contracts for the priority lists, composer, and account appearance.
import { createApiClient } from "@wardenx/ui";
import { beforeEach, describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fixtureClient(requests: string[] = []) {
  return createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requests.push(
        `${input instanceof Request ? input.method : "GET"} ${url.pathname}`,
      );
      if (url.pathname === "/api/v1/portal/visits/upcoming") {
        return json({
          items: [
            {
              visitId: "22222222-2222-4222-8222-222222222222",
              scheduledStart: "2026-10-14T14:00:00.000Z",
              discipline: "registered_nurse",
              modality: "telehealth",
              status: "scheduled",
              joinable: true,
            },
          ],
        });
      }
      if (url.pathname === "/api/v1/portal/visits/history")
        return json({ items: [] });
      if (url.pathname === "/api/v1/portal/messages/channel") {
        return json({
          channelId: "33333333-3333-4333-8333-333333333333",
          lastReadPointer: null,
        });
      }
      if (url.pathname === "/api/v1/portal/messages/history")
        return json({ messages: [] });
      if (url.pathname === "/api/v1/portal/documents") {
        return json({
          items: [
            {
              documentId: "44444444-4444-4444-8444-444444444444",
              title: "Welcome guide",
              documentType: "care_guide",
              sharedAt: "2026-10-12T10:00:00.000Z",
            },
          ],
        });
      }
      if (url.pathname === "/api/v1/portal/medications/active") {
        return json({
          items: [
            {
              medicationOrderId: "66666666-6666-4666-8666-666666666666",
              drugName: "Sample medication",
              dose: "5 mg",
              route: "oral",
              scheduleSummary: "Every morning",
              isPrn: false,
            },
          ],
        });
      }
      if (url.pathname === "/api/v1/portal/administrations/recent")
        return json({ items: [] });
      if (url.pathname === "/api/v1/portal/amendments") {
        return json({
          items: [
            {
              id: "77777777-7777-4777-8777-777777777777",
              targetKind: "patient_demographic",
              requestedChange: "Synthetic correction request",
              status: "submitted",
              submittedAt: "2026-10-12T10:00:00.000Z",
            },
          ],
        });
      }
      if (url.pathname === "/api/v1/portal/sessions/current") {
        return json({
          portalAccountId: "55555555-5555-4555-8555-555555555555",
          activePatientId: PATIENT_ID,
          scopeSet: ["visits", "messages"],
          relationship: "family_caregiver",
          status: "active",
        });
      }
      return new Response(null, { status: 404 });
    },
  });
}

describe("portal priority screens", () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("presents the next visit as a patient-facing card", async () => {
    window.history.pushState({}, "", `/p/${PATIENT_ID}/visits`);
    render(<PortalApp client={fixtureClient()} />);

    expect(
      await screen.findByRole("heading", { name: "Registered Nurse" }),
    ).toBeTruthy();
    expect(screen.getByText("Telehealth")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Join video visit" })
        .getAttribute("href"),
    ).toContain("/telehealth");
  });

  it("uses the shared, described composer for secure messages", async () => {
    window.history.pushState({}, "", `/p/${PATIENT_ID}/messages`);
    render(<PortalApp client={fixtureClient()} />);

    const composer = await screen.findByRole("textbox", {
      name: /Message your care team/,
    });
    expect(composer.getAttribute("aria-describedby")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Send message",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it("renders shared documents as a semantic, responsive library", async () => {
    window.history.pushState({}, "", `/p/${PATIENT_ID}/documents`);
    render(<PortalApp client={fixtureClient()} />);

    expect(
      await screen.findByRole("heading", { name: "Welcome guide" }),
    ).toBeTruthy();
    expect(screen.getByRole("list")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Download Welcome guide" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Send a document" }),
    ).toBeTruthy();
  });

  it("offers and persists the account theme choice", async () => {
    window.history.pushState({}, "", "/account");
    render(<PortalApp client={fixtureClient()} />);

    const toggle = await screen.findByRole("button", { name: "Dark" });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(document.documentElement.classList.contains("dark")).toBe(true),
    );
    expect(window.localStorage.getItem("wx-theme")).toBe("dark");
  });

  it("shows medication details and opens the caregiver report only on request", async () => {
    window.history.pushState({}, "", `/p/${PATIENT_ID}/medications`);
    render(<PortalApp client={fixtureClient()} />);

    expect(
      await screen.findByRole("heading", { name: "Sample medication" }),
    ).toBeTruthy();
    expect(screen.getByText("Every morning")).toBeTruthy();
    expect(
      screen.queryByRole("dialog", { name: "Record a dose given" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Record a dose given" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Record a dose given" });
    expect(dialog.querySelector("select")).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: /Caregiver attestation/ }),
    ).toBeTruthy();
  });

  it("keeps amendment requests as a tracked request rather than a direct edit", async () => {
    window.history.pushState({}, "", `/p/${PATIENT_ID}/amendments`);
    render(<PortalApp client={fixtureClient()} />);

    expect(
      await screen.findByText("Synthetic correction request"),
    ).toBeTruthy();
    expect(
      screen.getByRole("textbox", { name: "Describe the correction" }),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: /Review request/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("requires telehealth consent before enabling and submitting the join action", async () => {
    const requests: string[] = [];
    window.history.pushState(
      {},
      "",
      `/p/${PATIENT_ID}/visits/88888888-8888-4888-8888-888888888888/telehealth`,
    );
    render(<PortalApp client={fixtureClient(requests)} />);

    const join = screen.getByRole("button", { name: "Join visit" });
    expect((join as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(join);
    expect(requests.some((request) => request.includes("/telehealth/"))).toBe(
      false,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect((join as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(join);
    await waitFor(() =>
      expect(
        requests.some((request) =>
          request.includes(
            "/portal/telehealth/visits/88888888-8888-4888-8888-888888888888/join",
          ),
        ),
      ).toBe(true),
    );
  });
});
