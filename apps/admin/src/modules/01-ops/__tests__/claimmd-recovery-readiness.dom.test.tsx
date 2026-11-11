import { ApiClientProvider, createApiClient } from "@chartwarden/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ClaimMdRecoveryReadiness } from "../claimmd-recovery-readiness";

const INBOX = "20000000-0000-4000-8000-000000005501";
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function stubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = input instanceof Request ? input : new Request(String(input), init);
  const path = new URL(request.url).pathname;
  if (path.endsWith("/observability"))
    return json({
      scope: "central_claimmd_account",
      accountReferenceExposed: false,
      usage: "test",
      responses: {},
      eras: {},
      requestBudget: { status: "unavailable" },
      workerHeartbeat: { status: "unavailable" },
      sampledAt: "2026-11-11T10:00:00Z",
    });
  if (path.includes("recovery-preflight") || path.includes("recovery-dry-run"))
    return json({
      inboxId: INBOX,
      usage: "test",
      stage: "capture",
      currentState: "retryable_failure",
      currentVersion: 5,
      sourceDigestPresent: false,
      tenantAttribution: "unattributed",
      leaseActive: false,
      priorRecoveryAttempts: 0,
      disposition: "eligible_for_simulation",
      blockers: [],
      financialEffects: {
        status: "not_evaluated",
        reasonCode: "PREFLIGHT_DOES_NOT_AUTHORIZE_FINANCIAL_REPROCESSING",
      },
      simulation: {
        available: true,
        mutatesSource: false,
        callsVendor: false,
        authorizesExecution: false,
      },
      assessedAt: "2026-11-11T10:00:00Z",
    });
  return new Response(null, { status: 404 });
}

afterEach(cleanup);

describe("Claim.MD recovery readiness", () => {
  it("runs a clearly nonmutating dry-run and never renders an execution action", async () => {
    render(
      <ApiClientProvider
        client={createApiClient({ baseUrl: "http://localhost", fetch: stubFetch })}
      >
        <ClaimMdRecoveryReadiness />
      </ApiClientProvider>,
    );
    expect(await screen.findByText("Durable source health")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("ERA inbox ID"), { target: { value: INBOX } });
    fireEvent.click(screen.getByRole("button", { name: "Run nonmutating dry-run" }));
    expect(await screen.findByText("eligible for simulation")).toBeTruthy();
    expect(screen.getByText(/cannot be used as execution authorization/i)).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /execute|replay|recover now/i })).toBeNull(),
    );
  });
});
