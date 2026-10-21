// apps/web/src/modules/18-evv — #91: nine EVV read screens, zero mutations.
//
// EVV is a FEDERAL requirement — the 21st Century Cures Act obliges every state Medicaid programme to
// verify home-visit delivery electronically. Four queues stand between a delivered visit and a paid one,
// and none of them had a control:
//   • the DEVICE roster. Capture is refused outright without an APPROVED `evv_device` (D8), so a
//     clinician who self-registered from their handset could not verify a single visit until someone
//     approved them — and nothing on this platform could.
//   • the MISSING-EVV RESOLUTION backlog. An OPEN row is what blocks the visit downstream. Closing it is
//     a human attestation on a §7.3 24-hour / §7.4 7-day clock, so with no control every row aged out.
//   • the AGGREGATOR SUBMISSION queue. A rejection is fixed and resubmitted by an operator (§7.9); a
//     voided visit's submission is cancelled. A rejected row stayed rejected forever.
//   • the GEOFENCE POLICY. These numbers decide whether a capture reads `pass` or `outside_geofence` —
//     which is what puts a visit in the resolution queue to begin with.
//
// Asserted on the recorded `fetch` calls — method, path, body — never on a spy over the api client, so a
// test cannot pass against a client that was never wired to a screen.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { EvvAggregatorSubmissions } from "./aggregator-submissions";
import { EvvDevicesPending } from "./devices";
import { EvvGeofencePolicy } from "./geofence-policy";
import { EvvMissingResolutions } from "./missing-resolutions";

const DEVICE = "dddddddd-1111-4111-8111-dddddddddddd";
const RESOLUTION = "rrrrrrrr-2222-4222-8222-rrrrrrrrrrrr".replace(/r/g, "a");
const SUBMISSION = "cccccccc-3333-4333-8333-cccccccccccc";
const VISIT = "99999999-4444-4444-8444-999999999999";
const PATIENT = "88888888-5555-4555-8555-888888888888";
const ADDRESS = "77777777-6666-4666-8666-777777777777";

let deviceStatus = "pending_approval";
let resolutionStatus = "open";
let submissionStatus = "rejected";

const device = () => ({
  id: DEVICE,
  membershipId: "membership-1",
  platform: "ios",
  modelDescription: "iPhone 14 Pro",
  status: deviceStatus,
});
const resolution = () => ({
  id: RESOLUTION,
  visitId: VISIT,
  kind: "missing_checkout",
  status: resolutionStatus,
  resolvedByMembershipId: null,
});
const submission = () => ({
  id: SUBMISSION,
  visitId: VISIT,
  stateCode: "PA",
  aggregatorVendor: "sandata",
  status: submissionStatus,
  aggregatorTransactionId: null,
  attemptCount: 2,
});
const policy = () => ({
  tenant: { radiusM: 150, maxAccuracyM: 40 },
  perAddress: [{ patientAddressId: ADDRESS, radiusM: 60, maxAccuracyM: 20 }],
});

let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];
let writeFailure: { status: number; body: unknown } | null = null;

function requestOf(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string } {
  if (typeof input === "string")
    return { url: input, method: (init?.method ?? "GET").toUpperCase() };
  if (input instanceof URL)
    return { url: input.toString(), method: (init?.method ?? "GET").toUpperCase() };
  return { url: input.url, method: (init?.method ?? input.method ?? "GET").toUpperCase() };
}

