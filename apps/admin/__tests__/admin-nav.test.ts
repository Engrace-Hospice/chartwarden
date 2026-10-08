import { describe, expect, it } from "vitest";
// apps/admin — the console sidebar (shell/admin-nav.ts): grouped like the clinical app's, derived from the registered
// screens, never hiding a registered surface, and highlighting the list a detail screen belongs to.
import { activeAdminEntry, buildAdminNav } from "../src/shell/admin-nav";
import type { AdminScreenDescriptor } from "../src/shell/registry";

const Noop = () => null;
const screen = (id: string, path: string, extra: Partial<AdminScreenDescriptor> = {}) =>
  ({ id, path, title: id, screen: Noop, ...extra }) as AdminScreenDescriptor;

const SCREENS = [
  screen("admin.ops.outbox", "/admin/ops/outbox"),
  screen("admin.ops.outbox-detail", "/admin/ops/outbox/:id"),
  screen("saas.tenants", "/tenants"),
  screen("admin.refunds", "/admin/refunds"),
  screen("admin.refund-new", "/admin/refunds/new"),
  screen("x.unplaced", "/x"),
  screen("login", "/login", { chrome: false }),
];

describe("admin sidebar", () => {
  it("groups placed screens under their section after Overview, and puts unplaced ones in More", () => {
    const nav = buildAdminNav(SCREENS);
    expect(nav.map((s) => s.label)).toEqual([
      null,
      "Tenants",
      "Subscription billing",
      "Operations",
      "More",
    ]);
    expect(nav[0]?.entries.map((e) => e.to)).toEqual(["/"]);
    expect(nav.at(-1)?.entries.map((e) => e.key)).toEqual(["x.unplaced"]);
  });

  it("leaves out parameterised screens, chromeless screens and list actions", () => {
    const keys = buildAdminNav(SCREENS).flatMap((s) => s.entries.map((e) => e.key));
    expect(keys).not.toContain("admin.ops.outbox-detail");
    expect(keys).not.toContain("admin.refund-new");
    expect(keys).not.toContain("login");
  });

  it("marks the list a detail or action path belongs to, and Overview only at /", () => {
    const nav = buildAdminNav(SCREENS);
    expect(activeAdminEntry(nav, "/admin/refunds/new")).toBe("admin.refunds");
    expect(activeAdminEntry(nav, "/admin/ops/outbox")).toBe("admin.ops.outbox");
    expect(activeAdminEntry(nav, "/")).toBe("overview");
    expect(activeAdminEntry(nav, "/nowhere")).toBeUndefined();
  });
});
