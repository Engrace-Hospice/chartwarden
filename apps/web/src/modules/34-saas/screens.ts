import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/34-saas — M34 SaaS Tenant Platform screen registration (R2, ADR-0030).
// The platform control-plane + tenant-admin surface (§5.1 screen inventory). Each `requiredPermission`
// is the REAL §4.5 M34 key the matching list/read route gates on
// (apps/backend/src/modules/34-saas-tenant-platform/permission-keys.ts) — the server stays the
// authoritative enforcer; this only gates nav visibility. Platform-ops screens sit under the
// "Platform" navGroup; the tenant-facing /admin/* screens under "Admin".
import type { ComponentType } from "react";
import { Account } from "./account";
import { BaaRegister } from "./baa-register";
import { DsarQueue } from "./dsar-queue";
import { FeatureFlags } from "./feature-flags";
import { KeyRings } from "./key-rings";
import { Onboarding } from "./onboarding";
import { OnboardingTemplates } from "./onboarding-templates";
import { Signups } from "./signups";
import { SupportGrants } from "./support-grants";
import { SupportSessions } from "./support-sessions";
import { TenantExportQueue } from "./tenant-export-queue";
import { TenantInventory } from "./tenant-inventory";
import { TenantOverview } from "./tenant-overview";

export const saasScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 34,
  slug: "34-saas",
  screens: [
    // --- platform-ops control plane (§5.1) ---
    {
      id: "saas.tenants",
      path: "/tenants",
      title: "Tenants",
      navGroup: "Platform",
      requiredPermission: "tenant.list_platform",
      screen: TenantInventory,
    },
    {
      id: "saas.tenant-overview",
      path: "/tenants/:orgSlug",
      title: "Tenant Overview",
      navGroup: "Platform",
      requiredPermission: "tenant.read_platform",
      screen: TenantOverview,
    },
    {
      id: "saas.support-sessions",
      path: "/support/sessions",
      title: "Support Sessions",
      navGroup: "Platform",
      requiredPermission: "support_session.list_platform",
      screen: SupportSessions,
    },
    {
      id: "saas.dsar-queue",
      path: "/exports/dsar",
      title: "DSAR Exports",
      navGroup: "Platform",
      // §164.524 is tenant/org-scoped (D9) — there is no platform-wide DSAR list route, so the
      // queue gates on the tenant-scoped list-own key the backing route enforces.
      requiredPermission: "dsar_export.list_own",
      screen: DsarQueue,
    },
    {
      id: "saas.tenant-export-queue",
      path: "/exports/tenant",
      title: "Tenant Exports",
      navGroup: "Platform",
      requiredPermission: "tenant_export.list_own",
      screen: TenantExportQueue,
    },
    {
      id: "saas.onboarding-templates",
      path: "/onboarding/templates",
      title: "Onboarding Templates",
      navGroup: "Platform",
      requiredPermission: "onboarding_template.list",
      screen: OnboardingTemplates,
    },
    {
      id: "saas.feature-flags",
      path: "/feature-flags",
      title: "Feature Flags",
      navGroup: "Platform",
      requiredPermission: "feature_flag.read_platform",
      screen: FeatureFlags,
    },
    {
      id: "saas.baa-register",
      path: "/baa",
      title: "BAA Register",
      navGroup: "Platform",
      requiredPermission: "platform_tenant_baa.read_platform",
      screen: BaaRegister,
    },
    {
      id: "saas.signups",
      path: "/signups",
      title: "Signup Intents",
      navGroup: "Platform",
      requiredPermission: "signup_intent.list_platform",
      screen: Signups,
    },
    {
      id: "saas.key-rings",
      path: "/key-rings",
      title: "Key Rings",
      navGroup: "Platform",
      // The §3.5 key-ring metadata read reuses the tenant platform-read key (§4.1/§4.5).
      requiredPermission: "tenant.read_platform",
      screen: KeyRings,
    },
    // --- tenant-facing admin surface (§5.1) ---
    {
      id: "saas.account",
      path: "/admin/account",
      title: "Account",
      navGroup: "Admin",
      requiredPermission: "tenant.read_own",
      screen: Account,
    },
    {
      id: "saas.onboarding",
      path: "/admin/onboarding",
      title: "Onboarding",
      navGroup: "Admin",
      requiredPermission: "onboarding.read_own",
      screen: Onboarding,
    },
    {
      id: "saas.support-grants",
      path: "/admin/support-grants",
      title: "Support Grants",
      navGroup: "Admin",
      requiredPermission: "support_consent_grant.list_own",
      screen: SupportGrants,
    },
  ],
};
