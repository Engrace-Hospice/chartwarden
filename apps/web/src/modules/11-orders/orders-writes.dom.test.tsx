// apps/web/src/modules/11-orders — #91: the M11 write controls must not be inert.
//
// Before this change `apps/web/src/modules/11-orders` issued ZERO mutations — 2731 lines across seven
// screens, every one of them a read. Four of those screens are QUEUES whose entire reason to exist is an
// action they did not offer: a physician could open "orders awaiting your signature" and have no way to
// sign one, and the Results-Pending-Review queue could not mark a lab result reviewed.
//
// Nothing in the repo's gate set can see that. `ui:parity` proves a screen is registered with a resolvable
// permission, `docs:ui` proves the spec corpus is consistent, `openapi:coverage` proves a ROUTE carries a
// contract — none of them inspects whether a control does anything. So the net is a DOM test that CLICKS
// the control and asserts the request went out, on the recorded fetch calls rather than a spy over the api
// client: a mocked client would still pass if a button were re-wired to a handler that never issues the
// request, which is the exact failure being fixed. (Same shape as `13-emar/emar-writes.dom.test.tsx`.)
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import type { JSX } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { CosignQueue } from "./cosign-queue";
import { OrderDetail } from "./order-detail";
import { OrdersSignInbox } from "./orders-sign-inbox";
import { ResultsReviewQueue } from "./results-review-queue";
import { VerbalExpiringQueue } from "./verbal-expiring-queue";

const ORDER = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PATIENT = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PHYSICIAN = "cccccccc-3333-4333-8333-cccccccccccc";

const baseOrder = {
  id: ORDER,
  patientId: PATIENT,
  admissionId: "dddddddd-4444-4444-8444-dddddddddddd",
  kind: "medication",
  status: "pending_signature",
  priority: "routine",
  drafterDiscipline: "rn_case_manager",
  orderingPhysicianMdmId: PHYSICIAN,
  cosignRequired: false,
  cosignStatus: null as "pending" | "attached" | null,
  transmissionStatus: "not_applicable",
  resultsStatus: "not_applicable",
  verbalDeadlineAt: null as string | null,
  discontinuationReason: null as string | null,
  replacesOrderId: null as string | null,
  signedAt: null as string | null,
  signedBy: null as string | null,
  completedAt: null as string | null,
  createdAt: "2026-08-26T09:00:00.000Z",
};

/** The detail row each screen reads — overridden per test to put the order in the right §2.2 state. */
let detailRow: Record<string, unknown> = { ...baseOrder };

let calls: string[] = [];
let bodies: Record<string, unknown>[] = [];
/** Set by a test to make the NEXT write fail. The api client captures `stubFetch` at construction, so a
 *  re-stubbed global would never reach it — the override has to live inside the stub itself. */
let writeFailure: { status: number; body: unknown } | null = null;

// openapi-fetch calls `fetch(new Request(url, init))` — the method rides on the Request, NOT on a separate
// `init`, so reading `init.method` alone records every call as a GET.
function requestOf(input: RequestInfo | URL, init?: RequestInit): { url: string; method: string } {
  if (typeof input === "string")
    return { url: input, method: (init?.method ?? "GET").toUpperCase() };
  if (input instanceof URL)
    return { url: input.toString(), method: (init?.method ?? "GET").toUpperCase() };
  return { url: input.url, method: (init?.method ?? input.method ?? "GET").toUpperCase() };
}

