import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/39-consent — M39 screen registration (Track B, ADR-0030).
//
// M39's first web surface. Until now the module had no `apps/web` codePath in the manifest at all, so
// `arch:parity` would have failed before any file landed — the manifest entry is the actual unblock, and
// these three screens are the documented specs it makes buildable.
//
// WX-PR-010 adds the two write screens (report 09 mini-specs #1/#2): capture-and-sign and lifecycle
// detail, over the WX-PR-009 Drizzle lifecycle. `consent.author` gates both — creating a draft only
// needs AUTHOR, but the sign/revoke/supersede/renew actions on each screen additionally require
// `consent.sign`/`consent.revoke` server-side (checked per-route, not per-screen) plus a fresh step-up.
import { lazy } from "react";
import type { ComponentType } from "react";
const ConsentExpirationRenewal = lazy(() =>
  import("./consent-expiration-renewal").then((m) => ({ default: m.ConsentExpirationRenewal })),
);
const ConsentRecipientsDpoa = lazy(() =>
  import("./consent-recipients-dpoa").then((m) => ({ default: m.ConsentRecipientsDpoa })),
);
const ConsentRecordManager = lazy(() =>
  import("./consent-record-manager").then((m) => ({ default: m.ConsentRecordManager })),
);
const ConsentCapture = lazy(() =>
  import("./consent-capture").then((m) => ({ default: m.ConsentCapture })),
);
const ConsentDetail = lazy(() =>
  import("./consent-detail").then((m) => ({ default: m.ConsentDetail })),
);

export const consentScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 39,
  slug: "39-consent",
  screens: [
    {
      id: "consent.record-manager",
      path: "/patients/:patientId/consents",
      title: "Consents",
      navGroup: "Clinical",
      requiredPermission: "consent.read",
      screen: ConsentRecordManager,
    },
    {
      id: "consent.capture",
      path: "/patients/:patientId/consents/new",
      title: "New Consent",
      navGroup: "Clinical",
      requiredPermission: "consent.author",
      screen: ConsentCapture,
    },
    {
      id: "consent.detail",
      path: "/patients/:patientId/consents/:consentId",
      title: "Consent Detail",
      navGroup: "Clinical",
      requiredPermission: "consent.read",
      screen: ConsentDetail,
    },
    {
      id: "consent.expiration-renewal",
      path: "/patients/:patientId/consents/expiring",
      title: "Expiring Consents",
      navGroup: "Compliance",
      requiredPermission: "consent.read",
      screen: ConsentExpirationRenewal,
    },
    {
      id: "consent.recipients-dpoa",
      path: "/consents/:consentId/recipients",
      title: "Recipients & DPOA",
      navGroup: "Compliance",
      requiredPermission: "consent.read",
      screen: ConsentRecipientsDpoa,
    },
  ],
};
