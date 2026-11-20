import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { markStepUpReturn } from "../../shell/step-up-redirect";
import { EvvEventDetail } from "./event-detail";

const ORIGINAL = "11111111-1111-4111-8111-111111111111";
const MIDDLE = "22222222-2222-4222-8222-222222222222";
const HEAD = "33333333-3333-4333-8333-333333333333";
const REPLACEMENT = "44444444-4444-4444-8444-444444444444";
const VISIT = "55555555-5555-4555-8555-555555555555";
const PATIENT = "66666666-6666-4666-8666-666666666666";
const DEVICE = "77777777-7777-4777-8777-777777777777";
const PATH = `/evv/events/${HEAD}`;

const event = (id: string, replacesEventId: string | null, supersededByEventId: string | null) => ({
  id,
  organizationId: "org-1",
  visitId: VISIT,
  patientId: PATIENT,
  kind: "check_in" as const,
  serviceTypeCode: "G0156",
  postingMembershipId: "membership-1",
  postingDisciplineAtRecording: "hha",
  evvDeviceId: DEVICE,
  capturedAt: "2026-11-19T17:30:00.000Z",
  recordedAt: "2026-11-19T17:31:00.000Z",
  gpsQuality: "acceptable" as const,
  offlineCapture: false,
  replacesEventId,
  supersededByEventId,
});

const events = new Map([
  [ORIGINAL, event(ORIGINAL, null, MIDDLE)],
  [MIDDLE, event(MIDDLE, ORIGINAL, HEAD)],
  [HEAD, event(HEAD, MIDDLE, null)],
  [REPLACEMENT, event(REPLACEMENT, null, null)],
]);

let correctionResponse: { status: number; body: unknown };
let correctionBody: unknown = null;
let correctionTargetId: string | null = null;
let fetchImpl = stubFetch;

function requestOf(input: RequestInfo | URL, init?: RequestInit): Request {
  if (input instanceof Request) return input;
  return new Request(input, init);
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = requestOf(input, init);
  const url = new URL(request.url, "http://localhost");
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  if (request.method === "POST") {
    correctionTargetId = url.pathname.split("/").at(-2) ?? null;
    correctionBody = await request.clone().json();
    return json(correctionResponse.status, correctionResponse.body);
  }

  const id = url.pathname.split("/").at(-1) ?? "";
  const found = events.get(id);
  return found ? json(200, found) : json(404, { error: { code: "NOT_FOUND" } });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["clinical_supervisor"],
  permissions: ["evv.read", "evv.correct_record"],
  isAdmin: false,
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

function NavigateProbe() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(`/evv/events/${REPLACEMENT}`)}>
      Open replacement
    </button>
  );
}

function mount(path = PATH, permissions = SESSION.permissions) {
  return render(
    <ApiClientProvider
      client={createApiClient({
        baseUrl: "http://localhost",
        fetch: (input: Request) => fetchImpl(input),
      })}
    >
      <SessionProvider session={{ ...SESSION, permissions }}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <LocationProbe />
            <NavigateProbe />
            <Routes>
              <Route path="/evv/events/:eventId" element={<EvvEventDetail />} />
              <Route path="/step-up" element={<div>Step-up</div>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

async function openAndFillCorrection() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "File correction" }));
  await screen.findByRole("dialog", { name: "Correct EVV event" });
  await user.clear(screen.getByLabelText(/captured at/i));
  await user.type(screen.getByLabelText(/captured at/i), "2026-11-19T09:45");
  await user.type(screen.getByLabelText(/latitude/i), "34.0522");
  await user.type(screen.getByLabelText(/longitude/i), "-118.2437");
  await user.type(screen.getByLabelText(/accuracy in meters/i), "18");
  await user.type(
    screen.getByLabelText(/correction reason/i),
    "The original capture used an incorrect device timestamp after a supervised clock review.",
  );
  return user;
}

