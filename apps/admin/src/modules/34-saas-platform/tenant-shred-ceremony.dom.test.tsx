// apps/admin/src/modules/34-saas-platform — #29: the cryptographic shred must actually shred, and
// must never claim it did when it didn't.
//
// The ceremony sent `destructionCertificateId: ""` against a route that requires
// `format: "uuid"`, then discarded the result: `await client.POST(...)` with no error check,
// followed unconditionally by `setShredOpen(false); void load();`. So every shred was rejected with
// a 400 and the console closed the dialog as though it had succeeded.
//
// The operator could not tell. A SUCCESSFUL shred returns 202 and merely ENQUEUES `tenant.shred`,
// leaving the tenant in `destruction_pending` — which is exactly what a failure leaves behind. The
// one signal that distinguished them was the one being thrown away.
//
// These cases assert the two properties that matter: no request may ever carry an invalid
// certificate id, and a refusal must remain visible to the operator.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiClientProvider, ToastProvider, createApiClient } from "@wardenx/ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TenantOverview } from "./tenant-overview";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LEGAL_NAME = "Cedar Ridge Hospice LLC";
const CERT = "9f1c2b3a-4d5e-4f60-8a71-2b3c4d5e6f70";

const TENANT = {
  id: "t-1",
  organizationId: "o-1",
  orgSlug: "cedar-ridge",
  legalBusinessName: LEGAL_NAME,
  // The shred CTA only renders in this state — the moment the destruction is meant to be carried out.
  status: "destruction_pending",
  planLabel: "Enterprise",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  latestStatusEvent: null,
  keyRing: { currentDekVersion: "v3", dekLastRotatedAt: null, destroyedAt: null },
  onboarding: { totalTasks: 4, doneTasks: 4, currentStep: null },
  baa: { status: "active", expiresOn: null },
  activeGrants: 0,
  activeSessions: 0,
};

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
let calls: Recorded[] = [];

/** openapi-fetch calls `fetch(new Request(url, init))`, so method AND body ride on the Request —
 *  reading only `init.body` records every call as a bodyless GET. The Request body is a stream, so
 *  it is cloned and awaited rather than read off the object. */
async function record(input: RequestInfo | URL, init?: RequestInit): Promise<Recorded> {
  const isRequest = typeof input === "object" && input !== null && "url" in input;
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = (
    init?.method ?? (isRequest ? (input as Request).method : "GET") ?? "GET"
  ).toUpperCase();
  let raw: string | null = null;
  if (typeof init?.body === "string") raw = init.body;
  else if (isRequest) {
    try {
      raw = await (input as Request).clone().text();
    } catch {
      raw = null;
    }
  }
  let body: Record<string, unknown> | null = null;
  if (raw) {
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = null;
    }
  }
  return { method, path: new URL(url, "http://localhost").pathname, body };
}

function makeFetch(shredStatus: number) {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = await record(input, init);
    calls.push(call);
    if (call.path.endsWith("/shred") && shredStatus >= 400) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ error: { code: "VALIDATION_FAILED", message: "destruction certificate is not approved" } }),
          { status: shredStatus, headers: { "content-type": "application/json" } },
        ),
      );
    }
    const payload = call.method === "GET" ? TENANT : { accepted: true };
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: call.method === "GET" ? 200 : 202,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

function mount(shredStatus = 202) {
  window.history.pushState({}, "", "/tenants/cedar-ridge");
  return render(
    <ApiClientProvider
      client={createApiClient({ baseUrl: "http://localhost", fetch: makeFetch(shredStatus) })}
    >
      <ToastProvider>
        <TenantOverview />
      </ToastProvider>
    </ApiClientProvider>,
  );
}

/** Open the ceremony and complete the parts that existed BEFORE this fix. */
async function openCeremonyAndAffirm(): Promise<void> {
  await waitFor(() => expect(screen.getByText(LEGAL_NAME)).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: /Cryptographic shred/i }));
  fireEvent.click(await screen.findByRole("checkbox"));
  fireEvent.change(screen.getByLabelText(/Type the legal business name/i), {
    target: { value: LEGAL_NAME },
  });
}

const shredPosts = (): Recorded[] => calls.filter((c) => c.path.endsWith("/shred") && c.method === "POST");

beforeEach(() => {
  calls = [];
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("#29 — the tenant cryptographic shred", () => {
  it("NEVER sends an invalid destructionCertificateId, however the ceremony is completed", async () => {
    // The invariant, stated directly. The old build completed this exact sequence and POSTed
    // `destructionCertificateId: ""`.
    mount();
    await openCeremonyAndAffirm();
    fireEvent.click(screen.getByRole("button", { name: /Shred tenant key/i }));
    await new Promise((r) => setTimeout(r, 50));

    for (const post of shredPosts()) {
      expect(
        String(post.body?.destructionCertificateId ?? ""),
        "a shred was submitted with an id the route rejects — it can never succeed",
      ).toMatch(UUID_RE);
    }
  });

  it("refuses to submit AND tells the operator when the certificate id is missing", async () => {
    mount();
    await openCeremonyAndAffirm();
    fireEvent.click(screen.getByRole("button", { name: /Shred tenant key/i }));

    // Told, not silently ignored.
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent ?? "").toMatch(/destruction-certificate id/i);
    // ...and nothing was sent.
    expect(shredPosts()).toHaveLength(0);
  });

  it("submits the operator's certificate id and reason when both are valid", async () => {
    mount();
    await openCeremonyAndAffirm();
    fireEvent.change(screen.getByLabelText(/destruction-certificate id/i), {
      target: { value: CERT },
    });
    fireEvent.change(screen.getByLabelText(/Transition reason/i), {
      target: { value: "Retention elapsed; BAA terminated 2026-08-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Shred tenant key/i }));

    await waitFor(() => expect(shredPosts()).toHaveLength(1));
    const post = shredPosts()[0];
    expect(post?.body?.destructionCertificateId).toBe(CERT);
    expect(String(post?.body?.transitionReason ?? "").length).toBeGreaterThanOrEqual(8);
  });

  it("a REFUSED shred keeps the ceremony open with the server's reason visible", async () => {
    // The heart of #29: the old build closed the dialog on failure, so a refusal was indistinguishable
    // from the 202-enqueued success path.
    mount(400);
    await openCeremonyAndAffirm();
    fireEvent.change(screen.getByLabelText(/destruction-certificate id/i), {
      target: { value: CERT },
    });
    fireEvent.change(screen.getByLabelText(/Transition reason/i), {
      target: { value: "Retention elapsed; BAA terminated 2026-08-01" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Shred tenant key/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent ?? "").toMatch(/destruction certificate is not approved/i);
    // The ceremony must still be on screen — closing it is the false confirmation.
    expect(screen.getByRole("button", { name: /Shred tenant key/i })).toBeTruthy();
  });

  it("a mismatched typed name is reported, not silently ignored", async () => {
    mount();
    await waitFor(() => expect(screen.getByText(LEGAL_NAME)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Cryptographic shred/i }));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.change(screen.getByLabelText(/Type the legal business name/i), {
      target: { value: "Some Other Hospice" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Shred tenant key/i }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.getByRole("alert").textContent ?? "").toMatch(/does not match/i);
    expect(shredPosts()).toHaveLength(0);
  });
});
