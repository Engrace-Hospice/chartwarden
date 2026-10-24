// M36 WP 6.10 (ADR-0102, PROPOSED) - alarm ingest, WATCH ONLY: a third-party alarm (nurse call, bed or fall sensor, monitor) becomes an ordinary
// M36 ALERT through the existing alert catalog and fan-out. It is NOT a nurse-call system and NOT an emergency path: it never creates an
// acknowledgment request, never enters the escalation ladder and never pages by itself (in-app only by default). Constants and DTOs shared by the
// backend and the web. The closed sets and numeric bounds are pinned against migration 1250 by a test.

/** Tenant flag (absent = off): gates the inbound route and creating or rotating a source; listing and disabling never depend on it. */
export const ALARM_INGEST_FLAG_KEY = "messaging.alarm_ingest" as const;

export const ALARM_INGEST_MANAGE_PERMISSION = "messaging.alarm_ingest.manage" as const;
/** Fresh step-up action for create, rotate and disable. */
export const ALARM_INGEST_MANAGE_STEP_UP_KEY = "messaging.alarm_ingest.manage" as const;

/**
 * The catalog alert types an alarm may map to (platform seed rules in @chartwarden/messaging; non-locked, severity floor info, in-app only).
 * CHECK `alarm_source_mapping_alert_type`. Deliberately NONE of the urgent, acknowledgment, SOS or locked event types.
 */
export const ALARM_INGEST_ALERT_TYPES = [
  "alarm_ingest.nurse_call",
  "alarm_ingest.patient_sensor",
  "alarm_ingest.equipment",
] as const;
export type AlarmIngestAlertType = (typeof ALARM_INGEST_ALERT_TYPES)[number];

/** The most urgent an inbound alarm can ever be: `warn`. CHECK `alarm_source_mapping_ceiling` and `alarm_ingest_event_effective_severity`. */
export const ALARM_SEVERITY_CEILINGS = ["info", "warn"] as const;
export type AlarmSeverityCeiling = (typeof ALARM_SEVERITY_CEILINGS)[number];
/** What a sender may ASK for; anything above the mapping's ceiling is capped, never raised. */
export const ALARM_REQUESTED_SEVERITIES = ["info", "warn", "critical"] as const;
export type AlarmRequestedSeverity = (typeof ALARM_REQUESTED_SEVERITIES)[number];

/** CHECK `alarm_ingest_event_status`. received -> alerted | no_recipients (forward only); unmapped is born final. */
export const ALARM_INGEST_EVENT_STATUSES = [
  "received",
  "alerted",
  "no_recipients",
  "unmapped",
] as const;
export type AlarmIngestEventStatus = (typeof ALARM_INGEST_EVENT_STATUSES)[number];

/** Bounds, pinned against the SQL CHECKs. */
export const ALARM_SOURCE_NAME_MAX = 120;
export const ALARM_KIND_PATTERN = "^[a-z0-9_]{1,40}$";
export const ALARM_EVENT_ID_PATTERN = "^[A-Za-z0-9._:-]{1,64}$";
export const ALARM_MAX_MAPPINGS_PER_SOURCE = 20;
export const ALARM_MAX_SOURCES_PER_TENANT = 20;
/** The inbound body is tiny and has no free-text field at all (no PHI vector). Enforced as the route's bodyLimit. */
export const ALARM_INGEST_MAX_BODY_BYTES = 1024;
/** Replay window, seconds either side of the server clock (the M36 webhook window, 300 s). */
export const ALARM_INGEST_REPLAY_WINDOW_SECONDS = 300;
/** An optional device timestamp must be within this many seconds of the server clock, else it is refused (clock skew is not silently trusted). */
export const ALARM_INGEST_OCCURRED_AT_SKEW_SECONDS = 86_400;
/** Budgets: per client address before any database work, then per source after the signature is proven. */
export const ALARM_INGEST_IP_BUDGET_PER_MINUTE = 300;
export const ALARM_INGEST_SOURCE_BUDGET_PER_MINUTE = 60;

/** HTTP 503 from create and rotate when per-address budgets cannot key on a real client address (no valid TRUSTED_PROXY_CIDRS in production). */
export const ALARM_INGEST_UNAVAILABLE_CODE = "ALARM_INGEST_UNAVAILABLE" as const;

/** Request headers of the inbound route (lower-case). Registered in scripts/check-request-header-auth.ts. */
export const ALARM_INGEST_KEY_ID_HEADER = "x-wx-key-id";
export const ALARM_INGEST_TIMESTAMP_HEADER = "x-wx-timestamp";
export const ALARM_INGEST_SIGNATURE_HEADER = "x-wx-signature";
export const ALARM_INGEST_SIGNATURE_PREFIX = "v1=";

/**
 * The ONLY text an alarm alert carries (the inbox `summary`). A constant: no sender text, location or patient can enter it, and no out-of-band
 * payload is built from it (the sanitiser is an allowlist). It is also what the screen says an alarm is: a notice, not a call for help.
 */
export const ALARM_INGEST_ALERT_MESSAGE =
  "An external system reported an alarm. This is a notice only and does not replace the nurse-call or monitoring system.";

export interface AlarmMappingInput {
  readonly alarmKind: string;
  readonly alertType: AlarmIngestAlertType;
  readonly severityCeiling: AlarmSeverityCeiling;
}

export interface CreateAlarmSourceRequest {
  readonly name: string;
  readonly mappings: readonly AlarmMappingInput[];
}

export interface AlarmSourceCounts {
  readonly alerted: number;
  readonly noRecipients: number;
  readonly unmapped: number;
  readonly pending: number;
}

export interface AlarmSourceDto {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly secretGeneration: number;
  readonly createdAt: string;
  readonly rotatedAt: string | null;
  readonly disabledAt: string | null;
  readonly lastAcceptedAt: string | null;
  readonly mappings: readonly AlarmMappingInput[];
  /** Events in the last 24 hours by outcome: a silent drop is a number on the screen. */
  readonly last24h: AlarmSourceCounts;
}

/** Returned ONCE at creation and at rotation: the credential the sender is configured with. The secret is never readable again. */
export interface AlarmSourceCredentialDto extends AlarmSourceDto {
  readonly keyId: string;
  readonly secret: string;
}

export interface AlarmIngestAcceptedDto {
  readonly status: "accepted" | "duplicate";
  readonly outcome: AlarmIngestEventStatus;
}
