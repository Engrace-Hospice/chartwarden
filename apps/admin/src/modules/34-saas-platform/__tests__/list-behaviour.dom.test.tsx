import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
// apps/admin/src/modules/34-saas-platform — the shared list/drawer behaviours on the M34 screens: a stale ?param link is
// cleared with a notice, Enter opens a row's drawer, Escape closes it and hands focus back to the row, and a free-text
// filter issues one request after the typing pauses (Apply / Enter still load at once). A drawer opened from the URL
// survives a reload that still lists its record, is cleared (with the notice) by one that does not, is not re-mounted from
// stale rows while a failed load is retried, and closes on Back.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
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

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const page = (items: unknown[]): unknown => ({ items, nextCursor: null, hasMore: false });

function LocationProbe(): JSX.Element {
  const location = useLocation();
  return <output data-testid="search">{location.search}</output>;
}

function HistoryBack(): JSX.Element {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(-1)}>
      history back
    </button>
  );
}

/** A route's reply: a body served as 200 JSON, or a function that answers each request itself. */
type Reply = unknown | (() => Response | Promise<Response>);

function mount(
  element: JSX.Element,
  url: string,
  routes: Record<string, Reply>,
): { calls: Recorded[]; listCalls: (path: string) => Recorded[] } {
  const calls: Recorded[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      const parsed = new URL(req.url);
      calls.push({ path: parsed.pathname, search: parsed.search });
      const reply = routes[parsed.pathname];
      return typeof reply === "function"
        ? (reply as () => Response | Promise<Response>)()
        : json(reply ?? page([]));
    },
  });
  render(
    <ApiClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[url]}>
          {element}
          <LocationProbe />
          <HistoryBack />
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
  /** The button that reloads the list. Only the screens on `useSelectionParam` name one (see URL_DRAWER_CASES). */
  reload?: string;
}

const flag = {
  id: "flag-1",
  flagKey: "beta.thing",
  organizationId: null,
  flagKind: "product",
  valueType: "bool",
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
  {
    name: "FeatureFlags",
    element: <FeatureFlags />,
    path: "/flags",
    param: "flag",
    id: "flag-1",
    drawer: "Feature flag",
    routes: { "/api/v1/platform/feature-flags": page([flag]) },
    reload: "Refresh",
  },
  {
    name: "BaaRegister",
    element: <BaaRegister />,
    path: "/baa",
    param: "baa",
    id: "baa-1",
    drawer: "BAA record",
    routes: { "/api/v1/platform/baa-register": page([baa]) },
    reload: "Refresh",
  },
  {
    name: "DsarQueue",
    element: <DsarQueue />,
    path: "/dsar",
    param: "job",
    id: "dsar-1",
    drawer: "DSAR request",
    routes: { "/api/v1/tenant/dsar-export-jobs": page([dsar]) },
    reload: "Apply",
  },
  {
    name: "TenantExportQueue",
    element: <TenantExportQueue />,
    path: "/exports",
    param: "export",
    id: "export-1",
    drawer: "Export job",
    routes: { "/api/v1/tenant/tenant-export-jobs": page([exportJob]) },
    reload: "Apply",
  },
];

describe.each(PARAM_CASES)("$name list behaviour", (c) => {
  it("clears a ?param naming a missing record once the list has loaded, and says so", async () => {
    mount(c.element, `${c.path}?${c.param}=missing`, c.routes);
    expect(await screen.findByText(STALE_NOTICE)).toBeTruthy();
    // The toast (urgent) can commit before the router's location update, so wait for the param to clear.
    await waitFor(() => expect(search()).toBe(""));
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
    await waitFor(() => expect(search()).toBe(""));
    await waitFor(() => expect(document.activeElement).toBe(firstRow()));
  });

  it("closes the drawer on Back", async () => {
    mount(c.element, c.path, c.routes);
    await waitFor(() =>
      expect(document.querySelector("tr.wx-data-row-interactive")).not.toBeNull(),
    );
    fireEvent.keyDown(firstRow(), { key: "Enter" });
    await screen.findByRole("complementary", { name: c.drawer });
    expect(search()).toBe(`?${c.param}=${c.id}`);
    fireEvent.click(screen.getByRole("button", { name: "history back" }));
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(search()).toBe("");
  });
});

type Phase = "listed" | "gone" | "failing" | "held";

