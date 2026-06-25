// apps/web/src/shell — Role-Based Home (M1 app-shell landing, Track A).
// Spec: docs/design/screens/core/WARDENX_UI_APP_SHELL_HOME.md — the content outlet's landing.
// The chrome (App Shell) is F0-T03; this is the role-based home rendered at "/". It surfaces
// quick-access tiles for the screens registered into the shell (grouped by nav group); role-specific
// data widgets (My Patients, AR snapshot, cosign queue…) populate as their modules land.
import { cardSurface, t } from "@wardenx/ui";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { canSeeScreen } from "./actor-session";
import type { WebScreenDescriptor } from "./screen-registry";
import { useSession } from "./session";

export function RoleHome({ screens }: { screens: WebScreenDescriptor[] }): JSX.Element {
  const session = useSession();
  // Tiles = registered nav screens (exclude detail/param + wildcard routes), gated to the actor's
  // effective permissions (FB-T15 — role-scoped Home; the server stays the enforcer), then grouped.
  const tiles = screens
    .filter((s) => !s.path.includes(":") && !s.path.includes("*"))
    .filter((s) => canSeeScreen(s, session));
  const roles = session?.roles ?? [];
  const groups = new Map<string, WebScreenDescriptor[]>();
  for (const s of tiles) {
    const g = s.navGroup ?? "General";
    groups.set(g, [...(groups.get(g) ?? []), s]);
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div style={{ padding: "2rem", overflow: "auto", background: t.background, minHeight: "100%" }}>
      {/* Fraunces display voice (§3.1) for the human-facing welcome headline. */}
      <h1
        style={{
          margin: "0 0 0.35rem",
          fontFamily: t.fontDisplay,
          fontWeight: 500,
          fontSize: "1.6rem",
          color: t.onSurface,
        }}
      >
        {session ? `Welcome, ${session.displayName ?? session.userId}` : "Welcome to WardenX"}
      </h1>
      <p style={{ marginTop: 0, color: t.onSurfaceVariant, maxWidth: "44rem" }}>
        {roles.length > 0
          ? `Signed in as ${roles.join(", ")}${session?.organizationName ? ` · ${session.organizationName}` : ""}. Your home is scoped to your role; more widgets appear as their modules ship.`
          : "Your home adapts to your role. Role-specific widgets appear as their modules ship."}
      </p>

      {ordered.length === 0 ? (
        // Empty state in the Fraunces voice (§3.1) — an absence is editorial, not chrome.
        <p style={{ color: t.onSurfaceVariant, fontFamily: t.fontDisplay, marginTop: "2rem" }}>
          No screens are available to you yet.
        </p>
      ) : (
        ordered.map(([group, items]) => (
          <section key={group} style={{ marginTop: "2rem" }}>
            <h2
              style={{
                fontSize: "0.75rem",
                fontWeight: 600,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: t.muted,
                margin: "0 0 0.75rem",
              }}
            >
              {group}
            </h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(14rem, 1fr))",
                gap: "0.875rem",
              }}
            >
              {items.map((s) => (
                // §6.2 Lantern Card as a nav tile: surface-lowest + radius-xl + shadow-soft, No-Line
                // (§10.1) — no border. A soft shadow lift on hover gives the affordance an edge would.
                <Link
                  key={s.id}
                  to={s.path}
                  style={{
                    ...cardSurface,
                    display: "block",
                    padding: "1rem 1.125rem",
                    textDecoration: "none",
                    color: t.onSurface,
                    transition: "box-shadow 120ms ease, transform 120ms ease",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.boxShadow = t.shadowFloat;
                    e.currentTarget.style.transform = "translateY(-1px)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.boxShadow = t.shadowSoft;
                    e.currentTarget.style.transform = "translateY(0)";
                  }}
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
