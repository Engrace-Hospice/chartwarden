// @chartwarden/portal — the consumer-facing Patient/Family Portal PWA domain surface (M31 §5.1; M31-T01 layout).
//
// The portal is a TanStack-Router SPA (§5.1); the real screens (login → select-patient → care-summary →
// medications → …) are built in M31-T08 against the module's generated client. This T01 layout re-exports
// the M31 leaf contracts the portal renders over — the lay-language data categories, the account/grant
// lifecycle enums, and the PHI-minimal read DTOs — so the screen task builds against a typed foundation.
export type {
  PortalAccountRelationship,
  PortalAccountStatus,
  PortalAccessGrantKind,
  PortalDataCategory,
  PortalScopeSet,
  PortalAccountDigest,
  PortalAccessGrantDigest,
  TelehealthVisitDigest,
  TelehealthLifecycleState,
  TelehealthScheduledVisitSetting,
} from "@chartwarden/types";
