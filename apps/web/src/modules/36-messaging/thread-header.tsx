// The conversation header and the patient-context pane of ConversationThread (moved out of it unchanged in WP 2.2 to
// keep that file under the line ceiling).
import { Glyph } from "@wardenx/ui";
import { type JSX, type RefObject, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { IdgDiscussionsSection } from "./idg-discussions-section";
import type { ChannelSummary, PatientHeaderInfo } from "./messaging-types";
import { initialsOf } from "./messaging-utils";
import { PatientContextTiles } from "./patient-context-tiles";
import { SnoozeControl } from "./snooze-control";

export interface ThreadHeaderProps {
  channel: ChannelSummary;
  title: string;
  subtitle: string;
  patient: PatientHeaderInfo | null;
  contextOpen: boolean;
  onBack: () => void;
  onToggleContext: () => void;
  /** WP 2.9: open the member list of a department channel (passed only to someone who may manage members). */
  onShowMembers?: () => void;
  /** Receives focus when the user opens this conversation from the inbox on a narrow screen. */
  headingRef?: RefObject<HTMLHeadingElement>;
}

export function ThreadHeader({
  channel,
  title,
  subtitle,
  patient,
  contextOpen,
  onBack,
  onToggleContext,
  onShowMembers,
  headingRef,
}: ThreadHeaderProps): JSX.Element {
  return (
    <header className="wx-messaging-thread-header">
      <button
        type="button"
        className="wx-messaging-back"
        onClick={onBack}
        aria-label="Back to conversations"
      >
        <Glyph name="chevron-left" size={20} />
      </button>
      <span className={`wx-messaging-avatar wx-kind-${channel.kind}`} aria-hidden="true">
        {channel.kind === "care_team" ? <Glyph name="users" size={18} /> : initialsOf(title)}
      </span>
      <div className="wx-messaging-thread-title">
        <h2 ref={headingRef} tabIndex={-1}>
          {channel.kind === "care_team" && patient ? `${title} · Care Team` : title}
        </h2>
        <span>{patient ? `MRN ${patient.mrn}` : subtitle}</span>
      </div>
      {channel.archivedAt ? (
        <span className="wx-messaging-readonly">
          <Glyph name="lock" size={13} /> Archived · read only
        </span>
      ) : null}
      {/* WP 4.10: pauses non-urgent push / text / email notices for this conversation; shows nothing when the feature is off. */}
      <SnoozeControl channelId={channel.channelId} />
      {onShowMembers ? (
        <button type="button" className="wx-messaging-context-toggle" onClick={onShowMembers}>
          <Glyph name="users" size={16} />
          <span className="wx-messaging-context-label">Members</span>
        </button>
      ) : null}
      {channel.kind === "care_team" && patient ? (
        <button
          type="button"
          className="wx-messaging-context-toggle"
          aria-expanded={contextOpen}
          aria-controls="messaging-patient-context"
          onClick={onToggleContext}
        >
          <Glyph name="user-circle" size={16} />
          <span className="wx-messaging-context-label">Patient context</span>
        </button>
      ) : null}
    </header>
  );
}

/** Below 1280 px the patient context overlays the conversation (06-ux-design §1). Keep in step with messaging-responsive.css. */
const OVERLAY_CONTEXT_QUERY = "(max-width: 1279px)";

export function PatientContextAside({
  patient,
  onClose,
  idgChannelId,
  onOpenThread,
}: {
  patient: PatientHeaderInfo;
  onClose: () => void;
  /** WP 3.6: the care-team channel whose IDG discussions are listed; the section shows only with onOpenThread. */
  idgChannelId?: string;
  onOpenThread?: (rootId: string, opener: HTMLElement) => void;
}): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  // WP 2.11: opened by the user, so it takes focus (it is a slide-over / sheet below 1280 px) and hands it back on close.
  useEffect(() => {
    const opener = document.activeElement;
    // Docked (>= 1280 px) it is a column beside the conversation, not an overlay: leave focus on the toggle.
    const overlay =
      typeof window.matchMedia !== "function" || window.matchMedia(OVERLAY_CONTEXT_QUERY).matches;
    if (overlay) closeRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <aside
      id="messaging-patient-context"
      className="wx-messaging-patient-context"
      aria-label="Patient context"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <header>
        <strong>Patient context</strong>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="Close patient context">
          <Glyph name="close" size={17} />
        </button>
      </header>
      <div className="wx-messaging-patient-identity">
        <span className="wx-messaging-avatar">
          {initialsOf(`${patient.firstName} ${patient.lastName}`)}
        </span>
        <div>
          <strong>
            {patient.firstName} {patient.lastName}
          </strong>
          <span>MRN {patient.mrn}</span>
        </div>
      </div>
      <PatientContextTiles patientId={patient.id} />
      {idgChannelId && onOpenThread ? (
        <IdgDiscussionsSection channelId={idgChannelId} onOpenThread={onOpenThread} />
      ) : null}
      <Link to={`/patients/${patient.id}`}>
        Open patient chart <Glyph name="arrow-right" size={14} />
      </Link>
    </aside>
  );
}
