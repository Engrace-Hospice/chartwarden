// GAP-058 — the live Stripe transport (SDK-free, fetch-backed). Tested against a fake fetch: this proves the
// wire mapping, auth, idempotency header and error classification — NOT behaviour against real Stripe.
import { describe, expect, it } from "vitest";
import { createFetchStripeHttpPort, isStripeApiError } from "../src/stripe";

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(responses: Array<{ status: number; body: unknown } | Error>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses");
    if (next instanceof Error) throw next;
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      json: async () => next.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const KEY = { secretKey: "sk_test_x", baseUrl: "https://stripe.test" };

describe("createFetchStripeHttpPort (GAP-058)", () => {
  it("GETs a payment method with bearer auth and no idempotency header", async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: { id: "pm_1" } }]);
    const port = createFetchStripeHttpPort({ ...KEY, fetchImpl: impl });
    const res = await port.execute(
      { operation: "payment_method.retrieve", payload: { paymentMethodId: "pm_1" } },
      { idempotencyKey: "k" },
    );
    expect(res).toEqual({ statusCode: 200, body: { id: "pm_1" } });
    expect(calls[0]?.url).toBe("https://stripe.test/v1/payment_methods/pm_1");
    expect(calls[0]?.init.method).toBe("GET");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_test_x");
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("POSTs a refund form-encoded with the idempotency key, resolving the invoice's payment intent", async () => {
    const { impl, calls } = fakeFetch([
      { status: 200, body: { id: "in_1", payment_intent: "pi_9" } },
      { status: 200, body: { id: "re_1", status: "succeeded" } },
    ]);
    const port = createFetchStripeHttpPort({ ...KEY, fetchImpl: impl });
    const res = await port.execute(
      {
        operation: "refund.create",
        payload: { stripeInvoiceId: "in_1", amountCents: 1250, refundId: "r-uuid" },
      },
      { idempotencyKey: "stripe-idem-refund.create-r-uuid-0" },
    );
    expect(res.body).toEqual({ id: "re_1", status: "succeeded" });
    expect(calls[0]?.url).toBe("https://stripe.test/v1/invoices/in_1");
    expect(calls[1]?.url).toBe("https://stripe.test/v1/refunds");
    expect(calls[1]?.init.method).toBe("POST");
    const headers = calls[1]?.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBe("stripe-idem-refund.create-r-uuid-0");
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(calls[1]?.init.body));
    expect(form.get("payment_intent")).toBe("pi_9");
    expect(form.get("amount")).toBe("1250");
    expect(form.get("metadata[refund_id]")).toBe("r-uuid");
  });

  it("classifies 4xx as permanent, 429/5xx/network as retryable", async () => {
    const run = async (r: { status: number; body: unknown } | Error) => {
      const { impl } = fakeFetch([r]);
      const port = createFetchStripeHttpPort({ ...KEY, fetchImpl: impl });
      return port
        .execute(
          { operation: "payment_method.retrieve", payload: { paymentMethodId: "pm_1" } },
          { idempotencyKey: "k" },
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
    };
    const permanent = await run({ status: 404, body: { error: { message: "No such" } } });
    expect(isStripeApiError(permanent) && permanent.retryable).toBe(false);
    expect(isStripeApiError(permanent) && permanent.statusCode).toBe(404);
    for (const status of [429, 500, 503]) {
      const e = await run({ status, body: { error: { message: "x" } } });
      expect(isStripeApiError(e) && e.retryable).toBe(true);
    }
    const net = await run(new Error("ECONNRESET"));
    expect(isStripeApiError(net) && net.retryable).toBe(true);
    expect(isStripeApiError(net) && net.statusCode).toBe(0);
  });

  it("refuses an operation it has no mapping for, permanently", async () => {
    const { impl, calls } = fakeFetch([]);
    const port = createFetchStripeHttpPort({ ...KEY, fetchImpl: impl });
    const err = await port
      .execute({ operation: "meter.create", payload: {} }, { idempotencyKey: "k" })
      .catch((e: unknown) => e);
    expect(isStripeApiError(err) && err.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
