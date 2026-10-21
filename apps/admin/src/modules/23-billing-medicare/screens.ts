import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/admin/src/modules/23-billing-medicare — M23's platform-admin slice (§4.1 #42, GAP-144), registered into the
// M34 admin shell (the same pattern as 35-subscription-billing). `billing.rule_config.platform_admin` is the REAL key
// the route gates on (the platform administrator's; a tenant org_admin never holds it) — the server stays the
// authoritative enforcer, with the step-up and AI-actor block on top; this only gates nav visibility.
// Lazy, like the M32 slice: the console's initial bundle is already over its 350 kB budget (WX-PR-022), and an
// operator who never runs the annual load never downloads it.
import { lazy } from "react";
import type { ComponentType } from "react";

const WageIndexLoad = lazy(() =>
  import("./wage-index-load").then((m) => ({ default: m.WageIndexLoad })),
);

export const medicareBillingAdminScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 23,
  slug: "23-billing-medicare",
  screens: [
    {
      id: "admin.billing.wage-index-load",
      path: "/admin/billing/wage-indexes/load",
      title: "Wage index load",
      navGroup: "Medicare billing",
      requiredPermission: "billing.rule_config.platform_admin",
      screen: WageIndexLoad,
    },
  ],
};
