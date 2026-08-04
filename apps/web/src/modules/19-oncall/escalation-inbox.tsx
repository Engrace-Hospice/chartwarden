// apps/web/src/modules/19-oncall — S19.4 ESCALATION INBOX (`/triage/escalations`, §5.1, Track B /
// ADR-0030).
//
// THE INBOX IS SORTED BY MANDATORY, THEN TIER, THEN AGE. §5.1 says "severity-sorted"; the sort below spells
// out what severity means here — a platform-floor mandatory row outranks everything (no tenant policy can
// suppress it and only an explicit write by the escalated party clears it), then the ladder rung, then
// minutes open. Sorting by age alone would put a 40-minute medical-director page below a 90-minute
// RN-supervisor one.
//
// `minutesOpen` IS THE SERVER'S, NOT A CLOCK THIS SCREEN RUNS. §4.1 returns it computed, which matters
// because the SLA the §4.8 worker enforces and the number a supervisor reads must be the same number; a
// browser with a skewed clock would otherwise disagree with the alert that already fired.
//
// §5.1 asks for "SLA timers per `triage_escalation.acknowledged_within_seconds` SLA target". That COLUMN
// does not exist — the per-severity callback SLA lives in `tenant_oncall_policy.callback_sla_per_severity`
// as tenant-shaped JSON, and there is no route that resolves it to a per-row target. So the age is shown
// as an honest elapsed time rather than as a percentage of a target this screen would have to invent. The
// policy screen renders the tenant's configured SLA object beside it.
//
// TWO WRITES LIVE HERE AND NOWHERE ELSE. Acknowledge is the write §7.2 waits on: until it lands the call
// takes no disposition but the hand-off. Resolve is the ONLY place a MANDATORY row can reach `resolved`
// (§2.2.4) — a call close may auto-resolve an acknowledged non-mandatory row, but the four D7 protocols'
// rows need this explicit write, because the whole point is that the agency can prove a named human
// answered.
import { EmptyState, LoadingSpinner, PageHeader, StatusPill, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import {
  type EscalationInboxItem,
  type EscalationTier,
  acknowledgeEscalation,
  errorMessage,
  listEscalations,
  resolveEscalation,
} from "./oncall-api";
import {
  ESCALATION_STATE_TONE,
  ESCALATION_TIERS,
  dateTime,
  durationLabel,
  humanize,
  shortId,
  tierLabel,
  toneOf,
} from "./oncall-status";
import {
  CallStatePill,
  Card,
  CountGrid,
  FilterRow,
  Modal,
  Notice,
  SelectField,
  TextAreaField,
  TierPill,
  alertStyle,
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
  tdNum,
  th,
  thNum,
} from "./oncall-ui";

const INBOX_PAGE = 100;
/** §4.1 row 18 — the resolution text floor. Mirrored so the button explains itself before the round trip. */
const RESOLUTION_MIN_CHARS = 30;

const TIER_FILTERS = [{ value: "", label: "every tier" }].concat(
  ESCALATION_TIERS.map((x) => ({ value: x, label: tierLabel(x) })),
);
const OPEN_FILTERS = [
  { value: "open", label: "outstanding (default)" },
  { value: "all", label: "including resolved" },
];

/** Mandatory first, then ladder rung (descending), then age. */
function inboxRank(a: EscalationInboxItem, b: EscalationInboxItem): number {
  if (a.mandatory !== b.mandatory) return a.mandatory ? -1 : 1;
  const rank = (x: EscalationInboxItem) => ESCALATION_TIERS.indexOf(x.tier);
  if (rank(a) !== rank(b)) return rank(b) - rank(a);
  return b.minutesOpen - a.minutesOpen;
}

export function EscalationInboxScreen(): JSX.Element {
  const client = useApiClient();
  const [tier, setTier] = useState("");
  const [scope, setScope] = useState("open");
  const [rows, setRows] = useState<EscalationInboxItem[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<EscalationInboxItem | null>(null);
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await listEscalations(client, {
      limit: INBOX_PAGE,
      // `tier` is always "" (every tier) or one of ESCALATION_TIERS — the SelectField below offers no
      // other value.
      ...(tier ? { tier: tier as EscalationTier } : {}),
      ...(scope === "all" ? { openOnly: false } : {}),
    });
    if (res.error) {
      setError(errorMessage(res.error, "The escalation inbox could not be loaded."));
      setLoading(false);
      return;
    }
    setRows(res.page?.data ?? []);
    setTruncated(res.page?.has_more ?? false);
    setLoading(false);
  }, [client, tier, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState title="Unavailable" description={error} />;

  const sorted = [...rows].sort(inboxRank);
  const unacknowledged = rows.filter((r) => r.state === "open").length;
  const mandatoryOpen = rows.filter((r) => r.mandatory && r.state !== "resolved").length;
  const overAnHour = rows.filter((r) => r.state === "open" && r.minutesOpen >= 60).length;

  async function ack(row: EscalationInboxItem): Promise<void> {
    setBusy(true);
    setActionError(null);
    const res = await acknowledgeEscalation(client, row.id, row.version);
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, "That page could not be acknowledged."));
      return;
    }
    await load();
  }

  async function commitResolve(): Promise<void> {
    if (!resolving) return;
    setBusy(true);
    setActionError(null);
    const res = await resolveEscalation(client, resolving.id, resolving.version, { resolution });
    setBusy(false);
    if (res.error) {
      setActionError(errorMessage(res.error, "That page could not be resolved."));
      return;
    }
    setResolving(null);
    setResolution("");
    await load();
  }

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Escalation inbox</span>}
        breadcrumb="On-call triage"
        actions={
          <Link to="/triage" style={ghostButtonStyle}>
            Triage queue
          </Link>
        }
      />

      {mandatoryOpen > 0 ? (
        <Notice tone="error" assertive>
          {mandatoryOpen} platform-floor mandatory escalation
          {mandatoryOpen === 1 ? " is" : "s are"} outstanding. Each holds its call's disposition and
          can be cleared only by an explicit resolution written by the escalated party — closing the
          call will not clear it.
        </Notice>
      ) : null}

      {truncated ? (
        <Notice tone="info">
          More than {INBOX_PAGE} escalations match. The counts below count the page fetched, not the
          whole tenant — §4.1.1 publishes no total on a PHI list.
        </Notice>
      ) : null}

      <Card title="Outstanding">
        <CountGrid
          entries={[
            { label: "On this page", value: rows.length },
            {
              label: "Unacknowledged",
              value: unacknowledged,
              tone: unacknowledged > 0 ? "error" : undefined,
            },
            {
              label: "Mandatory, open",
              value: mandatoryOpen,
              tone: mandatoryOpen > 0 ? "error" : undefined,
            },
            {
              label: "Open over an hour",
              value: overAnHour,
              tone: overAnHour > 0 ? "error" : undefined,
            },
          ]}
        />
        <span style={mutedStyle}>
          Age is elapsed minutes as the SERVER computed them, not a browser clock and not a
          percentage of an SLA target: the per-severity callback SLA lives on the tenant policy as
          tenant-shaped JSON and no route resolves it to a per-row target, so a "% of SLA" here
          would be invented.
        </span>
      </Card>

      <FilterRow>
        <SelectField label="Tier" value={tier} options={TIER_FILTERS} onChange={setTier} />
        <SelectField label="Show" value={scope} options={OPEN_FILTERS} onChange={setScope} />
      </FilterRow>

      <Card title="Pages">
        {sorted.length === 0 ? (
          <span style={mutedStyle}>
            Nothing is outstanding in your tier band. An empty inbox is the ordinary night — and it
            is not the same as "you are on no tier": the server narrows this list to the tiers you
            sit on, and a page addressed to a colleague is simply absent.
          </span>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={th}>Tier</th>
                <th style={th}>Trigger</th>
                <th style={th}>State</th>
                <th style={th}>Call</th>
                <th style={th}>Call state</th>
                <th style={th}>Patient</th>
                <th style={thNum}>Open</th>
                <th style={th}>Raised</th>
                <th style={th}>Action</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.id} style={rowLine}>
                  <td style={td}>
                    <TierPill tier={r.tier} />
                    {r.mandatory ? (
                      <>
                        <br />
                        <StatusPill label="Platform floor" tone="critical" />
                      </>
                    ) : null}
                  </td>
                  <td style={td}>{humanize(r.triggerKind)}</td>
                  <td style={td}>
                    <StatusPill
                      label={humanize(r.state)}
                      tone={toneOf(ESCALATION_STATE_TONE, r.state)}
                    />
                  </td>
                  <td style={td}>
                    <Link to={`/triage/calls/${r.triageCallId}`} style={linkStyle}>
                      {shortId(r.triageCallId)}
                    </Link>
                  </td>
                  <td style={td}>
                    <CallStatePill state={r.callState} />
                  </td>
                  <td style={td}>{r.patientId ? shortId(r.patientId) : "not identified"}</td>
                  <td style={tdNum}>{durationLabel(r.minutesOpen)}</td>
                  <td style={td}>{dateTime(r.escalatedAt)}</td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
                      {r.state === "open" ? (
                        <button
                          type="button"
                          style={busy ? disabledButtonStyle : primaryButtonStyle}
                          disabled={busy}
                          onClick={() => void ack(r)}
                        >
                          Acknowledge
                        </button>
                      ) : null}
                      {r.state === "acknowledged" ? (
                        <button
                          type="button"
                          style={busy ? disabledButtonStyle : ghostButtonStyle}
                          disabled={busy}
                          onClick={() => {
                            setResolving(r);
                            setResolution("");
                          }}
                        >
                          Resolve
                        </button>
                      ) : null}
                      {r.state === "resolved" ? <span style={mutedStyle}>closed</span> : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <span style={mutedStyle}>
          A refusal on either action reads "not yours" rather than 404, deliberately: an escalation
          id discloses nothing to somebody who already holds the inbox permission, and a 404 would
          send a supervisor hunting for a page that is sitting in a colleague's queue.
        </span>
      </Card>

      {actionError ? <p style={alertStyle}>{actionError}</p> : null}

      {resolving ? (
        <Modal
          title={`Resolve — ${tierLabel(resolving.tier)}`}
          onClose={() => setResolving(null)}
          footer={
            <button
              type="button"
              disabled={busy || resolution.trim().length < RESOLUTION_MIN_CHARS}
              style={
                busy || resolution.trim().length < RESOLUTION_MIN_CHARS
                  ? disabledButtonStyle
                  : primaryButtonStyle
              }
              onClick={() => void commitResolve()}
            >
              Record the resolution
            </button>
          }
        >
          {resolving.mandatory ? (
            <Notice tone="warning">
              This is a platform-floor mandatory escalation. This write is the ONLY way it reaches
              `resolved`, and it is what the agency shows a surveyor to prove a named human
              answered.
            </Notice>
          ) : null}
          <TextAreaField
            label={`What was decided (≥ ${RESOLUTION_MIN_CHARS} chars)`}
            value={resolution}
            onChange={setResolution}
            rows={5}
            hint="Your own account, in your words. The text is audit-denylisted, so it is read off the row under access control and never out of a log."
          />
        </Modal>
      ) : null}
    </div>
  );
}
