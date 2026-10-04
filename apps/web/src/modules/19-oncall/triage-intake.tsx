// apps/web/src/modules/19-oncall — S19.1 INBOUND CALL INTAKE (`/triage/intake`, §5.1, Track B /
// ADR-0030). Spec: docs/design/screens/clinical/WARDENX_UI_ON_CALL_TRIAGE.md — the "Create call" action.
//
// The form stays deliberately short. Source, covering shift, red-flag evaluation and AI suggestion are
// server-derived; the client captures only what a human intake operator can truthfully know at call open.
import {
  Button,
  EmptyState,
  Glyph,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@wardenx/ui";
import { useMemo, useState } from "react";
import type { CSSProperties, FormEvent, JSX } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  type TriageCallerKind,
  type TriageInboundChannel,
  errorMessage,
  openTriageCall,
} from "./oncall-api";
import {
  DEFAULT_CALLER_KIND,
  DEFAULT_INBOUND_CHANNEL,
  HUMAN_CALLER_KINDS,
  HUMAN_INBOUND_CHANNELS,
  humanize,
} from "./oncall-status";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** §4.2's `callerPhoneE164` pattern, mirrored so the clinician learns before the round trip. */
const E164_RE = /^\+[1-9]\d{1,14}$/;

export function TriageIntakeScreen(): JSX.Element {
  const client = useApiClient();
  const navigate = useNavigate();

  const [providerEntityId, setProviderEntityId] = useState("");
  const [inboundChannel, setInboundChannel] = useState(DEFAULT_INBOUND_CHANNEL);
  const [callerKind, setCallerKind] = useState(DEFAULT_CALLER_KIND);
  const [callerDisplayName, setCallerDisplayName] = useState("");
  const [callerPhone, setCallerPhone] = useState("");
  const [callerRelationship, setCallerRelationship] = useState("");
  const [patientId, setPatientId] = useState("");
  const [admissionId, setAdmissionId] = useState("");
  const [chiefComplaint, setChiefComplaint] = useState("");
  const [callerQuote, setCallerQuote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const peValid = UUID_RE.test(providerEntityId);
  const phoneValid = callerPhone === "" || E164_RE.test(callerPhone);
  const anchorValid =
    (patientId === "" && admissionId === "") ||
    (UUID_RE.test(patientId) && UUID_RE.test(admissionId));
  const canOpen = peValid && phoneValid && anchorValid && !busy;
  const hasCaller = callerDisplayName.trim() !== "" || callerPhone.trim() !== "";
  const hasNarrative = chiefComplaint.trim() !== "" || callerQuote.trim() !== "";
  const chartLinked = patientId.trim() !== "" && admissionId.trim() !== "";

  const validationSummary = useMemo(
    () => [
      { label: "Provider", valid: peValid, detail: peValid ? "Ready" : "Required UUID" },
      { label: "Callback", valid: phoneValid, detail: phoneValid ? "Valid" : "Use E.164" },
      {
        label: "Chart link",
        valid: anchorValid,
        detail: chartLinked ? "Attached" : anchorValid ? "Optional" : "Needs both IDs",
      },
    ],
    [anchorValid, chartLinked, peValid, phoneValid],
  );

  async function open(): Promise<void> {
    setBusy(true);
    setError(null);
    const res = await openTriageCall(client, {
      providerEntityId,
      inboundChannel: inboundChannel as TriageInboundChannel,
      callerKind: callerKind as TriageCallerKind,
      ...(callerDisplayName ? { callerDisplayName } : {}),
      ...(callerPhone ? { callerPhoneE164: callerPhone } : {}),
      ...(callerRelationship ? { callerRelationshipLabel: callerRelationship } : {}),
      ...(patientId ? { patientId, admissionId } : {}),
      ...(chiefComplaint ? { chiefComplaintText: chiefComplaint } : {}),
      ...(callerQuote ? { callerQuote } : {}),
    });
    setBusy(false);
    if (res.error || !res.result) {
      setError(errorMessage(res.error, "The call could not be opened."));
      return;
    }
    navigate(`/triage/calls/${res.result.triageCallId}`);
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (canOpen) await open();
  }

  if (!client) return <EmptyState title="Unavailable" description="No API client is configured." />;

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="Take a call"
          breadcrumb="On-call / Intake"
          actions={
            <Link to="/triage" style={linkButtonStyle}>
              Back to queue
            </Link>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Open the triage record quickly; shift assignment, source, and risk evaluation stay
            server-authored.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <div role="alert" style={errorBannerStyle}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Glyph name="alert" size={16} />
                <span>{error}</span>
              </div>
              <button
                type="button"
                onClick={() => setError(null)}
                style={dismissButtonStyle}
                aria-label="Dismiss error"
              >
                x
              </button>
            </div>
          ) : null}
          <output style={infoBannerStyle}>
            <Glyph name="info" size={16} />
            <span>
              Opening the call starts the record. Patient identification can happen later from the
              call panel.
            </span>
          </output>
        </div>
      }
      table={
        <form onSubmit={(event) => void submit(event)} style={formShellStyle}>
          <section style={sectionStyle}>
            <div style={sectionHeaderStyle}>
              <h2 style={sectionTitleStyle}>Where the call landed</h2>
              <StatusPill
                tone={peValid ? "success" : "warning"}
                label={peValid ? "Ready" : "Required"}
              />
            </div>
            <div style={fieldGridStyle}>
              <TextField
                label="Provider entity id"
                value={providerEntityId}
                onChange={setProviderEntityId}
                mono
                required
                invalid={providerEntityId !== "" && !peValid}
                hint="Coverage is resolved per ProviderEntity."
              />
              <SelectField
                label="Inbound channel"
                value={inboundChannel}
                options={HUMAN_INBOUND_CHANNELS.map((value) => ({
                  value,
                  label: humanize(value),
                }))}
                onChange={setInboundChannel}
              />
              <SelectField
                label="Caller kind"
                value={callerKind}
                options={HUMAN_CALLER_KINDS.map((value) => ({ value, label: humanize(value) }))}
                onChange={setCallerKind}
              />
            </div>
            {providerEntityId !== "" && !peValid ? (
              <p style={fieldErrorStyle}>That is not a well-formed provider-entity id.</p>
            ) : null}
          </section>

          <section style={sectionStyle}>
            <div style={sectionHeaderStyle}>
              <h2 style={sectionTitleStyle}>Who is on the line</h2>
              <StatusPill
                tone={hasCaller ? "progress" : "neutral"}
                label={hasCaller ? "Captured" : "Optional"}
              />
            </div>
            <div style={fieldGridStyle}>
              <TextField
                label="Caller name"
                value={callerDisplayName}
                onChange={setCallerDisplayName}
              />
              <TextField
                label="Callback number"
                value={callerPhone}
                onChange={setCallerPhone}
                type="tel"
                placeholder="+15125550123"
                mono
                invalid={!phoneValid}
                hint="Use E.164 when provided."
              />
              <TextField
                label="Relationship"
                value={callerRelationship}
                onChange={setCallerRelationship}
                placeholder="daughter, facility nurse"
              />
            </div>
            {!phoneValid ? (
              <p style={fieldErrorStyle}>
                A callback number must be E.164: a leading + and 2-15 digits.
              </p>
            ) : null}
          </section>

          <section style={sectionStyle}>
            <div style={sectionHeaderStyle}>
              <h2 style={sectionTitleStyle}>Patient anchor</h2>
              <StatusPill
                tone={anchorValid ? (chartLinked ? "success" : "neutral") : "error"}
                label={chartLinked ? "Linked" : anchorValid ? "Optional now" : "Incomplete"}
              />
            </div>
            <div style={fieldGridStyle}>
              <TextField
                label="Patient id"
                value={patientId}
                onChange={setPatientId}
                mono
                invalid={patientId !== "" && !UUID_RE.test(patientId)}
              />
              <TextField
                label="Admission id"
                value={admissionId}
                onChange={setAdmissionId}
                mono
                invalid={admissionId !== "" && !UUID_RE.test(admissionId)}
              />
            </div>
            {!anchorValid ? (
              <p style={fieldErrorStyle}>
                Patient and admission travel together or not at all; both must be UUIDs when one is
                supplied.
              </p>
            ) : (
              <p style={hintStyle}>
                Leave both blank if the chart is not found yet. The panel can identify the patient
                before documentation.
              </p>
            )}
          </section>

          <section style={sectionStyle}>
            <div style={sectionHeaderStyle}>
              <h2 style={sectionTitleStyle}>Why they rang</h2>
              <StatusPill
                tone={hasNarrative ? "progress" : "neutral"}
                label={hasNarrative ? "Started" : "Optional"}
              />
            </div>
            <TextAreaField
              label="Chief complaint"
              value={chiefComplaint}
              onChange={setChiefComplaint}
              rows={3}
              hint="Used by the server response to suggest protocol context on the panel."
            />
            <TextAreaField
              label="Caller's own words"
              value={callerQuote}
              onChange={setCallerQuote}
              rows={3}
              hint="Optional encrypted narrative."
            />
          </section>

          <div style={footerStyle}>
            <div style={validationStackStyle}>
              {validationSummary.map((item) => (
                <span key={item.label} style={validationItemStyle(item.valid)}>
                  {item.label}: {item.detail}
                </span>
              ))}
            </div>
            <Button
              type="submit"
              tone="primary"
              disabled={!canOpen}
              title={
                canOpen
                  ? undefined
                  : "A well-formed provider-entity id is required; callback must be E.164; patient and admission travel together."
              }
            >
              {busy ? "Opening..." : "Open the call"}
            </Button>
          </div>
        </form>
      }
      fullPageScroll
    />
  );
}

