// apps/web/src/modules/20-field-safety - §5.2 "MY SAFETY" (`/me/safety`, Track B / ADR-0030).
//
// The clinician's own surface: SOS, due check-ins, and an ad-hoc concern check-in.
import {
  Button,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type RaiseSosResult,
  type SafetyCheckInKind,
  type SafetyCheckInStatus,
  type SafetyMyDayView,
  type SafetyWarning,
  cancelSos,
  errorMessage,
  getConsents,
  getMyDay,
  raiseSos,
  recordCheckIn,
} from "./safety-api";
import {
  AD_HOC_CHECK_IN_KINDS,
  CONCERN_NOTE_MIN_CHARS,
  DEFAULT_CHECK_IN_KIND,
  DEFAULT_CHECK_IN_STATUS,
  checkInStatusLabel,
  dateTime,
  humanize,
  meetsMinChars,
  secondsUntil,
  shortId,
} from "./safety-status";
import {
  CancelCountdown,
  Notice,
  SelectField,
  SosButton,
  TextAreaField,
  disabledButtonStyle,
  primaryButtonStyle,
} from "./safety-ui";

const GEO_TIMEOUT_MS = 3000;

async function tryPosition(): Promise<{
  latitude: number;
  longitude: number;
  accuracyM: number;
} | null> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: { latitude: number; longitude: number; accuracyM: number } | null) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const timer = setTimeout(() => done(null), GEO_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        clearTimeout(timer);
        done({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyM: Math.max(0, Math.round(position.coords.accuracy)),
        });
      },
      () => {
        clearTimeout(timer);
        done(null);
      },
      { enableHighAccuracy: true, timeout: GEO_TIMEOUT_MS, maximumAge: 0 },
    );
  });
}

