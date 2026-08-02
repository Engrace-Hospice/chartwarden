import type { ScreenDescriptor, ScreenRegistry, ScreenRegistryModule } from "@wardenx/types";
// @wardenx/portal — concrete screen registry (M31 §5.1, Track B / ADR-0030). Binds each metadata entry in
// PORTAL_SCREEN_MANIFEST to its React component, producing the `portalScreens` module the portal composition
// root (main.tsx) registers into a registry the shell reads to build its router. Mirrors the M1 web-shell
// registry contract (`@wardenx/types` ScreenRegistry) so the portal is a first-class, gate-shaped SPA rather
// than an ad-hoc router.
import type { ComponentType } from "react";
import { PortalAccount } from "./account";
import { PortalAmendments } from "./amendments";
import { PortalBereavement } from "./bereavement";
import { PortalCarePlanView } from "./care-plan";
import { PortalDocumentList } from "./documents";
import { PORTAL_SCREEN_MANIFEST } from "./manifest";
import { PortalMedicationList } from "./medications";
import { PortalMessages } from "./messages";
import { PortalNotificationPreferences } from "./preferences";
import { PortalPatientDashboard } from "./patient-dashboard";
import { PortalPatientPicker } from "./patient-picker";
import { PortalSignIn } from "./sign-in";
import { TelehealthWaitingRoom } from "./telehealth-waiting-room";
import { PortalVisitList } from "./visits";

export type PortalScreen = ComponentType;

/** id → component. Every PORTAL_SCREEN_MANIFEST id must resolve here (asserted at module build below). */
const COMPONENTS: Record<string, PortalScreen> = {
  "portal.sign-in": PortalSignIn,
  "portal.patient-picker": PortalPatientPicker,
  "portal.dashboard": PortalPatientDashboard,
  "portal.care-plan": PortalCarePlanView,
  "portal.visits": PortalVisitList,
  "portal.telehealth": TelehealthWaitingRoom,
  "portal.medications": PortalMedicationList,
  "portal.documents": PortalDocumentList,
  "portal.messages": PortalMessages,
  "portal.amendments": PortalAmendments,
  "portal.preferences": PortalNotificationPreferences,
  "portal.bereavement": PortalBereavement,
  "portal.account": PortalAccount,
};

const screens: ScreenDescriptor<PortalScreen>[] = PORTAL_SCREEN_MANIFEST.map((m) => {
  const screen = COMPONENTS[m.id];
  if (!screen) throw new Error(`portal registry: no component bound for screen id "${m.id}"`);
  return {
    id: m.id,
    path: m.path,
    title: m.title,
    navGroup: m.navGroup,
    requiredPermission: m.requiredPermission,
    chrome: m.chrome,
    screen,
  };
});

export const portalScreens: ScreenRegistryModule<PortalScreen> = {
  moduleId: 31,
  slug: "31-portal",
  screens,
};

/** Create an empty registry (M1 contract). The composition root registers `portalScreens` into it. */
export function createPortalRegistry(): ScreenRegistry<PortalScreen> {
  const modules: ScreenRegistryModule<PortalScreen>[] = [];
  const ids = new Set<string>();
  return {
    register(module) {
      for (const s of module.screens) {
        if (ids.has(s.id)) throw new Error(`duplicate portal screen id: "${s.id}" (module ${module.slug})`);
        ids.add(s.id);
      }
      modules.push(module);
    },
    modules() {
      return [...modules];
    },
    screens() {
      return modules.flatMap((m) => m.screens);
    },
  };
}
