import type { ScreenDescriptor, ScreenRegistry, ScreenRegistryModule } from "@chartwarden/types";
// @chartwarden/portal — concrete screen registry (M31 §5.1, Track B / ADR-0030). Binds each metadata entry in
// PORTAL_SCREEN_MANIFEST to its React component, producing the `portalScreens` module the portal composition
// root (main.tsx) registers into a registry the shell reads to build its router. Mirrors the M1 web-shell
// registry contract (`@chartwarden/types` ScreenRegistry) so the portal is a first-class, gate-shaped SPA rather
// than an ad-hoc router.
import { lazy } from "react";
import type { ComponentType } from "react";
import { PORTAL_SCREEN_MANIFEST } from "./manifest";

export type PortalScreen = ComponentType;

/**
 * Route-level code splitting (#849): each screen is its own chunk, so the entry carries only the shell + manifest.
 * `app.tsx` wraps every route element in a Suspense boundary.
 */
function lazyScreen<K extends string>(
  load: () => Promise<Record<K, ComponentType>>,
  name: K,
): PortalScreen {
  return lazy(() => load().then((m) => ({ default: m[name] as ComponentType })));
}

/** id → component. Every PORTAL_SCREEN_MANIFEST id must resolve here (asserted at module build below). */
const COMPONENTS: Record<string, PortalScreen> = {
  "portal.sign-in": lazyScreen(() => import("./sign-in"), "PortalSignIn"),
  "portal.accept-invitation": lazyScreen(
    () => import("./accept-invitation"),
    "PortalAcceptInvitation",
  ),
  "portal.signed-in": lazyScreen(() => import("./signed-in"), "PortalSignedIn"),
  "portal.link-redeem-funeral": lazyScreen(() => import("./funeral-redeem"), "PortalLinkRedeem"),
  "portal.link-redeem-collaborator": lazyScreen(
    () => import("./funeral-redeem"),
    "PortalLinkRedeem",
  ),
  "portal.funeral-case": lazyScreen(() => import("./funeral-case"), "PortalFuneralCase"),
  "portal.patient-picker": lazyScreen(() => import("./patient-picker"), "PortalPatientPicker"),
  "portal.dashboard": lazyScreen(() => import("./patient-dashboard"), "PortalPatientDashboard"),
  "portal.care-plan": lazyScreen(() => import("./care-plan"), "PortalCarePlanView"),
  "portal.visits": lazyScreen(() => import("./visits"), "PortalVisitList"),
  "portal.telehealth": lazyScreen(
    () => import("./telehealth-waiting-room"),
    "TelehealthWaitingRoom",
  ),
  "portal.medications": lazyScreen(() => import("./medications"), "PortalMedicationList"),
  "portal.documents": lazyScreen(() => import("./documents"), "PortalDocumentList"),
  "portal.messages": lazyScreen(() => import("./messages"), "PortalMessages"),
  "portal.amendments": lazyScreen(() => import("./amendments"), "PortalAmendments"),
  "portal.preferences": lazyScreen(() => import("./preferences"), "PortalNotificationPreferences"),
  "portal.bereavement": lazyScreen(() => import("./bereavement"), "PortalBereavement"),
  "portal.account": lazyScreen(() => import("./account"), "PortalAccount"),
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
        if (ids.has(s.id))
          throw new Error(`duplicate portal screen id: "${s.id}" (module ${module.slug})`);
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
