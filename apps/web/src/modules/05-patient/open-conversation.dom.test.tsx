// Every patient-scoped "message" entry point must open THIS patient's care-team conversation
// (POST care-team-channel, then router state), never plain /messaging (first conversation in the list).
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { type ReactElement, useEffect, useState } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import {
  PatientConversationLink,
  useOpenPatientConversation,
} from "../../shell/open-patient-conversation";
import { OverviewRail, OverviewTab, PatientChartHeader } from "./patient-overview";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CHANNEL = "care-team-channel-1";
const patient = {
  id: PATIENT,
  organizationId: "org-1",
  mrn: "MRN1",
  lastName: "Doe",
  firstName: "Jo",
  dob: "1950-01-01",
  status: "active",
};

let calls: string[] = [];
let mode: "ok" | "denied" | "hang" | "throw" | "other-patient" = "ok";
let release: (() => void) | null = null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(req.url, "http://localhost");
  calls.push(`${req.method} ${url.pathname}`);
  if (url.pathname.endsWith("/care-team-channel")) {
    if (mode === "throw") throw new TypeError("network down");
    if (mode === "other-patient") {
      return json({ channelId: CHANNEL, kind: "care_team", patientId: "other", archived: false });
    }
    if (mode === "denied") return json({ error: { code: "FORBIDDEN", message: "no" } }, 403);
    if (mode === "hang")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return json({
      channelId: CHANNEL,
      kind: "care_team",
      patientId: url.pathname.split("/")[5],
      archived: false,
    });
  }
  return json({}, 404);
}

let navigations = 0;

function Destination() {
  const location = useLocation();
  const state = location.state as { messagingChannelId?: string } | null;
  // Each navigate() produces a new location key, so this counts navigations.
  useEffect(() => {
    void location.key;
    navigations += 1;
  }, [location.key]);
  return <div>Messaging destination {state?.messagingChannelId ?? "none"}</div>;
}

const client = createApiClient({ baseUrl: "http://localhost", fetch: stubFetch });

function mount(ui: ReactElement) {
  return render(
    <ApiClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/chart"]}>
          <Routes>
            <Route path="/chart" element={ui} />
            <Route path="/messaging" element={<Destination />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </ApiClientProvider>,
  );
}

const channelPosts = () => calls.filter((c) => c.endsWith("/care-team-channel")).length;

beforeEach(() => {
  navigations = 0;
  calls = [];
  mode = "ok";
  release = null;
});

const entryPoints: [string, () => ReactElement, () => Promise<HTMLElement> | HTMLElement][] = [
  [
    "Communication tab",
    () => <ChartModuleRail patientId={PATIENT} current="summary" />,
    () => screen.getByRole("link", { name: "Communication" }),
  ],
  [
    "Send Message quick link",
    () => <OverviewRail patientId={PATIENT} data={{}} />,
    () => screen.getByRole("link", { name: /Send Message/ }),
  ],
  [
    "Message care team action",
    () => <PatientChartHeader patient={patient} data={{}} />,
    () => {
      fireEvent.click(screen.getByRole("button", { name: /Actions/ }));
      return screen.getByRole("link", { name: "Message care team" });
    },
  ],
  [
    "care team member message icon",
    () => (
      <OverviewTab
        patient={patient}
        data={{
          careTeam: {
            assignments: [
              {
                id: "a1",
                clinicianUserId: "u1",
                role: "primary_rn",
                assignedAt: "2026-01-01T00:00:00Z",
                current: true,
              },
            ],
            emergencyContacts: [],
          },
        }}
      />
    ),
    () => screen.getByRole("link", { name: /^Message / }),
  ],
];

describe.each(entryPoints)("%s", (_name, ui, getLink) => {
  it("opens this patient's conversation with the resolved channel id", async () => {
    mount(ui());
    fireEvent.click(await getLink());
    await screen.findByText(`Messaging destination ${CHANNEL}`);
    expect(calls).toContain(`POST /api/v1/messaging/patients/${PATIENT}/care-team-channel`);
  });

  it("toasts and stays put when the channel is unavailable", async () => {
    mode = "denied";
    mount(ui());
    fireEvent.click(await getLink());
    await screen.findByText(
      "The care team conversation is unavailable or your access has changed.",
    );
    expect(screen.queryByText(/Messaging destination/)).toBeNull();
  });

  it("sends one request for a double click", async () => {
    mode = "hang";
    mount(ui());
    const link = await getLink();
    fireEvent.click(link);
    fireEvent.click(link);
    await waitFor(() => expect(channelPosts()).toBe(1));
    await act(async () => release?.());
    await screen.findByText(`Messaging destination ${CHANNEL}`);
    expect(channelPosts()).toBe(1);
  });
});

const UNAVAILABLE = "The care team conversation is unavailable or your access has changed.";
const rail = () => screen.getByRole("link", { name: "Communication" });

function LinkHarness({ patientId, current }: { patientId: string; current?: "page" }) {
  const conversation = useOpenPatientConversation(patientId);
  return (
    <PatientConversationLink
      patientId={patientId}
      conversation={conversation}
      aria-current={current}
    >
      Chat
    </PatientConversationLink>
  );
}

function Toggle({ children }: { children: ReactElement }) {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setShown(false)}>
        hide
      </button>
      {shown ? children : null}
    </>
  );
}

