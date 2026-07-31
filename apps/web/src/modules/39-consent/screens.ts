import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/39-consent — M39 screen registration (Track B, ADR-0030).
//
// M39's first web surface. Until now the module had no `apps/web` codePath in the manifest at all, so
// `arch:parity` would have failed before any file landed — the manifest entry is the actual unblock, and
// these three screens are the documented specs it makes buildable.
import type { ComponentType } from "react";
import { ConsentExpirationRenewal } from "./consent-expiration-renewal";
import { ConsentRecipientsDpoa } from "./consent-recipients-dpoa";
import { ConsentRecordManager } from "./consent-record-manager";

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
