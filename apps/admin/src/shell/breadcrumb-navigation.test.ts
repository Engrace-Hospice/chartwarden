import { describe, expect, it } from "vitest";
import type { AdminNavSection } from "./admin-nav";
import { resolveAdminBreadcrumbs } from "./breadcrumb-navigation";
import type { AdminScreenDescriptor } from "./registry";

const screens: AdminScreenDescriptor[] = [
  { id: "subscriptions", path: "/admin/subscriptions", title: "Subscriptions", screen: () => null },
  { id: "usage", path: "/admin/usage/:organizationId", title: "Usage", screen: () => null },
];
const sections: AdminNavSection[] = [
  {
    label: "Subscription billing",
    entries: [
      { key: "subscriptions", label: "Subscriptions", to: "/admin/subscriptions", icon: "receipt" },
    ],
  },
];

describe("admin breadcrumbs", () => {
  it("links a usage detail back to its subscription group", () => {
    expect(resolveAdminBreadcrumbs("/admin/usage/org-1", screens, sections)).toEqual([
      { label: "Subscription billing", href: "/admin/subscriptions" },
      { label: "Subscriptions", href: "/admin/subscriptions" },
      { label: "Usage" },
    ]);
  });
});
