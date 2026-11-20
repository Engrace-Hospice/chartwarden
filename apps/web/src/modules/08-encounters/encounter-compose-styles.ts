// apps/web/src/modules/08-encounters — the inline styles of the visit-note composer (the page, its progress bar, the section rail, the
// editor and the preview card). Tokens only; the findings panels use the kit classes instead.
import type { CSSProperties } from "react";

export const hairline =
  "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)";

export const page: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "1rem",
  background: "color-mix(in srgb, var(--color-surface-container-low) 55%, transparent)",
};

export const headerActions: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "center",
  flexWrap: "wrap",
  justifyContent: "flex-end",
};

export const summaryBar: CSSProperties = {
  display: "flex",
  alignItems: "stretch",
  justifyContent: "space-between",
  gap: "1.5rem",
  padding: "1rem 1.1rem",
  border: hairline,
  borderRadius: "0.9rem",
  background: "var(--color-surface)",
  boxShadow: "0 1px 2px color-mix(in srgb, black 6%, transparent)",
};

export const summaryMain: CSSProperties = {
  flex: 1,
  minWidth: 0,
};

export const summaryTitleRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-end",
  justifyContent: "space-between",
  gap: "1rem",
};

export const eyebrow: CSSProperties = {
  marginBottom: "0.2rem",
  fontSize: "0.8125rem",
  lineHeight: 1.2,
  fontWeight: 500,
  color: "var(--color-on-surface-variant)",
};

export const summaryTitle: CSSProperties = {
  fontSize: "0.95rem",
  fontWeight: 650,
  color: "var(--color-on-surface)",
};

export const completionPercent: CSSProperties = {
  fontSize: "1.05rem",
  color: "var(--color-primary)",
};

export const progressTrack: CSSProperties = {
  height: "0.4rem",
  marginTop: "0.65rem",
  borderRadius: 999,
  overflow: "hidden",
  background: "var(--color-surface-container-highest)",
};

export const progressFill: CSSProperties = {
  display: "block",
  height: "100%",
  borderRadius: 999,
  background: "var(--color-primary)",
  transition: "width 180ms ease",
};

export const summaryStats: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "1rem",
  flexShrink: 0,
};

export const summaryStat: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: "7rem",
};

export const summaryStatValue: CSSProperties = {
  fontSize: "1.1rem",
  fontWeight: 700,
  color: "var(--color-on-surface)",
};

export const summaryStatLabel: CSSProperties = {
  marginTop: "0.1rem",
  fontSize: "0.72rem",
  color: "var(--color-on-surface-variant)",
};

export const summaryDivider: CSSProperties = {
  width: 1,
  alignSelf: "stretch",
  background: "var(--color-outline-variant)",
  opacity: 0.5,
};

export const noticeBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.65rem",
  padding: "0.75rem 0.9rem",
  borderRadius: "0.7rem",
  fontSize: "0.82rem",
  border: hairline,
};

export const noticeSuccess: CSSProperties = {
  background: "color-mix(in srgb, var(--color-success) 8%, var(--color-surface))",
  color: "var(--color-on-surface)",
};

export const noticeError: CSSProperties = {
  background: "color-mix(in srgb, var(--color-error) 8%, var(--color-surface))",
  color: "var(--color-on-surface)",
};

export const noticeTitle: CSSProperties = {
  flexShrink: 0,
  fontWeight: 700,
};

export const attentionCard: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  padding: "0.9rem 1rem",
  borderRadius: "0.8rem",
  border: "1px solid color-mix(in srgb, var(--color-error) 25%, transparent)",
  background: "color-mix(in srgb, var(--color-error) 6%, var(--color-surface))",
};

export const attentionMark: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: "1.7rem",
  height: "1.7rem",
  flexShrink: 0,
  borderRadius: 999,
  fontSize: "0.85rem",
  fontWeight: 800,
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  // The pill foreground again: plain error on this tint is about 3.7:1 in light theme, the pill token about 4.9:1.
  color: "var(--color-error-pill-fg)",
};

export const attentionTitle: CSSProperties = {
  display: "block",
  fontSize: "0.83rem",
  color: "var(--color-on-surface)",
};

export const attentionText: CSSProperties = {
  margin: "0.2rem 0 0",
  fontSize: "0.78rem",
  lineHeight: 1.45,
  color: "var(--color-on-surface-variant)",
};

export const readyCard: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  padding: "0.9rem 1rem",
  borderRadius: "0.8rem",
  border: hairline,
  background: "var(--color-surface-container-low)",
};

export const readyMark: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: "1.7rem",
  height: "1.7rem",
  flexShrink: 0,
  borderRadius: 999,
  fontSize: "0.82rem",
  fontWeight: 800,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container-highest)",
};

export const readyTitle: CSSProperties = {
  display: "block",
  fontSize: "0.83rem",
};

export const readyText: CSSProperties = {
  margin: "0.2rem 0 0",
  fontSize: "0.78rem",
  color: "var(--color-on-surface-variant)",
};

export const workspace: CSSProperties = {
  display: "grid",
  gap: "1rem",
  alignItems: "start",
};

