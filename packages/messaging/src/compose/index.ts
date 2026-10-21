// @chartwarden/messaging — cross-module notification composition barrel (M36-T09, spec §4.11, §3.13,
// ADR-0024). Notification composition + recipient resolution for the referral / critical-results /
// transmission-failure event families moved from M14 to M36 (SD-017); M36 composes from
// `notification_template` and resolves recipients via its own registry, never importing a producer.

export {
  type NotificationTemplateRow,
  type TenantTemplateOverlayRow,
  type EffectiveNotificationTemplate,
  type RenderedTemplate,
  TemplateOverlayMismatchError,
  MissingTemplateVariableError,
  resolveTemplate,
  renderTemplate,
} from "./template-render";

export {
  type CompositionResolverPorts,
  COMPOSITION_RESOLVER_ROLE_KEYS,
  COMPOSITION_RESOLVER_NAMES,
  registerCompositionResolvers,
} from "./resolvers";

export {
  type CrossModuleCompositionInput,
  type ComposedDispatchRequest,
  type CrossModuleCompositionResult,
  type CrossModuleComposerPorts,
  type RecordedComposedDispatch,
  type InMemoryComposerOptions,
  UnknownNotificationTemplateError,
  UnregisteredComposedPayloadError,
  composeAndDispatch,
  createInMemoryCrossModuleComposer,
} from "./compose-cross-module";
