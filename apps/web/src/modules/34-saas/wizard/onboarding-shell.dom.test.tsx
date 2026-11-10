// @vitest-environment jsdom
// The wizard inside the REAL app shell (AppShell, the real screen registration, a fetch stub that records every request): the audited
// view is read once when the bare route resumes onto a step, a refused background call never bounces an onboarding screen, and nothing
// polls routes the server confines while the organization is onboarding.
import { createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../../shell/app";
import {
  getGlobalResponseSignal,
  handleObservedResponse,
  setGlobalResponseSignal,
  subscribeGlobalResponseSignal,
} from "../../../shell/global-response-signal";
import { createScreenRegistry } from "../../../shell/screen-registry";
import type { Session } from "../../../shell/session";
import { systemScreens } from "../../../shell/system-pages";
import { saasScreens } from "../index";
import { OnboardingScreenGate } from "./onboarding-gate";
import { ORG_ADMIN, wizardStep, wizardView } from "./test-support";

const VIEW = wizardView([
  wizardStep("account_created", 1, { title: "Organisation" }),
  wizardStep("plan_contract", 2, { title: "Plan and contract" }),
]);
const AUDITED = "/api/v1/tenant/onboarding";
const INBOX = "/api/v1/alerts/inbox";
const FLAGS = "/api/v1/system/feature-flags";

const json = (status: number, body: unknown, url: string): Response => {
  const res = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  Object.defineProperty(res, "url", { value: `http://localhost${url}` }); // a constructed Response has none
  return res;
};

let urls: string[] = [];
const fetchStub = async (input: Request | string): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input.url, "http://localhost").pathname;
  urls.push(url);
  if (url === AUDITED) return json(200, VIEW, url);
  if (url === INBOX || url === FLAGS) {
    return json(403, { error: { code: "ORGANIZATION_ONBOARDING", message: "confined" } }, url);
  }
  return json(404, { error: { code: "NOT_FOUND", message: "x" } }, url);
};
const reads = (path: string): number => urls.filter((u) => u === path).length;

afterEach(() => {
  cleanup();
  setGlobalResponseSignal(null);
  urls = [];
  vi.unstubAllGlobals();
});

function mountAt(path: string, organizationStage: Session["organizationStage"]) {
  vi.stubGlobal("fetch", vi.fn(fetchStub));
  const registry = createScreenRegistry();
  registry.register(systemScreens);
  registry.register(saasScreens);
  window.history.pushState({}, "", path);
  render(
    <AppShell
      registry={registry}
      client={createApiClient({
        baseUrl: "http://localhost",
        fetch: fetchStub,
        onResponseStatus: handleObservedResponse,
      })}
      screenGuard={OnboardingScreenGate}
      session={{
        ...ORG_ADMIN,
        ...(organizationStage ? { organizationStage } : { organizationStage: undefined }),
      }}
    />,
  );
}

/** Resolves once a signal of `kind` has been raised and consumed by the shell: positive evidence for "it fired and nothing moved". */
async function signalSettled(kind: string): Promise<void> {
  let raised = false;
  const stop = subscribeGlobalResponseSignal(() => {
    if (getGlobalResponseSignal()?.kind === kind) raised = true;
  });
  await waitFor(() => expect(raised).toBe(true), { timeout: 5000 });
  await waitFor(() => expect(getGlobalResponseSignal()).toBeNull(), { timeout: 5000 });
  stop();
}

describe("the wizard in the real app shell", () => {
  it("reads the audited onboarding view exactly once when the bare route resumes onto a step", async () => {
    mountAt("/admin/onboarding", "onboarding");
    expect(await screen.findByRole("heading", { level: 2, name: "Organisation" })).toBeTruthy();
    expect(window.location.pathname).toBe("/admin/onboarding/account_created");
    // let any remount's read land before counting
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reads(AUDITED)).toBe(1);
  });

  it("does not remount the wizard when the person moves to another step", async () => {
    mountAt("/admin/onboarding/account_created", "onboarding");
    await screen.findByRole("heading", { level: 2, name: "Organisation" });
    screen.getByRole("button", { name: /Plan and contract/ }).click();
    await screen.findByRole("heading", { level: 2, name: "Plan and contract" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reads(AUDITED)).toBe(1);
  });

  it("does not bounce Agency setup when a background call is refused and the stage is unknown", async () => {
    mountAt("/admin/setup", undefined);
    await signalSettled("organization-onboarding"); // the alert inbox poll answered 403 ORGANIZATION_ONBOARDING
    expect(reads(INBOX)).toBeGreaterThan(0);
    expect(window.location.pathname).toBe("/admin/setup");
  });

  it("still sends a screen outside onboarding to the wizard when the stage is unknown", async () => {
    mountAt("/admin/support-grants", undefined);
    await waitFor(
      () => expect(window.location.pathname).toBe("/admin/onboarding/account_created"),
      {
        timeout: 5000,
      },
    );
  });

  it("makes no read of the routes the server confines while the stage is onboarding", async () => {
    mountAt("/admin/setup", "onboarding");
    await screen.findByRole("heading", { name: "Agency setup" });
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(reads(INBOX)).toBe(0);
    expect(reads(FLAGS)).toBe(0);
  });

  it("keeps the notification bell quiet while confined: it opens to 'No notifications', never 'could not be loaded'", async () => {
    mountAt("/admin/setup", "onboarding");
    await screen.findByRole("heading", { name: "Agency setup" });
    fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    expect(await screen.findByText("No notifications")).toBeTruthy();
    expect(screen.queryByText("Notifications could not be loaded.")).toBeNull();
    expect(reads(INBOX)).toBe(0);
  });
});
