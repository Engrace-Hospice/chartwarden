// apps/web/src/modules/20-field-safety — §5.1 "MY SAFETY CONSENT" (`/me/safety/consent`,
// Track B / ADR-0030). D6 / D10 / M20-F06.
//
// The clinician's own consent surface: three separately grantable, separately revocable purposes, each
// with the exact acknowledgment text she was shown at the moment she agreed.
//
// ── THE ACKNOWLEDGMENT TEXT IS THE PRODUCT, NOT THE CHROME ──────────────────────────────────────────
//
// `acknowledgmentTextSnapshot` is REQUIRED on the grant and is deliberately NOT audit-denylisted (§3.3
// says so in its own note): it is the one thing a consent dispute turns on. So the screen sends the exact
// sentence it displayed — {@link CONSENT_TEXT} below — rather than a summary or a version tag. If the
// wording here changes, past grants keep the wording they were given, which is the whole point of storing
// a snapshot instead of a pointer.
//
// ── DECLINING `sos_coordinates` DOES NOT DISABLE THE SOS BUTTON (M20-F16) ────────────────────────────
//
// §5.2's own sketch says the opposite ("declining disables the SOS feature with an explanatory banner").
// M20-F16 overrides it and the implementation follows M20-F16: the press always succeeds, the alert
// always fans out, and the recipients are simply told there is no position. This screen says that
// plainly, because a clinician who believes declining will disable her panic button will consent under
// duress — which is exactly the coercion §2.2.8 keeps `revoked` and `expired` distinct in order to detect.
//
// ── `emergency_contact_call` IS M20-F06: THIS ROW *IS* THE CONTACT ──────────────────────────────────
//
// M2 has no emergency-contact table, so the consent row carries the contact in its encrypted scope
// detail. The read projection returns a BOOLEAN (`contactOnFile`), never the number — re-displaying a
// spouse's phone on every page load would widen the disclosure the consent was given for. Changing the
// contact is therefore a fresh grant, and the screen says so rather than offering an edit that does not
// exist.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
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
  Card,
  Modal,
  Notice,
  SummaryGrid,
  Field,
  TextAreaField,
  TextField,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
} from "./safety-ui";

/**
 * The exact text sent as `acknowledgmentTextSnapshot`, per purpose.
 *
 * These sentences are the record. They are written in the second person and in plain words, because the
 * person who has to understand them is a nurse on a doorstep, and because a snapshot of legalese proves
 * only that legalese was displayed.
 */
