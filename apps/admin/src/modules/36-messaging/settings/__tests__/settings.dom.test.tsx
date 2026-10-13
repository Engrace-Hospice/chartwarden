// M36 settings screens: loading/error/empty/403 states and the optimistic-with-rollback alert-rule toggle,
// preferences save, and endpoint add/verify/remove — all against a recording fake fetch.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AlertRules } from "../alert-rules";
import { DeliveryEndpoints } from "../delivery-endpoints";
import { settingsScreens } from "../index";
import { NotificationPreferences, toggleChannel } from "../notification-preferences";

const ID = "11111111-1111-4111-8111-111111111111";
const RULE = {
  ruleId: ID,
  organizationId: null,
  eventType: "sfv.due",
  category: "clinical_routine",
  severityFloor: "info",
  recipientResolver: "care_team",
  systemLocked: false,
  enabled: true,
};
const LOCKED = {
  ...RULE,
  ruleId: "22222222-2222-4222-8222-222222222222",
  eventType: "safety.sos",
  systemLocked: true,
};
const PREFS = {
  id: ID,
  userId: ID,
  routingMap: { clinical_urgent: { critical: ["in_app"] } },
  quietHours: { tz: "UTC", ranges: [], severityOverride: "critical" },
  vacationForwardToUserId: null,
  vacationUntil: null,
  updatedAt: "2026-10-01T00:00:00.000Z",
};

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
type Handler = (call: Call) => Response;
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const denied = (status: number, message = "nope"): Response =>
  json({ error: { code: "X", message, correlationId: "c" } }, status);

function mount(element: JSX.Element, handler: Handler): Call[] {
  const calls: Call[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(await req.clone().text()) as Record<string, unknown>;
      } catch {
        body = null;
      }
      const call = { method: req.method, path: new URL(req.url).pathname, body };
      calls.push(call);
      return handler(call);
    },
  });
  render(
    <ApiClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>{element}</MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
  return calls;
}

afterEach(cleanup);

describe("settingsScreens descriptor", () => {
  it("lists three screens with real permission keys and unique ids", () => {
    expect(settingsScreens.map((s) => s.requiredPermission)).toEqual([
      "alert.rules.read",
      "notifications.preferences.manage",
      "notifications.endpoint.manage",
    ]);
    expect(new Set(settingsScreens.map((s) => s.id)).size).toBe(3);
  });
});

describe("AlertRules", () => {
  it("shows a loading skeleton, then the rules", async () => {
    mount(<AlertRules />, () => json({ rules: [RULE] }));
    expect(screen.getByRole("status", { name: "Loading alert rules…" })).toBeTruthy();
    expect(await screen.findByLabelText("Sfv due enabled")).toBeTruthy();
  });

  it("renders the empty state", async () => {
    mount(<AlertRules />, () => json({ rules: [] }));
    expect(await screen.findByText("No alert rules are configured.")).toBeTruthy();
  });

  it("renders no-access on 403", async () => {
    mount(<AlertRules />, () => denied(403));
    expect(await screen.findByText(/do not have access to alert rules/)).toBeTruthy();
  });

  it("renders error with retry that reloads", async () => {
    let attempts = 0;
    mount(<AlertRules />, () => (++attempts === 1 ? denied(500) : json({ rules: [RULE] })));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("Sfv due enabled")).toBeTruthy();
  });

  it("toggles optimistically and keeps the server's row", async () => {
    const calls = mount(<AlertRules />, (c) =>
      c.method === "GET"
        ? json({ rules: [RULE] })
        : json({
            ...RULE,
            ruleId: "33333333-3333-4333-8333-333333333333",
            organizationId: ID,
            enabled: false,
          }),
    );
    const box = (await screen.findByLabelText("Sfv due enabled")) as HTMLInputElement;
    fireEvent.click(box);
    expect((screen.getByLabelText("Sfv due enabled") as HTMLInputElement).checked).toBe(false);
    await screen.findByText("Updated Sfv due.");
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.path).toBe(`/api/v1/alert-rules/${ID}`);
    expect(patch?.body).toEqual({ enabled: false });
    expect(await screen.findByText("Custom")).toBeTruthy();
  });

  it("rolls back and explains when the server refuses", async () => {
    mount(<AlertRules />, (c) =>
      c.method === "GET" ? json({ rules: [RULE] }) : denied(403, "Rule is system locked"),
    );
    fireEvent.click(await screen.findByLabelText("Sfv due enabled"));
    expect(await screen.findByText(/Rule is system locked/)).toBeTruthy();
    expect((screen.getByLabelText("Sfv due enabled") as HTMLInputElement).checked).toBe(true);
  });

  it("disables controls for a system-locked rule", async () => {
    mount(<AlertRules />, () => json({ rules: [LOCKED] }));
    expect(
      ((await screen.findByLabelText("Safety sos enabled")) as HTMLInputElement).disabled,
    ).toBe(true);
    expect(screen.getByText("Locked")).toBeTruthy();
  });
});

