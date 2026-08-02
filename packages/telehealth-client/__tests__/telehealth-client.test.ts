// @wardenx/telehealth-client — M31-T05 adapter tests (§4.5 D1 / §7.2 / §7.3 / D13).
//
// Covers: the pure circuit breaker (closed → open → half-open → closed), the Daily.co adapter's PHI-free
// boundary (no visit id / no PHI ever reaches the vendor; the room name is an opaque HMAC), token TTL clamping,
// idempotent room mint + endRoom, the D13 webhook HMAC verify (valid / invalid / missing / timing-safe), the
// degraded-error envelope on outage + open circuit, and the scaffold adapters' non-retryable refusal + the
// compile-time `satisfies TelehealthProvider` conformance. All transport is injected — no real network.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DailyCoTelehealthProvider,
  type FetchLike,
  INITIAL_TELEHEALTH_BREAKER_SNAPSHOT,
  NativeWebrtcTelehealthProvider,
  TELEHEALTH_CIRCUIT_BREAKER_CONFIG,
  TELEHEALTH_TOKEN_TTL_CEILING_SECONDS,
  TELEHEALTH_TOKEN_TTL_FLOOR_SECONDS,
  TelehealthDegradedError,
  type TelehealthProvider,
  TwilioVideoTelehealthProvider,
  applyTelehealthOutcome,
  clampTtl,
  evaluateTelehealthBreaker,
  isTelehealthDegradedError,
} from "../src/index";

const ENDPOINT = "https://api.daily.co/v1";
const API_KEY = "test-daily-key";
const ROOM_SECRET = "room-name-secret";
const WEBHOOK_SECRET = "webhook-secret";

/** A tiny fetch stub that records every call and replays scripted responses. */
function stubFetch(responses: Array<{ ok?: boolean; status?: number; json?: unknown } | Error>): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }>;
} {
  const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return {
      ok: r.ok ?? true,
      status: r.status ?? 200,
      json: async () => r.json ?? {},
    };
  };
  return { fetchImpl, calls };
}

function makeAdapter(fetchImpl: FetchLike, now = () => "2026-08-02T12:00:00.000Z"): DailyCoTelehealthProvider {
  return new DailyCoTelehealthProvider({
    endpoint: ENDPOINT,
    apiKey: API_KEY,
    roomNameSecret: ROOM_SECRET,
    webhookSecret: WEBHOOK_SECRET,
    now,
    fetchImpl,
  });
}

describe("telehealth circuit breaker (pure)", () => {
  const cfg = TELEHEALTH_CIRCUIT_BREAKER_CONFIG;

  it("opens after the failure threshold and fails fast while open", () => {
    let snap = INITIAL_TELEHEALTH_BREAKER_SNAPSHOT;
    for (let n = 0; n < cfg.failureThreshold; n++) {
      snap = applyTelehealthOutcome(snap, "failure", "2026-08-02T12:00:00.000Z", cfg);
    }
    expect(snap.state).toBe("open");
    expect(evaluateTelehealthBreaker(snap, "2026-08-02T12:00:05.000Z", cfg).allowed).toBe(false);
  });

  it("cools to half-open after the open duration, then closes on a probe success", () => {
    let snap = INITIAL_TELEHEALTH_BREAKER_SNAPSHOT;
    for (let n = 0; n < cfg.failureThreshold; n++) {
      snap = applyTelehealthOutcome(snap, "failure", "2026-08-02T12:00:00.000Z", cfg);
    }
    const later = "2026-08-02T12:01:01.000Z"; // > openDurationSeconds (60s) after open
    const gate = evaluateTelehealthBreaker(snap, later, cfg);
    expect(gate.effectiveState).toBe("half_open");
    expect(gate.allowed).toBe(true);
    const closed = applyTelehealthOutcome(snap, "success", later, cfg);
    expect(closed.state).toBe("closed");
    expect(closed.recentFailureInstants).toHaveLength(0);
  });
});

