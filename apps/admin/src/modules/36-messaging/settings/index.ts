// apps/admin/src/modules/36-messaging/settings — M36 settings screens (alert rules, notification preferences,
// delivery endpoints). `settingsScreens` is spread into the module's `screens` array at registration.
import type { ScreenDescriptor } from "@chartwarden/types";
import { lazy } from "react";
import type { ComponentType } from "react";
const AlertRules = lazy(() => import("./alert-rules").then((m) => ({ default: m.AlertRules })));
const DeliveryEndpoints = lazy(() =>
  import("./delivery-endpoints").then((m) => ({ default: m.DeliveryEndpoints })),
);
const NotificationPreferences = lazy(() =>
  import("./notification-preferences").then((m) => ({ default: m.NotificationPreferences })),
);

export { AlertRules, DeliveryEndpoints, NotificationPreferences };

// requiredPermission keys are the REAL permissions the backend routes gate on (messaging-routes.ts).
export const settingsScreens: ScreenDescriptor<ComponentType>[] = [
  {
    id: "admin.messaging.alert-rules",
    path: "/admin/messaging/alert-rules",
    title: "Alert rules",
    navGroup: "Messaging",
    requiredPermission: "alert.rules.read",
    screen: AlertRules,
  },
  {
    id: "admin.messaging.notification-preferences",
    path: "/admin/messaging/notification-preferences",
    title: "Notification preferences",
    navGroup: "Messaging",
    requiredPermission: "notifications.preferences.manage",
    screen: NotificationPreferences,
  },
  {
    id: "admin.messaging.delivery-endpoints",
    path: "/admin/messaging/delivery-endpoints",
    title: "Delivery endpoints",
    navGroup: "Messaging",
    requiredPermission: "notifications.endpoint.manage",
    screen: DeliveryEndpoints,
  },
];
