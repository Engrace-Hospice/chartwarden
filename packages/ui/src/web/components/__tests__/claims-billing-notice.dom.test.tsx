// ADR-0108 — the shared ClaimsBillingNotice / useClaimsBilling: hidden when entitled or unknown, a warning (and
// `blocked`) only when the server enforces, an info line in shadow, and a 402 refusal flips every reader at once.
import { act, cleanup, render, screen } from "@testing-library/react";
import type { JSX } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createApiClient } from "../../../core/api/client";
import { ApiClientProvider } from "../../../core/api/provider";
import {
  CLAIMS_BILLING_POSTURE_TTL_MS,
  ClaimsBillingNotice,
  __resetClaimsBillingForTest,
  claimsBillingRefusalReason,
  noteClaimsBillingRefusal,
  primeClaimsBilling,
  useClaimsBilling,
} from "../claims-billing-notice";

function Probe(): JSX.Element {
  const { blocked } = useClaimsBilling();
  return (
    <>
      <ClaimsBillingNotice />
      <button type="button" disabled={blocked}>
        Submit claim
      </button>
    </>
  );
}

function mount(claimsBilling: unknown, status = 200): void {
  const fetchStub = async (): Promise<Response> =>
    new Response(JSON.stringify(status === 200 ? { status: "active", claimsBilling } : {}), {
      status,
      headers: { "content-type": "application/json" },
    });
  primeClaimsBilling(createApiClient({ baseUrl: "http://localhost", fetch: fetchStub }));
  render(<Probe />);
}

/** A client whose status read answers each posture in turn (one per GET). */
function sequenceClient(...postures: unknown[]) {
  let i = 0;
  const fetchStub = async (): Promise<Response> =>
    new Response(JSON.stringify({ status: "active", claimsBilling: postures[i++] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return {
    client: createApiClient({ baseUrl: "http://localhost", fetch: fetchStub }),
    calls: () => i,
  };
}

const submit = () => screen.getByRole("button", { name: "Submit claim" }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  __resetClaimsBillingForTest();
});

describe("ClaimsBillingNotice (ADR-0108)", () => {
  it("shows nothing and blocks nothing for an entitled org", async () => {
    mount({ entitled: true, enforced: true, reason: null });
    await act(async () => {});
    expect(screen.queryByText(/claims-billing add-on/)).toBeNull();
    expect(submit().disabled).toBe(false);
  });

  it("enforced and not entitled: warns and disables new work", async () => {
    mount({ entitled: false, enforced: true, reason: "lapsed" });
    expect(await screen.findByText(/add-on has ended/)).toBeTruthy();
    expect(screen.getByText(/Claims already sent still finish/)).toBeTruthy();
    expect(submit().disabled).toBe(true);
  });

  it("shadow: informs, blocks nothing", async () => {
    mount({ entitled: false, enforced: false, reason: "never_purchased" });
    expect(await screen.findByText(/nothing is blocked yet/)).toBeTruthy();
    expect(submit().disabled).toBe(false);
  });

  it("re-reads the posture after the TTL, so a platform grant shows without a reload", async () => {
    const { client, calls } = sequenceClient(
      { entitled: false, enforced: true, reason: "never_purchased" },
      { entitled: true, enforced: true, reason: null },
    );
    const t0 = 1_000_000;
    primeClaimsBilling(client, { orgKey: "org-a", now: t0 });
    render(<Probe />);
    await act(async () => {});
    expect(submit().disabled).toBe(true);
    primeClaimsBilling(client, { orgKey: "org-a", now: t0 + CLAIMS_BILLING_POSTURE_TTL_MS - 1 });
    await act(async () => {});
    expect(calls()).toBe(1); // still fresh: no second read
    primeClaimsBilling(client, { orgKey: "org-a", now: t0 + CLAIMS_BILLING_POSTURE_TTL_MS });
    await act(async () => {});
    expect(calls()).toBe(2);
    expect(submit().disabled).toBe(false);
  });

  it("re-reads on an org switch and never shows the previous org's posture meanwhile", async () => {
    const { client, calls } = sequenceClient(
      { entitled: false, enforced: true, reason: "lapsed" },
      { entitled: true, enforced: true, reason: null },
    );
    primeClaimsBilling(client, { orgKey: "org-a", now: 1 });
    render(<Probe />);
    await act(async () => {});
    expect(submit().disabled).toBe(true);
    act(() => primeClaimsBilling(client, { orgKey: "org-b", now: 2 }));
    expect(submit().disabled).toBe(false); // org A's block is dropped at once
    await act(async () => {});
    expect(calls()).toBe(2);
    expect(screen.queryByText(/add-on has ended/)).toBeNull();
  });

  it("an unreadable status stays unknown, and a 402 refusal flips it to blocked", async () => {
    mount(undefined, 403);
    await act(async () => {});
    expect(submit().disabled).toBe(false);
    const refusal = {
      error: { code: "CLAIMS_BILLING_ADDON_REQUIRED", details: [{ code: "subscription_paused" }] },
    };
    expect(claimsBillingRefusalReason(refusal)).toBe("subscription_paused");
    expect(claimsBillingRefusalReason({ error: { code: "FORBIDDEN" } })).toBeNull();
    act(() => {
      noteClaimsBillingRefusal(refusal);
    });
    expect(screen.getByText(/subscription is paused/)).toBeTruthy();
    expect(submit().disabled).toBe(true);
  });
});
