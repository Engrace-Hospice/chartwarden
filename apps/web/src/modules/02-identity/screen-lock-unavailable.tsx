// Fail-closed fallback for the lazily loaded idle ScreenLock (#849). If the ScreenLock chunk cannot
// load (stale deploy, offline), the idle lock would silently not exist on a PHI screen. This overlay
// blocks the authenticated frame instead and offers the only safe recovery: reload.
import type { JSX } from "react";

export function ScreenLockUnavailable(): JSX.Element {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="screen-lock-unavailable-title"
      data-testid="screen-lock-unavailable"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483647,
        display: "grid",
        placeItems: "center",
        background: "rgb(0 0 0 / 0.85)",
        color: "#fff",
        padding: "1rem",
        textAlign: "center",
      }}
    >
      <div style={{ maxWidth: "28rem" }}>
        <h1 id="screen-lock-unavailable-title" style={{ fontSize: "1.5rem", margin: 0 }}>
          Session protection unavailable
        </h1>
        <p>
          The inactivity lock could not be loaded, so this screen is blocked to protect patient
          data. Reload to continue.
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{ minHeight: "2.75rem", padding: "0 1.5rem", fontSize: "1rem" }}
        >
          Reload
        </button>
      </div>
    </div>
  );
}
