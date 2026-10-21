// @chartwarden/messaging — Alert Payload Catalog: Foundation Registry + boot validation
// (M36-T05; spec §3.11–3.12, M36-F01).
//
// The typed alert-payload registry mirrors M1's outbox-event catalog and M4's audit-action
// catalog: a per-module CONTRIBUTION (`ModuleAlertContribution`, @chartwarden/types) is aggregated
// into one validated catalog, the boot UPSERT projects it into `alert_payload_catalog` (§3.11.2),
// and dispatch (§4.6.1) validates every emit against the registered TypeBox `payloadSchema`.
//
// M36 is FOUNDATION-TIER (M36-F01): its `dependsOn` is `[1,2,3,4]` and it must NOT import any
// later producer module. So this aggregator NEVER hardcodes a producer's slice (unlike M4's
// action catalog, whose slices live inside @chartwarden/audit). Instead each later module REGISTERS
// its contribution at ITS OWN boot via {@link createAlertPayloadRegistry} — no import edge. M36
// ships the infra + the boot gate; it validates whatever was registered without knowing the
// producers statically. The build is FAIL-CLOSED: a duplicate `payloadType` or a namespace
// violation throws rather than letting one producer silently shadow another (§3.12).
import type {
  AlertPayloadCatalogRow,
  AlertPayloadEntry,
  AlertPayloadSeverity,
  ModuleAlertContribution,
} from "@chartwarden/types";
import { ALERT_PAYLOAD_SEVERITY_ORDER } from "@chartwarden/types";

const VALID_SEVERITIES = new Set<AlertPayloadSeverity>(ALERT_PAYLOAD_SEVERITY_ORDER);
const PAYLOAD_PREFIX = /^(m\d+)\./; // mN.<resource>.<verb> — the owner the prefix implies

/** Thrown when two modules register the same `payloadType` (§3.12 — one owner per payload). */
export class AlertPayloadCollisionError extends Error {
  constructor(
    readonly payloadType: string,
    readonly firstModule: string,
    readonly secondModule: string,
  ) {
    super(
      `alert_payload_collision: '${payloadType}' is registered by both '${firstModule}' and ` +
        `'${secondModule}' — a payload type may be owned by one module only`,
    );
    this.name = "AlertPayloadCollisionError";
  }
}

/** A single namespacing/shape violation surfaced by {@link validateAlertPayloadCatalog} (§3.12). */
export interface AlertPayloadCatalogViolation {
  readonly payloadType: string;
  /** `wrong_namespace`: owner ≠ the `mN.` prefix; `bad_severity`/`empty_channels`/`empty_resolver`:
   *  the entry is malformed; `duplicate`: the payload type is declared twice. */
  readonly type:
    | "wrong_namespace"
    | "bad_severity"
    | "empty_channels"
    | "empty_resolver"
    | "duplicate";
  readonly detail: string;
}

/** Flatten registered contributions into a single entry list (preserves registration order). */
function flatten(contributions: readonly ModuleAlertContribution[]): readonly AlertPayloadEntry[] {
  return contributions.flatMap((c) => [...c]);
}

/**
 * Aggregate `contributions` into a `payloadType → entry` map, rejecting duplicates with
 * {@link AlertPayloadCollisionError}. Pure and total over its input — pass synthetic
 * contributions to unit-test the collision guard.
 */
export function buildAlertPayloadCatalog(
  contributions: readonly ModuleAlertContribution[],
): ReadonlyMap<string, AlertPayloadEntry> {
  const byType = new Map<string, AlertPayloadEntry>();
  for (const entry of flatten(contributions)) {
    const existing = byType.get(entry.payloadType);
    if (existing) {
      throw new AlertPayloadCollisionError(
        entry.payloadType,
        existing.moduleOwner,
        entry.moduleOwner,
      );
    }
    byType.set(entry.payloadType, entry);
  }
  return byType;
}

/**
 * Validate the catalog's namespacing + entry shape (§3.12). Returns every violation (empty ⇒
 * valid). A pure check over the registered contributions — no DB. {@link assertAlertPayloadCatalogValid}
 * wraps it for the boot gate, which fails closed on any violation.
 *
 * Rules: a `mN.*` payload type must be owned by `mN`; severity must be a known
 * {@link AlertPayloadSeverity}; `defaultChannels` must be non-empty (a payload with no floor
 * channel could not reach the always-available in-app floor); `defaultRecipientResolver` must be
 * a non-empty name; no `payloadType` may be declared twice.
 */