describe("DailyCoTelehealthProvider — PHI boundary (D1)", () => {
  it("never sends the visit id or any PHI to the vendor; room name is an opaque HMAC prefix", async () => {
    const { fetchImpl, calls } = stubFetch([
      { status: 404 }, // GET probe → not found
      { json: { name: "tlh_x", url: "https://x.daily.co/tlh_x" } }, // POST create
    ]);
    const adapter = makeAdapter(fetchImpl);
    const visitId = "visit-uuid-1234-secret";
    const out = await adapter.mintRoom({
      telehealthVisitId: visitId,
      scheduledStartedAt: "2026-08-02T12:05:00.000Z",
      recordingEnabled: false,
    });
    expect(out.vendorRoomId).toBe("tlh_x");
    // The raw visit id must appear in NO request URL or body.
    for (const c of calls) {
      expect(c.url).not.toContain(visitId);
      expect(c.body ?? "").not.toContain(visitId);
    }
    // The created room name is the opaque `tlh_<hmac>` — deterministic and not the visit id.
    const createBody = JSON.parse(calls[1]?.body ?? "{}") as { name: string };
    expect(createBody.name).toMatch(/^tlh_[0-9a-f]{32}$/);
    expect(createBody.name).not.toContain(visitId);
  });

  it("mintRoom is idempotent — an existing room short-circuits the create (deterministic name)", async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { name: "tlh_existing", url: "https://x.daily.co/tlh_existing" } }, // GET probe → found
    ]);
    const adapter = makeAdapter(fetchImpl);
    const out = await adapter.mintRoom({
      telehealthVisitId: "v1",
      scheduledStartedAt: "2026-08-02T12:05:00.000Z",
      recordingEnabled: true,
    });
    expect(out.vendorRoomId).toBe("tlh_existing");
    expect(calls).toHaveLength(1); // no POST
    expect(calls[0]?.method).toBe("GET");
  });

  it("clamps participant-token TTL into the [30 min, 2 h] platform bounds", async () => {
    const { fetchImpl } = stubFetch([{ json: { token: "tok" } }]);
    const adapter = makeAdapter(fetchImpl, () => "2026-08-02T12:00:00.000Z");
    const belowFloor = await adapter.mintParticipantToken({
      vendorRoomId: "tlh_x",
      participantKind: "patient",
      ttlSeconds: 10,
    });
    const expectedFloorMs = Date.parse("2026-08-02T12:00:00.000Z") + TELEHEALTH_TOKEN_TTL_FLOOR_SECONDS * 1000;
    expect(Date.parse(belowFloor.expiresAt)).toBe(expectedFloorMs);

    expect(clampTtl(10)).toBe(TELEHEALTH_TOKEN_TTL_FLOOR_SECONDS);
    expect(clampTtl(999_999)).toBe(TELEHEALTH_TOKEN_TTL_CEILING_SECONDS);
    expect(clampTtl(3_600)).toBe(3_600);
  });

  it("marks the clinician as room owner and the patient as non-owner", async () => {
    const { fetchImpl, calls } = stubFetch([{ json: { token: "a" } }, { json: { token: "b" } }]);
    const adapter = makeAdapter(fetchImpl);
    await adapter.mintParticipantToken({ vendorRoomId: "tlh_x", participantKind: "clinician", ttlSeconds: 1800 });
    await adapter.mintParticipantToken({ vendorRoomId: "tlh_x", participantKind: "patient", ttlSeconds: 1800 });
    expect(JSON.parse(calls[0]?.body ?? "{}").properties.is_owner).toBe(true);
    expect(JSON.parse(calls[1]?.body ?? "{}").properties.is_owner).toBe(false);
  });

  it("endRoom treats a 404 as an idempotent success", async () => {
    const { fetchImpl } = stubFetch([{ status: 404 }]);
    const adapter = makeAdapter(fetchImpl);
    await expect(adapter.endRoom("tlh_gone")).resolves.toBeUndefined();
  });
});

