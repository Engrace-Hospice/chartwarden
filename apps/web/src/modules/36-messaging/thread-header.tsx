// The conversation header and the patient-context pane of ConversationThread (moved out of it unchanged in WP 2.2 to
// keep that file under the line ceiling).
import { Glyph } from "@wardenx/ui";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import type { ChannelSummary, PatientHeaderInfo } from "./messaging-types";
import { initialsOf } from "./messaging-utils";

export interface ThreadHeaderProps {
  channel: ChannelSummary;
  title: string;
  subtitle: string;
  patient: PatientHeaderInfo | null;
  contextOpen: boolean;
  onBack: () => void;
  onToggleContext: () => void;
}

export function ThreadHeader({
  channel,
  title,
  subtitle,
  patient,
  contextOpen,
  onBack,
  onToggleContext,
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
        <h2>{channel.kind === "care_team" && patient ? `${title} · Care Team` : title}</h2>
        <span>{patient ? `MRN ${patient.mrn}` : subtitle}</span>
      </div>
      {channel.archivedAt ? (
        <span className="wx-messaging-readonly">
          <Glyph name="lock" size={13} /> Archived · read only
        </span>
      ) : null}
      {channel.kind === "care_team" && patient ? (
        <button
          type="button"
          className="wx-messaging-context-toggle"
          aria-expanded={contextOpen}
          aria-controls="messaging-patient-context"
          onClick={onToggleContext}
        >
          <Glyph name="user-circle" size={16} /> Patient context
        </button>
      ) : null}
    </header>
  );
}

export function PatientContextAside({
  patient,
  onClose,
}: {
  patient: PatientHeaderInfo;
  onClose: () => void;
}): JSX.Element {
  return (
    <aside
      id="messaging-patient-context"
      className="wx-messaging-patient-context"
      aria-label="Patient context"
    >
      <header>
        <strong>Patient context</strong>
        <button type="button" onClick={onClose} aria-label="Close patient context">
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
      <p>Minimum identification details for this authorized care-team conversation.</p>
      <Link to={`/patients/${patient.id}`}>
        Open patient chart <Glyph name="arrow-right" size={14} />
      </Link>
    </aside>
  );
}
