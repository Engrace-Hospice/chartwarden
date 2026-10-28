import { Button, Glyph, InlineAlert, StatusPill, useApiClient } from "@chartwarden/ui";
// @chartwarden/portal — §5.1 Telehealth waiting room (`/p/:patientId/visits/:visitId/telehealth`). Pre-visit
// checklist (consent reaffirm, audio test), then "Join" calls POST /portal/telehealth/visits/:id/join, which
// the backend telehealth adapter (M31-T05) answers with a short-lived vendor token + join URL. Two-party
// recording consent is surfaced before the token is used; the audio-only fallback (Tier-3, §7.3) is always
// offered. We wrap the vendor — we never navigate the caregiver to a raw Daily.co surface.
import { useRef, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import { readError } from "./portal-format";
import { PortalCard, PortalPage } from "./portal-page";
import { TELEHEALTH_FRAME_ALLOW, telehealthEmbedUrl } from "./telehealth-embed";

interface JoinTicket {
  vendor: string;
  vendorJoinUrl: string;
  vendorParticipantToken: string;
  tokenExpiresAt: string;
  audioOnlyFallbackActive: boolean;
  recordingActive: boolean;
}

export function TelehealthWaitingRoom(): JSX.Element {
  const { patientId, visitId } = useParams<{
    patientId: string;
    visitId: string;
  }>();
  // Switching to another visit, even within the same patient, must drop the old
  // vendor ticket, consent and asynchronous join state before rendering.
  return (
    <WaitingRoomForVisit key={`${patientId ?? "none"}:${visitId ?? "none"}`} visitId={visitId} />
  );
}

function WaitingRoomForVisit({ visitId }: { visitId?: string }): JSX.Element {
  const client = useApiClient();
  const joinInFlight = useRef(false);
  const leaveInFlight = useRef(false);
  const [consented, setConsented] = useState(false);
  const [ticket, setTicket] = useState<JoinTicket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState(false);

  async function join(): Promise<void> {
    // The disabled button is presentation only; the action itself must also enforce acknowledgement.
    if (!visitId || !consented || joinInFlight.current) return;
    joinInFlight.current = true;
    setJoining(true);
    setError(null);
    try {
      const res = await client.POST("/api/v1/portal/telehealth/visits/{visitId}/join", {
        params: { path: { visitId } },
      });
      if ("error" in res) {
        setError(readError(res.response?.status));
      } else {
        const nextTicket = res.data as JoinTicket | undefined;
        if (nextTicket && telehealthEmbedUrl(nextTicket)) setTicket(nextTicket);
        else
          setError(
            "This video room could not be opened securely. Please contact your hospice team.",
          );
      }
    } catch {
      setError("We couldn't connect to the video visit. Check your connection and try again.");
    } finally {
      joinInFlight.current = false;
      setJoining(false);
    }
  }

  async function leave(): Promise<void> {
    if (!visitId || leaveInFlight.current) return;
    leaveInFlight.current = true;
    setError(null);
    try {
      const res = await client.POST("/api/v1/portal/telehealth/visits/{visitId}/leave", {
        params: { path: { visitId } },
      });
      if ("error" in res) setError(readError(res.response?.status));
      else setTicket(null);
    } catch {
      setError("We couldn't confirm leaving this visit. Please try again.");
    } finally {
      leaveInFlight.current = false;
    }
  }

  if (ticket) {
    const embedUrl = telehealthEmbedUrl(ticket);
    return (
      <PortalPage
        title="Video visit"
        subtitle="You're connected to your care team."
        width="workspace"
      >
        <div className="wx-portal-telehealth-room">
          <PortalCard heading="In the visit">
            <p className="wx-portal-body-copy">
              The video runs inside this secure window.{" "}
              {ticket.recordingActive ? (
                <StatusPill tone="warning" label="Recording" />
              ) : (
                <StatusPill tone="neutral" label="Not recording" />
              )}
            </p>
            {/* GAP-053: the vendor's hosted room runs in a frame; the token travels in the frame url and the
              join url is never rendered as a link that would bypass our PHI boundary. The vendor room carries the
              mute / camera / chat / participant controls. */}
            {embedUrl ? (
              <iframe
                title="Video visit"
                aria-label="Video area"
                src={embedUrl}
                allow={TELEHEALTH_FRAME_ALLOW}
                referrerPolicy="no-referrer"
                className="wx-portal-video-frame"
              />
            ) : (
              <InlineAlert tone="error">
                The video room could not be opened. Leave and try joining again, or call your care
                team.
              </InlineAlert>
            )}
            {ticket.audioOnlyFallbackActive ? (
              <p className="wx-portal-supporting-copy">
                Audio-only mode is on because of a limited connection.
              </p>
            ) : null}
            {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
            <div className="wx-portal-actions">
              <Button tone="secondary" onClick={() => void leave()}>
                Leave visit
              </Button>
            </div>
          </PortalCard>
        </div>
      </PortalPage>
    );
  }

  return (
    <PortalPage
      title="Telehealth waiting room"
      subtitle="Prepare your space and confirm your acknowledgement before connecting."
      width="reading"
    >
      <div className="wx-portal-telehealth-waiting">
        <PortalCard heading="Before you join">
          <div className="wx-portal-telehealth-intro" aria-hidden="true">
            <span>
              <Glyph name="video" size={24} />
            </span>
          </div>
          <ul className="wx-portal-content-list">
            <li>Find a quiet, private spot with a steady connection.</li>
            <li>Your microphone and camera will be requested when you join.</li>
            <li>If video won't connect, you can switch to audio-only.</li>
          </ul>
          <label className="wx-portal-check-row">
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
          {error ? <InlineAlert tone="error">{error}</InlineAlert> : null}
          <div className="wx-portal-actions">
            <Button loading={joining} disabled={!consented || joining} onClick={() => void join()}>
              {joining ? "Connecting…" : "Join visit"}
            </Button>
          </div>
        </PortalCard>
      </div>
    </PortalPage>
  );
}
