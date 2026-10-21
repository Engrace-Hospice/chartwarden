// apps/admin/src/modules/34-saas-platform — the shared list/drawer behaviours on the M34 screens: a stale ?param link is
// cleared with a notice, Enter opens a row's drawer, Escape closes it and hands focus back to the row, and a free-text
// filter issues one request after the typing pauses (Apply / Enter still load at once).
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { BaaRegister } from "../baa-register";
import { DsarQueue } from "../dsar-queue";
import { FeatureFlags } from "../feature-flags";
import { OnboardingTemplates } from "../onboarding-templates";
import { Signups } from "../signups";
import { SupportSessions } from "../support-sessions";
import { TenantExportQueue } from "../tenant-export-queue";
import { TenantInventory } from "../tenant-inventory";

const STALE_NOTICE = "That record is no longer in this list.";
const DEBOUNCE_WAIT_MS = 2000;
const SETTLE_AFTER_DEBOUNCE_MS = 600;
const NOW = "2026-01-01T00:00:00.000Z";

interface Recorded {
  path: string;
  search: string;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const page = (items: unknown[]): unknown => ({ items, nextCursor: null, hasMore: false });

function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

function mount(
  element: JSX.Element,
  url: string,
  routes: Record<string, unknown>,
): { calls: Recorded[]; listCalls: (path: string) => Recorded[] } {
  const calls: Recorded[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const parsed = new URL(req.url);
      calls.push({ path: parsed.pathname, search: parsed.search });
      return json(routes[parsed.pathname] ?? page([]));
    },
  });
  render(
    <ApiClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[url]}>
          {element}
          <LocationProbe />
        </MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
  return { calls, listCalls: (path) => calls.filter((c) => c.path === path) };
}

const search = (): string => screen.getByTestId("search").textContent ?? "";
const firstRow = (): HTMLElement => {
  const row = document.querySelector<HTMLElement>("tr.wx-data-row-interactive");
  if (!row) throw new Error("no interactive row rendered");
  return row;
};

afterEach(() => cleanup());

interface ParamCase {
  name: string;
  element: JSX.Element;
  path: string;
  param: string;
  id: string;
  drawer: string;
  routes: Record<string, unknown>;
}

