// @wardenx/messaging — the cross-module notification composer (M36-T09, spec §4.11, ADR-0024).
//
// ONE composer path for all six moved events (the §3.12.5 referral / critical-results /
// transmission-failure families). A producer module (M6/M11/M22) emits its typed outbox event;
// M36 — never importing the producer — composes the notification:
//   1. load the matching `notification_template` (tenant overlay tightens wording; §3.13);
//   2. render title/body from the SOURCE event payload (validated against the template schema);
//   3. resolve recipients via the registered resolver (§4.6 / §4.11 — the ADR-0024 resolvers in
//      ./resolvers register onto the same registry M36 already owns);
//   4. dispatch through the catalog-validated entry point (§4.6.1) — every dispatch validates the
//      `payloadType` against `alert_payload_catalog` (§3.11), so an unregistered payload is refused.
//
// Pure orchestration over injected PORTS (the M38 `TerminologyProvider`-over-store pattern):
// production binds them to Drizzle (templates/overlays), the registry (recipients), and the
// `AlertEmitter`/§4.6.1 dispatch; tests inject fakes. The composed title/body are PHI-bearing and
// ride only the in-app floor — the §4.7 sanitizer strips them for any out-of-band hop.

import {
  type RecipientResolverFn,
  createRecipientResolverRegistry,
  resolveRecipients,
} from "../resolution/recipients";
import { PLATFORM_NOTIFICATION_TEMPLATES } from "../seed/notification-templates";
import { type CompositionResolverPorts, registerCompositionResolvers } from "./resolvers";
import {
  type NotificationTemplateRow,
  type TenantTemplateOverlayRow,
  renderTemplate,
  resolveTemplate,
} from "./template-render";

/** A producer's typed outbox event as the composer consumes it (§4.11). For the six moved rows the
 *  `eventType` is also the `template_key` and the `default_payload_type`. */
export interface CrossModuleCompositionInput {
  readonly eventType: string;
  /** The producer's source event payload — the placeholders + the resolver subject ids live here. */
  readonly sourcePayload: Readonly<Record<string, unknown>>;
  readonly organizationId: string;
  readonly correlationId: string;
  /** Optional per-rule resolver args (e.g. a custom `orderIdPath` / `roleKeys`). */
  readonly resolverArgs?: Readonly<Record<string, unknown>>;
}

/** The catalog-validated dispatch request the composer hands to §4.6.1. The composed copy is added
 *  to the payload under content-explicit keys; recipients were resolved at compose time (§4.11.3). */
export interface ComposedDispatchRequest {
  readonly payloadType: string;
  readonly organizationId: string;
  readonly correlationId: string;
  readonly recipientUserIds: readonly string[];
  /** The source payload enriched with the rendered copy (in-perimeter; never traverses §4.7). */
  readonly payload: Readonly<Record<string, unknown>>;
  readonly callerModule: "m36";
}

/** What the composer returns to the producer's outbox consumer. */
export interface CrossModuleCompositionResult {
  readonly alertId: string;
  readonly payloadType: string;
  readonly resolvedRecipientCount: number;
  readonly title: string;
  readonly body: string;
}

/** Thrown when no platform-floor template exists for the event — a missing-seed/registration bug,
 *  not a tenant-reachable state (the producer event has no copy to render). */
export class UnknownNotificationTemplateError extends Error {
  constructor(readonly templateKey: string) {
    super(`unknown_notification_template: no template registered for '${templateKey}'`);
    this.name = "UnknownNotificationTemplateError";
  }
}

/**
 * The ports the composer composes over. Every method is a plain async boundary so the composer
 * stays pure: production binds `loadTemplate`/`loadOverlay` to Drizzle, `resolveRecipients` to the
 * registry (built with the ADR-0024 resolvers), and `dispatch` to the §4.6.1 catalog-validated
 * entry point; {@link createInMemoryCrossModuleComposer} binds them in-memory for tests + boot.
 */
export interface CrossModuleComposerPorts {
  /** The platform-floor `notification_template` for the org's effective version (null ⇒ unknown). */
  loadTemplate(orgId: string, templateKey: string): Promise<NotificationTemplateRow | null>;
  /** The tenant overlay for this org+key, if any (null ⇒ use the floor wording). */
  loadOverlay(orgId: string, templateKey: string): Promise<TenantTemplateOverlayRow | null>;
  /** Resolve recipients via the named resolver against the source-of-truth registry (§4.11.3). */
  resolveRecipients(
    orgId: string,
    resolverName: string,
    args: Record<string, unknown>,
    payload: Record<string, unknown>,
  ): Promise<readonly string[]>;
  /** Catalog-validated dispatch (§4.6.1) — validates `payloadType` ∈ catalog, fans out, persists. */
  dispatch(req: ComposedDispatchRequest): Promise<{ alertId: string }>;
}

/**
 * Compose + dispatch one cross-module notification (§4.11). Loads the template (throws
 * {@link UnknownNotificationTemplateError} if none), applies the tenant overlay, renders the copy
 * (throws on a missing required placeholder — see {@link renderTemplate}), resolves recipients via
 * the template's `default_recipient_resolver`, and dispatches the enriched payload. The recipient
 * count is the distinct resolved set; the dispatch decides the per-recipient fan-out (in-app floor
 * + per-preference out-of-band).
 */
