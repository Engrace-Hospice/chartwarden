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
const GlobalSearchSettings = lazy(() =>
  import("./global-search-settings").then((m) => ({ default: m.GlobalSearchSettings })),
);
const StaffMessaging = lazy(() =>
  import("./staff-messaging").then((m) => ({ default: m.StaffMessaging })),
);
const UnacknowledgedQueue = lazy(() =>
  import("./unacknowledged-queue").then((m) => ({ default: m.UnacknowledgedQueue })),
);
const NotificationPreferences = lazy(() =>
  import("./notification-preferences").then((m) => ({ default: m.NotificationPreferences })),
);
const OnCallDirectory = lazy(() =>
  import("./oncall-directory").then((m) => ({ default: m.OnCallDirectory })),
);
const DeviceManager = lazy(() =>
  import("./device-manager").then((m) => ({ default: m.DeviceManager })),
);
const SessionGovernance = lazy(() =>
  import("./session-governance").then((m) => ({ default: m.SessionGovernance })),
);
const NotificationLanding = lazy(() =>
  import("./notification-landing").then((m) => ({ default: m.NotificationLanding })),
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
      // WP 4.9 (ADR-0076): the supervisor's queue of requests still waiting for a human; the API demands messaging.review as well.
      id: "messaging.unacknowledged",
      path: "/messaging/unacknowledged",
      title: "Unacknowledged urgent requests",
      navGroup: "General",
      requiredPermission: "messaging.review",
      screen: UnacknowledgedQueue,
    },
    {
      // WP 4.6 (ADR-0073): the caller's own routing, quiet hours and vacation forwarding. The screen says "not turned on" while the tenant flag
      // `messaging.notification_policy` is off (the API gives the nav no flag signal, so the screen itself fails closed).
      id: "messaging.preferences",
      path: "/messaging/preferences",
      title: "My notifications",
      navGroup: "General",
      requiredPermission: "messaging.read",
      screen: NotificationPreferences,
    },
    {
      // WP 4.12 (ADR-0080): the read-only "who is covering now" directory; the API demands messaging.read as well and the tenant flag.
      id: "messaging.on-call",
      path: "/messaging/on-call",
      title: "On call now",
      navGroup: "General",
      requiredPermission: "messaging.oncall.read",
      screen: OnCallDirectory,
    },
    {
      // WP 5.5 (ADR-0083): the caller's own sessions and a Revoke for each. Self-service: no permission key (the API returns only the caller's own).
      id: "messaging.devices",
      path: "/messaging/devices",
      title: "Devices and sessions",
      navGroup: "General",
      screen: DeviceManager,
    },
    {
      // WP 5.5 (ADR-0083): a security officer lists and revokes another person's sessions; the revoke also needs a fresh step-up.
      id: "messaging.session-governance",
      path: "/messaging/governance/sessions",
      title: "Sessions",
      navGroup: "Admin",
      requiredPermission: "messaging.sessions.manage",
      screen: SessionGovernance,
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
      id: "messaging.global-search-settings",
      path: "/messaging/search-settings",
      title: "Global search settings",
      navGroup: "Admin",
      requiredPermission: "messaging.global_search.manage",
      screen: GlobalSearchSettings,
    },
    {
      // WP 4.8: the landing of an out-of-band link (`/n/<opaque delivery id>`); omitted from nav (param path).
      id: "messaging.notification-landing",
      path: "/n/:id",
      title: "Notification",
      screen: NotificationLanding,
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
