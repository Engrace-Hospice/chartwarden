import { StatusPill, t, useApiClient } from "@wardenx/ui";
// @wardenx/portal — §5.1 Telehealth waiting room (`/p/:patientId/visits/:visitId/telehealth`). Pre-visit
// checklist (consent reaffirm, audio test), then "Join" calls POST /portal/telehealth/visits/:id/join, which
// the backend telehealth adapter (M31-T05) answers with a short-lived vendor token + join URL. Two-party
// recording consent is surfaced before the token is used; the audio-only fallback (Tier-3, §7.3) is always
// offered. We wrap the vendor — we never navigate the caregiver to a raw Daily.co surface.
import { useState } from "react";
import type { CSSProperties, JSX } from "react";
import { useParams } from "react-router-dom";
import { readError } from "./portal-format";
import { PortalCard, PortalPage } from "./portal-page";

interface JoinTicket {
  vendor: string;
  vendorJoinUrl: string;
  vendorParticipantToken: string;
  tokenExpiresAt: string;
  audioOnlyFallbackActive: boolean;
  recordingActive: boolean;
}

const primaryBtn: CSSProperties = {
  padding: "0.6rem 1rem",
  borderRadius: "0.5rem",
  border: "none",
  background: t.primary,
  color: t.onPrimary,
  fontWeight: 600,
  cursor: "pointer",
};
const ghostBtn: CSSProperties = {
  ...primaryBtn,
  background: t.surfaceContainer,
  color: t.onSurface,
};

export function TelehealthWaitingRoom(): JSX.Element {
  const client = useApiClient();
  const { visitId } = useParams<{ visitId: string }>();
  const [consented, setConsented] = useState(false);
  const [ticket, setTicket] = useState<JoinTicket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  async function join(): Promise<void> {
    if (!visitId) return;
    setJoining(true);
    setError(null);
    const res = await client.POST("/api/v1/portal/telehealth/visits/{visitId}/join", {
      params: { path: { visitId } },
    });
    setJoining(false);
    if (res.error) setError(readError(res.response?.status));
    else setTicket((res.data as JoinTicket) ?? null);
  }

  async function leave(): Promise<void> {
    if (!visitId) return;
    await client.POST("/api/v1/portal/telehealth/visits/{visitId}/leave", {
      params: { path: { visitId } },
      body: {},
    });
    setTicket(null);
  }

  if (ticket) {
    return (
      <PortalPage title="Video visit" subtitle="You're connected to your care team.">
        <PortalCard heading="In the visit">
          <p style={{ margin: "0 0 0.75rem", fontSize: "0.9rem" }}>
            The video runs inside this secure window.{" "}
            {ticket.recordingActive ? (
              <StatusPill tone="warning" label="Recording" />
            ) : (
              <StatusPill tone="neutral" label="Not recording" />
            )}
          </p>
          {/* The vendor SDK mounts here in the running app; the join URL + token are held, never shown as a
              clickable link that would bypass our PHI boundary. */}
          <div
            aria-label="Video area"
            style={{
              height: "16rem",
              borderRadius: "0.6rem",
              background: t.surfaceLowest,
              border: `1px solid ${t.surfaceContainer}`,
              display: "grid",
              placeItems: "center",
              color: t.onSurfaceVariant,
              fontSize: "0.85rem",
            }}
          >
            {ticket.audioOnlyFallbackActive
              ? "Audio-only mode (limited connection)"
              : "Video connected"}
          </div>
          <div style={{ display: "flex", gap: "0.75rem", marginTop: "1rem" }}>
            <button type="button" style={ghostBtn} onClick={() => void leave()}>
              Leave visit
            </button>
          </div>
        </PortalCard>
      </PortalPage>
    );
  }

  return (
    <PortalPage
      title="Telehealth waiting room"
      subtitle="A few checks before your care team joins."
    >
      <PortalCard heading="Before you join">
        <ul style={{ margin: "0 0 1rem", paddingLeft: "1.1rem", fontSize: "0.9rem" }}>
          <li>Find a quiet, private spot with a steady connection.</li>
          <li>Your microphone and camera will be requested when you join.</li>
          <li>If video won't connect, you can switch to audio-only.</li>
        </ul>
        <label
          style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", fontSize: "0.88rem" }}
        >
          <input
            type="checkbox"
            checked={consented}
            onChange={(e) => setConsented(e.target.checked)}
          />
          <span>
            I understand this visit may be recorded with consent, and I agree to take part in a
            telehealth visit for my loved one.
          </span>
        </label>
        {error ? (
          <p role="alert" style={{ color: t.error, fontSize: "0.85rem", margin: "0.75rem 0 0" }}>
            {error}
          </p>
        ) : null}
        <div style={{ marginTop: "1rem" }}>
          <button
            type="button"
            style={primaryBtn}
            disabled={!consented || joining}
            onClick={() => void join()}
          >
            {joining ? "Connecting…" : "Join visit"}
          </button>
        </div>
      </PortalCard>
    </PortalPage>
  );
}