beforeEach(() => {
  correctionBody = null;
  correctionTargetId = null;
  fetchImpl = stubFetch;
  correctionResponse = {
    status: 200,
    body: {
      eventId: REPLACEMENT,
      kind: "check_in",
      gpsQuality: "acceptable",
      geofenceDecision: "pass",
      visitStateAfterEvent: "in_visit",
    },
  };
  window.sessionStorage.clear();
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe("EVV event evidence timeline", () => {
  it("follows the immutable correction chain and identifies the live record", async () => {
    mount(`/evv/events/${MIDDLE}`);

    const timeline = await screen.findByRole("region", { name: "Correction evidence" });
    await waitFor(() => expect(timeline.querySelectorAll("li")).toHaveLength(3));
    expect(screen.getByText("Original event")).toBeInTheDocument();
    expect(screen.getByText("Correction 1")).toBeInTheDocument();
    expect(screen.getByText("Correction 2 · Current")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "File correction" })).not.toBeInTheDocument();
  });

  it("offers correction only for an authorized live head", async () => {
    mount(PATH, ["evv.read"]);
    await screen.findByText("Correction 2 · Current");
    expect(screen.queryByRole("button", { name: "File correction" })).not.toBeInTheDocument();
  });

  it("does not let a stale chain load replace the newly selected correction target", async () => {
    let releaseHead!: (response: Response) => void;
    let headSettled = false;
    const delayedHead = new Promise<Response>((resolve) => {
      releaseHead = resolve;
    });
    fetchImpl = async (input, init) => {
      const request = requestOf(input, init);
      const id = new URL(request.url, "http://localhost").pathname.split("/").at(-1);
      if (request.method === "GET" && id === HEAD) {
        const response = await delayedHead;
        headSettled = true;
        return response;
      }
      return stubFetch(request);
    };

    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Open replacement" }));
    expect(await screen.findByRole("link", { name: /open event 44444444/i })).toBeInTheDocument();

    releaseHead(
      new Response(JSON.stringify(events.get(HEAD)), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await waitFor(() => expect(headSettled).toBe(true));
    expect(screen.getByRole("link", { name: /open event 44444444/i })).toBeInTheDocument();

    const correctionUser = await openAndFillCorrection();
    await correctionUser.click(screen.getByRole("button", { name: "Create correction" }));
    await waitFor(() => expect(correctionTargetId).toBe(REPLACEMENT));
  });
});

describe("EVV append-only correction", () => {
  it("submits a replacement capture while preserving the original event", async () => {
    mount();
    const user = await openAndFillCorrection();

    expect(screen.getByText(/original event remains unchanged/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create correction" }));

    await waitFor(() => expect(correctionBody).not.toBeNull());
    expect(correctionBody).toEqual({
      newEvent: {
        visitId: VISIT,
        serviceTypeCode: "G0156",
        capturedAt: new Date("2026-11-19T09:45").toISOString(),
        coords: { lat: 34.0522, lng: -118.2437 },
        accuracyM: 18,
        evvDeviceId: DEVICE,
        offlineCapture: false,
      },
      correctionReason:
        "The original capture used an incorrect device timestamp after a supervised clock review.",
    });
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(REPLACEMENT));
  });

  it("preserves the draft through a STEP_UP_REQUIRED round trip", async () => {
    correctionResponse = {
      status: 403,
      body: { error: { code: "STEP_UP_REQUIRED", message: "Re-authentication required." } },
    };
    mount();
    const user = await openAndFillCorrection();
    await user.click(screen.getByRole("button", { name: "Create correction" }));

    const stepUp = `/step-up?returnTo=${encodeURIComponent(PATH)}`;
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(stepUp));

    cleanup();
    markStepUpReturn(PATH);
    mount();
    expect(await screen.findByRole("dialog", { name: "Correct EVV event" })).toBeInTheDocument();
    expect(screen.getByLabelText(/correction reason/i)).toHaveValue(
      "The original capture used an incorrect device timestamp after a supervised clock review.",
    );
  });

  it("keeps a concurrent supersede refusal in context instead of overwriting", async () => {
    correctionResponse = {
      status: 409,
      body: {
        error: {
          code: "EVV_EVENT_ALREADY_SUPERSEDED",
          message: "The target event is already superseded.",
        },
      },
    };
    mount();
    const user = await openAndFillCorrection();
    await user.click(screen.getByRole("button", { name: "Create correction" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/open the current event/i);
    expect(screen.getByTestId("where")).toHaveTextContent(PATH);
  });

  it("recovers from a correction transport failure", async () => {
    fetchImpl = async (input, init) => {
      const request = requestOf(input, init);
      if (request.method === "POST") throw new TypeError("network unavailable");
      return stubFetch(request);
    };
    mount();
    const user = await openAndFillCorrection();
    await user.click(screen.getByRole("button", { name: "Create correction" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/connection failed/i);
    expect(screen.getByRole("button", { name: "Create correction" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });
});