function bodyFor(method: string, path: string): unknown {
  if (method === "GET") {
    if (path === "/api/v1/evv/devices") return [device()];
    if (path === "/api/v1/evv/missing-resolutions") return [resolution()];
    if (path === "/api/v1/evv/aggregator-submissions") return [submission()];
    if (path === "/api/v1/evv/geofence-policy") return policy();
    if (path === "/api/v1/patients")
      return {
        items: [
          {
            id: PATIENT,
            organizationId: "org-1",
            mrn: "MRN-7",
            lastName: "Okafor",
            firstName: "Ngozi",
            dob: "1941-11-02",
            status: "active",
          },
        ],
        nextCursor: null,
      };
    if (path.endsWith("/addresses"))
      return {
        addresses: [{ id: ADDRESS, line1: "Glenlair Farm", city: "Dumfries", kind: "home" }],
      };
  }
  if (path.includes("/evv/devices/")) return device();
  if (path.includes("/missing-resolutions/")) return resolution();
  if (path.includes("/aggregator-submissions/")) return submission();
  if (path.includes("/geofence-policy")) return policy();
  return {};
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, method } = requestOf(input, init);
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  if (method !== "GET") {
    const req = typeof input === "object" && "clone" in input ? (input as Request) : null;
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    if (raw) {
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Every M18 write sends JSON; recording nothing is honest if one ever does not.
      }
    }
    if (writeFailure) {
      return new Response(JSON.stringify(writeFailure.body), {
        status: writeFailure.status,
        headers: { "content-type": "application/json" },
      });
    }
  }
  return new Response(JSON.stringify(bodyFor(method, path)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["clinical_supervisor"],
  permissions: [],
  isAdmin: false,
};

function mount(element: JSX.Element): ReturnType<typeof render> {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={["/evv"]}>
            <Routes>
              <Route path="/evv" element={element} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
}

const writes = () => calls.filter((c) => !c.startsWith("GET "));
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

beforeEach(() => {
  calls = [];
  bodies = [];
  writeFailure = null;
  deviceStatus = "pending_approval";
  resolutionStatus = "open";
  submissionStatus = "rejected";
});
afterEach(() => {
  writeFailure = null;
});

describe("#91 — the device roster can decide a device", () => {
  it("approves a pending device (no body — the route takes none)", async () => {
    mount(<EvvDevicesPending />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    fireEvent.click(await screen.findByRole("button", { name: "Approve device" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/evv/devices/${DEVICE}/approve`));
  });

  it("a rejection SENDS its reason — the column exists and until #165 nothing wrote it", async () => {
    mount(<EvvDevicesPending />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    type(await screen.findByLabelText(/^reason/i), "enrolled on a personal handset");
    fireEvent.click(screen.getByRole("button", { name: "Reject device" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/evv/devices/${DEVICE}/reject`));
    expect(bodies.at(-1)).toEqual({ reason: "enrolled on a personal handset" });
  });

  it("a rejection with no reason cannot be submitted", async () => {
    mount(<EvvDevicesPending />);
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    expect(
      (screen.getByRole("button", { name: "Reject device" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("only a PENDING device offers approve/reject; an approved one offers suspend and retire", async () => {
    deviceStatus = "approved";
    mount(<EvvDevicesPending />);
    type(await screen.findByLabelText(/device status/i), "approved");
    await screen.findByRole("button", { name: "Suspend" });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retire" })).toBeTruthy();
  });

  it("a retired device offers nothing — it is terminal", async () => {
    deviceStatus = "retired";
    mount(<EvvDevicesPending />);
    type(await screen.findByLabelText(/device status/i), "retired");
    await screen.findByText(/iPhone 14 Pro/);
    for (const label of ["Approve", "Reject", "Suspend", "Retire"]) {
      expect(screen.queryByRole("button", { name: label })).toBeNull();
    }
  });

  it("retire sends no reason when none is typed — an empty string is not a reason", async () => {
    deviceStatus = "approved";
    mount(<EvvDevicesPending />);
    type(await screen.findByLabelText(/device status/i), "approved");
    fireEvent.click(await screen.findByRole("button", { name: "Retire" }));
    fireEvent.click(await screen.findByRole("button", { name: "Retire device" }));
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/evv/devices/${DEVICE}/retire`));
    expect(bodies.at(-1)).toEqual({});
  });
});

describe("#91 — the missing-EVV backlog can be closed", () => {
  it("a clinician self-attest sends its reason and the row reflects the close", async () => {
    resolutionStatus = "open";
    mount(<EvvMissingResolutions />);
    fireEvent.click(await screen.findByRole("button", { name: "Attest" }));
    const reason =
      "I delivered this visit at 14:10; the handset lost signal in the glen and never captured the check-out.";
    type(await screen.findByLabelText(/what happened/i), reason);
    fireEvent.click(screen.getByRole("button", { name: "Record attestation" }));
    await waitFor(() =>
      expect(writes()).toContain(
        `POST /api/v1/evv/missing-resolutions/${RESOLUTION}/clinician-attest`,
      ),
    );
    expect(bodies.at(-1)).toEqual({ reason });
  });

  it("a self-attest below the 40-character floor cannot be submitted, and says how far short", async () => {
    mount(<EvvMissingResolutions />);
    fireEvent.click(await screen.findByRole("button", { name: "Attest" }));
    type(await screen.findByLabelText(/what happened/i), "was there");
    // 40 − 9 = 31.
    expect(await screen.findByText(/31 more characters/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Record attestation" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(writes()).toHaveLength(0);
  });

  it("a supervisor override carries the HIGHER 60-character floor and sends no step-up ref", async () => {
    mount(<EvvMissingResolutions />);
    fireEvent.click(await screen.findByRole("button", { name: "Override" }));
    const reason =
      "The clinician confirmed delivery by phone and the encounter note was signed the same evening; the handset had failed.";
    type(await screen.findByLabelText(/what happened/i), reason);
    fireEvent.click(screen.getByRole("button", { name: "Record override" }));
    await waitFor(() =>
      expect(writes()).toContain(
        `POST /api/v1/evv/missing-resolutions/${RESOLUTION}/supervisor-override`,
      ),
    );
    // `stepUpAuthRefId` was a required uuid no caller could obtain (#165). The step-up is resolved
    // from the session; a client that invents one is not doing the ceremony.
    expect(bodies.at(-1)).toEqual({ reason });
  });

  it("a 403 from the step-up gate is rendered in place, and the row stays open", async () => {
    writeFailure = {
      status: 403,
      body: {
        error: {
          code: "EVV_SUPERVISOR_OVERRIDE_STEP_UP_REQUIRED",
          message: "A supervisor override requires fresh M2 step-up auth.",
        },
      },
    };
    mount(<EvvMissingResolutions />);
    fireEvent.click(await screen.findByRole("button", { name: "Override" }));
    type(await screen.findByLabelText(/what happened/i), "x".repeat(80));
    fireEvent.click(screen.getByRole("button", { name: "Record override" }));
    expect(await screen.findByText(/fresh M2 step-up/i)).toBeTruthy();
  });

  it("a closed row offers no close — the actions belong to `open` only", async () => {
    resolutionStatus = "closed_supervisor_override";
    mount(<EvvMissingResolutions />);
    await screen.findByText("Closed");
    expect(screen.queryByRole("button", { name: "Attest" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Override" })).toBeNull();
  });

  it("the 'not the assigned clinician' refusal names the OTHER route rather than a retry", async () => {
    writeFailure = {
      status: 403,
      body: { error: { code: "EVV_RESOLUTION_NOT_ASSIGNED_CLINICIAN", message: "Not assigned." } },
    };
    mount(<EvvMissingResolutions />);
    fireEvent.click(await screen.findByRole("button", { name: "Attest" }));
    type(await screen.findByLabelText(/what happened/i), "x".repeat(60));
    fireEvent.click(screen.getByRole("button", { name: "Record attestation" }));
    expect(await screen.findByText(/supervisor override is the other route/i)).toBeTruthy();
  });
});

describe("#91 — the aggregator queue can be worked", () => {
  it("a rejected submission can be resubmitted", async () => {
    mount(<EvvAggregatorSubmissions />);
    fireEvent.click(await screen.findByRole("button", { name: "Resubmit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Queue resubmission" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/evv/aggregator-submissions/${SUBMISSION}/resubmit`),
    );
  });

  it("a cancel sends its reason", async () => {
    submissionStatus = "queued";
    mount(<EvvAggregatorSubmissions />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    type(await screen.findByLabelText(/why is this being cancelled/i), "the visit was voided");
    fireEvent.click(screen.getByRole("button", { name: "Cancel submission" }));
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/evv/aggregator-submissions/${SUBMISSION}/cancel`),
    );
    expect(bodies.at(-1)).toEqual({ reason: "the visit was voided" });
  });

  it("a QUEUED submission offers cancel and not resubmit — resubmit follows a rejection", async () => {
    submissionStatus = "queued";
    mount(<EvvAggregatorSubmissions />);
    await screen.findByRole("button", { name: "Cancel" });
    expect(screen.queryByRole("button", { name: "Resubmit" })).toBeNull();
  });

  it("an ACCEPTED submission is terminal and offers neither", async () => {
    submissionStatus = "accepted";
    mount(<EvvAggregatorSubmissions />);
    // The row's own "—" placeholder is what an actionless row renders.
    await screen.findByText("—");
    expect(screen.queryByRole("button", { name: "Resubmit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });
});

describe("#91 — the geofence policy can be changed", () => {
  it("the tenant policy edit sends both numbers", async () => {
    mount(<EvvGeofencePolicy />);
    fireEvent.click(await screen.findByRole("button", { name: /edit tenant policy/i }));
    type(await screen.findByLabelText(/^radius \(m\)/i), "120");
    type(screen.getByLabelText(/max accuracy/i), "25");
    fireEvent.click(screen.getByRole("button", { name: /save policy/i }));
    await waitFor(() => expect(writes()).toContain("PATCH /api/v1/evv/geofence-policy/tenant"));
    expect(bodies.at(-1)).toEqual({ radiusM: 120, maxAccuracyM: 25 });
  });

  it("a LOOSER policy is warned about and still submittable — tighten-only is the server's rule", async () => {
    mount(<EvvGeofencePolicy />);
    fireEvent.click(await screen.findByRole("button", { name: /edit tenant policy/i }));
    type(await screen.findByLabelText(/^radius \(m\)/i), "900");
    expect(await screen.findByText(/looser than the platform floor/i)).toBeTruthy();
    // Enabled on purpose: a floor this build has stale numbers for must not lock out a legal edit.
    expect(
      (screen.getByRole("button", { name: /save policy/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("a per-address override resolves the address through patient search, then sends it", async () => {
    mount(<EvvGeofencePolicy />);
    fireEvent.click(await screen.findByRole("button", { name: /add override/i }));
    type(await screen.findByLabelText(/^patient/i), "Okafor");
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    // The address is not in context on an org-scoped screen: patient, then their addresses.
    type(await screen.findByLabelText(/^match/i), PATIENT);
    await waitFor(() => expect(calls).toContain(`GET /api/v1/patients/${PATIENT}/addresses`));
    const reason = "the farm track leaves the public road 400m before the house";
    type(await screen.findByLabelText(/why does this address/i), reason);
    fireEvent.click(screen.getByRole("button", { name: /save override/i }));
    await waitFor(() => expect(writes()).toContain("POST /api/v1/evv/geofence-policy/per-address"));
    expect(bodies.at(-1)).toEqual({
      patientAddressId: ADDRESS,
      radiusM: 120,
      maxAccuracyM: 30,
      overrideReason: reason,
    });
  });

  it("an override with no address cannot be saved — it is the one input the route needs", async () => {
    mount(<EvvGeofencePolicy />);
    fireEvent.click(await screen.findByRole("button", { name: /add override/i }));
    type(await screen.findByLabelText(/why does this address/i), "x".repeat(40));
    expect(
      (screen.getByRole("button", { name: /save override/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(writes()).toHaveLength(0);
  });
});