export const sectionRail: CSSProperties = {
  overflow: "hidden",
  border: hairline,
  borderRadius: "0.9rem",
  background: "var(--color-surface)",
};

export const railHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.95rem 1rem",
  borderBottom: hairline,
};

export const railTitle: CSSProperties = {
  fontSize: "0.88rem",
};

export const railCount: CSSProperties = {
  display: "inline-grid",
  placeItems: "center",
  minWidth: "1.65rem",
  height: "1.65rem",
  padding: "0 0.4rem",
  borderRadius: 999,
  fontSize: "0.72rem",
  fontWeight: 700,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container-high)",
};

export const sectionNav: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.15rem",
  padding: "0.45rem",
};

export const sectionNavButton: CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  gap: "0.65rem",
  padding: "0.65rem 0.7rem",
  border: "1px solid transparent",
  borderRadius: "0.65rem",
  background: "transparent",
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
};

export const sectionNavButtonActive: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--color-primary) 18%, transparent)",
  background: "color-mix(in srgb, var(--color-primary) 7%, var(--color-surface))",
};

export const sectionIndex: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: "1.55rem",
  height: "1.55rem",
  flexShrink: 0,
  borderRadius: 999,
  fontSize: "0.68rem",
  fontWeight: 700,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container-high)",
};

export const sectionIndexComplete: CSSProperties = {
  color: "var(--color-success)",
  background: "color-mix(in srgb, var(--color-success) 11%, var(--color-surface))",
};

export const sectionIndexActive: CSSProperties = {
  color: "var(--color-on-primary)",
  background: "var(--color-primary)",
};

export const sectionNavCopy: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  gap: "0.1rem",
};

export const sectionNavTitle: CSSProperties = {
  overflow: "hidden",
  fontSize: "0.78rem",
  fontWeight: 600,
  color: "var(--color-on-surface)",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

export const sectionNavTitleActive: CSSProperties = {
  color: "var(--color-primary)",
};

export const sectionNavMeta: CSSProperties = {
  fontSize: "0.68rem",
  color: "var(--color-on-surface-variant)",
};

// The pill foreground, not --color-error: on the active step's primary tint plain error is 4.12:1 in light
// theme (needs 4.5), the pill token is 5.52:1. The two tokens are identical in dark theme.
export const sectionNavMetaRequired: CSSProperties = {
  color: "var(--color-error-pill-fg)",
};

export const readOnlyHint: CSSProperties = {
  margin: "0 0.75rem 0.75rem",
  padding: "0.7rem",
  borderRadius: "0.6rem",
  fontSize: "0.72rem",
  lineHeight: 1.4,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container-low)",
};

export const editorColumn: CSSProperties = {
  minWidth: 0,
};

export const editorCard: CSSProperties = {
  overflow: "hidden",
  border: hairline,
  borderRadius: "0.9rem",
  background: "var(--color-surface)",
  boxShadow: "0 1px 2px color-mix(in srgb, black 5%, transparent)",
};

export const editorHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "1rem",
  padding: "1.1rem 1.2rem",
  borderBottom: hairline,
};

export const editorTitleRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "0.5rem",
};

export const editorTitle: CSSProperties = {
  margin: 0,
  fontSize: "1.05rem",
  fontWeight: 700,
  color: "var(--color-on-surface)",
};

export const editorDescription: CSSProperties = {
  maxWidth: "46rem",
  margin: "0.35rem 0 0",
  fontSize: "0.78rem",
  lineHeight: 1.45,
  color: "var(--color-on-surface-variant)",
};

export const requiredBadge: CSSProperties = {
  padding: "0.18rem 0.42rem",
  borderRadius: 999,
  fontSize: "0.66rem",
  fontWeight: 700,
  color: "var(--color-error-pill-fg)",
  background: "color-mix(in srgb, var(--color-error) 9%, transparent)",
};

export const discardDialog: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "1.25rem",
};

export const discardTitle: CSSProperties = {
  margin: 0,
  fontSize: "1.15rem",
  color: "var(--color-on-surface)",
};

export const discardText: CSSProperties = {
  margin: 0,
  lineHeight: 1.5,
  color: "var(--color-on-surface-variant)",
};

export const discardActions: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "0.5rem",
};

export const optionalBadge: CSSProperties = {
  padding: "0.18rem 0.42rem",
  borderRadius: 999,
  fontSize: "0.66rem",
  fontWeight: 650,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container-high)",
};

export const selectionCounter: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  flexShrink: 0,
  fontSize: "0.7rem",
  color: "var(--color-on-surface-variant)",
};

export const editorBody: CSSProperties = {
  padding: "1rem 1.15rem 1.15rem",
};

export const entryGrid: CSSProperties = {
  display: "grid",
  gap: "0.55rem",
};

export const entryCard: CSSProperties = {
  overflow: "hidden",
  border: hairline,
  borderRadius: "0.7rem",
  background: "var(--color-surface)",
  transition: "border-color 120ms ease, background-color 120ms ease, box-shadow 120ms ease",
};

