import type { GlyphName } from "@chartwarden/ui";
import { PORTAL_SCREEN_MANIFEST } from "./screens/manifest";

export type PortalNavSection = "primary" | "secondary";

export interface PortalNavItem {
  id: string;
  label: string;
  icon: GlyphName;
  section: PortalNavSection;
  mobile?: "home" | "visits" | "messages";
}

/**
 * Presentation order only. Paths and permission metadata continue to come from the screen manifest.
 * There is intentionally no scopeSet-to-permission translation: the portal API does not expose a
 * trustworthy effective-permissions projection. Backend route guards remain authoritative.
 */
export const PORTAL_NAVIGATION: readonly PortalNavItem[] = [
  {
    id: "portal.dashboard",
    label: "Home",
    icon: "home",
    section: "primary",
    mobile: "home",
  },
  {
    id: "portal.visits",
    label: "Visits",
    icon: "calendar",
    section: "primary",
    mobile: "visits",
  },
  {
    id: "portal.messages",
    label: "Messages",
    icon: "message-square",
    section: "primary",
    mobile: "messages",
  },
  {
    id: "portal.care-plan",
    label: "Care plan",
    icon: "clipboard-check",
    section: "primary",
  },
  {
    id: "portal.medications",
    label: "Medications",
    icon: "pill",
    section: "primary",
  },
  {
    id: "portal.documents",
    label: "Documents",
    icon: "file-text",
    section: "primary",
  },
  {
    id: "portal.bereavement",
    label: "Bereavement support",
    icon: "heart",
    section: "secondary",
  },
  {
    id: "portal.amendments",
    label: "Request a correction",
    icon: "pencil",
    section: "secondary",
  },
  {
    id: "portal.preferences",
    label: "Notifications",
    icon: "bell",
    section: "secondary",
  },
  {
    id: "portal.account",
    label: "Account & security",
    icon: "shield-check",
    section: "secondary",
  },
] as const;

const manifestById = new Map(
  PORTAL_SCREEN_MANIFEST.map((screen) => [screen.id, screen]),
);

export function portalNavPath(id: string, patientId: string): string {
  const screen = manifestById.get(id);
  if (!screen) throw new Error(`portal navigation: unknown screen id "${id}"`);
  return screen.path.replace(":patientId", encodeURIComponent(patientId));
}

export function portalNavTitle(pathname: string): string {
  if (pathname === "/patient-picker") return "Choose patient";
  const item = [...PORTAL_NAVIGATION]
    .sort(
      (a, b) =>
        (manifestById.get(b.id)?.path.length ?? 0) -
        (manifestById.get(a.id)?.path.length ?? 0),
    )
    .find(({ id }) => {
      const screen = manifestById.get(id);
      if (!screen) return false;
      const pattern = screen.path
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(":patientId", "[^/]+");
      const suffix = id === "portal.dashboard" ? "$" : "(?:/|$)";
      return new RegExp(`^${pattern}${suffix}`).test(pathname);
    });
  return item?.label ?? "Family Portal";
}
