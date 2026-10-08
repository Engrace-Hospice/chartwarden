// StepUpCard — the shared step-up ceremony (apps/web + apps/admin /step-up). The net: a successful TOTP
// re-verification returns to an app-relative `?returnTo`, but NEVER to another origin (an open redirect), and a
// 423 lockout goes to the app's sign-in path. Plus the Re-verify link / refusal helpers the screens use.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../../core/api/client";
import { ApiClientProvider } from "../../../core/api/provider";
import { StepUpCard, safeReturnTo } from "../step-up-card";
import { ReverifyLink, isStepUpRequired, stepUpPath } from "../step-up-link";

let verifyStatus = 200;
let paths: string[] = [];

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const path = new URL(req.url, "http://localhost").pathname;
  paths.push(path);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (path === "/api/v1/sessions/step-up/initiate")
    return json(200, { challengeId: "11111111-1111-4111-8111-111111111111", factor: "totp" });
  if (verifyStatus !== 200)
    return json(verifyStatus, { error: { code: "LOCKED", message: "locked", correlationId: "c" } });
  return json(200, { ok: true });
}

function Where(): JSX.Element {
  const loc = useLocation();
  return <div data-testid="where">{`${loc.pathname}${loc.search}`}</div>;
}

function mount(entry: string): void {
  render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route
            path="/step-up"
            element={<StepUpCard brand={<strong>Brand</strong>} signInPath="/sign-in" />}
          />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </ApiClientProvider>,
  );
}

async function verifyWithCode(): Promise<void> {
  fireEvent.change(await screen.findByLabelText(/Authentication code/), {
    target: { value: "123456" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Verify" }));
}

beforeEach(() => {
  verifyStatus = 200;
  paths = [];
});
afterEach(() => cleanup());

describe("safeReturnTo", () => {
  it("keeps an app-relative path with its query", () => {
    expect(safeReturnTo("/admin/refunds/new?x=1")).toBe("/admin/refunds/new?x=1");
  });

  it.each([
    ["missing", null],
    ["empty", ""],
    ["absolute URL", "https://evil.example/phish"],
    ["protocol-relative", "//evil.example/phish"],
    ["backslash protocol-relative", "/\\evil.example"],
    ["javascript scheme", "javascript:alert(1)"],
    ["bare relative", "admin/refunds"],
    ["tab-prefixed protocol-relative", "/\t/evil.example"],
    ["newline-prefixed protocol-relative", "/\n/evil.example"],
  ])("falls back to / for a %s returnTo", (_label, raw) => {
    expect(safeReturnTo(raw)).toBe("/");
  });
});

describe("StepUpCard", () => {
  it("renders the brand and returns to an app-relative returnTo after a verified code", async () => {
    mount(`/step-up?returnTo=${encodeURIComponent("/billing/wage-index?fy=2026")}`);
    expect(screen.getByText("Brand")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Confirm it’s you" })).toBeTruthy();
    await verifyWithCode();
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toBe("/billing/wage-index?fy=2026"),
    );
    expect(paths).toEqual(["/api/v1/sessions/step-up/initiate", "/api/v1/sessions/step-up"]);
  });

  it("rejects an absolute returnTo and goes home instead", async () => {
    mount(`/step-up?returnTo=${encodeURIComponent("https://evil.example/phish")}`);
    await verifyWithCode();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/"));
  });

  it("rejects a protocol-relative // returnTo and goes home instead", async () => {
    mount(`/step-up?returnTo=${encodeURIComponent("//evil.example/phish")}`);
    await verifyWithCode();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/"));
  });

  it("a 423 lockout goes to the app's sign-in path", async () => {
    verifyStatus = 423;
    mount("/step-up?returnTo=%2Fanywhere");
    await verifyWithCode();
    await waitFor(() => expect(screen.getByTestId("where").textContent).toBe("/sign-in"));
  });
});

describe("step-up refusal helpers", () => {
  it("recognises STEP_UP_REQUIRED in the standard envelope and a flat body, and nothing else", () => {
    expect(isStepUpRequired({ error: { code: "STEP_UP_REQUIRED" } })).toBe(true);
    expect(isStepUpRequired({ code: "STEP_UP_REQUIRED" })).toBe(true);
    expect(isStepUpRequired({ error: { code: "FORBIDDEN" } })).toBe(false);
    expect(isStepUpRequired(undefined)).toBe(false);
    expect(isStepUpRequired("STEP_UP_REQUIRED")).toBe(false);
  });

  it("ReverifyLink points at /step-up with the current path + search as returnTo", () => {
    render(
      <MemoryRouter initialEntries={["/admin/refunds/new?invoice=1"]}>
        <ReverifyLink />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: "Re-verify" });
    expect(link.getAttribute("href")).toBe(stepUpPath("/admin/refunds/new?invoice=1"));
  });
});
