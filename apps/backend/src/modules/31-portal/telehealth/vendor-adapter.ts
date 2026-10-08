// apps/backend/src/modules/31-portal/telehealth/vendor-adapter.ts - binds the Daily.co `TelehealthProvider`
// (`@wardenx/telehealth-client`) to the route-facing `TelehealthAdapterPort` (GAP-051).
//
// CONFIG-DRIVEN. The adapter is bound only when ALL FOUR settings are present; with any missing the factory returns
// `undefined` and the routes keep their fail-closed NOOP (join/start-recording 503, webhooks 401) rather than
// reaching a vendor with a half-configured key:
//   TELEHEALTH_DAILY_API_KEY          Daily.co REST bearer key (held inside the adapter, never logged)
//   TELEHEALTH_DAILY_WEBHOOK_SECRET   HMAC base for the inbound webhook signature (D13)
//   TELEHEALTH_ROOM_NAME_SECRET       keys the opaque `tlh_<hmac(visitId)>` room name (D1, PHI-free)
//   TELEHEALTH_DAILY_ENDPOINT         optional REST base (default https://api.daily.co/v1)
// These are PLATFORM-level settings: one Daily.co account fronts every tenant, and the vendor only ever sees the
// opaque room name, so a per-tenant key vault would add isolation the vendor boundary does not need. Rotating
// TELEHEALTH_ROOM_NAME_SECRET re-mints rooms.
import { DailyCoTelehealthProvider } from "@wardenx/telehealth-client";
import type { TelehealthAdapterPort } from "../routes/index";

/** Participant-token lifetime handed to the vendor (the adapter clamps to its [30 min, 2 h] platform bounds). */
export const TELEHEALTH_PARTICIPANT_TOKEN_TTL_SECONDS = 3_600;
const DEFAULT_DAILY_ENDPOINT = "https://api.daily.co/v1";

type EnvLike = Readonly<Record<string, string | undefined>>;

const present = (value: string | undefined): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Bridge a {@link DailyCoTelehealthProvider} to the route port (which addresses tokens by VISIT id). */
export function toTelehealthAdapterPort(
  provider: DailyCoTelehealthProvider,
): TelehealthAdapterPort {
  return {
    vendor: provider.vendor,
    mintRoom: (input) => provider.mintRoom(input),
    mintParticipantToken: ({ telehealthVisitId, role }) =>
      provider.mintParticipantToken({
        vendorRoomId: provider.roomNameForVisit(telehealthVisitId),
        participantKind: role,
        ttlSeconds: TELEHEALTH_PARTICIPANT_TOKEN_TTL_SECONDS,
      }),
    endRoom: (vendorRoomId) => provider.endRoom(vendorRoomId),
    startRecording: (vendorRoomId) => provider.startRecording(vendorRoomId),
    stopRecording: (vendorRoomId, vendorRecordingId) =>
      provider.stopRecording(vendorRoomId, vendorRecordingId),
    verifyWebhookSignature: (headers, rawBody) => provider.verifyWebhookSignature(headers, rawBody),
  };
}

/** The Daily.co route adapter when fully configured, else `undefined` (the routes stay fail-closed). */
export function buildDailyTelehealthAdapter(
  env: EnvLike,
  now: () => string = () => new Date().toISOString(),
): TelehealthAdapterPort | undefined {
  const apiKey = env.TELEHEALTH_DAILY_API_KEY;
  const webhookSecret = env.TELEHEALTH_DAILY_WEBHOOK_SECRET;
  const roomNameSecret = env.TELEHEALTH_ROOM_NAME_SECRET;
  if (!present(apiKey) || !present(webhookSecret) || !present(roomNameSecret)) return undefined;
  return toTelehealthAdapterPort(
    new DailyCoTelehealthProvider({
      endpoint: present(env.TELEHEALTH_DAILY_ENDPOINT)
        ? env.TELEHEALTH_DAILY_ENDPOINT
        : DEFAULT_DAILY_ENDPOINT,
      apiKey,
      webhookSecret,
      roomNameSecret,
      now,
    }),
  );
}
