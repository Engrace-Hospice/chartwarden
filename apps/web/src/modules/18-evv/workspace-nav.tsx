import type { JSX } from "react";
import { Link, useLocation } from "react-router-dom";
import { useSession } from "../../shell/session";

interface EvvWorkspaceItem {
  readonly label: string;
  readonly to: string;
  readonly permission: string;
  readonly current: (pathname: string) => boolean;
}

const ITEMS: readonly EvvWorkspaceItem[] = [
  {
    label: "Overview",
    to: "/evv/dashboard",
    permission: "evv.read_metrics",
    current: (pathname) => pathname === "/evv/dashboard" || pathname === "/admin/evv-metrics",
  },
  {
    label: "Needs attention",
    to: "/evv/missing-resolutions?status=open",
    permission: "evv.missing_resolution.read",
    current: (pathname) => pathname === "/evv/missing-resolutions",
  },
  {
    label: "Events",
    to: "/evv/events",
    permission: "evv.read",
    current: (pathname) => pathname === "/evv/events" || pathname.startsWith("/evv/events/"),
  },
  {
    label: "Submissions",
    to: "/evv/aggregator-submissions",
    permission: "evv.aggregator.read",
    current: (pathname) => pathname === "/evv/aggregator-submissions",
  },
  {
    label: "Policies",
    to: "/evv/geofence-policy",
    permission: "evv.policy.read",
    current: (pathname) => pathname === "/evv/geofence-policy",
  },
  {
    label: "Devices",
    to: "/evv/devices/pending",
    permission: "evv.device.read",
    current: (pathname) => pathname === "/evv/devices/pending" || pathname === "/me/evv/devices",
  },
] as const;

export function EvvWorkspaceNav(): JSX.Element | null {
  const location = useLocation();
  const permissions = useSession()?.permissions ?? [];
  const items = ITEMS.filter((item) => permissions.includes(item.permission));

  if (items.length === 0) return null;

  return (
    <nav className="wx-subtabs" aria-label="EVV operations">
      {items.map((item) => {
        const current = item.current(location.pathname);
        return (
          <Link
            key={item.to}
            to={item.to}
            className={current ? "is-current" : undefined}
            aria-current={current ? "page" : undefined}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
