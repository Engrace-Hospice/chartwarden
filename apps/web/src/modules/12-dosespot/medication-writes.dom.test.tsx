// apps/web/src/modules/12-dosespot — #91: nothing in the staff app could write a prescription.
//
// Nine read screens, zero mutations. Four of them are QUEUES whose whole reason to exist is an action
// they did not offer — the prescriber Sign Inbox, the Verbal-Orders queue, the Refill Inbox and its
// detail. In a hospice, symptom control IS medication: this is the origin of the chain M13's eMAR
// administers against, and until #136 the chain did not reach the eMAR either.
//
// The net asserts on RECORDED FETCH CALLS — method, path and body — rather than on a spy over the api
// client, because a mocked client still passes when a control is re-wired to a handler that never fires.
// Several assertions are about the SHAPE of what is sent: the drug identity must come from M38 rather
// than from typing, and the sig must land under `data.sigStructured`, which is the ONLY part of the
// opaque `data` payload M12's seam store projects into the DTO M13 reads before every administration.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionProvider } from "../../shell/session";
import { MedicationDetail } from "./medication-detail";
import { PatientMedications } from "./patient-medications";
import { RefillDetail } from "./refill-detail";

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const ADMISSION = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const ORDER = "cccccccc-3333-4333-8333-cccccccccccc";
const REFILL = "dddddddd-4444-4444-8444-dddddddddddd";
const RXCUI = "1730193";

let orderStatus = "pending_signature";
let refillStatus = "pending";
let epcsStatus = "not_certified";
let admissions: Record<string, unknown>[] = [
  { id: ADMISSION, state: "active", admissionAt: "2026-08-01T00:00:00.000Z", dischargedAt: null },
];

