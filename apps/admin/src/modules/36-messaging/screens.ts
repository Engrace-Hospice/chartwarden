import type { ScreenRegistryModule } from "@chartwarden/types";
// apps/admin/src/modules/36-messaging — M36 platform-ops admin screens, registered into the M34-owned admin shell
// at composition (apps/admin/src/main.tsx), the same pattern as 35-subscription-billing. Each `requiredPermission`
// is the key the matching backend route gates on; the server stays authoritative, this only gates nav visibility.
import { lazy } from "react";
import type { ComponentType } from "react";

// Route-level code splitting (#849): each screen is its own chunk; the shell wraps routes in <Suspense>.
const AlertDeliveries = lazy(() =>
  import("./alert-deliveries").then((m) => ({ default: m.AlertDeliveries })),
);
const ChannelMembers = lazy(() =>
  import("./channel-members").then((m) => ({ default: m.ChannelMembers })),
);
const IntegrityTile = lazy(() =>
  import("./integrity-tile").then((m) => ({ default: m.IntegrityTile })),
);
import { settingsScreens } from "./settings";

export const messagingAdminScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 36,
  slug: "36-messaging",
  screens: [
    {
      id: "admin.messaging.alert-deliveries",
      path: "/admin/messaging/alert-deliveries",
      title: "Alert deliveries",
      navGroup: "Messaging",
      requiredPermission: "messaging.admin.read",
      screen: AlertDeliveries,
    },
    {
      id: "admin.messaging.channel-members",
      path: "/admin/messaging/channels/:id/members",
      title: "Channel members",
      navGroup: "Messaging",
      requiredPermission: "messaging.manage_members",
      screen: ChannelMembers,
    },
    {
      id: "admin.messaging.integrity",
      path: "/admin/messaging/integrity",
      title: "Integrity jobs",
      navGroup: "Messaging",
      requiredPermission: "audit.read",
      screen: IntegrityTile,
    },
    ...settingsScreens,
  ],
};
