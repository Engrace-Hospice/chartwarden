import { createHmac } from "node:crypto";
import type { EvvEventKind } from "@chartwarden/types";

export const EVV_OFFLINE_FINGERPRINT_KEY_ENV = "EVV_OFFLINE_FINGERPRINT_KEY";
export const EVV_OFFLINE_FINGERPRINT_KEY_ID = "v1";

export interface OfflineCaptureFingerprintInput {
  readonly organizationId: string;
  readonly postingMembershipId: string;
  readonly evvDeviceId: string;
  readonly localId: string;
  readonly kind: EvvEventKind;
  readonly visitId: string;
  readonly capturedAt: string;
  readonly coords: { readonly lat: number; readonly lng: number };
  readonly accuracyM: number;
  readonly gpsQualityAttested?: "degraded_attested";
  readonly serviceTypeCode?: string;
}

/**
 * Fixed-position canonical form: parsed JSON number spellings and equivalent ISO offsets collapse to one
 * representation. It is never persisted or logged; only HMAC-SHA-256 is stored in the receipt.
 */
export function canonicalOfflineCapture(input: OfflineCaptureFingerprintInput): string {
  return JSON.stringify([
    1,
    input.organizationId,
    input.postingMembershipId,
    input.evvDeviceId,
    input.localId,
    input.kind,
    input.visitId,
    new Date(input.capturedAt).toISOString(),
    input.coords.lat,
    input.coords.lng,
    input.accuracyM,
    input.gpsQualityAttested ?? null,
    input.serviceTypeCode ?? null,
  ]);
}

export function fingerprintOfflineCapture(
  input: OfflineCaptureFingerprintInput,
  key: string,
): string {
  return createHmac("sha256", key).update(canonicalOfflineCapture(input), "utf8").digest("hex");
}

export function offlineFingerprintKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env[EVV_OFFLINE_FINGERPRINT_KEY_ENV];
  if (key && key.length >= 32) return key;
  if (env.NODE_ENV === "production") {
    throw new Error(`${EVV_OFFLINE_FINGERPRINT_KEY_ENV} is required in production`);
  }
  // Test/development only. Production validation and the branch above prevent deployment with this value.
  return "wardenx-development-only-evv-offline-fingerprint-key";
}
