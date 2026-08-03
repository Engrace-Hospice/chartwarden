// @wardenx/ui web — the shared toast/notification region (UI-010). Every app-shell composition root
// mounts one `ToastProvider`; any descendant calls `useToast().show(...)` instead of hand-rolling a
// local `role="status"`/`role="alert"` paragraph next to a form (the M5 address-save / M2 staff
// remove-member containments this replaces). A stack renders fixed to the viewport corner; each
// entry is individually dismissable and self-expires.
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { t } from "../theme/tokens";

export type ToastTone = "info" | "success" | "error";

export interface ToastOptions {
  tone?: ToastTone;
  /** Auto-dismiss delay in ms. Default 5000. */
  durationMs?: number;
}

export interface ToastContextValue {
  show: (message: string, options?: ToastOptions) => void;
}

interface ToastEntry {
  id: number;
  message: string;
  tone: ToastTone;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  const show = useCallback(
    (message: string, options?: ToastOptions) => {
      const id = nextId.current++;
      const tone = options?.tone ?? "info";
      setToasts((prev) => [...prev, { id, message, tone }]);
      const duration = options?.durationMs ?? 5000;
      window.setTimeout(() => dismiss(id), duration);
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(() => ({ show }), [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        style={{
          position: "fixed",
          bottom: t.space6,
          right: t.space6,
          zIndex: 2000,
          display: "flex",
          flexDirection: "column",
          gap: t.space2,
          maxWidth: "24rem",
        }}
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === "error" ? "alert" : "status"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: t.space3,
              padding: `${t.space3} ${t.space4}`,
              background: t.surfaceLowest,
              color: t.onSurface,
              borderRadius: t.radiusLg,
              boxShadow: t.shadowFloat,
              borderLeft: `3px solid ${toneColor(toast.tone)}`,
            }}
          >
            <span style={{ flex: 1, fontSize: "0.8125rem" }}>{toast.message}</span>
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
              style={{
                border: "none",
                background: "transparent",
                color: t.onSurfaceVariant,
                cursor: "pointer",
                fontSize: "1rem",
                lineHeight: 1,
                padding: 0,
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function toneColor(tone: ToastTone): string {
  if (tone === "error") return t.error;
  if (tone === "success") return t.success;
  return t.primary;
}

/** Must be called under a `ToastProvider` (mounted once at the app-shell composition root). */
export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}
