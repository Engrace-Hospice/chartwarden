// apps/web/src/modules/20-field-safety — §5.2 "MY SAFETY" (`/me/safety`, Track B / ADR-0030).
//
// The clinician's own surface, and the only place on the platform where `safety.sos.raise` and
// `safety.check_in.create` can be spent. §5.2 makes this the mobile centre of gravity: the SOS control,
// the D5 cancel window, the check-in obligations due right now, and the ad-hoc "I have a concern" card.
//
// ── THE PRESS NEVER REFUSES, AND EVERY BRANCH HERE PRESERVES THAT ────────────────────────────────────
//
// S13 / M20-F16: a clinician who declined location consent still presses the button and the alert still
// fans out. So:
//
//   • no coordinate is REQUIRED — the request body omits it rather than the button refusing;
//   • a browser geolocation prompt that is denied, times out, or is unavailable does NOT block the press.
//     The position attempt has its own short deadline and the press goes without it;
//   • the button is disabled only when the SERVER has said the membership may not raise (a 403 on a
//     previous attempt), never for want of consent, a coordinate, or a device attestation.
//
// The press also sends NO `Idempotency-Key` — §4.1's Idempotent column says `no` and §2.6 / M20-F10 say
// why: every press is a separate call for help, and collapsing two onto one alert is the suppression S13
// forbids. That is enforced in `safety-api.ts`; this screen simply never adds one back.
//
// ── `acknowledgersDispatched` IS THREE-VALUED AND THE COPY IS THREE-WAY ──────────────────────────────
//
//   n > 0   → "n people were paged".
//   n === 0 → "the resolver answered and nobody is subscribed" — a real, terrible answer worth showing.
//   null    → "we could not ask at all". This is the M20-F01 degraded path, and it is the ONLY branch
//             that tells her to dial instead of waiting.
//
// ── D15's `tel:` FALLBACK IS DESCRIBED, NOT DIALLED, AND THAT IS A REAL GAP ──────────────────────────
//
// D15 wants a one-tap dial to the on-duty supervisor's number, cached at app-open. M20 publishes no route
// that returns any phone number — §8.2 keeps numbers off every DTO in the module, and §9.5 explicitly
// forbids falling back to a hard-coded one. A `tel:` link here would therefore have to invent a number.
// The degraded branch tells her to ring her agency's own emergency line and to call 911 for immediate
// danger, which is true, and does not put a fabricated number under her thumb at the worst moment.
import { LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
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
  Card,
  CheckInStatusPill,
  Notice,
  SelectField,
  SosButton,
  TextAreaField,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  linkStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  th,
} from "./safety-ui";

/** How long the browser is given to produce a position before the press goes without one. Short by
 *  design: S13's whole point is that nothing between the tap and the fan-out may block. */
const GEO_TIMEOUT_MS = 3000;

/** Ask the browser for a position, and RESOLVE `null` on every failure path — denial, timeout, no API.
 *  Never rejects: a rejected promise here would be one more thing between the tap and the alert. */
async function tryPosition(): Promise<
  { latitude: number; longitude: number; accuracyM: number } | null
