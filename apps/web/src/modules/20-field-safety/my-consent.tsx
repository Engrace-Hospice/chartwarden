// apps/web/src/modules/20-field-safety - §5.1 "MY SAFETY CONSENT" (`/me/safety/consent`,
// Track B / ADR-0030). D6 / D10 / M20-F06.
//
// The clinician's own consent surface. Each purpose is separate and revocable.
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type SafetyConsentPurpose,
  type SafetyConsentView,
  errorMessage,
  getConsents,
  grantConsent,
  revokeConsent,
} from "./safety-api";
import {
  CONSENT_PURPOSES,
  CONSENT_STATUS_TONE,
  consentPurposeLabel,
  dateTime,
  humanize,
  toneOf,
} from "./safety-status";
import {
  Modal,
  Notice,
  TextAreaField,
  TextField,
  disabledButtonStyle,
  primaryButtonStyle,
} from "./safety-ui";

const CONSENT_TEXT: Record<string, string> = {
  sos_coordinates:
    "I agree that when I press the SOS button, my device's location at that moment may be recorded and shown to the people responding to my alert. I understand that every time somebody views my location it is logged with their name, and that I can see those views on this page. I understand that declining this does NOT disable my SOS button - my alert will still be raised, and the responders will simply be told my location is unknown.",
  continuous_location_during_sos:
    "I agree that while an SOS of mine is active, my device's location may be sampled repeatedly and shown to the people responding, until the alert is resolved or the agency's time limit is reached. I understand this happens only while an alert of mine is open - never at any other time - and only if my agency has also enabled it. I can withdraw this at any time.",
  emergency_contact_call:
    "I give the person named below as my emergency contact, and I agree that my agency may call them if I raise an SOS and cannot be reached. I understand their details are stored encrypted and are not shown back to me or to my supervisors on any screen - only used to place that call.",
};

