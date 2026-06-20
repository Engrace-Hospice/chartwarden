// apps/web/src/modules/36-messaging — M36 screen registration (Track A, ADR-0030).
import type { ComponentType } from "react";
import type { ScreenRegistryModule } from "@wardenx/types";
import { NotificationsInbox } from "./notifications-inbox";
import { StaffMessaging } from "./staff-messaging";

export const messagingScreens: ScreenRegistryModule<ComponentType> = {
  moduleId: 36,
  slug: "36-messaging",
  screens: [
    {
      id: "messaging.staff",
      path: "/messaging",
      title: "Messaging",
      navGroup: "General",
      requiredPermission: "messaging.read",
      screen: StaffMessaging,
    },
    {
      id: "messaging.notifications",
      path: "/notifications",
      title: "Notifications",
      navGroup: "General",
      screen: NotificationsInbox,
    },
  ],
};