/** The screen's list route, answering by phase so a test can reload it into any of the four outcomes. */
function scriptedList(c: ParamCase): {
  routes: Record<string, Reply>;
  listPath: string;
  setPhase: (next: Phase) => void;
  release: () => void;
} {
  const [listPath, listed] = Object.entries(c.routes)[0] as [string, unknown];
  let phase: Phase = "listed";
  let settle: (response: Response) => void = () => {};
  const reply = (): Response | Promise<Response> => {
    if (phase === "gone") return json(page([]));
    if (phase === "failing")
      return json({ error: { code: "INTERNAL", message: "boom", correlationId: "c" } }, 500);
    if (phase === "held")
      return new Promise<Response>((resolve) => {
        settle = resolve;
      });
    return json(listed);
  };
  return {
    routes: { [listPath]: reply },
    listPath,
    setPhase: (next) => {
      phase = next;
    },
    release: () => settle(json(listed)),
  };
}

const rowShown = (): void =>
  expect(document.querySelector("tr.wx-data-row-interactive")).not.toBeNull();

// The four screens on `useSelectionParam` (flags, BAA register, DSAR, tenant exports): each reloads from a button, empties
// its list when a load fails, and writes the selection through a functional updater. The other lists keep their rows through
// a failed refresh, so their drawer is never re-mounted and has nothing to prove here.
const URL_DRAWER_CASES = PARAM_CASES.filter((c) => c.reload);

describe.each(URL_DRAWER_CASES)("$name URL drawer across reloads", (c) => {
  const open = async (): Promise<
    ReturnType<typeof scriptedList> & {
      drawer: HTMLElement;
      listCalls: (path: string) => Recorded[];
    }
  > => {
    const list = scriptedList(c);
    const { listCalls } = mount(c.element, `${c.path}?${c.param}=${c.id}`, list.routes);
    const drawer = await screen.findByRole("complementary", { name: c.drawer });
    return { ...list, drawer, listCalls };
  };
  const reload = (): void => {
    fireEvent.click(screen.getByRole("button", { name: c.reload }));
  };

  it("survives a reload that still lists the record, without re-mounting", async () => {
    const { drawer } = await open();
    reload();
    await waitFor(rowShown);
    expect(screen.getByRole("complementary", { name: c.drawer })).toBe(drawer);
    expect(search()).toBe(`?${c.param}=${c.id}`);
    expect(screen.queryByText(STALE_NOTICE)).toBeNull();
  });

  it("clears the drawer, with the notice, when a reload no longer lists the record", async () => {
    const { setPhase } = await open();
    setPhase("gone");
    reload();
    expect(await screen.findByText(STALE_NOTICE)).toBeTruthy();
    await waitFor(() => expect(search()).toBe(""));
    expect(screen.queryByRole("complementary")).toBeNull();
  });

  it("does not re-mount the drawer from stale rows while a failed load is retried", async () => {
    const { setPhase, release, listPath, listCalls } = await open();
    setPhase("failing");
    reload();
    const retry = await screen.findByRole("button", { name: "Try again" });
    // The list cannot be read, so no drawer — but the link is kept: nothing says the record is gone.
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(search()).toBe(`?${c.param}=${c.id}`);
    expect(screen.queryByText(STALE_NOTICE)).toBeNull();

    setPhase("held");
    fireEvent.click(retry);
    // Initial load, the failing reload, and the retry now held in flight.
    await waitFor(() => expect(listCalls(listPath)).toHaveLength(3));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(search()).toBe(`?${c.param}=${c.id}`);

    release();
    expect(await screen.findByRole("complementary", { name: c.drawer })).toBeTruthy();
    expect(search()).toBe(`?${c.param}=${c.id}`);
  });

  it("keeps other query params when a row is opened and when the drawer closes", async () => {
    mount(c.element, `${c.path}?keep=1`, c.routes);
    await waitFor(rowShown);
    fireEvent.keyDown(firstRow(), { key: "Enter" });
    const drawer = await screen.findByRole("complementary", { name: c.drawer });
    expect(new URLSearchParams(search()).get("keep")).toBe("1");
    expect(new URLSearchParams(search()).get(c.param)).toBe(c.id);
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("complementary")).toBeNull());
    expect(search()).toBe("?keep=1");
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
    await waitFor(() => expect(search()).toBe(""));
  });
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