export function MyConsentScreen(): JSX.Element {
  const client = useApiClient();
  const [consents, setConsents] = useState<SafetyConsentView[]>([]);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [granting, setGranting] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactRelationship, setContactRelationship] = useState("");
  const [revokeReason, setRevokeReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await getConsents(client);
    if (res.error || !res.surface) {
      setError(errorMessage(res.error, "Your consent settings could not be read."));
      setConsents([]);
      setAsOf(null);
    } else {
      setConsents(res.surface.consents);
      setAsOf(res.surface.asOf);
      setError(null);
    }
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const doGrant = useCallback(async () => {
    if (!granting) return;
    setSaving(true);
    setModalError(null);
    const text = CONSENT_TEXT[granting];
    if (!text) {
      setSaving(false);
      setModalError("No consent wording is defined for that purpose, so nothing was sent.");
      return;
    }
    const res = await grantConsent(client, {
      purpose: granting as NonNullable<SafetyConsentPurpose>,
      acknowledgmentTextSnapshot: text,
      ...(granting === "emergency_contact_call"
        ? {
            contact: {
              name: contactName.trim(),
              phone: contactPhone.trim(),
              ...(contactRelationship.trim() ? { relationship: contactRelationship.trim() } : {}),
            },
          }
        : {}),
    });
    setSaving(false);
    if (res.error) {
      setModalError(errorMessage(res.error, "Your consent was not recorded."));
      return;
    }
    setGranting(null);
    setContactName("");
    setContactPhone("");
    setContactRelationship("");
    await load();
  }, [client, contactName, contactPhone, contactRelationship, granting, load]);

  const doRevoke = useCallback(async () => {
    if (!revoking) return;
    setSaving(true);
    setModalError(null);
    const res = await revokeConsent(client, {
      purpose: revoking as NonNullable<SafetyConsentPurpose>,
      ...(revokeReason.trim() ? { reason: revokeReason.trim() } : {}),
    });
    setSaving(false);
    if (res.error) {
      setModalError(errorMessage(res.error, "Your withdrawal was not recorded."));
      return;
    }
    setRevoking(null);
    setRevokeReason("");
    await load();
  }, [client, load, revokeReason, revoking]);

  const byPurpose = useMemo(
    () => new Map(consents.map((consent) => [consent.purpose, consent])),
    [consents],
  );

  if (loading && consents.length === 0) {
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  }

  if (error && consents.length === 0) {
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState title="Consent settings unavailable" description={error} />
      </div>
    );
  }

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="My Safety Consent"
          breadcrumb="Field safety"
          actions={
            <div style={actionGroupStyle}>
              <Link to="/me/safety" style={linkButtonStyle}>
                My safety
              </Link>
              <Button type="button" tone="secondary" onClick={() => void load()} loading={loading}>
                Refresh
              </Button>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            {asOf ? `Read at ${dateTime(asOf)}.` : "Consent settings scoped to your own account."}
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          <Notice tone="info" live>
            These consents are separate. Refusing all three does not disable SOS; the alert is still
            raised and responders are told location is unknown.
          </Notice>
          {error ? (
            <Notice tone="warning" live>
              {error}
            </Notice>
          ) : null}
        </div>
      }
      table={
        <div style={contentStyle}>
          <table style={tableStyle}>
            <thead>
              <tr style={headerRowStyle}>
                <th style={{ ...thStyle, width: "24%" }}>Purpose</th>
                <th style={{ ...thStyle, width: "13%" }}>Status</th>
                <th style={{ ...thStyle, width: "15%" }}>Given</th>
                <th style={{ ...thStyle, width: "15%" }}>Withdrawn</th>
                <th style={{ ...thStyle, width: "15%" }}>Expires</th>
                <th style={{ ...thStyle, width: "10%" }}>Contact</th>
                <th style={{ ...thStyle, width: "8%", textAlign: "right" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {CONSENT_PURPOSES.map((purpose) => {
                const consent = byPurpose.get(purpose);
                return (
                  <ConsentRow
                    key={purpose}
                    purpose={purpose}
                    consent={consent}
                    onGrant={() => {
                      setModalError(null);
                      setGranting(purpose);
                    }}
                    onRevoke={() => {
                      setRevokeReason("");
                      setModalError(null);
                      setRevoking(purpose);
                    }}
                  />
                );
              })}
            </tbody>
          </table>

          <section style={sectionStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Consent wording</span>
              <strong>Current text shown before a grant</strong>
            </div>
            <div style={wordingGridStyle}>
              {CONSENT_PURPOSES.map((purpose) => (
                <details key={purpose} style={detailsStyle}>
                  <summary style={summaryStyle}>{consentPurposeLabel(purpose)}</summary>
                  <p style={paragraphStyle}>{CONSENT_TEXT[purpose]}</p>
                </details>
              ))}
            </div>
          </section>

          <div role="note" style={noteStyle}>
            <StatusPill label="Audit gap" tone="neutral" />
            <span>
              Coordinate reads are logged, but M20 does not yet expose a self-service read route for
              that audit list. This page names the gap instead of showing an empty list.
            </span>
          </div>

          {granting ? (
            <Modal
              title={consentPurposeLabel(granting)}
              onClose={() => setGranting(null)}
              footer={
                <button
                  type="button"
                  onClick={() => void doGrant()}
                  disabled={
                    saving ||
                    (granting === "emergency_contact_call" &&
                      (contactName.trim().length === 0 || contactPhone.trim().length === 0))
                  }
                  style={
                    saving ||
                    (granting === "emergency_contact_call" &&
                      (contactName.trim().length === 0 || contactPhone.trim().length === 0))
                      ? disabledButtonStyle
                      : primaryButtonStyle
                  }
                >
                  {saving ? "Recording..." : "I consent"}
                </button>
              }
            >
              <p style={paragraphStyle}>{CONSENT_TEXT[granting]}</p>
              {granting === "emergency_contact_call" ? (
                <>
                  <TextField label="Their name" value={contactName} onChange={setContactName} />
                  <TextField
                    label="Their phone number"
                    value={contactPhone}
                    onChange={setContactPhone}
                    type="tel"
                    hint="Enter a full number with area code (no extension). Stored encrypted. It is not shown back on any screen."
                  />
                  <TextField
                    label="Relationship to you (optional)"
                    value={contactRelationship}
                    onChange={setContactRelationship}
                  />
                </>
              ) : null}
              <Notice tone="info">
                The words above are stored with your consent exactly as written.
              </Notice>
              {modalError ? (
                <Notice tone="error" assertive>
                  {modalError}
                </Notice>
              ) : null}
            </Modal>
          ) : null}

          {revoking ? (
            <Modal
              title={`Withdraw: ${consentPurposeLabel(revoking)}`}
              onClose={() => setRevoking(null)}
              footer={
                <button
                  type="button"
                  onClick={() => void doRevoke()}
                  disabled={saving}
                  style={saving ? disabledButtonStyle : primaryButtonStyle}
                >
                  {saving ? "Recording..." : "Withdraw my consent"}
                </button>
              }
            >
              <Notice tone="info">{withdrawalCopy(revoking)}</Notice>
              <TextAreaField
                label="Reason (optional)"
                value={revokeReason}
                onChange={setRevokeReason}
                rows={3}
              />
              {modalError ? (
                <Notice tone="error" assertive>
                  {modalError}
                </Notice>
              ) : null}
            </Modal>
          ) : null}
        </div>
      }
      fullPageScroll
    />
  );
}

function ConsentRow({
  purpose,
  consent,
  onGrant,
  onRevoke,
}: {
  purpose: string;
  consent: SafetyConsentView | undefined;
  onGrant: () => void;
  onRevoke: () => void;
}): JSX.Element {
  const granted = consent?.status === "granted";
  return (
    <tr style={rowStyle}>
      <td style={tdStyle}>{consentPurposeLabel(purpose)}</td>
      <td style={tdStyle}>
        {consent ? (
          <StatusPill
            label={humanize(consent.status)}
            tone={toneOf(CONSENT_STATUS_TONE, consent.status)}
          />
        ) : (
          <StatusPill label="Not asked" tone="neutral" />
        )}
      </td>
      <td style={tdStyle}>{consent ? dateTime(consent.grantedAt) : "-"}</td>
      <td style={tdStyle}>{consent ? dateTime(consent.revokedAt) : "-"}</td>
      <td style={tdStyle}>{consent?.expiresAt ? dateTime(consent.expiresAt) : "No expiry"}</td>
      <td style={tdStyle}>
        {purpose === "emergency_contact_call" ? (consent?.contactOnFile ? "On file" : "None") : "-"}
      </td>
      <td style={{ ...tdStyle, textAlign: "right" }}>
        <Button
          size="sm"
          tone={granted ? "tertiary" : "primary"}
          onClick={granted ? onRevoke : onGrant}
        >
          {granted ? "Withdraw" : consent ? "Give again" : "Give"}
        </Button>
      </td>
    </tr>
  );
}

function withdrawalCopy(purpose: string): string {
  if (purpose === "sos_coordinates") {
    return "Your SOS button keeps working exactly as before; responders will simply be told your location is unknown.";
  }
  if (purpose === "continuous_location_during_sos") {
    return "Your SOS keeps working, but responders will not see continuous movement while the alert is active.";
  }
  return "Your agency will no longer call this contact.";
}

const actionGroupStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "0.5rem",
};
const linkButtonStyle = {
  minHeight: "2.25rem",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 0.75rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-container)",
  color: "var(--color-on-surface)",
  fontSize: "0.85rem",
  fontWeight: 600,
  textDecoration: "none",
};
const filterShellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
  padding: "0 1.5rem 0.75rem",
};
const contentStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "1rem",
  padding: "0 1.5rem 1.5rem",
};
const sectionStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.75rem",
};
const toolbarTitleStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.125rem",
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
};
const toolbarEyebrowStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const tableStyle = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "0.875rem",
};
const headerRowStyle = {
  textAlign: "left" as const,
  color: "var(--color-on-surface-variant)",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 40%, transparent)",
  background: "var(--color-surface-low)",
};
const rowStyle = {
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};
const thStyle = {
  padding: "0.625rem 1rem",
  fontWeight: 600,
  fontSize: "0.75rem",
};
const tdStyle = {
  padding: "0.75rem 1rem",
  verticalAlign: "middle" as const,
};
const wordingGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(16rem, 1fr))",
  gap: "0.75rem",
};
const detailsStyle = {
  paddingBottom: "0.75rem",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 30%, transparent)",
};
const summaryStyle = {
  cursor: "pointer",
  color: "var(--color-on-surface)",
  fontWeight: 600,
  fontSize: "0.875rem",
};
const paragraphStyle = {
  margin: 0,
  color: "var(--color-on-surface)",
  fontSize: "0.875rem",
  whiteSpace: "pre-wrap" as const,
};
const noteStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.75rem",
  padding: "0.625rem 1rem",
  borderRadius: "var(--radius-md)",
  background: "var(--color-surface-low)",
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
};
