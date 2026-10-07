import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/11-orders — M11 screen registration (Track B, ADR-0030).
// The §5 Orders read screens that have a backing M11 read route on the generated client: the global
// physician Signature Inbox (§5, pending-signature), the per-patient Orders list (§5, "Use Patient
// Workspace"), the Order Detail (§5), the Verbal-Expiring queue (§5, 48h countdown), the Cosign-Pending
// queue (§5 §2.5), the Lab Results-Pending-Review queue (§5 D17), and the Standing-Order admin (§5 §2.4 D5).
// Nav visibility is gated by the matching M11 permission key; the SERVER stays the only enforcement point
// (no frontend authz, ADR-0030).
//
// WRITE SURFACES (#91). The five §2.2/§2.3/§2.5/§2.6 ceremonies are BUILT: sign, cosign, record-verbal,
// discontinue and mark-reviewed, shared by the four queues and the detail pane through
// `order-action-modal.tsx` and committing to the real routes via `orders-api.ts`. Each queue now offers
// the action it exists for — before this, all seven screens together issued ZERO mutations, so a physician
// could open "orders awaiting your signature" and have no way to sign one.
//
// "The sign step-up" used to be listed here as deferred. There is none to defer:
// `POST /api/v1/orders/:id/sign` mounts `[SIGN, ABAC_SIGN]` and nothing else, `requireStepUp` appears
// nowhere in M11, and the module spec (v0_4) does not mention step-up at all — M8's encounter signature is
// the one that requires it, which is the likely source of the assumption. A re-authentication ceremony the
// server never asks for would be client-side theatre; if M11 SHOULD require one, that is a spec decision
// and a server change, not a modal.
//
// GAP-125 — HELD TRANSMISSIONS. `/orders/held-transmissions` is the F-201 worklist of lab orders whose HL7 message
// dead-ended, with the F-187/F-188 attested recovery (step-up gated) and the F-202 co-sign / cancel in its drawer.
// Gated by `orders.transmission.view_held` (the server's grant for the list); the recovery controls follow
// `orders.transmission.recover` / `.cosign_escalated`. Before this, a held order could be recovered only via the API.
//
// STILL DEFERRED, named so the corpus stays the accurate inventory: the AUTHORING draft modal (all 8
// kinds, `POST /api/v1/orders`), `correct`, and the standing-order + verbal-policy admin writes.
//
// E2E (#91 AC5): `e2e/specs/orders.spec.ts` drives the signature round trip in a real browser — the
// order appears in the inbox, the RN signs it from the row, and it LEAVES the inbox. Writing it required
// changing the seed: `db:seed:scenario-orders-idg` drove its only order all the way to `signed`, so this
// queue was permanently empty on a seeded stack and the only spec anyone could have written would have
// asserted the empty state, passing forever and proving nothing (the #106/F-046 shape).
import { lazy } from "react";
import type { ComponentType } from "react";
const CosignQueue = lazy(() => import("./cosign-queue").then((m) => ({ default: m.CosignQueue })));
const OrderDetail = lazy(() => import("./order-detail").then((m) => ({ default: m.OrderDetail })));
const HeldTransmissions = lazy(() =>
  import("./held-transmissions").then((m) => ({ default: m.HeldTransmissions })),
);
const OrdersSignInbox = lazy(() =>
  import("./orders-sign-inbox").then((m) => ({ default: m.OrdersSignInbox })),
);
const PatientOrders = lazy(() =>
  import("./patient-orders").then((m) => ({ default: m.PatientOrders })),
);
const ResultsReviewQueue = lazy(() =>
  import("./results-review-queue").then((m) => ({ default: m.ResultsReviewQueue })),
);
const StandingOrders = lazy(() =>
  import("./standing-orders").then((m) => ({ default: m.StandingOrders })),
);
const VerbalExpiringQueue = lazy(() =>
  import("./verbal-expiring-queue").then((m) => ({ default: m.VerbalExpiringQueue })),
);

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
      // Held lab-order transmissions — dead-ended HL7 messages awaiting an attested recovery (F-201, GAP-125).
      id: "orders.held-transmissions",
      path: "/orders/held-transmissions",
      title: "Held Transmissions",
      navGroup: "Clinical",
      requiredPermission: "orders.transmission.view_held",
      screen: HeldTransmissions,
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
