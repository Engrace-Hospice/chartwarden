// apps/web/src/modules/20-field-safety — §5.1 "TENANT POLICY EDITOR" (`/safety/policy`, Track B/ADR-0030).
//
// The knobs that decide how often a clinician is asked "are you OK", how long she has to answer before
// somebody is paged, how long the D5 cancel window is, and whether her location may be streamed at all.
//
// ── TIGHTEN-ONLY IS A BAND PER KNOB, NOT ONE COMPARISON, AND THE SCREEN RENDERS THE BANDS ────────────
//
// D4's rule reads as "a tenant may tighten, never loosen", but "tighter" runs in opposite directions
// depending on the knob: a SHORTER supervisor-alert threshold pages sooner (tighter), a SHORTER mid-visit
// cadence asks more often (tighter), and a LONGER cancel window gives more chance to undo an accidental
// press (also tighter). So the platform expresses it as a BAND per knob — `SAFETY_POLICY_BOUNDS`, mirrored
// into §3.3's CHECK constraints — and this editor shows each band beside its field rather than implying a
// direction. The SERVER is the authority: `assertPolicyEditValid` returns a 422 naming the knob and its
// band, and it also enforces the ladder invariant (reminder ≤ supervisor ≤ escalation ≤ SOS-equivalent)
// that no per-field range can express.
//
// ── THE `asOf` READ IS NOT A CURIOSITY ──────────────────────────────────────────────────────────────
//
// §2.2.4's replay arm exists because a 2031 review of a 2026 incident must read the 2026 thresholds.
// Reading today's would turn a policy that TIGHTENED into a regression that never happened. The date box
// is therefore a first-class control on this page, and switching it puts the editor into a read-only
// historical view — because editing a version you time-travelled to would write today's row with
// yesterday's numbers.
import { EmptyState, LoadingSpinner, PageHeader, t, useApiClient } from "@wardenx/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Link } from "react-router-dom";
import { type SafetyPolicyView, errorMessage, getPolicy, patchPolicy } from "./safety-api";
import {
  INCIDENT_CATEGORIES,
  POLICY_EDIT_REASON_MIN_CHARS,
  SUBSCRIPTION_MODELS,
  dateTime,
  durationLabel,
  humanize,
  incidentCategoryLabel,
  meetsMinChars,
  secondsLabel,
  toInstant,
} from "./safety-status";
import {
  Card,
  CheckboxField,
  ChipMultiSelect,
  Field,
  FilterRow,
  Modal,
  Notice,
  SelectField,
  SummaryGrid,
  TextAreaField,
  TextField,
  columnStyle,
  disabledButtonStyle,
  ghostButtonStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  rowLine,
  tableStyle,
  td,
  tdNum,
  th,
  thNum,
} from "./safety-ui";

/**
 * The §3.3 CHECK bands, mirrored for DISPLAY.
 *
 * Each pair is copied from migration 0110's `m20_spv_*_band` constraints, which are themselves the
 * `SAFETY_POLICY_BOUNDS` constant. They are shown, never enforced here: a client-side range that
 * disagreed with the database would refuse an edit the platform allows, and one that agreed would be a
 * second copy to keep in step. The server names the knob and the band in its 422.
 */
const BANDS: Record<string, [number, number]> = {
  midVisitCadenceMinutes: [30, 120],
  midVisitMinVisitDurationMinutes: [15, 240],
  preVisitWindowMinutes: [5, 60],
  postVisitWindowMinutes: [1, 30],
  gentleReminderMinutes: [1, 5],
  supervisorAlertMinutes: [1, 15],
  escalationMinutes: [1, 30],
  sosEquivalentMinutes: [1, 60],
  sosCancelWindowSeconds: [5, 30],
  sosContinuousLocationSampleSeconds: [10, 300],
  sosContinuousLocationMaxDurationHours: [1, 4],
  sosTier1SlaSeconds: [15, 60],
  sosTier2SlaSeconds: [30, 120],
  sosTier3SlaSeconds: [60, 300],
};

/** The knobs, grouped the way a DON reads them rather than the way the row stores them. */
const CADENCE_KNOBS = [
  ["midVisitCadenceMinutes", "Mid-visit cadence", "minutes"],
  ["midVisitMinVisitDurationMinutes", "Shortest visit that gets a mid-visit prompt", "minutes"],
  ["preVisitWindowMinutes", "Pre-visit card appears before the visit", "minutes"],
  ["postVisitWindowMinutes", "Post-visit window after check-out", "minutes"],
] as const;

