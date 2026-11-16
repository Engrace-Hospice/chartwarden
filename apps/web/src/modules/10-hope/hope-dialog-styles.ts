import { t } from "@chartwarden/ui";
// apps/web/src/modules/10-hope — inline styles shared by the HOPE assessment workspace and the dialogs it opens
// (`hope-sign-dialog.tsx`, `hope-sfv-complete-dialog.tsx`), and by the small write dialogs, which share `meta`, `lateBox`, `checkRow` and
// `errorText` at the end of this file: `hope-record-modal.tsx`, `hope-record-sections.tsx`, `hope-override-section.tsx`,
// `hope-action-modal.tsx` and `record-cms-result-modal.tsx`. They live apart from the screen so a dialog can be its own
// file without importing the 5,000-line screen back (an import cycle).
import type { CSSProperties } from "react";

export const muted: CSSProperties = {
  margin: 0,
  color: t.muted,
  fontSize: "0.9rem",
  lineHeight: 1.45,
};

export const actionRow: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.75rem",
  marginTop: "1rem",
};

export const primaryButton: CSSProperties = {
  border: 0,
  borderRadius: 8,
  padding: "0.6rem 0.85rem",
  background: t.primary,
  color: t.onPrimary,
  fontWeight: 700,
  cursor: "pointer",
};

export const secondaryButton: CSSProperties = {
  border: `1px solid ${t.outline}`,
  borderRadius: 8,
  padding: "0.55rem 0.8rem",
  background: t.surface,
  color: t.onSurface,
  fontWeight: 650,
  cursor: "pointer",
};

export const modalTitle: CSSProperties = {
  margin: "0 0 0.5rem",
  fontFamily: t.fontDisplay,
  fontSize: "1.2rem",
};

export const modalStats: CSSProperties = {
  display: "flex",
  gap: "0.75rem",
  color: t.muted,
  marginTop: "1rem",
};

export const signDialogError: CSSProperties = {
  margin: "0.75rem 0 0",
  color: t.error,
  fontSize: "0.85rem",
};

export const sfvModalHeader: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "1.25rem 1.35rem 1rem",
  borderBottom: `1px solid ${t.outlineVariant}`,
  background: t.surface,
};

export const sfvModalHeaderText: CSSProperties = {
  minWidth: 0,
};

export const sfvModalEyebrow: CSSProperties = {
  marginBottom: "0.2rem",
  color: t.primary,
  fontSize: "0.8125rem",
  fontWeight: 500,
};

export const sfvModalTitle: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  fontFamily: t.fontDisplay,
  fontSize: "1.3rem",
  fontWeight: 700,
};

export const sfvModalDescription: CSSProperties = {
  margin: "0.3rem 0 0",
  color: t.muted,
  fontSize: "0.88rem",
  lineHeight: 1.45,
};

export const sfvCloseButton: CSSProperties = {
  display: "grid",
  flex: "0 0 auto",
  width: 34,
  height: 34,
  placeItems: "center",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 8,
  background: t.surface,
  color: t.muted,
  fontSize: "1.35rem",
  lineHeight: 1,
  cursor: "pointer",
};

export const sfvModalBody: CSSProperties = {
  padding: "24px",
  overflowY: "auto",
  flex: 1,
  minHeight: 0,
};

export const sfvPermissionErrorBox: CSSProperties = {
  borderColor: t.warning,
  background: `color-mix(in srgb, ${t.warning} 10%, ${t.surface})`,
  color: t.onSurface,
};

export const sfvSection: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.9rem",
  padding: "1rem",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 10,
  background: t.surfaceLow,
  marginBottom: "1rem",
};

export const sfvSectionHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
};

export const sfvSectionTitle: CSSProperties = {
  margin: 0,
  color: t.onSurface,
  fontSize: "0.98rem",
  fontWeight: 750,
};

export const sfvSectionDescription: CSSProperties = {
  margin: "0.2rem 0 0",
  color: t.muted,
  fontSize: "0.82rem",
  lineHeight: 1.4,
};

export const sfvDetailsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: "16px",
};

export const sfvField: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.4rem",
};

export const sfvFieldLabel: CSSProperties = {
  color: t.onSurface,
  fontSize: "0.8rem",
  fontWeight: 700,
};

export const sfvInput: CSSProperties = {
  width: "100%",
  minHeight: 42,
  boxSizing: "border-box",
  border: `1px solid ${t.outline}`,
  borderRadius: 8,
  padding: "0.55rem 0.65rem",
  background: t.surface,
  color: t.onSurface,
  font: "inherit",
};

export const sfvProgressBadge: CSSProperties = {
  flex: "0 0 auto",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 999,
  padding: "0.2rem 0.55rem",
  background: t.surface,
  color: t.muted,
  fontSize: "0.75rem",
  fontWeight: 700,
  whiteSpace: "nowrap",
};

export const sfvProgressTrack: CSSProperties = {
  width: "100%",
  height: 5,
  overflow: "hidden",
  borderRadius: 999,
  background: t.outlineVariant,
};

export const sfvProgressValue: CSSProperties = {
  height: "100%",
  borderRadius: 999,
  background: t.primary,
  transition: "width 180ms ease",
};

export const sfvAnswersGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: "12px",
};

export const sfvAnswerCard: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 220px",
  alignItems: "center",
  gap: "20px",

  padding: "16px",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 12,
  background: t.surface,
  color: t.onSurface,
};

export const sfvAnswerCardHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.6rem",
};

export const sfvQuestionContent: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
  minWidth: 0,
};

