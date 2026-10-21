import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createApiClient } from "@chartwarden/ui";
import { beforeEach, describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";

const PATIENT = "11111111-1111-4111-8111-111111111111";
const json = (data: unknown) => Response.json(data);

function stub(
  handler: (
    path: string,
    method: string,
    body: Record<string, unknown> | null,
  ) => Response | Promise<Response>,
) {
  return createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const req = input instanceof Request ? input : new Request(input);
      const text = req.method === "POST" ? await req.text() : "";
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      return handler(new URL(req.url).pathname, req.method, body);
    },
  });
}
const session = {
  portalAccountId: "account-1",
  activePatientId: PATIENT,
  scopeSet: ["visits"],
  relationship: "family_caregiver",
  status: "active",
};

beforeEach(() => {
  window.localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("PR4.2 account and preferences", () => {
  it("shows current relationship, patient return and actual notification destination", async () => {
    window.history.pushState({}, "", "/account");
    render(
      <PortalApp
        client={stub((path) =>
          path.endsWith("/sessions/current") ? json(session) : new Response(null, { status: 404 }),
        )}
      />,
    );
    expect(await screen.findByText("Family Caregiver")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Back to patient home/ }).getAttribute("href")).toBe(
      `/p/${PATIENT}`,
    );
    expect(
      screen.getByRole("link", { name: /View notification preferences/ }).getAttribute("href"),
    ).toBe(`/p/${PATIENT}/preferences`);
    expect(screen.getByRole("heading", { name: "Verify your identity" })).toBeTruthy();
    expect(screen.queryByText(/Change password/)).toBeNull();
  });

  it("requires a valid-length code and reports verification errors honestly", async () => {
    const submitted: unknown[] = [];
    window.history.pushState({}, "", "/account");
    render(
      <PortalApp
        client={stub((path, method, body) => {
          if (path.endsWith("/sessions/current")) return json(session);
          if (path.endsWith("/sessions/step-up") && method === "POST") {
            submitted.push(body?.totpCode);
            return new Response(null, { status: 423 });
          }
          return new Response(null, { status: 404 });
        })}
      />,
    );
    const verify = await screen.findByRole("button", { name: "Verify code" });
    expect((verify as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "One-time code" }), {
      target: { value: "123456" },
    });
    fireEvent.click(verify);
    await waitFor(() => expect(submitted).toEqual(["123456"]));
    expect(
      await screen.findByText("We could not load this right now. Please try again in a moment."),
    ).toBeTruthy();
  });

  it("changes light/dark mode without server requests", async () => {
    window.history.pushState({}, "", "/account");
    render(
      <PortalApp
        client={stub((path) =>
          path.endsWith("/sessions/current") ? json(session) : new Response(null, { status: 404 }),
        )}
      />,
    );
    const dark = await screen.findByRole("button", { name: "Dark" });
    fireEvent.click(dark);
    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));
    expect(window.localStorage.getItem("wx-theme")).toBe("dark");
    expect(dark.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders notification settings as read-only verified data", async () => {
    window.history.pushState({}, "", `/p/${PATIENT}/preferences`);
    render(
      <PortalApp
        client={stub((path) => {
          if (path.endsWith("/notification-preferences"))
            return json({
              channels: [
                { channel: "email", enabled: true },
                { channel: "sms", enabled: false },
              ],
              quietHours: { startHour: 22, endHour: 7 },
            });
          if (path.endsWith("/care-summary")) return json({ patient: { layLabel: "Example" } });
          return new Response(null, { status: 404 });
        })}
      />,
    );
    expect(await screen.findByText("Email notifications")).toBeTruthy();
    expect(screen.getByText("Text message notifications")).toBeTruthy();
    expect(screen.getByText("10:00 PM – 7:00 AM")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("link", { name: /^← Account & security$/ })).toBeTruthy();
  });

  it("distinguishes failed preference loading from an empty channel collection", async () => {
    window.history.pushState({}, "", `/p/${PATIENT}/preferences`);
    render(
      <PortalApp
        client={stub((path) =>
          path.endsWith("/care-summary")
            ? json({ patient: { layLabel: "Example" } })
            : new Response(null, { status: 500 }),
        )}
      />,
    );
    expect(
      await screen.findByText("We could not load this right now. Please try again in a moment."),
    ).toBeTruthy();
    expect(
      screen.queryByText("No notification channels are available for this account."),
    ).toBeNull();
  });

  it("does not claim sign-out succeeded when the server rejected it", async () => {
    const requests: string[] = [];
    window.history.pushState({}, "", "/account");
    render(
      <PortalApp
        client={stub((path) => {
          if (path.endsWith("/sessions/current")) return json(session);
          if (path.endsWith("/sessions/logout")) {
            requests.push("logout");
            return new Response(null, { status: 500 });
          }
          return new Response(null, { status: 404 });
        })}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(requests).toEqual(["logout"]));
    expect(await screen.findByText("We couldn't confirm sign-out. Please try again.")).toBeTruthy();
    expect(window.location.pathname).toBe("/account");
  });
});
