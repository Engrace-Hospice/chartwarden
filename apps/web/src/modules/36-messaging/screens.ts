import type { ScreenRegistryModule } from "@wardenx/types";
// apps/web/src/modules/36-messaging — M36 screen registration (Track A, ADR-0030).
import { lazy } from "react";
import type { ComponentType } from "react";
const NotificationsInbox = lazy(() =>
  import("./notifications-inbox").then((m) => ({ default: m.NotificationsInbox })),
);
const SavedReplies = lazy(() =>
  import("./saved-replies-screen").then((m) => ({ default: m.SavedReplies })),
);
const StaffMessaging = lazy(() =>
  import("./staff-messaging").then((m) => ({ default: m.StaffMessaging })),
);

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
      id: "messaging.saved-replies",
      path: "/messaging/saved-replies",
      title: "Saved replies",
      navGroup: "General",
      requiredPermission: "messaging.send",
      screen: SavedReplies,
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
