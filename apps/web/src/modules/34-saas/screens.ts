import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/34-saas — M34 SaaS Tenant Platform screen registration (R2, ADR-0030).
// The tenant-facing /admin/* surface only — the platform-ops control plane (§5.1: Tenants, Support
// Sessions, Feature Flags, DSAR/Tenant Exports, Onboarding Templates, BAA Register, Signup Intents,
// Key Rings) migrated to the dedicated apps/admin console
// (apps/admin/src/modules/34-saas-platform/screens.ts) — a live-browser audit finding that those
// screens belonged there, not gated-and-hidden inside this app. Each `requiredPermission` is the
// REAL §4.5 M34 key the matching route gates on
// (apps/backend/src/modules/34-saas-tenant-platform/permission-keys.ts) — the server stays the
// authoritative enforcer; this only gates nav visibility.
import { lazy } from "react";
import type { ComponentType } from "react";
const AgencySetup = lazy(() => import("./agency-setup").then((m) => ({ default: m.AgencySetup })));
const Account = lazy(() => import("./account").then((m) => ({ default: m.Account })));
const Onboarding = lazy(() => import("./onboarding").then((m) => ({ default: m.Onboarding })));
const SupportGrants = lazy(() =>
  import("./support-grants").then((m) => ({ default: m.SupportGrants })),
);

export const saasScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 34,
  slug: "34-saas",
  screens: [
    {
      id: "saas.account",
      path: "/admin/account",
      title: "Account",
      navGroup: "Admin",
      requiredPermission: "tenant.read_own",
      screen: Account,
    },
    {
      id: "saas.agency-setup",
      path: "/admin/setup",
      title: "Agency setup",
      navGroup: "Admin",
      // The routes it calls gate on `org.manage` (M2 org-admin surface), the key the setup writes need.
      requiredPermission: "org.manage",
      screen: AgencySetup,
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
