// @wardenx/messaging — the `AlertEmitter` seam implementation (M36-T06, spec §4.6, §2.1).
//
// The boot wiring of the M36-T04 resolution/fan-out engine into the published `AlertEmitter`
// seam: `emit()` resolves the firing `alert_rule`s for the event, the recipients each names
// (dynamically, against the source-of-truth ports), and the per-recipient fan-out plan, then
// persists the alert + its `notification_delivery` rows. Pure orchestration over injected
// PORTS — exactly the M38 `TerminologyProvider`-over-`TerminologyStore` pattern: production
// injects Drizzle/seam-backed ports (M36-T07/T08); the in-memory slice below keeps boot + unit
// tests free of live infra and the source-module seams that have not landed yet.
//
// The §2.1 invariants are the engine's (M36-T04): in-app is the always-available floor for every
// recipient; out-of-band is additive per preference; voice is SOS-only; quiet-hours/vacation are
// evaluated fresh. This file only feeds the engine and counts the result.

import type { AlertEmitter } from "../interfaces/alert-emitter";
import type { AlertCategory, AlertSeverity, NotificationChannel } from "../interfaces/kinds";
import {
  type PlannedDelivery,
  type RecipientPreferences,
  type RecipientSourcePorts,
  type ResolverArgs,
  createRecipientResolverRegistry,
  planFanOut,
  resolveRecipients,
  severityAtLeast,
} from "../resolution";
import { PLATFORM_DEFAULT_ALERT_RULES } from "../seed/alert-rules";

/** A firing `alert_rule` as the emitter consumes it (§3.6) — the subset emit routes on. */
export interface EmitAlertRule {
  readonly category: AlertCategory;
  /** The rule's `alert_severity` floor; emit routes at max(input.severity, severityFloor). */
  readonly severityFloor: AlertSeverity;
  readonly recipientResolver: string;
  readonly resolverArgs: ResolverArgs;
  readonly channelsOverride: readonly NotificationChannel[] | null;
}

/** A persisted alert + its planned deliveries (the shape the in-memory sink records / a Drizzle
 *  adapter INSERTs). `alertId` is assigned by {@link AlertEmitterPorts.persist}. */
export interface PersistedAlert {
  readonly orgId: string;
  readonly eventType: string;
  readonly severity: AlertSeverity;
  readonly correlationId: string;
  /** The structured event payload (§3.6) — `alert.payload` is NOT NULL (GAP-096: this field was
   *  missing here even though `emit()`'s own input always carries one). */
  readonly payload: Record<string, unknown>;
  readonly deliveries: readonly PlannedDelivery[];
  /** F-191 — count a repeat of this `correlationId` instead of silently absorbing it (see `AlertEmitter.emit`). */
  readonly countRepeats?: boolean;
}

/**
 * The data/source-of-truth ports the {@link AlertEmitter} composes over. Every method is a plain
 * async boundary so the routing core stays pure and testable; production binds them to the M5/
 * M19/M2 recipient seams + Drizzle (M36-T07/T08), the slice binds them in-memory.
 */
