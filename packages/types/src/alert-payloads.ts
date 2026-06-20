// @wardenx/types — Typed alert-payload catalog contracts (M36 Secure Messaging §3.11/§3.12; M36-T05).
//
// The typed alert-payload registry brings M36's alert catalog inline with M1's
// outbox-event-catalog (./outbox.ts) and M4's audit-action-catalog discipline: a per-module
// CONTRIBUTION shape + a boot UPSERT into `alert_payload_catalog` + runtime validation. Per the
// §3.12 Foundation Registry pattern, every LATER module contributes the typed payloads it emits
// (`m11.lab_results.critical`, `m22.document.rendered_critical_results`, …) at ITS OWN boot — so
// the shape lives here in a leaf (NOT the banned packages/foundation, ADR-0005 D4), and M36's
// aggregator (packages/messaging) needs no dependsOn edge on any producer. check-fitness-gaps.ts
// enforces the same `mN.<resource>.<verb>` ownership the outbox catalog uses.
import type { TSchema } from "@sinclair/typebox";
import type { ModuleToken } from "./outbox";

/**
 * The DISTINCT payload-catalog severity ladder (§3.11, M36-F06b) — mirrors the
 * `alert_payload_severity` pgEnum. Tenants may TIGHTEN via the D11 routing override but never
 * loosen. DISTINCT from the legacy `alert`/`alert_rule` `info|warn|critical` ladder.
 */
export type AlertPayloadSeverity = "INFO" | "WARN" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Definition order of {@link AlertPayloadSeverity} — the floor ↑ tighten ordering the D11 routing
 *  override compares against (INFO < WARN < MEDIUM < HIGH < CRITICAL), matching the Postgres enum
 *  definition order the §3.11.1 `enforce_alert_routing_tighten_only` trigger relies on. */
export const ALERT_PAYLOAD_SEVERITY_ORDER = [
  "INFO",
  "WARN",
  "MEDIUM",
  "HIGH",
  "CRITICAL",
] as const satisfies readonly AlertPayloadSeverity[];

/**
 * One typed alert payload a module registers with M36 (§3.12.1). The `payloadType` is a
 * `mN.<resource>.<verb>` name owned by `moduleOwner`; `payloadSchema` is the TypeBox schema the
 * catalog-validated dispatch path (§4.6.1) checks every emit against. `defaultChannels` is the
 * platform-floor delivery class set (`socket_push`/`inbox`/`sms`/`email`); a tenant may ADD but
 * never remove (D11). `defaultRecipientResolver` names a resolver in M36's registry (§4.6).
 */
export interface AlertPayloadEntry {
  /** Fully-qualified payload type, e.g. `m11.lab_results.critical` (§3.12). */
  readonly payloadType: string;
  /** The owning module's `mN` token — must match the payload type's `mN.` prefix. */
  readonly moduleOwner: ModuleToken;
  /** Platform-floor severity for this payload (tenants may tighten, never loosen, §3.11). */
  readonly severity: AlertPayloadSeverity;
  /** Default delivery class set, e.g. `['socket_push', 'inbox']` (§3.11; tenants add-only). */
  readonly defaultChannels: readonly string[];
  /** Name of the recipient resolver M36 dispatches to (§4.6), e.g. `ordering_provider`. */
  readonly defaultRecipientResolver: string;
  /** TypeBox schema every emitted payload of this type must satisfy (§4.6.1 refuse-on-failure). */
  readonly payloadSchema: TSchema;
  /** When true, the response SLA is tracked downstream in M30 (§3.11). */
  readonly requiresResponseTracking: boolean;
  /** Human-readable description (the catalog's reporting surface, §3.11). */
  readonly description: string;
}

/** One module's alert-payload contribution: the payload types it OWNS under its `mN.` prefix
 *  (§3.12). A producer module ships one of these and registers it at its own boot. */
export type ModuleAlertContribution = readonly AlertPayloadEntry[];

/**
 * Persisted projection of a catalog entry into the `alert_payload_catalog` row shape (§3.11.2).
 * Structural (no `@wardenx/db` import) so the leaf stays a leaf — M36's boot slice feeds these
 * rows to an injected Drizzle UPSERTer, exactly as M1 does for `outbox_event_catalog`.
 */
export interface AlertPayloadCatalogRow {
  readonly payloadType: string;
  readonly moduleOwner: string;
  readonly severity: AlertPayloadSeverity;
  readonly defaultChannels: string[];
  readonly defaultRecipientResolver: string;
  readonly payloadSchema: unknown;
  readonly requiresResponseTracking: boolean;
  readonly description: string;
}
