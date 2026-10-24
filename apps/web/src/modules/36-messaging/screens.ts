import type { ScreenRegistryModule } from "@chartwarden/types";
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
const SmartInbox = lazy(() => import("./smart-inbox").then((m) => ({ default: m.SmartInbox })));
const AckBroadcast = lazy(() =>
  import("./ack-broadcast").then((m) => ({ default: m.AckBroadcast })),
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
const OffboardingWorkflow = lazy(() =>
  import("./offboarding-workflow").then((m) => ({ default: m.OffboardingWorkflow })),
);
const RetentionGovernance = lazy(() =>
  import("./retention-governance").then((m) => ({ default: m.RetentionGovernance })),
);
const ResponseAnalytics = lazy(() =>
  import("./response-analytics").then((m) => ({ default: m.ResponseAnalytics })),
);
const BreakGlassReview = lazy(() =>
  import("./break-glass-review").then((m) => ({ default: m.BreakGlassReview })),
);
const ExportMine = lazy(() => import("./export-mine").then((m) => ({ default: m.ExportMine })));
const ExternalPartners = lazy(() =>
  import("./partners").then((m) => ({ default: m.ExternalPartners })),
);
const ExportApprovals = lazy(() =>
  import("./export-approvals").then((m) => ({ default: m.ExportApprovals })),
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
      // WP 6.1 (ADR-0091): the caller's own ranked work. The screen says "not turned on" while the tenant flag `messaging.smart_inbox` is off.
      id: "messaging.inbox",
      path: "/messaging/inbox",
      title: "Work inbox",
      navGroup: "General",
      requiredPermission: "messaging.read",
      screen: SmartInbox,
    },
    {
      // WP 6.8 (ADR-0097): announcements that require acknowledgment (the caller's own list; a holder of messaging.announce also sees who has
      // not acknowledged). The screen says "not turned on" while the tenant flag `messaging.ack_broadcast` is off.
      id: "messaging.ack-broadcast",
      path: "/messaging/broadcasts",
      title: "Announcements to acknowledge",
      navGroup: "General",
      requiredPermission: "messaging.read",
      screen: AckBroadcast,
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
      // WP 5.9 (ADR-0084): a departed person's offboarding checklist. Reached by user id; omitted from nav (param path).
      id: "messaging.offboarding",
      path: "/messaging/governance/offboarding/:userId",
      title: "Offboarding",
      requiredPermission: "messaging.offboarding.manage",
      screen: OffboardingWorkflow,
    },
    {
      // WP 5.6 (ADR-0086, proposed): per-class retention view and the legal-hold list (place, release). The scan is plan-only; destruction is not built.
      id: "messaging.retention",
      path: "/messaging/governance/retention",
      title: "Retention and legal holds",
      navGroup: "Admin",
      requiredPermission: "messaging.retention.manage",
      screen: RetentionGovernance,
    },
    {
      // WP 6.2 (ADR-0092, proposed): aggregate response analytics. Hidden (404 -> "not turned on") until the tenant flag messaging.response_analytics is on.
      id: "messaging.response-analytics",
      path: "/messaging/analytics",
      title: "Response analytics",
      navGroup: "Admin",
      requiredPermission: "messaging.analytics.read",
      screen: ResponseAnalytics,
    },
    {
      // WP 5.8 (ADR-0087, proposed): the compliance review of break-glass access (queue, detail, complete). Reviews never depend on the tenant flag.
      id: "messaging.break-glass",
      path: "/messaging/governance/break-glass",
      title: "Break-glass review",
      navGroup: "Admin",
      requiredPermission: "messaging.break_glass.review",
      screen: BreakGlassReview,
    },
    {
      // WP 5.7 (ADR-0089, proposed): the caller's own message exports and the request entry (the entry also needs the tenant flag messaging.export).
      id: "messaging.export",
      path: "/messaging/export",
      title: "Message exports",
      navGroup: "Admin",
      requiredPermission: "messaging.export.request",
      screen: ExportMine,
    },
    {
      // WP 5.7 (ADR-0089, proposed): the approver queue for message exports. Approving never depends on the tenant flag.
      id: "messaging.export-approvals",
      path: "/messaging/governance/export-approvals",
      title: "Export approvals",
      navGroup: "Admin",
      requiredPermission: "messaging.export.approve",
      screen: ExportApprovals,
    },
    {
      // WP 6.6 (ADR-0096, proposed): share one conversation read-only with a pharmacy / DME partner, and revoke a share now. Creating also needs the
      // tenant flag messaging.external_partners; listing and revoking never do. The partner-facing view is not built.
      id: "messaging.partners",
      path: "/messaging/partners",
      title: "External partners",
      navGroup: "Admin",
      requiredPermission: "messaging.share.manage",
      screen: ExternalPartners,
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
