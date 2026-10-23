import { SESSION_POLICY } from "@chartwarden/types";
import { Modal, useApiClient } from "@chartwarden/ui";
// apps/web/src/modules/02-identity — Idle Screen-Lock overlay (M2 Auth, AUTH polish).
// Spec: docs/design/screens/core/CHARTWARDEN_UI_AUTH.md "Screen-lock overlay" — after 5 minutes idle, a soft
// re-auth (password); the SESSION STAYS ALIVE (lifecycle active → screen_locked → active, M2 §2.2.4).
// This is an OVERLAY, not a route: the composition root mounts it inside the app shell (M1 stays
// module-free), so it covers only the authenticated frame — the chromeless /login flow is never locked.
//
// The idle interval is the platform floor SESSION_POLICY.screenLockSec (one source of truth, §11 D1).
// Unlock re-proves the password for the SAME session (POST /api/v1/auth/unlock, #589): the server verifies it
// for the session's own user and mints nothing, so the session id, bound organization and step-up freshness
// survive. It must NOT call sign-in: that creates a second session with no organization (the org binds only in
// select-organization), and the next org-scoped request 401s. The screen-lock pgEnum/lifecycle is
// server-tracked; this is the client surface. The lock applies only to the classes in SESSION_POLICY.screenLockClasses
// (staff/auditor — §2.2.4 screenLockApplies); external-collaborator / funeral-home magic-link windows
// are never screen-locked. An unknown/absent class fails SAFE (the lock applies).
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { clearAllDrafts } from "../../shell/ceremony-drafts";
import { setGlobalResponseSignal } from "../../shell/global-response-signal";
import { authClient } from "./auth-client";

const IDLE_MS = SESSION_POLICY.screenLockSec * 1000;
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"] as const;

/** Whether the screen-lock applies to a session class. Unknown/absent ⇒ true (fail safe). */
function screenLockApplies(sessionClass: string | null | undefined): boolean {
  if (!sessionClass) return true;
  return (SESSION_POLICY.screenLockClasses as readonly string[]).includes(sessionClass);
}

/** What the overlay says for each refusal code; anything else gets `default`. */
const UNLOCK_MESSAGES: Readonly<Record<string, string>> = {
  INVALID_CREDENTIALS: "That password didn’t match. Try again.",
  UNLOCK_LOCKED_OUT: "Too many failed attempts. This session has ended - sign in again.",
  TOO_MANY_FAILED_ATTEMPTS: "Too many failed attempts. Wait a few minutes before trying again.",
  default: "Couldn’t unlock just now. Try again, or sign out and sign in again.",
};

