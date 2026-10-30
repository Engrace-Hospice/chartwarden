// apps/web/src/modules/05-patient/patient-code-status.tsx — the patient code-status panel (ADR-0104,
// `?view=code-status`): the current status, the append-only history, a form to record a decision, and
// entered-in-error per entry. "Not recorded" is the absence of an entry; it is never shown as Full code. The server
// enforces who may write (403 → plain message); this screen does not gate on permission. After every write the
// list is re-read and `notifyCodeStatusChanged` refreshes the chart banner, so the header never shows a stale value.
import { Button, InlineAlert, Panel, TextAreaField, useApiClient } from "@chartwarden/ui";
import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import {
  CODE_STATUS_LABEL,
  fmtDate,
  maskTail,
  notifyCodeStatusChanged,
} from "../../shell/patient-context";

type CodeStatus = keyof typeof CODE_STATUS_LABEL;

interface Entry {
  id: string;
  codeStatus: CodeStatus;
  reason: string;
  recordedByMembershipId: string;
  recordedAt: string;
  enteredInErrorAt: string | null;
}

interface CodeStatusList {
  current: Entry | null;
  history: Entry[];
}

/** Which control a form error belongs to, so focus can move to it. */
type FieldError = { field: "value" | "reason" | "form"; message: string };

const VALUES = Object.keys(CODE_STATUS_LABEL) as CodeStatus[];

const FIRST_RADIO_ID = "code-status-first-value";
const REASON_ID = "code-status-reason";
const VALUE_ERROR_ID = "code-status-value-error";
const RETRACT_REASON_ID = "code-status-retract-reason";
const retractTriggerId = (entryId: string): string => `code-status-retract-${entryId}`;

const focusById = (id: string): void => document.getElementById(id)?.focus();

/** A 403 is a plain refusal; anything else shows the server's own message. */
function writeError(
  res: { error?: unknown; response?: { status: number } },
  fallback: string,
): string {
  if (res.response?.status === 403) return "You are not authorised to change code status.";
  return (res.error as { error?: { message?: string } } | undefined)?.error?.message ?? fallback;
}

/** Keyed by patient: another patient's list, half-typed reason or open retraction can never carry over. */
export function PatientCodeStatusTab({ patientId }: { patientId: string }): JSX.Element {
  return <CodeStatusPanel key={patientId} patientId={patientId} />;
}

