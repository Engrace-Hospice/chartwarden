// M36 — the dedup key a cron/consumer alert is persisted under. `AlertEmitter.emit` collapses a repeat of an
// existing (org, correlationId) onto the first alert and writes no deliveries (alert-emitter-impl.ts), so a
// correlation id of just `<module>-cron:<alertCode>` meant the second NOE past its window in an org (or the
// same NOE tomorrow) never alerted anyone (GAP-035). Key on the subject entity ids in the payload plus the UTC
// day: each distinct entity alerts, and a still-unresolved condition re-alerts at most once a day.
//
// The clearinghouse held-work alerts (an organization whose clearinghouse is not live) have no entity ids: their subject is a queue
// and a reason, and their severity is part of what is being said (a held NOE is critical, a held claim a warning). Per UTC day and
// code they would collapse into one: a warning at 02:00 would absorb a critical for a NOE at 09:00, and the six-hour re-alert would
// never reach anyone. They are keyed on severity, queue and reason/code and on a six-hour window instead of the day.
import {
  CLEARINGHOUSE_HOLD_ALERT_CODES,
  CLEARINGHOUSE_HOLD_ALERT_WINDOW_MS,
  ChartWardenError,
} from "@chartwarden/types";

const DISCRIMINATOR_KEYS: ReadonlySet<string> = new Set([
  "macJurisdiction",
  "tier",
  "carcCode",
  "rarcCode",
  "up",
]);

/** The payload fields (besides `*Id`) that name what a held-work alert is about; `waiting` (a count) is deliberately not one. */
const HOLD_SUBJECT_KEYS: readonly string[] = ["code", "queue", "reason"];

const HOLD_ALERT_CODES: ReadonlySet<string> = new Set(
  Object.values(CLEARINGHOUSE_HOLD_ALERT_CODES),
);

/** True for the alerts raised when an organization has work held because its clearinghouse is not live. */
export const isClearinghouseHoldAlert = (alertCode: string): boolean =>
  HOLD_ALERT_CODES.has(alertCode);

function isDiscriminator(key: string): boolean {
  return key.endsWith("Id") || DISCRIMINATOR_KEYS.has(key);
}

const scalarsOf = (
  payload: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): (string | number | boolean)[] =>
  keys
    .map((k) => payload[k])
    .filter((v): v is string | number | boolean =>
      ["string", "number", "boolean"].includes(typeof v),
    );

/**
 * `severity` is read only for a held-work alert (see above); every other alert keeps its per-day key, whatever is passed.
 */
export function cronAlertCorrelationId(
  prefix: string,
  alertCode: string,
  payload: Readonly<Record<string, unknown>>,
  now: Date = new Date(),
  severity?: string,
): string {
  if (isClearinghouseHoldAlert(alertCode)) {
    const window = Math.floor(now.getTime() / CLEARINGHOUSE_HOLD_ALERT_WINDOW_MS);
    return [
      prefix,
      alertCode,
      severity ?? "",
      ...scalarsOf(payload, HOLD_SUBJECT_KEYS).map(String),
      `w${window}`,
    ]
      .filter((p) => p !== "")
      .join(":");
  }
  const subject = scalarsOf(payload, Object.keys(payload).filter(isDiscriminator).sort()).join(":");
  const day = now.toISOString().slice(0, 10);
  return [prefix, alertCode, subject, day].filter((p) => p !== "").join(":");
}

/**
 * What the held-work alert's sender needs of `AlertEmitter.emit`'s answer: an alert that resolved NO recipient was persisted (and its
 * window's id is taken) but reaches nobody. The sender's quiet window must not start for it, so it is a typed failure there (the
 * hold's own catch logs the code and tries again at the next held job; the emitter absorbs the retry until the window turns over).
 * Any other alert is untouched.
 */
export function assertHoldAlertHadRecipients(alertCode: string, emitted: unknown): void {
  if (!isClearinghouseHoldAlert(alertCode)) return;
  const count = (emitted as { resolvedRecipientCount?: unknown } | null)?.resolvedRecipientCount;
  if (count === 0) {
    throw new ChartWardenError(
      "ALERT_NO_RECIPIENT",
      "the held-work alert resolved no recipient: it is recorded but reaches nobody",
      503,
    );
  }
}

/** What a cron's alert port needs of the emitter seam (the composition root binds `getSeam("AlertEmitter")`). */
export interface CronAlertEmitter {
  emit(
    orgId: string,
    input: {
      eventType: string;
      payload: Record<string, unknown>;
      severity: string;
      correlationId: string;
    },
  ): Promise<unknown>;
}

/**
 * Emit one cron alert for one organization under its dedupe key ({@link cronAlertCorrelationId}), and refuse a held-work alert that
 * addressed nobody ({@link assertHoldAlertHadRecipients}). The M23 and M41 alert ports both send through this.
 */
export async function emitCronAlert(
  emitter: CronAlertEmitter,
  prefix: string,
  organizationId: string,
  alert: {
    readonly alertCode: string;
    readonly severity: string;
    readonly payload: Record<string, unknown>;
  },
  now: Date = new Date(),
): Promise<void> {
  const emitted = await emitter.emit(organizationId, {
    eventType: alert.alertCode,
    payload: alert.payload,
    severity: alert.severity,
    correlationId: cronAlertCorrelationId(
      prefix,
      alert.alertCode,
      alert.payload,
      now,
      alert.severity,
    ),
  });
  assertHoldAlertHadRecipients(alert.alertCode, emitted);
}