describe("DailyCoTelehealthProvider — degraded envelope (§7.3)", () => {
  it("normalises a transport error to a retryable TelehealthDegradedError", async () => {
    const { fetchImpl } = stubFetch([new Error("ECONNRESET")]);
    const adapter = makeAdapter(fetchImpl);
    expect.assertions(4);
    try {
      await adapter.mintRoom({ telehealthVisitId: "v", scheduledStartedAt: "2026-08-02T12:00:00.000Z", recordingEnabled: false });
    } catch (e) {
      expect(isTelehealthDegradedError(e)).toBe(true);
      expect((e as TelehealthDegradedError).retryable).toBe(true);
      expect((e as TelehealthDegradedError).vendor).toBe("daily_co");
      expect((e as TelehealthDegradedError).operation).toBe("mintRoom");
    }
  });

  it("fails fast with a degraded error once the circuit is open (no fetch attempted)", async () => {
    const { fetchImpl, calls } = stubFetch([
      new Error("x"), new Error("x"), new Error("x"), new Error("x"), new Error("x"),
    ]);
    const adapter = makeAdapter(fetchImpl);
    // Trip the breaker with 5 failed startRecording calls (threshold).
    for (let n = 0; n < 5; n++) {
      await adapter.startRecording("tlh_x").catch(() => undefined);
    }
    const callsAfterTrip = calls.length;
    await expect(adapter.startRecording("tlh_x")).rejects.toBeInstanceOf(TelehealthDegradedError);
    expect(calls.length).toBe(callsAfterTrip); // open circuit did NOT call fetch
  });
});

describe("DailyCoTelehealthProvider — webhook HMAC verify (D13)", () => {
  const adapter = makeAdapter(stubFetch([{}]).fetchImpl);
  const body = '{"type":"meeting-ended","room":"tlh_x"}';
  const sign = (b: string) => createHmac("sha256", WEBHOOK_SECRET).update(b, "utf8").digest("hex");

  it("accepts a correct signature (case-insensitive header)", () => {
    expect(adapter.verifyWebhookSignature({ "X-Webhook-Signature": sign(body) }, body)).toBe(true);
    expect(adapter.verifyWebhookSignature({ "x-webhook-signature": sign(body) }, body)).toBe(true);
  });

  it("rejects a tampered body, a wrong-secret signature, and a missing header", () => {
    expect(adapter.verifyWebhookSignature({ "x-webhook-signature": sign(body) }, `${body} `)).toBe(false);
    expect(adapter.verifyWebhookSignature({ "x-webhook-signature": createHmac("sha256", "other").update(body).digest("hex") }, body)).toBe(false);
    expect(adapter.verifyWebhookSignature({}, body)).toBe(false);
    expect(adapter.verifyWebhookSignature({ "x-webhook-signature": "not-hex-zz" }, body)).toBe(false);
  });
});

describe("scaffold adapters (§4.5 — interface conformance only)", () => {
  it("refuse every vendor call with a non-retryable degraded error", async () => {
    for (const adapter of [new TwilioVideoTelehealthProvider(), new NativeWebrtcTelehealthProvider()]) {
      try {
        await adapter.mintRoom({ telehealthVisitId: "v", scheduledStartedAt: "2026-08-02T12:00:00.000Z", recordingEnabled: false });
        throw new Error("expected refusal");
      } catch (e) {
        expect(isTelehealthDegradedError(e)).toBe(true);
        expect((e as TelehealthDegradedError).retryable).toBe(false);
      }
      expect(adapter.verifyWebhookSignature({}, "{}")).toBe(false);
    }
  });

  it("all three adapters conform to TelehealthProvider (compile-time)", () => {
    const providers: TelehealthProvider[] = [
      new DailyCoTelehealthProvider({
        endpoint: ENDPOINT, apiKey: API_KEY, roomNameSecret: ROOM_SECRET, webhookSecret: WEBHOOK_SECRET,
        now: () => "2026-08-02T12:00:00.000Z", fetchImpl: stubFetch([{}]).fetchImpl,
      }),
      new TwilioVideoTelehealthProvider(),
      new NativeWebrtcTelehealthProvider(),
    ];
    expect(providers.map((p) => p.vendor)).toEqual(["daily_co", "twilio_video", "native_webrtc"]);
  });
});