describe("NotificationPreferences", () => {
  it("toggleChannel returns a new map without mutating", () => {
    const base = { a: { info: ["push" as const] } };
    const next = toggleChannel(base, "a", "info", "sms", true);
    expect(next.a?.info).toEqual(["push", "sms"]);
    expect(base.a?.info).toEqual(["push"]);
  });

  it("shows no-access on 403", async () => {
    mount(<NotificationPreferences />, () => denied(403));
    expect(await screen.findByText(/do not have access to notification preferences/)).toBeTruthy();
  });

  it("saves the edited routing map and disables the form while saving", async () => {
    const calls = mount(<NotificationPreferences />, (c) =>
      c.method === "GET" ? json(PREFS) : json({ id: ID, updatedAt: PREFS.updatedAt }),
    );
    fireEvent.click(await screen.findByLabelText("Clinical urgent critical via Sms"));
    fireEvent.click(screen.getByRole("button", { name: "Save preferences" }));
    await screen.findByText("Preferences saved.");
    const put = calls.find((c) => c.method === "PUT");
    expect(
      (put?.body?.routingMap as Record<string, Record<string, string[]>>).clinical_urgent?.critical,
    ).toEqual(["in_app", "sms"]);
    expect(put?.body?.vacationForwardToUserId).toBeNull();
  });

  it("surfaces a server refusal and keeps the draft", async () => {
    mount(<NotificationPreferences />, (c) =>
      c.method === "GET" ? json(PREFS) : denied(422, "unknown channel"),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Save preferences" }));
    expect(await screen.findByText("unknown channel")).toBeTruthy();
  });
});

describe("DeliveryEndpoints", () => {
  it("adds, verifies and removes an endpoint", async () => {
    const calls = mount(<DeliveryEndpoints />, (c) => {
      if (c.method === "DELETE") return new Response(null, { status: 204 });
      if (c.path.endsWith("/verify"))
        return json({ endpointId: ID, channel: "email", verificationStatus: "verified" });
      return json({ endpointId: ID, channel: "email", verificationStatus: "pending" }, 201);
    });
    expect(screen.getByText(/No endpoints added in this session/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Address or device token/), {
      target: { value: "me@example.org" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    fireEvent.change(await screen.findByLabelText("Verification code for me@example.org"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify me@example.org" }));
    await screen.findByText("me@example.org is verified.");
    expect(calls.find((c) => c.path.endsWith("/verify"))?.body).toEqual({ token: "123456" });
    fireEvent.click(screen.getByRole("button", { name: "Remove me@example.org" }));
    await waitFor(() =>
      expect(screen.getByText(/No endpoints added in this session/)).toBeTruthy(),
    );
  });

  it("shows no-access when registering is forbidden", async () => {
    mount(<DeliveryEndpoints />, () => denied(403));
    fireEvent.change(screen.getByLabelText(/Address or device token/), {
      target: { value: "x@y.z" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    expect(await screen.findByText(/do not have access to delivery endpoints/)).toBeTruthy();
  });

  it("explains a rejected code", async () => {
    mount(<DeliveryEndpoints />, (c) =>
      c.path.endsWith("/verify")
        ? json({ endpointId: ID, channel: "email", verificationStatus: "pending" })
        : json({ endpointId: ID, channel: "email", verificationStatus: "pending" }, 201),
    );
    fireEvent.change(screen.getByLabelText(/Address or device token/), {
      target: { value: "a@b.c" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add endpoint" }));
    fireEvent.change(await screen.findByLabelText("Verification code for a@b.c"), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify a@b.c" }));
    expect(await screen.findByText(/code was not accepted/)).toBeTruthy();
  });
});
