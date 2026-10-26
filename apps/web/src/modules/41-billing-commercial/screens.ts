// apps/web/src/modules/41-billing-commercial — M41 Billing — Commercial screen registration (issue #726, spec section 5). Each
// `requiredPermission` is the real key the routes gate on (commercial_billing.read, created by migration 1265); the server stays
// the authoritative enforcer, this gates nav visibility only. The lane sits under "Billing" beside Medicare and Medicaid.
import type { ScreenRegistryModule } from "@chartwarden/types";
import { lazy } from "react";
import type { ComponentType } from "react";

const CommercialClaimQueue = lazy(() =>
  import("./claim-queue").then((m) => ({ default: m.CommercialClaimQueue })),
);
const CommercialAssembleClaim = lazy(() =>
  import("./assemble-claim").then((m) => ({ default: m.CommercialAssembleClaim })),
);
const CommercialClaimDetail = lazy(() =>
  import("./claim-detail").then((m) => ({ default: m.CommercialClaimDetail })),
);
const SupportedPayers = lazy(() =>
  import("./supported-payers").then((m) => ({ default: m.SupportedPayers })),
);

const CommercialAuthorizations = lazy(() =>
  import("./authorizations").then((m) => ({ default: m.CommercialAuthorizations })),
);

const CommercialEnrollments = lazy(() =>
  import("./enrollments").then((m) => ({ default: m.CommercialEnrollments })),
);

const CommercialEligibility = lazy(() =>
  import("./eligibility").then((m) => ({ default: m.CommercialEligibility })),
);

export const commercialBillingScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 41,
  slug: "41-billing-commercial",
  screens: [
    {
      id: "commercial.claims",
      path: "/commercial/billing/claims",
      title: "Commercial Claims",
      navGroup: "Billing",
      requiredPermission: "commercial_billing.read",
      screen: CommercialClaimQueue,
    },
    {
      id: "commercial.assemble-claim",
      path: "/commercial/billing/claims/new",
      title: "Assemble Commercial Claim",
      navGroup: "Billing",
      requiredPermission: "commercial_billing.write",
      screen: CommercialAssembleClaim,
    },
    {
      id: "commercial.claim",
      path: "/commercial/billing/claims/:claimId",
      title: "Commercial Claim",
      navGroup: "Billing",
      requiredPermission: "commercial_billing.read",
      screen: CommercialClaimDetail,
    },
    {
      id: "commercial.payers",
      path: "/commercial/billing/payers",
      title: "Supported Payers",
      navGroup: "Billing",
      requiredPermission: "commercial_billing.read",
      screen: SupportedPayers,
    },
    {
      id: "commercial.authorizations",
      path: "/commercial/billing/authorizations",
      title: "Commercial Authorizations",
      navGroup: "Billing",
      requiredPermission: "commercial_billing.read",
      screen: CommercialAuthorizations,
    },
    {
      id: "commercial.enrollments",
      path: "/commercial/billing/enrollments",
      title: "Commercial Enrollments",
      navGroup: "Billing",
      requiredPermission: "commercial_billing.read",
      screen: CommercialEnrollments,
    },
    {
      id: "commercial.eligibility",
      path: "/commercial/billing/eligibility",
      title: "Commercial Eligibility",
      navGroup: "Billing",
      requiredPermission: "commercial_billing.read",
      screen: CommercialEligibility,
    },
  ],
};
