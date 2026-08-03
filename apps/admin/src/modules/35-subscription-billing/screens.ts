import type { ScreenRegistryModule } from "@wardenx/types";
// apps/admin/src/modules/35-subscription-billing — M35 §5.2 platform-ops screen registration (ADR-0030).
// The fourteen WardenX-staff subscription-billing screens contributed into the M34 admin shell. Each
// `requiredPermission` is a REAL §4.7 M35 `billing_admin.*` key the matching /api/admin route gates on
// (M35_CONTRIBUTED_PERMISSIONS in @wardenx/auth) — the server stays the authoritative enforcer; this only
// gates nav visibility. M34 owns the apps/admin shell; M35 owns this slice and registers into it at
// composition (apps/admin/src/main.tsx), never importing the shell's internals — the frontend seam analogue.
import type { ComponentType } from "react";
import { Dunning } from "./dunning";
import { PlanEdit } from "./plan-edit";
import { PlansList } from "./plans-list";
import { Promos } from "./promos";
import { RefundApprove } from "./refund-approve";
import { RefundNew } from "./refund-new";
import { RefundsQueue } from "./refunds-queue";
import { Revenue } from "./revenue";
import { SubscriptionApplyPromo } from "./subscription-apply-promo";
import { SubscriptionDetail } from "./subscription-detail";
import { SubscriptionPause } from "./subscription-pause";
import { SubscriptionsList } from "./subscriptions-list";
import { Usage } from "./usage";
import { Webhooks } from "./webhooks";

export const subscriptionAdminScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 35,
  slug: "35-subscription-billing",
  screens: [
    // ── Plans + Promos (M35A-T05) ──
    { id: "admin.plans", path: "/admin/plans", title: "Plans", navGroup: "Billing", requiredPermission: "plan.admin.read", screen: PlansList },
    { id: "admin.plan-edit", path: "/admin/plans/:id/edit", title: "Edit plan", navGroup: "Billing", requiredPermission: "plan.admin.write", screen: PlanEdit },
    { id: "admin.promos", path: "/admin/promos", title: "Promos", navGroup: "Billing", requiredPermission: "promo.admin.read", screen: Promos },
    // ── Subscriptions (M35A-T06) ──
    { id: "admin.subscriptions", path: "/admin/subscriptions", title: "Subscriptions", navGroup: "Billing", requiredPermission: "subscription.admin.read", screen: SubscriptionsList },
    { id: "admin.subscription-detail", path: "/admin/subscriptions/:id", title: "Subscription", navGroup: "Billing", requiredPermission: "subscription.admin.read", screen: SubscriptionDetail },
    { id: "admin.subscription-pause", path: "/admin/subscriptions/:id/pause", title: "Pause subscription", navGroup: "Billing", requiredPermission: "subscription.admin.write", screen: SubscriptionPause },
    { id: "admin.subscription-apply-promo", path: "/admin/subscriptions/:id/apply_promo", title: "Apply promo", navGroup: "Billing", requiredPermission: "promo.admin.apply", screen: SubscriptionApplyPromo },
    // ── Refunds (M35A-T07) ──
    { id: "admin.refunds", path: "/admin/refunds", title: "Refunds", navGroup: "Billing", requiredPermission: "refund.read", screen: RefundsQueue },
    { id: "admin.refund-new", path: "/admin/refunds/new", title: "New refund", navGroup: "Billing", requiredPermission: "refund.request", screen: RefundNew },
    { id: "admin.refund-approve", path: "/admin/refunds/:id/approve", title: "Review refund", navGroup: "Billing", requiredPermission: "refund.approve", screen: RefundApprove },
    // ── Dunning + Revenue + Usage + Webhooks (M35A-T08) ──
    { id: "admin.dunning", path: "/admin/dunning", title: "Dunning", navGroup: "Billing", requiredPermission: "dunning.admin.read", screen: Dunning },
    { id: "admin.revenue", path: "/admin/revenue", title: "Revenue", navGroup: "Billing", requiredPermission: "revenue.admin.read", screen: Revenue },
    { id: "admin.usage", path: "/admin/usage/:organizationId", title: "Tenant usage", navGroup: "Billing", requiredPermission: "usage.admin.read", screen: Usage },
    { id: "admin.webhooks", path: "/admin/webhooks/stripe", title: "Stripe webhooks", navGroup: "Billing", requiredPermission: "stripe.admin.read", screen: Webhooks },
  ],
};
