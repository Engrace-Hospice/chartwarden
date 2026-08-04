// @wardenx/telehealth-client — the Daily.co `TelehealthProvider` (M31-T05, spec §4.5 D1 / §7.2 / §7.3 / D13).
// The ONLY place a telehealth vendor is called (architecture §25.14 adapter mandate; dependency-cruiser
// §25.15 forbids any other module from reaching Daily.co directly). Ships ENABLED by default (D1); Twilio +
// native-WebRTC ship scaffold-only behind this same interface (`twilio-adapter.ts` / `native-webrtc-adapter.ts`).
//
// PHI boundary (D1 — the whole point of the wrapper): NOTHING patient-identifying ever leaves M31. The vendor
// sees ONLY (a) a deterministic opaque room name `tlh_<hmac(visitId)>` — NOT the raw visit id, NOT the patient
// id, NOT any name/MRN/condition (§7.2 step 2), and (b) an opaque participant kind ("patient" | "clinician").
// The HMAC room-name derivation makes `mintRoom` idempotent on `telehealthVisitId` (same visit → same room on
// replay) WITHOUT sending the visit id itself. The circuit breaker (§25.14) fails fast into the §7.3 degraded
// path; every transport error is normalised to {@link TelehealthDegradedError} so a raw `fetch` rejection
// never reaches an M31 caller.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  INITIAL_TELEHEALTH_BREAKER_SNAPSHOT,
  TELEHEALTH_CIRCUIT_BREAKER_CONFIG,
  type TelehealthBreakerSnapshot,
  type TelehealthCircuitBreakerConfig,
  applyTelehealthOutcome,
  evaluateTelehealthBreaker,
} from "./circuit-breaker";
import { TelehealthDegradedError, type TelehealthOperation } from "./errors";
import type {
  TelehealthMintParticipantTokenInput,
  TelehealthMintRoomInput,
  TelehealthProvider,
} from "./provider";

/** §4.5 — participant-token TTL bounds: platform floor 1800 s (30 min), ceiling 7200 s (2 h). */
export const TELEHEALTH_TOKEN_TTL_FLOOR_SECONDS = 1_800;
export const TELEHEALTH_TOKEN_TTL_CEILING_SECONDS = 7_200;

/** A `fetch`-shaped transport (the global `fetch` by default; injected in unit tests — no real network). */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Construction deps for {@link DailyCoTelehealthProvider} (clock + transport injected → deterministic tests). */
export interface DailyCoTelehealthProviderDeps {
  /** Daily.co REST base, e.g. `https://api.daily.co/v1` — NEVER any PHI in the URL (D1). */
  readonly endpoint: string;
  /** Platform Daily.co API key (Bearer). Held only inside this adapter — never logged, never in an event. */
  readonly apiKey: string;
  /**
   * Server secret that keys the opaque room-name HMAC. Makes `mintRoom` idempotent on `telehealthVisitId`
   * without sending the visit id to the vendor. Rotating it re-mints rooms (acceptable — visits are short).
   */
  readonly roomNameSecret: string;
  /** Daily.co webhook signing secret (D13) — the HMAC base for {@link verifyWebhookSignature}. */
  readonly webhookSecret: string;
  /** Wall-clock as an ISO instant — injected so the breaker + token-expiry math are deterministic in tests. */
  readonly now: () => string;
  readonly fetchImpl?: FetchLike;
  readonly config?: TelehealthCircuitBreakerConfig;
  /** PHI-free correlation id for the degraded-error envelope (one per adapter instance). */
  readonly correlationId?: string;
}

interface DailyRoomBody {
  name: string;
  url: string;
}

interface DailyTokenBody {
  token: string;
}

interface DailyRecordingBody {
  id: string;
}

interface DailyRecordingStopBody {
  download_link?: string;
  duration?: number;
}

/**
 * §4.5 D1 — the Daily.co-backed telehealth adapter. Holds the breaker snapshot in-process (Valkey-backed in
 * prod). Implements the full {@link TelehealthProvider} surface; the audio-only track disable (§7.3) is a
 * CLIENT-side operation in the caller's browser SDK, so there is deliberately no server method for it here —
 * the backend records `audio_only_fallback_active` on the visit row (M31-T06) and emits the outbox event.
 */
export class DailyCoTelehealthProvider implements TelehealthProvider {
  readonly vendor = "daily_co" as const;

  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly roomNameSecret: string;
  private readonly webhookSecret: string;
  private readonly now: () => string;
  private readonly fetchImpl: FetchLike;
  private readonly config: TelehealthCircuitBreakerConfig;
  private readonly correlationId: string;
  private breaker: TelehealthBreakerSnapshot = INITIAL_TELEHEALTH_BREAKER_SNAPSHOT;