export async function composeAndDispatch(
  input: CrossModuleCompositionInput,
  ports: CrossModuleComposerPorts,
): Promise<CrossModuleCompositionResult> {
  const floor = await ports.loadTemplate(input.organizationId, input.eventType);
  if (floor === null) throw new UnknownNotificationTemplateError(input.eventType);

  const overlay = await ports.loadOverlay(input.organizationId, input.eventType);
  const effective = resolveTemplate(floor, overlay);
  const { title, body } = renderTemplate(effective, input.sourcePayload);

  const recipients = await ports.resolveRecipients(
    input.organizationId,
    effective.defaultRecipientResolver,
    { ...input.resolverArgs },
    { ...input.sourcePayload },
  );

  const { alertId } = await ports.dispatch({
    payloadType: effective.defaultPayloadType,
    organizationId: input.organizationId,
    correlationId: input.correlationId,
    recipientUserIds: recipients,
    payload: { ...input.sourcePayload, composedTitle: title, composedBody: body },
    callerModule: "m36",
  });

  return {
    alertId,
    payloadType: effective.defaultPayloadType,
    resolvedRecipientCount: recipients.length,
    title,
    body,
  };
}

// ── In-memory slice (no live infra) — boot default + the test seam ────────────────────────────

/** A recorded composed dispatch — what a §4.6.1 dispatcher would have fanned out + persisted. */
export interface RecordedComposedDispatch extends ComposedDispatchRequest {
  readonly alertId: string;
}

/** Thrown by the in-memory dispatch when a composed `payloadType` is not in the known catalog set —
 *  the §4.6.1 fail-closed guard (the §7.12 "unregistered payload" invariant, at the composer edge). */
export class UnregisteredComposedPayloadError extends Error {
  constructor(readonly payloadType: string) {
    super(`unregistered_composed_payload: '${payloadType}' is not in the alert payload catalog`);
    this.name = "UnregisteredComposedPayloadError";
  }
}

/** Options for {@link createInMemoryCrossModuleComposer}; everything defaults slice-safe. */
export interface InMemoryComposerOptions {
  /** Platform-floor templates keyed by `template_key` (default: the six §3.13 floor rows). */
  readonly templates?: readonly NotificationTemplateRow[];
  /** Tenant overlays, looked up by `(organizationId, templateKey)`. Default none. */
  readonly overlays?: readonly TenantTemplateOverlayRow[];
  /** ADR-0024 resolver source ports — default every lookup to empty (no source modules landed). */
  readonly compositionPorts?: Partial<CompositionResolverPorts>;
  /** The set of catalog payload types `dispatch` accepts (default: the six composed rows). */
  readonly knownPayloadTypes?: Iterable<string>;
}

const EMPTY_COMPOSITION_PORTS: CompositionResolverPorts = {
  orderingProviderForOrder: async () => [],
  orderingProvidersWithActiveOrdersForPhysician: async () => [],
  roleSetMembers: async () => [],
};

const EMPTY_RECIPIENT_PORTS = {
  careTeamMembers: async () => [],
  onCallMembers: async () => [],
  disciplineMembers: async () => [],
  roleSetMembers: async () => [],
  tenantAdmins: async () => [],
  orgMembers: async () => [],
} as const;

/**
 * Build a cross-module composer over in-memory stores — the boot-slice default + the test seam
 * (the analogue of `createInMemoryAlertEmitter`). Seeds the six §3.13 platform-floor templates,
 * builds the resolver registry with the ADR-0024 composition resolvers, and a `dispatch` that
 * validates the composed `payloadType` against the known catalog set before recording it. Returns
 * the composer plus the `recorded` array so tests can assert the composed dispatch + recipients.
 */
export function createInMemoryCrossModuleComposer(options: InMemoryComposerOptions = {}): {
  composeAndDispatch: (input: CrossModuleCompositionInput) => Promise<CrossModuleCompositionResult>;
  registry: Map<string, RecipientResolverFn>;
  recorded: RecordedComposedDispatch[];
} {
  // Lazy import to keep this module's type-only deps; the seed is plain data.
  const seedTemplates = options.templates ?? PLATFORM_NOTIFICATION_TEMPLATES;
  const templatesByKey = new Map(seedTemplates.map((t) => [t.templateKey, t]));
  const overlaysByKey = new Map(
    (options.overlays ?? []).map((o) => [`${o.organizationId}::${o.templateKey}`, o]),
  );
  const known = new Set<string>(
    options.knownPayloadTypes ?? seedTemplates.map((t) => t.defaultPayloadType),
  );

  const registry = createRecipientResolverRegistry(EMPTY_RECIPIENT_PORTS);
  registerCompositionResolvers(registry, {
    ...EMPTY_COMPOSITION_PORTS,
    ...options.compositionPorts,
  });

  const recorded: RecordedComposedDispatch[] = [];
  let seq = 0;

  const ports: CrossModuleComposerPorts = {
    loadTemplate: async (_orgId, templateKey) => templatesByKey.get(templateKey) ?? null,
    loadOverlay: async (orgId, templateKey) =>
      overlaysByKey.get(`${orgId}::${templateKey}`) ?? null,
    resolveRecipients: (orgId, resolverName, args, payload) =>
      resolveRecipients(registry, resolverName, orgId, args, payload),
    dispatch: async (req) => {
      if (!known.has(req.payloadType)) throw new UnregisteredComposedPayloadError(req.payloadType);
      seq += 1;
      const alertId = `alert_${seq}`;
      recorded.push({ ...req, alertId });
      return { alertId };
    },
  };

  return {
    composeAndDispatch: (input) => composeAndDispatch(input, ports),
    registry,
    recorded,
  };
}