export function MySafetyScreen(): JSX.Element {
  const client = useApiClient();
  const [day, setDay] = useState<SafetyMyDayView | null>(null);
  const [coordConsent, setCoordConsent] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [pressing, setPressing] = useState(false);
  const [raised, setRaised] = useState<RaiseSosResult | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [cancelState, setCancelState] = useState<string | null>(null);
  const [sosDenied, setSosDenied] = useState(false);
  const [sosError, setSosError] = useState<string | null>(null);

  const [kind, setKind] = useState(DEFAULT_CHECK_IN_KIND);
  const [status, setStatus] = useState(DEFAULT_CHECK_IN_STATUS);
  const [note, setNote] = useState("");
  const [posting, setPosting] = useState(false);
  const [postWarnings, setPostWarnings] = useState<SafetyWarning[] | null>(null);
  const [postError, setPostError] = useState<string | null>(null);

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [dayResult, consentResult] = await Promise.all([
      getMyDay(client, { limit: 25 }),
      getConsents(client),
    ]);
    setDay(dayResult.day);
    setCoordConsent(
      consentResult.surface
        ? consentResult.surface.consents.some(
            (consent) => consent.purpose === "sos_coordinates" && consent.status === "granted",
          )
        : null,
    );
    setError(
      dayResult.error ? errorMessage(dayResult.error, "Your safety day could not be read.") : null,
    );
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!raised) return;
    const tick = () => setSecondsLeft(secondsUntil(raised.cancelWindowExpiresAt));
    tick();
    tickRef.current = setInterval(tick, 250);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [raised]);

  const press = useCallback(async () => {
    setPressing(true);
    setSosError(null);
    setCancelState(null);
    const coords = await tryPosition();
    const res = await raiseSos(client, {
      ...(coords ? { postedCoordinates: coords } : {}),
      capturedAt: new Date().toISOString(),
    });
    setPressing(false);
    if (res.error || !res.result) {
      const body = res.error as { status?: number } | null;
      if (body?.status === 403) setSosDenied(true);
      setSosError(
        errorMessage(
          res.error,
          "The alert could not be raised. Do not wait on this screen - ring your agency's emergency line, and 911 if you are in danger now.",
        ),
      );
      return;
    }
    setRaised(res.result);
  }, [client]);

  const cancel = useCallback(async () => {
    if (!raised) return;
    const res = await cancelSos(client, raised.id, {});
    if (res.error || !res.result) {
      setSosError(
        errorMessage(res.error, "The cancel did not go through. The alert is still open."),
      );
      return;
    }
    setCancelState(res.result.cancelStatus);
  }, [client, raised]);

  const postCheckIn = useCallback(
    async (body: {
      kind: SafetyCheckInKind;
      status: SafetyCheckInStatus;
      visitId?: string;
      scheduleId?: string;
      concernNote?: string;
    }) => {
      setPosting(true);
      setPostError(null);
      setPostWarnings(null);
      const res = await recordCheckIn(client, body);
      setPosting(false);
      if (res.error || !res.result) {
        setPostError(errorMessage(res.error, "Your check-in was not recorded."));
        return;
      }
      setPostWarnings(res.result.warningsSurfaced);
      setNote("");
      await load();
    },
    [client, load],
  );

  if (loading) {
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  }

  const obligations = (day?.obligations ?? []).filter(
    (obligation) =>
      obligation.state === "proposed" ||
      obligation.state === "overdue" ||
      obligation.state === "escalated",
  );
  const noteOwed = status !== "ok";
  const canPost = !noteOwed || meetsMinChars(note, CONCERN_NOTE_MIN_CHARS);

  return (
    <WorkQueueLayout
      header={
        <PageHeader
          title="My Safety"
          breadcrumb="Field safety"
          actions={
            <div style={actionGroupStyle}>
              <Link to="/me/safety/check-ins" style={linkButtonStyle}>
                My check-ins
              </Link>
              <Link to="/me/safety/consent" style={linkButtonStyle}>
                My consent
              </Link>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            SOS, due check-ins, and a quick way to tell your supervisor you are not OK.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <Notice tone="warning" live>
              {error} Your obligations may be incomplete below.
            </Notice>
          ) : null}
          {coordConsent === false ? (
            <Notice tone="info">
              You have not consented to SOS location sharing. The SOS button still works; the alert
              is raised without a position.
            </Notice>
          ) : null}
          {coordConsent === null ? (
            <Notice tone="warning" live>
              Consent settings could not be read. Pressing SOS still raises the alert.
            </Notice>
          ) : null}
        </div>
      }
      table={
        <div style={contentStyle}>
          <section style={sosSectionStyle}>
            <div style={sectionHeaderStyle}>
              <div style={toolbarTitleStyle}>
                <span style={toolbarEyebrowStyle}>Emergency</span>
                <strong>Call for help</strong>
              </div>
              <StatusPill
                label={raised ? "SOS active" : "Ready"}
                tone={raised ? "critical" : "success"}
              />
            </div>
            {raised === null ? (
              <div style={sosPressStyle}>
                <SosButton onPress={() => void press()} disabled={sosDenied} busy={pressing} />
                <span style={centerMutedStyle}>
                  One press raises the alert immediately. You get a short cancel window afterward.
                </span>
                {sosDenied ? (
                  <Notice tone="error" assertive>
                    The server refused this press: your membership is not field-eligible for SOS.
                  </Notice>
                ) : null}
                {sosError && !sosDenied ? (
                  <Notice tone="error" assertive>
                    {sosError}
                  </Notice>
                ) : null}
              </div>
            ) : (
              <div style={sectionStyle}>
                <Notice tone="error" assertive>
                  <strong>SOS raised</strong> at {dateTime(raised.postedAt)}. Alert{" "}
                  <code className="wx-data-md" style={inlineCodeStyle}>
                    {shortId(raised.id)}
                  </code>
                  .
                </Notice>
                <AcknowledgementNotice raised={raised} />
                {cancelState === null ? (
                  <CancelCountdown
                    secondsLeft={secondsLeft}
                    onCancel={() => void cancel()}
                    biometricRequired={false}
                    busy={pressing}
                  />
                ) : cancelState === "cancelled_in_window" ? (
                  <Notice tone="success" assertive>
                    Cancelled inside the window. The press and cancel both stay on the record.
                  </Notice>
                ) : (
                  <Notice tone="error" assertive>
                    The cancel was not accepted and the alert is still going.
                  </Notice>
                )}
                {raised.warningsSurfaced.length > 0 ? (
                  <Notice tone="warning" live>
                    {raised.warningsSurfaced.map((warning) => warning.message).join(" ")}
                  </Notice>
                ) : null}
                {sosError ? (
                  <Notice tone="error" assertive>
                    {sosError}
                  </Notice>
                ) : null}
                <Link to={`/safety/sos/${raised.id}`} style={textLinkStyle}>
                  Open this alert's record
                </Link>
              </div>
            )}
          </section>

          <section style={sectionStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Due now</span>
              <strong>Check-ins you owe</strong>
            </div>
            {obligations.length === 0 ? (
              <span style={secondaryTextStyle}>
                Nothing outstanding{day ? ` as of ${dateTime(day.asOf)}` : ""}.
              </span>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr style={headerRowStyle}>
                    <th style={{ ...thStyle, width: "21%" }}>Expected</th>
                    <th style={{ ...thStyle, width: "17%" }}>Kind</th>
                    <th style={{ ...thStyle, width: "18%" }}>Visit</th>
                    <th style={{ ...thStyle, width: "16%" }}>State</th>
                    <th style={{ ...thStyle, width: "28%", textAlign: "right" }}>Answer</th>
                  </tr>
                </thead>
                <tbody>
                  {obligations.map((obligation) => (
                    <tr key={obligation.scheduleId} style={rowStyle}>
                      <td style={tdStyle}>{dateTime(obligation.expectedAt)}</td>
                      <td style={tdStyle}>{humanize(obligation.kind)}</td>
                      <td style={tdMonoStyle}>
                        {obligation.visitId ? shortId(obligation.visitId) : "-"}
                      </td>
                      <td style={tdStyle}>
                        <StatusPill
                          label={humanize(obligation.state)}
                          tone={
                            obligation.state === "escalated"
                              ? "critical"
                              : obligation.state === "overdue"
                                ? "error"
                                : "progress"
                          }
                        />
                      </td>
                      <td style={{ ...tdStyle, textAlign: "right" }}>
                        <button
                          type="button"
                          onClick={() =>
                            void postCheckIn({
                              kind: obligation.kind,
                              status: "ok",
                              scheduleId: obligation.scheduleId,
                              ...(obligation.visitId ? { visitId: obligation.visitId } : {}),
                            })
                          }
                          disabled={posting}
                          style={posting ? disabledButtonStyle : primaryButtonStyle}
                        >
                          I'm OK
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section style={sectionStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Ad hoc</span>
              <strong>Check in now</strong>
            </div>
            <div style={formGridStyle}>
              <SelectField
                label="How are you?"
                value={status}
                options={[
                  { value: "ok", label: checkInStatusLabel("ok") },
                  { value: "concerned_continue", label: checkInStatusLabel("concerned_continue") },
                  { value: "concerned_stop", label: checkInStatusLabel("concerned_stop") },
                ]}
                onChange={setStatus}
              />
              <SelectField
                label="Kind"
                value={kind}
                options={AD_HOC_CHECK_IN_KINDS.map((value) => ({
                  value,
                  label: humanize(value),
                }))}
                onChange={setKind}
              />
            </div>
            {noteOwed ? (
              <TextAreaField
                label="What is worrying you?"
                value={note}
                onChange={setNote}
                rows={4}
                minChars={CONCERN_NOTE_MIN_CHARS}
                hint="Your supervisor reads this."
              />
            ) : null}
            {status === "concerned_stop" ? (
              <Notice tone="warning">
                Choosing {checkInStatusLabel("concerned_stop")} starts a callback clock on your
                supervisor's side.
              </Notice>
            ) : null}
            <div>
              <button
                type="button"
                onClick={() =>
                  void postCheckIn({
                    kind: kind as SafetyCheckInKind,
                    status: status as SafetyCheckInStatus,
                    ...(noteOwed ? { concernNote: note } : {}),
                  })
                }
                disabled={posting || !canPost}
                style={posting || !canPost ? disabledButtonStyle : primaryButtonStyle}
              >
                {posting ? "Sending..." : "Post check-in"}
              </button>
            </div>
            {postWarnings && postWarnings.length > 0 ? (
              <Notice tone="warning" live>
                Recorded. {postWarnings.map((warning) => warning.message).join(" ")}
              </Notice>
            ) : postWarnings ? (
              <Notice tone="success" live>
                Recorded.
              </Notice>
            ) : null}
            {postError ? (
              <Notice tone="error" assertive>
                {postError}
              </Notice>
            ) : null}
          </section>

          <div role="note" style={noteStyle}>
            <StatusPill label="Web limits" tone="neutral" />
            <span>
              This page cannot dial a supervisor number, queue an offline SOS, or verify biometrics;
              those require native-shell capabilities or backend data M20 does not expose here.
            </span>
          </div>
        </div>
      }
      fullPageScroll
    />
  );
}

function AcknowledgementNotice({ raised }: { raised: RaiseSosResult }): JSX.Element {
  if (raised.acknowledgersDispatched === null) {
    return (
      <Notice tone="error" assertive>
        We could not work out who to page. Ring your agency emergency line now, and 911 for
        immediate danger.
      </Notice>
    );
  }
  if (raised.acknowledgersDispatched === 0) {
    return (
      <Notice tone="error" assertive>
        Nobody is subscribed to be paged for you. Your alert is recorded and escalating.
      </Notice>
    );
  }
  return (
    <Notice tone="warning" assertive>
      {raised.acknowledgersDispatched}{" "}
      {raised.acknowledgersDispatched === 1 ? "person was" : "people were"} paged.
    </Notice>
  );
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
const sosSectionStyle = {
  ...sectionStyle,
  paddingBottom: "1rem",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
};
const sectionHeaderStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
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
const sosPressStyle = {
  display: "flex",
  flexDirection: "column" as const,
  alignItems: "center",
  gap: "0.75rem",
  padding: "1rem 0",
};
const centerMutedStyle = {
  maxWidth: "28rem",
  textAlign: "center" as const,
  color: "var(--color-on-surface-variant)",
  fontSize: "0.85rem",
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
const tdMonoStyle = {
  ...tdStyle,
  fontFamily: "var(--font-mono)",
};
const formGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(14rem, 1fr))",
  gap: "0.75rem",
};
const secondaryTextStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const inlineCodeStyle = {
  color: "var(--color-on-surface-variant)",
  background: "var(--color-surface-container)",
  borderRadius: "var(--radius-sm)",
  padding: "0.1rem 0.3rem",
  fontSize: "0.75rem",
};
const textLinkStyle = {
  color: "var(--color-primary)",
  fontSize: "0.85rem",
  fontWeight: 600,
  textDecoration: "none",
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