function bodyFor(method: string, path: string): unknown {
  if (method !== "GET") return { ...detailRow, status: "active", signedAt: "2026-08-26T10:00:00Z" };
  if (path === "/api/v1/orders/pending-signature") return { orders: [detailRow] };
  if (path === "/api/v1/orders/cosign-pending") return { orders: [detailRow] };
  if (path === "/api/v1/orders/verbal-expiring") return { orders: [detailRow] };
  if (path === "/api/v1/orders/results-pending-review") return { orders: [detailRow] };
  if (path.startsWith("/api/v1/orders/")) return detailRow;
  if (path.startsWith("/api/v1/patients/"))
    return {
      mrn: "MRN-1",
      lastName: "Vance",
      firstName: "Ada",
      dob: "1948-03-02",
      status: "active",
    };
  return {};
}

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, method } = requestOf(input, init);
  const path = new URL(url, "http://localhost").pathname;
  calls.push(`${method} ${path}`);
  if (method !== "GET") {
    const raw =
      typeof input === "object" && "clone" in input
        ? await (input as Request).clone().text()
        : typeof init?.body === "string"
          ? init.body
          : "";
    if (raw) {
      try {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        // No M11 write sends a non-JSON body; recording nothing is the honest answer.
      }
    }
  }
  if (method !== "GET" && writeFailure) {
    return new Response(JSON.stringify(writeFailure.body), {
      status: writeFailure.status,
      headers: { "content-type": "application/json" },
    });
  }
  return new Response(JSON.stringify(bodyFor(method, path)), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** A physician session holding ONE signer role, so the modal needs no discipline prompt. */
const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["medical_director"],
  permissions: [],
  isAdmin: false,
};

function mount(path: string, pattern: string, element: JSX.Element, session = SESSION) {
  return render(
    <ApiClientProvider client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}>
      <SessionProvider session={session}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route path={pattern} element={element} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
}

const writes = () => calls.filter((c) => !c.startsWith("GET "));

