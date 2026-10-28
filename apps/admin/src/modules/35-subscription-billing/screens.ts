import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/admin/src/modules/35-subscription-billing — M35 §5.2 platform-ops screen registration (ADR-0030).
// The fourteen ChartWarden-staff subscription-billing screens contributed into the M34 admin shell. Each
// `requiredPermission` is a REAL §4.7 M35 `billing_admin.*` key the matching /api/admin route gates on
// (M35_CONTRIBUTED_PERMISSIONS in @chartwarden/auth) — the server stays the authoritative enforcer; this only
// gates nav visibility. M34 owns the apps/admin shell; M35 owns this slice and registers into it at
// composition (apps/admin/src/main.tsx), never importing the shell's internals — the frontend seam analogue.
import { lazy } from "react";
import type { ComponentType } from "react";

// Route-level code splitting (#849): each screen is its own chunk; the shell wraps routes in <Suspense>.
const Dunning = lazy(() => import("./dunning").then((m) => ({ default: m.Dunning })));
const PlanEdit = lazy(() => import("./plan-edit").then((m) => ({ default: m.PlanEdit })));
const PlansList = lazy(() => import("./plans-list").then((m) => ({ default: m.PlansList })));
const Promos = lazy(() => import("./promos").then((m) => ({ default: m.Promos })));
const RefundApprove = lazy(() =>
  import("./refund-approve").then((m) => ({ default: m.RefundApprove })),
);
const RefundNew = lazy(() => import("./refund-new").then((m) => ({ default: m.RefundNew })));
const RefundsQueue = lazy(() =>
  import("./refunds-queue").then((m) => ({ default: m.RefundsQueue })),
);
const Revenue = lazy(() => import("./revenue").then((m) => ({ default: m.Revenue })));
const SubscriptionApplyPromo = lazy(() =>
  import("./subscription-apply-promo").then((m) => ({ default: m.SubscriptionApplyPromo })),
);
const SubscriptionDetail = lazy(() =>
  import("./subscription-detail").then((m) => ({ default: m.SubscriptionDetail })),
);
const SubscriptionPause = lazy(() =>
  import("./subscription-pause").then((m) => ({ default: m.SubscriptionPause })),
);
const SubscriptionsList = lazy(() =>
  import("./subscriptions-list").then((m) => ({ default: m.SubscriptionsList })),
);
const Usage = lazy(() => import("./usage").then((m) => ({ default: m.Usage })));
const Webhooks = lazy(() => import("./webhooks").then((m) => ({ default: m.Webhooks })));

export const subscriptionAdminScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 35,
  slug: "35-subscription-billing",
  screens: [
    // ── Plans + Promos (M35A-T05) ──
    {
      id: "admin.plans",
      path: "/admin/plans",
      title: "Plans",
      navGroup: "Billing",
      requiredPermission: "plan.admin.read",
      screen: PlansList,
    },
    {
      id: "admin.plan-edit",
      path: "/admin/plans/:id/edit",
      title: "Edit plan",
      navGroup: "Billing",
      requiredPermission: "plan.admin.write",
      screen: PlanEdit,
    },
    {
      id: "admin.promos",
      path: "/admin/promos",
      title: "Promos",
      navGroup: "Billing",
      requiredPermission: "promo.admin.read",
      screen: Promos,
    },
    // ── Subscriptions (M35A-T06) ──
    {
      id: "admin.subscriptions",
      path: "/admin/subscriptions",
      title: "Subscriptions",
      navGroup: "Billing",
      requiredPermission: "subscription.admin.read",
      screen: SubscriptionsList,
    },
    {
      id: "admin.subscription-detail",
      path: "/admin/subscriptions/:id",
      title: "Subscription",
      navGroup: "Billing",
      requiredPermission: "subscription.admin.read",
      screen: SubscriptionDetail,
    },
    {
      id: "admin.subscription-pause",
      path: "/admin/subscriptions/:id/pause",
      title: "Pause subscription",
      navGroup: "Billing",
      requiredPermission: "subscription.admin.write",
      screen: SubscriptionPause,
    },
    {
      id: "admin.subscription-apply-promo",
      path: "/admin/subscriptions/:id/apply_promo",
      title: "Apply promo",
      navGroup: "Billing",
      requiredPermission: "promo.admin.apply",
      screen: SubscriptionApplyPromo,
    },
    // ── Refunds (M35A-T07) ──
    {
      id: "admin.refunds",
      path: "/admin/refunds",
      title: "Refunds",
      navGroup: "Billing",
      requiredPermission: "refund.read",
      screen: RefundsQueue,
    },
    {
      id: "admin.refund-new",
      path: "/admin/refunds/new",
      title: "New refund",
      navGroup: "Billing",
      requiredPermission: "refund.request",
      screen: RefundNew,
    },
    {
      id: "admin.refund-approve",
      path: "/admin/refunds/:id/approve",
      title: "Review refund",
      navGroup: "Billing",
      requiredPermission: "refund.approve",
      screen: RefundApprove,
    },
    // ── Dunning + Revenue + Usage + Webhooks (M35A-T08) ──
    {
      id: "admin.dunning",
      path: "/admin/dunning",
      title: "Dunning",
      navGroup: "Billing",
      requiredPermission: "dunning.admin.read",
      screen: Dunning,
    },
    {
      id: "admin.revenue",
      path: "/admin/revenue",
      title: "Revenue",
      navGroup: "Billing",
      requiredPermission: "revenue.admin.read",
      screen: Revenue,
    },
    {
      id: "admin.usage",
      path: "/admin/usage/:organizationId",
      title: "Tenant usage",
      navGroup: "Billing",
      requiredPermission: "usage.admin.read",
      screen: Usage,
    },
    {
      id: "admin.webhooks",
      path: "/admin/webhooks/stripe",
      title: "Stripe webhooks",
      navGroup: "Billing",
      requiredPermission: "stripe.admin.read",
      screen: Webhooks,
    },
  ],
};