export interface AlertEmitterPorts {
  /** Source-of-truth recipient lookups (care team / on call / role / discipline / broadcast). */
  readonly recipients: RecipientSourcePorts;
  /** The enabled `alert_rule`s firing for an event in this org (platform-defaults ∪ overrides). */
  rulesFor(orgId: string, eventType: string): Promise<readonly EmitAlertRule[]>;
  /** Notification preferences by user id (a user with no row → in-app floor only). */
  preferencesFor(
    orgId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, RecipientPreferences>>;
  /**
   * Persist the alert + its delivery plan; returns the new `alert.id`. A repeat of an existing `(org,
   * correlationId)` returns the EXISTING id and writes no deliveries. When `record.countRepeats`, it also returns
   * the alert's occurrence count after this call (1 for the first, +1 per absorbed repeat) — F-191.
   */
  persist(record: PersistedAlert): Promise<{ alertId: string; occurrences?: number }>;
  /** Evaluation clock — explicit so quiet-hours/vacation are deterministic in tests. */
  now(): Date;
}

/**
 * Compose the {@link AlertEmitter} seam over the given ports. `emit()`:
 *   1. loads the firing rules for `eventType` (no rule → a no-op alert, recipientCount 0);
 *   2. for each rule resolves recipients NOW (§2.1.3) and plans the fan-out at the effective
 *      severity max(input.severity, rule.severityFloor);
 *   3. persists one `alert` with the union of planned `notification_delivery` rows;
 *   4. returns its id + the distinct resolved-recipient count.
 */
export function createAlertEmitter(ports: AlertEmitterPorts): AlertEmitter {
  const registry = createRecipientResolverRegistry(ports.recipients);

  return {
    async emit(orgId, input) {
      const rules = await ports.rulesFor(orgId, input.eventType);
      const at = ports.now();

      const deliveries: PlannedDelivery[] = [];
      const recipientUnion = new Set<string>();

      for (const rule of rules) {
        const recipientUserIds = await resolveRecipients(
          registry,
          rule.recipientResolver,
          orgId,
          rule.resolverArgs,
          input.payload,
        );
        if (recipientUserIds.length === 0) continue;
        for (const id of recipientUserIds) recipientUnion.add(id);

        // Effective severity is the higher of the emit severity and the rule's floor (§3.6).
        const severity = severityAtLeast(input.severity, rule.severityFloor)
          ? input.severity
          : rule.severityFloor;

        const preferences = await ports.preferencesFor(orgId, recipientUserIds);
        deliveries.push(
          ...planFanOut({
            alert: { eventType: input.eventType, category: rule.category, severity },
            channelsOverride: rule.channelsOverride,
            recipientUserIds,
            preferences,
            at,
          }),
        );
      }

      const { alertId, occurrences } = await ports.persist({
        orgId,
        eventType: input.eventType,
        severity: input.severity,
        correlationId: input.correlationId,
        payload: input.payload,
        deliveries,
        ...(input.countRepeats ? { countRepeats: true } : {}),
      });
      return {
        alertId,
        resolvedRecipientCount: recipientUnion.size,
        ...(occurrences === undefined ? {} : { occurrences }),
      };
    },
  };
}

// ── In-memory slice default (no live infra) ──────────────────────────────────────────────────

/** A recorded alert in the in-memory sink — what a Drizzle adapter would have INSERTed. */
export interface RecordedAlert extends PersistedAlert {
  readonly alertId: string;
}

/** Optional overrides for {@link createInMemoryAlertEmitter}; everything defaults slice-safe. */
export interface InMemoryAlertEmitterOptions {
  /** Recipient source ports — default every lookup to empty (no source modules landed yet). */
  readonly recipients?: Partial<RecipientSourcePorts>;
  /** Firing rules per event — default to the enabled platform-default seed (§3.10). */
  readonly rulesFor?: (orgId: string, eventType: string) => readonly EmitAlertRule[];
  /** Preferences by user id — default empty (every recipient gets the in-app floor only). */
  readonly preferences?: ReadonlyMap<string, RecipientPreferences>;
  /** Fixed evaluation clock for deterministic tests. */
  readonly now?: () => Date;
}

const EMPTY_RECIPIENT_PORTS: RecipientSourcePorts = {
  careTeamMembers: async () => [],
  onCallMembers: async () => [],
  disciplineMembers: async () => [],
  roleSetMembers: async () => [],
  tenantAdmins: async () => [],
  orgMembers: async () => [],
};

/** Platform-default firing rules for an event (enabled rows only), as {@link EmitAlertRule}s. */
function platformRulesFor(eventType: string): EmitAlertRule[] {
  return PLATFORM_DEFAULT_ALERT_RULES.filter((r) => r.enabled && r.eventType === eventType).map(
    (r) => ({
      category: r.category,
      severityFloor: r.severityFloor,
      recipientResolver: r.recipientResolver,
      resolverArgs: r.resolverArgs,
      channelsOverride: r.channelsOverride,
    }),
  );
}

/**
 * Build an {@link AlertEmitter} over an in-memory sink — the boot slice default (the analogue of
 * M38's `createInMemoryTerminologyStore`). Returns the emitter plus the `recorded` array so tests
 * can assert the planned `notification_delivery` rows. Recipient lookups default to empty (the
 * source-module seams have not landed); inject `recipients` to exercise a real fan-out.
 */
export function createInMemoryAlertEmitter(options: InMemoryAlertEmitterOptions = {}): {
  emitter: AlertEmitter;
  recorded: RecordedAlert[];
} {
  const recorded: RecordedAlert[] = [];
  let seq = 0;
  // F-191 — occurrence counts for `countRepeats` alerts, keyed `org|correlationId` (the real table's unique key).
  const counted = new Map<string, { alertId: string; occurrences: number }>();
  const recipients: RecipientSourcePorts = { ...EMPTY_RECIPIENT_PORTS, ...options.recipients };
  const preferences = options.preferences ?? new Map<string, RecipientPreferences>();

  const emitter = createAlertEmitter({
    recipients,
    rulesFor: async (_orgId, eventType) =>
      options.rulesFor ? options.rulesFor(_orgId, eventType) : platformRulesFor(eventType),
    preferencesFor: async () => preferences,
    persist: async (record) => {
      const key = `${record.orgId}|${record.correlationId}`;
      const seen = record.countRepeats ? counted.get(key) : undefined;
      if (seen) {
        seen.occurrences += 1;
        return { alertId: seen.alertId, occurrences: seen.occurrences };
      }
      seq += 1;
      const alertId = `alert_${seq}`;
      recorded.push({ ...record, alertId });
      if (record.countRepeats) counted.set(key, { alertId, occurrences: 1 });
      return record.countRepeats ? { alertId, occurrences: 1 } : { alertId };
    },
    now: options.now ?? (() => new Date()),
  });

  return { emitter, recorded };
}
