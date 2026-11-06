import { createApiClient } from "@chartwarden/ui";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PortalApp } from "../src/app";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
type Handler = (path: string, method: string) => Response | Promise<Response>;
function renderBereavement(handler: Handler) {
  window.history.pushState({}, "", `/portal/p/${P1}/bereavement`);
  const requests: string[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input) => {
      const req = input instanceof Request ? input : new Request(input);
      const path = new URL(req.url).pathname;
      requests.push(`${req.method} ${path}`);
      if (path === "/api/v1/portal/care-summary")
        return json({ patient: { layLabel: "Example patient" } });
      return handler(path, req.method);
    },
  });
  return { ...render(<PortalApp client={client} />), requests };
}
const program = {
  items: [{ label: "Optional support", detail: "Speak with your hospice team about resources." }],
};
const resources = {
  items: [
    {
      title: "Coping guide",
      kind: "guide",
      summary: "Read when you are ready.",
      url: "https://example.org/support",
    },
  ],
};

describe("PR4.4 bereavement support", () => {
  it("presents program details and secure external resource links", async () => {
    renderBereavement((path) =>
      path.endsWith("/program")
        ? json(program)
        : path.endsWith("/resources")
          ? json(resources)
          : json({}, 404),
    );
    expect(await screen.findByRole("heading", { name: "Optional support" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Coping guide" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "Open Coping guide in a new tab" });
    expect(link.getAttribute("href")).toBe("https://example.org/support");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });

  it("does not create clickable links from unsafe resource URLs", async () => {
    renderBereavement((path) =>
      path.endsWith("/program")
        ? json(program)
        : path.endsWith("/resources")
          ? json({ items: [{ title: "Untrusted guide", url: "javascript:alert(1)" }] })
          : json({}, 404),
    );
    expect(await screen.findByRole("heading", { name: "Untrusted guide" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Open Untrusted guide/ })).toBeNull();
  });

  it("keeps resources visible when the program request fails, with an independent retry", async () => {
    let calls = 0;
    renderBereavement((path) => {
      if (path.endsWith("/program")) {
        calls++;
        return calls === 1 ? json({}, 503) : json(program);
      }
      return path.endsWith("/resources") ? json(resources) : json({}, 404);
    });
    expect(await screen.findByRole("heading", { name: "Coping guide" })).toBeTruthy();
    const alert = await screen.findByRole("alert");
    fireEvent.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Optional support" })).toBeTruthy();
    expect(calls).toBe(2);
  });

  it("requires confirmation before opting out, and reflects server success", async () => {
    const { requests } = renderBereavement((path) =>
      path.endsWith("/program")
        ? json(program)
        : path.endsWith("/resources")
          ? json(resources)
          : json({ ok: true }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Opt out of outreach" }));
    expect(requests.filter((r) => r.includes("/opt-out"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Keep outreach" }));
    expect(requests.filter((r) => r.includes("/opt-out"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Opt out of outreach" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm opt out" }));
    await waitFor(() => expect(requests.filter((r) => r.includes("/opt-out"))).toHaveLength(1));
    expect(await screen.findByText("Preference submitted")).toBeTruthy();
  });

  it("does not claim opt-out success when the request fails", async () => {
    renderBereavement((path) =>
      path.endsWith("/program")
        ? json(program)
        : path.endsWith("/resources")
          ? json(resources)
          : json({}, 500),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Opt out of outreach" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm opt out" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("Preference submitted")).toBeNull();
  });

  it("distinguishes empty resources from an API error", async () => {
    renderBereavement((path) =>
      path.endsWith("/program")
        ? json(program)
        : path.endsWith("/resources")
          ? json({ items: [] })
          : json({}, 404),
    );
    expect(await screen.findByText("No resources shared yet")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("drops prior patient data when a pending request resolves after switching", async () => {
    let resolveOld: ((value: Response) => void) | undefined;
    let reads = 0;
    renderBereavement((path) => {
      if (path.endsWith("/program")) {
        reads++;
        return reads === 1
          ? new Promise<Response>((resolve) => {
              resolveOld = resolve;
            })
          : json({ items: [{ label: "New patient support", detail: "New" }] });
      }
      return path.endsWith("/resources") ? json({ items: [] }) : json({}, 404);
    });
    await waitFor(() => expect(reads).toBe(1));
    window.history.pushState({}, "", `/portal/p/${P2}/bereavement`);
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(await screen.findByRole("heading", { name: "New patient support" })).toBeTruthy();
    await act(async () => {
      resolveOld?.(json({ items: [{ label: "Old patient private program" }] }));
    });
    expect(screen.queryByText("Old patient private program")).toBeNull();
  });

  describe("ADR-0109 D10 — stop mailings, keep the calls", () => {
    const withBody = (
      handler: (path: string, method: string, body: unknown) => Response | Promise<Response>,
    ) => {
      const bodies: unknown[] = [];
      const client = createApiClient({
        baseUrl: "http://localhost",
        fetch: async (input) => {
          const req = input instanceof Request ? input : new Request(input);
          const path = new URL(req.url).pathname;
          if (path === "/api/v1/portal/care-summary")
            return json({ patient: { layLabel: "Example patient" } });
          const text = req.method === "GET" ? "" : await req.clone().text();
          const body = text === "" ? undefined : JSON.parse(text);
          if (path.endsWith("/mailing-preference")) bodies.push(body);
          return handler(path, req.method, body);
        },
      });
      window.history.pushState({}, "", `/portal/p/${P1}/bereavement`);
      render(<PortalApp client={client} />);
      return bodies;
    };
    const base = (path: string, programBody: unknown = program) =>
      path.endsWith("/program")
        ? json(programBody)
        : path.endsWith("/resources")
          ? json(resources)
          : json({ ok: true });

    it("offers the control with the reassurance, and sends allowMailings false on one click", async () => {
      const bodies = withBody((path) => base(path));
      const stop = await screen.findByRole("button", {
        name: "Stop mailings — you'll still hear from your counselor",
      });
      fireEvent.click(stop);
      expect(await screen.findByText(/Mailings are stopped/)).toBeTruthy();
      expect(bodies).toEqual([{ allowMailings: false }]);
      // the program is still ours: this is not an opt-out
      expect(screen.queryByText("Preference submitted")).toBeNull();
      expect(screen.getByRole("button", { name: "Opt out of outreach" })).toBeTruthy();
    });

    it("starts in the stopped state when every contact has already stopped mailings, and resumes them", async () => {
      const bodies = withBody((path) =>
        base(path, { items: [{ label: "Support", mailingsAllowed: false }] }),
      );
      expect(await screen.findByText(/Mailings are stopped/)).toBeTruthy();
      expect(
        screen.queryByRole("button", {
          name: "Stop mailings — you'll still hear from your counselor",
        }),
      ).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Resume mailings" }));
      expect(
        await screen.findByRole("button", {
          name: "Stop mailings — you'll still hear from your counselor",
        }),
      ).toBeTruthy();
      expect(bodies).toEqual([{ allowMailings: true }]);
    });

    it("does not claim mailings stopped when the request fails", async () => {
      withBody((path) => (path.endsWith("/mailing-preference") ? json({}, 503) : base(path)));
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Stop mailings — you'll still hear from your counselor",
        }),
      );
      expect(await screen.findByRole("alert")).toBeTruthy();
      expect(screen.queryByText(/Mailings are stopped/)).toBeNull();
      expect(
        screen.getByRole("button", {
          name: "Stop mailings — you'll still hear from your counselor",
        }),
      ).toBeTruthy();
    });

    it("keeps ONE status region mounted across stop and resume, and focus follows the control that replaces the clicked one", async () => {
      withBody((path) => base(path));
      const stop = await screen.findByRole("button", {
        name: "Stop mailings — you'll still hear from your counselor",
      });
      const region = stop.closest(".wx-bereavement-mailings")?.querySelector('[role="status"]');
      expect(region).toBeTruthy();
      expect(region?.textContent).toBe("");
      fireEvent.click(stop);
      const resume = await screen.findByRole("button", { name: "Resume mailings" });
      expect(region?.textContent).toMatch(/Mailings are stopped/);
      expect(region?.isConnected).toBe(true);
      await waitFor(() => expect(document.activeElement).toBe(resume));
      fireEvent.click(resume);
      const stopAgain = await screen.findByRole("button", {
        name: "Stop mailings — you'll still hear from your counselor",
      });
      expect(region?.textContent).toMatch(/Mailings have resumed/);
      expect(region?.isConnected).toBe(true);
      await waitFor(() => expect(document.activeElement).toBe(stopAgain));
    });

    it("honours mayOptOut: no opt-out button once the server says this contact may not, but mailings stay controllable", async () => {
      withBody((path) =>
        base(path, { items: [{ label: "Support", mayOptOut: false, inWindow: true }] }),
      );
      expect(await screen.findByText(/can't be changed here any more/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Opt out of outreach" })).toBeNull();
      expect(
        screen.getByRole("button", {
          name: "Stop mailings — you'll still hear from your counselor",
        }),
      ).toBeTruthy();
    });

    it("honours inWindow: once the program has ended there is nothing to opt out of or to stop", async () => {
      withBody((path) =>
        base(path, { items: [{ label: "Support", mayOptOut: false, inWindow: false }] }),
      );
      expect(await screen.findByText(/because the support program has ended/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Opt out of outreach" })).toBeNull();
      expect(screen.queryByRole("button", { name: /Stop mailings|Resume mailings/ })).toBeNull();
      expect(screen.queryByText("Printed mailings")).toBeNull();
    });

    it("keeps offering both controls while at least one contact is still in the program", async () => {
      withBody((path) =>
        base(path, {
          items: [
            { label: "Ended", mayOptOut: false, inWindow: false },
            { label: "Open", mayOptOut: true, inWindow: true },
          ],
        }),
      );
      expect(await screen.findByRole("button", { name: "Opt out of outreach" })).toBeTruthy();
      expect(screen.getByText("Printed mailings")).toBeTruthy();
    });

    it("is hidden once the family has opted out of outreach altogether", async () => {
      withBody((path) => base(path));
      fireEvent.click(await screen.findByRole("button", { name: "Opt out of outreach" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm opt out" }));
      expect(await screen.findByText("Preference submitted")).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Stop mailings/ })).toBeNull();
    });
  });
});
