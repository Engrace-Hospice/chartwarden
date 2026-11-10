// apps/admin/src/modules/34-saas-platform/onboarding — the clearinghouse model now lives in @chartwarden/ui (the tenant wizard shares
// it: the view schema is the same on both lanes). Re-exported here so admin imports keep their path.
export {
  MODE_LABEL,
  VENDOR_LABEL,
  clearinghouseActions,
  clearinghouseFacts,
  isTransmitting,
  needsSecret,
} from "@chartwarden/ui";
export type {
  ClearinghouseActions,
  ClearinghouseMode,
  ClearinghouseVendor,
  ClearinghouseView,
} from "@chartwarden/ui";