const CONSENT_TEXT: Record<string, string> = {
  sos_coordinates:
    "I agree that when I press the SOS button, my device's location at that moment may be recorded and shown to the people responding to my alert. I understand that every time somebody views my location it is logged with their name, and that I can see those views on this page. I understand that declining this does NOT disable my SOS button — my alert will still be raised, and the responders will simply be told my location is unknown.",
  continuous_location_during_sos:
    "I agree that while an SOS of mine is active, my device's location may be sampled repeatedly and shown to the people responding, until the alert is resolved or the agency's time limit is reached. I understand this happens only while an alert of mine is open — never at any other time — and only if my agency has also enabled it. I can withdraw this at any time.",
  emergency_contact_call:
    "I give the person named below as my emergency contact, and I agree that my agency may call them if I raise an SOS and cannot be reached. I understand their details are stored encrypted and are not shown back to me or to my supervisors on any screen — only used to place that call.",
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
      // Unreachable through the UI, and a refusal rather than a fallback: sending a placeholder snapshot
      // would record a consent to text nobody wrote.
      setSaving(false);
      setModalError("No consent wording is defined for that purpose, so nothing was sent.");
      return;
    }
    const res = await grantConsent(client, {
      purpose: granting,
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
      purpose: revoking,
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

  if (loading) return <LoadingSpinner />;
  if (error && consents.length === 0)
    return <EmptyState title="Consent settings unavailable" description={error} />;

  const byPurpose = new Map(consents.map((c) => [c.purpose, c]));

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>My safety consent</span>}
        breadcrumb="Field safety"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/me/safety" style={ghostButtonStyle}>
              My safety
            </Link>
            <button type="button" onClick={() => void load()} style={ghostButtonStyle}>
              Refresh
            </button>
          </div>
        }
      />

      <Notice tone="info" live>
        These three are <strong>separate</strong>: you can give one and refuse another, and withdraw any of
        them at any time without affecting the others.{" "}
        <strong>Refusing all three does not disable your SOS button.</strong> The alert is raised either
        way — the people responding are simply told your location is unknown.
      </Notice>

      {error ? (
        <Notice tone="warning" live>
          {error}
        </Notice>
      ) : null}

      {CONSENT_PURPOSES.map((purpose) => {
        const c = byPurpose.get(purpose);
        const granted = c?.status === "granted";
        return (
          <Card
            key={purpose}
            title={consentPurposeLabel(purpose)}
            actions={
              <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
                {granted ? (
                  <button
                    type="button"
                    onClick={() => {
                      setRevokeReason("");
                      setModalError(null);
                      setRevoking(purpose);
                    }}
                    style={ghostButtonStyle}
                  >
                    Withdraw
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setModalError(null);
                      setGranting(purpose);
                    }}
                    style={primaryButtonStyle}
                  >
                    {c ? "Give it again" : "Give consent"}
                  </button>
                )}
              </div>
            }
          >
            {c ? (
              <>
                <SummaryGrid>
                  <Field
                    label="Status"
                    value={
                      <StatusPill
                        label={humanize(c.status)}
                        tone={toneOf(CONSENT_STATUS_TONE, c.status)}
                      />
                    }
                  />
                  <Field label="Given" value={dateTime(c.grantedAt)} />
                  <Field label="Withdrawn" value={dateTime(c.revokedAt)} />
                  <Field
                    label="Expires"
                    value={c.expiresAt ? dateTime(c.expiresAt) : "No expiry set"}
                  />
                  {purpose === "emergency_contact_call" ? (
                    <Field
                      label="Contact on file"
                      value={c.contactOnFile ? "Yes — held, not shown" : "None"}
                    />
                  ) : null}
                </SummaryGrid>
                {c.status === "expired" ? (
                  <Notice tone="warning">
                    This lapsed on your agency's rotation schedule — it is <strong>not</strong> the same as
                    you withdrawing it, and the record keeps the two apart. Give it again if you still
                    agree.
                  </Notice>
                ) : null}
                <details>
                  <summary style={{ ...mutedStyle, cursor: "pointer" }}>
                    What you were shown when you agreed
                  </summary>
                  <p style={{ margin: `${t.space2} 0 0`, fontSize: "0.85rem", whiteSpace: "pre-wrap" }}>
                    {c.acknowledgmentTextSnapshot}
                  </p>
                </details>
                {purpose === "emergency_contact_call" && c.contactOnFile ? (
                  <span style={mutedStyle}>
                    Your contact's details are held encrypted and are never shown back — not to you, not to
                    your supervisors. To change them, give this consent again with the new details; the new
                    grant replaces the old one.
                  </span>
                ) : null}
              </>
            ) : (
              <>
                <Notice tone="info">You have not been asked for this one yet.</Notice>
                <p style={{ margin: 0, fontSize: "0.85rem", whiteSpace: "pre-wrap" }}>
                  {CONSENT_TEXT[purpose]}
                </p>
              </>
            )}
          </Card>
        );
      })}

      <Card title="Who has looked at my location">
        <span style={mutedStyle}>
          Every read of your coordinates is logged at raised severity with the reader's name, and once an
          alert has closed a supervisor must write a reason of at least forty characters before the system
          will decrypt anything. §8.7 gives you the right to see that list here. M20 publishes no route
          that returns it to this page yet — the entries are in the audit record, reachable through your
          compliance officer — so this section names the gap rather than showing an empty list that would
          read as "nobody has looked".
        </span>
      </Card>

      {asOf ? <span style={mutedStyle}>Read at {dateTime(asOf)}.</span> : null}

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
              {saving ? "Recording…" : "I consent"}
            </button>
          }
        >
          {/* The exact text sent as the snapshot. Displayed and stored are the same string, by
              construction — see the module header. */}
          <p style={{ margin: 0, fontSize: "0.9rem", whiteSpace: "pre-wrap" }}>
            {CONSENT_TEXT[granting]}
          </p>
          {granting === "emergency_contact_call" ? (
            <>
              <TextField label="Their name" value={contactName} onChange={setContactName} />
              <TextField
                label="Their phone number"
                value={contactPhone}
                onChange={setContactPhone}
                type="tel"
                hint="Stored encrypted. It is not shown back on any screen — including this one, next time you visit."
              />
              <TextField
                label="Relationship to you (optional)"
                value={contactRelationship}
                onChange={setContactRelationship}
              />
            </>
          ) : null}
          <Notice tone="info">
            The words above are stored with your consent exactly as written, so a later question about what
            you agreed to is answered by what you were actually shown.
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
              {saving ? "Recording…" : "Withdraw my consent"}
            </button>
          }
        >
          <Notice tone="info">
            You do not have to give a reason, and nobody has to approve this.{" "}
            {revoking === "sos_coordinates"
              ? "Your SOS button keeps working exactly as before — the responders will simply be told your location is unknown."
              : revoking === "continuous_location_during_sos"
                ? "Your SOS keeps working and the responders still get your position at the moment you pressed; they just will not see you move."
                : "Your agency will no longer call this contact."}
          </Notice>
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
  );
}
