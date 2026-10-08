// M36 — the dedup key a cron/consumer alert is persisted under. `AlertEmitter.emit` collapses a repeat of an
// existing (org, correlationId) onto the first alert and writes no deliveries (alert-emitter-impl.ts), so a
// correlation id of just `<module>-cron:<alertCode>` meant the second NOE past its window in an org (or the
// same NOE tomorrow) never alerted anyone (GAP-035). Key on the subject entity ids in the payload plus the UTC
// day: each distinct entity alerts, and a still-unresolved condition re-alerts at most once a day.
const DISCRIMINATOR_KEYS: ReadonlySet<string> = new Set([
  "macJurisdiction",
  "tier",
  "carcCode",
  "rarcCode",
  "up",
]);

function isDiscriminator(key: string): boolean {
  return key.endsWith("Id") || DISCRIMINATOR_KEYS.has(key);
}

export function cronAlertCorrelationId(
  prefix: string,
  alertCode: string,
  payload: Readonly<Record<string, unknown>>,
  now: Date = new Date(),
): string {
  const subject = Object.keys(payload)
    .filter(isDiscriminator)
    .sort()
    .map((k) => payload[k])
    .filter((v): v is string | number | boolean =>
      ["string", "number", "boolean"].includes(typeof v),
    )
    .join(":");
  const day = now.toISOString().slice(0, 10);
  return [prefix, alertCode, subject, day].filter((p) => p !== "").join(":");
}
