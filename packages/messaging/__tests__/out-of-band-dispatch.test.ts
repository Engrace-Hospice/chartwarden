import {
  type ClaimedDelivery,
  DELIVERY_SWEEP_INTERVAL_MS,
  TRANSPORT_NOT_CONFIGURED,
  TransportError,
  backoffDelayMs,
  canTransition,
  createDenyTransports,
  createFakeTransports,
  dispatchClaimedDelivery,
  hasAttemptsLeft,
  mapVendorStatus,
  queueParametersFor,
} from "@chartwarden/messaging";
// M36 GAP-101 — out-of-band dispatch decision, retry/backoff policy and vendor-status reconcile (§4.4/§4.7/§4.9).
import { describe, expect, it } from "vitest";

const claim = (over: Partial<ClaimedDelivery> = {}): ClaimedDelivery => ({
  deliveryId: "d-1",
  organizationId: "org-1",
  alertId: "a-1",
  recipientUserId: "u-1",
  channel: "sms",
  alertCategory: "clinical_urgent",
  alertSeverity: "critical",
  attemptCount: 1,
  vendorMessageId: null,
  ...over,
});

const destination = { endpointId: "e-1", value: "+15551234567" };
const ports = (
  transports = createFakeTransports().transports,
  dest: typeof destination | null = destination,
) => ({
  transports,
  appBaseUrl: "https://app.example.com",
  resolveDestination: async () => dest,
});

describe("dispatchClaimedDelivery", () => {
  it("sends a SANITIZED payload (no payload/body) and reports the vendor id", async () => {
    const fake = createFakeTransports();
    const out = await dispatchClaimedDelivery(claim(), ports(fake.transports));
    expect(out).toMatchObject({
      kind: "sent",
      vendorMessageId: "fake-sms-1",
      endpointId: "e-1",
      settlesOnAcceptance: false,
    });
    const sent = fake.calls[0]?.request;
    expect(sent?.destination).toBe("+15551234567");
    expect(Object.keys(sent?.notification ?? {}).sort()).toEqual([
      "deepLink",
      "notificationDeliveryId",
      "short",
    ]);
    expect(sent?.notification.deepLink).toBe("https://app.example.com/n/d-1");
  });

  it("settles push on acceptance (web-push has no delivery callback)", async () => {
    const out = await dispatchClaimedDelivery(claim({ channel: "push" }), ports());
    expect(out).toMatchObject({ kind: "sent", settlesOnAcceptance: true });
  });

  it("never re-sends a row that already holds a vendor id", async () => {
    const fake = createFakeTransports();
    const out = await dispatchClaimedDelivery(
      claim({ vendorMessageId: "SM1" }),
      ports(fake.transports),
    );
    expect(out).toMatchObject({ kind: "sent", vendorMessageId: "SM1" });
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses voice for anything but a critical field-safety alert (SOS-only), without calling the vendor", async () => {
    const fake = createFakeTransports();
    const out = await dispatchClaimedDelivery(
      claim({ channel: "voice", alertCategory: "clinical_urgent" }),
      ports(fake.transports),
    );
    expect(out).toEqual({ kind: "failed", reason: "voice_not_sos", endpointId: null });
    expect(fake.calls).toHaveLength(0);
  });

  it("sends voice for a critical field-safety alert", async () => {
    const out = await dispatchClaimedDelivery(
      claim({ channel: "voice", alertCategory: "field_safety", alertSeverity: "critical" }),
      ports(),
    );
    expect(out.kind).toBe("sent");
  });

  it("fails terminally when the recipient has no verified endpoint", async () => {
    const out = await dispatchClaimedDelivery(claim(), ports(undefined, null));
    expect(out).toEqual({ kind: "failed", reason: "no_verified_endpoint", endpointId: null });
  });

  it("retries a retryable refusal with the queue backoff, honouring a larger Retry-After", async () => {
    const t = createFakeTransports({
      failWith: () => new TransportError("rate_limited", true, 60_000),
    });
    const out = await dispatchClaimedDelivery(claim({ attemptCount: 1 }), ports(t.transports));
    expect(out).toMatchObject({ kind: "retry", reason: "rate_limited", delayMs: 60_000 });
  });

  it("fails terminally once the attempt budget is spent", async () => {
    const t = createFakeTransports({ failWith: () => new TransportError("vendor_5xx", true) });
    const budget = queueParametersFor("sms").attempts;
    const out = await dispatchClaimedDelivery(claim({ attemptCount: budget }), ports(t.transports));
    expect(out).toMatchObject({ kind: "failed", reason: "vendor_5xx" });
  });

  it("fails at once on a non-retryable refusal", async () => {
    const t = createFakeTransports({ failWith: () => new TransportError("invalid_number", false) });
    const out = await dispatchClaimedDelivery(claim({ attemptCount: 1 }), ports(t.transports));
    expect(out).toMatchObject({ kind: "failed", reason: "invalid_number" });
  });

  it("treats an unexpected throw as retryable", async () => {
    const transports = {
      ...createDenyTransports(),
      sms: { send: () => Promise.reject(new Error("boom")) },
    };
    const out = await dispatchClaimedDelivery(claim(), ports(transports));
    expect(out).toMatchObject({ kind: "retry", reason: "transport_error" });
  });

  it("the production deny-stub fails every send terminally (never pending, never faked as sent)", async () => {
    const out = await dispatchClaimedDelivery(claim(), ports(createDenyTransports()));
    expect(out).toEqual({ kind: "failed", reason: TRANSPORT_NOT_CONFIGURED, endpointId: "e-1" });
  });
});

