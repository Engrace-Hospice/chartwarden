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
  Button,
  EmptyState,
  LoadingSpinner,
  PageHeader,
  StatusPill,
  t,
  useApiClient,
} from "@chartwarden/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useParams } from "react-router-dom";
import {
  type PreDeathDraft,
  type TriState,
  errorCode,
  errorMessage,
  getPreDeathDraft,
  isStaleWrite,
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
  ErrorText,
  Notice,
  SelectField,
  StatusLine,
  columnStyle,
  mutedStyle,
  pageTitleStyle,
  primaryButtonStyle,
  useIdempotencyKey,
} from "./bereavement-ui";

const SUD_KEY = "active_substance_use";
const DRAFT_LOCKED_CODE = "DRAFT_LOCKED";
const LOAD_FAILED = "This admission's pre-death assessment could not be loaded.";
const NOT_FOUND_COPY =
  "This admission does not exist, or you are not on the patient's care team for it.";
const NOW_LOCKED =
  "A bereavement plan was opened for this admission while you were editing, so this draft is now closed and read-only.";
const DRAFT_MOVED =
  "This draft changed while you were working on it. The latest version is loaded below: check it and save again.";

const asTriState = (v: string): TriState => (v === "unknown" ? "unknown" : v === "true");
const triValue = (v: TriState | undefined): string =>
  v === undefined || v === "unknown" ? "unknown" : v ? "true" : "false";

/** What a failed load is called: 404 is "not found or not yours" (never a hint who is dying), anything else is a failure. */
function loadFailureTitle(status: number): string {
  if (status === 404) return "Not found";
  if (status === 403) return "Not available to you";
  return "Unavailable";
}

export function PredeathAssessment(): JSX.Element {
  const { admissionId } = useParams<{ admissionId: string }>();
  // Keyed by admission: a route-param change remounts, so one admission's draft is never shown under another's id.
  return <PredeathForAdmission key={admissionId ?? "none"} admissionId={admissionId} />;
}

function PredeathForAdmission({ admissionId }: { admissionId: string | undefined }): JSX.Element {
  const client = useApiClient();
  const [draft, setDraft] = useState<PreDeathDraft | null>(null);
  const [factors, setFactors] = useState<Record<string, TriState>>({});
  // `loading` is the FIRST load only: a reload (after a refused save) keeps the form on screen.
  const [loading, setLoading] = useState(true);
  const [loadFailure, setLoadFailure] = useState<{ message: string; status: number } | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  const idempotency = useIdempotencyKey();
  const latestRequest = useRef(0);
  const hasDraft = useRef(false);

  const adopt = useCallback((next: PreDeathDraft) => {
    hasDraft.current = true;
    setDraft(next);
    setFactors(next.factors as Record<string, TriState>);
  }, []);

  const load = useCallback(async () => {
    if (!admissionId) {
      setLoading(false);
      return;
    }
    const mine = ++latestRequest.current;
    const { draft: d, error, status } = await getPreDeathDraft(client, admissionId);
    if (mine !== latestRequest.current) return; // a newer load, or an unmount, superseded this response
    if (error || !d) {
      const message = errorMessage(error, LOAD_FAILED);
      if (hasDraft.current) setRefreshError(message);
      else setLoadFailure({ message, status });
      setLoading(false);
      return;
    }
    adopt(d);
    setLoadFailure(null);
    setRefreshError(null);
    setLoading(false);
  }, [client, admissionId, adopt]);

  useEffect(() => {
    void load();
    return () => {
      latestRequest.current += 1;
    };
  }, [load]);

  if (loading) return <LoadingSpinner />;
  if (loadFailure || !draft || !admissionId) {
    const status = loadFailure?.status ?? 404;
    const retryable = status !== 404 && status !== 403;
    return (
      <EmptyState
        title={loadFailureTitle(status)}
        description={status === 404 || !loadFailure ? NOT_FOUND_COPY : loadFailure.message}
        action={
          retryable ? (
            <Button
              tone="secondary"
              size="sm"
              onClick={() => {
                setLoading(true);
                void load();
              }}
            >
              Try again
            </Button>
          ) : undefined
        }
      />
    );
  }

  const withheld = draft.redactedCategories.includes("sud");
  const editable = !draft.locked;

  /** A refused save: the draft moved or was closed under us. Say so, reload, and (once closed) leave the form read-only. */
  const refuse = (error: unknown, status: number): void => {
    if (!isStaleWrite(status)) {
      setSaveError(errorMessage(error, "The draft could not be saved."));
      return;
    }
    if (errorCode(error) === DRAFT_LOCKED_CODE) {
      setDraft((prev) => (prev ? { ...prev, locked: true } : prev));
      setStatusMessage(NOW_LOCKED);
    } else {
      setSaveError(DRAFT_MOVED);
    }
    void load();
  };

  const save = async () => {
    setBusy(true);
    setSaveError(null);
    setStatusMessage("");
    // The eight keys are always exactly RISK_FACTOR_KEYS (the draft the server returned, edited in place).
    const vector = Object.fromEntries(RISK_FACTOR_KEYS.map((k) => [k, factors[k] ?? "unknown"]));
    const {
      draft: next,
      error,
      status,
    } = await putPreDeathDraft(
      client,
      admissionId,
      draft.version,
      {
        factors: vector as unknown as NonNullable<
          Parameters<typeof putPreDeathDraft>[3]
        >["factors"],
      },
      idempotency.keyFor(`${draft.version}:${JSON.stringify(vector)}`),
    );
    idempotency.settle(status);
    setBusy(false);
    if (error || !next) {
      refuse(error, status);
      return;
    }
    adopt(next);
    setStatusMessage(`Draft saved. Version ${next.version} is now the current one.`);
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
        <Notice tone="warning">
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

      {refreshError ? <ErrorText>{refreshError}</ErrorText> : null}

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
              onChange={(v) => {
                setFactors({ ...factors, [k]: asTriState(v) });
                setStatusMessage(""); // "Draft saved" no longer describes what is on screen
              }}
            />
          ))}
        </div>
        {editable ? (
          <div style={{ display: "flex", gap: t.space2, alignItems: "center", flexWrap: "wrap" }}>
            <button type="button" style={primaryButtonStyle} disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save draft"}
            </button>
          </div>
        ) : null}
        <StatusLine message={statusMessage} tone={draft.locked ? "warning" : "success"} />
        {saveError ? <ErrorText>{saveError}</ErrorText> : null}
      </Card>
    </div>
  );
}