> {
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: { latitude: number; longitude: number; accuracyM: number } | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const timer = setTimeout(() => done(null), GEO_TIMEOUT_MS);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        clearTimeout(timer);
        done({
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracyM: Math.max(0, Math.round(pos.coords.accuracy)),
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

  // the press
  const [pressing, setPressing] = useState(false);
  const [raised, setRaised] = useState<RaiseSosResult | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [cancelState, setCancelState] = useState<string | null>(null);
  const [sosDenied, setSosDenied] = useState(false);
  const [sosError, setSosError] = useState<string | null>(null);

  // the ad-hoc check-in
  const [kind, setKind] = useState(DEFAULT_CHECK_IN_KIND);
  const [status, setStatus] = useState(DEFAULT_CHECK_IN_STATUS);
  const [note, setNote] = useState("");
  const [posting, setPosting] = useState(false);
  const [postWarnings, setPostWarnings] = useState<SafetyWarning[] | null>(null);
  const [postError, setPostError] = useState<string | null>(null);

  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [d, c] = await Promise.all([getMyDay(client, { limit: 25 }), getConsents(client)]);
    setDay(d.day);
    // Three-valued on purpose: `null` means the consent surface did not answer, and the SOS card must not
    // claim "you have not consented" on the strength of a failed read.
    setCoordConsent(
      c.surface
        ? c.surface.consents.some((x) => x.purpose === "sos_coordinates" && x.status === "granted")
        : null,
    );
    setError(d.error ? errorMessage(d.error, "Your safety day could not be read.") : null);
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  // The D5 window ticks locally off the SERVER's `cancelWindowExpiresAt`, never off a client-started
  // stopwatch: the server decided when the window closes and its clock is the one the cancel route reads.
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
    // The position attempt is bounded and its failure is silent — see `tryPosition`.
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
          "The alert could not be raised. Do not wait on this screen — ring your agency's emergency line, and 911 if you are in danger now.",
        ),
      );
      return;
    }
    setRaised(res.result);
  }, [client]);

  const cancel = useCallback(async () => {
    if (!raised) return;
    // No biometric token is sent: the device verdict D5 wants is a native-shell capability (ADR-0035),
    // and fabricating a token from the web would be asserting a check that never happened. On a tenant
    // that requires one the server records `cancel_attempted_but_rejected` and the alert PROCEEDS —
    // which is the correct outcome, and the copy below says so before she taps.
    const res = await cancelSos(client, raised.id, {});
    if (res.error || !res.result) {
      setSosError(errorMessage(res.error, "The cancel did not go through. The alert is still open."));
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

  if (loading) return <LoadingSpinner />;

  const obligations = (day?.obligations ?? []).filter(
    (o) => o.state === "proposed" || o.state === "overdue" || o.state === "escalated",
  );
  const noteOwed = status !== "ok";
  const canPost = !noteOwed || meetsMinChars(note, CONCERN_NOTE_MIN_CHARS);

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>My safety</span>}
        breadcrumb="Field safety"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/me/safety/check-ins" style={ghostButtonStyle}>
              My check-ins
            </Link>
            <Link to="/me/safety/consent" style={ghostButtonStyle}>
              My consent
            </Link>
          </div>
        }
      />

      {/* ── the SOS control ────────────────────────────────────────────────────────────────────────── */}
      <Card title="Call for help">
        {raised === null ? (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: t.space3,
              padding: t.space4,
            }}
          >
            <SosButton onPress={() => void press()} disabled={sosDenied} busy={pressing} />
            <span style={{ ...mutedStyle, textAlign: "center", maxWidth: "28rem" }}>
              One press raises the alert immediately. You get {""}
              <strong>a few seconds to take it back</strong> and nothing else stands between the press and
              the people who will be paged — not consent, not a location, not your device.
            </span>
            {sosDenied ? (
              <Notice tone="error" assertive>
                The server refused this press: your membership is not field-eligible for SOS. That is a
                configuration your agency controls — ask your supervisor. It is not a fault on this device
                and pressing again will not change it.
              </Notice>
            ) : null}
            {sosError && !sosDenied ? (
              <Notice tone="error" assertive>
                {sosError}
              </Notice>
            ) : null}
            {coordConsent === false ? (
              <Notice tone="info">
                You have <strong>not</strong> consented to sharing your location with an SOS. The button
                still works and the alert still goes — the people paged will simply be told there is no
                position. You can change that on your consent page at any time.
              </Notice>
            ) : null}
            {coordConsent === null ? (
              <Notice tone="warning" live>
                Your consent settings could not be read just now. That changes nothing about the button:
                pressing it raises the alert either way.
              </Notice>
            ) : null}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
            <Notice tone="error" assertive>
              <strong>SOS RAISED</strong> at {dateTime(raised.postedAt)}. Alert{" "}
              <span style={{ fontFamily: t.fontMono }}>{shortId(raised.id)}</span>.
            </Notice>

            {/* The three-way branch — see the module header. */}
            {raised.acknowledgersDispatched === null ? (
              <Notice tone="error" assertive>
                <strong>We could not work out who to page.</strong> Your alert is recorded and the
                escalation clock is running, but the system could not reach the service that resolves your
                supervisors — so nobody may have been notified. Do not wait on this screen: ring your
                agency's emergency line now, and 911 if you are in immediate danger.
              </Notice>
            ) : raised.acknowledgersDispatched === 0 ? (
              <Notice tone="error" assertive>
                <strong>Nobody is subscribed to be paged for you.</strong> The system asked and got an
                empty answer — this is a configuration gap, not an outage. Your alert is recorded and
                escalating, but ring your agency's emergency line as well, and 911 if you are in immediate
                danger.
              </Notice>
            ) : (
              <Notice tone="warning" assertive>
                <strong>
                  {raised.acknowledgersDispatched}{" "}
                  {raised.acknowledgersDispatched === 1 ? "person was" : "people were"} paged.
                </strong>{" "}
                That is how many the system resolved and handed to messaging — delivery is out of this
                screen's sight, so it is not a promise that a phone rang. This page will show an
                acknowledgment when somebody signs on.
              </Notice>
            )}

            {cancelState === null ? (
              <CancelCountdown
                secondsLeft={secondsLeft}
                onCancel={() => void cancel()}
                biometricRequired={false}
                busy={pressing}
              />
            ) : cancelState === "cancelled_in_window" ? (
              <Notice tone="success" assertive>
                <strong>Cancelled.</strong> You withdrew the alert inside the window and nobody is being
                escalated. The press and the cancel are both on the record — that is normal and nobody has
                to explain it.
              </Notice>
            ) : (
              <Notice tone="error" assertive>
                <strong>The cancel was not accepted, and the alert is still going.</strong> Your agency
                requires a check this device could not make, so the attempt was recorded as a rejected
                cancel and the escalation continues. That is deliberate: it is what stops a phone taken
                from you being used to silence your call for help. If you are safe, tell the responder when
                they reach you.
              </Notice>
            )}

            {raised.warningsSurfaced.length > 0 ? (
              <Notice tone="warning" live>
                {raised.warningsSurfaced.map((w) => w.message).join(" ")}
              </Notice>
            ) : null}

            {sosError ? (
              <Notice tone="error" assertive>
                {sosError}
              </Notice>
            ) : null}

            <Link to={`/safety/sos/${raised.id}`} style={linkStyle}>
              Open this alert's record
            </Link>
            <span style={mutedStyle}>
              A responder must acknowledge and then resolve this alert. It does not close by itself and it
              does not time out — if nobody answers, it keeps climbing.
            </span>
          </div>
        )}
      </Card>

      {/* ── the obligations due now ────────────────────────────────────────────────────────────────── */}
      <Card title="Check-ins you owe">
        {error ? (
          <Notice tone="warning" live>
            {error} Your obligations may be incomplete below — that is a failed read, not an empty list.
          </Notice>
        ) : null}
        {obligations.length === 0 ? (
          <span style={mutedStyle}>
            Nothing outstanding{day ? ` as of ${dateTime(day.asOf)}` : ""}. Prompts appear here as your
            visits reach their pre-visit, mid-visit and post-visit windows.
          </span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>When</th>
                <th style={th}>Which</th>
                <th style={th}>Visit</th>
                <th style={th}>State</th>
                <th style={th}>Answer</th>
              </tr>
            </thead>
            <tbody>
              {obligations.map((o) => (
                <tr key={o.scheduleId} style={rowLine}>
                  <td style={td}>{dateTime(o.expectedAt)}</td>
                  <td style={td}>{humanize(o.kind)}</td>
                  <td style={td}>
                    {o.visitId ? (
                      <span style={{ fontFamily: t.fontMono }}>{shortId(o.visitId)}</span>
                    ) : (
                      <span style={mutedStyle}>—</span>
                    )}
                  </td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(o.state)}
                      tone={
                        o.state === "escalated"
                          ? "critical"
                          : o.state === "overdue"
                            ? "error"
                            : "progress"
                      }
                    />
                  </td>
                  <td style={td}>
                    <button
                      type="button"
                      onClick={() =>
                        void postCheckIn({
                          kind: o.kind,
                          status: "ok",
                          scheduleId: o.scheduleId,
                          ...(o.visitId ? { visitId: o.visitId } : {}),
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
        <span style={mutedStyle}>
          Answering here closes the obligation. If you are not OK, use the card below instead — a
          non-"OK" answer needs a note, and it is the note somebody acts on.
        </span>
      </Card>

      {/* ── the ad-hoc card ────────────────────────────────────────────────────────────────────────── */}
      <Card title="Check in now">
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
          options={AD_HOC_CHECK_IN_KINDS.map((v) => ({ value: v, label: humanize(v) }))}
          onChange={setKind}
        />
        <span style={mutedStyle}>
          Only the two unprompted kinds are offered here. A pre-visit, mid-visit or post-visit check-in
          belongs to a specific visit and is answered from its row above — posting one loose would be
          refused, because the record has to say which visit it attests to.
        </span>
        {noteOwed ? (
          <TextAreaField
            label="What is worrying you?"
            value={note}
            onChange={setNote}
            rows={4}
            minChars={CONCERN_NOTE_MIN_CHARS}
            hint="Your supervisor reads this. It is kept out of the change-log trail on purpose, so it is not copied around."
          />
        ) : null}
        {status === "concerned_stop" ? (
          <Notice tone="warning">
            Choosing <strong>{checkInStatusLabel("concerned_stop")}</strong> starts a callback clock on
            your supervisor's side. You do not have to justify stopping.
          </Notice>
        ) : null}
        <button
          type="button"
          onClick={() =>
            void postCheckIn({
              // `kind`/`status` are always one of the closed vocabularies the SelectFields on this
              // screen offer.
              kind: kind as SafetyCheckInKind,
              status: status as SafetyCheckInStatus,
              ...(noteOwed ? { concernNote: note } : {}),
            })
          }
          disabled={posting || !canPost}
          style={posting || !canPost ? disabledButtonStyle : primaryButtonStyle}
        >
          {posting ? "Sending…" : "Post check-in"}
        </button>
        {postWarnings && postWarnings.length > 0 ? (
          <Notice tone="warning" live>
            Recorded. {postWarnings.map((w) => w.message).join(" ")}
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
      </Card>

      <Card title="What this web page cannot do">
        <span style={mutedStyle}>
          <strong>It cannot dial for you.</strong> D15 wants one tap to your on-duty supervisor's number
          when the network is degraded. No M20 route returns a phone number — §8.2 keeps numbers off every
          DTO in the module and §9.5 forbids falling back to a hard-coded one — so a dial button here
          would have to invent a number, which is worse than not having one. Use your agency's own
          emergency line, and 911 for immediate danger.
        </span>
        <span style={mutedStyle}>
          <strong>It cannot capture a press while you are offline.</strong> D15's offline queue is an
          encrypted store in the native shell (ADR-0035); a browser tab has nowhere to put it and no
          background sync to drain it. If this page cannot reach the server, the press does not exist —
          the message above says so rather than showing a hopeful spinner.
        </span>
        <span style={mutedStyle}>
          <strong>It cannot verify your face or fingerprint.</strong> The D5 biometric cancel is a device
          capability. Cancelling from here sends no verdict, so on an agency that requires one your cancel
          is recorded as attempted-and-rejected and the alert continues — which is the safe direction of
          that failure, and is spelled out above the button rather than discovered afterwards.
        </span>
      </Card>
    </div>
  );
}
