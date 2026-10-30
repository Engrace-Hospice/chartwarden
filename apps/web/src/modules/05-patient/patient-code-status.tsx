// apps/web/src/modules/05-patient/patient-code-status.tsx — the patient code-status panel (ADR-0104,
// `?view=code-status`): the current status, the append-only history, a form to record a decision, and
// entered-in-error per entry. "Not recorded" is the absence of an entry; it is never shown as Full code. The server
// enforces who may write (403 → plain message); this screen does not gate on permission. After every write the
// list is re-read and `notifyCodeStatusChanged` refreshes the chart banner, so the header never shows a stale value.
import { Button, InlineAlert, Panel, TextAreaField, useApiClient } from "@chartwarden/ui";
import { type JSX, useCallback, useEffect, useState } from "react";
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

const VALUES = Object.keys(CODE_STATUS_LABEL) as CodeStatus[];

/** A 403 is a plain refusal; anything else shows the server's own message. */
function writeError(
  res: { error?: unknown; response?: { status: number } },
  fallback: string,
): string {
  if (res.response?.status === 403) return "You are not authorised to change code status.";
  return (res.error as { error?: { message?: string } } | undefined)?.error?.message ?? fallback;
}

export function PatientCodeStatusTab({ patientId }: { patientId: string }): JSX.Element {
  const client = useApiClient();
  const [list, setList] = useState<CodeStatusList | "error" | null>(null);
  const [value, setValue] = useState<CodeStatus | null>(null);
  const [reason, setReason] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [retractId, setRetractId] = useState<string | null>(null);
  const [retractReason, setRetractReason] = useState("");
  const [retractError, setRetractError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await client.GET("/api/v1/patients/{id}/code-status", {
        params: { path: { id: patientId } },
      });
      setList(res.error || !res.data ? "error" : (res.data as CodeStatusList));
    } catch {
      setList("error");
    }
  }, [client, patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function afterWrite(): Promise<void> {
    await load();
    notifyCodeStatusChanged(patientId);
  }

  async function record(): Promise<void> {
    if (!value) return setFormError("Choose a code status.");
    if (!reason.trim()) return setFormError("A reason is required.");
    setBusy(true);
    setFormError(null);
    const res = await client.POST("/api/v1/patients/{id}/code-status", {
      params: { path: { id: patientId } },
      body: { codeStatus: value, reason: reason.trim() },
    });
    setBusy(false);
    if (res.error) return setFormError(writeError(res, "The code status could not be saved."));
    setValue(null);
    setReason("");
    await afterWrite();
  }

  async function retract(entryId: string): Promise<void> {
    if (!retractReason.trim()) return setRetractError("A reason is required.");
    setBusy(true);
    setRetractError(null);
    const res = await client.POST("/api/v1/patients/{id}/code-status/{entryId}/entered-in-error", {
      params: { path: { id: patientId, entryId } },
      body: { reason: retractReason.trim() },
    });
    setBusy(false);
    if (res.error) return setRetractError(writeError(res, "The entry could not be retracted."));
    setRetractId(null);
    setRetractReason("");
    await afterWrite();
  }

  if (list === null) return <p aria-busy="true">Loading code status…</p>;
  if (list === "error") return <InlineAlert>Code status could not be loaded.</InlineAlert>;

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <Panel title="Code status" icon="shield">
        <p style={{ margin: 0, fontWeight: 600 }}>
          Current: {list.current ? CODE_STATUS_LABEL[list.current.codeStatus] : "Not recorded"}
        </p>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void record();
          }}
          style={{ display: "grid", gap: "0.75rem", marginTop: "0.75rem" }}
        >
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: "0.35rem" }}>
            <legend>Record a new code status</legend>
            {VALUES.map((v) => (
              <label key={v} style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <input
                  type="radio"
                  name="code-status"
                  value={v}
                  checked={value === v}
                  onChange={() => setValue(v)}
                />
                {CODE_STATUS_LABEL[v]}
              </label>
            ))}
          </fieldset>
          <TextAreaField
            label="Reason"
            required
            value={reason}
            maxLength={1000}
            onChange={(e) => setReason(e.target.value)}
          />
          {formError ? <InlineAlert>{formError}</InlineAlert> : null}
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
                          label="Why was this entered in error?"
                          required
                          value={retractReason}
                          maxLength={1000}
                          onChange={(ev) => setRetractReason(ev.target.value)}
                        />
                        {retractError ? <InlineAlert>{retractError}</InlineAlert> : null}
                        <div style={{ display: "flex", gap: "0.5rem" }}>
                          <Button type="button" disabled={busy} onClick={() => void retract(e.id)}>
                            Confirm entered in error
                          </Button>
                          <Button type="button" tone="secondary" onClick={() => setRetractId(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
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