const OVERDUE_KNOBS = [
  ["gentleReminderMinutes", "Rung 1 — gentle reminder to her", "minutes late"],
  ["supervisorAlertMinutes", "Rung 2 — page the supervisor", "minutes late"],
  ["escalationMinutes", "Rung 3 — escalate", "minutes late"],
  ["sosEquivalentMinutes", "Rung 4 — treat as an SOS", "minutes late"],
] as const;

const SOS_KNOBS = [
  ["sosCancelWindowSeconds", "D5 cancel window", "seconds"],
  ["sosTier1SlaSeconds", "Tier-1 SLA before escalating", "seconds"],
  ["sosTier2SlaSeconds", "Tier-2 SLA", "seconds"],
  ["sosTier3SlaSeconds", "Tier-3 SLA", "seconds"],
  ["sosContinuousLocationSampleSeconds", "Location sample interval", "seconds"],
  ["sosContinuousLocationMaxDurationHours", "Location stream hard cap", "hours"],
] as const;

type KnobKey = keyof typeof BANDS;

export function SafetyPolicyScreen(): JSX.Element {
  const client = useApiClient();
  const [policy, setPolicy] = useState<SafetyPolicyView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [asOf, setAsOf] = useState("");
  const [historical, setHistorical] = useState(false);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [biometric, setBiometric] = useState(true);
  const [streamEnabled, setStreamEnabled] = useState(false);
  const [model, setModel] = useState("location_scoped");
  const [autoFlag, setAutoFlag] = useState<string[]>([]);
  const [afterHoursStart, setAfterHoursStart] = useState("18");
  const [afterHoursEnd, setAfterHoursEnd] = useState("8");
  const [editReason, setEditReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState<string | null>(null);

  const load = useCallback(
    async (at?: string) => {
      setLoading(true);
      const res = await getPolicy(client, at);
      if (res.error || !res.policy) {
        setError(errorMessage(res.error, "The safety policy could not be read."));
        setPolicy(null);
      } else {
        setPolicy(res.policy);
        setError(null);
      }
      setLoading(false);
    },
    [client],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const openEditor = useCallback(() => {
    if (!policy) return;
    const next: Record<string, string> = {};
    for (const k of Object.keys(BANDS)) next[k] = String(policy[k as keyof SafetyPolicyView] ?? "");
    setDraft(next);
    setBiometric(policy.sosCancelRequiresBiometric);
    setStreamEnabled(policy.sosContinuousLocationEnabled);
    setModel(policy.subscriptionModel);
    setAutoFlag([...policy.oshaReportableAutoFlagCategories]);
    setAfterHoursStart(String(policy.afterHoursStartHour));
    setAfterHoursEnd(String(policy.afterHoursEndHour));
    setEditReason("");
    setModalError(null);
    setEditing(true);
  }, [policy]);

  const save = useCallback(async () => {
    if (!policy) return;
    setSaving(true);
    setModalError(null);
    const body: Record<string, unknown> = { editReason };
    for (const [k, raw] of Object.entries(draft)) {
      const n = Number(raw);
      // A knob left blank or unparseable is OMITTED rather than sent as 0 or NaN. §4.1's PATCH is
      // partial: an absent key keeps the current value, and a 0 would be a deliberate loosening the
      // server would then have to refuse on the DON's behalf.
      if (raw.trim() !== "" && Number.isFinite(n)) body[k] = Math.trunc(n);
    }
    body.sosCancelRequiresBiometric = biometric;
    body.sosContinuousLocationEnabled = streamEnabled;
    body.subscriptionModel = model;
    body.oshaReportableAutoFlagCategories = autoFlag;
    if (afterHoursStart.trim() !== "") body.afterHoursStartHour = Math.trunc(Number(afterHoursStart));
    if (afterHoursEnd.trim() !== "") body.afterHoursEndHour = Math.trunc(Number(afterHoursEnd));

    // The policy DTO carries no `version` column of its own — §2.5's optimistic guard on this route reads
    // the header when the caller has one. `null` means "no version to echo", which the route accepts for
    // the policy PATCH (it is not marked If-Match-required), and a concurrent edit is caught by the
    // version-chain rule server-side rather than by a number this screen never saw.
    const res = await patchPolicy(client, null, body as Record<string, unknown> & { editReason: string });
    setSaving(false);
    if (res.error) {
      setModalError(errorMessage(res.error, "The policy was not changed."));
      return;
    }
    setEditing(false);
    await load(historical && asOf ? toInstant(asOf) : undefined);
  }, [
    afterHoursEnd,
    afterHoursStart,
    asOf,
    autoFlag,
    biometric,
    client,
    draft,
    editReason,
    historical,
    load,
    model,
    policy,
    streamEnabled,
  ]);

  if (loading) return <LoadingSpinner />;
  if (!policy)
    return (
      <EmptyState
        title="Safety policy unavailable"
        description={error ?? "No policy answered for this organization."}
      />
    );

  const knobRow = (key: KnobKey, label: string, unit: string) => {
    const band = BANDS[key];
    const value = policy[key as keyof SafetyPolicyView] as number;
    return (
      <tr key={key} style={rowLine}>
        <td style={td}>{label}</td>
        <td style={tdNum}>{value}</td>
        <td style={td}>{unit}</td>
        <td style={tdNum}>
          {band ? `${band[0]}–${band[1]}` : "—"}
        </td>
        <td style={td}>
          {unit === "seconds"
            ? secondsLabel(value)
            : unit === "hours"
              ? durationLabel(value * 60)
              : durationLabel(value)}
        </td>
      </tr>
    );
  };

  return (
    <div style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Safety policy</span>}
        breadcrumb="Field safety"
        actions={
          <div style={{ display: "flex", gap: t.space2, flexWrap: "wrap" }}>
            <Link to="/safety" style={ghostButtonStyle}>
              Safety board
            </Link>
            <button
              type="button"
              onClick={openEditor}
              disabled={historical}
              style={historical ? disabledButtonStyle : primaryButtonStyle}
            >
              Edit policy
            </button>
          </div>
        }
      />

      {historical ? (
        <Notice tone="warning" live>
          <strong>Historical view.</strong> These are the thresholds that were in force at{" "}
          {dateTime(toInstant(asOf))} — version {policy.versionId}. Editing is disabled here on purpose:
          saving from a time-travelled view would write today's row with yesterday's numbers. Clear the
          date to come back to the policy actually in force.
        </Notice>
      ) : null}

      <Card title="Version in force">
        <SummaryGrid>
          <Field label="Version" value={policy.versionId} mono />
          <Field label="Effective from" value={dateTime(policy.effectiveFrom)} />
          <Field
            label="Effective to"
            value={policy.effectiveTo ? dateTime(policy.effectiveTo) : "Still in force"}
          />
          <Field label="Subscription model" value={humanize(policy.subscriptionModel)} />
          <Field
            label="After-hours window"
            value={`${String(policy.afterHoursStartHour).padStart(2, "0")}:00 → ${String(policy.afterHoursEndHour).padStart(2, "0")}:00`}
          />
          <Field
            label="Cancel needs a biometric"
            value={policy.sosCancelRequiresBiometric ? "Yes" : "No"}
          />
          <Field
            label="Continuous location during SOS"
            value={policy.sosContinuousLocationEnabled ? "Enabled by the agency" : "Off"}
          />
        </SummaryGrid>
        <FilterRow>
          <TextField
            label="Read the policy as it stood at"
            value={asOf}
            onChange={setAsOf}
            type="datetime-local"
          />
          <button
            type="button"
            onClick={() => {
              setHistorical(true);
              void load(toInstant(asOf));
            }}
            disabled={asOf.trim() === ""}
            style={asOf.trim() === "" ? disabledButtonStyle : ghostButtonStyle}
          >
            Time-travel
          </button>
          <button
            type="button"
            onClick={() => {
              setHistorical(false);
              setAsOf("");
              void load();
            }}
            style={ghostButtonStyle}
          >
            Back to current
          </button>
        </FilterRow>
        <span style={mutedStyle}>
          §2.2.4's replay arm. A review of a 2026 incident must read the 2026 thresholds — reading today's
          would turn a policy that tightened into a regression that never happened.
        </span>
      </Card>

      <Card title="Check-in cadence">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>Knob</th>
              <th style={thNum}>Value</th>
              <th style={th}>Unit</th>
              <th style={thNum}>Allowed band</th>
              <th style={th}>Reads as</th>
            </tr>
          </thead>
          <tbody>{CADENCE_KNOBS.map(([k, label, unit]) => knobRow(k, label, unit))}</tbody>
        </table>
      </Card>

      <Card title="Overdue ladder (D4)">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>Rung</th>
              <th style={thNum}>Value</th>
              <th style={th}>Unit</th>
              <th style={thNum}>Allowed band</th>
              <th style={th}>Reads as</th>
            </tr>
          </thead>
          <tbody>{OVERDUE_KNOBS.map(([k, label, unit]) => knobRow(k, label, unit))}</tbody>
        </table>
        <span style={mutedStyle}>
          The four rungs are an ORDER, not four independent numbers: the database refuses a policy where
          the reminder fires after the supervisor page, or the escalation after the SOS-equivalent. That
          invariant is not expressible as a per-field range, which is why the server checks the MERGED
          result rather than each box as you type it.
        </span>
      </Card>

      <Card title="SOS (D5 / D6)">
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={th}>Knob</th>
              <th style={thNum}>Value</th>
              <th style={th}>Unit</th>
              <th style={thNum}>Allowed band</th>
              <th style={th}>Reads as</th>
            </tr>
          </thead>
          <tbody>{SOS_KNOBS.map(([k, label, unit]) => knobRow(k, label, unit))}</tbody>
        </table>
        <Notice tone="info">
          <strong>Continuous location is two gates, not one.</strong> The agency switch above is only the
          first: D6 additionally requires each clinician's own{" "}
          <code>continuous_location_during_sos</code> consent before a single sample may be written.
          Turning it on here does not start streaming anybody, and turning it off stops everybody.
        </Notice>
      </Card>

      <Card title="OSHA auto-flag categories (D9)">
        {policy.oshaReportableAutoFlagCategories.length === 0 ? (
          <span style={mutedStyle}>No category is auto-flagged.</span>
        ) : (
          <div style={{ display: "flex", flexWrap: "wrap", gap: t.space2 }}>
            {policy.oshaReportableAutoFlagCategories.map((c) => (
              <span key={c} style={{ ...mutedStyle, color: t.onSurface }}>
                {incidentCategoryLabel(c)}
              </span>
            ))}
          </div>
        )}
        <span style={mutedStyle}>
          Auto-flagging <strong>suggests</strong>; it never signs. D9 keeps the classification a
          supervisor's separate, step-up'd act precisely so an automatic heuristic cannot file with a state
          agency.
        </span>
      </Card>

      {editing ? (
        <Modal
          title="Edit the safety policy"
          onClose={() => setEditing(false)}
          footer={
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !meetsMinChars(editReason, POLICY_EDIT_REASON_MIN_CHARS)}
              style={
                saving || !meetsMinChars(editReason, POLICY_EDIT_REASON_MIN_CHARS)
                  ? disabledButtonStyle
                  : primaryButtonStyle
              }
            >
              {saving ? "Saving…" : "Save new version"}
            </button>
          }
        >
          <Notice tone="warning" assertive>
            This is a <strong>step-up</strong> act. It writes a NEW policy version — the current one is
            kept and stays attached to every alert and incident already stamped with it, so nothing that
            has already happened is re-judged by today's numbers. A change that loosens a knob past the
            platform floor is refused with the knob named.
          </Notice>
          {[...CADENCE_KNOBS, ...OVERDUE_KNOBS, ...SOS_KNOBS].map(([k, label, unit]) => {
            const band = BANDS[k];
            return (
              <TextField
                key={k}
                label={`${label} (${unit})`}
                value={draft[k] ?? ""}
                onChange={(v) => setDraft((d) => ({ ...d, [k]: v }))}
                type="number"
                hint={band ? `Platform band: ${band[0]}–${band[1]}. Leave blank to keep the current value.` : undefined}
              />
            );
          })}
          <CheckboxField
            label="Cancelling an SOS requires a biometric check (D5)"
            checked={biometric}
            onChange={setBiometric}
          />
          <CheckboxField
            label="Allow continuous location streaming during an active SOS (D6)"
            checked={streamEnabled}
            onChange={setStreamEnabled}
          />
          <SelectField
            label="Default supervisor subscription model (D8)"
            value={model}
            options={SUBSCRIPTION_MODELS.map((v) => ({ value: v, label: humanize(v) }))}
            onChange={setModel}
          />
          <TextField
            label="After-hours starts at (hour, 0–23)"
            value={afterHoursStart}
            onChange={setAfterHoursStart}
            type="number"
          />
          <TextField
            label="After-hours ends at (hour, 0–23)"
            value={afterHoursEnd}
            onChange={setAfterHoursEnd}
            type="number"
            hint="Inside this window an SOS also pages M19's on-call actors in parallel with your own supervisors (D14)."
          />
          <ChipMultiSelect
            label="Auto-flag these categories as OSHA-reportable candidates"
            values={INCIDENT_CATEGORIES}
            selected={autoFlag}
            onChange={setAutoFlag}
            labeller={incidentCategoryLabel}
          />
          <TextAreaField
            label="Why are you changing this?"
            value={editReason}
            onChange={setEditReason}
            rows={4}
            minChars={POLICY_EDIT_REASON_MIN_CHARS}
            hint="Emitted at warn severity. This is the sentence a later compliance review reads to understand why an agency changed its own watch."
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