export function validateAlertPayloadCatalog(
  contributions: readonly ModuleAlertContribution[],
): AlertPayloadCatalogViolation[] {
  const violations: AlertPayloadCatalogViolation[] = [];
  const seen = new Set<string>();
  for (const entry of flatten(contributions)) {
    if (seen.has(entry.payloadType)) {
      violations.push({
        payloadType: entry.payloadType,
        type: "duplicate",
        detail: `payload type '${entry.payloadType}' is declared more than once`,
      });
    }
    seen.add(entry.payloadType);

    const m = PAYLOAD_PREFIX.exec(entry.payloadType);
    if (!m) {
      violations.push({
        payloadType: entry.payloadType,
        type: "wrong_namespace",
        detail: `payload type '${entry.payloadType}' does not follow the mN.<resource>.<verb> convention`,
      });
    } else if (entry.moduleOwner !== m[1]) {
      violations.push({
        payloadType: entry.payloadType,
        type: "wrong_namespace",
        detail: `payload type '${entry.payloadType}' implies owner '${m[1]}' but is registered to '${entry.moduleOwner}'`,
      });
    }

    if (!VALID_SEVERITIES.has(entry.severity)) {
      violations.push({
        payloadType: entry.payloadType,
        type: "bad_severity",
        detail: `payload type '${entry.payloadType}' has unknown severity '${entry.severity}'`,
      });
    }
    if (entry.defaultChannels.length === 0) {
      violations.push({
        payloadType: entry.payloadType,
        type: "empty_channels",
        detail: `payload type '${entry.payloadType}' declares no default channels`,
      });
    }
    if (entry.defaultRecipientResolver.length === 0) {
      violations.push({
        payloadType: entry.payloadType,
        type: "empty_resolver",
        detail: `payload type '${entry.payloadType}' declares no default recipient resolver`,
      });
    }
  }
  return violations;
}

/**
 * The boot gate (§3.12): throw if the registered catalog has any namespacing/shape violation.
 * M36 calls this at startup before the catalog is UPSERTed into `alert_payload_catalog`; a
 * violation is a registration bug, so boot fails closed. (Collisions throw earlier, in
 * {@link buildAlertPayloadCatalog}.)
 */
export function assertAlertPayloadCatalogValid(
  contributions: readonly ModuleAlertContribution[],
): void {
  buildAlertPayloadCatalog(contributions); // throws on collision first
  const violations = validateAlertPayloadCatalog(contributions);
  if (violations.length > 0) {
    const lines = violations.map((v) => `  • [${v.type}] ${v.detail}`).join("\n");
    throw new Error(
      `alert payload catalog invalid (${violations.length} violation(s)) — M36 boot refuses to start:\n${lines}`,
    );
  }
}

/** True when `payloadType` is a registered catalog payload (§4.6.1 runtime validation helper). */
export function isRegisteredPayloadType(
  payloadType: string,
  contributions: readonly ModuleAlertContribution[],
): boolean {
  return flatten(contributions).some((e) => e.payloadType === payloadType);
}

/**
 * Project the catalog into the rows the M36 boot UPSERTs (on `payload_type`) into
 * `alert_payload_catalog` (§3.11.2). Same source-of-truth-is-code → DB-mirror contract as the
 * outbox/action catalogs: the table is regenerated from the registry, never hand-edited.
 */
export function alertPayloadCatalogRows(
  contributions: readonly ModuleAlertContribution[],
): AlertPayloadCatalogRow[] {
  return flatten(contributions).map((e) => ({
    payloadType: e.payloadType,
    moduleOwner: e.moduleOwner,
    severity: e.severity,
    defaultChannels: [...e.defaultChannels],
    defaultRecipientResolver: e.defaultRecipientResolver,
    payloadSchema: e.payloadSchema,
    requiresResponseTracking: e.requiresResponseTracking,
    description: e.description,
  }));
}

/** The mutable Foundation Registry every later module registers its contribution onto (§3.12). */
export interface AlertPayloadRegistry {
  /** Register a producer module's contribution at its own boot (no import edge into M36). */
  register(contribution: ModuleAlertContribution): void;
  /** Every contribution registered so far, in registration order. */
  contributions(): readonly ModuleAlertContribution[];
  /** Build the validated `payloadType → entry` map (throws on collision). */
  build(): ReadonlyMap<string, AlertPayloadEntry>;
  /** Boot gate: assert the registered catalog is collision-free and well-formed. */
  assertValid(): void;
  /** Project the registry into `alert_payload_catalog` rows for the boot UPSERT. */
  rows(): AlertPayloadCatalogRow[];
  /** True when `payloadType` has been registered (§4.6.1 dispatch guard). */
  has(payloadType: string): boolean;
}

/**
 * Create the per-boot Foundation Registry (§3.12 / M36-F01). M36 owns NO alert payloads itself
 * (it is the engine); later modules register their `alerts-by-mN.ts` contributions onto this
 * registry at THEIR boot, so M36 never imports them. The boot slice then calls `assertValid()`
 * and UPSERTs `rows()`. A fresh registry per call keeps tests isolated.
 */
export function createAlertPayloadRegistry(): AlertPayloadRegistry {
  const contributions: ModuleAlertContribution[] = [];
  return {
    register(contribution) {
      contributions.push(contribution);
    },
    contributions() {
      return contributions;
    },
    build() {
      return buildAlertPayloadCatalog(contributions);
    },
    assertValid() {
      assertAlertPayloadCatalogValid(contributions);
    },
    rows() {
      return alertPayloadCatalogRows(contributions);
    },
    has(payloadType) {
      return isRegisteredPayloadType(payloadType, contributions);
    },
  };
}
