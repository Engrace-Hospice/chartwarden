import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/web/src/modules/35-subscription — M35 Subscription Billing tenant screen registration (§5.1, ADR-0030).
// The eight tenant-facing §5.1 screens (org_admin / billing_admin / accounts_receivable). Each
// `requiredPermission` is a REAL §4.7 M35 tenant key the matching list/read route gates on
// (M35_CONTRIBUTED_PERMISSIONS in @chartwarden/auth) — the server stays the authoritative enforcer, this only
// gates nav visibility. There is no tenant-facing `promo`/`dunning` read key, so those two screens gate on
// `subscription.read` (the tenant billing scope). The platform-ops §5.2 admin console is a separate
// forward surface (apps/admin) and is NOT registered here.
//
// PATHS: the spec §5.1 proposes `/billing/*`, but `/billing` is already owned by M23 (revenue-cycle
// Medicare billing home) in the live shell registry — a distinct actor and concern. Architecture wins
// over the spec proposal on conflict, so M35's SaaS-subscription surfaces are namespaced under
// `/subscription/*` (a "Subscription" navGroup), keeping them cleanly separate from the clinical revenue
// cycle.
import { lazy } from "react";
import type { ComponentType } from "react";
const BillingOverview = lazy(() =>
  import("./billing-overview").then((m) => ({ default: m.BillingOverview })),
);
const BillingPlan = lazy(() => import("./billing-plan").then((m) => ({ default: m.BillingPlan })));
const Dunning = lazy(() => import("./dunning").then((m) => ({ default: m.Dunning })));
const InvoiceDetail = lazy(() =>
  import("./invoice-detail").then((m) => ({ default: m.InvoiceDetail })),
);
const Invoices = lazy(() => import("./invoices").then((m) => ({ default: m.Invoices })));
const PaymentMethods = lazy(() =>
  import("./payment-methods").then((m) => ({ default: m.PaymentMethods })),
);
const Promos = lazy(() => import("./promos").then((m) => ({ default: m.Promos })));
const Usage = lazy(() => import("./usage").then((m) => ({ default: m.Usage })));

export const subscriptionScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 35,
  slug: "35-subscription",
  screens: [
    {
      id: "billing.overview",
      path: "/subscription",
      title: "Subscription",
      navGroup: "Subscription",
      requiredPermission: "subscription.read",
      screen: BillingOverview,
    },
    {
      id: "billing.plan",
      path: "/subscription/plan",
      title: "Change plan",
      navGroup: "Subscription",
      requiredPermission: "subscription.read",
      screen: BillingPlan,
    },
    {
      id: "billing.payment-methods",
      path: "/subscription/payment_methods",
      title: "Payment methods",
      navGroup: "Subscription",
      requiredPermission: "payment_method.read",
      screen: PaymentMethods,
    },
    {
      id: "billing.invoices",
      path: "/subscription/invoices",
      title: "Invoices",
      navGroup: "Subscription",
      requiredPermission: "invoice.read",
      screen: Invoices,
    },
    {
      id: "billing.invoice-detail",
      path: "/subscription/invoices/:id",
      title: "Invoice",
      navGroup: "Subscription",
      requiredPermission: "invoice.read",
      screen: InvoiceDetail,
    },
    {
      id: "billing.usage",
      path: "/subscription/usage",
      title: "Usage",
      navGroup: "Subscription",
      requiredPermission: "usage.read",
      screen: Usage,
    },
    {
      id: "billing.dunning",
      path: "/subscription/dunning",
      title: "Dunning",
      navGroup: "Subscription",
      requiredPermission: "subscription.read",
      screen: Dunning,
    },
    {
      id: "billing.promos",
      path: "/subscription/promos",
      title: "Promo codes",
      navGroup: "Subscription",
      requiredPermission: "subscription.read",
      screen: Promos,
    },
  ],
};