describe("retry policy (§4.4.1)", () => {
  it("exponential backoff doubles and respects the cap", () => {
    const sms = queueParametersFor("sms");
    expect(backoffDelayMs(sms, 1)).toBe(5000);
    expect(backoffDelayMs(sms, 2)).toBe(10_000);
    expect(backoffDelayMs(sms, 20)).toBe(300_000);
  });

  it("fixed backoff is constant (voice)", () => {
    const voice = queueParametersFor("voice");
    expect(backoffDelayMs(voice, 1)).toBe(2000);
    expect(backoffDelayMs(voice, 3)).toBe(2000);
  });

  it("the attempt budget is the catalog's", () => {
    const voice = queueParametersFor("voice");
    expect(hasAttemptsLeft(voice, voice.attempts - 1)).toBe(true);
    expect(hasAttemptsLeft(voice, voice.attempts)).toBe(false);
  });

  it("every out-of-band channel has a sweep cadence, voice fastest", () => {
    expect(Math.min(...Object.values(DELIVERY_SWEEP_INTERVAL_MS))).toBe(
      DELIVERY_SWEEP_INTERVAL_MS.voice,
    );
  });
});

describe("mapVendorStatus + canTransition (§2.4.4 / §4.9)", () => {
  it("maps Twilio SMS statuses", () => {
    expect(mapVendorStatus("twilio_sms", "delivered")).toEqual({
      status: "delivered",
      failReason: null,
    });
    expect(mapVendorStatus("twilio_sms", "queued")?.status).toBe("sent");
    expect(mapVendorStatus("twilio_sms", "undelivered", "30003")).toEqual({
      status: "failed",
      failReason: "twilio_sms:undelivered:30003",
    });
  });

  it("maps Twilio voice statuses (completed = delivered; busy/no-answer = failed; ringing = ignored)", () => {
    expect(mapVendorStatus("twilio_voice", "completed")?.status).toBe("delivered");
    expect(mapVendorStatus("twilio_voice", "no-answer")?.status).toBe("failed");
    expect(mapVendorStatus("twilio_voice", "ringing")).toBeNull();
  });

  it("maps Postmark record types; opens/clicks imply nothing", () => {
    expect(mapVendorStatus("postmark_event", "Delivery")?.status).toBe("delivered");
    expect(mapVendorStatus("postmark_event", "Bounce", "HardBounce")?.status).toBe("failed");
    expect(mapVendorStatus("postmark_event", "Open")).toBeNull();
  });

  it("ignores an unknown status rather than guessing", () => {
    expect(mapVendorStatus("twilio_sms", "mystery")).toBeNull();
  });

  it("only moves strictly forward — a replay or a late contradictory callback is refused", () => {
    expect(canTransition("pending", "sent")).toBe(true);
    expect(canTransition("sent", "delivered")).toBe(true);
    expect(canTransition("sent", "failed")).toBe(true);
    expect(canTransition("pending", "failed")).toBe(true);
    expect(canTransition("delivered", "delivered")).toBe(false);
    expect(canTransition("delivered", "failed")).toBe(false);
    expect(canTransition("failed", "delivered")).toBe(false);
    expect(canTransition("sent", "sent")).toBe(false);
    expect(canTransition("skipped_quiet_hours", "delivered")).toBe(false);
    expect(canTransition("forwarded", "failed")).toBe(false);
  });
});
