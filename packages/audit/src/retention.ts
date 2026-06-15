// @wardenx/audit — retention-class registry (M1 spec §8.1, ADR-0004 / M4 D1).
//
// Every audit event is filed under a retention class that decides how long its monthly
// partition is kept before cold-archive + drop:
//   - operational : 1 year      (ops telemetry — partition rotation, etc.)
//   - compliance  : 7 years     (HIPAA floor 6 — §164.316(b)(2); standardized to 7)
//   - legal_hold  : indefinite  (under a legal hold)
//
// `compliance` is the safe DEFAULT: an unclassified event is kept as long as a routine
// compliance record needs, never accidentally short. The registry lets a module declare the
// (small) set of event types that are merely operational so they age out after a year.

/** The three audit retention classes (mirrors the `audit_retention_class` pg enum). */
export type RetentionClass = "operational" | "compliance" | "legal_hold";

/** The fail-safe class for any event type not explicitly registered. */
export const DEFAULT_RETENTION_CLASS: RetentionClass = "compliance";

const registry = new Map<string, RetentionClass>();

/** Register the retention class for an event type (idempotent; last write wins). */
export function registerRetention(eventType: string, retentionClass: RetentionClass): void {
  registry.set(eventType, retentionClass);
}

/**
 * Resolve the retention class for an event: an explicit per-call class wins, then the
 * registry, then the compliance default.
 */
export function resolveRetention(eventType: string, explicit?: RetentionClass): RetentionClass {
  return explicit ?? registry.get(eventType) ?? DEFAULT_RETENTION_CLASS;
}

/** Seed the retention classes for the audit events Module 1 emits (spec §8.1). */
export function registerM1Retention(): void {
  // Operational telemetry — kept ~1 year, not a compliance artifact.
  registerRetention("audit.partition_created", "operational");
  registerRetention("audit.partition_archived", "operational");
  // Every other M1 event (org.*, provider_entity.*, location.*, feature_flag.updated,
  // system_status.changed, platform.bypass_invoked) is `compliance` — the default.
}

/** Test/boot reset hook — clears overrides, then re-seeds the M1 defaults. */
export function resetRetentionRegistry(): void {
  registry.clear();
  registerM1Retention();
}

registerM1Retention();
