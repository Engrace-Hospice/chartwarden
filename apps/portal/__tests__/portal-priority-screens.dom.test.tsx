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

function fixtureClient() {
  return createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
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
      if (url.pathname === "/api/v1/portal/visits/history") return json({ items: [] });
      if (url.pathname === "/api/v1/portal/messages/channel") {
        return json({ channelId: "33333333-3333-4333-8333-333333333333", lastReadPointer: null });
      }
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
      if (url.pathname === "/api/v1/portal/administrations/recent") return json({ items: [] });
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

  it("keeps visit information labelled when the table becomes mobile cards", async () => {
    window.history.pushState({}, "", `/p/${PATIENT_ID}/visits`);
    render(<PortalApp client={fixtureClient()} />);

    const when = await screen.findByRole("cell", { name: /2026-10-14/ });
    expect(when.getAttribute("data-label")).toBe("When");
    expect(screen.getByRole("link", { name: "Join" }).getAttribute("href")).toContain(
      "/telehealth",
    );
  });

  it("uses the shared, described composer for secure messages", async () => {
    window.history.pushState({}, "", `/p/${PATIENT_ID}/messages`);
    render(<PortalApp client={fixtureClient()} />);

    const composer = await screen.findByRole("textbox", { name: /Write to your care team/ });
    expect(composer.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("renders shared documents with explicit mobile labels", async () => {
    window.history.pushState({}, "", `/p/${PATIENT_ID}/documents`);
    render(<PortalApp client={fixtureClient()} />);

    const documentCell = await screen.findByRole("cell", { name: "Welcome guide" });
    expect(documentCell.getAttribute("data-label")).toBe("Document");
    expect(screen.getByRole("combobox", { name: "Document type" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });

  it("offers and persists the account theme choice", async () => {
    window.history.pushState({}, "", "/account");
    render(<PortalApp client={fixtureClient()} />);

    const toggle = await screen.findByRole("button", { name: "Use dark theme" });
    fireEvent.click(toggle);

    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));
    expect(window.localStorage.getItem("wx-theme")).toBe("dark");
  });

  it("labels medication data and the caregiver attestation form", async () => {
    window.history.pushState({}, "", `/p/${PATIENT_ID}/medications`);
    render(<PortalApp client={fixtureClient()} />);

    const medication = await screen.findByRole("cell", { name: "Sample medication" });
    expect(medication.getAttribute("data-label")).toBe("Medication");
    expect(screen.getByRole("combobox", { name: /Medication/ })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /Caregiver attestation/ })).toBeTruthy();
  });

  it("keeps amendment requests as a tracked request rather than a direct edit", async () => {
    window.history.pushState({}, "", `/p/${PATIENT_ID}/amendments`);
    render(<PortalApp client={fixtureClient()} />);

    expect(await screen.findByRole("cell", { name: "Synthetic correction request" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: /Requested change/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit request" })).toBeDisabled();
  });

  it("requires telehealth consent before enabling the join action", () => {
    window.history.pushState(
      {},
      "",
      `/p/${PATIENT_ID}/visits/88888888-8888-4888-8888-888888888888/telehealth`,
    );
    render(<PortalApp client={fixtureClient()} />);

    const join = screen.getByRole("button", { name: "Join visit" });
    expect(join).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(join).not.toBeDisabled();
  });
});
