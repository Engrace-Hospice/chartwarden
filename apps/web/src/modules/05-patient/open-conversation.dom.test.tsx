// Every patient-scoped "message" entry point must open THIS patient's care-team conversation
// (POST care-team-channel, then router state), never plain /messaging (first conversation in the list).
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { ReactElement } from "react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { ChartModuleRail } from "../../shell/chart-module-rail";
import { PatientChartHeader, OverviewRail, OverviewTab } from "./patient-overview";

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
let mode: "ok" | "denied" | "hang" = "ok";
let release: (() => void) | null = null;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(req.url, "http://localhost");
  calls.push(`${req.method} ${url.pathname}`);
  if (url.pathname.endsWith("/care-team-channel")) {
    if (mode === "denied") return json({ error: { code: "FORBIDDEN", message: "no" } }, 403);
    if (mode === "hang") await new Promise<void>((r) => (release = r));
    return json({ channelId: CHANNEL, kind: "care_team", patientId: PATIENT, archived: false });
  }
  return json({}, 404);
}

function Destination() {
  const state = useLocation().state as { messagingChannelId?: string } | null;
  return <div>Messaging destination {state?.messagingChannelId ?? "none"}</div>;
}

function mount(ui: ReactElement) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
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

describe("Communication tab semantics", () => {
  it("stays a link to /messaging, marks nothing current off-section, and lets modified clicks through", async () => {
    mount(<ChartModuleRail patientId={PATIENT} current="summary" />);
    const link = screen.getByRole("link", { name: "Communication" });
    expect(link.getAttribute("href")).toBe("/messaging");
    expect(link.getAttribute("aria-current")).toBeNull();
    // jsdom cannot follow a real navigation; the router lets the modified click through unprevented.
    link.addEventListener("click", (e) => e.preventDefault());
    fireEvent.click(link, { ctrlKey: true });
    expect(channelPosts()).toBe(0);
  });

  it("ignores a response that lands after unmount", async () => {
    mode = "hang";
    const view = mount(<ChartModuleRail patientId={PATIENT} current="summary" />);
    fireEvent.click(screen.getByRole("link", { name: "Communication" }));
    await waitFor(() => expect(channelPosts()).toBe(1));
    view.unmount();
    await act(async () => release?.());
    expect(screen.queryByText(/Messaging destination/)).toBeNull();
  });
});
