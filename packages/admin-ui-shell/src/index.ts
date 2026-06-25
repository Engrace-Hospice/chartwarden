// @wardenx/admin-ui-shell — Lantern layout primitives the M34 platform-ops console composes (§3.1).
// The shell chrome (top bar + nav rail), the current-tenant context read from the URL `:orgSlug`, and
// the persistent support-session banner. Screens live in apps/web (architecture wins over the spec's
// apps/admin layout); they import these primitives plus the @wardenx/ui domain patterns.
export { PlatformOpsShell, PLATFORM_NAV_ITEMS } from "./layout/PlatformOpsShell";
export type { PlatformOpsShellProps, PlatformNavItem } from "./layout/PlatformOpsShell";
export {
  TenantContextProvider,
  useTenantContext,
  useOptionalTenantContext,
} from "./layout/TenantContextProvider";
export type {
  TenantContextProviderProps,
  TenantContextValue,
} from "./layout/TenantContextProvider";
export { SupportSessionBanner } from "./layout/SupportSessionBanner";
export type { SupportSessionBannerProps } from "./layout/SupportSessionBanner";
