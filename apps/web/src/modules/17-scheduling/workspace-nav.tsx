import type { JSX } from "react";
import { Link, useLocation } from "react-router-dom";
import { useSession } from "../../shell/session";

export interface SchedulingWorkspaceNavProps {
  patientId?: string | null;
}

function withPatient(path: string, patientId?: string | null): string {
  if (!patientId) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}patient=${encodeURIComponent(patientId)}`;
}

export function SchedulingWorkspaceNav({ patientId }: SchedulingWorkspaceNavProps): JSX.Element {
  const location = useLocation();
  const permissions = useSession()?.permissions ?? [];
  const can = (permission: string): boolean => permissions.includes(permission);
  const items = [
    {
      label: "Calendar",
      to: withPatient("/calendar", patientId),
      visible: can("visit.read"),
      current: location.pathname === "/calendar" && !location.search.includes("panel=staff"),
    },
    {
      label: "Needs scheduling",
      to: withPatient("/scheduling/proposals", patientId),
      visible: can("visit.proposal.read"),
      current: location.pathname === "/scheduling/proposals",
    },
    {
      label: "My visits",
      to: "/me/visits",
      visible: can("visit.read"),
      current: location.pathname === "/me/visits",
    },
    {
      label: "Staff & availability",
      to: withPatient("/calendar?panel=staff", patientId),
      visible:
        can("visit.read") &&
        (can("availability.read") ||
          can("time_off.read_team") ||
          can("membership_credential.read")),
      current:
        location.pathname === "/calendar" &&
        new URLSearchParams(location.search).get("panel") === "staff",
    },
  ].filter((item) => item.visible);

  return (
    <nav className="wx-scheduling-workspace-nav" aria-label="Scheduling workspace">
      <span className="wx-scheduling-workspace-label">Scheduling workspace</span>
      <div className="wx-scheduling-workspace-links">
        {items.map((item) => (
          <Link key={item.label} to={item.to} aria-current={item.current ? "page" : undefined}>
            {item.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