  constructor(deps: DailyCoTelehealthProviderDeps) {
    this.endpoint = deps.endpoint.replace(/\/+$/, "");
    this.apiKey = deps.apiKey;
    this.roomNameSecret = deps.roomNameSecret;
    this.webhookSecret = deps.webhookSecret;
    this.now = deps.now;
    this.fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
    this.config = deps.config ?? TELEHEALTH_CIRCUIT_BREAKER_CONFIG;
    this.correlationId = deps.correlationId ?? "daily_co";
  }

  /**
   * §7.2 step 2 — mint (or idempotently re-fetch) the vendor room. The room name is `tlh_<hmac(visitId)>`:
   * deterministic (idempotent on replay), opaque to the vendor, and provably NOT the raw visit id. A pre-flight
   * GET returns the existing room on replay; a 404 falls through to POST. PHI-free body.
   */
  async mintRoom(
    input: TelehealthMintRoomInput,
  ): Promise<{ vendorRoomId: string; vendorRoomUrl: string }> {
    const name = this.roomName(input.telehealthVisitId);
    const existing = await this.tryGetRoom("mintRoom", name);
    if (existing) return { vendorRoomId: existing.name, vendorRoomUrl: existing.url };

    const nbf = Math.floor(Date.parse(input.scheduledStartedAt) / 1000);
    const body = JSON.stringify({
      name,
      privacy: "private",
      properties: {
        // Vendor sees ONLY the opaque name + a TTL derived from the scheduled start — never PHI (D1).
        nbf: Number.isFinite(nbf) ? nbf : undefined,
        exp:
          (Number.isFinite(nbf) ? nbf : Math.floor(Date.parse(this.now()) / 1000)) +
          TELEHEALTH_TOKEN_TTL_CEILING_SECONDS,
        enable_recording: input.recordingEnabled ? "cloud" : undefined,
      },
    });
    const created = await this.call<DailyRoomBody>(
      "mintRoom",
      `${this.endpoint}/rooms`,
      "POST",
      body,
    );
    return { vendorRoomId: created.name, vendorRoomUrl: created.url };
  }

  /**
   * §4.5 / §7.2 step 4 — mint a per-participant short-TTL meeting token. `participantKind` is opaque; the
   * clinician is the room owner (`is_owner`), the patient/caregiver is not. TTL is clamped to the [30 min, 2 h]
   * platform bounds. No name / identity is ever sent — Daily binds the token to the room, not to a person.
   */
  async mintParticipantToken(
    input: TelehealthMintParticipantTokenInput,
  ): Promise<{ token: string; expiresAt: string }> {
    const ttl = clampTtl(input.ttlSeconds);
    const expUnix = Math.floor(Date.parse(this.now()) / 1000) + ttl;
    const body = JSON.stringify({
      properties: {
        room_name: input.vendorRoomId,
        is_owner: input.participantKind === "clinician",
        exp: expUnix,
      },
    });
    const minted = await this.call<DailyTokenBody>(
      "mintParticipantToken",
      `${this.endpoint}/meeting-tokens`,
      "POST",
      body,
    );
    return { token: minted.token, expiresAt: new Date(expUnix * 1000).toISOString() };
  }

  /** §4.5 — force-end (server-side delete) a room. Idempotent: a 404 on an already-gone room is a success. */
  async endRoom(vendorRoomId: string): Promise<void> {
    await this.call<unknown>(
      "endRoom",
      `${this.endpoint}/rooms/${encodeURIComponent(vendorRoomId)}`,
      "DELETE",
      undefined,
      {
        treat404AsSuccess: true,
      },
    );
  }

  /** §7.4 — start cloud recording on an active room (the D9 consent gate is enforced by M31 BEFORE this call). */
  async startRecording(vendorRoomId: string): Promise<{ vendorRecordingId: string }> {
    const started = await this.call<DailyRecordingBody>(
      "startRecording",
      `${this.endpoint}/rooms/${encodeURIComponent(vendorRoomId)}/recordings/start`,
      "POST",
      "{}",
    );
    return { vendorRecordingId: started.id };
  }

  /** §7.4 — stop recording; returns the vendor download link + duration (M31 downloads to tenant DEK storage). */
  async stopRecording(
    vendorRoomId: string,
    vendorRecordingId: string,
  ): Promise<{ recordingUrl: string; durationSec: number }> {
    const stopped = await this.call<DailyRecordingStopBody>(
      "stopRecording",
      `${this.endpoint}/rooms/${encodeURIComponent(vendorRoomId)}/recordings/${encodeURIComponent(vendorRecordingId)}/stop`,
      "POST",
      "{}",
    );
    return { recordingUrl: stopped.download_link ?? "", durationSec: stopped.duration ?? 0 };
  }