const order = () => ({
  id: ORDER,
  patientId: PATIENT,
  admissionId: ADMISSION,
  medClass: "standard",
  status: orderStatus,
  drugName: "Morphine Sulfate 20 MG/ML Oral Solution",
  strength: "20 mg/mL",
  doseForm: "Oral Solution",
  route: "Oral",
  rxnormRxcui: RXCUI,
  ndc: "00054023549",
  version: 1,
  prescriberMembershipId: "membership-1",
  prescriberDiscipline: "hospice_physician",
  prescribingPhysicianMdmId: "mdm-1",
  dispensingPharmacyMdmId: null,
  isControlledSubstance: false,
  deaSchedule: null,
  cosignRequired: false,
  cosignStatus: null,
  refillsRemaining: 0,
  derivedFromRefillId: null,
  replacesMedicationOrderId: null,
  signedAt: null,
  signedBy: null,
  transmittedAt: null,
  discontinuedAt: null,
  discontinuationReason: null,
  createdAt: "2026-08-27T09:00:00.000Z",
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
    if (path.endsWith("/admissions")) return { items: admissions };
    if (path.endsWith("/medications/active")) return { orders: [] };
    if (path.startsWith("/api/v1/terminology/rxnorm/search"))
      return { results: [], mode: "prefix", asOf: null };
    if (path === "/api/v1/terminology/rxnorm/search")
      return { results: [], mode: "prefix", asOf: null };
    if (path.includes("/terminology/rxnorm/") && path.split("/").length > 5)
      return {
        systemId: "rxnorm",
        code: RXCUI,
        display: "Morphine Sulfate 20 MG/ML Oral Solution",
        status: "active",
        effectiveDate: "2020-01-01",
        endDate: null,
        properties: { tty: "SCD", ingredientRxcui: "7052", ndcs: ["00054023549", "00054023599"] },
      };
    if (path.includes("/terminology/value-sets/")) return { items: [], nextCursor: null };
    if (path.endsWith("/controlled-substance-policy"))
      return {
        scheduleIiMaxRefills: 0,
        scheduleIiiToVMaxRefills: 5,
        epcsCertificationStatus: epcsStatus,
      };
    if (path.startsWith("/api/v1/refills/"))
      return {
        id: REFILL,
        status: refillStatus,
        sourceMedicationOrderId: ORDER,
        requestedAt: "2026-08-27T08:00:00.000Z",
        prescriberMembershipId: "membership-1",
        resultingMedicationOrderId: null,
      };
    if (path.startsWith("/api/v1/medication-orders")) {
      if (path === "/api/v1/medication-orders") return { orders: [] };
      return order();
    }
  }
  if (path.includes("/refills/")) return { id: REFILL };
  return order();
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, method } = requestOf(input, init);
  const parsed = new URL(url, "http://localhost");
  const path = parsed.pathname;
  calls.push(`${method} ${path}`);
  if (method !== "GET") {
    const req = typeof input === "object" && "clone" in input ? (input as Request) : null;
    const raw = req ? await req.clone().text() : typeof init?.body === "string" ? init.body : "";
    if (raw) {
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // Every M12 write sends JSON; recording nothing is honest if one ever does not.
      }
    }
    if (writeFailure) {
      return new Response(JSON.stringify(writeFailure.body), {
        status: writeFailure.status,
        headers: { "content-type": "application/json" },
      });
    }
  }
  // The search is answered from the query so the picker can be driven end to end.
  if (method === "GET" && path === "/api/v1/terminology/rxnorm/search") {
    const q = parsed.searchParams.get("q") ?? "";
    return new Response(
      JSON.stringify({
        results: q.toLowerCase().startsWith("morph")
          ? [
              {
                systemId: "rxnorm",
                code: RXCUI,
                display: "Morphine Sulfate 20 MG/ML Oral Solution",
                status: "active",
                effectiveDate: "2020-01-01",
                endDate: null,
              },
            ]
          : [],
        mode: "prefix",
        asOf: null,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
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
  roles: ["hospice_physician"],
  permissions: [],
  isAdmin: false,
};

function mount(path: string, element: JSX.Element, route: string): ReturnType<typeof render> {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={route} element={element} />
              <Route path="*" element={<div>navigated</div>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  ) as unknown as ReturnType<typeof render>;
}

const mountChart = () =>
  mount(
    `/patients/${PATIENT}/medications`,
    <PatientMedications />,
    "/patients/:patientId/medications",
  );
const mountOrder = () =>
  mount(`/medication-orders/${ORDER}`, <MedicationDetail />, "/medication-orders/:id");
const mountRefill = () => mount(`/refills/${REFILL}`, <RefillDetail />, "/refills/:id");

const writes = () => calls.filter((c) => !c.startsWith("GET "));

beforeEach(() => {
  calls = [];
  bodies = [];
  writeFailure = null;
  orderStatus = "pending_signature";
  refillStatus = "pending";
  epcsStatus = "not_certified";
  admissions = [
    { id: ADMISSION, state: "active", admissionAt: "2026-08-01T00:00:00.000Z", dischargedAt: null },
  ];
});
afterEach(() => {
  writeFailure = null;
});

describe("#91 — a prescription can be written", () => {
  it("Prescribe is offered only when the patient has an OPEN admission to document against", async () => {
    // F-065: `POST /medication-orders` requires `admissionId` and nothing could resolve one for a
    // patient until this read existed. With none, the control is absent rather than certain to fail.
    admissions = [];
    const { unmount } = mountChart();
    await waitFor(() => expect(calls).toContain(`GET /api/v1/patients/${PATIENT}/admissions`));
    expect(screen.queryByRole("button", { name: "Prescribe" })).toBeNull();
    unmount();

    calls = [];
    admissions = [
      {
        id: ADMISSION,
        state: "active",
        admissionAt: "2026-08-01T00:00:00.000Z",
        dischargedAt: null,
      },
    ];
    mountChart();
    expect(await screen.findByRole("button", { name: "Prescribe" })).toBeTruthy();
  });

  it("a discharged-only patient is not prescribable — the admission must be open", async () => {
    admissions = [
      {
        id: ADMISSION,
        state: "discharged",
        admissionAt: "2026-01-01T00:00:00.000Z",
        dischargedAt: "2026-06-01T00:00:00.000Z",
      },
    ];
    mountChart();
    await waitFor(() => expect(calls).toContain(`GET /api/v1/patients/${PATIENT}/admissions`));
    expect(screen.queryByRole("button", { name: "Prescribe" })).toBeNull();
  });

  it("the drug identity comes from M38's RxNorm search and the concept's own NDCs, never typed", async () => {
    mountChart();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Prescribe" })));
    fireEvent.change(await waitFor(() => screen.getByLabelText(/Find a drug/i)), {
      target: { value: "morphine" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(
      await waitFor(() => screen.getByText("Morphine Sulfate 20 MG/ML Oral Solution")),
    );
    // The NDC options are the resolved concept's `properties.ndcs` — no field asks for one.
    const ndc = await waitFor(() => screen.getByLabelText(/NDC/i));
    expect((ndc as HTMLSelectElement).value).toBe("00054023549");
    expect(calls).toContain(`GET /api/v1/terminology/rxnorm/${RXCUI}`);
  });

  it("the sig lands under data.sigStructured — the only part of `data` anything downstream reads", async () => {
    mountChart();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Prescribe" })));
    fireEvent.change(await waitFor(() => screen.getByLabelText(/Find a drug/i)), {
      target: { value: "morphine" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(
      await waitFor(() => screen.getByText("Morphine Sulfate 20 MG/ML Oral Solution")),
    );
    fireEvent.change(await waitFor(() => screen.getByLabelText(/^Strength$/i)), {
      target: { value: "20 mg/mL" },
    });
    fireEvent.change(screen.getByLabelText(/^Dose form$/i), { target: { value: "Oral Solution" } });
    fireEvent.change(screen.getByLabelText(/^Dose$/i), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText(/^Route$/i), { target: { value: "Oral" } });
    fireEvent.change(screen.getByLabelText(/Ordering physician/i), { target: { value: "mdm-1" } });
    fireEvent.change(screen.getByLabelText(/^Frequency$/i), { target: { value: "PRN" } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    await waitFor(() => expect(writes()).toContain("POST /api/v1/medication-orders"));
    const sent = bodies[0] as { data: { sigStructured: Record<string, unknown> } };
    expect(sent.data.sigStructured.doseQuantity).toBe(5);
    expect(sent.data.sigStructured.route).toBe("Oral");
    expect(sent.data.sigStructured.frequencyCode).toBe("PRN");
    // PRN is not a frequency the eMAR schedules against — it must be flagged as as-needed.
    expect(sent.data.sigStructured.asNeeded).toBe(true);
    expect((bodies[0] as Record<string, unknown>).rxnormRxcui).toBe(RXCUI);
    expect((bodies[0] as Record<string, unknown>).ndc).toBe("00054023549");
  });

  it("controlled substances are not offered while the agency is not EPCS-certified", async () => {
    // §2.4/D18: `requestSignature` refuses a controlled order outright, so a draft created here could
    // never be signed, completed or discontinued. The availability is READ, not assumed.
    mountChart();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Prescribe" })));
    fireEvent.change(await waitFor(() => screen.getByLabelText(/Find a drug/i)), {
      target: { value: "morphine" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(
      await waitFor(() => screen.getByText("Morphine Sulfate 20 MG/ML Oral Solution")),
    );
    const select = (await waitFor(() => screen.getByLabelText(/^Class$/i))) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["standard", "compounded"]);
    expect(await screen.findByText(/not DEA EPCS-certified/i)).toBeTruthy();
  });

  it("and ARE offered once the server says the agency is certified", async () => {
    epcsStatus = "certified";
    mountChart();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Prescribe" })));
    fireEvent.change(await waitFor(() => screen.getByLabelText(/Find a drug/i)), {
      target: { value: "morphine" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.click(
      await waitFor(() => screen.getByText("Morphine Sulfate 20 MG/ML Oral Solution")),
    );
    const select = (await waitFor(() => screen.getByLabelText(/^Class$/i))) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toContain("controlled_substance");
  });
});

describe("#91 — the lifecycle ceremonies the queues exist for", () => {
  it("a pending_signature order offers Sign, and signing sends the discipline as provenance", async () => {
    mountOrder();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Sign" })));
    fireEvent.click(
      await waitFor(() => screen.getAllByRole("button", { name: "Sign" })[1] as HTMLElement),
    );
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/medication-orders/${ORDER}/sign`));
    // The caller holds exactly one prescribing role, so it is preselected rather than asked for.
    expect(bodies[0]?.signerDiscipline).toBe("hospice_physician");
    expect(typeof bodies[0]?.signedAtClient).toBe("string");
  });

  it("an ACTIVE order offers discontinue and complete — and neither before it is active (#136)", async () => {
    orderStatus = "signed";
    const { unmount } = mountOrder();
    await waitFor(() => expect(screen.getAllByText(/Morphine/).length).toBeGreaterThan(0));
    // `complete` and `discontinue` are legal only from `active`; a signed order that never activates
    // was the frozen state #136 fixed.
    expect(screen.queryByRole("button", { name: "Discontinue" })).toBeNull();
    unmount();

    orderStatus = "active";
    mountOrder();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Discontinue" })));
    fireEvent.click(
      await waitFor(() => screen.getAllByRole("button", { name: "Discontinue" })[1] as HTMLElement),
    );
    await waitFor(() =>
      expect(writes()).toContain(`POST /api/v1/medication-orders/${ORDER}/discontinue`),
    );
    expect(bodies[0]?.reason).toBe("clinical_judgement");
  });

  it("a SIGN_REQUIRES_EPCS refusal names the EPCS path rather than reading as a generic error", async () => {
    writeFailure = {
      status: 422,
      body: { error: { code: "SIGN_REQUIRES_EPCS", message: "controlled" } },
    };
    mountOrder();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Sign" })));
    fireEvent.click(
      await waitFor(() => screen.getAllByRole("button", { name: "Sign" })[1] as HTMLElement),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(/EPCS path/i);
  });
});

describe("#91 — the refill decision the inbox exists for", () => {
  it("Approve sends the authorised count and the response channel", async () => {
    mountRefill();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Approve" })));
    fireEvent.click(
      await waitFor(() => screen.getAllByRole("button", { name: "Approve" })[1] as HTMLElement),
    );
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/refills/${REFILL}/approve`));
    expect(bodies[0]?.refillsAuthorized).toBe(1);
    expect(bodies[0]?.responseChannel).toBe("dosespot");
  });

  it("Deny requires the reason the pharmacy is told", async () => {
    mountRefill();
    fireEvent.click(await waitFor(() => screen.getByRole("button", { name: "Deny" })));
    const submit = await waitFor(
      () => screen.getAllByRole("button", { name: "Deny" })[1] as HTMLButtonElement,
    );
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason/i), {
      target: { value: "Patient is now on a comfort kit; this order is superseded." },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Deny" })[1] as HTMLElement);
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/refills/${REFILL}/deny`));
    expect(bodies[0]?.denialReason).toBe(
      "Patient is now on a comfort kit; this order is superseded.",
    );
  });

  it("a decided refill offers no decision at all", async () => {
    refillStatus = "approved";
    mountRefill();
    await waitFor(() => expect(calls).toContain(`GET /api/v1/refills/${REFILL}`));
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });
});