function CodeStatusPanel({ patientId }: { patientId: string }): JSX.Element {
  const client = useApiClient();
  const [list, setList] = useState<CodeStatusList | "error" | null>(null);
  const [stale, setStale] = useState(false); // a re-read failed: the list on screen may be out of date
  const [notice, setNotice] = useState<string | null>(null);
  const [value, setValue] = useState<CodeStatus | null>(null);
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<FieldError | null>(null);
  const [retractId, setRetractId] = useState<string | null>(null);
  const [retractReason, setRetractReason] = useState("");
  const [retractError, setRetractError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false); // a state flag lags a second Enter press; the ref does not
  const loadSeq = useRef(0); // only the newest read may set the list (post-write re-read)
  const restoreFocusTo = useRef<string | null>(null); // the retract trigger to refocus once it is back
  const currentRef = useRef<HTMLParagraphElement>(null);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    const fail = (): void => {
      // Keep what is on screen after a failed re-read (a write may well have succeeded); only a first read errors.
      setList((prev) => (prev && prev !== "error" ? prev : "error"));
      setStale(true);
    };
    try {
      const res = await client.GET("/api/v1/patients/{id}/code-status", {
        params: { path: { id: patientId } },
      });
      if (seq !== loadSeq.current) return;
      if (res.error || !res.data) return fail();
      setList(res.data as CodeStatusList);
      setStale(false);
    } catch {
      if (seq === loadSeq.current) fail();
    }
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Opening the retraction form lands focus in it; closing it returns focus to the row's trigger.
  useEffect(() => {
    if (retractId) return focusById(RETRACT_REASON_ID);
    if (restoreFocusTo.current) {
      focusById(restoreFocusTo.current);
      restoreFocusTo.current = null;
    }
  }, [retractId]);

  function closeRetraction(entryId: string): void {
    restoreFocusTo.current = retractTriggerId(entryId);
    setRetractId(null);
  }

  async function afterWrite(message: string): Promise<void> {
    await load();
    notifyCodeStatusChanged(patientId);
    setNotice(message);
    currentRef.current?.focus();
  }

  async function record(): Promise<void> {
    if (!value) {
      setFormError({ field: "value", message: "Choose a code status." });
      return focusById(FIRST_RADIO_ID);
    }
    if (!reason.trim()) {
      setFormError({ field: "reason", message: "A reason is required." });
      return focusById(REASON_ID);
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFormError(null);
    setNotice(null);
    const res = await client
      .POST("/api/v1/patients/{id}/code-status", {
        params: { path: { id: patientId } },
        body: { codeStatus: value, reason: reason.trim() },
      })
      .catch(() => null);
    busyRef.current = false;
    setBusy(false);
    if (!res) {
      return setFormError({
        field: "form",
        message: "The code status could not be saved. Check the list before retrying.",
      });
    }
    if (res.error) {
      return setFormError({
        field: "form",
        message: writeError(res, "The code status could not be saved."),
      });
    }
    setValue(null);
    setReason("");
    await afterWrite("Code status recorded.");
  }

  async function retract(entryId: string): Promise<void> {
    if (!retractReason.trim()) {
      setRetractError("A reason is required.");
      return focusById(RETRACT_REASON_ID);
    }
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setRetractError(null);
    setNotice(null);
    const res = await client
      .POST("/api/v1/patients/{id}/code-status/{entryId}/entered-in-error", {
        params: { path: { id: patientId, entryId } },
        body: { reason: retractReason.trim() },
      })
      .catch(() => null);
    busyRef.current = false;
    setBusy(false);
    if (!res) {
      return setRetractError("The entry could not be retracted. Check the list before retrying.");
    }
    if (res.error) return setRetractError(writeError(res, "The entry could not be retracted."));
    setRetractId(null);
    setRetractReason("");
    await afterWrite("Entry marked entered in error.");
  }

  if (list === null) return <p aria-busy="true">Loading code status…</p>;
  if (list === "error") return <InlineAlert>Code status could not be loaded.</InlineAlert>;

  const valueError = formError?.field === "value" ? formError.message : null;

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <Panel title="Code status" icon="shield">
        {stale ? (
          <InlineAlert tone="warning">
            The list could not be refreshed and may be out of date. Reload before relying on it.
          </InlineAlert>
        ) : null}
        <p ref={currentRef} tabIndex={-1} style={{ margin: 0, fontWeight: 600 }}>
          Current: {list.current ? CODE_STATUS_LABEL[list.current.codeStatus] : "Not recorded"}
        </p>
        {notice ? <InlineAlert tone="success">{notice}</InlineAlert> : null}
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void record();
          }}
          style={{ display: "grid", gap: "0.75rem", marginTop: "0.75rem" }}
        >
          <fieldset
            aria-describedby={valueError ? VALUE_ERROR_ID : undefined}
            aria-invalid={valueError ? true : undefined}
            style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: "0.35rem" }}
          >
            <legend>Record a new code status (required)</legend>
            {VALUES.map((v, i) => (
              <label key={v} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="radio"
                  id={i === 0 ? FIRST_RADIO_ID : undefined}
                  name="code-status"
                  value={v}
                  required
                  checked={value === v}
                  onChange={() => setValue(v)}
                />
                {CODE_STATUS_LABEL[v]}
              </label>
            ))}
            {valueError ? (
              <p id={VALUE_ERROR_ID} role="alert" style={{ margin: 0 }}>
                {valueError}
              </p>
            ) : null}
          </fieldset>
          <TextAreaField
            id={REASON_ID}
            label="Reason"
            required
            value={reason}
            maxLength={1000}
            error={formError?.field === "reason" ? formError.message : undefined}
            onChange={(e) => setReason(e.target.value)}
          />
          {formError?.field === "form" ? <InlineAlert>{formError.message}</InlineAlert> : null}
          <div>
            <Button type="submit" disabled={busy}>
              Record code status
            </Button>
          </div>
        </form>
      </Panel>

      <Panel title="History" flush>
        {list.history.length === 0 ? (
          <p style={{ margin: "1rem" }}>No code status has been recorded.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Reason</th>
                <th scope="col">Recorded</th>
                <th scope="col">By</th>
                <th scope="col">State</th>
              </tr>
            </thead>
            <tbody>
              {list.history.map((e) => (
                <tr key={e.id}>
                  <td>{CODE_STATUS_LABEL[e.codeStatus]}</td>
                  <td>{e.reason}</td>
                  <td>{fmtDate(e.recordedAt)}</td>
                  <td>{maskTail(e.recordedByMembershipId)}</td>
                  <td>
                    {e.enteredInErrorAt ? (
                      "Entered in error"
                    ) : retractId === e.id ? (
                      <div style={{ display: "grid", gap: "0.5rem" }}>
                        <TextAreaField
                          id={RETRACT_REASON_ID}
                          label={`Why was this entered in error? (${CODE_STATUS_LABEL[e.codeStatus]}, ${fmtDate(e.recordedAt)})`}
                          required
                          value={retractReason}
                          maxLength={1000}
                          error={retractError ?? undefined}
                          onChange={(ev) => setRetractReason(ev.target.value)}
                        />
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <Button type="button" disabled={busy} onClick={() => void retract(e.id)}>
                            Confirm entered in error
                          </Button>
                          <Button
                            type="button"
                            tone="secondary"
                            disabled={busy}
                            onClick={() => closeRetraction(e.id)}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        id={retractTriggerId(e.id)}
                        type="button"
                        tone="secondary"
                        onClick={() => {
                          setRetractId(e.id);
                          setRetractReason("");
                          setRetractError(null);
                        }}
                      >
                        Mark entered in error
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </div>
  );
}
