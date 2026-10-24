// M36 WP 6.10 (ADR-0101, PROPOSED) - the pure core of alarm ingest: the sender credential, the HMAC signature, the replay window, the severity
// cap and the body digest. No I/O, no clock (the instant is an argument), no logging. The HMAC key is the per-source secret, which the service
// opens from its envelope only after the cheap, secret-free checks (key id shape, timestamp window, signature shape) have passed.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ALARM_INGEST_REPLAY_WINDOW_SECONDS,
  ALARM_INGEST_SIGNATURE_PREFIX,
  type AlarmRequestedSeverity,
  type AlarmSeverityCeiling,
} from "@chartwarden/types";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY_ID_RE = new RegExp(`^(${UUID})\\.(${UUID})$`, "i");
const SIGNATURE_RE = /^v1=[0-9a-f]{64}$/;
/** Epoch SECONDS, 10 digits (until 2286): a strict shape, no ISO date, no milliseconds, no sign. */
const TIMESTAMP_RE = /^\d{10}$/;
const SECRET_PREFIX = "wxas_";

/** A new sender secret: 256 random bits, shown once. */
export function newAlarmSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** The credential id the sender is configured with: `<organizationId>.<sourceId>`. The org selects the RLS scope of the one lookup. */
export function alarmKeyId(organizationId: string, sourceId: string): string {
  return `${organizationId}.${sourceId}`;
}

export function parseAlarmKeyId(
  value: unknown,
): { readonly organizationId: string; readonly sourceId: string } | null {
  if (typeof value !== "string") return null;
  const m = KEY_ID_RE.exec(value);
  return m ? { organizationId: m[1]!.toLowerCase(), sourceId: m[2]!.toLowerCase() } : null;
}

/** `v1=` + hex HMAC-SHA256 over `<timestamp>.<keyId>.<rawBody>`: the timestamp and the credential id are signed, so neither can be swapped. */
export function signAlarmRequest(input: {
  readonly secret: string;
  readonly keyId: string;
  readonly timestamp: string;
  readonly rawBody: string;
}): string {
  const mac = createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.keyId}.`, "utf8")
    .update(input.rawBody, "utf8")
    .digest("hex");
  return `${ALARM_INGEST_SIGNATURE_PREFIX}${mac}`;
}

/** Constant-time. A malformed signature is simply "no match". */
export function alarmSignatureMatches(
  input: Parameters<typeof signAlarmRequest>[0],
  provided: unknown,
): boolean {
  if (typeof provided !== "string" || !SIGNATURE_RE.test(provided)) return false;
  const expected = Buffer.from(signAlarmRequest(input), "utf8");
  const actual = Buffer.from(provided, "utf8");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function isAlarmSignatureShape(value: unknown): value is string {
  return typeof value === "string" && SIGNATURE_RE.test(value);
}

/** True when `value` is a well-formed epoch-seconds string within the +-300 s window of `nowMs`. */
export function inAlarmReplayWindow(value: unknown, nowMs: number): boolean {
  if (typeof value !== "string" || !TIMESTAMP_RE.test(value)) return false;
  return Math.abs(nowMs / 1000 - Number(value)) <= ALARM_INGEST_REPLAY_WINDOW_SECONDS;
}

/** Hex SHA-256 of the exact bytes received: the stored fingerprint of an event (an id reused with a different body is a conflict). */
export function alarmPayloadDigest(rawBody: string): string {
  return createHash("sha256").update(rawBody, "utf8").digest("hex");
}

const SEVERITY_RANK: Readonly<Record<AlarmRequestedSeverity, number>> = {
  info: 0,
  warn: 1,
  critical: 2,
};

/**
 * TIGHTEN-ONLY severity: the effective severity is the sender's request (default `info`), CAPPED at the mapping's ceiling, which is itself
 * `info` or `warn`. Nothing the sender sends can raise it above the ceiling, and nothing can make it `critical`.
 */
export function effectiveAlarmSeverity(
  requested: AlarmRequestedSeverity | undefined,
  ceiling: AlarmSeverityCeiling,
): AlarmSeverityCeiling {
  const asked = requested ?? "info";
  return SEVERITY_RANK[asked] > SEVERITY_RANK[ceiling] ? ceiling : (asked as AlarmSeverityCeiling);
}
