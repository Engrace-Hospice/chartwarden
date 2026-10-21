// @chartwarden/terminology — tenant value-set extension rules (M38-T07, §7.6).
// Add-only/never-weaken: the add-time classification + the read-time platform∪tenant union.

export {
  classifyTenantExtension,
  unionTenantExtensions,
  type TenantExtensionContext,
  type TenantExtensionOutcome,
  type TenantExtensionRefusal,
} from "./extensions";
