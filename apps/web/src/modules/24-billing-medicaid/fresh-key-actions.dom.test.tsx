// Medicaid actions whose every click means "do it now, against the current state" (an eligibility check asks the payer, a sandbox test probes
// the credential, a validation run checks the claim): each click carries its own Idempotency-Key, never the API client's per-intent key
// (a replay of an earlier lost-reply answer would be stale).
import { ApiClientProvider, ToastProvider, createApiClient } from "@chartwarden/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { JSX } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { SessionProvider } from "../../shell/session";
import { MedicaidClaimWorkbench } from "./claim-workbench";
import { MedicaidEligibilityCenter } from "./eligibility-center";
import { MedicaidTradingPartnerCredentials } from "./trading-partner-credentials";

// The lookups search the API; the screen only needs the id they choose.
vi.mock("../../shell/entity-lookups", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../shell/entity-lookups")>();
  const Lookup = ({
    label,
    value,
    onChange,
  }: { label: string; value: string; onChange: (value: string) => void }): JSX.Element => (
    <input aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />
  );
  return { ...original, PatientLookupField: Lookup, PatientPayerLookupField: Lookup };
});

const PATIENT = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const PAYER = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SESSION = {
  userId: "user-1",
  organizationId: "org-1",
  membershipId: "membership-1",
  roles: ["biller"],
  permissions: [],
  isAdmin: true,
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** A real client over a stubbed fetch: GETs answer `reads`, and every POST's Idempotency-Key is recorded. */
function mount(element: JSX.Element, reads: (path: string) => unknown) {
  const posts: { path: string; key: string | null }[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost",
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") {
        posts.push({ path, key: request.headers.get("Idempotency-Key") });
        return json({ ok: true });
      }
      return json(reads(path));
    },
  });
  render(
    <ApiClientProvider client={client}>
      <SessionProvider session={SESSION}>
        <ToastProvider>
          <MemoryRouter>{element}</MemoryRouter>
        </ToastProvider>
      </SessionProvider>
    </ApiClientProvider>,
  );
  return posts;
}

function expectOwnKeys(posts: { key: string | null }[]): void {
  expect(posts).toHaveLength(2);
  expect(posts[0]?.key).toBeTruthy();
  expect(posts[1]?.key).toBeTruthy();
  expect(posts[1]?.key).not.toBe(posts[0]?.key);
}

describe("Medicaid re-run actions", () => {
  it("the eligibility check sends its own Idempotency-Key on every click", async () => {
    const posts = mount(<MedicaidEligibilityCenter />, () => []);
    fireEvent.change(await screen.findByLabelText("Patient"), { target: { value: PATIENT } });
    fireEvent.change(screen.getByLabelText("Patient payer"), { target: { value: PAYER } });
    fireEvent.change(screen.getByLabelText("As of service date"), {
      target: { value: "2026-11-09" },
    });

    for (const nth of [1, 2]) {
      fireEvent.click(await screen.findByRole("button", { name: "Refresh eligibility" }));
      await waitFor(() => expect(posts).toHaveLength(nth));
    }

    expectOwnKeys(posts);
  });

  it("the sandbox test of a credential sends its own Idempotency-Key on every click", async () => {
    const posts = mount(<MedicaidTradingPartnerCredentials />, () => [
      {
        id: "cccccccc-3333-4333-8333-cccccccccccc",
        providerEntityId: "dddddddd-4444-4444-8444-dddddddddddd",
        serviceState: "OR",
        channel: "sftp",
        mcoId: null,
        tradingPartnerId: "TP-1",
        clientId: null,
        sftpHost: null,
        portalUrl: null,
        activeFrom: "2026-01-01",
        activeTo: null,
        lastSandboxTestAt: null,
        lastSandboxTestResult: null,
        hasClientSecret: true,
        hasSftpKey: false,
      },
    ]);

    for (const nth of [1, 2]) {
      fireEvent.click(await screen.findByRole("button", { name: /Run sandbox test for OR TP-1/ }));
      await waitFor(() => expect(posts).toHaveLength(nth));
      await screen.findByRole("button", { name: /Run sandbox test for OR TP-1/ }); // settled again
    }

    expectOwnKeys(posts);
  });

  it("Validate now sends its own Idempotency-Key on every click", async () => {
    const posts = mount(<MedicaidClaimWorkbench />, () => ({
      items: [
        {
          id: "eeeeeeee-5555-4555-8555-eeeeeeeeeeee",
          patientId: PATIENT,
          serviceState: "OR",
          kind: "hospice_only",
          tob: "811",
          serviceFrom: "2026-10-01",
          serviceTo: "2026-10-31",
          mcoId: null,
          medicaidClaimControlNumber: "MCN-1",
          state: "READY",
          version: 1,
          updatedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
      nextCursor: null,
      hasMore: false,
    }));
    for (const nth of [1, 2]) {
      // The queue reloads after a run, which clears the selection: select the claim again.
      const box = (await screen.findByLabelText("Select claim MCN-1")) as HTMLInputElement;
      if (!box.checked) fireEvent.click(box);
      fireEvent.click(await screen.findByRole("button", { name: "Validate now" }));
      await waitFor(() => expect(posts).toHaveLength(nth));
      await screen.findByText("No claims selected"); // the reload that follows a run has finished
    }

    expectOwnKeys(posts);
  });
});
