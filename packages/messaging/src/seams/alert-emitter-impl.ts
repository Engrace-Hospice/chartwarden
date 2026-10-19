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
  DESIGNATED_EVENT_TYPES,
  type PlannedDelivery,
  type PolicyTrailEntry,
  type RecipientPreferences,
  type RecipientResolverFn,
  type RecipientSourcePorts,
  type ResolverArgs,
  createRecipientResolverRegistry,
  designatedClassOf,
  isSnoozableEvent,
  planFanOutDetailed,
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
  /** F-199 — count a repeat of this `correlationId` instead of silently absorbing it (see `AlertEmitter.emit`). */
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
   * the alert's occurrence count after this call (1 for the first, +1 per absorbed repeat) — F-199.
   */
  persist(record: PersistedAlert): Promise<{ alertId: string; occurrences?: number }>;
  /**
   * WP 4.6 (ADR-0073) — is the notification policy on for this tenant and this event (its ops flag AND the flag of the event's
   * family)? Absent = off = the engine exactly as before (the seeded in-app-only rules stay in-app only). A throw propagates:
   * the emit fails and the outbox retries; a flag we could not read never silently downgrades a safety route.
   */
  policyEnabledFor?(orgId: string, eventType: string): Promise<boolean>;
  /**
   * WP 4.6 — per user, the channels on which they have a VERIFIED endpoint (voice rides on `sms`). A user absent from the map has
   * none. Never returns an endpoint value. A throw propagates (retry), for the same reason.
   */
  verifiedChannelsFor?(
    orgId: string,
    userIds: readonly string[],
  ): Promise<ReadonlyMap<string, ReadonlySet<NotificationChannel>>>;
  /**
   * WP 4.10 (ADR-0077) — which of these users have an ACTIVE conversation snooze for `channelId`? Asked only for an allowlisted
   * non-urgent alert that carries a `channelId`; the port itself answers empty while the tenant flag is off and never reports a
   * snooze that an open acknowledgment request makes void. A throw propagates (the outbox retries): never a silent "not snoozed"
   * for a notice the user asked to quiet, and never a silent "snoozed" either.
   */
  snoozedUsersFor?(
    orgId: string,
    channelId: string,
    userIds: readonly string[],
    messageId: string,
  ): Promise<ReadonlySet<string>>;
  /** Evaluation clock — explicit so quiet-hours/vacation are deterministic in tests. */
  now(): Date;
  /**
   * GAP-057 — the composition root's hook to register OTHER modules' recipient resolvers (M34's
   * `compliance_officer_for_tenant` / `platform_security_owner`, ADR-0024 style) onto the registry this
   * emitter resolves against. M36 cannot import those modules, so they are injected here. Called once at
   * construction, after the seven built-ins are in place.
   */
  readonly extendResolvers?: (registry: Map<string, RecipientResolverFn>) => void;
}

/**
 * WP 4.6: a tenant `alert_rule` row may shadow a platform rule, but for the four DESIGNATED events the recipients are the platform
 * rule's, always: a tenant row cannot re-aim a safety alert at someone else (it may still add channels). Not designated = unchanged.
 */