function TextField({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  hint,
  mono,
  required,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "tel";
  placeholder?: string;
  hint?: string;
  mono?: boolean;
  required?: boolean;
  invalid?: boolean;
}): JSX.Element {
  const id = `triage-${label.replace(/\W+/g, "-").toLowerCase()}`;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <label htmlFor={id} style={fieldStyle}>
      <span style={labelStyle}>
        {label}
        {required ? <span style={{ color: "var(--color-error)" }}> *</span> : null}
      </span>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        required={required}
        aria-invalid={invalid || undefined}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.target.value)}
        style={{
          ...inputStyle,
          ...(mono ? { fontFamily: "var(--font-mono)" } : {}),
          ...(invalid ? invalidInputStyle : {}),
        }}
      />
      {hint ? (
        <span id={hintId} style={hintStyle}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}): JSX.Element {
  const id = `triage-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <label htmlFor={id} style={fieldStyle}>
      <span style={labelStyle}>{label}</span>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={inputStyle}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  rows,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  hint: string;
}): JSX.Element {
  const id = `triage-${label.replace(/\W+/g, "-").toLowerCase()}`;
  const hintId = `${id}-hint`;
  return (
    <label htmlFor={id} style={fieldStyle}>
      <span style={labelStyle}>{label}</span>
      <textarea
        id={id}
        value={value}
        rows={rows}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.target.value)}
        style={textareaStyle}
      />
      <span id={hintId} style={hintStyle}>
        {hint}
      </span>
    </label>
  );
}

const filterShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};

const formShellStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "1rem",
  padding: "0 1.5rem 1.5rem",
};

const sectionStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.85rem",
  padding: "1rem",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-lowest)",
};

const sectionHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  color: "var(--color-on-surface)",
  fontSize: "0.95rem",
  fontWeight: 650,
};

const fieldGridStyle: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
  gap: "0.875rem",
};

const fieldStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "0.3rem",
  minWidth: 0,
};

const labelStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
  fontWeight: 650,
};

const inputStyle: CSSProperties = {
  width: "100%",
  minHeight: "2.35rem",
  padding: "0.5rem 0.65rem",
  borderRadius: "var(--radius-md)",
  border: "1px solid color-mix(in srgb, var(--color-outline-variant) 45%, transparent)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};

const invalidInputStyle: CSSProperties = {
  borderColor: "var(--color-error)",
  background: "color-mix(in srgb, var(--color-error) 8%, var(--color-surface-low))",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: "6rem",
  resize: "vertical",
  fontFamily: "inherit",
};

const hintStyle: CSSProperties = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};

const fieldErrorStyle: CSSProperties = {
  margin: 0,
  color: "var(--color-error)",
  fontSize: "0.8rem",
};

const footerStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
  position: "sticky",
  bottom: 0,
  padding: "0.875rem 0",
  background: "var(--color-surface)",
  borderTop: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
};

const validationStackStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.4rem",
};

const validationItemStyle = (valid: boolean): CSSProperties => ({
  display: "inline-flex",
  alignItems: "center",
  minHeight: "1.65rem",
  padding: "0.2rem 0.5rem",
  borderRadius: "var(--radius-sm)",
  background: valid
    ? "color-mix(in srgb, var(--color-success) 10%, transparent)"
    : "color-mix(in srgb, var(--color-warning) 12%, transparent)",
  color: `color-mix(in srgb, ${valid ? "var(--color-success)" : "var(--color-warning)"} 60%, var(--color-on-surface))`,
  fontSize: "0.75rem",
  fontWeight: 650,
});

const linkButtonStyle: CSSProperties = {
  minHeight: "2.25rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0.45rem 0.8rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  fontWeight: 650,
  textDecoration: "none",
};

const infoBannerStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-primary-tint)",
  border: "1px solid color-mix(in srgb, var(--color-primary) 25%, transparent)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};

const errorBannerStyle: CSSProperties = {
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--color-error) 12%, transparent)",
  border: "1px solid color-mix(in srgb, var(--color-error) 30%, transparent)",
  color: "var(--color-error)",
  fontSize: "0.85rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "0.75rem",
};

const dismissButtonStyle: CSSProperties = {
  border: "none",
  background: "none",
  color: "inherit",
  cursor: "pointer",
  fontWeight: 600,
};