const PARAM_CASES: ParamCase[] = [
  {
    name: "Signups",
    element: <Signups />,
    path: "/signups",
    param: "intent",
    id: "intent-1",
    drawer: "Signup intent",
    routes: {
      "/api/v1/platform/signup-intents": page([
        {
          id: "intent-1",
          contactEmail: "a@cedar.example",
          legalBusinessName: "Cedar Ridge",
          intendedFirstAdminEmail: "b@cedar.example",
          intentStatus: "new",
          source: "self_serve_form",
          rejectionReason: null,
          receivedAt: NOW,
          processedAt: null,
          tenantAccountId: null,
        },
      ]),
    },
  },
  {
    name: "SupportSessions",
    element: <SupportSessions />,
    path: "/support/sessions",
    param: "session",
    id: "session-1",
    drawer: "Support session",
    routes: {
      "/api/v1/platform/support-sessions": page([
        {
          id: "session-1",
          organizationId: "org-1",
          supportConsentGrantId: "grant-1",
          tenantAccountId: "tenant-1",
          actorMembershipId: "member-1",
          startedAt: NOW,
          expiresAt: NOW,
          closedAt: NOW,
          closeReason: null,
          status: "closed",
        },
      ]),
    },
  },
  {
    name: "OnboardingTemplates",
    element: <OnboardingTemplates />,
    path: "/onboarding/templates",
    param: "template",
    id: "template-1",
    drawer: "Onboarding template",
    routes: {
      "/api/v1/platform/onboarding-templates": page([
        {
          id: "template-1",
          key: "baa_signed",
          title: "BAA signed",
          canonicalOrder: 1,
          isCanonical: false,
          createdAt: NOW,
        },
      ]),
    },
  },
  {
    name: "TenantInventory",
    element: <TenantInventory />,
    path: "/tenants",
    param: "tenant",
    id: "cedar",
    drawer: "Tenant",
    routes: {
      "/api/v1/platform/tenants": page([
        {
          id: "t-1",
          organizationId: "org-1",
          orgSlug: "cedar",
          legalBusinessName: "Cedar Ridge",
          status: "active",
          planLabel: "standard",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ]),
    },
  },
];

describe.each(PARAM_CASES)("$name list behaviour", (c) => {
  it("clears a ?param naming a missing record once the list has loaded, and says so", async () => {
    mount(c.element, `${c.path}?${c.param}=missing`, c.routes);
    expect(await screen.findByText(STALE_NOTICE)).toBeTruthy();
    expect(search()).toBe("");
  });

  it("opens the drawer for a record that is in the list and keeps the param", async () => {
    mount(c.element, `${c.path}?${c.param}=${c.id}`, c.routes);
    expect(await screen.findByRole("complementary", { name: c.drawer })).toBeTruthy();
    expect(search()).toBe(`?${c.param}=${c.id}`);
    expect(screen.queryByText(STALE_NOTICE)).toBeNull();
  });

  it("opens on Enter, closes on Escape and returns focus to the row", async () => {
    mount(c.element, c.path, c.routes);
    await waitFor(() =>
      expect(document.querySelector("tr.wx-data-row-interactive")).not.toBeNull(),
    );
    const row = firstRow();
    row.focus();
    fireEvent.keyDown(row, { key: "Enter" });
    const drawer = await screen.findByRole("complementary", { name: c.drawer });
    expect(search()).toBe(`?${c.param}=${c.id}`);
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(search()).toBe("");
    expect(document.activeElement).toBe(firstRow());
  });
});

describe("TenantInventory new-tenant link", () => {
  it("does not treat ?tenant=new as a stale record", async () => {
    mount(<TenantInventory />, "/tenants?tenant=new", {
      "/api/v1/platform/tenants": page([]),
    });
    expect(await screen.findByRole("complementary", { name: "New tenant" })).toBeTruthy();
    expect(search()).toBe("?tenant=new");
    expect(screen.queryByText(STALE_NOTICE)).toBeNull();
  });

  it("closes the New tenant drawer on Escape", async () => {
    mount(<TenantInventory />, "/tenants?tenant=new", {
      "/api/v1/platform/tenants": page([]),
    });
    const drawer = await screen.findByRole("complementary", { name: "New tenant" });
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(search()).toBe("");
  });
});

describe("state-held selections", () => {
  const flag = {
    id: "flag-1",
    flagKey: "beta.thing",
    organizationId: null,
    flagKind: "product",
    valueType: "boolean",
    value: true,
    rolloutPercent: null,
    killSwitchActive: false,
    updatedAt: NOW,
  };
  const baa = {
    id: "baa-1",
    organizationId: "org-1",
    tenantAccountId: "tenant-1",
    addendumVersion: "v2",
    baaStatus: "executed",
    executedOn: null,
    effectiveOn: null,
    expiresOn: null,
    documentId: null,
    attestedAt: null,
  };
  const dsar = {
    id: "dsar-1",
    patientId: "patient-1",
    requestSource: "patient",
    status: "requested",
    requestedAt: NOW,
    slaDueAt: NOW,
    extendedUntil: null,
    fulfilledAt: null,
    deniedReason: null,
    createdAt: NOW,
  };
  const exportJob = {
    id: "export-1",
    requestedPurpose: "migration",
    status: "fulfilled",
    requestedAt: NOW,
    fulfilledAt: NOW,
    bundleSizeBytes: 10,
    createdAt: NOW,
  };
  const cases = [
    {
      name: "FeatureFlags",
      element: <FeatureFlags />,
      route: "/api/v1/platform/feature-flags",
      item: flag,
      drawer: "Feature flag",
    },
    {
      name: "BaaRegister",
      element: <BaaRegister />,
      route: "/api/v1/platform/baa-register",
      item: baa,
      drawer: "BAA record",
    },
    {
      name: "DsarQueue",
      element: <DsarQueue />,
      route: "/api/v1/tenant/dsar-export-jobs",
      item: dsar,
      drawer: "DSAR request",
    },
    {
      name: "TenantExportQueue",
      element: <TenantExportQueue />,
      route: "/api/v1/tenant/tenant-export-jobs",
      item: exportJob,
      drawer: "Export job",
    },
  ];

  it.each(cases)(
    "$name: Enter opens the drawer, Escape closes it and focus returns to the row",
    async (c) => {
      mount(c.element, "/x", { [c.route]: page([c.item]) });
      await waitFor(() =>
        expect(document.querySelector("tr.wx-data-row-interactive")).not.toBeNull(),
      );
      const row = firstRow();
      row.focus();
      fireEvent.keyDown(row, { key: "Enter" });
      const drawer = await screen.findByRole("complementary", { name: c.drawer });
      fireEvent.keyDown(drawer, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
      expect(document.activeElement).toBe(firstRow());
    },
  );
});

describe("debounced text filters", () => {
  const typeSlowly = (label: string, text: string): void => {
    const field = screen.getByLabelText(label);
    for (let i = 1; i <= text.length; i += 1) {
      fireEvent.change(field, { target: { value: text.slice(0, i) } });
    }
  };

  it("FeatureFlags issues one request after typing pauses, and Enter loads at once", async () => {
    const path = "/api/v1/platform/feature-flags";
    const { listCalls } = mount(<FeatureFlags />, "/flags", {});
    await waitFor(() => expect(listCalls(path)).toHaveLength(1));
    typeSlowly("Tenant organization id", "org-123");
    expect(listCalls(path)).toHaveLength(1);
    await waitFor(() => expect(listCalls(path)).toHaveLength(2), { timeout: DEBOUNCE_WAIT_MS });
    expect(listCalls(path)[1]?.search).toContain("organizationId=org-123");
    fireEvent.change(screen.getByLabelText("Tenant organization id"), {
      target: { value: "org-9" },
    });
    fireEvent.keyDown(screen.getByLabelText("Tenant organization id"), { key: "Enter" });
    await waitFor(() => expect(listCalls(path)).toHaveLength(3));
    expect(listCalls(path)[2]?.search).toContain("organizationId=org-9");
    // The debounced value then catches up to the text Enter already loaded: it must not fetch the same query again.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER_DEBOUNCE_MS));
    expect(listCalls(path)).toHaveLength(3);
  });

  it("BaaRegister issues one request after typing pauses", async () => {
    const path = "/api/v1/platform/baa-register";
    const { listCalls } = mount(<BaaRegister />, "/baa", {});
    await waitFor(() => expect(listCalls(path)).toHaveLength(1));
    typeSlowly("Tenant account id", "tenant-77");
    expect(listCalls(path)).toHaveLength(1);
    await waitFor(() => expect(listCalls(path)).toHaveLength(2), { timeout: DEBOUNCE_WAIT_MS });
    expect(listCalls(path)[1]?.search).toContain("tenantAccountId=tenant-77");
  });

  it("DsarQueue issues one request after typing pauses, and Apply loads the typed text at once", async () => {
    const path = "/api/v1/tenant/dsar-export-jobs";
    const { listCalls } = mount(<DsarQueue />, "/dsar", {});
    await waitFor(() => expect(listCalls(path)).toHaveLength(1));
    typeSlowly("Patient id", "pat-42");
    expect(listCalls(path)).toHaveLength(1);
    await waitFor(() => expect(listCalls(path)).toHaveLength(2), { timeout: DEBOUNCE_WAIT_MS });
    expect(listCalls(path)[1]?.search).toContain("patientId=pat-42");
    fireEvent.change(screen.getByLabelText("Patient id"), { target: { value: "pat-43" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(listCalls(path)).toHaveLength(3));
    expect(listCalls(path)[2]?.search).toContain("patientId=pat-43");
    await new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER_DEBOUNCE_MS));
    expect(listCalls(path)).toHaveLength(3);
  });
});
