import type { ScreenRegistryModule } from "@wardenx/types";
// apps/admin/src/modules/36-messaging — M36 platform-ops admin screens, registered into the M34-owned admin shell
// at composition (apps/admin/src/main.tsx), the same pattern as 35-subscription-billing. Each `requiredPermission`
// is the key the matching backend route gates on; the server stays authoritative, this only gates nav visibility.
import type { ComponentType } from "react";
import { AlertDeliveries } from "./alert-deliveries";
import { ChannelMembers } from "./channel-members";
import { IntegrityTile } from "./integrity-tile";
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
      screen: IntegrityTile as ComponentType,
    },
    ...settingsScreens,
  ],
};