function pinDesignatedRule(rule: EmitAlertRule, eventType: string): EmitAlertRule {
  if (!DESIGNATED_EVENT_TYPES.has(eventType)) return rule;
  const platform = PLATFORM_DEFAULT_ALERT_RULES.find((r) => r.eventType === eventType);
  if (!platform) return rule;
  return {
    ...rule,
    category: platform.category,
    recipientResolver: platform.recipientResolver,
    resolverArgs: platform.resolverArgs,
  };
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
  ports.extendResolvers?.(registry);

  /** WP 4.10: the snoozed recipients of an allowlisted, channel-keyed, non-designated alert; undefined = nothing to look up. */
  async function snoozedFor(
    orgId: string,
    input: { readonly eventType: string; readonly payload: Record<string, unknown> },
    userIds: readonly string[],
  ): Promise<ReadonlySet<string> | undefined> {
    if (!ports.snoozedUsersFor || !isSnoozableEvent(input.eventType)) return undefined;
    const channelId = input.payload.channelId;
    const messageId = input.payload.messageId;
    if (typeof channelId !== "string" || channelId.length === 0) return undefined;
    // No message id = nothing to prove routine = no snooze (fail safe: the notice goes out).
    if (typeof messageId !== "string" || messageId.length === 0) return undefined;
    return ports.snoozedUsersFor(orgId, channelId, userIds, messageId);
  }

  return {
    async emit(orgId, input) {
      const { policyTrail: _callerTrail, ...callerPayload } = input.payload; // a caller cannot forge the trail
      const at = ports.now();

      const deliveries: PlannedDelivery[] = [];
      const trail: PolicyTrailEntry[] = [];
      const recipientUnion = new Set<string>();
      // Only a designated event ever reads the flag: every other alert is exactly as before the policy existed.
      const designatedClass = designatedClassOf(input.eventType, input.payload);
      const designated =
        designatedClass !== null &&
        (await ports.policyEnabledFor?.(orgId, input.eventType)) === true
          ? designatedClass
          : null;
      // The pin is part of the policy: with the flag off, stored rules apply exactly as before.
      const stored = await ports.rulesFor(orgId, input.eventType);
      const rules = designated ? stored.map((r) => pinDesignatedRule(r, input.eventType)) : stored;

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
        const snoozedUserIds = await snoozedFor(orgId, input, recipientUserIds);
        const planned = planFanOutDetailed({
          alert: { eventType: input.eventType, category: rule.category, severity },
          channelsOverride: rule.channelsOverride,
          recipientUserIds,
          preferences,
          at,
          ...(snoozedUserIds ? { snoozedUserIds } : {}),
          ...(designated
            ? {
                policy: {
                  ackClass: designated.ackClass,
                  classDefaulted: designated.defaulted,
                  verifiedChannels:
                    (await ports.verifiedChannelsFor?.(orgId, recipientUserIds)) ?? new Map(),
                },
              }
            : {}),
        });
        deliveries.push(...planned.plan);
        trail.push(...planned.trail);
      }

      const { alertId, occurrences } = await ports.persist({
        orgId,
        eventType: input.eventType,
        severity: input.severity,
        correlationId: input.correlationId,
        // WP 4.6: the explained policy decisions of a designated route ride on the alert (ids and codes only).
        payload: trail.length > 0 ? { ...callerPayload, policyTrail: trail } : callerPayload,
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
  /** WP 4.6: the notification policy is ON for these event types (default: off everywhere). */
  readonly policyEnabledEventTypes?: ReadonlySet<string>;
  /** WP 4.6: verified-endpoint channels per user (default: none). */
  readonly verifiedChannels?: ReadonlyMap<string, ReadonlySet<NotificationChannel>>;
  /** WP 4.10: users with an active snooze of every conversation (default: none). */
  readonly snoozedUsers?: ReadonlySet<string>;
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
  // F-199 — occurrence counts for `countRepeats` alerts, keyed `org|correlationId` (the real table's unique key).
  const counted = new Map<string, { alertId: string; occurrences: number }>();
  const recipients: RecipientSourcePorts = { ...EMPTY_RECIPIENT_PORTS, ...options.recipients };
  const preferences = options.preferences ?? new Map<string, RecipientPreferences>();

  const emitter = createAlertEmitter({
    recipients,
    rulesFor: async (_orgId, eventType) =>
      options.rulesFor ? options.rulesFor(_orgId, eventType) : platformRulesFor(eventType),
    preferencesFor: async () => preferences,
    policyEnabledFor: async (_orgId, eventType) =>
      options.policyEnabledEventTypes?.has(eventType) === true,
    verifiedChannelsFor: async () => options.verifiedChannels ?? new Map(),
    snoozedUsersFor: async (_orgId, _channelId, userIds) =>
      new Set(userIds.filter((id) => options.snoozedUsers?.has(id) === true)),
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
