// apps/web/src/modules/20-field-safety - §5.1 "TENANT POLICY EDITOR" (`/safety/policy`, Track B/ADR-0030).
//
// The server owns every policy invariant. This screen renders the active or historical version, lets an
// authorized user create a new version, and keeps historical reads read-only.
import {
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  WorkQueueLayout,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX, ReactNode } from "react";
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
  CheckboxField,
  ChipMultiSelect,
  Modal,
  Notice,
  SelectField,
  TextAreaField,
  TextField,
  disabledButtonStyle,
  primaryButtonStyle,
} from "./safety-ui";

/**
 * The §3.3 CHECK bands, mirrored for display only. The server still validates the merged policy.
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

const CADENCE_KNOBS = [
  ["midVisitCadenceMinutes", "Mid-visit cadence", "minutes"],
  ["midVisitMinVisitDurationMinutes", "Shortest visit that gets a mid-visit prompt", "minutes"],
  ["preVisitWindowMinutes", "Pre-visit card appears before the visit", "minutes"],
  ["postVisitWindowMinutes", "Post-visit window after check-out", "minutes"],
] as const;

const OVERDUE_KNOBS = [
  ["gentleReminderMinutes", "Rung 1 - gentle reminder to her", "minutes late"],
  ["supervisorAlertMinutes", "Rung 2 - page the supervisor", "minutes late"],
  ["escalationMinutes", "Rung 3 - escalate", "minutes late"],
  ["sosEquivalentMinutes", "Rung 4 - treat as an SOS", "minutes late"],
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
      if (raw.trim() !== "" && Number.isFinite(n)) body[k] = Math.trunc(n);
    }
    body.sosCancelRequiresBiometric = biometric;
    body.sosContinuousLocationEnabled = streamEnabled;
    body.subscriptionModel = model;
    body.oshaReportableAutoFlagCategories = autoFlag;
    if (afterHoursStart.trim() !== "")
      body.afterHoursStartHour = Math.trunc(Number(afterHoursStart));
    if (afterHoursEnd.trim() !== "") body.afterHoursEndHour = Math.trunc(Number(afterHoursEnd));

    const res = await patchPolicy(
      client,
      null,
      body as Record<string, unknown> & { editReason: string },
    );
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

  if (loading && !policy) {
    return (
      <div style={{ padding: "3rem 1.5rem", textAlign: "center" }}>
        <LoadingSpinner />
      </div>
    );
  }

  if (!policy) {
    return (
      <div style={{ padding: "2rem 1.5rem" }}>
        <EmptyState
          title="Safety policy unavailable"
          description={error ?? "No policy answered for this organization."}
        />
      </div>
    );
  }

  const knobRow = (key: KnobKey, label: string, unit: string) => {
    const band = BANDS[key];
    const value = policy[key as keyof SafetyPolicyView] as number;
    return (
      <tr key={key} style={rowStyle}>
        <td style={tdStyle}>{label}</td>
        <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {value}
        </td>
        <td style={tdStyle}>{unit}</td>
        <td style={{ ...tdStyle, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
          {band ? `${band[0]}-${band[1]}` : "-"}
        </td>
        <td style={tdStyle}>
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
    <WorkQueueLayout
      header={
        <PageHeader
          title="Safety Policy"
          actions={
            <div style={actionGroupStyle}>
              <Link to="/safety" style={linkButtonStyle}>
                Safety board
              </Link>
              <Button type="button" tone="primary" onClick={openEditor} disabled={historical}>
                Edit policy
              </Button>
            </div>
          }
        >
          <div style={{ color: "var(--color-on-surface-variant)", fontSize: "0.875rem" }}>
            Version {policy.versionId} in force from {dateTime(policy.effectiveFrom)}.
          </div>
        </PageHeader>
      }
      filters={
        <div style={filterShellStyle}>
          {error ? (
            <Notice tone="warning" live>
              {error} The table below is the last policy version that answered.
            </Notice>
          ) : null}
          {historical ? (
            <Notice tone="warning" live>
              Historical view for {dateTime(toInstant(asOf))}. Editing is disabled until you return
              to the current policy.
            </Notice>
          ) : null}
          <div style={toolbarStyle}>
            <div style={toolbarTitleStyle}>
              <span style={toolbarEyebrowStyle}>Policy replay</span>
              <strong>Read the thresholds that were active at a specific instant</strong>
            </div>
            <div style={controlGroupStyle}>
              <input
                type="datetime-local"
                value={asOf}
                onChange={(event) => setAsOf(event.target.value)}
                aria-label="Read the policy as it stood at"
                style={inputStyle}
              />
              <Button
                size="sm"
                tone="secondary"
                onClick={() => {
                  setHistorical(true);
                  void load(toInstant(asOf));
                }}
                disabled={asOf.trim() === ""}
              >
                Time-travel
              </Button>
              <Button
                size="sm"
                tone="tertiary"
                onClick={() => {
                  setHistorical(false);
                  setAsOf("");
                  void load();
                }}
              >
                Back to current
              </Button>
            </div>
          </div>
        </div>
      }
      table={
        <div style={contentStyle}>
          <section style={sectionStyle}>
            <div style={sectionHeaderStyle}>
              <div style={toolbarTitleStyle}>
                <span style={toolbarEyebrowStyle}>Version in force</span>
                <strong>Tenant safety defaults</strong>
              </div>
              <StatusPill
                label={historical ? "Historical" : "Current"}
                tone={historical ? "warning" : "success"}
              />
            </div>
            <div style={detailGridStyle}>
              <DetailField label="Version" value={policy.versionId} mono />
              <DetailField label="Effective from" value={dateTime(policy.effectiveFrom)} />
              <DetailField
                label="Effective to"
                value={policy.effectiveTo ? dateTime(policy.effectiveTo) : "Still in force"}
              />
              <DetailField label="Subscription model" value={humanize(policy.subscriptionModel)} />
              <DetailField
                label="After-hours"
                value={`${String(policy.afterHoursStartHour).padStart(2, "0")}:00 to ${String(
                  policy.afterHoursEndHour,
                ).padStart(2, "0")}:00`}
              />
              <DetailField
                label="SOS cancel biometric"
                value={policy.sosCancelRequiresBiometric ? "Required" : "Not required"}
              />
              <DetailField
                label="Continuous location"
                value={policy.sosContinuousLocationEnabled ? "Enabled by agency" : "Off"}
              />
            </div>
          </section>

          <PolicyTable
            title="Check-in cadence"
            eyebrow="D4 prompts"
            columns={["Knob", "Value", "Unit", "Allowed band", "Reads as"]}
          >
            {CADENCE_KNOBS.map(([k, label, unit]) => knobRow(k, label, unit))}
          </PolicyTable>

          <PolicyTable
            title="Overdue ladder"
            eyebrow="D4 escalation"
            columns={["Rung", "Value", "Unit", "Allowed band", "Reads as"]}
            note="The four rungs are ordered by the server: reminder, supervisor page, escalation, then SOS-equivalent."
          >
            {OVERDUE_KNOBS.map(([k, label, unit]) => knobRow(k, label, unit))}
          </PolicyTable>

          <PolicyTable
            title="SOS response"
            eyebrow="D5 / D6"
            columns={["Knob", "Value", "Unit", "Allowed band", "Reads as"]}
            note="Continuous location also requires each clinician's consent; enabling it here does not start a stream by itself."
          >
            {SOS_KNOBS.map(([k, label, unit]) => knobRow(k, label, unit))}
          </PolicyTable>

          <section style={sectionStyle}>
            <div style={sectionHeaderStyle}>
              <div style={toolbarTitleStyle}>
                <span style={toolbarEyebrowStyle}>D9 OSHA</span>
                <strong>Auto-flag categories</strong>
              </div>
            </div>
            {policy.oshaReportableAutoFlagCategories.length === 0 ? (
              <span style={secondaryTextStyle}>No category is auto-flagged.</span>
            ) : (
              <div style={chipListStyle}>
                {policy.oshaReportableAutoFlagCategories.map((category) => (
                  <StatusPill
                    key={category}
                    label={incidentCategoryLabel(category)}
                    tone="neutral"
                  />
                ))}
              </div>
            )}
            <span style={secondaryTextStyle}>
              Auto-flagging suggests a classification; a supervisor still signs the reportable
              determination separately.
            </span>
          </section>

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
                  {saving ? "Saving..." : "Save new version"}
                </button>
              }
            >
              <Notice tone="warning" assertive>
                This writes a new policy version. Existing alerts and incidents keep the thresholds
                that were active when they happened.
              </Notice>
              {[...CADENCE_KNOBS, ...OVERDUE_KNOBS, ...SOS_KNOBS].map(([k, label, unit]) => {
                const band = BANDS[k];
                return (
                  <TextField
                    key={k}
                    label={`${label} (${unit})`}
                    value={draft[k] ?? ""}
                    onChange={(value) => setDraft((current) => ({ ...current, [k]: value }))}
                    type="number"
                    hint={
                      band
                        ? `Platform band: ${band[0]}-${band[1]}. Leave blank to keep the current value.`
                        : undefined
                    }
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
                options={SUBSCRIPTION_MODELS.map((value) => ({
                  value,
                  label: humanize(value),
                }))}
                onChange={setModel}
              />
              <TextField
                label="After-hours starts at (hour, 0-23)"
                value={afterHoursStart}
                onChange={setAfterHoursStart}
                type="number"
              />
              <TextField
                label="After-hours ends at (hour, 0-23)"
                value={afterHoursEnd}
                onChange={setAfterHoursEnd}
                type="number"
                hint="Inside this window an SOS also pages M19's on-call actors in parallel with safety supervisors."
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
                hint="This reason is written with the new policy version."
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

function PolicyTable({
  title,
  eyebrow,
  columns,
  note,
  children,
}: {
  title: string;
  eyebrow: string;
  columns: string[];
  note?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section style={sectionStyle}>
      <div style={sectionHeaderStyle}>
        <div style={toolbarTitleStyle}>
          <span style={toolbarEyebrowStyle}>{eyebrow}</span>
          <strong>{title}</strong>
        </div>
      </div>
      <table style={tableStyle}>
        <thead>
          <tr style={headerRowStyle}>
            {columns.map((column, index) => (
              <th
                key={column}
                style={{
                  ...thStyle,
                  textAlign: index === 1 || index === 3 ? "right" : "left",
                }}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {note ? <span style={secondaryTextStyle}>{note}</span> : null}
    </section>
  );
}

function DetailField({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}): JSX.Element {
  return (
    <div style={primaryCellStyle}>
      <span style={detailLabelStyle}>{label}</span>
      <span style={mono ? { fontFamily: "var(--font-mono)" } : undefined}>{value}</span>
    </div>
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
const toolbarStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
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
const controlGroupStyle = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  flexWrap: "wrap" as const,
};
const inputStyle = {
  height: "2.25rem",
  minWidth: "16rem",
  fontSize: "0.85rem",
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
const sectionHeaderStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "1rem",
};
const detailGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(12rem, 1fr))",
  gap: "0.75rem 1rem",
  paddingBottom: "0.5rem",
  borderBottom: "1px solid color-mix(in srgb, var(--color-outline-variant) 35%, transparent)",
};
const primaryCellStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: "0.25rem",
  minWidth: 0,
};
const detailLabelStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.7rem",
  fontWeight: 650,
};
const tableStyle = {
  display: "table",
  width: "100%",
  borderCollapse: "collapse" as const,
  fontSize: "0.875rem",
};
const headerRowStyle = {
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
const secondaryTextStyle = {
  color: "var(--color-on-surface-variant)",
  fontSize: "0.75rem",
};
const chipListStyle = {
  display: "flex",
  flexWrap: "wrap" as const,
  gap: "0.5rem",
};