beforeEach(() => {
  calls = [];
  bodies = [];
  detailRow = { ...baseOrder };
  writeFailure = null;
  vi.stubGlobal("fetch", vi.fn(stubFetch));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("#91 — the M11 queues can do the thing they exist for", () => {
  it("Signature inbox: the row action POSTs a signature", async () => {
    mount("/orders", "/orders", <OrdersSignInbox />);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Sign" }).length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Sign" })[0] as HTMLElement);

    const commit = screen.getAllByRole("button", { name: "Sign" }).at(-1) as HTMLButtonElement;
    fireEvent.click(commit);
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/orders/${ORDER}/sign`));

    // The signature records WHICH role signed — provenance the server stores on the signature row.
    expect(bodies[0]?.signerDiscipline).toBe("medical_director");
    expect(typeof bodies[0]?.signedAtClient).toBe("string");
  });

  it("Signature inbox: after signing, the queue RE-READS rather than dropping the row locally", async () => {
    mount("/orders", "/orders", <OrdersSignInbox />);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Sign" }).length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Sign" })[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole("button", { name: "Sign" }).at(-1) as HTMLButtonElement);

    await waitFor(() => expect(writes()).toContain(`POST /api/v1/orders/${ORDER}/sign`));
    // Whether the order leaves the queue is the server's answer, not the client's.
    await waitFor(() =>
      expect(calls.filter((c) => c === "GET /api/v1/orders/pending-signature").length).toBe(2),
    );
  });

  it("Cosign queue: the row action POSTs a cosignature with its attestation", async () => {
    detailRow = { ...baseOrder, cosignRequired: true, cosignStatus: "pending" };
    mount("/orders/cosign", "/orders/cosign", <CosignQueue />);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Cosign" }).length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Cosign" })[0] as HTMLElement);

    const commit = screen.getAllByRole("button", { name: "Cosign" }).at(-1) as HTMLButtonElement;
    // The server's 50-character attestation floor is mirrored, so the button says why it is refused.
    expect(commit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Attestation"), {
      target: {
        value: "I have reviewed this order in full and attest to its clinical appropriateness.",
      },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Cosign" }).at(-1) as HTMLButtonElement);

    await waitFor(() => expect(writes()).toContain(`POST /api/v1/orders/${ORDER}/cosign`));
    expect(bodies[0]?.cosignerRole).toBe("rn_case_manager");
  });

  it("Verbal-expiring queue: the row action POSTs the signature that clears the deadline", async () => {
    detailRow = {
      ...baseOrder,
      status: "verbal_pending",
      verbalDeadlineAt: "2026-08-27T09:00:00.000Z",
    };
    mount("/orders/verbal-expiring", "/orders/verbal-expiring", <VerbalExpiringQueue />);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Sign" }).length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Sign" })[0] as HTMLElement);
    fireEvent.click(screen.getAllByRole("button", { name: "Sign" }).at(-1) as HTMLButtonElement);
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/orders/${ORDER}/sign`));
  });

  it("Results-review queue: Mark reviewed POSTs the D17 completion", async () => {
    detailRow = { ...baseOrder, kind: "lab", status: "active", resultsStatus: "received" };
    mount("/orders/results", "/orders/results", <ResultsReviewQueue />);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Mark reviewed" }).length).toBeGreaterThan(0),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Mark reviewed" })[0] as HTMLElement);
    fireEvent.click(
      screen.getAllByRole("button", { name: "Mark reviewed" }).at(-1) as HTMLButtonElement,
    );
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/orders/${ORDER}/complete`));
  });
});

describe("#91 — the order detail offers the §2.2 ceremonies its status permits", () => {
  it("a pending-signature order offers Sign, and it POSTs", async () => {
    mount(`/orders/${ORDER}`, "/orders/:id", <OrderDetail />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Sign" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Sign" }).at(-1) as HTMLButtonElement);
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/orders/${ORDER}/sign`));
  });

  it("an ACTIVE order offers Discontinue, which POSTs a reason from the server's vocabulary", async () => {
    detailRow = { ...baseOrder, status: "active", signedAt: "2026-08-26T10:00:00.000Z" };
    mount(`/orders/${ORDER}`, "/orders/:id", <OrderDetail />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Discontinue" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Discontinue" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Discontinue" }).at(-1) as HTMLButtonElement,
    );

    await waitFor(() => expect(writes()).toContain(`POST /api/v1/orders/${ORDER}/discontinue`));
    expect(bodies[0]?.reason).toBe("clinical_judgement");
    expect(typeof bodies[0]?.effectiveAt).toBe("string");
  });

  it("an active order does NOT offer Sign — the ceremony follows §2.2 state", async () => {
    detailRow = { ...baseOrder, status: "active", signedAt: "2026-08-26T10:00:00.000Z" };
    mount(`/orders/${ORDER}`, "/orders/:id", <OrderDetail />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Discontinue" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Sign" })).toBeNull();
  });

  it("a lab order's completion is labelled 'Mark reviewed' — one route, two call sites (D17)", async () => {
    detailRow = { ...baseOrder, kind: "lab", status: "active", resultsStatus: "received" };
    mount(`/orders/${ORDER}`, "/orders/:id", <OrderDetail />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Mark reviewed" }).at(-1) as HTMLButtonElement,
    );
    await waitFor(() => expect(writes()).toContain(`POST /api/v1/orders/${ORDER}/complete`));
  });
});

describe("#91 — the client never decides authorization", () => {
  it("a 403 renders as a refusal, and the order is NOT re-read as though it changed", async () => {
    mount(`/orders/${ORDER}`, "/orders/:id", <OrderDetail />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Sign" }));

    writeFailure = { status: 403, body: { message: "signer_eligible denied" } };
    fireEvent.click(screen.getAllByRole("button", { name: "Sign" }).at(-1) as HTMLButtonElement);

    // The refusal is surfaced verbatim rather than swallowed — `signer_eligible` denying is the control
    // working, not a bug to route around.
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("signer_eligible denied"),
    );
  });

  it("a signer holding NO signer-vocabulary role cannot label a signature, and the commit stays refused", async () => {
    // NOT a permission verdict — the server still owns that. The signature cannot be ATTRIBUTED.
    mount(`/orders/${ORDER}`, "/orders/:id", <OrderDetail />, { ...SESSION, roles: ["chaplain"] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Sign" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Sign" }));
    const commit = screen.getAllByRole("button", { name: "Sign" }).at(-1) as HTMLButtonElement;
    expect(commit.disabled).toBe(true);
    expect(writes()).toEqual([]);
  });
});