  /**
   * §7.2 step 2 / §7.4 / D13 — verify an inbound Daily.co webhook. The signature is HMAC-SHA256 (hex) of the
   * raw request body under the webhook secret, delivered in the `x-webhook-signature` header. Constant-time
   * compare; any missing header / malformed digest is a rejection, not a throw (a bad signature is not a
   * transport outage). NEVER logs the body.
   */
  verifyWebhookSignature(headers: Record<string, string>, rawBody: string): boolean {
    const provided = headerValue(headers, "x-webhook-signature");
    if (provided === null) return false;
    const expected = createHmac("sha256", this.webhookSecret).update(rawBody, "utf8").digest("hex");
    return hexEqual(expected, provided);
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────

  /** `tlh_<hmac(visitId)>` — opaque, deterministic, PHI-free. Never the raw visit id (§7.2 step 2 / D1). */
  private roomName(telehealthVisitId: string): string {
    const digest = createHmac("sha256", this.roomNameSecret)
      .update(telehealthVisitId, "utf8")
      .digest("hex");
    return `tlh_${digest.slice(0, 32)}`;
  }

  private async tryGetRoom(
    operation: TelehealthOperation,
    name: string,
  ): Promise<DailyRoomBody | null> {
    return this.call<DailyRoomBody>(
      operation,
      `${this.endpoint}/rooms/${encodeURIComponent(name)}`,
      "GET",
      undefined,
      { treat404AsSuccess: true, nullOn404: true },
    );
  }

  /**
   * The breaker-guarded transport: fail fast with a degraded error while the circuit is open (§7.3), otherwise
   * `fetch` with the §4.9 timeout and fold the outcome into the breaker. Any transport error is normalised to
   * {@link TelehealthDegradedError}. A 404 is treated per the caller's flag (idempotent DELETE / GET-probe).
   */
  private async call<T>(
    operation: TelehealthOperation,
    url: string,
    method: "GET" | "POST" | "DELETE",
    body?: string,
    opts?: { treat404AsSuccess?: boolean; nullOn404?: boolean },
  ): Promise<T> {
    const gate = evaluateTelehealthBreaker(this.breaker, this.now(), this.config);
    if (!gate.allowed) {
      throw this.degraded(
        operation,
        true,
        "Telehealth vendor is temporarily unavailable (circuit open).",
      );
    }
    try {
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      if (res.status === 404 && opts?.treat404AsSuccess) {
        this.breaker = applyTelehealthOutcome(this.breaker, "success", this.now(), this.config);
        return (opts.nullOn404 ? null : undefined) as T;
      }
      if (!res.ok) throw new Error(`daily-${operation}-http-${res.status}`);
      const json = (method === "DELETE" ? undefined : await res.json()) as T;
      this.breaker = applyTelehealthOutcome(this.breaker, "success", this.now(), this.config);
      return json;
    } catch (err) {
      if (err instanceof TelehealthDegradedError) throw err;
      this.breaker = applyTelehealthOutcome(this.breaker, "failure", this.now(), this.config);
      throw this.degraded(operation, true, "Telehealth vendor request failed.");
    }
  }

  private degraded(
    operation: TelehealthOperation,
    retryable: boolean,
    message: string,
  ): TelehealthDegradedError {
    return new TelehealthDegradedError(
      "daily_co",
      operation,
      retryable,
      message,
      this.correlationId,
    );
  }
}

/** Clamp a requested token TTL into the [30 min, 2 h] platform bounds (§4.5). */
export function clampTtl(ttlSeconds: number): number {
  if (!Number.isFinite(ttlSeconds)) return TELEHEALTH_TOKEN_TTL_FLOOR_SECONDS;
  return Math.min(
    Math.max(Math.floor(ttlSeconds), TELEHEALTH_TOKEN_TTL_FLOOR_SECONDS),
    TELEHEALTH_TOKEN_TTL_CEILING_SECONDS,
  );
}

/** Case-insensitive header lookup (webhook headers arrive with varying casing). */
function headerValue(headers: Record<string, string>, name: string): string | null {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return null;
}

/** Constant-time hex-digest comparison (the M13 witness-token `signaturesMatch` precedent). */
function hexEqual(expectedHex: string, providedHex: string): boolean {
  if (expectedHex.length !== providedHex.length || expectedHex.length === 0) return false;
  let expected: Buffer;
  let provided: Buffer;
  try {
    expected = Buffer.from(expectedHex, "hex");
    provided = Buffer.from(providedHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== provided.length || expected.length === 0) return false;
  return timingSafeEqual(expected, provided);
}
