// apps/web/src/modules/11-orders — M11 screen registration (Track B, ADR-0030).
// The §5 Orders read screens that have a backing M11 read route on the generated client: the global
// physician Signature Inbox (§5, pending-signature), the per-patient Orders list (§5, "Use Patient
// Workspace"), the Order Detail (§5), the Verbal-Expiring queue (§5, 48h countdown), the Cosign-Pending
// queue (§5 §2.5), the Lab Results-Pending-Review queue (§5 D17), and the Standing-Order admin (§5 §2.4 D5).
// Nav visibility is gated by the matching M11 permission key; the SERVER stays the only enforcement point
// (no frontend authz, ADR-0030). The draft modal (all 8 kinds), the sign step-up, the record-verbal /
// cosign / discontinue / mark-reviewed / correct write surfaces, and the verbal-policy admin fill in as
// those write paths harden.
import type { ComponentType } from "react";
import type { ScreenRegistryModule } from "@wardenx/types";
import { CosignQueue } from "./cosign-queue";
import { OrderDetail } from "./order-detail";
import { OrdersSignInbox } from "./orders-sign-inbox";
import { PatientOrders } from "./patient-orders";
import { ResultsReviewQueue } from "./results-review-queue";
import { StandingOrders } from "./standing-orders";
import { VerbalExpiringQueue } from "./verbal-expiring-queue";

export const orderScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 11,
  slug: "11-orders",
  screens: [
    {
      // Physician signature inbox — global queue of orders awaiting signature; top-level nav surface.
      id: "orders.sign-inbox",
      path: "/orders",
      title: "Orders",
      navGroup: "Clinical",
      requiredPermission: "orders.read",
      screen: OrdersSignInbox,
    },
    {
      // Patient orders list — reached from the patient chart "Orders" tab; param path (no nav).
      id: "orders.patient-list",
      path: "/patients/:patientId/orders",
      title: "Orders",
      requiredPermission: "orders.read",
      screen: PatientOrders,
    },
    {
      // Order detail — reached from a worklist/list row; param path (no nav).
      id: "orders.detail",
      path: "/orders/:id",
      title: "Order",
      requiredPermission: "orders.read",
      screen: OrderDetail,
    },
    {
      // Verbal-expiring queue — verbal_pending orders inside the 48h window, live countdown.
      id: "orders.verbal-expiring",
      path: "/orders/verbal-expiring",
      title: "Verbal Orders",
      navGroup: "Clinical",
      requiredPermission: "orders.read",
      screen: VerbalExpiringQueue,
    },
    {
      // Cosign-pending queue — LPN-drafted orders awaiting RN/supervisor cosignature.
      id: "orders.cosign-pending",
      path: "/orders/cosign-pending",
      title: "Cosign Queue",
      navGroup: "Clinical",
      requiredPermission: "orders.read",
      screen: CosignQueue,
    },
    {
      // Lab results-pending-review queue — results received awaiting clinician Mark-reviewed (D17).
      id: "orders.results-review",
      path: "/orders/results-pending-review",
      title: "Results Review",
      navGroup: "Clinical",
      requiredPermission: "orders.read",
      screen: ResultsReviewQueue,
    },
    {
      // Standing-order admin — templates + cadence + spawn history (D5).
      id: "orders.standing",
      path: "/standing-orders",
      title: "Standing Orders",
      navGroup: "Clinical",
      requiredPermission: "orders.read",
      screen: StandingOrders,
    },
  ],
};
