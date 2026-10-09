// GAP-020 -- the print-wristband dialog. The raw payload is a one-time secret: the dialog must request a first
// print with no expected generation, show the code only while it is open, and drop it when it closes.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { formatWristbandPayload } from "@wardenx/types";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WristbandAction } from "./wristband-action";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PAYLOAD = formatWristbandPayload(Uint8Array.from({ length: 16 }, (_, i) => i * 3 + 1));

let posts: { path: string; body: Record<string, unknown> }[] = [];
let status: {
  state: "none" | "active";
  generation: number | null;
  issuedAt: string | null;
  everIssued: boolean;
} = {
  state: "none",
  generation: null,
  issuedAt: null,
  everIssued: false,
};

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "clone" in input ? (input as Request) : null;
  const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
  const url = req?.url ?? String(input);
  const path = new URL(url, "http://localhost").pathname;
  if (method === "POST") {
    const raw = req ? await req.clone().text() : "";
    posts.push({ path, body: JSON.parse(raw || "{}") as Record<string, unknown> });
    return new Response(
      JSON.stringify({
        generation: 1,
        payload: PAYLOAD,
        issuedAt: "2026-10-08T12:00:00.000Z",
        label: { name: "Ada Vance", mrn: "MRN-1", dob: "1948-03-02" },
      }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(JSON.stringify(status), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function mount() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <ToastProvider>
        <WristbandAction patientId={PATIENT} />
      </ToastProvider>
    </ApiClientProvider>,
  );
}

beforeEach(() => {
  posts = [];
  status = { state: "none", generation: null, issuedAt: null, everIssued: false };
  vi.stubGlobal("fetch", vi.fn(stubFetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WristbandAction (GAP-020)", () => {
  it("first print: POSTs first_issue with no expected generation, shows the code once, clears it on close", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Print wristband" }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate wristband" }));

    await waitFor(() => expect(screen.getByText(PAYLOAD)).toBeTruthy());
    expect(posts).toEqual([
      {
        path: `/api/v1/patients/${PATIENT}/wristbands`,
        body: { reason: "first_issue", expectedCurrentGeneration: null },
      },
    ]);
    expect(screen.getByText(/shown once/i)).toBeTruthy();
    // QR + Code 128 are real SVGs rendered from the payload.
    expect(document.querySelectorAll(".wx-wristband-label svg").length).toBe(2);

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText(PAYLOAD)).toBeNull());
    expect(document.body.textContent).not.toContain(PAYLOAD);
  });

  it("reprint: when a band is active it asks for a reason and sends the generation it saw", async () => {
    status = {
      state: "active",
      generation: 3,
      issuedAt: "2026-10-01T00:00:00.000Z",
      everIssued: true,
    };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Reprint wristband" }));
    fireEvent.change(await screen.findByLabelText("Reason for reprint"), {
      target: { value: "reprint_damaged" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate wristband" }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]?.body).toEqual({ reason: "reprint_damaged", expectedCurrentGeneration: 3 });
  });

  it("after every generation was voided it asks for a reprint reason, never first_issue", async () => {
    status = { state: "none", generation: null, issuedAt: null, everIssued: true };
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Reprint wristband" }));
    fireEvent.change(await screen.findByLabelText("Reason for reprint"), {
      target: { value: "identity_correction" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate wristband" }));
    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]?.body).toEqual({
      reason: "identity_correction",
      expectedCurrentGeneration: null,
    });
  });
});