export const sfvQuestionText: CSSProperties = {
  color: t.onSurface,
  fontSize: "0.88rem",
  fontWeight: 650,
  lineHeight: 1.4,
};

export const sfvAnswerNumber: CSSProperties = {
  display: "grid",
  flex: "0 0 auto",
  width: 28,
  height: 28,
  placeItems: "center",
  borderRadius: 7,
  background: t.surfaceLow,
  color: t.muted,
  fontSize: "0.75rem",
  fontWeight: 800,
};

export const sfvErrorBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.25rem",
  padding: "0.75rem 0.85rem",
  border: `1px solid ${t.error}`,
  borderRadius: 8,
  background: `color-mix(in srgb, ${t.error} 10%, ${t.surface})`,
  color: t.onSurface,
  fontSize: "0.82rem",
};

export const sfvModalFooter: CSSProperties = {
  flex: "0 0 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "0.85rem 1.35rem",
  borderTop: `1px solid ${t.outlineVariant}`,
  background: t.surface,
};

export const sfvFooterStatus: CSSProperties = {
  minWidth: 0,
  fontSize: "0.8rem",
};

export const sfvReadyText: CSSProperties = {
  color: t.success,
  fontWeight: 700,
};

export const sfvPendingText: CSSProperties = {
  color: t.muted,
};

export const sfvFooterActions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  gap: "0.65rem",
  flex: "0 0 auto",
};

export const sfvDisabledButton: CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
};

export const sfvReadonlyAnswer: CSSProperties = {
  minHeight: 42,
  display: "flex",
  alignItems: "center",
  boxSizing: "border-box",
  padding: "0.55rem 0.65rem",
  border: `1px solid ${t.outlineVariant}`,
  borderRadius: 8,
  background: t.surface,
  color: t.onSurface,
  fontSize: "0.85rem",
  fontWeight: 600,
};

/**
 * Inside the kit `Modal` card: header and footer stay put while the body scrolls. The frame draws the accent strip
 * itself and is no taller than the card's own max height, so the card never scrolls on top of the body (one scroll
 * region, not two).
 */
export const sfvDialogFrame: CSSProperties = {
  position: "relative",
  boxSizing: "border-box",
  display: "flex",
  flexDirection: "column",
  maxHeight: "calc(100vh - 3rem)",
  borderTop: `3px solid ${t.primary}`,
  background: t.surface,
  color: t.onSurface,
};

/** The sign dialog's content inside the kit `Modal` card: it draws the accent strip itself, like the SFV frame. */
export const signDialogBody: CSSProperties = {
  padding: "1.25rem",
  borderTop: `3px solid ${t.primary}`,
};

/** An alert or confirmation sitting between the scrolling body and the footer: always visible, never scrolled away. */
export const sfvStatusSlot: CSSProperties = {
  flex: "0 0 auto",
  margin: "0.75rem 1.35rem 0",
};

export const sfvConfirmBox: CSSProperties = {
  ...sfvStatusSlot,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  flexWrap: "wrap",
  gap: "0.75rem",
  padding: "0.75rem 0.85rem",
  border: `1px solid ${t.warning}`,
  borderRadius: 8,
  background: `color-mix(in srgb, ${t.warning} 10%, ${t.surface})`,
  color: t.onSurface,
  fontSize: "0.85rem",
};

/** The close control sits after the footer in the DOM (so the first focus is a field) and is drawn top right. */
export const sfvCloseCorner: CSSProperties = {
  ...sfvCloseButton,
  position: "absolute",
  top: "1rem",
  right: "1.1rem",
};

/** The completion dialog's header: leaves room for the corner close control. */
export const sfvModalHeaderWithClose: CSSProperties = {
  ...sfvModalHeader,
  paddingRight: "4rem",
};

/** Visually hidden, still read by assistive technology. */
export const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0, 0, 0, 0)",
  whiteSpace: "nowrap",
  border: 0,
};

export const inputStyle: CSSProperties = {
  width: "100%",
  border: `1px solid ${t.outline}`,
  borderRadius: 8,
  padding: "0.55rem 0.65rem",
  font: "inherit",
  background: t.surface,
};

export const dangerButton: CSSProperties = {
  border: 0,
  borderRadius: 8,
  padding: "0.6rem 0.85rem",
  background: t.error,
  color: "var(--color-on-primary)",
  fontWeight: 700,
  cursor: "pointer",
};

export const fieldLabel: CSSProperties = {
  display: "grid",
  gap: "0.45rem",
  marginTop: "1rem",
  fontWeight: 700,
  color: t.onSurface,
};

export const textareaField: CSSProperties = {
  ...inputStyle,
  minHeight: "7rem",
  resize: "vertical",
};

// The write dialogs' own notes, boxes and alerts: `meta` (small helper text) is used by all five files named at the top, `lateBox` and
// `checkRow` by the recording dialog and its parts (`hope-record-modal.tsx`, `hope-record-sections.tsx`, `hope-override-section.tsx`).
export const meta: CSSProperties = {
  margin: 0,
  fontSize: "0.75rem",
  color: "var(--color-on-surface-variant)",
};

export const lateBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.375rem",
  padding: "0.625rem",
  borderRadius: "0.375rem",
  border: "1px solid var(--color-outline-variant)",
};

export const checkRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  fontSize: "0.85rem",
};

/** A refusal in a dialog's own alert (the paragraph that takes focus after a failed write). */
export const errorText: CSSProperties = {
  margin: 0,
  fontSize: "0.8rem",
  color: "var(--color-error)",
};
