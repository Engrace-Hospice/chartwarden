// @wardenx/ui web — modal scaffold for the Guardrail ceremonies/blockers (R0.3, DESIGN.md §7.3/§7.4).
// Glass scrim + centered floating card, focus-trapped, Escape-to-close. Blocking/ceremony dialogs and
// ConfirmDialog compose this; it is also exported directly (UI-005) so callers needing a bespoke
// dialog build on the accessible shell instead of copying a scrim+panel by hand.
import { useCallback, useEffect, useRef } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { t } from "../theme/tokens";

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  open: boolean;
  onClose?: () => void;
  /** Accessible dialog label (the title text). */
  ariaLabel: string;
  /** Use role="alertdialog" for invariant blockers / destructive ceremonies. Default "dialog". */
  role?: "dialog" | "alertdialog";
  /** Max width of the floating card. Default 32rem. */
  width?: string;
  /** Top accent strip color (e.g. an alert-toned header rule). */
  accent?: string;
  children: ReactNode;
}

/** Centered, focus-trapped modal over a glass scrim (shadow-float). */
export function Modal({
  open,
  onClose,
  ariaLabel,
  role = "dialog",
  width = "32rem",
  accent,
  children,
}: ModalProps): JSX.Element | null {
  const cardRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === "Escape" && onClose) {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !cardRef.current || e.defaultPrevented) return;
      const card = cardRef.current;
      // A nested modal's card sits inside ours: its own handler deals with events from within it.
      if (e.target instanceof Element && e.target.closest("[data-wx-modal-card]") !== card) return;
      const nodes = Array.from(card.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) {
        e.preventDefault(); // nothing to move to, and Tab must not escape behind the modal
        return;
      }
      const active = document.activeElement;
      const index = active instanceof HTMLElement ? nodes.indexOf(active) : -1;
      const step = e.shiftKey ? -1 : 1;
      let target: HTMLElement | undefined;
      if (index >= 0) {
        // In the Tab order: only the real ends wrap; the browser moves everywhere else.
        const wraps = index + step < 0 || index + step >= nodes.length;
        if (!wraps) return;
        target = e.shiftKey ? nodes[nodes.length - 1] : nodes[0];
      } else if (active) {
        // Script-focusable only (tabindex="-1" heading, the card): continue from its place in the document, so
        // Shift+Tab from the top heading can't leave the dialog and Tab from mid-card doesn't jump to the start.
        const before = (node: HTMLElement) =>
          active.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING;
        const after = (node: HTMLElement) =>
          active.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING;
        target = e.shiftKey
          ? (nodes.filter(before).pop() ?? nodes[nodes.length - 1])
          : (nodes.find(after) ?? nodes[0]);
      }
      if (!target) return;
      e.preventDefault();
      target.focus();
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement;
    const card = cardRef.current;
    const first = card?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? card)?.focus();
    return () => {
      // Restore focus to the trigger on close (keyboard users don't lose their place).
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="wx-modal-scrim"
      onKeyDown={onKeyDown}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: "grid",
        placeItems: "center",
        padding: "1.5rem",
        background: "color-mix(in srgb, var(--color-on-surface) 32%, transparent)",
        backdropFilter: "blur(4px)",
        WebkitBackdropFilter: "blur(4px)",
      }}
    >
      {/* Scrim click closes a non-blocking dialog; blockers pass no onClose so it stays put. */}
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          border: "none",
          background: "transparent",
          cursor: onClose ? "pointer" : "default",
        }}
      />
      {/* The dialog card is the focus-trap root (tabIndex -1 is programmatic-focus only). */}
      <div
        ref={cardRef}
        data-wx-modal-card=""
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        tabIndex={-1}
        style={{
          position: "relative",
          width: "100%",
          maxWidth: width,
          maxHeight: "calc(100vh - 3rem)",
          overflowY: "auto",
          background: t.surfaceLowest,
          borderRadius: t.radiusXl,
          boxShadow: t.shadowFloat,
          borderTop: accent ? `3px solid ${accent}` : undefined,
        }}
      >
        {children}
      </div>
    </div>
  );
}