/** The envelope code of a refused response (`{ error: { code } }`), if it carries one. */
function refusalCode(error: unknown): string | undefined {
  const code = (error as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" ? code : undefined;
}

export function ScreenLock(): JSX.Element | null {
  const client = useApiClient();
  // `applies` is undefined until the session resolves; null-render until then (don't arm prematurely).
  const [applies, setApplies] = useState<boolean | undefined>(undefined);
  const [locked, setLocked] = useState(false);
  const [identity, setIdentity] = useState<{ value: string } | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const passwordInput = useRef<HTMLInputElement | null>(null);

  // Resolve the session once: capture the email (so unlock only needs the password) and decide whether
  // the lock applies to this class. No session ⇒ the lock is inert (the authenticated frame should
  // always have one, but fail open rather than trap a guest behind a lock).
  useEffect(() => {
    let alive = true;
    void authClient.getSession().then(({ data }) => {
      if (!alive) return;
      const label = data?.user?.email || data?.user?.username;
      const resolved = label ? { value: label } : null;
      if (!resolved) {
        setApplies(false);
        return;
      }
      setIdentity(resolved);
      setApplies(screenLockApplies(data?.session?.sessionClass));
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
    setBusy(true);
    setError(null);
    let ok = false;
    let status = 0;
    let refused: unknown;
    try {
      // The verdict is the HTTP status, never the truthiness of `error`: openapi-fetch hands back the raw body text
      // for a non-JSON error, which is "" for a bodiless 502 from a gateway - falsy, and not a successful unlock.
      const result = await client.POST("/api/v1/auth/unlock", { body: { password } });
      ok = result.response.ok;
      status = result.response.status;
      refused = result.error;
    } catch {
      refused = undefined; // network failure: stays locked with the generic message
    }
    setBusy(false);
    setPassword("");
    if (!ok) {
      const code = refusalCode(refused);
      // /auth/unlock is exempt from the blanket 401 -> expired rule (a wrong password is a 401 too), so a session
      // that is truly gone (UNAUTHORIZED, or SESSION_EXPIRED once the idle/absolute timeout fired) is reported here.
      // 423 UNLOCK_LOCKED_OUT: the final failed attempt, after which the server has already ended the session.
      // A 401 only counts when it says so: a bodiless/odd 401 from a proxy on a live session must not wipe drafts.
      if ((status === 401 && (code === "UNAUTHORIZED" || code === "SESSION_EXPIRED")) || status === 423) {
        setGlobalResponseSignal({ kind: "session-expired" });
      }
      setError((code && UNLOCK_MESSAGES[code]) || UNLOCK_MESSAGES.default);
      passwordInput.current?.focus(); // the field was just cleared; keep the keyboard user in the dialog
      return;
    }
    setLocked(false); // re-arms the idle timer via the effect above
  }

  if (!locked) return null;

  return (
    // WX-PR-022 (UI-002): was a bespoke `role="dialog"` div with no focus trap/Escape/restore —
    // migrated to the canonical Modal. `alertdialog` (not `dialog`) + no `onClose`: this is an
    // invariant blocker, not a dismissible dialog — the only way out is unlocking or signing out.
    <Modal open role="alertdialog" ariaLabel="Screen locked" width="22rem">
      <form onSubmit={unlock} style={card}>
        <strong style={{ fontSize: "1rem" }}>ChartWarden</strong>
        <h1 style={{ margin: 0, fontSize: "1.05rem" }}>Locked</h1>
        <p style={{ margin: 0, color: "var(--color-on-surface-variant)", fontSize: "0.85rem" }}>
          Your screen locked after inactivity.{" "}
          {identity ? (
            <>
              Enter your password to continue as <strong>{identity.value}</strong>.
            </>
          ) : (
            "Confirm your password to continue."
          )}
        </p>
        <input
          type="password"
          autoComplete="current-password"
          aria-label="Password"
          ref={passwordInput}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "screen-lock-error" : undefined}
          required
          value={password}
          onChange={(ev) => setPassword(ev.target.value)}
          style={field}
        />
        {error ? (
          <p
            id="screen-lock-error"
            role="alert"
            style={{ color: "var(--color-error)", margin: 0, fontSize: "0.85rem" }}
          >
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={busy || !password} style={primaryBtn}>
          {busy ? "Unlocking…" : "Unlock"}
        </button>
        <button
          type="button"
          onClick={() => {
            // Leave even if the sign-out call fails: the lock must never be a dead end.
            void authClient
              .signOut()
              .catch(() => undefined)
              .then(() => {
                clearAllDrafts();
                window.location.href = "/login";
              });
          }}
          style={linkBtn}
        >
          Sign out instead
        </button>
      </form>
    </Modal>
  );
}

const card = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "1.5rem",
} as const;
const field = {
  padding: "0.5rem 0.625rem",
  border: "1px solid var(--color-outline-variant)",
  borderRadius: "0.5rem",
} as const;
const primaryBtn = {
  padding: "0.625rem 1rem",
  border: "none",
  borderRadius: "0.5rem",
  background: "var(--color-primary)",
  color: "var(--color-surface-lowest)",
  cursor: "pointer",
  fontWeight: 600,
} as const;
const linkBtn = {
  border: "none",
  background: "none",
  color: "var(--color-on-surface-variant)",
  cursor: "pointer",
  fontSize: "0.8rem",
} as const;
