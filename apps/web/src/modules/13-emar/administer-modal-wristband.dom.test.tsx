// GAP-020 -- the bedside wristband field of the administer modal.
//
// What this pins is the contract between the form and the server, not the barcode maths (that is the codec's
// own test): the field sends the RAW scan as `patientWristbandPayload` (not the old free-text "digest"), a
// misread / checksum-damaged code is stopped HERE as "rescan" without a request (so a bad read never looks like
// a wrong-patient event), and a server refusal that names a wristband reason is shown with the next step.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { formatWristbandPayload } from "@wardenx/types";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { AdministerModal } from "./administer-modal";
import type { ActiveMedicationOrder } from "./emar-api";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ORDER_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const GOOD_BAND = formatWristbandPayload(Uint8Array.from({ length: 16 }, (_, i) => i + 9));

const ORDER = {
  id: ORDER_ID,
  patientId: PATIENT,
  admissionId: "11111111-1111-4111-8111-111111111111",
  medClass: "standard",
  status: "active",
  drugName: "Morphine Sulfate",
  strength: "5 mg",
  doseForm: "solution",
  route: "oral",
  rxnormRxcui: null,
  ndc: null,
  isControlledSubstance: false,
  deaSchedule: null,
  prescribingPhysicianMdmId: "55555555-9999-4999-8999-555555555555",
  prescriberDiscipline: "md",
} as unknown as ActiveMedicationOrder;

const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["rn"],
  permissions: [],
  isAdmin: false,
};

let posts: Record<string, unknown>[] = [];
let respondWith: { status: number; body: unknown } = { status: 201, body: {} };

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = typeof input === "object" && "clone" in input ? (input as Request) : null;
  const method = (req?.method ?? init?.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    if (raw) posts.push(JSON.parse(raw) as Record<string, unknown>);
  }
  return new Response(JSON.stringify(respondWith.body), {
    status: respondWith.status,
    headers: { "content-type": "application/json" },
  });
}

function mountModal() {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>
            <AdministerModal
              open
              patientId={PATIENT}
              orders={[ORDER]}
              initialOrderId={ORDER_ID}
              intent="administer"
              onClose={() => {}}
              onRecorded={() => {}}
            />
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

function confirmFiveRights(): void {
  for (const right of ["Right patient", "Right drug", "Right dose", "Right route", "Right time"])
    fireEvent.click(screen.getByLabelText(right, { exact: false }));
}

function scanAndCommit(code: string): void {
  confirmFiveRights();
  fireEvent.change(screen.getByLabelText("Scan patient wristband", { exact: false }), {
    target: { value: code },
  });
  fireEvent.click(
    screen.getAllByRole("button", { name: "Record administration" }).at(-1) as Element,
  );
}

beforeEach(() => {
  posts = [];
  respondWith = { status: 201, body: {} };
  vi.stubGlobal("fetch", vi.fn(stubFetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("administer modal -- wristband scan (GAP-020)", () => {
  it("sends the raw scan as barcodeScan.patientWristbandPayload, never the old digest field", async () => {
    mountModal();
    scanAndCommit(`${GOOD_BAND}\n`);
    await waitFor(() => expect(posts.length).toBe(1));
    const scan = (posts[0] as { barcodeScan?: Record<string, unknown> }).barcodeScan;
    expect(scan).toEqual({ patientWristbandPayload: GOOD_BAND });
    expect(scan).not.toHaveProperty("patientWristbandPayloadDigest");
  });

  it("stops a checksum-damaged read locally as 'rescan' and issues no request", async () => {
    mountModal();
    scanAndCommit(`${GOOD_BAND.slice(0, -4)}0000`);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not be read.*rescan/i);
    expect(posts).toEqual([]);
  });

  it("shows the server's wristband refusal and offers the print link when none is on file", async () => {
    respondWith = {
      status: 422,
      body: {
        error: {
          code: "BARCODE_VERIFICATION_FAILED",
          message: "barcode verification failed: wrong_patient",
          details: [
            {
              field: "barcodeScan.patientWristbandPayload",
              code: "WRISTBAND_NOT_ON_FILE",
              message: "no wristband is on file for this patient; print one",
            },
          ],
        },
      },
    };
    mountModal();
    scanAndCommit(GOOD_BAND);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/no wristband is on file/i);
    const link = screen.getByRole("link", { name: /print a wristband/i });
    expect(link.getAttribute("href")).toBe(`/patients/${PATIENT}`);
  });
});
