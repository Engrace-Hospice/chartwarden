// apps/web/src/modules/16-bereavement — the PRE-DEATH RISK ASSESSMENT draft (ADR-0109 D5, routes 35 / 36).
// Spec: docs/design/screens/clinical/CHARTWARDEN_UI_BEREAVEMENT.md — "Pre-death risk assessment".
//
// An MSW, chaplain or bereavement counselor on the patient's care team (or bereavement oversight) states the eight D17
// risk factors for an ADMISSION before the death, so the family is not scored blind on day one. It is addressed by the
// ADMISSION id — no bereavement plan exists yet — which is why this is its own screen rather than a view of a plan.
// What it is careful about:
//
//  1. TRI-STATE. `Unknown` is a real answer (D17); the form offers all three and starts every factor at `unknown`.
//  2. THE SUBSTANCE-USE FACTOR IS PART 2 CONTENT. When the server withholds it (`redactedCategories` names `sud`) the
//     factor is shown `unknown` and disabled — the server stores `unknown` for an uncleared writer whatever is sent.
//  3. LOCKED ONCE A PLAN EXISTS. After the death opens a plan the draft is carried into the initial score and is a closed
//     record: the form is read-only and says why (the server answers 409 `DRAFT_LOCKED` to a late write).
//  4. A 404 IS NOT-FOUND-OR-NOT-YOURS, never a hint about who is dying. The save carries the draft version read as
//     `If-Match` (0 for the first write), so a colleague's concurrent edit is a 412, not a silent overwrite.
import {
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import {
  type PreDeathDraft,
  type TriState,
  errorMessage,
  getPreDeathDraft,
  putPreDeathDraft,
} from "./bereavement-api";
import {
  RISK_FACTOR_KEYS,
  dateTime,
  humanize,
  redactionLabel,
  riskFactorLabel,
} from "./bereavement-status";
import {
  Card,
  Notice,
  SelectField,
  alertStyle,
  columnStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
} from "./bereavement-ui";

const SUD_KEY = "active_substance_use";

const asTriState = (v: string): TriState => (v === "unknown" ? "unknown" : v === "true");
const triValue = (v: TriState | undefined): string =>
  v === undefined || v === "unknown" ? "unknown" : v ? "true" : "false";

export function PredeathAssessment(): JSX.Element {
  const client = useApiClient();
  const { admissionId } = useParams<{ admissionId: string }>();
  const [draft, setDraft] = useState<PreDeathDraft | null>(null);
  const [factors, setFactors] = useState<Record<string, TriState>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const adopt = useCallback((next: PreDeathDraft) => {
    setDraft(next);
    setFactors(next.factors as Record<string, TriState>);
  }, []);

  const load = useCallback(async () => {
    if (!admissionId) return;
    setLoading(true);
    setLoadError(null);
    const { draft: d, error } = await getPreDeathDraft(client, admissionId);
    if (error || !d) {
      setLoadError(
        errorMessage(error, "This admission's pre-death assessment could not be loaded."),
      );
      setLoading(false);
      return;
    }
    adopt(d);
    setLoading(false);
  }, [client, admissionId, adopt]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (loadError || !draft || !admissionId) {
    return (
      <EmptyState
        title="Not found"
        description={
          loadError ??
          "This admission does not exist, or you are not on the patient's care team for it."
        }
      />
    );
  }

  const withheld = draft.redactedCategories.includes("sud");
  const editable = !draft.locked;

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    setSaved(false);
    // The eight keys are always exactly RISK_FACTOR_KEYS (the draft the server returned, edited in place).
    const { draft: next, error } = await putPreDeathDraft(client, admissionId, draft.version, {
      factors: Object.fromEntries(
        RISK_FACTOR_KEYS.map((k) => [k, factors[k] ?? "unknown"]),
      ) as unknown as NonNullable<Parameters<typeof putPreDeathDraft>[3]>["factors"],
    });
    setBusy(false);
    if (error || !next) {
      setSaveError(errorMessage(error, "The draft could not be saved."));
      return;
    }
    adopt(next);
    setSaved(true);
  };

  return (
    <div className="wx-kit-column" style={columnStyle}>
      <PageHeader
        title={<span style={pageTitleStyle}>Pre-death risk assessment</span>}
        actions={
          <StatusPill
            label={draft.locked ? "Closed" : "Draft"}
            tone={draft.locked ? "neutral" : "progress"}
          />
        }
      />

      <Notice tone="info">
        State what you know about this family's bereavement risk before the death. It is carried
        into the plan's initial risk score when the death opens a plan: a factor you state can raise
        the computed risk and never lowers it. `Unknown` is a real answer.
      </Notice>

      {draft.locked ? (
        <Notice tone="warning" live>
          A bereavement plan already exists for this admission, so this draft is closed
          {draft.carriedScoreId ? " — it was carried into the plan's initial risk score." : "."}
        </Notice>
      ) : null}

      {withheld ? (
        <Notice tone="info">
          {redactionLabel(draft.redactedCategories)} Substance-use disorder content is withheld from
          you, so that factor stays unknown whatever is sent.
        </Notice>
      ) : null}

      <Card title="Risk factors">
        {!draft.exists ? (
          <span style={mutedStyle}>
            Nothing has been recorded yet for this admission. Every factor starts as unknown.
          </span>
        ) : (
          <span style={mutedStyle}>
            Last edited{draft.lastEditedAt ? ` ${dateTime(draft.lastEditedAt)}` : ""}
            {draft.lastEditedDiscipline
              ? ` by ${humanize(draft.lastEditedDiscipline).toLowerCase()}`
              : ""}
            . Version {draft.version}.
          </span>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: t.space3 }}>
          {RISK_FACTOR_KEYS.map((k) => (
            <SelectField
              key={k}
              label={riskFactorLabel(k)}
              value={withheld && k === SUD_KEY ? "unknown" : triValue(factors[k])}
              options={[
                { value: "true", label: "Present" },
                { value: "false", label: "Absent" },
                { value: "unknown", label: "Unknown" },
              ]}
              disabled={!editable || (withheld && k === SUD_KEY)}
              onChange={(v) => setFactors({ ...factors, [k]: asTriState(v) })}
            />
          ))}
        </div>
        {editable ? (
          <div style={{ display: "flex", gap: t.space2, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" style={primaryButtonStyle} disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save draft"}
            </button>
            <span style={mutedStyle}>Version {draft.version}</span>
          </div>
        ) : null}
        {saved ? (
          <Notice tone="success" live>
            Draft saved. Version {draft.version} is now the current one.
          </Notice>
        ) : null}
        {saveError ? <p style={alertStyle}>{saveError}</p> : null}
      </Card>
    </div>
  );
}
