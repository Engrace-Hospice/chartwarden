import { createApiClient } from "@chartwarden/ui";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalApp } from "../src/app";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const summary = {
  patient: { layLabel: "Margaret Smith" },
  upcomingVisitsCount: 0,
  recentVisitsCount: 0,
  activeMedicationsCount: 0,
  unreadMessagesCount: 0,
  pendingDocumentSharesCount: 0,
};

const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** Render the portal for one signed-in person: `name` comes from the auth session, `relationship` from M31. */
function renderAs(
  person: { name: string | null; relationship: string },
  path = `/p/${PATIENT_ID}`,
  careSummary: typeof summary = summary,
) {
  window.history.pushState({}, "", `/portal${path}`);
  vi.stubGlobal("fetch", async (input: string) => {
    if (String(input) === "/api/auth/get-session") {
      return person.name ? json({ user: { name: person.name } }) : json(null);
    }
    return json({}, 404);
  });
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path === "/api/v1/portal/care-summary") return json(careSummary);
      if (path === "/api/v1/portal/visits/upcoming") return json({ category: "visits", items: [] });
      if (path === "/api/v1/portal/sessions/current")
        return json({
          portalAccountId: "22222222-2222-4222-8222-222222222222",
          activePatientId: PATIENT_ID,
          scopeSet: [],
          relationship: person.relationship,
          status: "active",
        });
      return json({}, 404);
    },
  });
  return render(<PortalApp client={client} />);
}

afterEach(() => vi.unstubAllGlobals());

describe("portal viewer: the patient's own view and the caregiver view", () => {
  it("greets a patient by their own first name and says it is their own record", async () => {
    renderAs({ name: "Pat Portal", relationship: "patient_self" });
    expect(
      await screen.findByRole("heading", {
        name: /^Good (morning|afternoon|evening), Pat$/,
        level: 1,
      }),
    ).toBeTruthy();
    expect(await screen.findByText("Your own record")).toBeTruthy();
    expect(screen.queryByText(/important part of/)).toBeNull();
    expect(screen.queryByText("Viewing care for")).toBeNull();
  });

  it("greets a caregiver as the patient's family and shows who they are caring for", async () => {
    renderAs({ name: "Dana Lee", relationship: "family_caregiver" });
    expect(
      await screen.findByRole("heading", {
        name: /^Good (morning|afternoon|evening), Margaret’s family$/,
        level: 1,
      }),
    ).toBeTruthy();
    expect(screen.getByText(/You’re an important part of Margaret’s care/)).toBeTruthy();
    expect(screen.getByText("Viewing care for")).toBeTruthy();
    expect(screen.queryByText("Your own record")).toBeNull();
  });

  it("never personalises from the API's generic patient placeholder", async () => {
    renderAs({ name: "Dana Lee", relationship: "family_caregiver" }, `/p/${PATIENT_ID}`, {
      ...summary,
      patient: { layLabel: "Your family member" },
    });
    expect(await screen.findByRole("heading", { name: "Welcome back", level: 1 })).toBeTruthy();
    expect(screen.queryByText(/Your’s/)).toBeNull();
  });

  it("uses quiet copy for an account that reaches the portal after the patient's death", async () => {
    renderAs({ name: "Dana Lee", relationship: "personal_representative_post_death" });
    expect(await screen.findByRole("heading", { name: "Welcome", level: 1 })).toBeTruthy();
    expect(screen.queryByText(/happening today/)).toBeNull();
  });

  it("falls back to the generic welcome when the session has no name", async () => {
    renderAs({ name: null, relationship: "patient_self" });
    expect(await screen.findByRole("heading", { name: "Welcome back", level: 1 })).toBeTruthy();
  });

  it("account page: a patient is signed in as the patient; a caregiver sees name and role", async () => {
    const own = renderAs({ name: "Pat Portal", relationship: "patient_self" }, "/account");
    expect(await screen.findByText("You're signed in as the patient")).toBeTruthy();
    own.unmount();

    renderAs({ name: "Dana Lee", relationship: "family_caregiver" }, "/account");
    expect(await screen.findByText("Dana Lee · Family caregiver")).toBeTruthy();
  });
});