export const entryCardSelected: CSSProperties = {
  border: "1px solid color-mix(in srgb, var(--color-primary) 30%, transparent)",
  background: "color-mix(in srgb, var(--color-primary) 4%, var(--color-surface))",
  boxShadow: "inset 3px 0 0 color-mix(in srgb, var(--color-primary) 85%, transparent)",
};

export const entryLabel: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: "0.75rem",
  padding: "0.75rem 0.8rem",
  cursor: "pointer",
};

export const entryCheckbox: CSSProperties = {
  width: "1rem",
  height: "1rem",
  marginTop: "0.1rem",
  flexShrink: 0,
  accentColor: "var(--color-primary)",
};

export const entryContent: CSSProperties = {
  display: "flex",
  flex: 1,
  minWidth: 0,
  flexDirection: "column",
  gap: "0.35rem",
};

export const entryText: CSSProperties = {
  fontSize: "0.82rem",
  lineHeight: 1.4,
  fontWeight: 550,
  color: "var(--color-on-surface)",
};

export const entryMetaRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "0.4rem",
};

export const slotPanel: CSSProperties = {
  padding: "0.75rem 0.8rem 0.8rem 2.55rem",
  borderTop: hairline,
  background: "var(--color-surface-container-low)",
};

export const slotPanelTitle: CSSProperties = {
  marginBottom: "0.55rem",
  fontSize: "0.7rem",
  fontWeight: 700,
  color: "var(--color-on-surface-variant)",
};

export const slotGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(11rem, 1fr))",
  gap: "0.65rem",
};

export const emptyVocabulary: CSSProperties = {
  padding: "1rem",
  borderRadius: "0.75rem",
  border: hairline,
  background: "var(--color-surface-container-low)",
};

export const emptyVocabularyTitle: CSSProperties = {
  fontSize: "0.82rem",
};

export const emptyVocabularyText: CSSProperties = {
  margin: "0.3rem 0 0",
  fontSize: "0.76rem",
  lineHeight: 1.45,
  color: "var(--color-on-surface-variant)",
};

export const freeTextSection: CSSProperties = {
  marginTop: "1rem",
  paddingTop: "1rem",
  borderTop: hairline,
};

export const freeTextHeading: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "0.75rem",
  marginBottom: "0.65rem",
};

export const freeTextTitle: CSSProperties = {
  fontSize: "0.82rem",
};

export const freeTextHint: CSSProperties = {
  margin: "0.2rem 0 0",
  fontSize: "0.72rem",
  color: "var(--color-on-surface-variant)",
};

export const verbatimBadge: CSSProperties = {
  flexShrink: 0,
  padding: "0.2rem 0.45rem",
  borderRadius: 999,
  fontSize: "0.64rem",
  fontWeight: 650,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container-high)",
};

export const previewColumn: CSSProperties = {
  minWidth: 0,
};

export const previewCard: CSSProperties = {
  position: "sticky",
  top: "1rem",
  overflow: "hidden",
  border: hairline,
  borderRadius: "0.9rem",
  background: "var(--color-surface)",
};

export const previewHeader: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: "0.75rem",
  padding: "0.95rem 1rem",
  borderBottom: hairline,
};

export const previewTitle: CSSProperties = {
  margin: 0,
  fontSize: "0.95rem",
  fontWeight: 700,
};

export const previewStatus: CSSProperties = {
  padding: "0.18rem 0.4rem",
  borderRadius: 999,
  fontSize: "0.64rem",
  fontWeight: 650,
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container-high)",
};

export const previewBody: CSSProperties = {
  minHeight: "12rem",
  maxHeight: "55vh",
  overflowY: "auto",
  padding: "1rem",
};

export const previewText: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  fontSize: "0.82rem",
  lineHeight: 1.65,
  color: "var(--color-on-surface)",
};

export const previewEmpty: CSSProperties = {
  display: "flex",
  minHeight: "10rem",
  flexDirection: "column",
  justifyContent: "center",
  alignItems: "center",
  padding: "1rem",
  textAlign: "center",
};

export const previewEmptyTitle: CSSProperties = {
  fontSize: "0.8rem",
};

export const previewEmptyText: CSSProperties = {
  maxWidth: "16rem",
  margin: "0.35rem 0 0",
  fontSize: "0.72rem",
  lineHeight: 1.45,
  color: "var(--color-on-surface-variant)",
};

export const previewFooter: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.6rem",
  padding: "0.7rem 0.85rem",
  borderTop: hairline,
  background: "var(--color-surface-container-low)",
};

export const previewActions: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "flex-end",
  gap: "0.35rem",
};

export const staleEditNotice: CSSProperties = {
  padding: "0.7rem 1rem",
  borderBottom: hairline,
  background: "color-mix(in srgb, var(--color-error) 8%, var(--color-surface))",
  color: "var(--color-on-surface)",
  fontSize: "0.72rem",
  lineHeight: 1.45,
};

export const previewFooterText: CSSProperties = {
  fontSize: "0.67rem",
  color: "var(--color-on-surface-variant)",
};
