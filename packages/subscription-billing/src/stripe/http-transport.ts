// @chartwarden/subscription-billing — GAP-058 the live Stripe HTTP transport (SDK-free, fetch-backed).
//
// The composition root constructs this ONLY when `STRIPE_SECRET_KEY` is configured; otherwise the
// fail-closed port (client.ts) stays bound. It implements the small operation set M35 actually drives
// (refund execution, payment-method ownership check, SetupIntent, customer create). Any other operation is
// refused PERMANENTLY rather than guessed at. Form-encoded bodies follow Stripe's bracket convention.
//
// HONESTY NOTE: written against Stripe's public REST docs and exercised only against a fake `fetch`
// (packages/subscription-billing/__tests__/http-transport.test.ts). It has NOT been run against a Stripe
// sandbox; field names (notably the invoice -> payment_intent hop used for refunds) must be confirmed there.

import type {
  StripeApiRequest,
  StripeApiResponse,
  StripeCallOptions,
  StripeHttpPort,
} from "./types";

export const STRIPE_API_BASE_URL = "https://api.stripe.com";

export interface FetchStripeHttpPortOptions {
  readonly secretKey: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Stripe-Version header; omitted => the account's pinned version. */
  readonly apiVersion?: string;
}

type FormValue = string | number | boolean | null | undefined | { readonly [k: string]: FormValue };

/** Stripe's bracket form encoding: `{metadata:{a:"b"}}` becomes `metadata[a]=b`. */
function encodeForm(value: { readonly [k: string]: FormValue }, prefix = ""): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
    const name = prefix === "" ? key : `${prefix}[${key}]`;
    if (typeof v === "object") {
      for (const [k2, v2] of encodeForm(v, name)) out.append(k2, v2);
    } else {
      out.append(name, String(v));
    }
  }
  return out;
}

/** Structurally a {@link StripeApiError}, so the dispatcher's retry-vs-DLQ decision reads it directly. */
class StripeTransportError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "StripeTransportError";
  }
}

const isRetryable = (status: number): boolean => status === 429 || status >= 500;

const requireString = (payload: Readonly<Record<string, unknown>>, key: string): string => {
  const v = payload[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new StripeTransportError(`missing payload field '${key}'`, 0, false);
  }
  return v;
};

/** Build the live {@link StripeHttpPort}. */
export function createFetchStripeHttpPort(options: FetchStripeHttpPortOptions): StripeHttpPort {
  const baseUrl = options.baseUrl ?? STRIPE_API_BASE_URL;
  const doFetch = options.fetchImpl ?? fetch;

  async function send(
    method: "GET" | "POST",
    path: string,
    form: URLSearchParams | null,
    idempotencyKey: string | null,
  ): Promise<StripeApiResponse> {
    const headers: Record<string, string> = { Authorization: `Bearer ${options.secretKey}` };
    if (options.apiVersion) headers["Stripe-Version"] = options.apiVersion;
    if (method === "POST") {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    }
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        ...(form ? { body: form.toString() } : {}),
      });
    } catch (err) {
      throw new StripeTransportError(err instanceof Error ? err.message : String(err), 0, true);
    }
    let parsed: unknown = {};
    try {
      parsed = await res.json();
    } catch {
      parsed = {};
    }
    const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
      string,
      unknown
    >;
    if (!res.ok) {
      const message = (record.error as { message?: unknown } | undefined)?.message;
      throw new StripeTransportError(
        typeof message === "string" ? message : `Stripe responded ${res.status}`,
        res.status,
        isRetryable(res.status),
      );
    }
    return { statusCode: res.status, body: record };
  }

  const getInvoice = (p: Readonly<Record<string, unknown>>) =>
    send(
      "GET",
      `/v1/invoices/${encodeURIComponent(requireString(p, "stripeInvoiceId"))}`,
      null,
      null,
    );

  return {
    async execute(request: StripeApiRequest, opts: StripeCallOptions): Promise<StripeApiResponse> {
      const p = request.payload;
      switch (request.operation) {
        case "payment_method.retrieve":
          return send(
            "GET",
            `/v1/payment_methods/${encodeURIComponent(requireString(p, "paymentMethodId"))}`,
            null,
            null,
          );
        case "invoice.retrieve":
          return getInvoice(p);
        case "customer.create":
          return send(
            "POST",
            "/v1/customers",
            encodeForm({
              name: typeof p.name === "string" ? p.name : undefined,
              metadata: { organization_id: requireString(p, "organizationId") },
            }),
            opts.idempotencyKey,
          );
        case "setup_intent.create":
          return send(
            "POST",
            "/v1/setup_intents",
            encodeForm({
              customer: requireString(p, "stripeCustomerId"),
              usage: "off_session",
              "payment_method_types[]": "card",
              metadata: { organization_id: requireString(p, "organizationId") },
            }),
            opts.idempotencyKey,
          );
        case "refund.create": {
          const invoice = await getInvoice(p);
          const paymentIntent = invoice.body.payment_intent;
          if (typeof paymentIntent !== "string" || paymentIntent.length === 0) {
            throw new StripeTransportError(
              "the invoice has no payment_intent to refund",
              422,
              false,
            );
          }
          const amount = p.amountCents;
          if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) {
            throw new StripeTransportError("refund amount must be a positive integer", 0, false);
          }
          return send(
            "POST",
            "/v1/refunds",
            encodeForm({
              payment_intent: paymentIntent,
              amount,
              metadata: { refund_id: requireString(p, "refundId") },
            }),
            opts.idempotencyKey,
          );
        }
        default:
          throw new StripeTransportError(
            `no live transport mapping for '${request.operation}'`,
            0,
            false,
          );
      }
    },
  };
}