function SharedHarness() {
  const conversation = useOpenPatientConversation(PATIENT);
  return (
    <>
      {["One", "Two", "Three"].map((label) => (
        <PatientConversationLink key={label} patientId={PATIENT} conversation={conversation}>
          {label}
        </PatientConversationLink>
      ))}
    </>
  );
}

describe("shared hook and cross-instance behaviour", () => {
  it("announces opening once and keeps every link name stable", async () => {
    mode = "hang";
    mount(<SharedHarness />);
    fireEvent.click(screen.getByRole("link", { name: "Two" }));
    await waitFor(() => expect(screen.getAllByRole("status")).toHaveLength(1));
    expect(screen.getByRole("status").textContent).toBe("Opening care team conversation…");
    for (const name of ["One", "Two", "Three"]) {
      expect(screen.getByRole("link", { name }).getAttribute("aria-busy")).toBe("true");
    }
    await act(async () => release?.());
    await screen.findByText(`Messaging destination ${CHANNEL}`);
  });

  it("sends one POST and one navigation for two hook instances of the same patient", async () => {
    mode = "hang";
    mount(
      <>
        <LinkHarness patientId={PATIENT} />
        <ChartModuleRail patientId={PATIENT} current="summary" />
      </>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Chat" }));
    fireEvent.click(rail());
    await waitFor(() => expect(channelPosts()).toBe(1));
    await act(async () => release?.());
    await screen.findByText(`Messaging destination ${CHANNEL}`);
    expect(channelPosts()).toBe(1);
    expect(navigations).toBe(1);
  });
});

describe("Communication tab semantics", () => {
  it("is a link whose href never points at /messaging", () => {
    mount(<ChartModuleRail patientId={PATIENT} current="summary" />);
    expect(rail().getAttribute("href")).toBe(`/patients/${PATIENT}`);
    expect(rail().getAttribute("aria-current")).toBeNull();
  });

  it("sets aria-current on the real rail when Communication is the active section", () => {
    mount(<ChartModuleRail patientId={PATIENT} current="communication" />);
    expect(rail().getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBeNull();
  });

  it.each([
    ["plain", {}],
    ["ctrl", { ctrlKey: true }],
    ["meta", { metaKey: true }],
    ["shift", { shiftKey: true }],
    ["alt", { altKey: true }],
  ])("%s click is intercepted and opens the conversation in this tab", async (_n, init) => {
    mode = "hang";
    mount(<ChartModuleRail patientId={PATIENT} current="summary" />);
    const notPrevented = fireEvent.click(rail(), init);
    expect(notPrevented).toBe(false);
    await waitFor(() => expect(channelPosts()).toBe(1));
    await act(async () => release?.());
    await screen.findByText(`Messaging destination ${CHANNEL}`);
  });

  it("intercepts a middle click too", async () => {
    mount(<ChartModuleRail patientId={PATIENT} current="summary" />);
    const notPrevented = fireEvent(
      rail(),
      new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }),
    );
    expect(notPrevented).toBe(false);
    await screen.findByText(`Messaging destination ${CHANNEL}`);
  });

  it("exposes the busy state and ignores a second click while pending", async () => {
    mode = "hang";
    mount(<ChartModuleRail patientId={PATIENT} current="summary" />);
    fireEvent.click(rail());
    await waitFor(() => expect(rail().getAttribute("aria-busy")).toBe("true"));
    expect(rail().getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe("Opening care team conversation…");
    // The name stays stable mid-flight (exact match).
    expect(screen.getByRole("link", { name: "Communication" })).toBeTruthy();
    fireEvent.click(rail());
    expect(channelPosts()).toBe(1);
    await act(async () => release?.());
    await screen.findByText(`Messaging destination ${CHANNEL}`);
  });

  it("toasts when the request throws, then a retry succeeds", async () => {
    mode = "throw";
    mount(<ChartModuleRail patientId={PATIENT} current="summary" />);
    fireEvent.click(rail());
    await screen.findByText("The care team conversation could not be opened. Try again.");
    await waitFor(() => expect(rail().getAttribute("aria-busy")).toBeNull());
    mode = "ok";
    fireEvent.click(rail());
    await screen.findByText(`Messaging destination ${CHANNEL}`);
  });

  it("recovers from a denied response with a successful retry", async () => {
    mode = "denied";
    mount(<ChartModuleRail patientId={PATIENT} current="summary" />);
    fireEvent.click(rail());
    await screen.findByText(UNAVAILABLE);
    await waitFor(() => expect(rail().getAttribute("aria-busy")).toBeNull());
    mode = "ok";
    fireEvent.click(rail());
    await screen.findByText(`Messaging destination ${CHANNEL}`);
    expect(channelPosts()).toBe(2);
  });

  it("refuses a channel that belongs to another patient", async () => {
    mode = "other-patient";
    mount(<ChartModuleRail patientId={PATIENT} current="summary" />);
    fireEvent.click(rail());
    await screen.findByText(UNAVAILABLE);
    expect(screen.queryByText(/Messaging destination/)).toBeNull();
  });

  it("ignores a response that lands after the link unmounts (router stays mounted)", async () => {
    mode = "hang";
    mount(
      <Toggle>
        <ChartModuleRail patientId={PATIENT} current="summary" />
      </Toggle>,
    );
    fireEvent.click(rail());
    await waitFor(() => expect(channelPosts()).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "hide" }));
    await act(async () => release?.());
    expect(screen.queryByText(/Messaging destination/)).toBeNull();
    expect(screen.getByRole("button", { name: "hide" })).toBeTruthy();
  });

  it("ignores a stale response after the patient changes and frees the next click", async () => {
    mode = "hang";
    const tree = (id: string) => (
      <ApiClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/chart"]}>
            <Routes>
              <Route path="/chart" element={<LinkHarness patientId={id} />} />
              <Route path="/messaging" element={<Destination />} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </ApiClientProvider>
    );
    const view = render(tree(PATIENT));
    fireEvent.click(screen.getByRole("link", { name: "Chat" }));
    await waitFor(() => expect(channelPosts()).toBe(1));
    view.rerender(tree("22222222-2222-4222-8222-222222222222"));
    expect(screen.getByRole("link", { name: "Chat" }).getAttribute("aria-busy")).toBeNull();
    await act(async () => release?.());
    expect(screen.queryByText(/Messaging destination/)).toBeNull();
    mode = "ok";
    fireEvent.click(screen.getByRole("link", { name: "Chat" }));
    await screen.findByText(`Messaging destination ${CHANNEL}`);
  });

  it("keeps the Actions menu request alive when the menu is closed mid-flight", async () => {
    mode = "hang";
    mount(<PatientChartHeader patient={patient} data={{}} />);
    const actions = screen.getByRole("button", { name: /Actions/ });
    fireEvent.click(actions);
    fireEvent.click(screen.getByRole("link", { name: "Message care team" }));
    await waitFor(() => expect(channelPosts()).toBe(1));
    expect(screen.getByRole("link", { name: "Message care team" })).toBeTruthy();
    fireEvent.click(actions);
    await act(async () => release?.());
    await screen.findByText(`Messaging destination ${CHANNEL}`);
  });
});
