// apps/web/src/shell — Role-Based Home (M1 app-shell landing, Track A).
// Spec: docs/ui/screens/core/WARDENX_UI_APP_SHELL_HOME.md — the content outlet's landing.
// The chrome (App Shell) is F0-T03; this is the role-based home rendered at "/". It surfaces
// quick-access tiles for the screens registered into the shell (grouped by nav group); role-specific
// data widgets (My Patients, AR snapshot, cosign queue…) populate as their modules land.
import type { JSX } from "react";
import { Link } from "react-router-dom";
import type { WebScreenDescriptor } from "./screen-registry";
import { useSession } from "./session";

export function RoleHome({ screens }: { screens: WebScreenDescriptor[] }): JSX.Element {
  const session = useSession();
  // Tiles = registered nav screens (exclude detail/param + wildcard routes), grouped by nav group.
  const tiles = screens.filter((s) => !s.path.includes(":") && !s.path.includes("*"));
  const groups = new Map<string, WebScreenDescriptor[]>();
  for (const s of tiles) {
    const g = s.navGroup ?? "General";
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div style={{ padding: "1.5rem", overflow: "auto" }}>
      <h1 style={{ margin: "0 0 0.25rem", fontSize: "1.4rem" }}>
        {session ? `Welcome, ${session.displayName ?? session.userId}` : "Welcome to WardenX"}
      </h1>
      <p style={{ marginTop: 0, color: "#6b7280" }}>
        Your home adapts to your role. Role-specific widgets appear as their modules ship.
      </p>

      {ordered.length === 0 ? (
        <p style={{ color: "#6b7280" }}>No screens are available to you yet.</p>
      ) : (
        ordered.map(([group, items]) => (
          <section key={group} style={{ marginTop: "1.5rem" }}>
            <h2 style={{ fontSize: "0.8rem", textTransform: "uppercase", color: "#6b7280", margin: "0 0 0.5rem" }}>{group}</h2>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(14rem, 1fr))", gap: "0.75rem" }}>
              {items.map((s) => (
                <Link
                  key={s.id}
                  to={s.path}
                  style={{ display: "block", padding: "1rem", border: "1px solid #e5e7eb", borderRadius: "0.5rem", textDecoration: "none", color: "#111827" }}
                >
                  <div style={{ fontWeight: 600 }}>{s.title}</div>
                </Link>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
