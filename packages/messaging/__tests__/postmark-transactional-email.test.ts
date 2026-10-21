// Contract tests for the Postmark adapter behind the M36 transactional email port. A recorded fake `fetch`
// stands in for Postmark: no network. Locks the request shape, retry/backoff policy, permanent-failure
// classification, the no-PHI/no-secret log rule, and the env-driven bind decision.
import { describe, expect, it } from "vitest";
import {
  EmailDeliveryError,
  createPostmarkTransactionalEmailTransport,
  postmarkConfigAttempted,
  resolvePostmarkConfig,
} from "../src/notification/postmark-transactional-email";
import type { FetchLike } from "../src/notification/postmark-transactional-email";

const TOKEN = "pm-server-token-SECRET-0123456789";
const TO = "invitee@recipient.test";
const LINK_TOKEN = "tok_LINKSECRET_abcdef";
const EMAIL = {
  to: TO,
  subject: "Your secure link from the hospice care team",
  text: `Open it:\nhttps://portal.test/funeral/redeem#token=${LINK_TOKEN}`,
};

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(responses: Array<Response | Error>): { fetch: FetchLike; calls: Recorded[] } {
  const calls: Recorded[] = [];
  let i = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(init.body as string),
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next as Response;
  };
  return { fetch, calls };
}

const ok = (id = "msg-1") =>
  new Response(JSON.stringify({ ErrorCode: 0, Message: "OK", MessageID: id }), { status: 200 });
const status = (code: number, body: object = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: code, headers });

function build(responses: Array<Response | Error>, extra: { maxAttempts?: number } = {}) {
  const { fetch, calls } = fakeFetch(responses);
  const logs: string[] = [];
  const sleeps: number[] = [];
  const transport = createPostmarkTransactionalEmailTransport({
    serverToken: TOKEN,
    from: "no-reply@chartwarden.test",
    fetch,
    log: (l) => logs.push(l),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    newDedupeKey: () => "dedupe-1",
    ...extra,
  });
  return { transport, calls, logs, sleeps };
}

describe("Postmark transactional email adapter", () => {
  it("POSTs the Postmark single-email shape with the server-token header", async () => {
    const { transport, calls } = build([ok()]);
    await transport.send(EMAIL);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.postmarkapp.com/email");
    expect(calls[0]?.headers["X-Postmark-Server-Token"]).toBe(TOKEN);
    expect(calls[0]?.body).toMatchObject({
      From: "no-reply@chartwarden.test",
      To: TO,
      Subject: EMAIL.subject,
      TextBody: EMAIL.text,
      MessageStream: "outbound",
      TrackOpens: false,
      TrackLinks: "None",
      Metadata: { dedupe_key: "dedupe-1" },
    });
  });

  it("retries 5xx and 429 with bounded backoff, then succeeds", async () => {
    const { transport, calls, sleeps } = build([
      status(503),
      status(429, {}, { "retry-after": "1" }),
      ok(),
    ]);
    await transport.send(EMAIL);
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([250, 1000]);
  });

  it("retries a network failure and a timeout abort", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const { transport, calls } = build([new Error("ECONNRESET"), abort, ok()]);
    await transport.send(EMAIL);
    expect(calls).toHaveLength(3);
  });

  it("gives up after maxAttempts with a typed retryable error", async () => {
    const { transport, calls } = build([status(500)], { maxAttempts: 2 });
    const err = await transport.send(EMAIL).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmailDeliveryError);
    expect(err).toMatchObject({ code: "PROVIDER_UNAVAILABLE", retryable: true, status: 500 });
    expect(calls).toHaveLength(2);
  });

  it("treats other 4xx as permanent: no retry, provider error code surfaced", async () => {
    const { transport, calls, sleeps } = build([
      status(422, { ErrorCode: 400, Message: "bad sender" }),
    ]);
    const err = await transport.send(EMAIL).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "PROVIDER_REJECTED",
      retryable: false,
      status: 422,
      providerErrorCode: 400,
    });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("rejects a 2xx without a MessageID as INVALID_RESPONSE", async () => {
    const { transport } = build([status(200, { ErrorCode: 0 })]);
    await expect(transport.send(EMAIL)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("never logs the recipient, subject, body, link token or server token", async () => {
    const okRun = build([ok("msg-xyz")]);
    await okRun.transport.send(EMAIL);
    const failRun = build([status(500, { Message: `bad ${TO}` })], { maxAttempts: 2 });
    const err = await failRun.transport.send(EMAIL).catch((e: unknown) => e);
    const everything = [...okRun.logs, ...failRun.logs, String((err as Error).message)].join("\n");
    for (const secret of [TOKEN, TO, LINK_TOKEN, EMAIL.subject, "recipient.test"]) {
      expect(everything).not.toContain(secret);
    }
    expect(okRun.logs[0]).toContain("message_id=msg-xyz");
    expect(okRun.logs[0]).toContain("status=200");
  });
});

describe("resolvePostmarkConfig", () => {
  const GOOD = {
    POSTMARK_SERVER_TOKEN: TOKEN,
    POSTMARK_FROM_ADDRESS: "no-reply@chartwarden.test",
    POSTMARK_SENDER_VERIFIED: "true",
  };
  it("binds only with token + From + verified attestation", () => {
    expect(resolvePostmarkConfig(GOOD)).toMatchObject({ bound: true });
  });
  it("stays unbound, naming each missing var", () => {
    expect(resolvePostmarkConfig({})).toEqual({
      bound: false,
      missing: ["POSTMARK_SERVER_TOKEN", "POSTMARK_FROM_ADDRESS", "POSTMARK_SENDER_VERIFIED"],
      invalid: [],
    });
    expect(resolvePostmarkConfig({ ...GOOD, POSTMARK_SERVER_TOKEN: "" })).toMatchObject({
      bound: false,
      missing: ["POSTMARK_SERVER_TOKEN"],
    });
  });
  it("rejects a malformed From, an unverified sender, and a non-https base in production", () => {
    expect(
      resolvePostmarkConfig({ ...GOOD, POSTMARK_FROM_ADDRESS: "Name <x@y.test>" }),
    ).toMatchObject({ bound: false, invalid: ["POSTMARK_FROM_ADDRESS"] });
    expect(resolvePostmarkConfig({ ...GOOD, POSTMARK_SENDER_VERIFIED: "false" })).toMatchObject({
      bound: false,
      invalid: ["POSTMARK_SENDER_VERIFIED"],
    });
    expect(
      resolvePostmarkConfig({
        ...GOOD,
        NODE_ENV: "production",
        POSTMARK_API_BASE_URL: "http://x.test",
      }),
    ).toMatchObject({ bound: false, invalid: ["POSTMARK_API_BASE_URL"] });
  });
  it("reports whether any credential var was attempted", () => {
    expect(postmarkConfigAttempted({})).toBe(false);
    expect(postmarkConfigAttempted({ POSTMARK_SERVER_TOKEN: "x" })).toBe(true);
  });
});
