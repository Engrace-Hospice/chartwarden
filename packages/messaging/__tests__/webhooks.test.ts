// M36-T08 — webhook two-layer defense (M36 spec §4.9 / §4.9.1 / §4.9.2; SD-056 / INT-016).
//
// Accept: the replay window rejects missing/invalid/expired timestamps and admits fresh ones; the
// Twilio HMAC verifier accepts a correctly-signed request and rejects a forged one; the Postmark
// verifier requires BOTH a valid source IP and a constant-time-correct bearer token (a valid token
// from a bad IP is rejected; a wrong token from a good IP is rejected).
import { describe, expect, it } from "vitest";
import {
  WebhookError,
  assertReplayWindow,
  computeTwilioSignature,
  verifyPostmarkWebhook,
  verifyTwilioSignature,
} from "@wardenx/messaging";

const NOW = Date.parse("2026-06-15T12:00:00Z");

describe("M36-T08 assertReplayWindow (§4.9.1)", () => {
  it("rejects a missing timestamp header", () => {
    expect(() => assertReplayWindow(undefined, NOW)).toThrow(WebhookError);
    expect(() => assertReplayWindow(undefined, NOW)).toThrow(/MISSING_TIMESTAMP_HEADER/);
  });

  it("rejects a non-numeric, non-date timestamp", () => {
    expect(() => assertReplayWindow("not-a-time", NOW)).toThrow(/INVALID_TIMESTAMP_HEADER/);
  });

  it("admits a fresh Twilio epoch-seconds timestamp within ±300s", () => {
    const epoch = String(Math.floor(NOW / 1000) - 120);
    expect(() => assertReplayWindow(epoch, NOW)).not.toThrow();
  });

  it("admits a fresh Postmark ISO-8601 Date header", () => {
    expect(() => assertReplayWindow("2026-06-15T11:58:00Z", NOW)).not.toThrow();
  });

  it("rejects a timestamp older than 5 minutes", () => {
    const stale = String(Math.floor(NOW / 1000) - 600);
    expect(() => assertReplayWindow(stale, NOW)).toThrow(/REPLAY_WINDOW_EXPIRED/);
  });
});

describe("M36-T08 verifyTwilioSignature (§4.9.2)", () => {
  const url = "https://api.example.com/webhooks/twilio/sms-status";
  const body = { MessageSid: "SM123", MessageStatus: "delivered", To: "+15551234567" };
  const authToken = "test_auth_token";

  it("accepts a correctly-signed request", () => {
    const signature = computeTwilioSignature(url, body, authToken);
    expect(() =>
      verifyTwilioSignature({ url, headers: { "x-twilio-signature": signature }, body, authToken }),
    ).not.toThrow();
  });

  it("rejects a forged signature", () => {
    expect(() =>
      verifyTwilioSignature({ url, headers: { "x-twilio-signature": "forged" }, body, authToken }),
    ).toThrow(/INVALID_SIGNATURE/);
  });

  it("rejects when a param is tampered (signature no longer matches)", () => {
    const signature = computeTwilioSignature(url, body, authToken);
    expect(() =>
      verifyTwilioSignature({
        url,
        headers: { "x-twilio-signature": signature },
        body: { ...body, MessageStatus: "failed" }, // attacker flips the status
        authToken,
      }),
    ).toThrow(/INVALID_SIGNATURE/);
  });
});

describe("M36-T08 verifyPostmarkWebhook (§4.9.2 / INT-016)", () => {
  const token = "postmark_secret_token";
  const good = { authorization: `Bearer ${token}` };

  it("accepts a valid token from an allowlisted IP", () => {
    expect(() =>
      verifyPostmarkWebhook({ headers: good, expectedToken: token, sourceIpAllowed: true }),
    ).not.toThrow();
  });

  it("rejects a valid token from a non-Postmark IP (403)", () => {
    expect(() =>
      verifyPostmarkWebhook({ headers: good, expectedToken: token, sourceIpAllowed: false }),
    ).toThrow(/FORBIDDEN_SOURCE/);
  });

  it("rejects a wrong token from an allowlisted IP (401)", () => {
    expect(() =>
      verifyPostmarkWebhook({
        headers: { authorization: "Bearer wrong_token_xxxxx" },
        expectedToken: token,
        sourceIpAllowed: true,
      }),
    ).toThrow(/INVALID_BEARER_TOKEN/);
  });

  it("rejects a missing bearer", () => {
    expect(() =>
      verifyPostmarkWebhook({ headers: {}, expectedToken: token, sourceIpAllowed: true }),
    ).toThrow(/MISSING_BEARER_TOKEN/);
  });
});
