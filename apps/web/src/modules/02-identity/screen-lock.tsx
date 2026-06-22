import { SESSION_POLICY } from "@wardenx/types";
// apps/web/src/modules/02-identity — Idle Screen-Lock overlay (M2 Auth, AUTH polish).
// Spec: docs/ui/screens/core/WARDENX_UI_AUTH.md "Screen-lock overlay" — after 5 minutes idle, a soft
// re-auth (password); the SESSION STAYS ALIVE (lifecycle active → screen_locked → active, M2 §2.2.4).
// This is an OVERLAY, not a route: the composition root mounts it inside the app shell (M1 stays
// module-free), so it covers only the authenticated frame — the chromeless /login flow is never locked.
//
// The idle interval is the platform floor SESSION_POLICY.screenLockSec (one source of truth, §11 D1).
// Unlock soft-re-auths the SAME user (authClient.signIn.email with the session's email), which the
// server is the authoritative enforcer of. The screen-lock pgEnum/lifecycle is server-tracked; this is
// the client surface. The lock applies only to the classes in SESSION_POLICY.screenLockClasses
// (staff/auditor — §2.2.4 screenLockApplies); external-collaborator / funeral-home magic-link windows
// are never screen-locked. An unknown/absent class fails SAFE (the lock applies).
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { authClient } from "./auth-client";

const IDLE_MS = SESSION_POLICY.screenLockSec * 1000;
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"] as const;

/** Whether the screen-lock applies to a session class. Unknown/absent ⇒ true (fail safe). */
function screenLockApplies(sessionClass: string | null | undefined): boolean {
  if (!sessionClass) return true;
  return (SESSION_POLICY.screenLockClasses as readonly string[]).includes(sessionClass);
}

export function ScreenLock(): JSX.Element | null {
  // `applies` is undefined until the session resolves; null-render until then (don't arm prematurely).
  const [applies, setApplies] = useState<boolean | undefined>(undefined);
  const [locked, setLocked] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Resolve the session once: capture the email (so unlock only needs the password) and decide whether
  // the lock applies to this class. No session ⇒ the lock is inert (the authenticated frame should
  // always have one, but fail open rather than trap a guest behind a lock).
  useEffect(() => {
    let alive = true;
    void authClient.getSession().then(({ data }) => {
      if (!alive) return;
      if (!data?.user?.email) {
        setApplies(false);
        return;
      }
      setEmail(data.user.email);
      setApplies(screenLockApplies(data.session?.sessionClass));
    });
    return () => {
      alive = false;
    };
  }, []);

  // Lock on idle; the timer is reset by any activity while unlocked.
  const arm = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setLocked(true), IDLE_MS);
  }, []);

  useEffect(() => {
    if (!applies || locked) return; // inert for non-applicable classes; frozen while locked
    const onActivity = (): void => arm();
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, onActivity, { passive: true });
    arm();
    return () => {
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, onActivity);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [applies, locked, arm]);

  async function unlock(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!email) return;
    setBusy(true);
    setError(null);
    const { error: err } = await authClient.signIn.email({ email, password });
    setBusy(false);
    if (err) {
      setError("That password didn’t match. Try again.");
      setPassword("");
      return;
    }
    setPassword("");
    setLocked(false); // re-arms the idle timer via the effect above
  }

  if (!locked) return null;

  return (
    // biome-ignore lint/a11y/useSemanticElements: native <dialog> needs imperative showModal(); role="dialog" overlay is the intended pattern.
    <div role="dialog" aria-modal="true" aria-label="Screen locked" style={overlay}>
      <form onSubmit={unlock} style={card}>
        <strong style={{ fontSize: "1rem" }}>WardenX</strong>
        <h1 style={{ margin: 0, fontSize: "1.05rem" }}>Locked</h1>
        <p style={{ margin: 0, color: "#6b7280", fontSize: "0.85rem" }}>
          Your screen locked after inactivity.{" "}
          {email ? (
            <>
              Enter your password to continue as <strong>{email}</strong>.
            </>
          ) : (
            "Confirm your password to continue."
          )}
        </p>
        <input
          type="password"
          autoComplete="current-password"
          aria-label="Password"
          required
          value={password}
          onChange={(ev) => setPassword(ev.target.value)}
          style={field}
        />
        {error ? <p style={{ color: "#b91c1c", margin: 0, fontSize: "0.85rem" }}>{error}</p> : null}
        <button type="submit" disabled={busy || !password} style={primaryBtn}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
        <button
          type="button"
          onClick={() => {
            void authClient.signOut().then(() => {
              window.location.href = "/login";
            });
          }}
          style={linkBtn}
        >
          Sign out instead
        </button>
      </form>
    </div>
  );
}

const overlay = {
  position: "fixed" as const,
  inset: 0,
  zIndex: 1000,
  background: "rgba(17, 24, 39, 0.55)",
  backdropFilter: "blur(4px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
} as const;
const card = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  width: "min(22rem, 92vw)",
  padding: "1.5rem",
  background: "#fff",
  borderRadius: "0.75rem",
  boxShadow: "0 20px 50px rgba(0,0,0,0.25)",
} as const;
const field = {
  padding: "0.5rem 0.625rem",
  border: "1px solid #e5e7eb",
  borderRadius: "0.5rem",
} as const;
const primaryBtn = {
  padding: "0.625rem 1rem",
  border: "none",
  borderRadius: "0.5rem",
  background: "#1d4ed8",
  color: "#fff",
  cursor: "pointer",
  fontWeight: 600,
} as const;
const linkBtn = {
  border: "none",
  background: "none",
  color: "#6b7280",
  cursor: "pointer",
  fontSize: "0.8rem",
} as const;
